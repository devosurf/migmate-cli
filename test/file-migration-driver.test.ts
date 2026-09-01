import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  fileMigrationDriver,
  type FileMigrationConfig,
} from "../src/engine/drivers/file-migration.ts";
import type { CommitUnit, DriverContext, FileCommitRow } from "../src/engine/drivers/types.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";

const fixedNow = "2026-09-01T00:00:00.000Z";

function bytes(value: string | number[]): Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }

  return new Uint8Array(value);
}

function sha256(value: string | Uint8Array): string {
  const input = value instanceof Uint8Array ? value : bytes(value);
  return createHash("sha256").update(input).digest("hex");
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }

  return items;
}

function rowIndex(units: CommitUnit[]): Map<string, FileCommitRow> {
  const rows = new Map<string, FileCommitRow>();
  for (const unit of units) {
    for (const row of unit.rows) {
      // A file migration driver yields file rows only; anything else is a defect.
      if (row.jobType !== "file_migration") continue;
      rows.set(row.sourceItemId, row);
    }
  }

  return rows;
}

function makeFixture(): { port: FakeFileMigrationPort; config: FileMigrationConfig } {
  const sourceItems: FakeFileMigrationFixture["sourceItems"] = [
    { id: "src-root", parentId: null, name: "root", kind: "folder", identity: "src-root" },
    {
      id: "zero",
      parentId: "src-root",
      name: "zero.txt",
      kind: "file",
      size: 0,
      mimeType: "application/octet-stream",
      content: "",
      identity: "zero",
    },
    {
      id: "binary",
      parentId: "src-root",
      name: "binary.bin",
      kind: "file",
      size: 4,
      mimeType: "application/octet-stream",
      content: bytes([1, 2, 3, 4]),
      identity: "binary",
    },
    {
      id: "office",
      parentId: "src-root",
      name: "doc.docx",
      kind: "file",
      size: 4,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content: "docx",
      identity: "office",
    },
    {
      id: "empty-folder",
      parentId: "src-root",
      name: "empty-folder",
      kind: "folder",
      identity: "empty-folder",
    },
    {
      id: "changed",
      parentId: "src-root",
      name: "changed.txt",
      kind: "file",
      size: 11,
      mimeType: "text/plain",
      content: "old content",
      identity: "changed",
    },
    {
      id: "rename",
      parentId: "src-root",
      name: "rename.txt",
      kind: "file",
      size: 14,
      mimeType: "text/plain",
      content: "rename content",
      identity: "rename",
    },
    {
      id: "deleted",
      parentId: "src-root",
      name: "deleted.txt",
      kind: "file",
      size: 15,
      mimeType: "text/plain",
      content: "deleted content",
      identity: "deleted",
    },
    {
      id: "package",
      parentId: "src-root",
      name: "pkg.onepkg",
      kind: "package",
      downloadable: false,
      identity: "package",
    },
    {
      id: "reference",
      parentId: "src-root",
      name: "shortcut.url",
      kind: "reference",
      downloadable: false,
      identity: "reference",
    },
    {
      id: "undownloadable",
      parentId: "src-root",
      name: "blocked.bin",
      kind: "undownloadable",
      downloadable: false,
      identity: "undownloadable",
    },
    {
      id: "duplicate",
      parentId: "src-root",
      name: "duplicate.txt",
      kind: "file",
      size: 3,
      mimeType: "text/plain",
      content: "dup",
      identity: "duplicate",
    },
    {
      id: "type-conflict",
      parentId: "src-root",
      name: "type-conflict.txt",
      kind: "file",
      size: 4,
      mimeType: "text/plain",
      content: "type",
      identity: "type-conflict",
    },
    {
      id: "unowned",
      parentId: "src-root",
      name: "unowned.txt",
      kind: "file",
      size: 7,
      mimeType: "text/plain",
      content: "unowned",
      identity: "unowned",
    },
    {
      id: "drift",
      parentId: "src-root",
      name: "drift.txt",
      kind: "file",
      size: 12,
      mimeType: "text/plain",
      content: "drift-source",
      identity: "drift",
    },
    {
      id: "identity",
      parentId: "src-root",
      name: "identity.txt",
      kind: "file",
      size: 16,
      mimeType: "text/plain",
      content: "identity content",
      identity: "identity-v1",
    },
  ];

  const sourceItemsById = new Map(sourceItems.map((item) => [item.id, item] as const));
  const driftSource = sourceItemsById.get("drift");
  const identitySource = sourceItemsById.get("identity");
  assert.ok(driftSource);
  assert.ok(identitySource);

  const destinationItems: FakeFileMigrationFixture["destinationItems"] = [
    { id: "dest-root", parentId: null, name: "dest", kind: "folder", identity: "dest-root" },
    {
      id: "dup-a",
      parentId: "dest-root",
      name: "duplicate.txt",
      kind: "file",
      content: "A",
      reportedChecksum: null,
      provenance: null,
    },
    {
      id: "dup-b",
      parentId: "dest-root",
      name: "duplicate.txt",
      kind: "file",
      content: "B",
      reportedChecksum: null,
      provenance: null,
    },
    {
      id: "type-folder",
      parentId: "dest-root",
      name: "type-conflict.txt",
      kind: "folder",
      provenance: null,
    },
    {
      id: "unowned-dest",
      parentId: "dest-root",
      name: "unowned.txt",
      kind: "file",
      content: "foreign",
      provenance: null,
    },
    {
      id: "drift-dest",
      parentId: "dest-root",
      name: "drift.txt",
      kind: "file",
      content: "corrupt",
      provenance: {
        mappingId: "mapping1",
        sourceDriveId: "source-drive",
        sourceItemId: "drift",
        sourceIdentity: "drift",
        sourceKind: "file",
        sourceRelativePath: "drift.txt",
        sourceFingerprint: sha256("drift-original"),
        verifiedFingerprint: sha256("drift-original"),
        createdAt: fixedNow,
        modifiedAt: fixedNow,
        mimeType: "text/plain",
      },
    },
    {
      id: "identity-dest",
      parentId: "dest-root",
      name: "identity.txt",
      kind: "file",
      content: "identity content",
      provenance: {
        mappingId: "mapping1",
        sourceDriveId: "source-drive",
        sourceItemId: "identity",
        sourceIdentity: "identity-v1",
        sourceKind: "file",
        sourceRelativePath: "identity.txt",
        sourceFingerprint: sha256("identity content"),
        verifiedFingerprint: sha256("identity content"),
        createdAt: fixedNow,
        modifiedAt: fixedNow,
        mimeType: "text/plain",
      },
    },
  ];

  const port = new FakeFileMigrationPort({
    sourceDriveId: "source-drive",
    sourceRootId: "src-root",
    destinationDriveId: "dest-drive",
    destinationRootId: "dest-root",
    sourceItems,
    destinationItems,
    worker: { pid: 777, version: "worker-9.9.9", alive: true },
  });

  const config: FileMigrationConfig = {
    mappings: [
      {
        id: "mapping1",
        sourceDriveId: "source-drive",
        sourceItemId: "src-root",
        destDriveId: "dest-drive",
        destFolderId: "dest-root",
        exclusions: [],
      },
    ],
  };

  return { port, config };
}

