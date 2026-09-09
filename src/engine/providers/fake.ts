import { createHash } from "node:crypto";
import type { CheckResult } from "../types.ts";
import type {
  ArchiveAssetRequest,
  ArchiveConversation,
  ArchivePage,
  ArchiveProvider,
  ArchiveRoute,
  ArchiveScopeBinding,
} from "./archive.ts";
import type {
  DestinationEntry,
  DestinationItemKind,
  ProviderPort,
  ProvenanceRecord,
  RetryAfterError,
  SourceEntry,
  SourceItemKind,
  TransferWorkerHandle,
  TransferWorkerProbe,
} from "./port.ts";

export interface FakeSourceItemFixture {
  id: string;
  parentId: string | null;
  name: string;
  kind: SourceItemKind;
  size?: number | null;
  etag?: string | null;
  createdAt?: string;
  modifiedAt?: string;
  mimeType?: string | null;
  identity?: string;
  downloadable?: boolean;
  metadata?: Record<string, unknown>;
  content?: Uint8Array | string;
}

export interface FakeDestinationItemFixture {
  id: string;
  parentId: string | null;
  name: string;
  kind: DestinationItemKind;
  size?: number | null;
  etag?: string | null;
  createdAt?: string;
  modifiedAt?: string;
  mimeType?: string | null;
  identity?: string;
  content?: Uint8Array | string;
  reportedChecksum?: string | null;
  provenance?: ProvenanceRecord | null;
}

export interface FakeRetryRule {
  method: string;
  objectId?: string;
  count: number;
  retryAfterMs: number;
}

export interface FakeSourceMutationRule {
  sourceItemId: string;
  nextContent: Uint8Array | string;
  nextIdentity?: string;
  nextModifiedAt?: string;
  nextEtag?: string | null;
  nextName?: string;
  nextParentId?: string | null;
  when?: "source-stream" | "destination-upload";
  triggered?: boolean;
}

/** Errors are thrown at the effect seam; `after` means the mutation already happened. */
export interface FakeEffectRule {
  method: string;
  objectId?: string;
  count: number;
  error: Error;
  timing?: "before" | "after";
  /** Streaming errors may occur after this many chunks, including zero. */
  afterChunks?: number;
}

export interface FakeArchivePageFixture {
  scopeId: string;
  route: ArchiveRoute;
  cursor: string | null;
  page: ArchivePage;
}

export interface FakeArchiveAssetFixture {
  conversationId: string;
  recordId: string;
  route: ArchiveRoute;
  kind: ArchiveAssetRequest["kind"];
  id: string;
  name: string;
  sourceUrl?: string;
  content: Uint8Array | string;
  chunkSize?: number;
}

export interface FakeArchiveFixture {
  scopes: ArchiveScopeBinding[];
  conversations: ArchiveConversation[];
  pages: FakeArchivePageFixture[];
  checks?: CheckResult[];
  assets?: FakeArchiveAssetFixture[];
  transcriptConversationIds?: Record<string, string | null>;
  effects?: FakeEffectRule[];
}

export interface FakeFileMigrationFixture {
  sourceDriveId: string;
  sourceRootId: string;
  destinationDriveId: string;
  destinationRootId: string;
  sourceItems: FakeSourceItemFixture[];
  destinationItems: FakeDestinationItemFixture[];
  worker?: {
    pid?: number;
    version?: string;
    alive?: boolean;
  };
  retryAfter?: FakeRetryRule[];
  sourceMutations?: FakeSourceMutationRule[];
  runDirectory?: string;
  reservedDestinationIds?: string[];
  effects?: FakeEffectRule[];
  applicationIdentity?: string;
  checks?: CheckResult[];
  archive?: FakeArchiveFixture;
}

interface MutableSourceEntry extends SourceEntry {
  content: Uint8Array | null;
}

interface MutableDestinationEntry extends DestinationEntry {
  content: Uint8Array | null;
}

