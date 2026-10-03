import { createHash } from "node:crypto";
import type { FileCommitRow } from "../commit.ts";
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
  webUrl: string | null;
  packageSections: number | null;
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

export interface FileScope {
  exclusions: FileExclusion[];
  sourceInventoryAt: string;
}

export interface FileEvidenceRow extends FileCommitRow {
  sourceEvidence?: FileSourceEvidence;
  nextStep: string | null;
  omissionReason: string | null;
  fileScope?: FileScope;
}

export type FileContext = DriverContext<FileMigrationConfig>;

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
    webUrl: source.webUrl,
    packageSections: source.packageSections,
    ...(richer.ctag !== undefined ? { ctag: richer.ctag } : {}),
    ...(richer.hashes !== undefined ? { hashes: richer.hashes } : {}),
    ...(richer.versionCount !== undefined ? { versionCount: richer.versionCount } : {}),
    ...(richer.listItemFields !== undefined ? { listItemFields: richer.listItemFields } : {}),
    ...(richer.contentType !== undefined ? { contentType: richer.contentType } : {}),
    ...(richer.retentionLabel !== undefined ? { retentionLabel: richer.retentionLabel } : {}),
  };
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

export interface Observation {
  entry: DestinationEntry;
  sha256: string | null;
}
export async function readObject(
  provider: ProviderPort,
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
  const provider = ctx.provider;
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
