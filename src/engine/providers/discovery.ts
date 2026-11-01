import { setTimeout as delay } from "node:timers/promises";
import type {
  BoundaryMember,
  DiscoveredBoundary,
  DiscoveredFolder,
  SourceDiscovery,
} from "../partition.ts";
import { ProviderFault } from "./fault.ts";
import { cursorPages, graphUrl, HttpProviderFault, type GraphTransport } from "./http.ts";
import { DiskListing } from "./listing.ts";

interface Walk {
  graph: GraphTransport;
  signal?: AbortSignal;
}

type Raw = Record<string, unknown>;

// Identity stays strict, and every refusal names the Graph object and field.
function invalid(
  message: string,
  object: "page" | "site" | "drive" | "item",
  field: string,
  context: Record<string, string>,
): ProviderFault {
  return new ProviderFault("preflight_failed", message, {
    check: "discovery_response_invalid",
    object,
    field,
    ...context,
  });
}

function usable(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001f]/u.test(value);
}

function followable(link: string): boolean {
  try {
    graphUrl(link);
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): Raw | undefined {
  return typeof value === "object" && value !== null ? (value as Raw) : undefined;
}

async function request<T>(
  walk: Walk,
  route: string,
  where: Record<string, string>,
  headers?: Record<string, string>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    walk.signal?.throwIfAborted();
    try {
      const init: RequestInit = {
        ...(headers ? { headers } : {}),
        ...(walk.signal ? { signal: walk.signal } : {}),
      };
      return Object.keys(init).length
        ? await walk.graph.request<T>(route, init)
        : await walk.graph.request<T>(route);
    } catch (error) {
      // An aborted fetch surfaces as a network fault; report the abort instead.
      walk.signal?.throwIfAborted();
      // Retry transient faults: a counting walk spans thousands of requests.
      if (attempt < 5 && error instanceof HttpProviderFault && error.transient) {
        // The transport holds later requests until a 429's Retry-After has passed.
        await delay(
          error.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** attempt),
          undefined,
          walk.signal ? { signal: walk.signal } : {},
        );
        continue;
      }
      // An exhausted or permanent failure ends the scan. Name it
      // instead of surfacing an unattributed internal defect.
      if (
        error instanceof HttpProviderFault ||
        (error instanceof ProviderFault && error.code === "provider_request_failed")
      )
        throw new ProviderFault("preflight_failed", "Graph did not complete a discovery request.", {
          ...error.evidence,
          ...where,
          check: "discovery_request_failed",
        });
      throw error;
    }
  }
}

async function* entries(
  walk: Walk,
  route: string,
  context: Record<string, string> = {},
  headers?: Record<string, string>,
): AsyncIterable<Raw> {
  const where = { route, ...context };
  for await (const page of cursorPages(
    route,
    async (cursor) => {
      const page = await request<{ value?: unknown; "@odata.nextLink"?: unknown }>(
        walk,
        cursor!,
        where,
        headers,
      );
      const next = page["@odata.nextLink"];
      if (!Array.isArray(page.value))
        throw invalid("Graph returned an invalid discovery page.", "page", "value", where);
      if (next !== undefined && (typeof next !== "string" || (next && !followable(next))))
        throw invalid(
          "Graph returned an invalid discovery page link.",
          "page",
          "@odata.nextLink",
          where,
        );
      return { value: page.value as Raw[], next };
    },
    () => invalid("Graph repeated a discovery page.", "page", "@odata.nextLink", where),
  ))
    yield* page;
}

async function requireTenantRead(graph: GraphTransport, signal?: AbortSignal): Promise<void> {
  const evidence = await graph.evidence(signal);
  if (
    !Array.isArray(evidence.grantedPermissions) ||
    !evidence.grantedPermissions.includes("Sites.Read.All")
  )
    throw new ProviderFault(
      "preflight_failed",
      "SharePoint discovery requires Sites.Read.All instead of Sites.Selected.",
      {
        check: "discovery_requires_sites_read_all",
        requiredGrant: "Sites.Read.All",
      },
    );
}

interface DiscoveredSite {
  id: string;
  name: string;
}

