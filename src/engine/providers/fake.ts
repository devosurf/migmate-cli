import { createHash, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { CheckResult } from "../types.ts";
import { ProviderFault } from "./fault.ts";
import {
  googleSourceName,
  googleDestinationName,
  sharepointSourceName,
  sharepointDestinationName,
  sharepointDestinationNameToStandard,
} from "./adapters/rclone-name-encoding.ts";
import type {
  ArchiveAssetRequest,
  ArchiveConversation,
  ArchivePage,
  ArchiveProvider,
  ArchiveRoute,
  ArchiveScopeBinding,
} from "./archive.ts";
import type {
  CopyPassHandle,
  CopyPassReference,
  CopyPassStats,
  CopyPassStatus,
  DestinationEntry,
  DestinationContainer,
  DestinationItemKind,
  FileHashEntry,
  FileListingComparison,
  FilePassRoot,
  GoogleAbout,
  DriveMember,
  DriveMembership,
  SharedDrive,
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
  driveId?: string;
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
  webUrl?: string | null;
  packageSections?: number | null;
  metadata?: Record<string, unknown>;
  content?: Uint8Array | string;
}

export interface FakeDestinationItemFixture {
  id: string;
  driveId?: string;
  parentId: string | null;
  name: string;
  kind: DestinationItemKind;
  size?: number | null;
  revision?: string | null;
  createdAt?: string;
  modifiedAt?: string;
  mimeType?: string | null;
  identity?: string;
  content?: Uint8Array | string;
  reportedChecksum?: string | null;
  provenance?: ProvenanceRecord | null;
  webUrl?: string;
}

export interface FakeRetryRule {
  method: string;
  objectId?: string;
  count: number;
  retryAfterMs: number;
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

export interface FakeCopyPassScenario {
  sourceRootId?: string;
  pause?: boolean;
  error?: string;
  afterFiles?: number;
}

export interface FakeDestinationContainerFixture {
  container: DestinationContainer;
  siteId?: string;
  members: DriveMembership[];
  inheritsPermissions?: boolean;
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
  runDirectory?: string;
  reservedDestinationIds?: string[];
  effects?: FakeEffectRule[];
  applicationIdentity?: string;
  googleAbout?: GoogleAbout | Error;
  destinationProvider?: "google_shared_drive" | "sharepoint";
  inheritedSiteMembers?: Record<string, DriveMembership[]>;
  destinationContainers?: FakeDestinationContainerFixture[];
  sharepointMembershipAvailable?: boolean;
  /** Observed app/system grants installed by breaking inheritance, if any. */
  implicitLibraryMembers?: DriveMembership[];
  unreadableSourceDrives?: string[];
  now?: () => Date;
  checks?: CheckResult[];
  archive?: FakeArchiveFixture;
  copyPasses?: FakeCopyPassScenario[];
}

interface MutableSourceEntry extends SourceEntry {
  content: Uint8Array | null;
}

interface MutableDestinationEntry extends DestinationEntry {
  content: Uint8Array | null;
}

interface FakeCopyPass {
  handle: CopyPassHandle;
  status: CopyPassStatus;
  stats: CopyPassStats;
  stopped: boolean;
  done: Promise<void>;
  paused?: Promise<void>;
  release?: () => void;
}

function fileHash(bytes: Uint8Array, type: "sha256" | "md5" | "quickxor"): string {
  if (type !== "quickxor") return createHash(type).update(bytes).digest("hex");
  const hash = Buffer.alloc(20);
  for (let i = 0; i < bytes.length; i++) {
    const bit = (i * 11) % 160;
    const index = Math.floor(bit / 8);
    const shift = bit % 8;
    hash[index] = hash[index]! ^ (bytes[i]! << shift);
    const next = (index + 1) % 20;
    hash[next] = hash[next]! ^ (bytes[i]! >>> (8 - shift));
  }
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(bytes.length));
  for (let i = 0; i < 8; i++) hash[12 + i] = hash[12 + i]! ^ size[i]!;
  return hash.toString("hex");
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

function sourceDirectory(entry: SourceEntry | DestinationEntry): boolean {
  return (
    entry.kind === "folder" ||
    (entry.kind === "package" && "packageSections" in entry && entry.packageSections !== null)
  );
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
    webUrl: entry.webUrl,
    packageSections: entry.packageSections,
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
    revision: entry.revision,
    createdAt: entry.createdAt,
    modifiedAt: entry.modifiedAt,
    mimeType: entry.mimeType,
    reportedChecksum: entry.reportedChecksum,
    ...(entry.webUrl ? { webUrl: entry.webUrl } : {}),
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
  private readonly withheldChecksums = new Set<string>();
  private readonly effects: FakeEffectRule[];
  private readonly reservedDestinationIds: string[];
  private readonly reservedIds = new Set<string>();
  private readonly unavailableDestinationStreams = new Map<string, Error>();
  private readonly checks: CheckResult[];
  private applicationId: string;
  private readonly about: GoogleAbout | Error;
  private readonly unreadableSourceDrives: Set<string>;
  private readonly now: () => Date;
  private readonly sharedDrives = new Map<string, DestinationContainer>();
  private readonly destinationProvider: "google_shared_drive" | "sharepoint";
  private readonly inheritedSiteMembers: Record<string, DriveMembership[]>;
  private readonly sharepointMembershipAvailable: boolean;
  private readonly implicitLibraryMembers: DriveMembership[];
  private readonly containerSites = new Map<string, string>();
  private readonly uniquePermissions = new Set<string>();
  private readonly driveRequests = new Map<string, string>();
  private readonly driveMembers = new Map<string, DriveMembership[]>();
  private readonly callLog: string[] = [];
  private workerState: { pid: number; version: string; alive: boolean; socketPath: string } | null;
  private readonly runDirectory: string;
  private idSeed = 0;
  private revisionSeed = 0;
  private workerExecuteId = randomUUID();
  private readonly passes = new Map<number, FakeCopyPass>();
  private passSeed = 0;
  private readonly copyPassScenarios: FakeCopyPassScenario[];

  constructor(fixture: FakeFileMigrationFixture) {
    this.now = fixture.now ?? (() => new Date());
    this.destinationProvider = fixture.destinationProvider ?? "google_shared_drive";
    this.inheritedSiteMembers = structuredClone(fixture.inheritedSiteMembers ?? {});
    this.sharepointMembershipAvailable = fixture.sharepointMembershipAvailable ?? false;
    this.implicitLibraryMembers = structuredClone(fixture.implicitLibraryMembers ?? []);
    this.unreadableSourceDrives = new Set(fixture.unreadableSourceDrives);
    this.copyPassScenarios = fixture.copyPasses?.map((scenario) => ({ ...scenario })) ?? [];
    this.sourceDriveId = fixture.sourceDriveId;
    this.sourceRootId = fixture.sourceRootId;
    this.destinationDriveId = fixture.destinationDriveId;
    this.destinationRootId = fixture.destinationRootId;
    this.retryAfterRules = fixture.retryAfter
      ? fixture.retryAfter.map((rule) => ({ ...rule }))
      : [];
    this.runDirectory = fixture.runDirectory ?? "/tmp/migmate-fake-run";
    this.effects = fixture.effects?.map((rule) => ({ ...rule })) ?? [];
    this.reservedDestinationIds = [...(fixture.reservedDestinationIds ?? [])];
    this.applicationId = fixture.applicationIdentity ?? "scripted-application";
    this.about = fixture.googleAbout ?? {
      user: { emailAddress: "service-account@example.com" },
      canCreateDrives: false,
    };
    this.checks = structuredClone(fixture.checks ?? []);
    if (fixture.archive) this.archive = new FakeArchivePort(fixture.archive);

    for (const source of fixture.sourceItems) {
      this.insertSource(source);
    }

    for (const destination of fixture.destinationItems) {
      this.insertDestination(destination);
    }

    for (const saved of fixture.destinationContainers ?? []) {
      const { container, siteId } = saved;
      this.sharedDrives.set(container.id, { ...container });
      this.driveMembers.set(container.id, structuredClone(saved.members));
      if (siteId !== undefined) this.containerSites.set(container.id, siteId);
      if (saved.inheritsPermissions === false) this.uniquePermissions.add(container.id);
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

  scriptEffect(rule: FakeEffectRule): void {
    this.effects.push({ ...rule });
  }

  loseResponseOnce(
    method: FakeEffectRule["method"],
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

  async googleAbout(): Promise<GoogleAbout> {
    if (this.about instanceof Error) throw this.about;
    return structuredClone(this.about);
  }

  async destinationCreator(): Promise<string> {
    return this.destinationProvider === "sharepoint"
      ? ""
      : (await this.googleAbout()).user.emailAddress;
  }

  private requireMembershipCredentials(): void {
    if (this.destinationProvider === "sharepoint" && !this.sharepointMembershipAvailable)
      throw Object.assign(
        new Error(
          "Named library members require the optional SharePoint certificate setup in CREDENTIALS.md.",
        ),
        { code: "sharepoint_membership_credentials_required", transient: false },
      );
  }

  async validateDestinationCreation(
    input: Parameters<NonNullable<ProviderPort["validateDestinationCreation"]>>[0],
  ): Promise<void> {
    if (input.members.length === 0) return;
    this.callLog.push(`validateDestinationCreation:${input.siteId ?? ""}`);
    try {
      this.requireMembershipCredentials();
    } catch {
      throw new ProviderFault(
        "preflight_failed",
        "Named library members require the optional SharePoint certificate setup in CREDENTIALS.md.",
        { check: "sharepoint_membership_credentials_required", siteId: input.siteId },
      );
    }
    if (this.destinationProvider === "sharepoint" && !input.siteId)
      throw destinationFault("destination_site_required", 400);
    this.throwEffect("validateDestinationCreation", input.siteId, "before");
  }

  async createDestinationContainer(
    input: Parameters<ProviderPort["createDestinationContainer"]>[0],
  ): Promise<DestinationContainer | null> {
    this.callLog.push(`createDestinationContainer:${input.name}`);
    this.throwEffect("createDestinationContainer", input.name, "before");
    const sharepoint = this.destinationProvider === "sharepoint";
    if (sharepoint && !input.siteId) throw destinationFault("destination_site_required", 400);
    if (
      sharepoint
        ? [...this.sharedDrives.values()].some(
            (drive) =>
              drive.name === input.name && this.containerSites.get(drive.id) === input.siteId,
          )
        : this.driveRequests.has(input.requestId)
    )
      return null;
    let sequence = this.sharedDrives.size + 1;
    while (this.sharedDrives.has(`drive-${sequence}`)) sequence++;
    const id = `drive-${sequence}`;
    const rootFolderId = sharepoint ? `${id}-root` : id;
    const drive: DestinationContainer = {
      id,
      name: input.name,
      createdTime: this.now().toISOString(),
      ...(sharepoint ? { rootFolderId, creationRequestId: input.requestId } : {}),
    };
    this.sharedDrives.set(id, drive);
    this.driveRequests.set(input.requestId, id);
    if (input.siteId) this.containerSites.set(id, input.siteId);
    this.driveMembers.set(
      id,
      sharepoint
        ? structuredClone(this.inheritedSiteMembers[input.siteId!] ?? [])
        : [{ email: await this.destinationCreator(), type: "user", role: "organizer" }],
    );
    this.insertDestination({
      id: rootFolderId,
      driveId: id,
      name: input.name,
      parentId: null,
      kind: "folder",
      ...(sharepoint
        ? {
            webUrl: `https://fake.sharepoint.com/sites/${encodeURIComponent(input.siteId!)}/${encodeURIComponent(input.name)}`,
          }
        : {}),
    });
    this.throwEffect("createDestinationContainer", input.name, "after");
    return { ...drive };
  }
  async findDestinationContainers(
    input: Parameters<ProviderPort["findDestinationContainers"]>[0],
  ): Promise<DestinationContainer[]> {
    if (this.destinationProvider === "sharepoint" && !input.siteId)
      throw destinationFault("destination_site_required", 400);
    return [...this.sharedDrives.values()]
      .filter(
        (drive) =>
          drive.name === input.name &&
          (this.destinationProvider !== "sharepoint" ||
            this.containerSites.get(drive.id) === input.siteId),
      )
      .map((drive) => ({ ...drive }));
  }

  async prepareDestinationMembers(driveId: string): Promise<void> {
    this.requireMembershipCredentials();
    this.callLog.push(`prepareDestinationMembers:${driveId}`);
    this.throwEffect("prepareDestinationMembers", driveId, "before");
    if (this.destinationProvider === "sharepoint" && !this.uniquePermissions.has(driveId)) {
      if (!this.driveMembers.has(driveId)) throw destinationFault("destination_missing", 404);
      this.driveMembers.set(driveId, structuredClone(this.implicitLibraryMembers));
      this.uniquePermissions.add(driveId);
      this.callLog.push(`breakPermissionInheritance:${driveId}`);
    }
    this.throwEffect("prepareDestinationMembers", driveId, "after");
  }

  destinationInheritsPermissions(driveId: string): boolean {
    return this.containerSites.has(driveId) && !this.uniquePermissions.has(driveId);
  }

  snapshotDestinationContainers(): FakeDestinationContainerFixture[] {
    return [...this.sharedDrives.values()].map((container) => {
      const siteId = this.containerSites.get(container.id);
      return {
        container: { ...container },
        ...(siteId === undefined ? {} : { siteId }),
        members: structuredClone(this.driveMembers.get(container.id) ?? []),
        inheritsPermissions: this.destinationInheritsPermissions(container.id),
      };
    });
  }
  async listDriveMembers(driveId: string): Promise<DriveMembership[]> {
    this.requireMembershipCredentials();
    return structuredClone(this.driveMembers.get(driveId) ?? []);
  }
  async addDriveMember(driveId: string, member: DriveMember): Promise<void> {
    if (this.destinationProvider === "sharepoint") {
      if (!["read", "write", "owner"].includes(member.role))
        throw destinationFault("unsupported_member_role", 400);
      await this.prepareDestinationMembers(driveId);
    }
    this.callLog.push(`addDriveMember:${driveId}:${member.email}`);
    this.throwEffect("addDriveMember", member.email, "before");
    const members = this.driveMembers.get(driveId);
    if (!members) throw destinationFault("destination_missing", 404);
    const existing = members.findIndex((m) => m.email === member.email && m.type === member.type);
    if (existing < 0) members.push({ ...member });
    else members[existing] = { ...member };
    this.throwEffect("addDriveMember", member.email, "after");
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
    return entry?.driveId === input.driveId && !this.unreadableSourceDrives.has(input.driveId)
      ? cloneSource(entry)
      : null;
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
      downloadable: boolean;
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
    if (patch.downloadable !== undefined) entry.downloadable = patch.downloadable;
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
      entry.etag = `source-${++this.revisionSeed}`;
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

  snapshotDestination(rootId = this.destinationRootId): Array<{
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
    const root = this.destinationById[rootId];
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

  /** The acting account loses its membership of a source Shared Drive after load. */
  revokeSourceDriveAccess(driveId: string): void {
    this.unreadableSourceDrives.add(driveId);
  }

  async readSharedDrive(driveId: string): Promise<SharedDrive | null> {
    if (this.unreadableSourceDrives.has(driveId)) return null;
    const root = Object.values(this.sourceById).find(
      (item) => item.driveId === driveId && item.parentId === null,
    );
    return root ? { id: driveId, name: root.name } : null;
  }

  async resolveSourceFolder(input: {
    driveId: string;
    folderPath: string;
  }): Promise<SourceEntry | null> {
    let entry = Object.values(this.sourceById).find(
      (item) => item.driveId === input.driveId && item.parentId === null,
    );
    for (const part of input.folderPath ? input.folderPath.split("/") : []) {
      if (!entry) return null;
      const parent = entry.id;
      entry = Object.values(this.sourceById).find(
        (item) => item.parentId === parent && item.name === part && item.driveId === input.driveId,
      );
    }
    return entry ? cloneSource(entry) : null;
  }

  async resolveDestinationPath(input: {
    driveId: string;
    folderPath: string;
  }): Promise<DestinationEntry | null> {
    let entry = Object.values(this.destinationById).find(
      (item) => item.driveId === input.driveId && item.parentId === null,
    );
    for (const part of input.folderPath ? input.folderPath.split("/") : []) {
      if (!entry) return null;
      const parent = entry.id;
      entry = Object.values(this.destinationById).find(
        (item) => item.parentId === parent && item.name === part && item.driveId === input.driveId,
      );
    }
    return entry ? cloneDestination(entry) : null;
  }

  async resolveSourceRoot(input: {
    sourceDriveId: string;
    sourceItemId: string;
  }): Promise<SourceEntry | null> {
    this.callLog.push(`resolveSourceRoot:${input.sourceItemId}`);
    this.throwRetryAfter("resolveSourceRoot", input.sourceItemId);
    const entry = this.sourceById[input.sourceItemId];
    if (
      !entry ||
      entry.driveId !== input.sourceDriveId ||
      this.unreadableSourceDrives.has(input.sourceDriveId)
    ) {
      return null;
    }

    return cloneSource(entry);
  }

  async listSourceChildren(input: { driveId: string; itemId: string }): Promise<SourceEntry[]> {
    this.callLog.push(`listSourceChildren:${input.itemId}`);
    this.throwRetryAfter("listSourceChildren", input.itemId);
    if (this.sourceById[input.itemId]?.driveId !== input.driveId) return [];
    const childIds = this.sourceChildrenByParent[input.itemId] ?? [];
    const children: SourceEntry[] = [];
    for (const childId of childIds) {
      const child = this.sourceById[childId];
      if (child) {
        children.push(cloneSource(child));
      }
    }

    return children;
  }

  openSourceContent(input: { driveId: string; itemId: string }): AsyncIterable<Uint8Array> {
    this.callLog.push(`openSourceContent:${input.itemId}`);
    this.throwRetryAfter("openSourceContent", input.itemId);
    const entry = this.sourceById[input.itemId];
    if (
      !entry ||
      entry.driveId !== input.driveId ||
      entry.content === null ||
      !entry.downloadable
    ) {
      throw destinationFault("source_read_failed", entry ? 403 : 404);
    }
    const fault = takeEffect(this.effects, "openSourceContent", input.itemId, "before", true);
    return scriptedStream(entry.content, fault);
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
      revision: this.nextRevision(),
      createdAt: input.createdAt,
      modifiedAt: input.modifiedAt,
      mimeType: null,
      reportedChecksum: null,
      provenance: input.marker ? { ...input.marker } : null,
      content: null,
    };
    this.insertDestinationEntry(entry);
    this.reservedIds.delete(id);
    this.throwEffect("createDestinationFolder", id, "after");
    return cloneDestination(entry);
  }

  async uploadDestinationContent(
    input: Parameters<ProviderPort["uploadDestinationContent"]>[0],
  ): Promise<DestinationEntry> {
    const targetId = input.destinationId ?? this.nextDestinationId("file");
    this.callLog.push(`uploadDestinationContent:${targetId}`);
    this.throwRetryAfter("uploadDestinationContent", targetId);
    const parent = this.destinationParent(input.parentFolderId);
    if (this.destinationById[targetId]) throw destinationFault("destination_id_conflict", 409);
    const bytes = await readAll(input.content);
    if (this.destinationById[targetId]) throw destinationFault("destination_id_conflict", 409);
    const entry: MutableDestinationEntry = {
      id: targetId,
      driveId: parent.driveId,
      parentId: parent.id,
      name: input.name,
      kind: "file",
      size: bytes.byteLength,
      revision: this.nextRevision(),
      createdAt: input.createdAt,
      modifiedAt: input.modifiedAt,
      mimeType: input.mimeType,
      reportedChecksum: this.withheldChecksums.has(targetId) ? null : hashBytes(bytes),
      provenance: input.marker ? { ...input.marker } : null,
      content: bytes,
    };
    this.insertDestinationEntry(entry);
    this.reservedIds.delete(targetId);
    input.onUploadProgress?.(bytes.byteLength);
    this.throwEffect("uploadDestinationContent", targetId, "after");
    return cloneDestination(entry);
  }

  async readDestinationMarker(objectId: string): Promise<ProvenanceRecord | null> {
    this.callLog.push(`readDestinationMarker:${objectId}`);
    this.throwRetryAfter("readDestinationMarker", objectId);
    const entry = this.destinationById[objectId];
    return entry?.provenance ? { ...entry.provenance } : null;
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

  private assertPassWorker(socketPath: string): void {
    if (!this.workerState?.alive || this.workerState.socketPath !== socketPath)
      throw destinationFault("worker_exited", 500);
  }

  private pass(reference: CopyPassReference): FakeCopyPass {
    this.assertPassWorker(reference.socketPath);
    const pass = this.passes.get(reference.pass.jobid);
    if (
      !pass ||
      reference.pass.executeId !== this.workerExecuteId ||
      reference.pass.group !== pass.handle.group
    )
      throw destinationFault("copy_pass_handle_mismatch", 500);
    return pass;
  }

  private tree(root: FilePassRoot): Map<string, MutableSourceEntry | MutableDestinationEntry> {
    const source = this.sourceById[root.fs];
    const entries = source ? this.sourceById : this.destinationById;
    const children = source ? this.sourceChildrenByParent : this.destinationChildrenByParent;
    if (entries[root.fs]?.kind !== "folder") throw destinationFault("directory_not_found", 404);
    const standardName =
      root.kind === "google_drive"
        ? googleSourceName
        : root.kind === "sharepoint"
          ? source
            ? sharepointSourceName
            : sharepointDestinationNameToStandard
          : (name: string) => name;
    const result = new Map<string, MutableSourceEntry | MutableDestinationEntry>();
    const visit = (id: string, prefix: string) => {
      for (const childId of children[id] ?? []) {
        const child = entries[childId];
        if (!child) continue;
        const name = standardName(child.name);
        if (name === null) throw destinationFault("path_unrepresentable", 400);
        const path = `${prefix}${name}`;
        result.set(path, child);
        if (sourceDirectory(child)) visit(child.id, `${path}/`);
      }
    };
    visit(root.fs, "");
    return result;
  }

  async compareFileListings(
    input: Parameters<ProviderPort["compareFileListings"]>[0],
  ): Promise<FileListingComparison> {
    this.assertPassWorker(input.socketPath);
    this.throwRetryAfter("compareFileListings", input.source.fs);
    const source = this.tree(input.source);
    const destination = this.tree(input.destination);
    const comparison: {
      [K in keyof FileListingComparison]: FileListingComparison[K] extends Iterable<infer T>
        ? FileListingComparison[K] extends string
          ? string
          : T[]
        : FileListingComparison[K];
    } = {
      new: [],
      changed: [],
      unchanged: [],
      deleted: [],
      retained: [],
      timestampOnly: [],
      modifyWindowNs: "1000000000",
    };
    for (const [path, entry] of source) {
      if (sourceDirectory(entry)) continue;
      const previous = destination.get(path);
      const item = { path, size: entry.size ?? -1 };
      // Match this fake's content-based executeCopyPass predicate, not an
      // invented timestamp clock for fixture content mutations.
      if (!previous) comparison.new.push(item);
      else if (
        previous.kind === "file" &&
        previous.content !== null &&
        entry.content !== null &&
        hashBytes(previous.content) === hashBytes(entry.content)
      )
        comparison.unchanged.push(item);
      else comparison.changed.push(item);
    }
    for (const [path, entry] of destination) {
      if (source.has(path) || sourceDirectory(entry)) continue;
      comparison[input.mode === "mirror" ? "deleted" : "retained"].push({
        path,
        size: entry.size ?? -1,
      });
    }
    for (const entries of [
      comparison.new,
      comparison.changed,
      comparison.unchanged,
      comparison.deleted,
      comparison.retained,
    ])
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return comparison;
  }

  async startCopyPass(
    input: Parameters<ProviderPort["startCopyPass"]>[0],
  ): Promise<CopyPassHandle> {
    this.assertPassWorker(input.socketPath);
    this.throwRetryAfter("startCopyPass", input.source.fs);
    if (
      input.mode === "mirror" &&
      (!Number.isSafeInteger(input.deleteLimit) || input.deleteLimit < 0)
    )
      throw destinationFault("copy_pass_delete_limit_invalid", 400);
    const jobid = ++this.passSeed;
    const handle = {
      executeId: this.workerExecuteId,
      jobid,
      group: `fake-${this.workerExecuteId}-${jobid}`,
    };
    const pass: FakeCopyPass = {
      handle,
      status: { state: "running", error: null },
      stats: { bytes: 0, files: 0, errors: 0, speed: 0, transferring: [] },
      stopped: false,
      done: Promise.resolve(),
    };
    this.passes.set(jobid, pass);
    const scenarioIndex = this.copyPassScenarios.findIndex(
      (scenario) =>
        scenario.sourceRootId === undefined || scenario.sourceRootId === input.source.fs,
    );
    const scenario =
      scenarioIndex < 0 ? undefined : this.copyPassScenarios.splice(scenarioIndex, 1)[0];
    const paused = scenario?.pause ? Promise.withResolvers<void>() : undefined;
    if (paused) pass.paused = paused.promise;
    pass.done = this.executeCopyPass(input, pass, scenario, paused?.resolve);
    return { ...handle };
  }

  private async executeCopyPass(
    input: Parameters<ProviderPort["startCopyPass"]>[0],
    pass: FakeCopyPass,
    scenario?: FakeCopyPassScenario,
    paused?: () => void,
  ): Promise<void> {
    const active = () => {
      if (pass.stopped || pass.handle.executeId !== this.workerExecuteId)
        throw new Error("context canceled");
      this.assertPassWorker(input.socketPath);
    };
    let scenarioApplied = false;
    const checkpoint = async () => {
      if (!scenario || scenarioApplied || pass.stats.files < (scenario.afterFiles ?? 0)) return;
      scenarioApplied = true;
      if (scenario.pause) {
        await new Promise<void>((resolve) => {
          pass.release = resolve;
          paused?.();
        });
        delete pass.release;
      }
      active();
      if (scenario.error) throw new Error(scenario.error);
    };
    try {
      await setImmediate();
      active();
      await checkpoint();
      const source = this.tree(input.source);
      const destination = this.tree(input.destination);
      const parents = new Map<string, string>([["", input.destination.fs]]);
      for (const [path, entry] of source) {
        active();
        const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const parentId = parents.get(parentPath)!;
        const existing = destination.get(path);
        const basename = path.slice(path.lastIndexOf("/") + 1);
        const destinationName =
          input.destination.kind === "sharepoint"
            ? sharepointDestinationName(basename)
            : input.destination.kind === "google_drive"
              ? googleDestinationName(basename)
              : basename;
        if (sourceDirectory(entry)) {
          if (existing && existing.kind !== "folder") throw new Error(`not a directory: ${path}`);
          const folder =
            existing ??
            (await this.createDestinationFolder({
              parentFolderId: parentId,
              name: destinationName,
              createdAt: entry.createdAt,
              modifiedAt: entry.modifiedAt,
            }));
          parents.set(path, folder.id);
          continue;
        }
        if (
          entry.kind !== "file" ||
          entry.content === null ||
          ("downloadable" in entry && !entry.downloadable)
        )
          throw new Error(`source unreadable: ${path}`);
        if (
          existing?.kind === "file" &&
          existing.content !== null &&
          hashBytes(existing.content) === hashBytes(entry.content)
        )
          continue;
        pass.stats.transferring = [{ path, bytes: 0, size: entry.content.length }];
        await setImmediate();
        active();
        this.throwRetryAfter("copyPass", path);
        if (existing && existing.kind !== "file") throw new Error(`not a file: ${path}`);
        if (existing) {
          this.mutateDestinationContent(existing.id, entry.content);
          existing.modifiedAt = entry.modifiedAt;
          existing.mimeType = entry.mimeType;
        } else {
          this.insertDestination({
            id: this.nextDestinationId("file"),
            parentId,
            driveId: this.destinationParent(parentId).driveId,
            name: destinationName,
            kind: "file",
            content: entry.content,
            createdAt: entry.createdAt,
            modifiedAt: entry.modifiedAt,
            mimeType: entry.mimeType,
          });
        }
        pass.stats.bytes += entry.content.length;
        pass.stats.files++;
        pass.stats.transferring = [];
        await checkpoint();
      }
      if (input.mode === "mirror") {
        const extras = [...destination].filter(([path]) => !source.has(path));
        const files = extras.filter(([, entry]) => entry.kind !== "folder");
        for (const [, entry] of files.slice(0, input.deleteLimit))
          this.removeDestinationItem(entry.id);
        if (files.length > input.deleteLimit) throw new Error("max-delete limit exceeded");
        for (const [, entry] of extras.reverse())
          if (entry.kind === "folder") this.removeDestinationItem(entry.id);
      }
      pass.status = { state: "completed", error: null };
    } catch (error) {
      pass.stats.errors++;
      pass.status = {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      pass.stats.transferring = [];
    }
  }

  async copyPassStatus(reference: CopyPassReference): Promise<CopyPassStatus> {
    return { ...this.pass(reference).status };
  }

  async copyPassStats(reference: CopyPassReference): Promise<CopyPassStats> {
    return structuredClone(this.pass(reference).stats);
  }

  async stopCopyPass(reference: CopyPassReference): Promise<void> {
    const pass = this.pass(reference);
    pass.stopped = true;
    pass.release?.();
    await pass.done;
  }

  async resolveFilePass(input: Parameters<ProviderPort["resolveFilePass"]>[0]) {
    if (!this.workerState?.alive) throw destinationFault("worker_exited", 500);
    return {
      socketPath: this.workerState.socketPath,
      source: {
        fs: input.sourceItemId,
        kind:
          input.sourceType === "google_shared_drive"
            ? ("google_drive" as const)
            : input.sourceType === "dropbox"
              ? ("dropbox" as const)
              : ("sharepoint" as const),
      },
      destination: {
        fs: input.destFolderId,
        ignoreSizeAndChecksum: input.sourceType === "google_shared_drive",
        kind:
          input.sourceType === "google_shared_drive"
            ? ("sharepoint" as const)
            : ("google_drive" as const),
      },
    };
  }

  async listFolders(input: Parameters<ProviderPort["listFolders"]>[0]): Promise<Iterable<string>> {
    this.assertPassWorker(input.socketPath);
    this.throwRetryAfter("listFolders", input.root.fs);
    return [...this.tree(input.root)]
      .filter(([, entry]) => sourceDirectory(entry))
      .map(([path]) => path)
      .sort();
  }

  async listFileHashes(
    input: Parameters<ProviderPort["listFileHashes"]>[0],
  ): Promise<Iterable<FileHashEntry>> {
    this.assertPassWorker(input.socketPath);
    this.throwEffect("listFileHashes", input.root.fs, "before");
    this.throwRetryAfter("listFileHashes", input.root.fs);
    const hashes: FileHashEntry[] = [];
    const selected = input.paths === undefined ? null : new Set(input.paths);
    for (const [path, entry] of this.tree(input.root)) {
      if (sourceDirectory(entry) || (selected !== null && !selected.has(path))) continue;
      const unreadable =
        input.download &&
        (entry.content === null ||
          ("downloadable" in entry && !entry.downloadable) ||
          this.unavailableDestinationStreams.has(entry.id));
      const supported =
        input.download ||
        input.root.kind === "local" ||
        (input.root.kind === "sharepoint"
          ? input.hashType === "quickxor"
          : input.hashType !== "quickxor");
      const hash =
        !supported ||
        unreadable ||
        entry.content === null ||
        (!input.download && input.hashType === "sha256" && this.withheldChecksums.has(entry.id))
          ? null
          : !input.download && input.hashType === "sha256" && "reportedChecksum" in entry
            ? entry.reportedChecksum
            : fileHash(entry.content, input.hashType);
      // rclone's OneDrive backend lists IDs as `driveId#itemId`.
      const id = input.root.kind === "sharepoint" ? `${entry.driveId}#${entry.id}` : entry.id;
      hashes.push({ path, size: entry.size ?? -1, hash, id });
    }
    return hashes;
  }

  /** Simulate an outside edit, not a provider upload. */
  mutateDestinationContent(id: string, content: Uint8Array | string): void {
    const entry = this.destinationById[id];
    if (!entry) throw destinationFault("destination_missing", 404);
    entry.content = encodeText(content);
    entry.size = entry.content.byteLength;
    entry.reportedChecksum = this.withheldChecksums.has(id) ? null : hashBytes(entry.content);
    entry.revision = this.nextRevision();
  }

  /** Wait for a scripted pause, without racing progress sampling or elapsed time. */
  async waitForCopyPassPaused(jobid: number): Promise<void> {
    const pass = this.passes.get(jobid);
    if (!pass?.paused) throw new Error("Fake copy pass has no scripted pause");
    await Promise.race([
      pass.paused,
      pass.done.then(() => {
        throw new Error("Fake copy pass ended before its paused checkpoint");
      }),
    ]);
  }

  releaseCopyPasses(jobid?: number): void {
    for (const pass of this.passes.values())
      if (jobid === undefined || pass.handle.jobid === jobid) pass.release?.();
  }

  removeDestinationItem(id: string): void {
    const entry = this.destinationById[id];
    if (!entry) return;
    delete this.destinationById[id];
    delete this.destinationChildrenByParent[id];
    const key = entry.parentId ?? "";
    this.destinationChildrenByParent[key] = (this.destinationChildrenByParent[key] ?? []).filter(
      (child) => child !== id,
    );
  }

  async startTransferWorker(
    input: Parameters<ProviderPort["startTransferWorker"]>[0],
  ): Promise<TransferWorkerHandle> {
    this.callLog.push(`startTransferWorker:${input.runDirectory}`);
    this.throwRetryAfter("startTransferWorker", input.runDirectory);
    for (const pass of this.passes.values()) pass.stopped = true;
    this.releaseCopyPasses();
    await Promise.all([...this.passes.values()].map((pass) => pass.done));
    this.passes.clear();
    this.workerExecuteId = randomUUID();
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
    for (const pass of this.passes.values()) pass.stopped = true;
    this.releaseCopyPasses();
    await Promise.all([...this.passes.values()].map((pass) => pass.done));
    if (this.workerState && this.workerState.socketPath === input.socketPath) {
      this.workerState.alive = false;
    }
  }

  async terminateTransferWorker(input: { socketPath: string }): Promise<void> {
    this.callLog.push(`terminateTransferWorker:${input.socketPath}`);
    this.throwRetryAfter("terminateTransferWorker", input.socketPath);
    for (const pass of this.passes.values()) pass.stopped = true;
    this.releaseCopyPasses();
    await Promise.all([...this.passes.values()].map((pass) => pass.done));
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
      driveId: fixture.driveId ?? this.sourceDriveId,
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
      webUrl: fixture.webUrl ?? null,
      packageSections: fixture.packageSections ?? null,
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
      driveId: fixture.driveId ?? this.destinationDriveId,
      parentId: fixture.parentId,
      name: fixture.name,
      kind: fixture.kind,
      size: fixture.size ?? bytes?.byteLength ?? null,
      revision: fixture.revision !== undefined ? fixture.revision : this.nextRevision(),
      createdAt: fixture.createdAt ?? new Date(0).toISOString(),
      modifiedAt: fixture.modifiedAt ?? new Date(0).toISOString(),
      mimeType: fixture.mimeType ?? null,
      reportedChecksum:
        fixture.reportedChecksum !== undefined ? fixture.reportedChecksum : checksum,
      provenance: fixture.provenance ? { ...fixture.provenance } : null,
      ...(fixture.webUrl ? { webUrl: fixture.webUrl } : {}),
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

  private nextRevision(): string {
    return `"fake-${++this.revisionSeed}"`;
  }

  private destinationParent(id: string): MutableDestinationEntry {
    const entry = this.destinationById[id];
    if (!entry || entry.kind !== "folder") throw destinationFault("destination_write_failed", 404);
    return entry;
  }

  private throwEffect(
    method: string,
    objectId?: string,
    timing: "before" | "after" = "before",
  ): void {
    const rule = takeEffect(this.effects, method, objectId, timing);
    if (rule) throw rule.error;
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
