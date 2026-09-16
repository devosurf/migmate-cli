import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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
  readSourceItem?(input: { driveId: string; itemId: string }): Promise<SourceEntry | null>;
  readDestinationObject?(input: {
    driveId: string;
    objectId: string;
  }): Promise<DestinationEntry | null>;
  reserveDestinationId?(): Promise<string>;
  createDestinationFolder(
    input: Parameters<ProviderPort["createDestinationFolder"]>[0] & {
      destinationId?: string;
      marker?: FileMarker;
    },
  ): Promise<DestinationEntry>;
  uploadDestinationContent(
    input: Parameters<ProviderPort["uploadDestinationContent"]>[0] & {
      create?: boolean;
      marker?: FileMarker;
      expectedRevision?: string;
    },
  ): Promise<DestinationEntry>;
  moveDestinationObject(
    input: Parameters<ProviderPort["moveDestinationObject"]>[0] & {
      expectedRevision?: string;
      marker?: FileMarker;
    },
  ): Promise<DestinationEntry>;
  writeDestinationMarker(
    input: Parameters<ProviderPort["writeDestinationMarker"]>[0] & {
      expectedRevision?: string;
    },
  ): Promise<void>;
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
  const projected = source as SourceEntry &
    Partial<FileSourceEvidence> & {
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
    source.driveId,
    source.id,
    source.identity,
    source.parentId,
    source.name,
    source.kind,
    source.size,
    source.etag,
    source.createdAt,
    source.modifiedAt,
    source.mimeType,
    source.downloadable,
  ]);
}

export async function assertSourceStable(
  provider: FileProvider,
  source: SourceEntry | FileSourceEvidence,
): Promise<void> {
  let current: SourceEntry | null;
  try {
    current = provider.readSourceItem
      ? await provider.readSourceItem({ driveId: source.driveId, itemId: source.id })
      : await provider.resolveSourceRoot({
          sourceDriveId: source.driveId,
          sourceItemId: source.id,
        });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const fault = error as Error & { status?: number; statusCode?: number; transient?: boolean };
    const status = fault.status ?? fault.statusCode;
    if (
      fault.transient === true ||
      status === undefined ||
      status < 400 ||
      status >= 500 ||
      status === 429
    )
      throw error;
    throw Object.assign(new Error("Source metadata could not be read"), {
      code: "source_read_failed",
      status,
      transient: false,
    });
  }
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
export async function stageSource(
  ctx: FileContext,
  source: SourceEntry,
): Promise<{
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
export interface Observation {
  entry: DestinationEntry;
  sha256: string | null;
}
export async function readObject(
  provider: FileProvider,
  driveId: string,
  objectId: string,
): Promise<DestinationEntry | null> {
  return provider.readDestinationObject
    ? provider.readDestinationObject({ driveId, objectId })
    : provider.resolveDestinationFolder({ destDriveId: driveId, destFolderId: objectId });
}
export function terminalUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = error as Error & { status?: number; statusCode?: number; code?: string };
  return (
    [401, 403, 404].includes(detail.status ?? detail.statusCode ?? 0) ||
    detail.code === "content_verification_degraded"
  );
}
export async function observe(
  ctx: Pick<DriverContext<unknown>, "provider" | "signal">,
  entry: DestinationEntry,
): Promise<Observation> {
  const provider: FileProvider = ctx.provider;
  let sha256 = entry.reportedChecksum;
  if (entry.kind === "file" && !sha256) {
    try {
      sha256 = (await hashStream(provider.streamDestinationContent(entry.id), ctx.signal)).sha256;
    } catch (error) {
      if (!terminalUnavailable(error)) throw error;
    }
  }
  const fresh = await readObject(provider, entry.driveId, entry.id);
  if (
    !fresh ||
    fresh.revision !== entry.revision ||
    fresh.parentId !== entry.parentId ||
    fresh.name !== entry.name ||
    fresh.kind !== entry.kind ||
    fresh.size !== entry.size ||
    fresh.createdAt !== entry.createdAt ||
    fresh.modifiedAt !== entry.modifiedAt ||
    fresh.mimeType !== entry.mimeType ||
    fresh.reportedChecksum !== entry.reportedChecksum
  ) {
    throw Object.assign(new Error("Destination changed during its fingerprint read"), {
      code: "prior_copy_drift",
    });
  }
  return { entry: fresh, sha256: entry.kind === "file" ? sha256 : null };
}
export function markerMatches(actual: FileMarker | null, expected: FileMarker): boolean {
  return (
    actual !== null &&
    actual.mappingId === expected.mappingId &&
    actual.sourceDriveId === expected.sourceDriveId &&
    actual.sourceItemId === expected.sourceItemId &&
    actual.sourceIdentity === expected.sourceIdentity &&
    actual.sourceKind === expected.sourceKind &&
    actual.sourceRelativePath === expected.sourceRelativePath &&
    actual.sourceFingerprint === expected.sourceFingerprint &&
    actual.verifiedFingerprint === expected.verifiedFingerprint &&
    actual.createdAt === expected.createdAt &&
    actual.modifiedAt === expected.modifiedAt &&
    actual.mimeType === expected.mimeType &&
    actual.stateRevision === expected.stateRevision
  );
}
export function outputFindings(actual: Observation, expected: FileOutput): string[] {
  const codes: string[] = [];
  const entry = actual.entry;
  if (
    entry.id !== expected.id ||
    entry.driveId !== expected.driveId ||
    entry.parentId !== expected.parentId ||
    entry.name !== expected.name
  )
    codes.push("destination_path_mismatch");
  if (entry.kind !== expected.kind) codes.push("destination_type_conflict");
  if (expected.kind === "file") {
    if (entry.size !== expected.size) codes.push("size_mismatch");
    if (actual.sha256 === null) codes.push("content_verification_degraded");
    else if (expected.sha256 !== actual.sha256) codes.push("content_mismatch");
    if (
      Date.parse(entry.createdAt) !== Date.parse(expected.createdAt) ||
      second(entry.modifiedAt) !== second(expected.modifiedAt) ||
      entry.mimeType !== expected.mimeType
    ) {
      codes.push("metadata_mismatch");
    }
  }
  return codes;
}