interface LibraryVisitor {
  /** A document library, with its site's label and URL path for proposed names. */
  library(site: DiscoveredSite, library: { id: string; name: string }, siteName: string): void;
  personalSite?(): void;
}

/** Every document library of every non-personal site and subsite, each site once. */
async function enumerateLibraries(walk: Walk, visitor: LibraryVisitor): Promise<void> {
  const seenSites = new Set<string>();
  async function visit(rawSite: Raw): Promise<void> {
    const id = rawSite.id;
    if (!usable(id))
      throw invalid(
        "Graph omitted or returned an invalid site identifier.",
        "site",
        "id",
        usable(rawSite.webUrl) ? { webUrl: rawSite.webUrl } : {},
      );
    if (seenSites.has(id)) return;
    seenSites.add(id);
    // The site URL path distinguishes subsites sharing a display name and does not
    // depend on whether tenant enumeration or the parent's subsite list came first.
    const url = usable(rawSite.webUrl) ? URL.parse(rawSite.webUrl) : null;
    // A OneDrive site's own drive is `business`, never a library this route proposes.
    // Visiting one costs two requests per user and reads into private sites for nothing.
    if (rawSite.isPersonalSite === true || url?.hostname.endsWith("-my.sharepoint.com")) {
      visitor.personalSite?.();
      return;
    }
    if (!url)
      throw invalid("Graph omitted or returned an invalid site URL.", "site", "webUrl", {
        siteId: id,
      });
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep Graph's encoded path when it is not valid percent-encoding.
    }
    // Labels only seed the proposed drive name a human reviews. Graph omits names on
    // system sites such as the classic Search Center, so a label never refuses.
    const siteLabel = [
      rawSite.displayName,
      rawSite.name,
      path.split("/").findLast(Boolean),
      url.hostname,
    ].find(usable);
    const site: DiscoveredSite = { id, name: siteLabel ?? id };
    const siteName = `${site.name} (${url.hostname}${path})`;
    for await (const rawDrive of entries(walk, `/v1.0/sites/${encodeURIComponent(id)}/drives`, {
      siteId: id,
    })) {
      if (rawDrive.driveType !== "documentLibrary") continue;
      const driveId = rawDrive.id;
      if (!usable(driveId))
        throw invalid("Graph omitted or returned an invalid library identifier.", "drive", "id", {
          siteId: id,
        });
      const library = { id: driveId, name: usable(rawDrive.name) ? rawDrive.name : driveId };
      visitor.library(site, library, siteName);
    }
    for await (const child of entries(walk, `/v1.0/sites/${encodeURIComponent(id)}/sites`, {
      siteId: id,
    }))
      await visit(child);
  }
  for await (const rawSite of entries(walk, "/v1.0/sites/getAllSites")) await visit(rawSite);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const ROLE_RANK: Record<string, number> = { read: 1, write: 2, owner: 3 };

function role(roles: unknown): string | null {
  if (!Array.isArray(roles) || !roles.every(usable) || roles.length === 0) return null;
  const known = roles.filter((value) => Object.hasOwn(ROLE_RANK, value));
  if (known.length) return known.reduce((a, b) => (ROLE_RANK[b]! > ROLE_RANK[a]! ? b : a));
  // Unlisted roles (such as SharePoint's own role names) stay visible to the reviewer.
  return [...new Set(roles)].sort(byText).join(",");
}

function stronger(a: string, b: string): string {
  const rank = (value: string) => ROLE_RANK[value] ?? 0;
  return rank(a) !== rank(b) ? (rank(a) > rank(b) ? a : b) : byText(a, b) >= 0 ? a : b;
}

/**
 * One permission identity as a member, `undefined` when it grants no person or group
 * (an application), or null when it names someone Graph does not identify.
 */