function encodeText(value: Uint8Array | string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value.slice();
  }

  return new TextEncoder().encode(value);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readAll(content: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (content instanceof Uint8Array) {
    return content.slice();
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of content) {
    chunks.push(chunk.slice());
  }

  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function cloneSource(entry: MutableSourceEntry): SourceEntry {
  return {
    id: entry.id,
    driveId: entry.driveId,
    parentId: entry.parentId,
    name: entry.name,
    kind: entry.kind,
    size: entry.size,
    etag: entry.etag,
    createdAt: entry.createdAt,
    modifiedAt: entry.modifiedAt,
    mimeType: entry.mimeType,
    identity: entry.identity,
    downloadable: entry.downloadable,
    ...(entry.metadata ? { metadata: structuredClone(entry.metadata) } : {}),
  };
}

function cloneDestination(entry: MutableDestinationEntry): DestinationEntry {
  return {
    id: entry.id,
    driveId: entry.driveId,
    parentId: entry.parentId,
    name: entry.name,
    kind: entry.kind,
    size: entry.size,
    etag: entry.etag,
    createdAt: entry.createdAt,
    modifiedAt: entry.modifiedAt,
    mimeType: entry.mimeType,
    reportedChecksum: entry.reportedChecksum,
    provenance: entry.provenance ? { ...entry.provenance } : null,
  };
}

function takeEffect(
  rules: FakeEffectRule[],
  method: string,
  objectId: string | undefined,
  timing: "before" | "after" = "before",
  streaming = false,
): FakeEffectRule | undefined {
  const rule = rules.find(
    (candidate) =>
      candidate.method === method &&
      (candidate.objectId === undefined || candidate.objectId === objectId) &&
      (candidate.timing ?? "before") === timing &&
      (candidate.afterChunks !== undefined) === streaming &&
      candidate.count > 0,
  );
  if (rule) rule.count -= 1;
  return rule;
}

async function* scriptedStream(
  bytes: Uint8Array,
  rule?: FakeEffectRule,
  chunkSize = Math.max(1, Math.ceil(bytes.byteLength / 2)),
): AsyncIterable<Uint8Array> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new Error("Invalid fixture chunk size");
  let chunks = 0;
  if (rule?.afterChunks === 0) throw rule.error;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.slice(offset, Math.min(bytes.byteLength, offset + chunkSize));
    chunks += 1;
    if (rule?.afterChunks === chunks) throw rule.error;
  }
}

function lostResponse(): Error {
  return Object.assign(new Error("Scripted effect applied, response lost"), { name: "AbortError" });
}

function destinationFault(code: string, status: number): Error {
  return Object.assign(new Error(code), { code, status, transient: false });
}

export class FakeFileMigrationPort implements ProviderPort {
  readonly sourceDriveId: string;
  readonly sourceRootId: string;
  readonly destinationDriveId: string;
  readonly destinationRootId: string;
  readonly archive?: FakeArchivePort;

  private readonly sourceById: Record<string, MutableSourceEntry> = Object.create(null);
  private readonly sourceChildrenByParent: Record<string, string[]> = Object.create(null);
  private readonly destinationById: Record<string, MutableDestinationEntry> = Object.create(null);
  private readonly destinationChildrenByParent: Record<string, string[]> = Object.create(null);
  private readonly retryAfterRules: FakeRetryRule[];
  private readonly sourceMutationRules: FakeSourceMutationRule[];
  private readonly withheldChecksums = new Set<string>();
  private readonly effects: FakeEffectRule[];
  private readonly reservedDestinationIds: string[];
  private readonly reservedIds = new Set<string>();
  private readonly unavailableDestinationStreams = new Map<string, Error>();
  private readonly checks: CheckResult[];
  private applicationId: string;
  private readonly callLog: string[] = [];
  private workerState: { pid: number; version: string; alive: boolean; socketPath: string } | null;
  private readonly runDirectory: string;
  private idSeed = 0;
  private etagSeed = 0;

  constructor(fixture: FakeFileMigrationFixture) {
    this.sourceDriveId = fixture.sourceDriveId;
    this.sourceRootId = fixture.sourceRootId;
    this.destinationDriveId = fixture.destinationDriveId;
    this.destinationRootId = fixture.destinationRootId;
    this.retryAfterRules = fixture.retryAfter
      ? fixture.retryAfter.map((rule) => ({ ...rule }))
      : [];
    this.sourceMutationRules = fixture.sourceMutations
      ? fixture.sourceMutations.map((rule) => ({ ...rule }))
      : [];
    this.runDirectory = fixture.runDirectory ?? "/tmp/migmate-fake-run";
    this.effects = fixture.effects?.map((rule) => ({ ...rule })) ?? [];
    this.reservedDestinationIds = [...(fixture.reservedDestinationIds ?? [])];
    this.applicationId = fixture.applicationIdentity ?? "scripted-application";
    this.checks = structuredClone(fixture.checks ?? []);
    if (fixture.archive) this.archive = new FakeArchivePort(fixture.archive);

    for (const source of fixture.sourceItems) {
      this.insertSource(source);
    }

    for (const destination of fixture.destinationItems) {
      this.insertDestination(destination);
    }

    this.workerState = {
      pid: fixture.worker?.pid ?? 4242,
      version: fixture.worker?.version ?? "fake-worker-1.0.0",
      alive: fixture.worker?.alive ?? true,
      socketPath: `${this.runDirectory}/transfer.sock`,
    };
  }

  get calls(): readonly string[] {
    return this.callLog;
  }

  withholdDestinationChecksum(objectId: string): void {
    this.withheldChecksums.add(objectId);
    const entry = this.destinationById[objectId];
    if (entry) {
      entry.reportedChecksum = null;
    }
  }

  allowDestinationChecksum(objectId: string): void {
    this.withheldChecksums.delete(objectId);
    const entry = this.destinationById[objectId];
    if (entry && entry.content) {
      entry.reportedChecksum = hashBytes(entry.content);
    }
  }

  blockDestinationStream(
    objectId: string,
    error: Error = destinationFault("destination_stream_unavailable", 403),
  ): void {
    this.unavailableDestinationStreams.set(objectId, error);
  }

