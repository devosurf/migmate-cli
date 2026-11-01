import type { FileProviderId } from "./providers/adapters/capabilities.ts";
import type { ManifestMapping, ManifestRoot } from "./manifest.ts";

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

export interface Partition {
  manifest: { version: 1; mappings: ManifestMapping[] };
  containers: ProposedContainer[];
  notices: string[];
}
