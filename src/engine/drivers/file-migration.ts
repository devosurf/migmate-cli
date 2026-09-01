import { createHash } from "node:crypto";
import type { CheckResult, CodeKind } from "../types.ts";
import { CODE_BY_NAME } from "../codes.ts";
import type {
  CommitFinding,
  CommitRow,
  CommitUnit,
  DriverContext,
  JobTypeDriver,
  ReportSection,
} from "./types.ts";
import {
  hasRetryAfter,
  type DestinationEntry,
  type ProviderPort,
  type ProvenanceRecord,
  type SourceEntry,
} from "../providers/port.ts";

export interface FileMappingConfig {
  id: string;
  sourceDriveId: string;
  sourceItemId: string;
  destDriveId: string;
  destFolderId: string;
  exclusions?: string[];
}

export interface FileMigrationConfig {
  mappings: FileMappingConfig[];
}

type Phase = "plan" | "execute" | "verify";
type FileRow = Extract<CommitRow, { jobType: "file_migration" }>;

type ActionCode =
  | "created"
  | "updated"
  | "moved"
  | "unchanged"
  | "destination_only_retained"
  | "source_deleted_destination_retained"
  | "source_package_omitted"
  | "source_reference_omitted"
  | "source_content_unavailable"
  | "path_unrepresentable"
  | "mapping_overlap"
  | "destination_duplicate_name"
  | "destination_type_conflict"
  | "unowned_path_collision"
  | "prior_copy_drift"
  | "source_identity_reuse_collision"
  | "content_verification_degraded";

interface SourceView extends SourceEntry {
  path: string;
  parentPath: string;
  representable: boolean;
}

interface DestinationView extends DestinationEntry {
  path: string;
  parentPath: string;
  checksum: string | null;
}

interface MappingSnapshot {
  sourceRoot: SourceView;
  destinationRoot: DestinationView;
  sourceOrder: SourceView[];
  destinationOrder: DestinationView[];
  sourceById: Record<string, SourceView>;
  sourceByPath: Record<string, SourceView[]>;
  destinationById: Record<string, DestinationView>;
  destinationByPath: Record<string, DestinationView[]>;
  destinationBySourceItemId: Record<string, DestinationView[]>;
}

interface PreparedItem {
  row: FileRow;
  findings: CommitFinding[];
  apply?: () => Promise<DestinationEntry | null>;
}

const utf8 = new TextEncoder();