  unblockDestinationStream(objectId: string): void {
    this.unavailableDestinationStreams.delete(objectId);
  }

  interruptAfterMarkerOnce(objectId: string): void {
    this.scriptEffect({
      method: "writeDestinationMarker",
      objectId,
      timing: "after",
      count: 1,
      error: lostResponse(),
    });
  }

  interruptAfterUploadOnce(objectId: string): void {
    this.loseResponseOnce("uploadDestinationContent", objectId);
  }

  scriptEffect(rule: FakeEffectRule): void {
    this.effects.push({ ...rule });
  }

  loseResponseOnce(
    method: "createDestinationFolder" | "uploadDestinationContent" | "moveDestinationObject",
    objectId?: string,
    error: Error = lostResponse(),
  ): void {
    this.effects.push({
      method,
      ...(objectId === undefined ? {} : { objectId }),
      timing: "after",
      count: 1,
      error,
    });
  }

  setApplicationIdentity(identity: string): void {
    this.applicationId = identity;
  }

  async applicationIdentity(): Promise<string> {
    this.throwRetryAfter("applicationIdentity");
    return this.applicationId;
  }

  async *preflight(
    _input: Parameters<NonNullable<ProviderPort["preflight"]>>[0],
  ): AsyncIterable<CheckResult> {
    this.throwRetryAfter("preflight");
    yield* structuredClone(this.checks);
  }

  async reserveDestinationId(): Promise<string> {
    this.callLog.push("reserveDestinationId");
    this.throwRetryAfter("reserveDestinationId");
    const id = this.reservedDestinationIds.shift() ?? this.nextDestinationId("file");
    if (this.destinationById[id] || this.reservedIds.has(id)) {
      throw destinationFault("destination_id_conflict", 409);
    }
    this.reservedIds.add(id);
    return id;
  }

  async readSourceItem(input: { driveId: string; itemId: string }): Promise<SourceEntry | null> {
    this.callLog.push(`readSourceItem:${input.itemId}`);
    this.throwRetryAfter("readSourceItem", input.itemId);
    const entry = this.sourceById[input.itemId];
    return entry?.driveId === input.driveId ? cloneSource(entry) : null;
  }

  async readDestinationObject(input: {
    driveId: string;
    objectId: string;
  }): Promise<DestinationEntry | null> {
    this.callLog.push(`readDestinationObject:${input.objectId}`);
    this.throwRetryAfter("readDestinationObject", input.objectId);
    const entry = this.destinationById[input.objectId];
    return entry?.driveId === input.driveId ? cloneDestination(entry) : null;
  }

  mutateSourceItem(
    sourceItemId: string,
    patch: Partial<{
      content: Uint8Array | string;
      name: string;
      parentId: string | null;
      metadata: Record<string, unknown>;
      identity: string;
      modifiedAt: string;
      etag: string | null;
      size: number | null;
    }>,
  ): void {
    const entry = this.sourceById[sourceItemId];
    if (!entry) {
      return;
    }

    if (patch.content !== undefined) {
      entry.content = encodeText(patch.content);
      entry.size = entry.content.byteLength;
    }
    if (patch.name !== undefined) entry.name = patch.name;
    if (patch.metadata !== undefined) entry.metadata = structuredClone(patch.metadata);
    if (patch.parentId !== undefined && patch.parentId !== entry.parentId) {
      const oldKey = entry.parentId ?? "";
      this.sourceChildrenByParent[oldKey] = (this.sourceChildrenByParent[oldKey] ?? []).filter(
        (id) => id !== entry.id,
      );
      entry.parentId = patch.parentId;
      const nextKey = entry.parentId ?? "";
      this.sourceChildrenByParent[nextKey] = [
        ...(this.sourceChildrenByParent[nextKey] ?? []),
        entry.id,
      ];
    }

    if (patch.identity !== undefined) {
      entry.identity = patch.identity;
    }

    if (patch.modifiedAt !== undefined) {
      entry.modifiedAt = patch.modifiedAt;
    }

    if (patch.etag !== undefined) {
      entry.etag = patch.etag;
    } else if (patch.content !== undefined) {
      entry.etag = `source-${++this.etagSeed}`;
    }

    if (patch.size !== undefined) {
      entry.size = patch.size;
    }
  }

  deleteSourceItem(sourceItemId: string): void {
    this.deleteSourceRecursive(sourceItemId);
  }

  renameSourceItem(sourceItemId: string, name: string): void {
    const entry = this.sourceById[sourceItemId];
    if (!entry) {
      return;
    }

    entry.name = name;
  }

  overrideSourceChildren(parentId: string, childIds: string[]): void {
    this.sourceChildrenByParent[parentId] = [...childIds];
  }

