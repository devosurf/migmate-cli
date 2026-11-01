import { setTimeout as delay } from "node:timers/promises";
import { ProviderFault } from "../fault.ts";
import { HttpProviderFault } from "../http.ts";
import type {
  BoundaryKind,
  BoundaryMember,
  DiscoveredBoundary,
  DiscoveredFolder,
  SourceDiscovery,
} from "../../partition.ts";

/** One Dropbox API call as the source app's team admin; a namespace sets the path root. */
export type DropboxDiscoveryRequest = <T>(
  endpoint: string,
  body: unknown,
  namespace?: string,
) => Promise<T>;

export interface DropboxDiscoveryInput {
  request: DropboxDiscoveryRequest;
  /** The source grant's scopes, from credential evidence. */
  grantedScopes: unknown;
  signal?: AbortSignal;
}

interface NamespaceRow {
  namespace_id?: unknown;
  name?: unknown;
  namespace_type?: { ".tag"?: unknown };
}
interface ListedItem {
  ".tag"?: unknown;
  name?: unknown;
  path_lower?: unknown;
  sharing_info?: { shared_folder_id?: unknown };
}
interface MembersPage {
  users?: {
    access_type?: { ".tag"?: unknown };
    user?: { account_id?: unknown; email?: unknown };
  }[];
  groups?: { access_type?: { ".tag"?: unknown }; group?: { group_id?: unknown } }[];
  invitees?: {
    access_type?: { ".tag"?: unknown };
    invitee?: { email?: unknown };
    user?: { email?: unknown };
  }[];
  cursor?: unknown;
}

const BOUNDARY_KINDS: Record<string, BoundaryKind> = {
  team_folder: "dropbox_team_folder",
  shared_folder: "dropbox_shared_folder",
};
// Personal storage is out of scope, as the source gate in dropbox.ts refuses it.
// https://github.com/dropbox/dropbox-api-spec/blob/main/team.stone (union NamespaceType)
const PERSONAL = new Set(["team_member_folder", "team_member_root", "app_folder"]);
const ATTEMPTS = 5;

function invalid(message: string, context: Record<string, unknown>): ProviderFault {
  return new ProviderFault("preflight_failed", message, {
    check: "discovery_response_invalid",
    ...context,
  });
}

