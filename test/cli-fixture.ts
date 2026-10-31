import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
  type FakeDestinationItemFixture,
  type FakeArchiveFixture,
} from "../src/engine/providers/fake.ts";
import type {
  CopyPassReference,
  DestinationEntry,
  ProviderPort,
} from "../src/engine/providers/port.ts";

export const CLI_JOB_CONFIG = {
  sourceProvider: "sharepoint",
  destinationProvider: "google_shared_drive",
  mappings: [
    {
      id: "map-1",
      sourceDriveId: "src-drive",
      sourceItemId: "src-root",
      destDriveId: "dst-drive",
      destFolderId: "dst-root",
    },
  ],
};
export const CLI_REVERSE_JOB_CONFIG = {
  sourceProvider: "google_shared_drive",
  destinationProvider: "sharepoint",
};
export const CLI_REVERSE_MANIFEST = {
  version: 1,
  mappings: [
    {
      id: "map-1",
      source: { type: "google_shared_drive", driveId: "src-drive", folderId: "src-root" },
      destination: { type: "sharepoint", driveId: "dst-drive", folderPath: "" },
    },
  ],
};
export const FIXTURE_TIME = "2026-09-01T00:00:00.000Z";
export const CLI_ARCHIVE_CONFIG = {
  scopes: [{ kind: "channel", teamId: "team-1", channelId: "channel-1" }],
  window: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" },
  timezone: "UTC",
  retainedHistory: false,
  transcripts: false,
  attachmentBytes: false,
};
export function cliFixture(count = 8): FakeFileMigrationFixture {
  return {
    sourceDriveId: "src-drive",
    sourceRootId: "src-root",
    destinationDriveId: "dst-drive",
    destinationRootId: "dst-root",
    sourceItems: [
      { id: "src-root", parentId: null, name: "root", kind: "folder", identity: "src-root" },
      ...Array.from({ length: count }, (_, index) => ({
        id: `source-${index}`,
        parentId: "src-root",
        name: `${index}.txt`,
        kind: "file" as const,
        identity: `source-${index}`,
        content: `content-${index}`,
        size: Buffer.byteLength(`content-${index}`),
        mimeType: "text/plain",
        createdAt: FIXTURE_TIME,
        modifiedAt: FIXTURE_TIME,
      })),
    ],
    destinationItems: [
      {
        id: "dst-root",
        parentId: null,
        name: "root",
        kind: "folder",
        identity: "dst-root",
        webUrl: "https://fake.sharepoint.com/sites/Existing/Documents",
      },
    ],
    worker: { version: "1.75.0", alive: false },
  };
}

export function cliArchiveFixture(): FakeArchiveFixture {
  return {
    scopes: [
      {
        id: "scope-1",
        kind: "channel",
        teamId: "team-1",
        channelId: "channel-1",
        conversationIds: ["conversation-1"],
      },
    ],
    conversations: [
      {
        id: "conversation-1",
        kind: "channel",
        title: "Fixture channel",
        scopeEntryId: "scope-1",
        participantScopeIds: ["scope-1"],
        teamId: "team-1",
        channelId: "channel-1",
        membershipType: "standard",
        raw: { id: "channel-1" },
      },
    ],
    pages: Array.from({ length: 8 }, (_, index) => ({
      scopeId: "scope-1",
      route: "messages",
      cursor: index === 0 ? null : `page-${index}`,
      page: {
        records: [
          {
            id: `message-${index}`,
            channelIdentity: { teamId: "team-1", channelId: "channel-1" },
            createdDateTime: FIXTURE_TIME,
            lastModifiedDateTime: FIXTURE_TIME,
            from: { user: { id: "user-1", displayName: "Fixture author" } },
            body: { contentType: "html", content: `<p>Message ${index}</p>` },
          },
        ],
        nextLink: index < 7 ? `page-${index + 1}` : null,
      },
    })),
  };
}

/** The only subprocess substitution is provider effects below the real engine.
 * This file is outside src and never offers a production fake-provider switch.
 * Destination state survives child death, independently of the engine's state.
 */