  snapshotSource(): Array<{
    id: string;
    parentId: string | null;
    name: string;
    kind: SourceItemKind;
    path: string;
    identity: string;
  }> {
    const root = this.sourceById[this.sourceRootId];
    if (!root) {
      return [];
    }

    const rows: Array<{
      id: string;
      parentId: string | null;
      name: string;
      kind: SourceItemKind;
      path: string;
      identity: string;
    }> = [];
    const visit = (id: string, path: string): void => {
      const entry = this.sourceById[id];
      if (!entry) {
        return;
      }

      rows.push({
        id: entry.id,
        parentId: entry.parentId,
        name: entry.name,
        kind: entry.kind,
        path,
        identity: entry.identity,
      });
      for (const childId of this.sourceChildrenByParent[id] ?? []) {
        const child = this.sourceById[childId];
        if (!child) {
          continue;
        }

        const childPath = path === "." ? child.name : `${path}/${child.name}`;
        visit(childId, childPath);
      }
    };

    visit(root.id, ".");
    return rows;
  }

  snapshotDestination(): Array<{
    id: string;
    parentId: string | null;
    name: string;
    kind: DestinationItemKind;
    path: string;
    mimeType: string | null;
    checksum: string | null;
    reportedChecksum: string | null;
    provenance: ProvenanceRecord | null;
  }> {
    const root = this.destinationById[this.destinationRootId];
    if (!root) {
      return [];
    }

    const rows: Array<{
      id: string;
      parentId: string | null;
      name: string;
      kind: DestinationItemKind;
      path: string;
      mimeType: string | null;
      checksum: string | null;
      reportedChecksum: string | null;
      provenance: ProvenanceRecord | null;
    }> = [];
    const visit = (id: string, path: string): void => {
      const entry = this.destinationById[id];
      if (!entry) {
        return;
      }

      rows.push({
        id: entry.id,
        parentId: entry.parentId,
        name: entry.name,
        kind: entry.kind,
        path,
        mimeType: entry.mimeType,
        checksum: entry.content ? hashBytes(entry.content) : null,
        reportedChecksum: entry.reportedChecksum,
        provenance: entry.provenance ? { ...entry.provenance } : null,
      });

      for (const childId of this.destinationChildrenByParent[id] ?? []) {
        const child = this.destinationById[childId];
        if (!child) {
          continue;
        }

        const childPath = path === "." ? child.name : `${path}/${child.name}`;
        visit(childId, childPath);
      }
    };

    visit(root.id, ".");
    return rows;
  }

  async resolveSourceRoot(input: {
    sourceDriveId: string;
    sourceItemId: string;
  }): Promise<SourceEntry | null> {
    this.callLog.push(`resolveSourceRoot:${input.sourceItemId}`);
    this.throwRetryAfter("resolveSourceRoot", input.sourceItemId);
    const entry = this.sourceById[input.sourceItemId];
    if (!entry || entry.driveId !== input.sourceDriveId) {
      return null;
    }

    return cloneSource(entry);
  }

  async listSourceChildren(sourceItemId: string): Promise<SourceEntry[]> {
    this.callLog.push(`listSourceChildren:${sourceItemId}`);
    this.throwRetryAfter("listSourceChildren", sourceItemId);
    const childIds = this.sourceChildrenByParent[sourceItemId] ?? [];
    const children: SourceEntry[] = [];
    for (const childId of childIds) {
      const child = this.sourceById[childId];
      if (child) {
        children.push(cloneSource(child));
      }
    }

    return children;
  }

  openSourceContent(sourceItemId: string): AsyncIterable<Uint8Array> {
    this.callLog.push(`openSourceContent:${sourceItemId}`);
    this.throwRetryAfter("openSourceContent", sourceItemId);
    const entry = this.sourceById[sourceItemId];
    if (!entry || entry.content === null || !entry.downloadable) {
      throw destinationFault("source_read_failed", entry ? 403 : 404);
    }
    const bytes = entry.content;
    const fault = takeEffect(this.effects, "openSourceContent", sourceItemId, "before", true);
    const self = this;
    return (async function* () {
      let mutated = false;
      for await (const chunk of scriptedStream(bytes, fault)) {
        yield chunk;
        if (!mutated) {
          self.applySourceMutation(sourceItemId, "source-stream");
          mutated = true;
        }
      }
      if (!mutated) self.applySourceMutation(sourceItemId, "source-stream");
    })();
  }

  async resolveDestinationFolder(input: {
    destDriveId: string;
    destFolderId: string;
  }): Promise<DestinationEntry | null> {
    this.callLog.push(`resolveDestinationFolder:${input.destFolderId}`);
    this.throwRetryAfter("resolveDestinationFolder", input.destFolderId);
    const entry = this.destinationById[input.destFolderId];
    if (!entry || entry.driveId !== input.destDriveId) {
      return null;
    }

    return cloneDestination(entry);
  }

  async listDestinationChildren(destFolderId: string): Promise<DestinationEntry[]> {
    this.callLog.push(`listDestinationChildren:${destFolderId}`);
    this.throwRetryAfter("listDestinationChildren", destFolderId);
    const childIds = this.destinationChildrenByParent[destFolderId] ?? [];
    const children: DestinationEntry[] = [];
    for (const childId of childIds) {
      const child = this.destinationById[childId];
      if (child) {
        children.push(cloneDestination(child));
      }
    }

    return children;
  }

