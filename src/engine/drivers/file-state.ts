import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CheckResult } from "../types.ts";
import type { CommitRow, FileCommitRow } from "../commit.ts";
import type { DriverContext } from "./types.ts";
import type {
  DestinationEntry,
  ProviderPort,
  ProvenanceRecord,
  SourceEntry,
} from "../providers/port.ts";
import type { FileMigrationConfig } from "./file-migration.ts";

export interface FileExclusion {
  sourceItemId: string;
  reason: string;
}

/** Explicit allowlist: provider objects and transient download URLs never enter state. */
export interface FileSourceEvidence {
  id: string;
  driveId: string;
  identity: string;
  parentId: string | null;
  name: string;
  kind: SourceEntry["kind"];
  size: number | null;
  etag: string | null;
  createdAt: string;
  modifiedAt: string;
  mimeType: string | null;
  downloadable: boolean;
  ctag?: string | null;
  hashes?: Record<string, string>;
  versionCount?: number;
  listItemFields?: Record<string, unknown>;
  contentType?: unknown;
  retentionLabel?: unknown;
}

export interface FileOutput {
  id: string;
  driveId: string;
  parentId: string | null;
  name: string;
  kind: "file" | "folder";
  size: number | null;
  createdAt: string;
  modifiedAt: string;
  mimeType: string | null;
  sha256: string | null;
}

export interface FileMarker extends ProvenanceRecord {
  stateRevision?: string;
}

/** Persist the whole object, including prepared intents, before advancing the generator. */
export interface FileState {
  version: 1;
  generation: number;
  status: "prepared" | "verified" | "unverified";
  attempt: string;
  action: "created" | "updated" | "moved";
  source: FileSourceEvidence;
  sourceFingerprint: string | null;
  relativePath: string;
  output: FileOutput;
  marker: FileMarker;
  previous: { output: FileOutput; marker: FileMarker } | null;
}

export interface FileScope {
  exclusions: FileExclusion[];
  destinationBaseline: Array<{ driveId: string; itemId: string }>;
  sourceInventoryAt: string;
}

export interface FileEvidenceRow extends FileCommitRow {
  fileState?: FileState;
  sourceEvidence?: FileSourceEvidence;
  fileScope?: FileScope;
}

/** Structural until the integration owner adds these fields to the shared context. */
export type FileContext = DriverContext<FileMigrationConfig> & {
  jobDirectory?: string;
  resume: DriverContext<FileMigrationConfig>["resume"] & {
    rows?: CommitRow[];
    committedUnits?: string[];
  };
};

export type FileProvider = ProviderPort & {
  preflight?(input: {
    jobType: "file_migration";
    config: unknown;
    jobDirectory: string;
  }): AsyncIterable<CheckResult>;
  readSourceItem?(input: { driveId: string; itemId: string }): Promise<SourceEntry | null>;
  readDestinationObject?(input: {
    driveId: string;
    objectId: string;
  }): Promise<DestinationEntry | null>;
  reserveDestinationId?(): Promise<string>;
  createDestinationFolder(input: Parameters<ProviderPort["createDestinationFolder"]>[0] & {
    destinationId?: string;
    marker?: FileMarker;
  }): Promise<DestinationEntry>;
  uploadDestinationContent(input: Parameters<ProviderPort["uploadDestinationContent"]>[0] & {
    create?: boolean;
    marker?: FileMarker;
    expectedEtag?: string;
  }): Promise<DestinationEntry>;
  moveDestinationObject(input: Parameters<ProviderPort["moveDestinationObject"]>[0] & {
    expectedEtag?: string;
    marker?: FileMarker;
  }): Promise<DestinationEntry>;
  writeDestinationMarker(input: Parameters<ProviderPort["writeDestinationMarker"]>[0] & {
    expectedEtag?: string;
  }): Promise<void>;
};

export class FileSourceChangedError extends Error {
  readonly code = "source_read_failed";
  readonly retryable = true;
  readonly transient = true;
  readonly reason = "source_changed";
  readonly sourceItemId: string;
  constructor(sourceItemId: string) {
    super("Source changed before its content fingerprint could be accepted");
    this.name = "FileSourceChangedError";
    this.sourceItemId = sourceItemId;
  }
}