function encodeBytes(value: Uint8Array | string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  return utf8.encode(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBytes(content: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (content instanceof Uint8Array) {
    return content;
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of content) {
    chunks.push(chunk);
  }

  let size = 0;
  for (const chunk of chunks) {
    size += chunk.byteLength;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function readStreamHash(
  content: Uint8Array | AsyncIterable<Uint8Array>,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const bytes = await readBytes(content);
  return { bytes, sha256: sha256(bytes) };
}

function isRepresentableSegment(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\u0000") &&
    name !== "." &&
    name !== ".."
  );
}

function joinPath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function leafName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function makeFinding(
  rev: number,
  phase: Phase,
  code: string,
  subjectId: string,
  subjectKind: string,
  at: string,
  evidence: Record<string, unknown>,
): CommitFinding {
  return {
    rev,
    phase,
    code,
    kind: "finding",
    subjectKind,
    subjectId,
    evidence,
    at,
  };
}

function rowId(mappingId: string, sourceItemId: string, phase: Phase, path: string): string {
  return `${mappingId}:${sourceItemId}:${phase}:${path}`;
}

/**
 * A row's `kind` is the registry's classification of its code, never the item's
 * own file/folder kind — acceptance and closure gating both branch on it.
 * An unregistered code is a defect in this driver, not an operator-facing refusal.
 */
function codeKind(code: ActionCode): CodeKind {
  const kind = CODE_BY_NAME[code]?.kind;
  if (kind === undefined) throw new Error(`unregistered code: ${code}`);
  return kind;
}

function currentChecksum(entry: DestinationView): string | null {
  return entry.reportedChecksum ?? entry.checksum;
}

function fileRow(
  rev: number,
  phase: Phase,
  mapping: FileMappingConfig,
  source: SourceView,
  code: ActionCode,
  path: string,
): FileRow {
  return {
    id: rowId(mapping.id, source.id, phase, path),
    jobType: "file_migration",
    rev,
    phase,
    code,
    kind: codeKind(code),
    accepted: false,
    mappingId: mapping.id,
    sourceDriveId: source.driveId,
    sourceItemId: source.id,
    relativePath: path,
    itemType: source.kind === "folder" ? "folder" : "file",
    size: source.size,
    sourceEtag: source.etag,
    sourceFingerprint: null,
    destinationDriveId: null,
    destinationFileId: null,
    destinationFingerprint: null,
    provenanceState: "none",
  };
}

function destinationRow(
  rev: number,
  phase: Phase,
  mapping: FileMappingConfig,
  sourceId: string,
  sourceDriveId: string,
  path: string,
  itemKind: string,
  code: ActionCode,
): FileRow {
  return {
    id: rowId(mapping.id, sourceId, phase, path),
    jobType: "file_migration",
    rev,
    phase,
    code,
    kind: codeKind(code),
    accepted: false,
    mappingId: mapping.id,
    sourceDriveId,
    sourceItemId: sourceId,
    relativePath: path,
    itemType: itemKind === "folder" ? "folder" : "file",
    size: null,
    sourceEtag: null,
    sourceFingerprint: null,
    destinationDriveId: mapping.destDriveId,
    destinationFileId: null,
    destinationFingerprint: null,
    provenanceState: "verified",
  };
}

function buildProvenance(
  mapping: FileMappingConfig,
  source: SourceView,
  fingerprint: string | null,
  now: string,
): ProvenanceRecord {
  return {
    mappingId: mapping.id,
    sourceDriveId: source.driveId,
    sourceItemId: source.id,
    sourceIdentity: source.identity,
    sourceKind: source.kind,
    sourceRelativePath: source.path,
    sourceFingerprint: fingerprint,
    verifiedFingerprint: fingerprint,
    createdAt: now,
    modifiedAt: now,
    mimeType: source.mimeType,
  };
}

async function retryable<T>(
  ctx: DriverContext<FileMigrationConfig>,
  op: () => Promise<T>,
): Promise<T> {
  let retries = 0;
  while (true) {
    try {
      return await op();
    } catch (error) {
      if (!hasRetryAfter(error) || retries >= 8) {
        throw error;
      }

      retries += 1;
      if (ctx.signal?.aborted) {
        throw new Error("aborted");
      }
    }
  }
}

async function loadSourceSnapshot(
  ctx: DriverContext<FileMigrationConfig>,
  provider: ProviderPort,
  root: SourceEntry,
): Promise<{
  order: SourceView[];
  byId: Record<string, SourceView>;
  byPath: Record<string, SourceView[]>;
}> {
  const order: SourceView[] = [];
  const byId: Record<string, SourceView> = Object.create(null);
  const byPath: Record<string, SourceView[]> = Object.create(null);

  const visit = async (
    entry: SourceEntry,
    path: string,
    parentPath: string,
    representable: boolean,
  ): Promise<void> => {
    const view: SourceView = { ...entry, path, parentPath, representable };
    order.push(view);
    byId[view.id] = view;
    const bucket = byPath[path] ?? [];
    bucket.push(view);
    byPath[path] = bucket;

    if (entry.kind !== "folder") {
      return;
    }

    const children = await retryable(ctx, () => provider.listSourceChildren(entry.id));
    for (const child of children) {
      const childRepresentable = isRepresentableSegment(child.name);
      await visit(child, joinPath(path, child.name), path, childRepresentable);
    }
  };

  await visit(root, ".", "", true);
  return { order, byId, byPath };
}

async function loadDestinationSnapshot(
  ctx: DriverContext<FileMigrationConfig>,
  provider: ProviderPort,
  root: DestinationEntry,
): Promise<{
  order: DestinationView[];
  byId: Record<string, DestinationView>;
  byPath: Record<string, DestinationView[]>;
  bySourceItemId: Record<string, DestinationView[]>;
}> {
  const order: DestinationView[] = [];
  const byId: Record<string, DestinationView> = Object.create(null);
  const byPath: Record<string, DestinationView[]> = Object.create(null);
  const bySourceItemId: Record<string, DestinationView[]> = Object.create(null);

  const visit = async (
    entry: DestinationEntry,
    path: string,
    parentPath: string,
  ): Promise<void> => {
    const view: DestinationView = {
      ...entry,
      path,
      parentPath,
      checksum: currentChecksum({
        ...entry,
        path,
        parentPath,
        checksum: entry.reportedChecksum ?? null,
      }),
    };
    order.push(view);
    byId[view.id] = view;
    const bucket = byPath[path] ?? [];
    bucket.push(view);
    byPath[path] = bucket;
    if (view.provenance) {
      const provenanceBucket = bySourceItemId[view.provenance.sourceItemId] ?? [];
      provenanceBucket.push(view);
      bySourceItemId[view.provenance.sourceItemId] = provenanceBucket;
    }

    if (entry.kind !== "folder") {
      return;
    }

    const children = await retryable(ctx, () => provider.listDestinationChildren(entry.id));
    for (const child of children) {
      await visit(child, joinPath(path, child.name), path);
    }
  };

  await visit(root, ".", "");
  return { order, byId, byPath, bySourceItemId };
}

async function buildSnapshot(
  ctx: DriverContext<FileMigrationConfig>,
  provider: ProviderPort,
  mapping: FileMappingConfig,
): Promise<MappingSnapshot> {
  const sourceRoot = await retryable(ctx, () =>
    provider.resolveSourceRoot({
      sourceDriveId: mapping.sourceDriveId,
      sourceItemId: mapping.sourceItemId,
    }),
  );
  if (!sourceRoot) {
    throw new Error(`missing source root ${mapping.sourceItemId}`);
  }

  const destinationRoot = await retryable(ctx, () =>
    provider.resolveDestinationFolder({
      destDriveId: mapping.destDriveId,
      destFolderId: mapping.destFolderId,
    }),
  );
  if (!destinationRoot) {
    throw new Error(`missing destination folder ${mapping.destFolderId}`);
  }

  const source = await loadSourceSnapshot(ctx, provider, sourceRoot);
  const destination = await loadDestinationSnapshot(ctx, provider, destinationRoot);
  const sourceRootView = source.order[0];
  const destinationRootView = destination.order[0];
  if (!sourceRootView || !destinationRootView) {
    throw new Error("tree traversal failed");
  }

  return {
    sourceRoot: sourceRootView,
    destinationRoot: destinationRootView,
    sourceOrder: source.order,
    destinationOrder: destination.order,
    sourceById: source.byId,
    sourceByPath: source.byPath,
    destinationById: destination.byId,
    destinationByPath: destination.byPath,
    destinationBySourceItemId: destination.bySourceItemId,
  };
}

function mappingFindings(
  ctx: DriverContext<FileMigrationConfig>,
  mapping: FileMappingConfig,
  snapshot: MappingSnapshot,
): CommitFinding[] {
  const now = ctx.now().toISOString();
  const findings: CommitFinding[] = [];
  const duplicates = ctx.config.mappings.filter(
    (candidate) =>
      candidate.id !== mapping.id &&
      candidate.sourceDriveId === mapping.sourceDriveId &&
      candidate.sourceItemId === mapping.sourceItemId,
  );
  if (duplicates.length > 0) {
    findings.push(
      makeFinding(ctx.revision, "plan", "mapping_overlap", mapping.id, "mapping", now, {
        sourceItemId: mapping.sourceItemId,
      }),
    );
  }

  const destinationDuplicates = ctx.config.mappings.filter(
    (candidate) =>
      candidate.id !== mapping.id &&
      candidate.destDriveId === mapping.destDriveId &&
      candidate.destFolderId === mapping.destFolderId,
  );
  if (destinationDuplicates.length > 0) {
    findings.push(
      makeFinding(ctx.revision, "plan", "mapping_overlap", mapping.id, "mapping", now, {
        destFolderId: mapping.destFolderId,
      }),
    );
  }

  if (!snapshot.sourceRoot.representable) {
    findings.push(
      makeFinding(ctx.revision, "plan", "path_unrepresentable", mapping.id, "mapping", now, {
        path: snapshot.sourceRoot.path,
      }),
    );
  }

  return findings;
}

function destinationParentFor(
  snapshot: MappingSnapshot,
  sourceParentPath: string,
): DestinationView {
  return snapshot.destinationByPath[sourceParentPath]?.[0] ?? snapshot.destinationRoot;
}

function matchingProvenance(
  destination: DestinationView | null,
  mapping: FileMappingConfig,
  source: SourceView,
): boolean {
  if (!destination || !destination.provenance) {
    return false;
  }

  return (
    destination.provenance.mappingId === mapping.id &&
    destination.provenance.sourceItemId === source.id
  );
}

function sourceBytesFor(source: SourceView): Uint8Array | null {
  return source.kind === "file" ? null : null;
}

async function readSourceContent(
  ctx: DriverContext<FileMigrationConfig>,
  provider: ProviderPort,
  source: SourceView,
): Promise<{ bytes: Uint8Array | null; sha256: string | null }> {
  if (source.kind !== "file" || !source.downloadable) {
    return { bytes: null, sha256: null };
  }

  return retryable(ctx, async () => {
    const stream = provider.openSourceContent(source.id);
    const { bytes, sha256 } = await readStreamHash(stream);
    return { bytes, sha256 };
  });
}

async function readDestinationContent(
  ctx: DriverContext<FileMigrationConfig>,
  provider: ProviderPort,
  destination: DestinationView,
): Promise<{ bytes: Uint8Array | null; sha256: string | null }> {
  if (destination.kind !== "file") {
    return { bytes: null, sha256: null };
  }

  const reported = currentChecksum(destination);
  if (reported) {
    return { bytes: null, sha256: reported };
  }

  try {
    return await retryable(ctx, async () => {
      const stream = provider.streamDestinationContent(destination.id);
      const { bytes, sha256 } = await readStreamHash(stream);
      return { bytes, sha256 };
    });
  } catch {
    return { bytes: null, sha256: null };
  }
}

function rootRow(
  rev: number,
  phase: Phase,
  mapping: FileMappingConfig,
  source: SourceView,
  destination: DestinationView,
  code: ActionCode,
  sourceFingerprint: string | null,
): FileRow {
  return {
    id: rowId(mapping.id, source.id, phase, source.path),
    jobType: "file_migration",
    rev,
    phase,
    code,
    kind: codeKind(code),
    accepted: false,
    mappingId: mapping.id,
    sourceDriveId: source.driveId,
    sourceItemId: source.id,
    relativePath: source.path,
    itemType: "folder",
    size: source.size,
    sourceEtag: source.etag,
    sourceFingerprint,
    destinationDriveId: destination.driveId,
    destinationFileId: destination.id,
    destinationFingerprint: currentChecksum(destination),
    provenanceState: phase === "verify" ? "verified" : "none",
  };
}

function retainedRow(
  rev: number,
  phase: Phase,
  mapping: FileMappingConfig,
  destination: DestinationView,
  sourceId: string,
  sourceDriveId: string,
  code: ActionCode,
): FileRow {
  return {
    id: rowId(mapping.id, sourceId, phase, destination.path),
    jobType: "file_migration",
    rev,
    phase,
    code,
    kind: codeKind(code),
    accepted: false,
    mappingId: mapping.id,
    sourceDriveId,
    sourceItemId: sourceId,
    relativePath: destination.path,
    itemType: destination.kind === "folder" ? "folder" : "file",
    size: destination.size,
    sourceEtag: destination.provenance?.sourceFingerprint ?? null,
    sourceFingerprint:
      destination.provenance?.verifiedFingerprint ??
      destination.provenance?.sourceFingerprint ??
      null,
    destinationDriveId: mapping.destDriveId,
    destinationFileId: destination.id,
    destinationFingerprint: currentChecksum(destination),
    provenanceState: destination.provenance ? "verified" : "none",
  };
}

function duplicateNameExists(entries: DestinationView[] | undefined): boolean {
  return (entries?.length ?? 0) > 1;
}

function buildBlockerFinding(
  ctx: DriverContext<FileMigrationConfig>,
  phase: Phase,
  code: string,
  source: SourceView,
  evidence: Record<string, unknown>,
): CommitFinding {
  return makeFinding(
    ctx.revision,
    phase,
    code,
    source.id,
    "item",
    ctx.now().toISOString(),
    evidence,
  );
}

async function evaluateSourceItem(
  ctx: DriverContext<FileMigrationConfig>,
  phase: Phase,
  provider: ProviderPort,
  mapping: FileMappingConfig,
  snapshot: MappingSnapshot,
  source: SourceView,
): Promise<PreparedItem> {
  const sourceContent = await readSourceContent(ctx, provider, source);
  const sourceFingerprint = sourceContent.sha256;
  const sourceBytes = sourceContent.bytes;

  if (!source.representable) {
    const row = fileRow(ctx.revision, phase, mapping, source, "path_unrepresentable", source.path);
    row.sourceFingerprint = sourceFingerprint;
    return {
      row,
      findings: [
        buildBlockerFinding(ctx, phase, "path_unrepresentable", source, { path: source.path }),
      ],
    };
  }

  if (source.id === mapping.sourceItemId) {
    const row = rootRow(
      ctx.revision,
      phase,
      mapping,
      source,
      snapshot.destinationRoot,
      "unchanged",
      sourceFingerprint,
    );
    return { row, findings: [] };
  }

  if (source.kind === "package") {
    const row = fileRow(
      ctx.revision,
      phase,
      mapping,
      source,
      "source_package_omitted",
      source.path,
    );
    row.sourceFingerprint = sourceFingerprint;
    return { row, findings: [] };
  }

  if (source.kind === "reference") {
    const row = fileRow(
      ctx.revision,
      phase,
      mapping,
      source,
      "source_reference_omitted",
      source.path,
    );
    row.sourceFingerprint = sourceFingerprint;
    return { row, findings: [] };
  }

  if (
    source.kind === "undownloadable" ||
    !source.downloadable ||
    (source.kind === "file" && sourceBytes === null)
  ) {
    const row = fileRow(
      ctx.revision,
      phase,
      mapping,
      source,
      "source_content_unavailable",
      source.path,
    );
    row.sourceFingerprint = sourceFingerprint;
    return { row, findings: [] };
  }

  const parent = source.parentId ? snapshot.sourceById[source.parentId] : null;
  const destinationParent = destinationParentFor(snapshot, parent?.path ?? ".");
  const pathEntries = snapshot.destinationByPath[source.path] ?? [];
  if (duplicateNameExists(pathEntries)) {
    const row = fileRow(
      ctx.revision,
      phase,
      mapping,
      source,
      "destination_duplicate_name",
      source.path,
    );
    row.sourceFingerprint = sourceFingerprint;
    return {
      row,
      findings: [
        buildBlockerFinding(ctx, phase, "destination_duplicate_name", source, {
          path: source.path,
        }),
      ],
    };
  }

  const destinationAtPath = pathEntries[0] ?? null;
  const destinationBySource = snapshot.destinationBySourceItemId[source.id]?.[0] ?? null;

  if (destinationBySource) {
    if (
      !destinationBySource.provenance ||
      destinationBySource.provenance.mappingId !== mapping.id
    ) {
      const row = fileRow(
        ctx.revision,
        phase,
        mapping,
        source,
        "unowned_path_collision",
        source.path,
      );
      row.sourceFingerprint = sourceFingerprint;
      return {
        row,
        findings: [
          buildBlockerFinding(ctx, phase, "unowned_path_collision", source, {
            path: source.path,
            destinationId: destinationBySource.id,
          }),
        ],
      };
    }

    if (destinationBySource.provenance.sourceIdentity !== source.identity) {
      const row = fileRow(
        ctx.revision,
        phase,
        mapping,
        source,
        "source_identity_reuse_collision",
        source.path,
      );
      row.sourceFingerprint = sourceFingerprint;
      return {
        row,
        findings: [
          buildBlockerFinding(ctx, phase, "source_identity_reuse_collision", source, {
            path: source.path,
            destinationId: destinationBySource.id,
          }),
        ],
      };
    }

    if (source.kind === "folder") {
      const samePath = destinationBySource.path === source.path;
      const row = fileRow(
        ctx.revision,
        phase,
        mapping,
        source,
        samePath ? "unchanged" : "moved",
        source.path,
      );
      row.sourceFingerprint = null;
      row.destinationDriveId = mapping.destDriveId;
      row.destinationFileId = destinationBySource.id;
      row.destinationFingerprint = null;
      row.provenanceState = phase === "verify" ? "verified" : "marked";

      if (phase === "execute" && !samePath) {
        return {
          row,
          findings: [],
          apply: async () => {
            const moved = await retryable(ctx, () =>
              provider.moveDestinationObject({
                objectId: destinationBySource.id,
                parentFolderId: destinationParent.id,
                name: source.name,
                modifiedAt: source.modifiedAt,
              }),
            );
            await provider.writeDestinationMarker({
              objectId: moved.id,
              marker: buildProvenance(mapping, source, null, ctx.now().toISOString()),
            });
            return moved;
          },
        };
      }

      return { row, findings: [] };
    }

    const destinationContent = await readDestinationContent(ctx, provider, destinationBySource);
    const destinationFingerprint = destinationContent.sha256;
    if (
      destinationBySource.provenance.verifiedFingerprint &&
      destinationFingerprint &&
      destinationFingerprint !== destinationBySource.provenance.verifiedFingerprint
    ) {
      const row = fileRow(ctx.revision, phase, mapping, source, "prior_copy_drift", source.path);
      row.sourceFingerprint = sourceFingerprint;
      row.destinationDriveId = mapping.destDriveId;
      row.destinationFileId = destinationBySource.id;
      row.destinationFingerprint = destinationFingerprint;
      row.provenanceState = "drifted";
      return {
        row,
        findings: [
          buildBlockerFinding(ctx, phase, "prior_copy_drift", source, {
            path: source.path,
            destinationId: destinationBySource.id,
          }),
        ],
      };
    }

    const samePath = destinationBySource.path === source.path;
    const sameFingerprint =
      sourceFingerprint !== null &&
      destinationFingerprint !== null &&
      sourceFingerprint === destinationFingerprint;
    const outcome: ActionCode =
      samePath && sameFingerprint
        ? "unchanged"
        : samePath
          ? phase === "verify"
            ? "content_verification_degraded"
            : "updated"
          : "moved";
    const row = fileRow(ctx.revision, phase, mapping, source, outcome, source.path);
    row.sourceFingerprint = sourceFingerprint;
    row.destinationDriveId = mapping.destDriveId;
    row.destinationFileId = destinationBySource.id;
    row.destinationFingerprint = destinationFingerprint;
    row.provenanceState = phase === "verify" && sameFingerprint ? "verified" : "marked";

    if (phase === "execute") {
      if (!samePath) {
        return {
          row,
          findings: [],
          apply: async () => {
            const moved = await retryable(ctx, () =>
              provider.moveDestinationObject({
                objectId: destinationBySource.id,
                parentFolderId: destinationParent.id,
                name: source.name,
                modifiedAt: source.modifiedAt,
              }),
            );
            await provider.writeDestinationMarker({
              objectId: moved.id,
              marker: buildProvenance(mapping, source, sourceFingerprint, ctx.now().toISOString()),
            });
            return moved;
          },
        };
      }

      if (!sameFingerprint && sourceBytes) {
        return {
          row,
          findings: [],
          apply: async () => {
            const updated = await retryable(ctx, () =>
              provider.uploadDestinationContent({
                destinationId: destinationBySource.id,
                parentFolderId: destinationParent.id,
                name: source.name,
                content: sourceBytes,
                createdAt: destinationBySource.createdAt,
                modifiedAt: source.modifiedAt,
                mimeType: source.mimeType,
              }),
            );
            await provider.writeDestinationMarker({
              objectId: updated.id,
              marker: buildProvenance(mapping, source, sourceFingerprint, ctx.now().toISOString()),
            });
            return updated;
          },
        };
      }
    }

    return { row, findings: [] };
  }

  if (destinationAtPath) {
    if (source.kind === "file" && destinationAtPath.kind !== "file") {
      const row = fileRow(
        ctx.revision,
        phase,
        mapping,
        source,
        "destination_type_conflict",
        source.path,
      );
      row.sourceFingerprint = sourceFingerprint;
      return {
        row,
        findings: [
          buildBlockerFinding(ctx, phase, "destination_type_conflict", source, {
            path: source.path,
            destinationKind: destinationAtPath.kind,
          }),
        ],
      };
    }

    if (source.kind === "folder" && destinationAtPath.kind !== "folder") {
      const row = fileRow(
        ctx.revision,
        phase,
        mapping,
        source,
        "destination_type_conflict",
        source.path,
      );
      row.sourceFingerprint = sourceFingerprint;
      return {
        row,
        findings: [
          buildBlockerFinding(ctx, phase, "destination_type_conflict", source, {
            path: source.path,
            destinationKind: destinationAtPath.kind,
          }),
        ],
      };
    }

    if (!destinationAtPath.provenance || destinationAtPath.provenance.mappingId !== mapping.id) {
      const row = fileRow(
        ctx.revision,
        phase,
        mapping,
        source,
        "unowned_path_collision",
        source.path,
      );
      row.sourceFingerprint = sourceFingerprint;
      return {
        row,
        findings: [
          buildBlockerFinding(ctx, phase, "unowned_path_collision", source, {
            path: source.path,
            destinationId: destinationAtPath.id,
          }),
        ],
      };
    }
  }

  if (source.kind === "folder") {
    const row = fileRow(ctx.revision, phase, mapping, source, "created", source.path);
    row.sourceFingerprint = sourceFingerprint;
    row.destinationDriveId = mapping.destDriveId;
    row.destinationFileId = destinationAtPath?.id ?? null;
    row.provenanceState = destinationBySource ? "marked" : "none";

    if (phase !== "execute") {
      return { row, findings: [] };
    }

    return {
      row,
      findings: [],
      apply: async () => {
        if (destinationBySource) {
          return destinationBySource;
        }

        const created = await retryable(ctx, () =>
          provider.createDestinationFolder({
            parentFolderId: destinationParent.id,
            name: source.name,
            createdAt: source.createdAt,
            modifiedAt: source.modifiedAt,
          }),
        );
        await provider.writeDestinationMarker({
          objectId: created.id,
          marker: buildProvenance(mapping, source, null, ctx.now().toISOString()),
        });
        return created;
      },
    };
  }

  const row = fileRow(ctx.revision, phase, mapping, source, "created", source.path);
  row.sourceFingerprint = sourceFingerprint;
  row.destinationDriveId = mapping.destDriveId;
  row.provenanceState = "none";

  if (phase !== "execute") {
    return { row, findings: [] };
  }

  return {
    row,
    findings: [],
    apply: async () => {
      const created = await retryable(ctx, () =>
        provider.uploadDestinationContent({
          parentFolderId: destinationParent.id,
          name: source.name,
          content: sourceBytes ?? new Uint8Array(),
          createdAt: source.createdAt,
          modifiedAt: source.modifiedAt,
          mimeType: source.mimeType,
        }),
      );
      await provider.writeDestinationMarker({
        objectId: created.id,
        marker: buildProvenance(mapping, source, sourceFingerprint, ctx.now().toISOString()),
      });
      return created;
    },
  };
}

async function evaluateRetainedDestination(
  ctx: DriverContext<FileMigrationConfig>,
  phase: Phase,
  mapping: FileMappingConfig,
  snapshot: MappingSnapshot,
  destination: DestinationView,
): Promise<PreparedItem> {
  const sourceId = destination.provenance?.sourceItemId ?? destination.id;
  const sourceDriveId = destination.provenance?.sourceDriveId ?? mapping.sourceDriveId;
  const rowCode: ActionCode =
    destination.provenance && !snapshot.sourceById[destination.provenance.sourceItemId]
      ? "source_deleted_destination_retained"
      : "destination_only_retained";
  const row = retainedRow(
    ctx.revision,
    phase,
    mapping,
    destination,
    sourceId,
    sourceDriveId,
    rowCode,
  );

  if (rowCode === "destination_only_retained") {
    return {
      row,
      findings: [
        buildBlockerFinding(
          ctx,
          phase,
          "destination_only_retained",
          {
            ...snapshot.sourceRoot,
            id: sourceId,
            driveId: sourceDriveId,
            kind: destination.kind === "folder" ? "folder" : "file",
            parentId: null,
            name: destination.name,
            size: destination.size,
            etag: destination.etag,
            createdAt: destination.createdAt,
            modifiedAt: destination.modifiedAt,
            mimeType: destination.mimeType,
            identity: sourceId,
            downloadable: true,
            path: destination.path,
            parentPath: destination.parentPath,
            representable: true,
          },
          { path: destination.path },
        ),
      ],
    };
  }

  return { row, findings: [] };
}

function totalUnits(snapshot: MappingSnapshot): number {
  let total = 0;
  for (const source of snapshot.sourceOrder) {
    if (source.id !== snapshot.sourceRoot.id) {
      total += 1;
    }
  }

  for (const destination of snapshot.destinationOrder) {
    if (destination.id === snapshot.destinationRoot.id) {
      continue;
    }

    const sourceAtPath = snapshot.sourceByPath[destination.path] ?? [];
    const provenanceSource = destination.provenance
      ? snapshot.sourceById[destination.provenance.sourceItemId]
      : undefined;
    if (sourceAtPath.length === 0 && provenanceSource === undefined) {
      total += 1;
    }
  }

  return total;
}

async function* runPhase(
  ctx: DriverContext<FileMigrationConfig>,
  phase: Phase,
): AsyncIterable<CommitUnit> {
  const provider = ctx.provider;
  let done = 0;

  for (const mapping of ctx.config.mappings) {
    const snapshot = await buildSnapshot(ctx, provider, mapping);
    const mappingIssues = mappingFindings(ctx, mapping, snapshot);
    const total = totalUnits(snapshot);

    for (const issue of mappingIssues) {
      done += 1;
      yield {
        rev: ctx.revision,
        phase,
        unitKey: `${mapping.id}:${issue.subjectId}:${phase}`,
        checkpoint: issue.subjectId,
        rows: [],
        findings: [issue],
        watermark: { unitKey: `${mapping.id}:${issue.subjectId}:${phase}`, value: issue.subjectId },
        progress: { unit: "items", done, total },
      };
    }

    for (const source of snapshot.sourceOrder) {
      if (source.id === snapshot.sourceRoot.id) {
        done += 1;
        const row = rootRow(
          ctx.revision,
          phase,
          mapping,
          source,
          snapshot.destinationRoot,
          "unchanged",
          null,
        );
        yield {
          rev: ctx.revision,
          phase,
          unitKey: `${mapping.id}:${source.id}:${phase}`,
          checkpoint: source.path,
          rows: [row],
          findings: [],
          watermark: { unitKey: `${mapping.id}:${source.id}:${phase}`, value: source.path },
          progress: { unit: "items", done, total },
        };
        continue;
      }

      const prepared = await evaluateSourceItem(ctx, phase, provider, mapping, snapshot, source);
      if (phase === "execute" && prepared.apply) {
        const result = await prepared.apply();
        if (result) {
          prepared.row.destinationFileId = result.id;
          prepared.row.destinationDriveId = result.driveId;
          prepared.row.destinationFingerprint = result.reportedChecksum ?? result.etag ?? null;
          prepared.row.provenanceState = "marked";
        }
      }

      done += 1;
      yield {
        rev: ctx.revision,
        phase,
        unitKey: `${mapping.id}:${source.id}:${phase}`,
        checkpoint: source.path,
        rows: [prepared.row],
        findings: prepared.findings,
        watermark: { unitKey: `${mapping.id}:${source.id}:${phase}`, value: source.path },
        progress: { unit: "items", done, total },
      };
    }

    for (const destination of snapshot.destinationOrder) {
      if (destination.id === snapshot.destinationRoot.id) {
        continue;
      }

      const sourceAtPath = snapshot.sourceByPath[destination.path] ?? [];
      const provenanceSource = destination.provenance
        ? snapshot.sourceById[destination.provenance.sourceItemId]
        : undefined;
      if (sourceAtPath.length > 0 || provenanceSource !== undefined) {
        continue;
      }

      const prepared = await evaluateRetainedDestination(
        ctx,
        phase,
        mapping,
        snapshot,
        destination,
      );
      done += 1;
      yield {
        rev: ctx.revision,
        phase,
        unitKey: `${mapping.id}:${prepared.row.sourceItemId}:${phase}`,
        checkpoint: destination.path,
        rows: [prepared.row],
        findings: prepared.findings,
        watermark: {
          unitKey: `${mapping.id}:${prepared.row.sourceItemId}:${phase}`,
          value: destination.path,
        },
        progress: { unit: "items", done, total },
      };
    }
  }
}

async function* preflight(ctx: DriverContext<FileMigrationConfig>): AsyncIterable<CheckResult> {
  for (const mapping of ctx.config.mappings) {
    const source = await retryable(ctx, () =>
      ctx.provider.resolveSourceRoot({
        sourceDriveId: mapping.sourceDriveId,
        sourceItemId: mapping.sourceItemId,
      }),
    );
    const destination = await retryable(ctx, () =>
      ctx.provider.resolveDestinationFolder({
        destDriveId: mapping.destDriveId,
        destFolderId: mapping.destFolderId,
      }),
    );

    if (source !== null && destination !== null) {
      yield {
        id: mapping.id,
        title: `mapping ${mapping.id}`,
        status: "pass",
        evidence: {
          sourcePresent: true,
          destinationPresent: true,
          sourceItemId: mapping.sourceItemId,
          destFolderId: mapping.destFolderId,
        },
      };
      continue;
    }

    yield {
      id: mapping.id,
      title: `mapping ${mapping.id}`,
      status: "fail",
      code: "unqualified_route",
      evidence: {
        sourcePresent: source !== null,
        destinationPresent: destination !== null,
        sourceItemId: mapping.sourceItemId,
        destFolderId: mapping.destFolderId,
      },
    };
  }
}

async function* reportSections(
  ctx: DriverContext<FileMigrationConfig>,
): AsyncIterable<ReportSection> {
  for (const mapping of ctx.config.mappings) {
    yield {
      title: `Mapping ${mapping.id}`,
      format: "markdown",
      body: [
        `- source root: ${mapping.sourceItemId}`,
        `- destination folder: ${mapping.destFolderId}`,
        `- revision: ${ctx.revision}`,
      ].join("\n"),
    };
  }
}

export const fileMigrationDriver: JobTypeDriver<FileMigrationConfig> = {
  preflight,
  collect(ctx) {
    return runPhase(ctx, "plan");
  },
  execute(ctx) {
    return runPhase(ctx, "execute");
  },
  verify(ctx) {
    return runPhase(ctx, "verify");
  },
  reportSections,
};

export function createFileMigrationDriver(): JobTypeDriver<FileMigrationConfig> {
  return fileMigrationDriver;
}