  async createDestinationFolder(
    input: Parameters<ProviderPort["createDestinationFolder"]>[0],
  ): Promise<DestinationEntry> {
    this.callLog.push(`createDestinationFolder:${input.parentFolderId}/${input.name}`);
    this.throwRetryAfter("createDestinationFolder", input.parentFolderId);
    const id = input.destinationId ?? this.nextDestinationId("folder");
    if (input.destinationId) this.throwEffect("createDestinationFolder", id);
    if (this.destinationById[id]) throw destinationFault("destination_id_conflict", 409);
    const parent = this.destinationParent(input.parentFolderId);
    const entry: MutableDestinationEntry = {
      id,
      driveId: parent.driveId,
      parentId: parent.id,
      name: input.name,
      kind: "folder",
      size: null,
      etag: this.nextEtag(),
      createdAt: input.createdAt,
      modifiedAt: input.modifiedAt,
      mimeType: null,
      reportedChecksum: null,
      provenance: input.marker ? { ...input.marker } : null,
      content: null,
    };
    this.insertDestinationEntry(entry);
    this.reservedIds.delete(id);
    this.afterMutation("createDestinationFolder", id, input.marker);
    return cloneDestination(entry);
  }

  async uploadDestinationContent(
    input: Parameters<ProviderPort["uploadDestinationContent"]>[0],
  ): Promise<DestinationEntry> {
    const targetId = input.destinationId ?? this.nextDestinationId("file");
    this.callLog.push(`uploadDestinationContent:${targetId}`);
    this.throwRetryAfter("uploadDestinationContent", targetId);
    const parent = this.destinationParent(input.parentFolderId);
    const before = this.destinationById[targetId];
    if (input.create === true && before) throw destinationFault("destination_id_conflict", 409);
    if (input.create === false && !before) throw destinationFault("destination_write_failed", 404);
    if (before?.kind !== undefined && before.kind !== "file") {
      throw destinationFault("destination_type_conflict", 409);
    }
    this.checkEtag(before, input.expectedEtag);
    const bytes = await readAll(input.content);
    const existing = this.destinationById[targetId];
    // The condition is evaluated again at commit, after the content stream ran.
    this.checkEtag(existing, input.expectedEtag);
    if (input.create === true && existing) throw destinationFault("destination_id_conflict", 409);
    const entry: MutableDestinationEntry = {
      id: targetId,
      driveId: parent.driveId,
      parentId: parent.id,
      name: input.name,
      kind: "file",
      size: bytes.byteLength,
      etag: this.nextEtag(),
      createdAt: existing?.createdAt ?? input.createdAt,
      modifiedAt: input.modifiedAt,
      mimeType: input.mimeType,
      reportedChecksum: this.withheldChecksums.has(targetId) ? null : hashBytes(bytes),
      provenance: input.marker
        ? { ...input.marker }
        : existing?.provenance
          ? { ...existing.provenance }
          : null,
      content: bytes,
    };
    if (existing) {
      this.destinationById[targetId] = entry;
      this.relinkDestination(entry, existing.parentId, input.parentFolderId);
    } else {
      this.insertDestinationEntry(entry);
    }
    this.reservedIds.delete(targetId);
    if (input.marker) this.applySourceMutation(input.marker.sourceItemId, "destination-upload");
    this.afterMutation("uploadDestinationContent", targetId, input.marker);
    return cloneDestination(entry);
  }

  async moveDestinationObject(
    input: Parameters<ProviderPort["moveDestinationObject"]>[0],
  ): Promise<DestinationEntry> {
    this.callLog.push(`moveDestinationObject:${input.objectId}`);
    this.throwRetryAfter("moveDestinationObject", input.objectId);
    const entry = this.destinationById[input.objectId];
    if (!entry) throw destinationFault("destination_write_failed", 404);
    const parent = this.destinationParent(input.parentFolderId);
    this.checkEtag(entry, input.expectedEtag);
    this.relinkDestination(entry, entry.parentId, parent.id);
    entry.parentId = parent.id;
    entry.driveId = parent.driveId;
    entry.name = input.name;
    if (input.modifiedAt !== undefined) entry.modifiedAt = input.modifiedAt;
    if (input.marker) entry.provenance = { ...input.marker };
    entry.etag = this.nextEtag();
    this.afterMutation("moveDestinationObject", entry.id, input.marker);
    return cloneDestination(entry);
  }
  async readDestinationMarker(objectId: string): Promise<ProvenanceRecord | null> {
    this.callLog.push(`readDestinationMarker:${objectId}`);
    this.throwRetryAfter("readDestinationMarker", objectId);
    const entry = this.destinationById[objectId];
    return entry?.provenance ? { ...entry.provenance } : null;
  }

