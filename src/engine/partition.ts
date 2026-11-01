import { createHash } from "node:crypto";
import { fileProvider, type FileProviderId } from "./providers/adapters/capabilities.ts";
import type { ManifestRoot } from "./manifest.ts";

/**
 * ADR-0020 D1: a read-only, point-in-time count of the source, per access boundary.
 * Discovery holds folders only, never files, so its size follows the folder count.
 */
export interface SourceDiscovery {
  sourceProvider: FileProviderId;
  observedAt: string;
  boundaries: DiscoveredBoundary[];
  /** Plain review notes, such as boundaries skipped because they cannot be mapped. */
  notices: string[];
}

export type BoundaryKind =
  | "dropbox_team_folder"
  | "dropbox_shared_folder"
  | "google_shared_drive"
  | "sharepoint_library"
  | "sharepoint_folder";

/** Source content that shares one membership (ADR-0020 D2). */
export interface DiscoveredBoundary {
  /**
   * Provider-stable identity: the Dropbox namespace ID, the Shared Drive ID, the
   * SharePoint drive ID, or `driveId/itemId` for a SharePoint folder with unique access.
   */
  id: string;
  kind: BoundaryKind;
  /** Display name, for review and proposed container names only. */
  name: string;
  /** The manifest source root of the boundary's top folder. */
  root: ManifestRoot;
  /** The boundary this one is nested inside, when it is. */
  parent?: string;
  /**
   * Who can reach the content, as provider identities (email or group ID). Equal lists
   * may share a container; null means unreadable, and such a boundary never shares.
   */
  members: BoundaryMember[] | null;
  tree: DiscoveredFolder;
}

export interface BoundaryMember {
  id: string;
  type: "user" | "group";
  role: string;
}

export interface DiscoveredFolder {
  /** Native folder name; empty for the boundary's top folder. */
  name: string;
  /** Stable folder ID, present where manifest source roots use IDs (Google). */
  id?: string;
  /** Files directly inside this folder, not in its subfolders. */
  files: number;
  /** Subfolders inside the same boundary. */
  folders: DiscoveredFolder[];
  /**
   * Subfolders that are access boundaries of their own. They are neither counted nor
   * listed in `folders`, and no mapping of this boundary may cover them.
   */
  nested?: string[];
}

/** Every item a folder's subtree adds below it: files and folders, not the folder itself. */
export function subtreeItems(folder: DiscoveredFolder): number {
  let total = folder.files;
  for (const child of folder.folders) total += 1 + subtreeItems(child);
  return total;
}

/** True when a boundary nested anywhere below forces a split around it. */
export function holdsNestedBoundary(folder: DiscoveredFolder): boolean {
  return Boolean(folder.nested?.length) || folder.folders.some(holdsNestedBoundary);
}

export interface PartitionInput {
  discovery: SourceDiscovery;
  destinationProvider: FileProviderId;
  /** The destination provider's hard item limit per container; null when not established. */
  hardLimit: number | null;
  /** Items planned into one container; null applies no size limit. */
  defaultTarget: number | null;
  /** Per-boundary capacity targets, keyed by boundary ID. */
  targets?: Readonly<Record<string, number>>;
}

export interface ProposedContainer {
  name: string;
  /** Items this container is planned to hold: files and folders, including mapping folders. */
  items: number;
  target: number | null;
  boundaries: string[];
  mappings: string[];
  /** The shared source membership of its boundaries, for the reviewer to translate. */
  sourceMembers: BoundaryMember[] | null;
  /** Over its target: a single folder whose own files exceed it cannot split further. */
  overTarget: boolean;
}

/** A draft row as the manifest file spells it, e.g. Dropbox roots name `namespaceId`. */
export type DraftMapping = Record<string, unknown> & { id: string };

export interface Partition {
  manifest: { version: 1; mappings: DraftMapping[] };
  containers: ProposedContainer[];
  notices: string[];
}

