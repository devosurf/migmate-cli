import { createHash } from "node:crypto";
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
  triggered?: boolean;
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
}

interface MutableSourceEntry extends SourceEntry {
  content: Uint8Array | null;
}

interface MutableDestinationEntry extends DestinationEntry {
  content: Uint8Array | null;
}

function encodeText(value: Uint8Array | string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  return new TextEncoder().encode(value);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readAll(content: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (content instanceof Uint8Array) {
    return content;
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of content) {
    chunks.push(chunk);
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

async function* asStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
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
    provenance: entry.provenance,
  };
}

export class FakeFileMigrationPort implements ProviderPort {
  readonly sourceDriveId: string;
  readonly sourceRootId: string;
  readonly destinationDriveId: string;
  readonly destinationRootId: string;

  private readonly sourceById: Record<string, MutableSourceEntry> = Object.create(null);
  private readonly sourceChildrenByParent: Record<string, string[]> = Object.create(null);
  private readonly destinationById: Record<string, MutableDestinationEntry> = Object.create(null);
  private readonly destinationChildrenByParent: Record<string, string[]> = Object.create(null);
  private readonly retryAfterRules: FakeRetryRule[];
  private readonly sourceMutationRules: FakeSourceMutationRule[];
  private readonly withheldChecksums = new Set<string>();
  private readonly interruptAfterMarker = new Set<string>();
  private readonly interruptAfterUpload = new Set<string>();
  private readonly unavailableDestinationStreams = new Set<string>();
  private readonly callLog: string[] = [];
  private workerState: { pid: number; version: string; alive: boolean; socketPath: string } | null;
  private readonly runDirectory: string;
  private idSeed = 0;

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

  blockDestinationStream(objectId: string): void {
    this.unavailableDestinationStreams.add(objectId);
  }

  unblockDestinationStream(objectId: string): void {
    this.unavailableDestinationStreams.delete(objectId);
  }

  interruptAfterMarkerOnce(objectId: string): void {
    this.interruptAfterMarker.add(objectId);
  }

  interruptAfterUploadOnce(objectId: string): void {
    this.interruptAfterUpload.add(objectId);
  }

  mutateSourceItem(
    sourceItemId: string,
    patch: Partial<{
      content: Uint8Array | string;
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

    if (patch.identity !== undefined) {
      entry.identity = patch.identity;
    }

    if (patch.modifiedAt !== undefined) {
      entry.modifiedAt = patch.modifiedAt;
    }

    if (patch.etag !== undefined) {
      entry.etag = patch.etag;
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
        provenance: entry.provenance,
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
    const entry = this.sourceById[sourceItemId];
    const rule = this.sourceMutationRules.find(
      (candidate) => candidate.sourceItemId === sourceItemId && !candidate.triggered,
    );
    this.throwRetryAfter("openSourceContent", sourceItemId);

    if (!entry || entry.content === null) {
      return asStream(new Uint8Array());
    }

    const bytes = entry.content;
    const self = this;
    return (async function* () {
      const chunkSize =
        bytes.byteLength <= 8 ? bytes.byteLength || 1 : Math.ceil(bytes.byteLength / 2);
      let first = true;
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
        if (first && rule) {
          first = false;
          const mutation: Partial<{
            content: Uint8Array | string;
            identity: string;
            modifiedAt: string;
            etag: string | null;
            size: number | null;
          }> = {
            content: rule.nextContent,
          };
          if (rule.nextIdentity !== undefined) {
            mutation.identity = rule.nextIdentity;
          }
          if (rule.nextModifiedAt !== undefined) {
            mutation.modifiedAt = rule.nextModifiedAt;
          }
          if (rule.nextEtag !== undefined) {
            mutation.etag = rule.nextEtag;
          }
          self.mutateSourceItem(sourceItemId, mutation);
          rule.triggered = true;
        }
      }
    })();
  }

  async resolveDestinationFolder(input: {
    destDriveId: string;
    destFolderId: string;
  }): Promise<DestinationEntry | null> {
    this.callLog.push(`resolveDestinationFolder:${input.destFolderId}`);
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

  async createDestinationFolder(input: {
    parentFolderId: string;
    name: string;
    createdAt: string;
    modifiedAt: string;
  }): Promise<DestinationEntry> {
    this.callLog.push(`createDestinationFolder:${input.parentFolderId}/${input.name}`);
    this.throwRetryAfter("createDestinationFolder", input.parentFolderId);
    const id = this.nextDestinationId("folder");
    const entry: MutableDestinationEntry = {
      id,
      driveId: this.destinationDriveId,
      parentId: input.parentFolderId,
      name: input.name,
      kind: "folder",
      size: null,
      etag: null,
      createdAt: input.createdAt,
      modifiedAt: input.modifiedAt,
      mimeType: null,
      reportedChecksum: null,
      provenance: null,
      content: null,
    };
    this.insertDestinationEntry(entry);
    return cloneDestination(entry);
  }

  async uploadDestinationContent(input: {
    destinationId?: string;
    parentFolderId: string;
    name: string;
    content: Uint8Array | AsyncIterable<Uint8Array>;
    createdAt: string;
    modifiedAt: string;
    mimeType: string | null;
  }): Promise<DestinationEntry> {
    const targetId = input.destinationId ?? this.nextDestinationId("file");
    this.callLog.push(`uploadDestinationContent:${targetId}`);
    this.throwRetryAfter("uploadDestinationContent", targetId);
    const bytes = await readAll(input.content);
    const checksum = hashBytes(bytes);
    const existing = this.destinationById[targetId];
    const entry: MutableDestinationEntry = existing
      ? {
          ...existing,
          parentId: input.parentFolderId,
          name: input.name,
          modifiedAt: input.modifiedAt,
          mimeType: input.mimeType,
          size: bytes.byteLength,
          content: bytes,
          reportedChecksum: this.withheldChecksums.has(targetId) ? null : checksum,
          etag: checksum,
        }
      : {
          id: targetId,
          driveId: this.destinationDriveId,
          parentId: input.parentFolderId,
          name: input.name,
          kind: "file",
          size: bytes.byteLength,
          etag: checksum,
          createdAt: input.createdAt,
          modifiedAt: input.modifiedAt,
          mimeType: input.mimeType,
          reportedChecksum: this.withheldChecksums.has(targetId) ? null : checksum,
          provenance: null,
          content: bytes,
        };

    if (!existing) {
      this.insertDestinationEntry(entry);
    } else {
      this.destinationById[targetId] = entry;
      this.relinkDestination(
        entry,
        existing.parentId,
        existing.name,
        input.parentFolderId,
        input.name,
      );
    }

    if (this.interruptAfterUpload.has(targetId)) {
      this.interruptAfterUpload.delete(targetId);
      const error = new Error(`interrupted after upload for ${targetId}`) as Error & {
        name: string;
      };
      error.name = "AbortError";
      throw error;
    }

    return cloneDestination(entry);
  }

  async moveDestinationObject(input: {
    objectId: string;
    parentFolderId: string;
    name: string;
    modifiedAt?: string;
  }): Promise<DestinationEntry> {
    this.callLog.push(`moveDestinationObject:${input.objectId}`);
    this.throwRetryAfter("moveDestinationObject", input.objectId);
    const entry = this.destinationById[input.objectId];
    if (!entry) {
      throw new Error(`unknown destination object: ${input.objectId}`);
    }

    this.relinkDestination(entry, entry.parentId, entry.name, input.parentFolderId, input.name);
    entry.parentId = input.parentFolderId;
    entry.name = input.name;
    if (input.modifiedAt) {
      entry.modifiedAt = input.modifiedAt;
    }

    return cloneDestination(entry);
  }
  async readDestinationMarker(objectId: string): Promise<ProvenanceRecord | null> {
    this.callLog.push(`readDestinationMarker:${objectId}`);
    const entry = this.destinationById[objectId];
    return entry ? entry.provenance : null;
  }

  async writeDestinationMarker(input: {
    objectId: string;
    marker: ProvenanceRecord | null;
  }): Promise<void> {
    this.callLog.push(`writeDestinationMarker:${input.objectId}`);
    const entry = this.destinationById[input.objectId];
    if (!entry) {
      throw new Error(`unknown destination object: ${input.objectId}`);
    }

    entry.provenance = input.marker;
    if (this.interruptAfterMarker.has(input.objectId)) {
      this.interruptAfterMarker.delete(input.objectId);
      const error = new Error(`interrupted after marker for ${input.objectId}`) as Error & {
        name: string;
      };
      error.name = "AbortError";
      throw error;
    }
  }

  streamDestinationContent(objectId: string): AsyncIterable<Uint8Array> {
    this.callLog.push(`streamDestinationContent:${objectId}`);
    const entry = this.destinationById[objectId];
    if (!entry) {
      throw new Error(`unknown destination object: ${objectId}`);
    }

    if (entry.content === null || this.unavailableDestinationStreams.has(objectId)) {
      throw new Error(`destination stream unavailable: ${objectId}`);
    }

    return asStream(entry.content);
  }

  async startTransferWorker(input: { runDirectory: string }): Promise<TransferWorkerHandle> {
    this.callLog.push(`startTransferWorker:${input.runDirectory}`);
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
    if (this.workerState && this.workerState.socketPath === input.socketPath) {
      this.workerState.alive = false;
    }
  }

  async terminateTransferWorker(input: { socketPath: string }): Promise<void> {
    this.callLog.push(`terminateTransferWorker:${input.socketPath}`);
    if (this.workerState && this.workerState.socketPath === input.socketPath) {
      this.workerState.alive = false;
    }
  }

  async transferWorkerVersion(input: { socketPath: string }): Promise<string | null> {
    this.callLog.push(`transferWorkerVersion:${input.socketPath}`);
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
    const entry: MutableSourceEntry = {
      id: fixture.id,
      driveId: this.sourceDriveId,
      parentId: fixture.parentId,
      name: fixture.name,
      kind: fixture.kind,
      size: fixture.size ?? null,
      etag: fixture.etag ?? null,
      createdAt: fixture.createdAt ?? new Date(0).toISOString(),
      modifiedAt: fixture.modifiedAt ?? new Date(0).toISOString(),
      mimeType: fixture.mimeType ?? null,
      identity: fixture.identity ?? fixture.id,
      downloadable: fixture.downloadable ?? fixture.kind !== "undownloadable",
      content: fixture.content !== undefined ? encodeText(fixture.content) : null,
    };
    this.sourceById[entry.id] = entry;
    const parentKey = entry.parentId ?? "";
    const children = this.sourceChildrenByParent[parentKey] ?? [];
    children.push(entry.id);
    this.sourceChildrenByParent[parentKey] = children;
  }

  private insertDestination(fixture: FakeDestinationItemFixture): void {
    const checksum =
      fixture.content !== undefined
        ? hashBytes(encodeText(fixture.content))
        : (fixture.reportedChecksum ?? null);
    const bytes = fixture.content !== undefined ? encodeText(fixture.content) : null;
    const entry: MutableDestinationEntry = {
      id: fixture.id,
      driveId: this.destinationDriveId,
      parentId: fixture.parentId,
      name: fixture.name,
      kind: fixture.kind,
      size: fixture.size ?? bytes?.byteLength ?? null,
      etag: fixture.etag ?? checksum,
      createdAt: fixture.createdAt ?? new Date(0).toISOString(),
      modifiedAt: fixture.modifiedAt ?? new Date(0).toISOString(),
      mimeType: fixture.mimeType ?? null,
      reportedChecksum: fixture.reportedChecksum ?? checksum,
      provenance: fixture.provenance ?? null,
      content: bytes,
    };
    this.insertDestinationEntry(entry);
  }

  private insertDestinationEntry(entry: MutableDestinationEntry): void {
    this.destinationById[entry.id] = entry;
    const parentKey = entry.parentId ?? "";
    const children = this.destinationChildrenByParent[parentKey] ?? [];
    children.push(entry.id);
    this.destinationChildrenByParent[parentKey] = children;
  }

  private relinkDestination(
    entry: MutableDestinationEntry,
    oldParentId: string | null,
    oldName: string,
    nextParentId: string,
    nextName: string,
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
    this.idSeed += 1;
    return `${prefix}-${this.idSeed}`;
  }

  private throwRetryAfter(method: string, objectId?: string): void {
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
    const error = new Error(`retry after ${rule.retryAfterMs}ms`) as RetryAfterError;
    error.retryAfterMs = rule.retryAfterMs;
    throw error;
  }
}