  async writeDestinationMarker(
    input: Parameters<ProviderPort["writeDestinationMarker"]>[0],
  ): Promise<void> {
    this.callLog.push(`writeDestinationMarker:${input.objectId}`);
    this.throwRetryAfter("writeDestinationMarker", input.objectId);
    const entry = this.destinationById[input.objectId];
    if (!entry) throw destinationFault("destination_write_failed", 404);
    this.checkEtag(entry, input.expectedEtag);
    entry.provenance = input.marker ? { ...input.marker } : null;
    entry.etag = this.nextEtag();
    this.throwEffect("writeDestinationMarker", input.objectId, "after");
  }

  streamDestinationContent(objectId: string): AsyncIterable<Uint8Array> {
    this.callLog.push(`streamDestinationContent:${objectId}`);
    this.throwRetryAfter("streamDestinationContent", objectId);
    const entry = this.destinationById[objectId];
    if (!entry) throw destinationFault("destination_stream_unavailable", 404);
    const blocked = this.unavailableDestinationStreams.get(objectId);
    if (blocked) throw blocked;
    if (entry.content === null) throw destinationFault("destination_stream_unavailable", 403);
    return scriptedStream(
      entry.content,
      takeEffect(this.effects, "streamDestinationContent", objectId, "before", true),
    );
  }

  async startTransferWorker(
    input: Parameters<ProviderPort["startTransferWorker"]>[0],
  ): Promise<TransferWorkerHandle> {
    this.callLog.push(`startTransferWorker:${input.runDirectory}`);
    this.throwRetryAfter("startTransferWorker", input.runDirectory);
    this.workerState = {
      pid: this.workerState?.pid ?? 4242,
      version: this.workerState?.version ?? "fake-worker-1.0.0",
      alive: true,
      socketPath: `${input.runDirectory}/transfer.sock`,
    };

    return {
      socketPath: this.workerState.socketPath,
      pid: this.workerState.pid,
      version: this.workerState.version,
    };
  }

  async probeTransferWorker(input: { socketPath: string }): Promise<TransferWorkerProbe> {
    this.callLog.push(`probeTransferWorker:${input.socketPath}`);
    this.throwRetryAfter("probeTransferWorker", input.socketPath);
    if (
      this.workerState &&
      this.workerState.socketPath === input.socketPath &&
      this.workerState.alive
    ) {
      return { alive: true, version: this.workerState.version };
    }

    return { alive: false, version: null };
  }

  async stopTransferWorker(input: { socketPath: string }): Promise<void> {
    this.callLog.push(`stopTransferWorker:${input.socketPath}`);
    this.throwRetryAfter("stopTransferWorker", input.socketPath);
    if (this.workerState && this.workerState.socketPath === input.socketPath) {
      this.workerState.alive = false;
    }
  }

  async terminateTransferWorker(input: { socketPath: string }): Promise<void> {
    this.callLog.push(`terminateTransferWorker:${input.socketPath}`);
    this.throwRetryAfter("terminateTransferWorker", input.socketPath);
    if (this.workerState && this.workerState.socketPath === input.socketPath) {
      this.workerState.alive = false;
    }
  }

  async transferWorkerVersion(input: { socketPath: string }): Promise<string | null> {
    this.callLog.push(`transferWorkerVersion:${input.socketPath}`);
    this.throwRetryAfter("transferWorkerVersion", input.socketPath);
    if (
      this.workerState &&
      this.workerState.socketPath === input.socketPath &&
      this.workerState.alive
    ) {
      return this.workerState.version;
    }

    return null;
  }

  private insertSource(fixture: FakeSourceItemFixture): void {
    const bytes = fixture.content === undefined ? null : encodeText(fixture.content);
    const entry: MutableSourceEntry = {
      id: fixture.id,
      driveId: this.sourceDriveId,
      parentId: fixture.parentId,
      name: fixture.name,
      kind: fixture.kind,
      size: fixture.size !== undefined ? fixture.size : (bytes?.byteLength ?? null),
      etag: fixture.etag !== undefined ? fixture.etag : bytes ? hashBytes(bytes) : null,
      createdAt: fixture.createdAt ?? new Date(0).toISOString(),
      modifiedAt: fixture.modifiedAt ?? new Date(0).toISOString(),
      mimeType: fixture.mimeType ?? null,
      identity: fixture.identity ?? fixture.id,
      downloadable: fixture.downloadable ?? fixture.kind !== "undownloadable",
      content: bytes,
      ...(fixture.metadata ? { metadata: structuredClone(fixture.metadata) } : {}),
    };
    this.sourceById[entry.id] = entry;
    const parentKey = entry.parentId ?? "";
    const children = this.sourceChildrenByParent[parentKey] ?? [];
    children.push(entry.id);
    this.sourceChildrenByParent[parentKey] = children;
  }

