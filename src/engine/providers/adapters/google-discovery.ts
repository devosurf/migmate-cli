import { setTimeout as delay } from "node:timers/promises";
import { ProviderFault } from "../fault.ts";
import { cursorPages, HttpProviderFault, responseJson } from "../http.ts";
import type {
  BoundaryMember,
  DiscoveredBoundary,
  DiscoveredFolder,
  SourceDiscovery,
} from "../../partition.ts";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/** One authenticated Drive request through the adapter's own transport. */
export type GoogleRequest = (path: string, signal: AbortSignal | null) => Promise<Response>;

interface RawDrive {
  id?: unknown;
  name?: unknown;
}
interface RawPermission {
  emailAddress?: unknown;
  domain?: unknown;
  type?: unknown;
  role?: unknown;
  deleted?: unknown;
}
interface RawFile {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  parents?: unknown;
}

function usable(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !/[\u0000-\u001f]/u.test(value);
}

function invalid(message: string, field: string, context: Record<string, string>): ProviderFault {
  return new ProviderFault("preflight_failed", message, {
    check: "discovery_response_invalid",
    field,
    ...context,
  });
}

const ATTEMPTS = 5;

/** Code-unit order, so the result never depends on the host's locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ADR-0020 D1 for Google: every Shared Drive the acting account is a member of is one
 * access boundary. Strictly read-only, and it holds folders and per-folder counts only.
 */