function identity(
  set: Raw,
  siteGroupScope: string,
): Omit<BoundaryMember, "role"> | null | undefined {
  const user = record(set.user);
  if (user) {
    // `email` is not in Graph's identity schema but SharePoint returns it on users;
    // the object ID is the stable fallback. Unverified against primary docs.
    if (usable(user.email)) return { id: user.email.toLowerCase(), type: "user" };
    if (usable(user.id)) return { id: user.id, type: "user" };
    return null;
  }
  const group = record(set.group);
  if (group) return usable(group.id) ? { id: group.id, type: "group" } : null;
  // Graph prefers the globally unique SharePoint group ID; a site group's principal ID
  // is unique only within its site collection, so it is scoped by that collection.
  const sharePointGroup = record(set.sharePointGroup);
  if (sharePointGroup && usable(sharePointGroup.id))
    return { id: sharePointGroup.id, type: "group" };
  const siteGroup = record(set.siteGroup);
  if (siteGroup)
    return usable(siteGroup.id) || typeof siteGroup.id === "number"
      ? { id: `sitegroup:${siteGroupScope}:${siteGroup.id}`, type: "group" }
      : null;
  const siteUser = record(set.siteUser);
  if (siteUser) return usable(siteUser.loginName) ? { id: siteUser.loginName, type: "user" } : null;
  if (set.application !== undefined || set.device !== undefined) return undefined;
  return null;
}

/**
 * Who a library root or folder grants access to. SharePoint lists the effective
 * permissions and does not return `inheritedFrom`, so this is the whole audience.
 * https://learn.microsoft.com/graph/api/driveitem-list-permissions
 * https://learn.microsoft.com/graph/api/resources/permission
 */
async function boundaryMembers(
  walk: Walk,
  route: string,
  context: Record<string, string>,
  siteGroupScope: string,
): Promise<BoundaryMember[] | null> {
  const members = new Map<string, BoundaryMember>();
  try {
    for await (const permission of entries(walk, route, context)) {
      const granted = role(permission.roles);
      if (!granted) return null;
      const sets: Raw[] = [];
      const direct = record(permission.grantedToV2);
      if (direct) sets.push(direct);
      if (Array.isArray(permission.grantedToIdentitiesV2))
        for (const set of permission.grantedToIdentitiesV2) {
          const value = record(set);
          if (!value) return null;
          sets.push(value);
        }
      const found: Omit<BoundaryMember, "role">[] = [];
      for (const set of sets) {
        const member = identity(set, siteGroupScope);
        if (member === null) return null;
        if (member) found.push(member);
      }
      const link = record(permission.link);
      const invitation = record(permission.invitation);
      if (link) {
        // An organization or anyone link reaches people no list names. It stays a
        // member so only boundaries with the same link audience compare equal.
        if (link.scope === "anonymous" || link.scope === "organization")
          found.push({ id: `link:${link.scope}`, type: "group" });
        else if (
          link.scope !== undefined &&
          link.scope !== "users" &&
          link.scope !== "existingAccess"
        )
          return null;
      } else if (!sets.length && invitation && usable(invitation.email))
        found.push({ id: invitation.email.toLowerCase(), type: "user" });
      else if (!sets.length) return null;
      for (const member of found) {
        const key = `${member.type}\u0000${member.id}`;
        const known = members.get(key);
        members.set(key, { ...member, role: known ? stronger(known.role, granted) : granted });
      }
    }
  } catch (error) {
    // An unreadable membership never shares a container; it does not end discovery.
    if (
      error instanceof ProviderFault &&
      error.evidence.check === "discovery_request_failed" &&
      (error.evidence.status === 403 || error.evidence.status === 404)
    )
      return null;
    throw error;
  }
  return [...members.values()].sort(
    (a, b) => byText(a.type, b.type) || byText(a.id, b.id) || byText(a.role, b.role),
  );
}

interface Node {
  name: string;
  parent: string;
  /** A OneNote notebook or other package: copied as items, never mappable as a folder. */
  package: boolean;
  /** Present under `Prefer: hierarchicalsharing` only where a permission scope starts. */
  shared: boolean;
}

interface Library {
  id: string;
  name: string;
  siteId: string;
}