  private insertDestination(fixture: FakeDestinationItemFixture): void {
    const bytes = fixture.content !== undefined ? encodeText(fixture.content) : null;
    const checksum = bytes ? hashBytes(bytes) : null;
    const entry: MutableDestinationEntry = {
      id: fixture.id,
      driveId: this.destinationDriveId,
      parentId: fixture.parentId,
      name: fixture.name,
      kind: fixture.kind,
      size: fixture.size ?? bytes?.byteLength ?? null,
      etag: fixture.etag !== undefined ? fixture.etag : this.nextEtag(),
      createdAt: fixture.createdAt ?? new Date(0).toISOString(),
      modifiedAt: fixture.modifiedAt ?? new Date(0).toISOString(),
      mimeType: fixture.mimeType ?? null,
      reportedChecksum:
        fixture.reportedChecksum !== undefined ? fixture.reportedChecksum : checksum,
      provenance: fixture.provenance ? { ...fixture.provenance } : null,
      content: bytes,
    };
    this.insertDestinationEntry(entry);
  }

  private insertDestinationEntry(entry: MutableDestinationEntry): void {
    this.destinationById[entry.id] = entry;
    const parentKey = entry.parentId ?? "";
    const children = this.destinationChildrenByParent[parentKey] ?? [];
    if (!children.includes(entry.id)) children.push(entry.id);
    this.destinationChildrenByParent[parentKey] = children;
  }

  private relinkDestination(
    entry: MutableDestinationEntry,
    oldParentId: string | null,
    nextParentId: string,
  ): void {
    const oldKey = oldParentId ?? "";
    this.destinationChildrenByParent[oldKey] = (
      this.destinationChildrenByParent[oldKey] ?? []
    ).filter((id) => id !== entry.id);

    const newKey = nextParentId ?? "";
    const newChildren = (this.destinationChildrenByParent[newKey] ?? []).filter(
      (id) => id !== entry.id,
    );
    newChildren.push(entry.id);
    this.destinationChildrenByParent[newKey] = newChildren;
  }

  private deleteSourceRecursive(sourceItemId: string): void {
    const entry = this.sourceById[sourceItemId];
    if (!entry) {
      return;
    }

    for (const childId of this.sourceChildrenByParent[sourceItemId] ?? []) {
      this.deleteSourceRecursive(childId);
    }

    delete this.sourceById[sourceItemId];
    this.sourceChildrenByParent[sourceItemId] = [];
    const parentKey = entry.parentId ?? "";
    this.sourceChildrenByParent[parentKey] = (this.sourceChildrenByParent[parentKey] ?? []).filter(
      (id) => id !== sourceItemId,
    );
  }

  private nextDestinationId(prefix: string): string {
    let id: string;
    do {
      id = `${prefix}-${++this.idSeed}`;
    } while (
      this.destinationById[id] ||
      this.reservedIds.has(id) ||
      this.reservedDestinationIds.includes(id)
    );
    return id;
  }

  private nextEtag(): string {
    return `"fake-${++this.etagSeed}"`;
  }

  private destinationParent(id: string): MutableDestinationEntry {
    const entry = this.destinationById[id];
    if (!entry || entry.kind !== "folder") throw destinationFault("destination_write_failed", 404);
    return entry;
  }

  private checkEtag(
    entry: MutableDestinationEntry | undefined,
    expected: string | undefined,
  ): void {
    if (expected !== undefined && (!expected || entry?.etag !== expected)) {
      throw destinationFault("prior_copy_drift", 412);
    }
  }

  private throwEffect(
    method: string,
    objectId?: string,
    timing: "before" | "after" = "before",
  ): void {
    const rule = takeEffect(this.effects, method, objectId, timing);
    if (rule) throw rule.error;
  }

  private afterMutation(method: string, id: string, marker: ProvenanceRecord | undefined): void {
    this.throwEffect(method, id, "after");
    // Legacy interruption control also covers markers committed atomically with content/metadata.
    if (marker) this.throwEffect("writeDestinationMarker", id, "after");
  }

  private applySourceMutation(
    sourceItemId: string,
    when: "source-stream" | "destination-upload",
  ): void {
    const rule = this.sourceMutationRules.find(
      (candidate) =>
        candidate.sourceItemId === sourceItemId &&
        !candidate.triggered &&
        (candidate.when ?? "source-stream") === when,
    );
    if (!rule) return;
    this.mutateSourceItem(sourceItemId, {
      content: rule.nextContent,
      ...(rule.nextIdentity === undefined ? {} : { identity: rule.nextIdentity }),
      ...(rule.nextModifiedAt === undefined ? {} : { modifiedAt: rule.nextModifiedAt }),
      ...(rule.nextEtag === undefined ? {} : { etag: rule.nextEtag }),
      ...(rule.nextName === undefined ? {} : { name: rule.nextName }),
      ...(rule.nextParentId === undefined ? {} : { parentId: rule.nextParentId }),
    });
    rule.triggered = true;
  }

  private throwRetryAfter(method: string, objectId?: string): void {
    this.throwEffect(method, objectId);
    const rule = this.retryAfterRules.find(
      (candidate) =>
        candidate.method === method &&
        (candidate.objectId === undefined || candidate.objectId === objectId) &&
        candidate.count > 0,
    );
    if (!rule) {
      return;
    }

    rule.count -= 1;
    const error: RetryAfterError = Object.assign(new Error(`retry after ${rule.retryAfterMs}ms`), {
      retryAfterMs: rule.retryAfterMs,
      status: 429,
      transient: true,
    });
    throw error;
  }
}