/** ADR-0020 D3: the default target keeps 20% headroom for deltas and trash. */
export function defaultCapacityTarget(hardLimit: number | null): number | null {
  return hardLimit === null ? null : Math.floor(hardLimit * 0.8);
}

interface Unit {
  boundary: DiscoveredBoundary;
  folder: DiscoveredFolder;
  /** Native source names from the boundary's top folder. */
  path: string[];
  filesOnly: boolean;
  items: number;
}

interface Bin {
  target: number | null;
  units: Unit[];
  load: number;
  /** Destination folder paths already counted, keyed by joined path. */
  folders: Set<string>;
  /** Each boundary's folder name inside this container. */
  boundaryFolders: Map<string, string>;
}

/**
 * ADR-0020 D2-D5: a deterministic draft. Boundaries with equal membership and target
 * pack into shared containers, each boundary in its own folder; a boundary over its
 * target, or around a nested boundary, splits by subfolder, its own files carried by a
 * files-only mapping. Members stay empty: discovery never translates access (D6).
 */
export function partition(input: PartitionInput): Partition {
  const notices: string[] = [];
  const source = fileProvider(input.discovery.sourceProvider);
  const destination = fileProvider(input.destinationProvider);
  // The names rclone would give these folders, so a split keeps the copied hierarchy.
  const destinationName = (native: string): string => {
    const standard = source.sourceName ? source.sourceName(native) : native;
    if (standard === null) return native;
    return destination.destinationName ? destination.destinationName(standard) : standard;
  };
  const targetOf = (boundary: DiscoveredBoundary) =>
    input.targets?.[boundary.id] ?? input.defaultTarget;

  function split(boundary: DiscoveredBoundary, folder: DiscoveredFolder, path: string[]): Unit[] {
    const target = targetOf(boundary);
    const items = subtreeItems(folder);
    // A folder without subfolders cannot split further, whatever its size.
    const whole = !folder.folders.length || target === null || items <= target;
    if (!holdsNestedBoundary(folder) && whole)
      return [{ boundary, folder, path, filesOnly: false, items }];
    const units: Unit[] = [];
    if (folder.files > 0)
      units.push({ boundary, folder, path, filesOnly: true, items: folder.files });
    for (const child of [...folder.folders].sort((a, b) => compare(a.name, b.name)))
      units.push(...split(boundary, child, [...path, child.name]));
    return units;
  }

  // Equal membership and equal target may share; unreadable membership never does.
  const groups = new Map<string, DiscoveredBoundary[]>();
  for (const boundary of [...input.discovery.boundaries].sort((a, b) => compare(a.id, b.id))) {
    const key = JSON.stringify([
      boundary.members === null ? ["unread", boundary.id] : memberKey(boundary.members),
      targetOf(boundary),
    ]);
    groups.set(key, [...(groups.get(key) ?? []), boundary]);
  }

  const bins: Bin[] = [];
  for (const boundaries of groups.values()) {
    const target = targetOf(boundaries[0]!);
    const open: Bin[] = [];
    for (const boundary of boundaries)
      for (const unit of split(boundary, boundary.tree, [])) {
        let bin = open.find((candidate) => {
          if (target === null) return true;
          return candidate.load + cost(candidate, unit) <= target;
        });
        if (!bin) {
          bin = { target, units: [], load: 0, folders: new Set(), boundaryFolders: new Map() };
          open.push(bin);
        }
        place(bin, unit);
      }
    bins.push(...open);
  }

  function boundaryFolder(bin: Bin, boundary: DiscoveredBoundary): string {
    const known = bin.boundaryFolders.get(boundary.id);
    if (known) return known;
    const base = destinationName(boundary.name.trim() || boundary.id);
    const sibling = destination.destinationSiblingKey ?? ((name: string) => name);
    const taken = new Set([...bin.boundaryFolders.values()].map(sibling));
    let name = base;
    for (let n = 2; taken.has(sibling(name)); n++) name = `${base} (${n})`;
    bin.boundaryFolders.set(boundary.id, name);
    return name;
  }
  function destinationPath(bin: Bin, unit: Unit): string[] {
    return [boundaryFolder(bin, unit.boundary), ...unit.path.map(destinationName)];
  }
  /** Items a unit adds: its own, plus each folder on its path the container lacks. */
  function cost(bin: Bin, unit: Unit): number {
    const known = bin.boundaryFolders.get(unit.boundary.id);
    const parts = [known ?? "\u0000new", ...unit.path.map(destinationName)];
    let added = unit.items;
    for (let i = 1; i <= parts.length; i++)
      if (!known || !bin.folders.has(parts.slice(0, i).join("/"))) added++;
    return added;
  }
  function place(bin: Bin, unit: Unit): void {
    bin.load += cost(bin, unit);
    const parts = destinationPath(bin, unit);
    for (let i = 1; i <= parts.length; i++) bin.folders.add(parts.slice(0, i).join("/"));
    bin.units.push(unit);
  }

  // Names: one boundary keeps its name, a split one numbers its parts, a group counts.
  const parts = new Map<string, number>();
  for (const bin of bins)
    for (const id of new Set(bin.units.map((unit) => unit.boundary.id)))
      parts.set(id, (parts.get(id) ?? 0) + 1);
  const seen = new Map<string, number>();
  const usedNames = new Set<string>();
  const usedIds = new Set<string>();
  const containers: ProposedContainer[] = [];
  const mappings: DraftMapping[] = [];
  for (const bin of bins) {
    const ids = [...new Set(bin.units.map((unit) => unit.boundary.id))];
    const first = bin.units[0]!.boundary;
    // A part's number counts every container holding the boundary, shared ones too.
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    let name: string;
    if (ids.length > 1) name = `${first.name} and ${ids.length - 1} more`;
    else if (parts.get(first.id)! > 1)
      name = `${first.name} (part ${seen.get(first.id)} of ${parts.get(first.id)})`;
    else name = first.name;
    name = name.trim() || first.id;
    let unique = name;
    for (let n = 2; usedNames.has(unique.toLowerCase()); n++) unique = `${name} (${n})`;
    usedNames.add(unique.toLowerCase());
    // A container of one boundary needs no boundary folder: its paths start at the root.
    const single = ids.length === 1;
    const container: ProposedContainer = {
      name: unique,
      items: single ? bin.load - 1 : bin.load,
      target: bin.target,
      boundaries: ids,
      mappings: [],
      sourceMembers: first.members,
      overTarget: false,
    };
    container.overTarget = bin.target !== null && container.items > bin.target;
    for (const unit of bin.units) {
      const folderPath = destinationPath(bin, unit)
        .slice(single ? 1 : 0)
        .join("/");
      let id = mappingId(unit);
      for (let n = 2; usedIds.has(id); n++) id = `${mappingId(unit)}-${n}`;
      usedIds.add(id);
      container.mappings.push(id);
      mappings.push({
        id,
        source: draftRoot(unitRoot(unit)),
        destination: {
          type: input.destinationProvider,
          create: unique,
          ...(folderPath ? { folderPath } : {}),
        },
        members: [],
        ...(unit.filesOnly ? { filesOnly: true } : {}),
      });
    }
    if (container.overTarget)
      notices.push(
        `Container "${unique}" plans ${container.items} items, over its target of ${bin.target}: a folder holds more files directly than the target allows and cannot split further.`,
      );
    containers.push(container);
  }

  const limit = input.hardLimit;
  if (limit === null && input.defaultTarget === null)
    notices.push(
      `No hard item limit is established for ${input.destinationProvider} containers, so containers split only by access boundary. Give a capacity target to split by size.`,
    );
  for (const [id, target] of Object.entries(input.targets ?? {}))
    if (limit !== null && target > limit)
      notices.push(`The capacity target for ${id} exceeds the provider's hard limit of ${limit}.`);
  if (limit !== null && input.defaultTarget !== null && input.defaultTarget > limit)
    notices.push(`The capacity target exceeds the provider's hard limit of ${limit}.`);
  const unread = input.discovery.boundaries.filter((b) => b.members === null).length;
  if (unread)
    notices.push(
      `The access of ${unread} boundar${unread === 1 ? "y" : "ies"} could not be read; each gets containers of its own.`,
    );
  if (destination.creationParent === "siteId")
    notices.push(
      "Add destination.siteId, the existing site each library is created in, to every row before loading.",
    );
  notices.push(
    "Members are empty: translate each container's sourceMembers into destination members before loading. Counts are a point-in-time observation.",
  );
  return { manifest: { version: 1, mappings }, containers, notices };

  function unitRoot(unit: Unit): ManifestRoot {
    const root = unit.boundary.root;
    if ("folderId" in root) {
      const folderId = unit.path.length === 0 ? root.folderId : unit.folder.id;
      if (!folderId) throw new Error(`Discovered folder without an id in ${unit.boundary.id}`);
      return { type: root.type, driveId: root.driveId, folderId };
    }
    return {
      type: root.type,
      driveId: root.driveId,
      folderPath: [...(root.folderPath ? [root.folderPath] : []), ...unit.path].join("/"),
    };
  }
}