/**
 * Counts one library in one delta walk and splits it at folders with unique access.
 *
 * Delta is the documented way to enumerate a whole drive, one paged walk instead of a
 * children request per folder, and only from the root in SharePoint. With
 * `Prefer: hierarchicalsharing`, Graph returns the `shared` facet only on the root of
 * each permission hierarchy (empty when it has no links), so an item carrying it has
 * unique permissions and an item without it inherits.
 * https://learn.microsoft.com/graph/api/driveitem-delta
 * https://learn.microsoft.com/onedrive/developer/rest-api/concepts/scan-guidance
 */
async function discoverLibrary(walk: Walk, library: Library, notices: string[]) {
  const driveId = library.id;
  const context = { driveId };
  const drive = `/v1.0/drives/${encodeURIComponent(driveId)}`;
  const top = await request<{ id?: unknown }>(walk, `${drive}/root?$select=id`, {
    route: `${drive}/root?$select=id`,
    ...context,
  });
  if (!usable(top.id))
    throw invalid("Graph omitted or returned an invalid library root.", "item", "id", context);
  const rootId = top.id;
  const folders = new Map<string, Node>();
  // Files live on disk, last occurrence winning: delta may repeat an item, and a
  // library may hold millions of files. A null parent is a deleted file.
  using files = new DiskListing<{ id: string; parent: string | null; shared: boolean }>(
    (file) => file.id,
  );
  let seen = 0;
  for await (const raw of entries(
    walk,
    `${drive}/root/delta?$select=id,name,root,folder,file,package,remoteItem,deleted,parentReference,shared`,
    context,
    { Prefer: "hierarchicalsharing" },
  )) {
    if (++seen % 1000 === 0) walk.signal?.throwIfAborted();
    const id = raw.id;
    if (!usable(id))
      throw invalid("Graph omitted or returned an invalid item identifier.", "item", "id", context);
    if (id === rootId || raw.root !== undefined) continue;
    if (raw.deleted !== undefined && raw.deleted !== null) {
      folders.delete(id);
      if (files.has(id)) files.add({ id, parent: null, shared: false });
      continue;
    }
    const parent = record(raw.parentReference)?.id;
    if (!usable(parent))
      throw invalid("Graph omitted an item's parent folder.", "item", "parentReference.id", {
        ...context,
        itemId: id,
      });
    const shared = raw.shared !== undefined && raw.shared !== null;
    if (raw.folder !== undefined || raw.package !== undefined) {
      const name = raw.name;
      // Folder names become manifest source paths, which address by native name.
      if (!usable(name) || name === "." || name === ".." || /[/\\]/u.test(name))
        throw invalid("Graph returned a folder without a usable name.", "item", "name", {
          ...context,
          itemId: id,
        });
      folders.set(id, { name, parent, package: raw.package !== undefined, shared });
    } else files.add({ id, parent, shared });
  }
  walk.signal?.throwIfAborted();

  // The mappable folder that holds each folder or package: itself for an ordinary
  // folder, the folder holding the outermost package for anything inside a package.
  // null marks a parent chain that never reaches the library root.
  const host = new Map<string, string | null>([[rootId, rootId]]);
  function hostOf(start: string): string | null {
    const chain: string[] = [];
    let at: string | undefined = start;
    while (at !== undefined && !host.has(at)) {
      if (chain.length > folders.size) break;
      chain.push(at);
      at = folders.get(at)?.parent;
    }
    let above = at !== undefined && host.has(at) ? at : null;
    for (const id of chain.reverse()) {
      const node = folders.get(id);
      const parentHost = above === null ? null : host.get(above)!;
      const value =
        !node || parentHost === null
          ? null
          : parentHost !== above
            ? parentHost
            : node.package
              ? above
              : id;
      host.set(id, value);
      above = id;
    }
    return host.get(start) ?? null;
  }
  const counts = new Map<string, number>();
  const add = (at: string) => counts.set(at, (counts.get(at) ?? 0) + 1);
  const children = new Map<string, string[]>();
  let orphans = 0;
  for (const [id, node] of folders) {
    const at = hostOf(id);
    if (at === null) orphans++;
    else if (at !== id) add(at);
    else {
      const siblings = children.get(node.parent);
      if (siblings) siblings.push(id);
      else children.set(node.parent, [id]);
    }
  }
  let uniqueFiles = 0;
  for (const file of files.uniqueValues()) {
    if (file.parent === null) continue;
    const at = hostOf(file.parent);
    if (at === null) orphans++;
    else {
      add(at);
      if (file.shared) uniqueFiles++;
    }
  }

  const siteParts = library.siteId.split(",");
  const siteGroupScope = siteParts.length === 3 ? siteParts.slice(0, 2).join(",") : library.siteId;
  const boundaries: DiscoveredBoundary[] = [];
  const pending: { top: string; id: string; path: string; parent?: string }[] = [
    { top: rootId, id: driveId, path: "" },
  ];
  type Pending = (typeof pending)[number];
  function tree(boundary: Pending, id: string, name: string, path: string): DiscoveredFolder {
    const folder: DiscoveredFolder = { name, files: counts.get(id) ?? 0, folders: [] };
    const nested: string[] = [];
    const below = (children.get(id) ?? [])
      .map((child) => ({ id: child, name: folders.get(child)!.name }))
      .sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id));
    for (const child of below) {
      const childPath = path ? `${path}/${child.name}` : child.name;
      if (folders.get(child.id)!.shared) {
        const nestedId = `${driveId}/${child.id}`;
        nested.push(nestedId);
        pending.push({ top: child.id, id: nestedId, path: childPath, parent: boundary.id });
      } else folder.folders.push(tree(boundary, child.id, child.name, childPath));
    }
    if (nested.length) folder.nested = nested.sort(byText);
    return folder;
  }
  while (pending.length) {
    const boundary = pending.shift()!;
    const isLibrary = boundary.top === rootId;
    const name = isLibrary ? library.name : `${library.name}/${boundary.path}`;
    const permissions = isLibrary
      ? `${drive}/root/permissions`
      : `${drive}/items/${encodeURIComponent(boundary.top)}/permissions`;
    const members = await boundaryMembers(
      walk,
      permissions,
      isLibrary ? context : { ...context, itemId: boundary.top },
      siteGroupScope,
    );
    if (members === null)
      notices.push(`${name}: its permissions were unreadable, so it shares no container.`);
    boundaries.push({
      id: boundary.id,
      kind: isLibrary ? "sharepoint_library" : "sharepoint_folder",
      name,
      root: { type: "sharepoint", driveId, folderPath: boundary.path },
      ...(boundary.parent ? { parent: boundary.parent } : {}),
      members,
      tree: tree(boundary, boundary.top, "", boundary.path),
    });
  }
  if (uniqueFiles)
    notices.push(
      `${library.name}: ${uniqueFiles} files have unique permissions; a container grants one membership, so review their access.`,
    );
  if (orphans)
    notices.push(
      `${library.name}: ${orphans} items had no folder path to the library root and were not counted.`,
    );
  return boundaries;
}

/** ADR-0020 D1: read-only counts of every SharePoint library, split by unique access. */
export async function discoverSharePointSource(
  graph: GraphTransport,
  signal?: AbortSignal,
): Promise<SourceDiscovery> {
  const observedAt = new Date().toISOString();
  await requireTenantRead(graph, signal);
  const walk: Walk = { graph, ...(signal ? { signal } : {}) };
  const libraries = new Map<string, Library>();
  let personal = 0;
  await enumerateLibraries(walk, {
    library(site, library, siteName) {
      if (!libraries.has(library.id))
        libraries.set(library.id, {
          id: library.id,
          name: `${siteName} - ${library.name}`,
          siteId: site.id,
        });
    },
    personalSite() {
      personal++;
    },
  });
  const notices: string[] = [];
  if (personal)
    notices.push(
      `${personal} personal OneDrive sites were skipped; discovery covers SharePoint document libraries only.`,
    );
  const boundaries: DiscoveredBoundary[] = [];
  for (const library of libraries.values())
    boundaries.push(...(await discoverLibrary(walk, library, notices)));
  boundaries.sort((a, b) => byText(a.id, b.id));
  return { sourceProvider: "sharepoint", observedAt, boundaries, notices };
}
