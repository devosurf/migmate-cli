import type { CheckResult, JobType } from "../types.ts";
import type { ArchiveProvider } from "./archive.ts";

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
   * Google Drive v3 publishes no ETag and honours no `If-Match`, so the
   * destination's concurrency token is `headRevisionId` for a binary file's
   * content plus `modifiedTime`. Drive's own `version` is excluded: it was
   * measured advancing with no writer present. Comparing the token before a
   * write is a compare-then-write, not an atomic conditional update — see
   * ADR-0004 and `docs/release-limits.md`.
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

export interface RetryAfterError extends Error {
  retryAfterMs: number;
}

export function hasRetryAfter(error: unknown): error is RetryAfterError {
  if (typeof error !== "object" || error === null || !("retryAfterMs" in error)) {
    return false;
  }

  return typeof Reflect.get(error, "retryAfterMs") === "number";
}

export interface ProviderPort {
  archive?: ArchiveProvider;
  preflight?(input: {
    jobType: JobType;
    config: unknown;
    jobDirectory: string;
  }): AsyncIterable<CheckResult>;
  applicationIdentity?(): Promise<string>;
  close?(): Promise<void>;
  /** Exact immutable evidence to bind into plan inputs and re-check before execute. */
  qualificationEvidence?(): Promise<{
    digest: string;
    tuple: Record<string, unknown>;
    bundle: string;
  }>;
  binaryEvidence?(): Promise<Record<string, unknown>>;
  assertExecutionEvidence?(input: {
    applicationIdentity: string;
    binarySha256: string;
    binaryVersion: string;
    qualificationDigest: string;
  }): Promise<void>;
  reserveDestinationId?(): Promise<string>;
  readSourceItem?(input: { driveId: string; itemId: string }): Promise<SourceEntry | null>;
  readDestinationObject?(input: {
    driveId: string;
    objectId: string;
  }): Promise<DestinationEntry | null>;
  resolveSourceRoot(input: {
    sourceDriveId: string;
    sourceItemId: string;
  }): Promise<SourceEntry | null>;
  listSourceChildren(sourceItemId: string): Promise<SourceEntry[]>;
  openSourceContent(sourceItemId: string): AsyncIterable<Uint8Array>;

  resolveDestinationFolder(input: {
    destDriveId: string;
    destFolderId: string;
  }): Promise<DestinationEntry | null>;
  listDestinationChildren(destFolderId: string): Promise<DestinationEntry[]>;
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
    create?: boolean;
    marker?: ProvenanceRecord;
    expectedRevision?: string;
    parentFolderId: string;
    name: string;
    content: Uint8Array | AsyncIterable<Uint8Array>;
    createdAt: string;
    modifiedAt: string;
    mimeType: string | null;
  }): Promise<DestinationEntry>;
  moveDestinationObject(input: {
    objectId: string;
    parentFolderId: string;
    name: string;
    modifiedAt?: string;
    expectedRevision?: string;
    marker?: ProvenanceRecord;
  }): Promise<DestinationEntry>;
  readDestinationMarker(objectId: string): Promise<ProvenanceRecord | null>;
  writeDestinationMarker(input: {
    objectId: string;
    marker: ProvenanceRecord | null;
    expectedRevision?: string;
  }): Promise<void>;
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
