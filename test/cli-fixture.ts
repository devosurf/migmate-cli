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
import { setTimeout as delay } from "node:timers/promises";
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
      { id: "dst-root", parentId: null, name: "root", kind: "folder", identity: "dst-root" },
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
  readonly delayMs: number;
  constructor(destinationPath: string, delayMs: number) {
    const fixture = cliFixture();
    fixture.archive = cliArchiveFixture();
    if (delayMs) fixture.copyPasses = [{ pause: true, afterFiles: 1 }];
    if (existsSync(destinationPath))
      fixture.destinationItems = JSON.parse(readFileSync(destinationPath, "utf8"));
    super(fixture);
    this.destinationPath = destinationPath;
    this.delayMs = delayMs;
    if (this.archive && delayMs) {
      const page = this.archive.page.bind(this.archive);
      // Real subprocess signal tests need an in-flight external read. Their
      // synchronization is the durable event, not a sleep in the test driver.
      this.archive.page = async (input) => {
        await delay(delayMs);
        return page(input);
      };
    }
  }
  override async startCopyPass(input: Parameters<ProviderPort["startCopyPass"]>[0]) {
    const handle = await super.startCopyPass(input);
    if (this.delayMs) {
      const timer = setTimeout(() => this.releaseCopyPasses(), this.delayMs * 8);
      timer.unref();
    }
    return handle;
  }
  override async copyPassStats(reference: CopyPassReference) {
    const stats = await super.copyPassStats(reference);
    await this.persist();
    return stats;
  }
  override async *openSourceContent(sourceItemId: string) {
    // Cross-process SIGINT/SIGKILL cannot be driven by an in-process fake clock.
    if (this.delayMs) await delay(this.delayMs);
    yield* super.openSourceContent(sourceItemId);
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
  async persist() {
    const records: FakeDestinationItemFixture[] = [];
    for (const row of this.snapshotDestination()) {
      const metadata =
        row.parentId === null
          ? await this.resolveDestinationFolder({
              destDriveId: this.destinationDriveId,
              destFolderId: row.id,
            })
          : (await this.listDestinationChildren(row.parentId)).find((entry) => entry.id === row.id);
      if (!metadata) throw new Error("Fixture destination disappeared during persistence");
      const chunks: Uint8Array[] = [];
      if (row.kind === "file")
        for await (const bytes of this.streamDestinationContent(row.id)) chunks.push(bytes);
      const content = Buffer.concat(chunks).toString("utf8");
      records.push({
        id: row.id,
        parentId: row.parentId,
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
