import type { CheckResult, JobType } from "../types.ts";
import type { ArchiveProvider } from "./archive.ts";
import type { SharePointDiscovery } from "./discovery.ts";

export type SourceItemKind = "file" | "folder" | "package" | "reference" | "undownloadable";
export type DestinationItemKind = "file" | "folder" | "shortcut" | "document";

export interface SourceEntry {
  id: string;
  driveId: string;
  parentId: string | null;
  name: string;
  kind: SourceItemKind;
  size: number | null;
  etag: string | null;
  createdAt: string;
  modifiedAt: string;
  mimeType: string | null;
  identity: string;
  downloadable: boolean;
  webUrl: string | null;
  packageSections: number | null;
  metadata?: Record<string, unknown>;
}

export interface ProvenanceRecord {
  mappingId: string;
  sourceDriveId: string;
  sourceItemId: string;
  sourceIdentity: string;
  sourceKind: SourceItemKind;
  sourceRelativePath: string;
  sourceFingerprint: string | null;
  verifiedFingerprint: string | null;
  createdAt: string;
  modifiedAt: string;
  mimeType: string | null;
  stateRevision?: string;
}

export interface DestinationEntry {
  id: string;
  driveId: string;
  parentId: string | null;
  name: string;
  kind: DestinationItemKind;
  size: number | null;
  /**
   * Observed content revision and modified time, retained for Teams archive
   * verification. This is evidence of drift, not a conditional-write token.
   * Drive's `version` is excluded because it can advance without a writer.
   */
  revision: string | null;
  createdAt: string;
  modifiedAt: string;
  mimeType: string | null;
  reportedChecksum: string | null;
  provenance: ProvenanceRecord | null;
}

export interface TransferWorkerHandle {
  socketPath: string;
  pid: number;
  version: string;
  group?: string;
}

export interface TransferWorkerProbe {
  alive: boolean;
  version: string | null;
}

/** A resolved rclone filesystem; fake trees use their root item id as fs. */
export interface FilePassRoot {
  fs: string;
  kind: "local" | "sharepoint" | "google_drive";
}

export interface CopyPassHandle {
  executeId: string;
  jobid: number;
  group: string;
}

export interface CopyPassReference {
  socketPath: string;
  pass: CopyPassHandle;
}

export interface CopyPassStatus {
  state: "running" | "completed" | "failed";
  error: string | null;
}

export interface CopyPassStats {
  bytes: number;
  files: number;
  errors: number;
  speed: number;
  transferring: { path: string; bytes: number; size: number }[];
}

export interface FileHashEntry {
  path: string;
  size: number;
  hash: string | null;
  /** The backend's observed object identity, when it exposes one. */
  id?: string;
}

export interface FilePassPreviewEntry {
  /** Mapping-relative path; size is the listed byte count, not downloaded proof. */
  path: string;
  size: number;
}

/** Disjoint action classes, sorted by path. This predicts a pass, not content equality. */
export interface FilePassPreview {
  new: FilePassPreviewEntry[];
  changed: FilePassPreviewEntry[];
  unchanged: FilePassPreviewEntry[];
  deleted: FilePassPreviewEntry[];
  retained: FilePassPreviewEntry[];
  /** Equal common hash with a differing timestamp: no content transfer. */
  timestampOnly: FilePassPreviewEntry[];
  modifyWindowNs: string;
}

export interface FilePassProvider {
  previewCopyPass(input: {
    socketPath: string;
    source: FilePassRoot;
    /** Omit only for a job-created destination which does not exist yet. */
    destination?: FilePassRoot;
    excludePaths?: string[];
    mode: "copy" | "mirror";
    /** Listings have no deadline; aborting stops them. */
    signal?: AbortSignal;
  }): Promise<FilePassPreview>;
  startCopyPass(
    input: {
      socketPath: string;
      source: FilePassRoot;
      destination: FilePassRoot;
      transfers: number;
      /** Literal mapping-relative paths; each excludes the item and its subtree. */
      excludePaths?: string[];
    } & ({ mode: "copy" } | { mode: "mirror"; deleteLimit: number }),
  ): Promise<CopyPassHandle>;
  copyPassStatus(input: CopyPassReference): Promise<CopyPassStatus>;
  copyPassStats(input: CopyPassReference): Promise<CopyPassStats>;
  stopCopyPass(input: CopyPassReference): Promise<void>;
  /** Sorted recursive relative folder paths, excluding the root. */
  listFolders(input: {
    socketPath: string;
    root: FilePassRoot;
    signal?: AbortSignal;
  }): Promise<string[]>;
  listFileHashes(input: {
    socketPath: string;
    root: FilePassRoot;
    hashType: "sha256" | "md5" | "quickxor";
    download: boolean;
    /** Exact relative files to list and hash; an empty selection reads no files. */
    paths?: string[];
    signal?: AbortSignal;
  }): Promise<FileHashEntry[]>;
}

export interface RetryAfterError extends Error {
  retryAfterMs: number;
}

