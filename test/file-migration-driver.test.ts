import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { openEngine, type Engine, type JobRef } from "../src/engine/index.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import type { FileMigrationConfig } from "../src/engine/drivers/file-migration.ts";
import {
  confirmServedContent,
  FileSourceChangedError,
  hashStream,
  type FileProvider,
} from "../src/engine/drivers/file-state.ts";
import { fileConfig, fileFixture, value, approve } from "./engine-fixture.ts";

const now = "2026-09-01T00:00:00.000Z";
const config = fileConfig();

function fixture(): FakeFileMigrationFixture {
  return fileFixture([
    { id: "folder", parentId: "source-root", name: "nested", kind: "folder" },
    { id: "empty", parentId: "folder", name: "empty", kind: "folder" },
    {
      id: "zero",
      parentId: "folder",
      name: "zero.bin",
      kind: "file",
      content: "",
      mimeType: "application/octet-stream",
    },
    {
      id: "binary",
      parentId: "source-root",
      name: "report.docx",
      kind: "file",
      content: new Uint8Array([0, 255, 5, 0]),
      createdAt: "2020-01-01T01:02:03.000Z",
      modifiedAt: "2024-05-06T07:08:09.000Z",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ]);
}

async function harness(
  t: TestContext,
  input: FakeFileMigrationFixture = fixture(),
  selected: FileMigrationConfig = config,
  port: FakeFileMigrationPort = new FakeFileMigrationPort(input),
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "migmate-file-contract-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const engine = openEngine({ home, now: () => new Date(now), provider: port });
  const ref = value(await engine.initJob({ type: "file_migration", config: selected }));
  return { home, engine, ref, port };
}

interface Harness {
  home: string;
  engine: Engine;
  ref: JobRef;
  port: FakeFileMigrationPort;
}

async function execute(h: Harness): Promise<void> {
  value(value(await h.engine.withWriter(h.ref, (writer) => writer.execute())));
}

async function codes(
  h: Harness,
  phase: "plan" | "execute" | "verify",
): Promise<Map<string, string>> {
  const page = value(await h.engine.reader(h.ref).rows({ phase, limit: 1000 }));
  return new Map(
    page.rows
      .filter((item) => item.jobType === "file_migration")
      .map((item) => [item.sourceItemId, item.code]),
  );
}

function hash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("file migration through the engine", () => {
  it("preserves nested empty folders, zero bytes, binary Office content and initial created time across restart and deltas", async (t) => {
    const h = await harness(t);
    const approvedDigest = await approve(h);
    await execute(h);
    const first = h.port.snapshotDestination();
    assert.deepEqual(first.map((item) => item.path).sort(), [
      ".",
      "nested",
      "nested/empty",
      "nested/zero.bin",
      "report.docx",
    ]);
    const original = first.find((item) => item.path === "report.docx")!;
    assert.equal(original.kind, "file");
    assert.equal(original.checksum, hash(new Uint8Array([0, 255, 5, 0])));
    assert.equal(first.find((item) => item.path === "nested/zero.bin")?.checksum, hash(""));
    const copied = await h.port.resolveDestinationFolder({
      destDriveId: "destination-drive",
      destFolderId: original.id,
    });
    assert.equal(copied?.createdAt, "2020-01-01T01:02:03.000Z");
    assert.equal(copied?.modifiedAt, "2024-05-06T07:08:09.000Z");

    h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
    h.port.renameSourceItem("binary", "renamed.docx");
    h.port.mutateSourceItem("binary", {
      content: "new binary content",
      etag: "source-v2",
      modifiedAt: "2025-02-03T04:05:06.000Z",
    });
    h.port.renameSourceItem("folder", "moved-parent");
    await execute(h);
    const second = h.port.snapshotDestination();
    const renamed = second.find((item) => item.path === "renamed.docx")!;
    assert.equal(renamed.id, original.id);
    assert.equal(renamed.checksum, hash("new binary content"));
    assert.equal(renamed.mimeType, original.mimeType);
    assert.equal(
      second.some((item) => item.path === "report.docx"),
      false,
    );
    assert.ok(second.some((item) => item.path === "moved-parent/empty"));
    assert.ok(second.some((item) => item.path === "moved-parent/zero.bin"));
    const updated = await h.port.resolveDestinationFolder({
      destDriveId: "destination-drive",
      destFolderId: original.id,
    });
    assert.equal(updated?.createdAt, copied?.createdAt);
    assert.equal(updated?.modifiedAt, "2025-02-03T04:05:06.000Z");
    const verification = value(
      value(await h.engine.withWriter(h.ref, (writer) => writer.verify())),
    );
    assert.equal(verification.clean, true);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.planDigest, approvedDigest);
  });

  it("retains source-deleted and unrelated destination objects without introducing exceptions", async (t) => {
    const input = fixture();
    input.destinationItems.push({
      id: "operator-owned",
      parentId: "destination-root",
      name: "keep.txt",
      kind: "file",
      content: "external",
    });
    const h = await harness(t, input);
    await approve(h);
    await execute(h);
    const copied = h.port.snapshotDestination().find((item) => item.path === "report.docx")!;
    h.port.deleteSourceItem("binary");
    await execute(h);
    assert.equal(
      h.port.snapshotDestination().find((item) => item.id === copied.id)?.checksum,
      copied.checksum,
    );
    assert.equal(
      h.port.snapshotDestination().find((item) => item.id === "operator-owned")?.checksum,
      hash("external"),
    );
    assert.equal((await codes(h, "execute")).get("binary"), "source_deleted_destination_retained");
    assert.equal(
      (await codes(h, "execute")).get("destination:operator-owned"),
      "destination_only_retained",
    );
    assert.equal(
      value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify()))).clean,
      true,
    );
  });

  it("never adopts a marker-only object, including an exact same-source marker", async (t) => {
    const input = fixture();
    input.destinationItems.push({
      id: "unknown-copy",
      parentId: "destination-root",
      name: "report.docx",
      kind: "file",
      content: "foreign",
      provenance: {
        mappingId: "mapping",
        sourceDriveId: "source-drive",
        sourceItemId: "binary",
        sourceIdentity: "binary",
        sourceKind: "file",
        sourceRelativePath: "report.docx",
        sourceFingerprint: hash("foreign"),
        verifiedFingerprint: hash("foreign"),
        createdAt: now,
        modifiedAt: now,
        mimeType: "application/octet-stream",
      },
    });
    const h = await harness(t, input);
    await h.engine.withWriter(h.ref, (writer) => writer.plan());
    assert.equal((await codes(h, "plan")).get("binary"), "unowned_path_collision");
    assert.equal(
      h.port.snapshotDestination().find((item) => item.id === "unknown-copy")?.checksum,
      hash("foreign"),
    );
  });

  it("reports duplicate names and ordinary-file/folder/shortcut/native-document conflicts without choosing an object", async (t) => {
    const input = fixture();
    input.sourceItems.push(
      {
        id: "duplicate",
        parentId: "source-root",
        name: "duplicate",
        kind: "file",
        content: "source",
      },
      { id: "shortcut", parentId: "source-root", name: "shortcut", kind: "folder" },
      { id: "native", parentId: "source-root", name: "native", kind: "file", content: "binary" },
    );
    input.destinationItems.push(
      {
        id: "duplicate-a",
        parentId: "destination-root",
        name: "duplicate",
        kind: "file",
        content: "a",
      },
      {
        id: "duplicate-b",
        parentId: "destination-root",
        name: "duplicate",
        kind: "file",
        content: "b",
      },
      { id: "wrong-folder", parentId: "destination-root", name: "report.docx", kind: "folder" },
      { id: "wrong-shortcut", parentId: "destination-root", name: "shortcut", kind: "shortcut" },
      { id: "wrong-native", parentId: "destination-root", name: "native", kind: "document" },
    );
    const h = await harness(t, input);
    await h.engine.withWriter(h.ref, (writer) => writer.plan());
    const outcomes = await codes(h, "plan");
    assert.equal(outcomes.get("duplicate"), "destination_duplicate_name");
    assert.equal(outcomes.get("binary"), "destination_type_conflict");
    assert.equal(outcomes.get("shortcut"), "destination_type_conflict");
    assert.equal(outcomes.get("native"), "destination_type_conflict");
  });

  it("refuses drift of its last verified output and reports byte mismatch instead of a degraded comparison", async (t) => {
    const h = await harness(t);
    await approve(h);
    await execute(h);
    const item = h.port.snapshotDestination().find((entry) => entry.path === "report.docx")!;
    const metadata = (await h.port.resolveDestinationFolder({
      destDriveId: "destination-drive",
      destFolderId: item.id,
    }))!;
    await h.port.uploadDestinationContent({
      destinationId: item.id,
      parentFolderId: "destination-root",
      name: item.name,
      content: new Uint8Array([1, 1, 1, 1]),
      createdAt: metadata.createdAt,
      modifiedAt: metadata.modifiedAt,
      mimeType: metadata.mimeType,
    });
    const verification = value(
      value(await h.engine.withWriter(h.ref, (writer) => writer.verify())),
    );
    assert.equal(verification.clean, false);
    assert.ok(verification.findings.some((entry) => entry.code === "content_mismatch"));
    assert.ok(verification.findings.some((entry) => entry.code === "prior_copy_drift"));
    assert.equal(
      verification.findings.some((entry) => entry.code === "content_verification_degraded"),
      false,
    );
    await h.engine.withWriter(h.ref, (writer) => writer.plan());
    assert.equal((await codes(h, "plan")).get("binary"), "prior_copy_drift");
    assert.equal(
      h.port.snapshotDestination().find((entry) => entry.id === item.id)?.checksum,
      hash(new Uint8Array([1, 1, 1, 1])),
    );
  });

  it("blocks a different stable source identity reusing a retained prior path", async (t) => {
    const input = fixture();
    input.sourceItems.push({
      id: "replacement",
      parentId: "source-root",
      name: "report.docx",
      kind: "file",
      content: "replacement",
    });
    const h = await harness(t, input);
    h.port.overrideSourceChildren("source-root", ["binary"]);
    await approve(h);
    await execute(h);
    const original = h.port.snapshotDestination().find((entry) => entry.path === "report.docx")!;
    h.port.deleteSourceItem("binary");
    h.port.overrideSourceChildren("source-root", ["replacement"]);
    await execute(h);
    assert.equal((await codes(h, "execute")).get("replacement"), "source_identity_reuse_collision");
    assert.equal(
      h.port.snapshotDestination().find((entry) => entry.path === "report.docx")?.id,
      original.id,
    );
    assert.equal(
      h.port.snapshotDestination().find((entry) => entry.id === original.id)?.checksum,
      original.checksum,
    );
  });

  it("expands subtree exclusions to exact source identities and never creates their descendants", async (t) => {
    const selected: FileMigrationConfig = {
      mappings: [
        {
          ...config.mappings[0]!,
          exclusions: [{ sourceItemId: "folder", reason: "Outside approved migration scope" }],
        },
      ],
    };
    const h = await harness(t, fixture(), selected);
    await approve(h);
    const planned = await codes(h, "plan");
    assert.equal(planned.get("folder"), "omitted_by_rule");
    assert.equal(planned.get("empty"), "omitted_by_rule");
    assert.equal(planned.get("zero"), "omitted_by_rule");
    await execute(h);
    assert.deepEqual(
      h.port
        .snapshotDestination()
        .map((entry) => entry.path)
        .sort(),
      [".", "report.docx"],
    );
    assert.equal((await codes(h, "verify")).get("zero"), "omitted_by_rule");
  });

  it("requires a new plan when an excluded subtree gains a new stable member", async (t) => {
    const input = fixture();
    input.sourceItems.push({
      id: "later",
      parentId: "folder",
      name: "later.bin",
      kind: "file",
      content: "later",
    });
    const selected: FileMigrationConfig = {
      mappings: [
        {
          ...config.mappings[0]!,
          exclusions: [{ sourceItemId: "folder", reason: "Explicitly excluded" }],
        },
      ],
    };
    const h = await harness(t, input, selected);
    h.port.overrideSourceChildren("folder", ["empty", "zero"]);
    await approve(h);
    await execute(h);
    value(
      await h.engine.withWriter(h.ref, async (writer) => {
        const verified = value(await writer.verify());
        value(
          await writer.accept({
            verificationDigest: verified.verificationDigest,
            codes: verified.findings.map((entry) => ({ code: entry.code })),
            approver: "file-contract-test",
          }),
        );
      }),
    );
    h.port.overrideSourceChildren("folder", ["empty", "zero", "later"]);
    const refused = value(await h.engine.withWriter(h.ref, (writer) => writer.execute()));
    assert.equal(refused.ok, false);
    if (refused.ok) throw new Error("Expanded exclusions were silently admitted");
    assert.equal(refused.refusal.code, "plan_revision_required");
    assert.equal(
      h.port.snapshotDestination().some((entry) => entry.path.includes("later")),
      false,
    );
  });

  it("does not move an owned source over another object's destination path", async (t) => {
    const h = await harness(t);
    await approve(h);
    await execute(h);
    const original = h.port.snapshotDestination().find((entry) => entry.path === "report.docx")!;
    await h.port.uploadDestinationContent({
      parentFolderId: "destination-root",
      name: "occupied.docx",
      content: new TextEncoder().encode("external"),
      createdAt: now,
      modifiedAt: now,
      mimeType: "application/octet-stream",
    });
    h.port.renameSourceItem("binary", "occupied.docx");
    await h.engine.withWriter(h.ref, (writer) => writer.plan());
    assert.equal((await codes(h, "plan")).get("binary"), "unowned_path_collision");
    assert.equal(
      h.port.snapshotDestination().find((entry) => entry.id === original.id)?.path,
      "report.docx",
    );
    assert.equal(
      h.port.snapshotDestination().find((entry) => entry.path === "occupied.docx")?.checksum,
      hash("external"),
    );
  });

  it("blocks nested mappings and unrepresentable ancestor paths before descendant writes", async (t) => {
    const input = fixture();
    input.destinationItems.push({
      id: "other-root",
      parentId: null,
      name: "other",
      kind: "folder",
    });
    const selected: FileMigrationConfig = {
      mappings: [
        config.mappings[0]!,
        {
          ...config.mappings[0]!,
          id: "nested-mapping",
          sourceItemId: "folder",
          destFolderId: "other-root",
        },
      ],
    };
    const h = await harness(t, input, selected);
    await h.engine.withWriter(h.ref, (writer) => writer.plan());
    const overlap = value(
      await h.engine.reader(h.ref).rows({ phase: "plan", codes: ["mapping_overlap"] }),
    );
    assert.equal(overlap.totalRows, 2);
    const other = await harness(t);
    other.port.renameSourceItem("folder", "bad/name");
    await other.engine.withWriter(other.ref, (writer) => writer.plan());
    const planned = await codes(other, "plan");
    assert.equal(planned.get("folder"), "path_unrepresentable");
    assert.equal(planned.get("zero"), "path_unrepresentable");
    assert.equal(planned.get("empty"), "path_unrepresentable");
  });

  it("streams a withheld destination SHA-256 and requires an exception when byte proof is unavailable", async (t) => {
    class UnavailableStreamPort extends FakeFileMigrationPort {
      unavailable = false;
      override streamDestinationContent(objectId: string): AsyncIterable<Uint8Array> {
        if (this.unavailable)
          throw Object.assign(new Error("Destination read denied"), { status: 403 });
        return super.streamDestinationContent(objectId);
      }
    }
    const port = new UnavailableStreamPort(fixture());
    const h = await harness(t, fixture(), config, port);
    await approve(h);
    await execute(h);
    const item = port.snapshotDestination().find((entry) => entry.path === "report.docx")!;
    port.withholdDestinationChecksum(item.id);
    assert.equal(
      value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify()))).clean,
      true,
    );
    port.unavailable = true;
    const degraded = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.equal(degraded.clean, false);
    assert.ok(degraded.findings.some((entry) => entry.code === "content_verification_degraded"));
    const closed = value(await h.engine.withWriter(h.ref, (writer) => writer.close()));
    assert.equal(closed.ok, false);
    if (closed.ok) throw new Error("A size-only verification closed cleanly");
    assert.equal(closed.refusal.code, "verification_unaccepted");
  });

  it("copies what the source serves when its listed size disagrees, and names that for acceptance", async (t) => {
    // SharePoint can list a size its download contradicts (rewritten Office files,
    // iOS Live Photos). The served bytes are what exists, so they are copied.
    const input = fileFixture([
      {
        id: "still",
        parentId: "source-root",
        name: "photo.heic",
        kind: "file",
        content: "still frame",
        size: 999,
        mimeType: "image/heic",
      },
    ]);
    const h = await harness(t, input);
    await approve(h);
    await execute(h);
    const copied = h.port.snapshotDestination().find((entry) => entry.path === "photo.heic");
    assert.equal(copied?.checksum, hash("still frame"));

    const first = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    const found = first.findings.map((entry) => entry.code);
    assert.ok(found.includes("source_size_inconsistent"));
    assert.equal(found.includes("size_mismatch"), false);
    assert.equal(found.includes("content_mismatch"), false);
    const [named] = value(
      await h.engine.reader(h.ref).rows({ phase: "verify", codes: ["source_size_inconsistent"] }),
    ).rows;
    assert.equal(named?.jobType === "file_migration" && named.provenanceState, "verified");
    const accept = async (verificationDigest: string) =>
      value(
        value(
          await h.engine.withWriter(h.ref, (writer) =>
            writer.accept({
              verificationDigest,
              approver: "operator",
              codes: [{ code: "source_size_inconsistent" }],
            }),
          ),
        ),
      );
    await accept(first.verificationDigest);

    // The served size is the copy's size, so a rerun finds nothing to re-upload.
    await execute(h);
    assert.equal((await codes(h, "execute")).get("still"), "unchanged");
    assert.equal(
      h.port.snapshotDestination().find((entry) => entry.path === "photo.heic")?.id,
      copied?.id,
    );

    await accept(
      value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())))
        .verificationDigest,
    );
    value(value(await h.engine.withWriter(h.ref, (writer) => writer.close())));
    const report = value(value(await h.engine.withWriter(h.ref, (writer) => writer.report())));
    const json = report.artifacts.find((artifact) => artifact.name === "report.json");
    assert.ok(json);
    const [exception] = JSON.parse(await readFile(json.path, "utf8")).acceptedExceptions;
    assert.equal(exception.code, "source_size_inconsistent");
    assert.deepEqual(exception.items[0].evidence, {
      path: "photo.heic",
      listedSize: 999,
      servedSize: 11,
    });
  });

  it("refuses served bytes that change between reads instead of copying a truncated download", async () => {
    class ShiftingPort extends FakeFileMigrationPort {
      reads = 0;
      override openSourceContent(sourceItemId: string): AsyncIterable<Uint8Array> {
        const bytes = new TextEncoder().encode(`frame ${++this.reads}`);
        return (async function* () {
          yield bytes;
        })();
      }
    }
    const port = new ShiftingPort(
      fileFixture([
        { id: "still", parentId: "source-root", name: "photo.heic", kind: "file", size: 999 },
      ]),
    );
    const provider: FileProvider = port;
    const source = await port.readSourceItem({ driveId: "source-drive", itemId: "still" });
    assert.ok(source);
    const served = await hashStream(provider.openSourceContent("still"));
    await assert.rejects(confirmServedContent(provider, source, served), FileSourceChangedError);
  });

  it("reconciles a lost upload response by its durably reserved identity across engine restart", async (t) => {
    class LostResponsePort extends FakeFileMigrationPort {
      lost = false;
      override async uploadDestinationContent(
        input: Parameters<FileProvider["uploadDestinationContent"]>[0],
      ) {
        const uploaded = await super.uploadDestinationContent(input);
        if (input.marker)
          await super.writeDestinationMarker({ objectId: uploaded.id, marker: input.marker });
        if (!this.lost) {
          this.lost = true;
          throw Object.assign(new Error("Simulated lost successful response"), {
            name: "AbortError",
          });
        }
        return uploaded;
      }
    }
    const input = fixture();
    input.sourceItems = input.sourceItems.filter(
      (entry) => entry.id === "source-root" || entry.id === "binary",
    );
    const port = new LostResponsePort(input);
    Object.assign(port, { reserveDestinationId: async () => "reserved-file" });
    const h = await harness(t, input, config, port);
    await approve(h);
    const interrupted = value(
      value(await h.engine.withWriter(h.ref, (writer) => writer.execute())),
    );
    assert.equal(interrupted.outcome, "interrupted");
    h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: port });
    await execute(h);
    const copies = port.snapshotDestination().filter((entry) => entry.path === "report.docx");
    assert.equal(copies.length, 1);
    assert.equal(copies[0]?.id, "reserved-file");
    assert.equal(copies[0]?.checksum, hash(new Uint8Array([0, 255, 5, 0])));
    assert.equal(
      value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify()))).clean,
      true,
    );
  });

  it("records terminal source and destination failures without abandoning healthy sibling items", async (t) => {
    class DeniedItemsPort extends FakeFileMigrationPort {
      override openSourceContent(sourceItemId: string): AsyncIterable<Uint8Array> {
        if (sourceItemId === "binary")
          throw Object.assign(new Error("Source denied"), { status: 403, transient: false });
        return super.openSourceContent(sourceItemId);
      }
      override async uploadDestinationContent(
        input: Parameters<FileProvider["uploadDestinationContent"]>[0],
      ) {
        if (input.name === "zero.bin")
          throw Object.assign(new Error("Destination denied"), { status: 403, transient: false });
        return super.uploadDestinationContent(input);
      }
    }
    const input = fixture();
    input.sourceItems.push({
      id: "healthy",
      parentId: "source-root",
      name: "healthy.bin",
      kind: "file",
      content: "preserved",
    });
    const port = new DeniedItemsPort(input);
    const h = await harness(t, input, config, port);
    await approve(h);
    await execute(h);
    const outcomes = await codes(h, "execute");
    assert.equal(outcomes.get("binary"), "source_read_failed");
    assert.equal(outcomes.get("zero"), "destination_write_failed");
    assert.equal(
      port.snapshotDestination().find((entry) => entry.path === "healthy.bin")?.checksum,
      hash("preserved"),
    );
    assert.equal(
      port.snapshotDestination().some((entry) => entry.path === "report.docx"),
      false,
    );
    assert.equal(
      port.snapshotDestination().some((entry) => entry.path === "nested/zero.bin"),
      false,
    );
  });

  it("requeues a source that changes during streaming instead of accepting its old bytes", async (t) => {
    const input = fixture();
    input.sourceMutations = [
      {
        sourceItemId: "binary",
        nextContent: "new source version",
        nextEtag: "changed-during-read",
      },
    ];
    const h = await harness(t, input);
    await approve(h);
    await execute(h);
    assert.equal(
      h.port.snapshotDestination().find((entry) => entry.path === "report.docx")?.checksum,
      hash("new source version"),
    );
    assert.equal(
      value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify()))).clean,
      true,
    );
  });
});