export class PersistentCliPort extends FakeFileMigrationPort {
  readonly destinationPath: string;
  private readonly control: { verb: string; ready: () => void } | undefined;
  private readonly barriers = new Set<() => void>();
  private released = false;
  private copyReady = false;
  private sourceRootReads = 0;
  constructor(
    destinationPath: string,
    control?: { verb: string; ready: () => void },
    destinationProvider: "google_shared_drive" | "sharepoint" = "google_shared_drive",
    sharepointMembershipAvailable = false,
    fixture = cliFixture(),
  ) {
    // These effects live in the CLI process. An arbitrary fake PID can collide
    // with an unrelated live process and correctly prevent stale-lease recovery.
    fixture.worker = { ...fixture.worker, pid: process.pid };
    fixture.archive = cliArchiveFixture();
    fixture.destinationProvider = destinationProvider;
    fixture.sharepointMembershipAvailable = sharepointMembershipAvailable;
    if (existsSync(`${destinationPath}.containers.json`))
      fixture.destinationContainers = JSON.parse(
        readFileSync(`${destinationPath}.containers.json`, "utf8"),
      );
    if (control) fixture.copyPasses = [{ pause: true, afterFiles: 1 }];
    if (existsSync(destinationPath))
      fixture.destinationItems = JSON.parse(readFileSync(destinationPath, "utf8"));
    super(fixture);
    this.destinationPath = destinationPath;
    this.control = control;
    if (this.archive && control) {
      const page = this.archive.page.bind(this.archive);
      this.archive.page = async (input) => {
        // Execution commits the first page before the next external read blocks.
        if (control.verb !== "execute" || input.cursor !== null) await this.hold(input.signal);
        return page(input);
      };
    }
  }
  private async hold(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.control || this.released) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.barriers.delete(release);
        signal?.removeEventListener("abort", abort);
      };
      const release = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      this.barriers.add(release);
      signal?.addEventListener("abort", abort, { once: true });
      this.control!.ready();
    });
  }
  release(): void {
    this.released = true;
    for (const release of this.barriers) release();
    this.releaseCopyPasses();
  }
  override async startCopyPass(input: Parameters<ProviderPort["startCopyPass"]>[0]) {
    const handle = await super.startCopyPass(input);
    if (this.control) await this.waitForCopyPassPaused(handle.jobid);
    return handle;
  }
  override async copyPassStats(reference: CopyPassReference) {
    const stats = await super.copyPassStats(reference);
    await this.persist();
    if (this.control && !this.copyReady && stats.files === 1) {
      this.copyReady = true;
      this.control.ready();
    }
    return stats;
  }
  override async resolveSourceRoot(input: Parameters<ProviderPort["resolveSourceRoot"]>[0]) {
    // The fixture has one mapping: let its preflight root probe finish before
    // blocking collection, after the durable plan phase_started event.
    if (this.control?.verb === "plan" && ++this.sourceRootReads > 1) await this.hold(input.signal);
    return super.resolveSourceRoot(input);
  }
  override async listFileHashes(input: Parameters<ProviderPort["listFileHashes"]>[0]) {
    if (this.control?.verb === "verify") await this.hold(input.signal);
    return super.listFileHashes(input);
  }
  override async uploadDestinationContent(input: {
    destinationId?: string;
    parentFolderId: string;
    name: string;
    content: Uint8Array | AsyncIterable<Uint8Array>;
    createdAt: string;
    modifiedAt: string;
    mimeType: string | null;
  }): Promise<DestinationEntry> {
    const result = await super.uploadDestinationContent({
      ...input,
      destinationId: input.destinationId ?? randomUUID(),
    });
    await this.persist();
    return result;
  }
  override async createDestinationContainer(
    input: Parameters<ProviderPort["createDestinationContainer"]>[0],
  ) {
    const created = await super.createDestinationContainer(input);
    await this.persist();
    return created;
  }
  override async prepareDestinationMembers(driveId: string) {
    await super.prepareDestinationMembers(driveId);
    await this.persist();
  }
  override async addDriveMember(
    driveId: string,
    member: Parameters<ProviderPort["addDriveMember"]>[1],
  ) {
    await super.addDriveMember(driveId, member);
    await this.persist();
  }
  async persist() {
    const records: FakeDestinationItemFixture[] = [];
    const containers = this.snapshotDestinationContainers();
    const roots = [
      { driveId: this.destinationDriveId, rootId: this.destinationRootId },
      ...containers.map(({ container }) => ({
        driveId: container.id,
        rootId: container.rootFolderId ?? container.id,
      })),
    ];
    for (const root of roots) {
      for (const row of this.snapshotDestination(root.rootId)) {
        const metadata =
          row.parentId === null
            ? await this.resolveDestinationFolder({
                destDriveId: root.driveId,
                destFolderId: row.id,
              })
            : (await this.listDestinationChildren(row.parentId)).find(
                (entry) => entry.id === row.id,
              );
        if (!metadata) throw new Error("Fixture destination disappeared during persistence");
        const chunks: Uint8Array[] = [];
        if (row.kind === "file")
          for await (const bytes of this.streamDestinationContent(row.id)) chunks.push(bytes);
        const content = Buffer.concat(chunks).toString("utf8");
        records.push({
          id: row.id,
          parentId: row.parentId,
          driveId: metadata.driveId,
          ...(metadata.webUrl ? { webUrl: metadata.webUrl } : {}),
          name: row.name,
          kind: row.kind,
          content,
          size: metadata.size,
          mimeType: metadata.mimeType,
          revision: metadata.revision,
          createdAt: metadata.createdAt,
          modifiedAt: metadata.modifiedAt,
          provenance: row.provenance,
          reportedChecksum: metadata.reportedChecksum,
        });
      }
    }
    const containerStaging = `${this.destinationPath}.containers.json.staging`;
    writeFileSync(containerStaging, JSON.stringify(containers), { mode: 0o600 });
    renameSync(containerStaging, `${this.destinationPath}.containers.json`);
    const staging = `${this.destinationPath}.staging`;
    writeFileSync(staging, JSON.stringify(records), { mode: 0o600 });
    const fd = openSync(staging, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staging, this.destinationPath);
  }
}

export class DropboxCliPort extends PersistentCliPort {
  constructor(
    destinationPath: string,
    control?: { verb: string; ready: () => void },
    destinationProvider: "google_shared_drive" | "sharepoint" = "google_shared_drive",
    sharepointMembershipAvailable = false,
  ) {
    const fixture = cliFixture();
    fixture.sourceDriveId = "123456";
    super(destinationPath, control, destinationProvider, sharepointMembershipAvailable, fixture);
  }

  async sourcePlanningEvidence() {
    return {
      evidence: { paperAsFiles: true, selectedAdminId: "dbmid:admin" },
      notices: [],
    };
  }
}