export function hasRetryAfter(error: unknown): error is RetryAfterError {
  if (typeof error !== "object" || error === null || !("retryAfterMs" in error)) {
    return false;
  }

  return typeof Reflect.get(error, "retryAfterMs") === "number";
}

export interface GoogleAbout {
  user: { emailAddress: string };
  canCreateDrives: boolean;
}

export interface DriveMember {
  email: string;
  type: "user" | "group";
  role: "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader";
}
export interface SharedDrive {
  id: string;
  name: string;
  createdTime?: string;
}
/** Observations include unsupported public/domain grants so verification can report them. */
export interface DriveMembership {
  email: string;
  type: string;
  role: string;
}

export interface ProviderPort extends FilePassProvider {
  googleAbout(signal?: AbortSignal): Promise<GoogleAbout>;
  readSharedDrive(driveId: string, signal?: AbortSignal): Promise<SharedDrive | null>;
  /** A 409 replay returns null: the caller must reconcile by exact name. */
  createSharedDrive(input: { name: string; requestId: string }): Promise<SharedDrive | null>;
  findSharedDrives(name: string): Promise<SharedDrive[]>;
  listDriveMembers(driveId: string): Promise<DriveMembership[]>;
  addDriveMember(driveId: string, member: DriveMember): Promise<void>;
  resolveFilePassSource(input: {
    sourceType?: "sharepoint" | "google_shared_drive";
    sourceDriveId: string;
    sourceItemId: string;
  }): Promise<{ socketPath: string; source: FilePassRoot }>;
  resolveFilePass(input: {
    sourceType?: "sharepoint" | "google_shared_drive";
    sourceDriveId: string;
    sourceItemId: string;
    destDriveId: string;
    destFolderId: string;
  }): Promise<{ socketPath: string; source: FilePassRoot; destination: FilePassRoot }>;
  archive?: ArchiveProvider;
  discoverSharePoint?(): Promise<SharePointDiscovery>;
  preflight?(input: {
    jobType: JobType;
    config: unknown;
    jobDirectory: string;
    signal?: AbortSignal;
  }): AsyncIterable<CheckResult>;
  applicationIdentity?(signal?: AbortSignal): Promise<string>;
  close?(): Promise<void>;
  binaryEvidence?(): Promise<Record<string, unknown>>;
  assertExecutionEvidence?(input: {
    applicationIdentity: string;
    binarySha256: string;
    binaryVersion: string;
  }): Promise<void>;
  reserveDestinationId?(): Promise<string>;
  readSourceItem?(input: {
    driveId: string;
    itemId: string;
    signal?: AbortSignal;
  }): Promise<SourceEntry | null>;
  readDestinationObject?(input: {
    driveId: string;
    objectId: string;
    signal?: AbortSignal;
  }): Promise<DestinationEntry | null>;
  resolveSourceFolder(input: { driveId: string; folderPath: string }): Promise<SourceEntry | null>;
  resolveDestinationPath(input: {
    driveId: string;
    folderPath: string;
  }): Promise<DestinationEntry | null>;
  resolveSourceRoot(input: {
    sourceDriveId: string;
    sourceItemId: string;
    signal?: AbortSignal;
  }): Promise<SourceEntry | null>;
  /** Graph item IDs are unique only within a drive: every source read names both. */
  listSourceChildren(input: {
    driveId: string;
    itemId: string;
    signal?: AbortSignal;
  }): Promise<SourceEntry[]>;
  openSourceContent(input: { driveId: string; itemId: string }): AsyncIterable<Uint8Array>;

  resolveDestinationFolder(input: {
    destDriveId: string;
    destFolderId: string;
    signal?: AbortSignal;
  }): Promise<DestinationEntry | null>;
  listDestinationChildren(destFolderId: string, signal?: AbortSignal): Promise<DestinationEntry[]>;
  createDestinationFolder(input: {
    destinationId?: string;
    marker?: ProvenanceRecord;
    parentFolderId: string;
    name: string;
    createdAt: string;
    modifiedAt: string;
  }): Promise<DestinationEntry>;
  uploadDestinationContent(input: {
    destinationId?: string;
    create?: true;
    marker?: ProvenanceRecord;
    parentFolderId: string;
    name: string;
    content: Uint8Array | AsyncIterable<Uint8Array>;
    createdAt: string;
    modifiedAt: string;
    mimeType: string | null;
  }): Promise<DestinationEntry>;
  readDestinationMarker(objectId: string): Promise<ProvenanceRecord | null>;
  streamDestinationContent(objectId: string): AsyncIterable<Uint8Array>;

  startTransferWorker(input: {
    runDirectory: string;
    onPrepare?: (intent: { socketPath: string; group: string; executablePath: string }) => void;
    onSpawn?: (handle: TransferWorkerHandle & { executablePath: string }) => void;
  }): Promise<TransferWorkerHandle>;
  probeTransferWorker(input: { socketPath: string }): Promise<TransferWorkerProbe>;
  stopTransferWorker(input: { socketPath: string }): Promise<void>;
  terminateTransferWorker(input: { socketPath: string }): Promise<void>;
  transferWorkerVersion(input: { socketPath: string }): Promise<string | null>;
}