function makeContext(
  port: FakeFileMigrationPort,
  config: FileMigrationConfig,
  revision = 1,
): DriverContext<FileMigrationConfig> {
  return {
    config,
    revision,
    resume: { checkpoint: null, watermarks: {} },
    provider: port,
    now: () => new Date(fixedNow),
  };
}

describe("file migration driver", () => {
  it("collects typed omissions and executes the first pass", async () => {
    const { port, config } = makeFixture();
    const ctx = makeContext(port, config);

    const collected = await collect(fileMigrationDriver.collect(ctx));
    const collectedRows = rowIndex(collected);

    assert.equal(collectedRows.get("src-root")?.code, "unchanged");
    assert.equal(collectedRows.get("zero")?.code, "created");
    assert.equal(collectedRows.get("binary")?.code, "created");
    assert.equal(collectedRows.get("office")?.code, "created");
    assert.equal(collectedRows.get("empty-folder")?.code, "created");
    assert.equal(collectedRows.get("package")?.code, "source_package_omitted");
    assert.equal(collectedRows.get("reference")?.code, "source_reference_omitted");
    assert.equal(collectedRows.get("undownloadable")?.code, "source_content_unavailable");
    assert.equal(collectedRows.get("duplicate")?.code, "destination_duplicate_name");
    assert.equal(collectedRows.get("type-conflict")?.code, "destination_type_conflict");
    assert.equal(collectedRows.get("unowned")?.code, "unowned_path_collision");
    assert.equal(collectedRows.get("drift")?.code, "prior_copy_drift");
    assert.equal(collectedRows.get("identity")?.code, "unchanged");

    assert.ok(
      collected.some((unit) =>
        unit.findings.some((finding) => finding.code === "destination_duplicate_name"),
      ),
    );
    assert.ok(
      collected.some((unit) =>
        unit.findings.some((finding) => finding.code === "prior_copy_drift"),
      ),
    );

    const executed = await collect(fileMigrationDriver.execute(ctx));
    const executedRows = rowIndex(executed);
    const snapshot = Object.fromEntries(
      port.snapshotDestination().map((entry) => [entry.path, entry] as const),
    );

    assert.equal(executedRows.get("zero")?.code, "created");
    assert.equal(executedRows.get("binary")?.code, "created");
    assert.equal(executedRows.get("office")?.code, "created");
    assert.equal(executedRows.get("empty-folder")?.code, "created");
    assert.equal(executedRows.get("package")?.code, "source_package_omitted");
    assert.equal(executedRows.get("reference")?.code, "source_reference_omitted");
    assert.equal(executedRows.get("undownloadable")?.code, "source_content_unavailable");
    assert.equal(executedRows.get("duplicate")?.code, "destination_duplicate_name");
    assert.equal(executedRows.get("type-conflict")?.code, "destination_type_conflict");
    assert.equal(executedRows.get("unowned")?.code, "unowned_path_collision");
    assert.equal(executedRows.get("drift")?.code, "prior_copy_drift");
    assert.equal(executedRows.get("identity")?.code, "unchanged");

    assert.ok(snapshot["zero.txt"]);
    assert.ok(snapshot["binary.bin"]);
    assert.ok(snapshot["doc.docx"]);
    assert.ok(snapshot["empty-folder"]);
    assert.equal(snapshot["zero.txt"]?.kind, "file");
    assert.equal(snapshot["binary.bin"]?.kind, "file");
    assert.equal(snapshot["doc.docx"]?.kind, "file");
    assert.equal(
      snapshot["doc.docx"]?.mimeType,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.equal(snapshot["zero.txt"]?.checksum, sha256(""));
    assert.equal(snapshot["binary.bin"]?.checksum, sha256(bytes([1, 2, 3, 4])));
    assert.equal(snapshot["doc.docx"]?.checksum, sha256("docx"));
  });

  it("updates changed content, moves renamed sources, and retains deleted destinations", async () => {
    const { port, config } = makeFixture();
    const ctx = makeContext(port, config);

    await collect(fileMigrationDriver.execute(ctx));

    port.mutateSourceItem("changed", { content: "changed v2" });
    port.renameSourceItem("rename", "renamed.txt");
    port.deleteSourceItem("deleted");
    port.mutateSourceItem("identity", { identity: "identity-v2" });

    const executed = await collect(fileMigrationDriver.execute(ctx));
    const rows = rowIndex(executed);
    const snapshot = Object.fromEntries(
      port.snapshotDestination().map((entry) => [entry.path, entry] as const),
    );

    assert.equal(rows.get("changed")?.code, "updated");
    assert.equal(rows.get("rename")?.code, "moved");
    assert.equal(rows.get("deleted")?.code, "source_deleted_destination_retained");
    assert.equal(rows.get("identity")?.code, "source_identity_reuse_collision");
    assert.equal(rows.get("zero")?.code, "unchanged");
    assert.equal(rows.get("binary")?.code, "unchanged");
    assert.equal(rows.get("office")?.code, "unchanged");

    assert.ok(snapshot["renamed.txt"]);
    assert.equal(snapshot["rename.txt"], undefined);
    assert.ok(snapshot["deleted.txt"]);
    assert.equal(snapshot["changed.txt"]?.checksum, sha256("changed v2"));
    assert.equal(snapshot["renamed.txt"]?.checksum, sha256("rename content"));
    assert.equal(snapshot["deleted.txt"]?.checksum, sha256("deleted content"));
  });

  it("verifies content through a withheld checksum and degrades when no proof is possible", async () => {
    const { port, config } = makeFixture();
    const ctx = makeContext(port, config);

    await collect(fileMigrationDriver.execute(ctx));

    const office = port.snapshotDestination().find((entry) => entry.path === "doc.docx");
    assert.ok(office);

    port.withholdDestinationChecksum(office.id);
    const verified = await collect(fileMigrationDriver.verify(ctx));
    const verifiedRows = rowIndex(verified);
    const officeVerify = verifiedRows.get("office");
    assert.equal(officeVerify?.code, "unchanged");
    const officeUnit = verified.find((unit) =>
      unit.rows.some((row) => row.jobType === "file_migration" && row.sourceItemId === "office"),
    );
    assert.equal(officeUnit?.findings.length ?? 0, 0);

    port.blockDestinationStream(office.id);
    const degraded = await collect(fileMigrationDriver.verify(ctx));
    const degradedRows = rowIndex(degraded);
    assert.equal(degradedRows.get("office")?.code, "content_verification_degraded");
  });

  it("replays an interrupted unit without duplicating the destination write", async () => {
    const sourceItems: FakeFileMigrationFixture["sourceItems"] = [
      { id: "src-root", parentId: null, name: "root", kind: "folder", identity: "src-root" },
      {
        id: "solo",
        parentId: "src-root",
        name: "solo.txt",
        kind: "file",
        size: 4,
        mimeType: "text/plain",
        content: "solo",
        identity: "solo",
      },
    ];

    const port = new FakeFileMigrationPort({
      sourceDriveId: "source-drive",
      sourceRootId: "src-root",
      destinationDriveId: "dest-drive",
      destinationRootId: "dest-root",
      sourceItems,
      destinationItems: [
        { id: "dest-root", parentId: null, name: "dest", kind: "folder", identity: "dest-root" },
      ],
    });

    const config: FileMigrationConfig = {
      mappings: [
        {
          id: "mapping1",
          sourceDriveId: "source-drive",
          sourceItemId: "src-root",
          destDriveId: "dest-drive",
          destFolderId: "dest-root",
        },
      ],
    };

    const ctx = makeContext(port, config);
    port.interruptAfterMarkerOnce("file-1");

    await assert.rejects(async () => {
      for await (const _unit of fileMigrationDriver.execute(ctx)) {
        void _unit;
      }
    }, /interrupted after marker/);

    const replay = await collect(fileMigrationDriver.execute(ctx));
    const rows = rowIndex(replay);
    const snapshot = Object.fromEntries(
      port.snapshotDestination().map((entry) => [entry.path, entry] as const),
    );

    assert.equal(rows.get("solo")?.code, "unchanged");
    assert.ok(snapshot["solo.txt"]);
    assert.equal(port.snapshotDestination().filter((entry) => entry.path === "solo.txt").length, 1);
  });
});