function text(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Code-unit order: deterministic across locales and runtimes. */
function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function byName(a: { name: string }, b: { name: string }): number {
  return order(a.name, b.name);
}

/**
 * ADR-0020 D1 for a Dropbox source: every team folder and shared folder the team can
 * reach, counted once per namespace ID, with its membership and folder tree. Read-only.
 */
export async function discoverDropbox(input: DropboxDiscoveryInput): Promise<SourceDiscovery> {
  const { signal } = input;
  // list_folder_members needs sharing.read; refuse before reading anything else.
  // https://github.com/dropbox/dropbox-api-spec/blob/main/sharing.stone (route list_folder_members)
  if (!Array.isArray(input.grantedScopes) || !input.grantedScopes.includes("sharing.read"))
    throw new ProviderFault(
      "preflight_failed",
      "Dropbox discovery reads folder membership and requires the sharing.read scope.",
      { check: "discovery_requires_sharing_read", requiredScope: "sharing.read" },
    );
  const observedAt = new Date().toISOString();

  // One request, retried while the fault is transient (throttling, 5xx, lost response).
  // Every call here is a read, and cursors stay valid across a retry.
  async function call<T>(endpoint: string, body: unknown, namespace?: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return await input.request<T>(endpoint, body, namespace);
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof HttpProviderFault && error.transient && attempt < ATTEMPTS) {
          await delay(
            error.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** (attempt - 1)),
            undefined,
            {
              ...(signal ? { signal } : {}),
            },
          );
          continue;
        }
        throw error;
      }
    }
  }
  function failed(error: unknown, context: Record<string, unknown>): never {
    if (error instanceof HttpProviderFault)
      throw new ProviderFault("preflight_failed", "Dropbox did not complete a discovery request.", {
        ...error.evidence,
        ...context,
        check: "discovery_request_failed",
      });
    throw error;
  }
  async function* pages<T extends { cursor?: unknown }>(
    first: string,
    body: unknown,
    more: (page: T) => boolean,
    context: Record<string, unknown>,
    namespace?: string,
  ): AsyncIterable<T> {
    const seen = new Set<string>();
    let page: T;
    try {
      page = await call<T>(first, body, namespace);
    } catch (error) {
      failed(error, { ...context, route: first });
    }
    const next = `${first}/continue`;
    for (;;) {
      if (!page || typeof page !== "object")
        throw invalid("Dropbox returned an invalid discovery page.", { ...context, route: first });
      yield page;
      if (!more(page)) return;
      const cursor = page.cursor;
      if (!text(cursor) || seen.has(cursor))
        throw invalid("Dropbox discovery paging repeated a cursor.", { ...context, route: next });
      seen.add(cursor);
      try {
        page = await call<T>(next, { cursor }, namespace);
      } catch (error) {
        failed(error, { ...context, route: next });
      }
    }
  }

  // The whole team inventory: discovery precedes every mapping. Duplicates may occur.
  // https://github.com/dropbox/dropbox-api-spec/blob/main/team.stone (route namespaces/list)
  const namespaces = new Map<string, { name: string; type: string }>();
  for await (const page of pages<{ namespaces?: unknown; has_more?: unknown; cursor?: unknown }>(
    "team/namespaces/list",
    {},
    (page) => page.has_more === true,
    {},
  )) {
    if (!Array.isArray(page.namespaces))
      throw invalid("Dropbox returned an invalid namespace page.", { field: "namespaces" });
    for (const row of page.namespaces as NamespaceRow[]) {
      signal?.throwIfAborted();
      const id = row?.namespace_id;
      const type = row?.namespace_type?.[".tag"];
      if (!text(id) || !/^[0-9]+$/u.test(id) || !text(type) || typeof row.name !== "string")
        throw invalid("Dropbox returned an incomplete namespace.", { field: "namespace_id" });
      const previous = namespaces.get(id);
      if (previous && previous.type !== type)
        throw invalid("Dropbox returned conflicting namespace identities.", {
          namespaceId: id,
          field: "namespace_type",
        });
      if (!previous) namespaces.set(id, { name: row.name, type });
    }
  }

  const notices: string[] = [];
  let personal = 0;
  const other = new Map<string, number>();
  const ids: string[] = [];
  for (const [id, namespace] of namespaces) {
    if (BOUNDARY_KINDS[namespace.type]) ids.push(id);
    else if (PERSONAL.has(namespace.type)) personal++;
    else other.set(namespace.type, (other.get(namespace.type) ?? 0) + 1);
  }
  ids.sort(order);
  if (personal)
    notices.push(
      `${personal} personal Dropbox namespace${personal === 1 ? " was" : "s were"} skipped (member folders and app folders); personal storage is out of scope.`,
    );
  for (const [type, count] of [...other].sort((a, b) => order(a[0], b[0])))
    notices.push(
      `${count} Dropbox namespace${count === 1 ? "" : "s"} of unknown type ${type} ${count === 1 ? "was" : "were"} skipped.`,
    );

  const boundaries = new Map<string, DiscoveredBoundary>();
  const unreadableMembers: string[] = [];
  const unreadableTrees: string[] = [];
  const foreignMounts: string[] = [];
  const nestedIn = new Map<string, string[]>();
  for (const id of ids) {
    signal?.throwIfAborted();
    const namespace = namespaces.get(id)!;
    const tree = await listTree(id);
    if (!tree) {
      unreadableTrees.push(id);
      continue;
    }
    const members = await listMembers(id);
    if (!members) unreadableMembers.push(id);
    for (const nested of tree.mounts) {
      const parents = nestedIn.get(nested) ?? [];
      parents.push(id);
      nestedIn.set(nested, parents);
    }
    boundaries.set(id, {
      id,
      kind: BOUNDARY_KINDS[namespace.type]!,
      name: namespace.name,
      // Exactly the source root of a manifest row `{ namespaceId, folderPath: "" }`.
      root: { type: "dropbox", driveId: id, folderPath: "" },
      members,
      tree: tree.root,
    });
  }
  // A mount of a namespace that is no boundary here stays in `nested`, so the parent
  // still splits around it: a recursive mapping of the parent would copy its content,
  // whose audience differs, into the parent's container.
  for (const [nested, parents] of nestedIn) {
    const boundary = boundaries.get(nested);
    if (!boundary) {
      foreignMounts.push(nested);
      continue;
    }
    parents.sort(order);
    boundary.parent = parents[0]!;
    if (parents.length > 1)
      notices.push(
        `Dropbox namespace ${nested} is mounted inside several boundaries (${parents.join(", ")}); its parent is recorded as ${parents[0]}.`,
      );
  }
  if (unreadableTrees.length)
    notices.push(
      `The selected administrator could not list ${unreadableTrees.length} Dropbox namespace${unreadableTrees.length === 1 ? "" : "s"}, left out of discovery: ${unreadableTrees.join(", ")}.`,
    );
  if (unreadableMembers.length)
    notices.push(
      `Membership of ${unreadableMembers.length} Dropbox namespace${unreadableMembers.length === 1 ? "" : "s"} could not be read; ${unreadableMembers.length === 1 ? "it shares" : "they share"} no container: ${unreadableMembers.join(", ")}.`,
    );
  if (foreignMounts.length)
    notices.push(
      `${foreignMounts.length} mounted folder${foreignMounts.length === 1 ? "" : "s"} belong${foreignMounts.length === 1 ? "s" : ""} to namespaces outside this discovery and ${foreignMounts.length === 1 ? "is" : "are"} left out of the counts and the draft; map them by hand if they belong in this migration: ${foreignMounts.sort(order).join(", ")}.`,
    );
  return {
    sourceProvider: "dropbox",
    observedAt,
    boundaries: [...boundaries.values()],
    notices,
  };

  async function listMembers(id: string): Promise<BoundaryMember[] | null> {
    // Users by lowercased email, as listDriveMembers names them; groups by group_id.
    // Invitees are named on the folder's ACL and gain its access on accepting, so they
    // count as users by their invited email.
    // https://github.com/dropbox/dropbox-api-spec/blob/main/sharing.stone (struct SharedFolderMembers)
    const members = new Map<string, BoundaryMember>();
    const add = (member: BoundaryMember) => {
      if (!text(member.id) || !text(member.role))
        throw invalid("Dropbox returned an incomplete folder member.", {
          namespaceId: id,
          route: "sharing/list_folder_members",
        });
      members.set(`${member.type}\u0000${member.id}`, member);
    };
    try {
      for await (const page of pages<MembersPage>(
        "sharing/list_folder_members",
        { shared_folder_id: id, limit: 1000 },
        (page) => page.cursor !== undefined && page.cursor !== null,
        { namespaceId: id },
      )) {
        for (const group of page.groups ?? [])
          add({
            id: String(group.group?.group_id ?? ""),
            type: "group",
            role: String(group.access_type?.[".tag"] ?? ""),
          });
        for (const user of page.users ?? [])
          add({
            id: String(user.user?.email || user.user?.account_id || "").toLowerCase(),
            type: "user",
            role: String(user.access_type?.[".tag"] ?? ""),
          });
        for (const invitee of page.invitees ?? [])
          add({
            id: String(invitee.invitee?.email || invitee.user?.email || "").toLowerCase(),
            type: "user",
            role: String(invitee.access_type?.[".tag"] ?? ""),
          });
      }
    } catch (error) {
      // A 409 is the folder's own refusal (not_a_member, unmounted, invalid_id):
      // membership is unreadable, not empty. Anything else ends discovery.
      if (
        error instanceof ProviderFault &&
        error.evidence.check === "discovery_request_failed" &&
        error.evidence.status === 409
      )
        return null;
      throw error;
    }
    return [...members.values()].sort(
      (a, b) => order(a.type, b.type) || order(a.id, b.id) || order(a.role, b.role),
    );
  }

  async function listTree(
    id: string,
  ): Promise<{ root: DiscoveredFolder; mounts: Set<string> } | null> {
    // Folders only, keyed by path_lower; files only add to their parent's count.
    // Recursive listings do not promise parent-before-child order, so a parent seen
    // first through a child is a placeholder until its own entry arrives.
    const folders = new Map<string, { name: string | null; files: number }>();
    folders.set("", { name: "", files: 0 });
    const mounts = new Map<string, string>();
    const folder = (path: string) => {
      let node = folders.get(path);
      if (!node) {
        node = { name: null, files: 0 };
        folders.set(path, node);
      }
      return node;
    };
    try {
      for await (const page of pages<{ entries?: unknown; has_more?: unknown; cursor?: unknown }>(
        "files/list_folder",
        {
          path: "",
          recursive: true,
          include_deleted: false,
          include_non_downloadable_files: true,
          // Entries under a nested shared folder belong to that namespace. The mount
          // point itself is still listed with its shared_folder_id; content that does
          // arrive below a mount is dropped anyway when the tree is built.
          // https://github.com/dropbox/dropbox-api-spec/blob/main/files.stone (struct ListFolderArg)
          include_mounted_folders: false,
          limit: 2000,
        },
        (page) => page.has_more === true,
        { namespaceId: id },
        id,
      )) {
        if (!Array.isArray(page.entries))
          throw invalid("Dropbox returned an invalid folder page.", {
            namespaceId: id,
            field: "entries",
          });
        for (const raw of page.entries as ListedItem[]) {
          signal?.throwIfAborted();
          const tag = raw?.[".tag"];
          if (tag === "deleted") continue;
          const path = raw.path_lower;
          if (!text(path) || !path.startsWith("/") || typeof raw.name !== "string" || !raw.name)
            throw invalid("Dropbox returned an item without a namespace-relative path.", {
              namespaceId: id,
              field: "path_lower",
            });
          const parent = path.slice(0, path.lastIndexOf("/"));
          if (tag === "folder") {
            const shared = raw.sharing_info?.shared_folder_id;
            // A shared_folder_id is a namespace ID (common.SharedFolderId = NamespaceId).
            if (text(shared) && shared !== id) {
              mounts.set(path, shared);
              folders.delete(path);
              continue;
            }
            folder(path).name = raw.name;
          } else if (tag === "file") folder(parent).files++;
          else
            throw invalid("Dropbox returned an item of unknown type.", {
              namespaceId: id,
              field: ".tag",
            });
        }
      }
    } catch (error) {
      if (
        error instanceof ProviderFault &&
        error.evidence.check === "discovery_request_failed" &&
        (error.evidence.status === 409 || error.evidence.status === 404)
      )
        return null;
      throw error;
    }
    // Children by parent; anything below a mount has no reachable parent and drops out.
    const children = new Map<string, string[]>();
    const nested = new Map<string, string[]>();
    for (const path of folders.keys())
      // A mount path can reappear as a placeholder when content below it is listed.
      if (path && !mounts.has(path)) {
        const parent = path.slice(0, path.lastIndexOf("/"));
        const list = children.get(parent) ?? [];
        list.push(path);
        children.set(parent, list);
      }
    for (const [path, namespace] of mounts) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      const list = nested.get(parent) ?? [];
      list.push(namespace);
      nested.set(parent, list);
    }
    const reached = new Set<string>();
    const build = (path: string): DiscoveredFolder => {
      const node = folders.get(path)!;
      if (node.name === null)
        throw invalid("Dropbox listed items inside a folder it did not list.", {
          namespaceId: id,
          field: "path_lower",
        });
      const own = nested.get(path);
      if (own) for (const namespace of own) reached.add(namespace);
      return {
        name: node.name,
        files: node.files,
        folders: (children.get(path) ?? []).map(build).sort(byName),
        ...(own ? { nested: [...new Set(own)].sort(order) } : {}),
      };
    };
    return { root: build(""), mounts: reached };
  }
}