export class FilePlanRevisionRequiredError extends Error {
  readonly code = "plan_revision_required";
  constructor() {
    super("The expanded stable exclusion set changed; a new plan is required");
    this.name = "FilePlanRevisionRequiredError";
  }
}

export function sourceEvidence(source: SourceEntry): FileSourceEvidence {
  const projected = source as SourceEntry & Partial<FileSourceEvidence> & {
    metadata?: Partial<FileSourceEvidence>;
  };
  const richer = projected.metadata ?? projected;
  return {
    id: source.id,
    driveId: source.driveId,
    identity: source.identity,
    parentId: source.parentId,
    name: source.name,
    kind: source.kind,
    size: source.size,
    etag: source.etag,
    createdAt: source.createdAt,
    modifiedAt: source.modifiedAt,
    mimeType: source.mimeType,
    downloadable: source.downloadable,
    ...(richer.ctag !== undefined ? { ctag: richer.ctag } : {}),
    ...(richer.hashes !== undefined ? { hashes: richer.hashes } : {}),
    ...(richer.versionCount !== undefined ? { versionCount: richer.versionCount } : {}),
    ...(richer.listItemFields !== undefined ? { listItemFields: richer.listItemFields } : {}),
    ...(richer.contentType !== undefined ? { contentType: richer.contentType } : {}),
    ...(richer.retentionLabel !== undefined ? { retentionLabel: richer.retentionLabel } : {}),
  };
}

export function sourceToken(source: SourceEntry | FileSourceEvidence): string {
  return JSON.stringify([
    source.driveId, source.id, source.identity, source.parentId, source.name, source.kind,
    source.size, source.etag, source.createdAt, source.modifiedAt, source.mimeType,
    source.downloadable,
  ]);
}

export async function assertSourceStable(
  provider: FileProvider,
  source: SourceEntry | FileSourceEvidence,
): Promise<void> {
  const current = provider.readSourceItem
    ? await provider.readSourceItem({ driveId: source.driveId, itemId: source.id })
    : await provider.resolveSourceRoot({ sourceDriveId: source.driveId, sourceItemId: source.id });
  if (!current || sourceToken(current) !== sourceToken(source)) {
    throw new FileSourceChangedError(source.id);
  }
}

export function second(value: string): number {
  return Math.floor(Date.parse(value) / 1000);
}

export async function hashStream(
  content: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of content) {
    signal?.throwIfAborted();
    hash.update(chunk);
    size += chunk.byteLength;
  }
  signal?.throwIfAborted();
  return { sha256: hash.digest("hex"), size };
}

/** One file on disk, bounded stream buffers, removed even on generator cancellation. */
export async function stageSource(ctx: FileContext, source: SourceEntry): Promise<{
  sha256: string;
  size: number;
  content: () => AsyncIterable<Uint8Array>;
  dispose: () => Promise<void>;
}> {
  if (!ctx.jobDirectory) throw new Error("File execution requires DriverContext.jobDirectory");
  const stagingRoot = join(ctx.jobDirectory, "assets", ".staging");
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(stagingRoot, "file-"));
  const path = join(directory, "content");
  const hash = createHash("sha256");
  let size = 0;
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const provider: FileProvider = ctx.provider;
    await assertSourceStable(provider, source);
    await pipeline(
      Readable.from(provider.openSourceContent(source.id)),
      new Transform({
        transform(chunk: Uint8Array, _encoding, callback) {
          hash.update(chunk);
          size += chunk.byteLength;
          callback(null, chunk);
        },
      }),
      createWriteStream(path, { mode: 0o600, flags: "wx" }),
      { signal: ctx.signal },
    );
    await assertSourceStable(provider, source);
    if (source.size !== null && source.size !== size) throw new FileSourceChangedError(source.id);
    return { sha256: hash.digest("hex"), size, content: () => createReadStream(path), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