export async function discoverSharedDrives(
  request: GoogleRequest,
  signal?: AbortSignal,
): Promise<SourceDiscovery> {
  const notices: string[] = [];
  // A large source takes thousands of pages, so one throttled or lost response must not
  // end the scan: retry transient faults, honouring Retry-After. Every call is a read.
  async function read<T>(path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return await responseJson<T>(await request(path, signal ?? null));
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof HttpProviderFault && error.transient && attempt < ATTEMPTS) {
          await delay(
            error.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** (attempt - 1)),
            undefined,
            signal ? { signal } : {},
          );
          continue;
        }
        throw error;
      }
    }
  }
  async function page<T>(path: string, context: Record<string, string>): Promise<T> {
    signal?.throwIfAborted();
    try {
      return await read<T>(path);
    } catch (error) {
      // An abort surfaces from fetch as a transport fault; keep it a cancellation.
      signal?.throwIfAborted();
      // A refusal, or a fault that outlasted its retries, ends the scan. Name it
      // instead of surfacing an unattributed internal defect.
      if (
        error instanceof HttpProviderFault ||
        (error instanceof ProviderFault && error.code === "provider_request_failed")
      )
        throw new ProviderFault(
          "preflight_failed",
          "Google did not complete a discovery request.",
          { ...error.evidence, ...context, check: "discovery_request_failed" },
        );
      throw error;
    }
  }
  function repeated(context: Record<string, string>): () => ProviderFault {
    return () => invalid("Google repeated a discovery page.", "nextPageToken", context);
  }

  // Not useDomainAdminAccess: preflight requires an ordinary non-admin subject, and
  // content is read as that subject, so its own memberships are what it can migrate.
  const drives: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  const listing = { object: "drives" };
  for await (const batch of cursorPages(
    null,
    async (cursor) => {
      const query = new URLSearchParams({
        pageSize: "100",
        fields: "nextPageToken,drives(id,name)",
      });
      if (cursor) query.set("pageToken", cursor);
      const result = await page<{ drives?: unknown; nextPageToken?: unknown }>(
        `/drive/v3/drives?${query}`,
        listing,
      );
      if (result.drives !== undefined && !Array.isArray(result.drives))
        throw invalid("Google returned an invalid Shared Drive page.", "drives", listing);
      return { value: (result.drives ?? []) as RawDrive[], next: nextToken(result, listing) };
    },
    repeated(listing),
  ))
    for (const drive of batch) {
      if (!usable(drive.id) || !/^[A-Za-z0-9_-]+$/u.test(drive.id))
        throw invalid("Google returned an invalid Shared Drive identifier.", "drives.id", listing);
      if (seen.has(drive.id)) continue;
      seen.add(drive.id);
      drives.push({ id: drive.id, name: usable(drive.name) ? drive.name : drive.id });
    }
  if (!drives.length) notices.push("The acting account is a member of no Shared Drives.");
  drives.sort((a, b) => compare(a.id, b.id));

  const boundaries: DiscoveredBoundary[] = [];
  for (const drive of drives) {
    const members = await driveMembers(drive);
    const tree = await driveTree(drive);
    const trashed = await trashedItems(drive);
    if (trashed)
      notices.push(
        `Shared Drive ${drive.id} (${drive.name}): ${trashed} trashed item(s) count toward its 500,000-item limit but are not migrated or counted here.`,
      );
    boundaries.push({
      id: drive.id,
      kind: "google_shared_drive",
      name: drive.name,
      // The top folder's ID is the Shared Drive's ID, the root loadManifest resolves.
      root: { type: "google_shared_drive", driveId: drive.id, folderId: drive.id },
      members,
      tree,
    });
  }
  return {
    sourceProvider: "google_shared_drive",
    observedAt: new Date().toISOString(),
    boundaries,
    notices,
  };

  async function driveMembers(drive: {
    id: string;
    name: string;
  }): Promise<BoundaryMember[] | null> {
    const context = { object: "permissions", driveId: drive.id };
    const members = new Map<string, BoundaryMember>();
    let deleted = 0;
    try {
      for await (const batch of cursorPages(
        null,
        async (cursor) => {
          const query = new URLSearchParams({
            supportsAllDrives: "true",
            pageSize: "100",
            fields: "nextPageToken,permissions(emailAddress,domain,type,role,deleted)",
          });
          if (cursor) query.set("pageToken", cursor);
          let result: { permissions?: unknown; nextPageToken?: unknown };
          try {
            result = await read<typeof result>(
              `/drive/v3/files/${encodeURIComponent(drive.id)}/permissions?${query}`,
            );
          } catch (error) {
            signal?.throwIfAborted();
            // A member without sharing rights may be refused the member list. Such a
            // boundary is still counted; it just never shares a container.
            if (
              error instanceof HttpProviderFault &&
              (error.status === 403 || error.status === 404)
            )
              throw new Unreadable();
            if (
              error instanceof HttpProviderFault ||
              (error instanceof ProviderFault && error.code === "provider_request_failed")
            )
              throw new ProviderFault(
                "preflight_failed",
                "Google did not complete a discovery request.",
                { ...error.evidence, ...context, check: "discovery_request_failed" },
              );
            throw error;
          }
          if (result.permissions !== undefined && !Array.isArray(result.permissions))
            throw new Unreadable();
          return {
            value: (result.permissions ?? []) as RawPermission[],
            next: nextToken(result, context),
          };
        },
        repeated(context),
      ))
        for (const permission of batch) {
          signal?.throwIfAborted();
          // A deleted account grants nobody access, so equal live access compares equal.
          if (permission.deleted === true) {
            deleted++;
            continue;
          }
          const member = boundaryMember(permission);
          if (!member) throw new Unreadable();
          const key = `${member.type}\u0000${member.id}\u0000${member.role}`;
          members.set(key, member);
        }
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      notices.push(
        `Shared Drive ${drive.id} (${drive.name}): its members could not be read, so it never shares a container.`,
      );
      return null;
    }
    if (deleted)
      notices.push(
        `Shared Drive ${drive.id} (${drive.name}): ${deleted} deleted account(s) among its members were left out.`,
      );
    return [...members.values()].sort(
      (a, b) => compare(a.id, b.id) || compare(a.type, b.type) || compare(a.role, b.role),
    );
  }

  async function driveTree(drive: { id: string; name: string }): Promise<DiscoveredFolder> {
    const context = { object: "files", driveId: drive.id };
    // Folders by ID, and file counts by parent ID: never one object per file.
    const folders = new Map<string, { name: string; parent: string | null }>();
    const files = new Map<string, number>();
    let unparented = 0;
    for await (const batch of cursorPages(
      null,
      async (cursor) => {
        const query = new URLSearchParams({
          corpora: "drive",
          driveId: drive.id,
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
          q: "trashed = false",
          pageSize: "1000",
          fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,parents)",
        });
        if (cursor) query.set("pageToken", cursor);
        const result = await page<{
          files?: unknown;
          nextPageToken?: unknown;
          incompleteSearch?: unknown;
        }>(`/drive/v3/files?${query}`, context);
        if (result.incompleteSearch === true)
          throw invalid(
            "Google returned an incomplete discovery listing.",
            "incompleteSearch",
            context,
          );
        if (result.files !== undefined && !Array.isArray(result.files))
          throw invalid("Google returned an invalid discovery page.", "files", context);
        return { value: (result.files ?? []) as RawFile[], next: nextToken(result, context) };
      },
      repeated(context),
    )) {
      signal?.throwIfAborted();
      for (const file of batch) {
        if (!usable(file.id))
          throw invalid("Google returned an invalid item identifier.", "files.id", context);
        // Below the top folder a Shared Drive item has exactly one parent.
        const parent =
          Array.isArray(file.parents) && file.parents.length === 1 && usable(file.parents[0])
            ? file.parents[0]
            : null;
        if (file.mimeType === FOLDER_MIME) {
          if (typeof file.name !== "string" || !file.name)
            throw invalid("Google returned an invalid folder name.", "files.name", {
              ...context,
              itemId: file.id,
            });
          folders.set(file.id, { name: file.name, parent });
        } else if (parent === null) unparented++;
        // Every other item, shortcuts and Google-native documents too, takes a slot.
        else files.set(parent, (files.get(parent) ?? 0) + 1);
      }
    }

    // A folder whose chain never reaches the top folder cannot be mapped by its place;
    // its whole subtree is counted at the top so no item goes missing from the total.
    const rooted = new Map<string, boolean>([[drive.id, true]]);
    for (const id of folders.keys()) {
      const chain: string[] = [];
      let at: string | null = id;
      while (at !== null && !rooted.has(at)) {
        const folder = folders.get(at);
        if (!folder || chain.includes(at)) break;
        chain.push(at);
        at = folder.parent;
      }
      const reaches = at !== null && rooted.get(at) === true;
      for (const link of chain) rooted.set(link, reaches);
    }
    const top: DiscoveredFolder = {
      name: "",
      id: drive.id,
      files: files.get(drive.id) ?? 0,
      folders: [],
    };
    const nodes = new Map<string, DiscoveredFolder>([[drive.id, top]]);
    let orphaned = unparented;
    for (const [id, folder] of folders) {
      if (rooted.get(id))
        nodes.set(id, { name: folder.name, id, files: files.get(id) ?? 0, folders: [] });
      else orphaned += 1 + (files.get(id) ?? 0);
    }
    for (const [parent, count] of files)
      if (parent !== drive.id && !folders.has(parent)) orphaned += count;
    for (const [id, folder] of folders)
      if (rooted.get(id) && id !== drive.id)
        nodes.get(folder.parent!)!.folders.push(nodes.get(id)!);
    for (const node of nodes.values())
      node.folders.sort((a, b) => compare(a.name, b.name) || compare(a.id!, b.id!));
    if (orphaned) {
      top.files += orphaned;
      notices.push(
        `Shared Drive ${drive.id} (${drive.name}): ${orphaned} item(s) whose parent folder could not be resolved are counted at its top folder.`,
      );
    }
    return top;
  }

  // Trash counts toward the item limit. Paging only IDs keeps this cheap, and Shared
  // Drive trash is purged after 30 days (unverified against API docs), so it stays small.
  async function trashedItems(drive: { id: string }): Promise<number> {
    const context = { object: "trash", driveId: drive.id };
    let count = 0;
    for await (const batch of cursorPages(
      null,
      async (cursor) => {
        const query = new URLSearchParams({
          corpora: "drive",
          driveId: drive.id,
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
          q: "trashed = true",
          pageSize: "1000",
          fields: "nextPageToken,files(id)",
        });
        if (cursor) query.set("pageToken", cursor);
        const result = await page<{ files?: unknown; nextPageToken?: unknown }>(
          `/drive/v3/files?${query}`,
          context,
        );
        if (result.files !== undefined && !Array.isArray(result.files))
          throw invalid("Google returned an invalid discovery page.", "files", context);
        return { value: (result.files ?? []) as unknown[], next: nextToken(result, context) };
      },
      repeated(context),
    ))
      count += batch.length;
    return count;
  }
}

class Unreadable extends Error {}

function nextToken(result: { nextPageToken?: unknown }, context: Record<string, string>) {
  if (result.nextPageToken !== undefined && typeof result.nextPageToken !== "string")
    throw invalid("Google returned an invalid discovery page token.", "nextPageToken", context);
  return result.nextPageToken;
}

/**
 * Users and groups by lowercase email. Domain and anyone grants have no email, so they
 * become stable group-like identities and equal access compares equal.
 */
function boundaryMember(permission: RawPermission): BoundaryMember | null {
  if (!usable(permission.role)) return null;
  const role = permission.role;
  if (permission.type === "user" || permission.type === "group")
    return usable(permission.emailAddress)
      ? { id: permission.emailAddress.toLowerCase(), type: permission.type, role }
      : null;
  if (permission.type === "domain")
    return usable(permission.domain)
      ? { id: `domain:${permission.domain.toLowerCase()}`, type: "group", role }
      : null;
  if (permission.type === "anyone") return { id: "anyone", type: "group", role };
  return null;
}