/** Stable across reruns: the boundary, the folder within it, and the scope. */
function mappingId(unit: Unit): string {
  const slug =
    unit.boundary.name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40)
      .replace(/-+$/u, "") || "boundary";
  const digest = createHash("sha256")
    .update(JSON.stringify([unit.boundary.id, unit.path, unit.filesOnly]))
    .digest("hex")
    .slice(0, 10);
  return `${slug}-${digest}${unit.filesOnly ? "-files" : ""}`;
}

function draftRoot(root: ManifestRoot): Record<string, unknown> {
  const { driveId, ...rest } = root;
  return { ...rest, [fileProvider(root.type).containerField ?? "driveId"]: driveId };
}

function memberKey(members: readonly BoundaryMember[]): string[] {
  return members.map((m) => JSON.stringify([m.id.toLowerCase(), m.type, m.role])).sort();
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface DiscoverResult {
  sourceProvider: FileProviderId;
  destinationProvider: FileProviderId;
  observedAt: string;
  capacity: {
    hardLimit: number | null;
    defaultTarget: number | null;
    targets: Record<string, number>;
  };
  boundaries: {
    id: string;
    kind: BoundaryKind;
    name: string;
    parent?: string;
    files: number;
    folders: number;
    members: BoundaryMember[] | null;
  }[];
  containers: ProposedContainer[];
  /** The reviewable draft; `--file` writes exactly this. */
  manifest: Partition["manifest"];
  notices: string[];
}

/** The review document: counts per boundary without its folder tree, and the draft. */
export function discoverResult(
  input: PartitionInput & { targets: Record<string, number> },
): DiscoverResult {
  const proposed = partition(input);
  const counts = (folder: DiscoveredFolder): { files: number; folders: number } => {
    let files = folder.files,
      folders = 0;
    for (const child of folder.folders) {
      const below = counts(child);
      files += below.files;
      folders += 1 + below.folders;
    }
    return { files, folders };
  };
  return {
    sourceProvider: input.discovery.sourceProvider,
    destinationProvider: input.destinationProvider,
    observedAt: input.discovery.observedAt,
    capacity: {
      hardLimit: input.hardLimit,
      defaultTarget: input.defaultTarget,
      targets: input.targets,
    },
    boundaries: [...input.discovery.boundaries]
      .sort((a, b) => compare(a.id, b.id))
      .map((boundary) => ({
        id: boundary.id,
        kind: boundary.kind,
        name: boundary.name,
        ...(boundary.parent !== undefined ? { parent: boundary.parent } : {}),
        ...counts(boundary.tree),
        members: boundary.members,
      })),
    containers: proposed.containers,
    manifest: proposed.manifest,
    notices: [...input.discovery.notices, ...proposed.notices],
  };
}