/** Explicit archive fixtures only: an unscripted page or asset never becomes an empty success. */
export class FakeArchivePort implements ArchiveProvider {
  private expansion: { scopes: ArchiveScopeBinding[]; conversations: ArchiveConversation[] };
  private readonly pages: FakeArchivePageFixture[];
  private readonly checks: CheckResult[];
  private readonly assets: FakeArchiveAssetFixture[];
  private readonly transcriptConversationIds: Record<string, string | null>;
  private readonly effects: FakeEffectRule[];
  private available = true;

  constructor(fixture: FakeArchiveFixture) {
    this.expansion = structuredClone({
      scopes: fixture.scopes,
      conversations: fixture.conversations,
    });
    this.pages = structuredClone(fixture.pages);
    this.checks = structuredClone(fixture.checks ?? []);
    this.assets = structuredClone(fixture.assets ?? []);
    this.transcriptConversationIds = { ...fixture.transcriptConversationIds };
    this.effects = fixture.effects?.map((rule) => ({ ...rule })) ?? [];
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  setExpansion(scopes: ArchiveScopeBinding[], conversations: ArchiveConversation[]): void {
    this.expansion = structuredClone({ scopes, conversations });
  }

  scriptEffect(rule: FakeEffectRule): void {
    this.effects.push({ ...rule });
  }

  failPageOnce(
    input: { scopeId: string; route: ArchiveRoute; cursor: string | null },
    error: Error,
  ): void {
    this.scriptEffect({
      method: "page",
      objectId: JSON.stringify([input.scopeId, input.route, input.cursor]),
      count: 1,
      error,
    });
  }

  async expand(...[, signal]: Parameters<ArchiveProvider["expand"]>) {
    this.before("expand", undefined, signal);
    return structuredClone(this.expansion);
  }

  async *preflight(
    ...[, , signal]: Parameters<ArchiveProvider["preflight"]>
  ): AsyncIterable<CheckResult> {
    this.before("preflight", undefined, signal);
    for (const check of this.checks) {
      signal?.throwIfAborted();
      yield structuredClone(check);
    }
  }

  async page(input: Parameters<ArchiveProvider["page"]>[0]): Promise<ArchivePage> {
    const key = JSON.stringify([input.scope.id, input.route, input.cursor]);
    this.before("page", key, input.signal);
    const fixture = this.pages.find(
      (candidate) =>
        candidate.scopeId === input.scope.id &&
        candidate.route === input.route &&
        candidate.cursor === input.cursor,
    );
    if (!fixture) throw new Error(`Unscripted archive page: ${key}`);
    return structuredClone(fixture.page);
  }

  async transcriptConversationId(
    ...[record, , , signal]: Parameters<ArchiveProvider["transcriptConversationId"]>
  ): Promise<string | null> {
    this.before("transcriptConversationId", String(record.id), signal);
    return this.transcriptConversationIds[String(record.id)] ?? null;
  }

  async *assetRequests(
    ...[conversation, record, route, config, signal]: Parameters<ArchiveProvider["assetRequests"]>
  ): AsyncIterable<ArchiveAssetRequest> {
    this.before("assetRequests", String(record.id), signal);
    for (const asset of this.assets) {
      if (
        asset.conversationId !== conversation.id ||
        asset.recordId !== record.id ||
        asset.route !== route
      )
        continue;
      if (asset.kind === "attachment" && !config.attachmentBytes) continue;
      if (asset.kind === "transcript" && !config.transcripts) continue;
      signal?.throwIfAborted();
      yield {
        conversation: structuredClone(conversation),
        record: structuredClone(record),
        route,
        kind: asset.kind,
        id: asset.id,
        name: asset.name,
        ...(asset.sourceUrl === undefined ? {} : { sourceUrl: asset.sourceUrl }),
      };
    }
  }

  async *openAsset(
    ...[request, signal]: Parameters<ArchiveProvider["openAsset"]>
  ): AsyncIterable<Uint8Array> {
    this.before("openAsset", request.id, signal);
    const asset = this.assets.find(
      (candidate) =>
        candidate.conversationId === request.conversation.id &&
        candidate.recordId === request.record.id &&
        candidate.route === request.route &&
        candidate.kind === request.kind &&
        candidate.id === request.id,
    );
    if (!asset) throw new Error(`Unscripted archive asset: ${request.id}`);
    const rule = takeEffect(this.effects, "openAsset", request.id, "before", true);
    for await (const chunk of scriptedStream(encodeText(asset.content), rule, asset.chunkSize)) {
      signal?.throwIfAborted();
      yield chunk;
    }
  }

  private before(
    method: string,
    objectId: string | undefined,
    signal: AbortSignal | undefined,
  ): void {
    signal?.throwIfAborted();
    if (!this.available) throw new Error(`Archive effects disabled: ${method}`);
    const rule = takeEffect(this.effects, method, objectId);
    if (rule) throw rule.error;
  }
}
