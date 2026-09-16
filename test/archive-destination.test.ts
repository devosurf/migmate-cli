import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort, type FakeEffectRule } from "../src/engine/providers/fake.ts";
import type { PackageManifest } from "../src/engine/archive/package.ts";

const now = () => new Date("2026-09-01T00:00:00.000Z");
const config = {
  scopes: [{ kind: "user-chats", userId: "a" }],
  window: { from: "2026-01-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  destination: { destDriveId: "destination", destFolderId: "archive-root" },
};
function provider(effects: FakeEffectRule[] = []) {
  return new FakeFileMigrationPort({
    sourceDriveId: "unused",
    sourceRootId: "unused",
    sourceItems: [],
    destinationDriveId: "destination",
    destinationRootId: "archive-root",
    destinationItems: [{ id: "archive-root", parentId: null, name: "Archive", kind: "folder" }],
    reservedDestinationIds: ["index-html", "index-csv", "manifest", "conversation"],
    effects,
    archive: {
      scopes: [{ id: "user:a", kind: "user-chats", userId: "a", conversationIds: ["chat"] }],
      conversations: [
        {
          id: "chat",
          kind: "chat",
          title: "Preserved conversation",
          scopeEntryId: "user:a",
          participantScopeIds: ["user:a"],
          ownerUserId: "a",
          raw: { id: "chat", chatType: "group" },
        },
      ],
      pages: [
        {
          scopeId: "user:a",
          route: "messages",
          cursor: null,
          page: {
            records: [
              {
                id: "message",
                chatId: "chat",
                createdDateTime: "2026-08-01T00:00:00Z",
                lastModifiedDateTime: "2026-08-01T00:00:00Z",
                from: { user: { id: "a", displayName: "Original identity" } },
                body: { contentType: "html", content: "<p>Preserved message</p>" },
                attachments: [],
                mentions: [],
              },
            ],
            nextLink: null,
          },
        },
      ],
    },
  });
}
async function approved(home: string, port: FakeFileMigrationPort) {
  const engine = openEngine({ home, now, provider: port });
  const initialized = await engine.initJob({ type: "teams_archive", config });
  assert.ok(initialized.ok);
  const ref = initialized.value;
  const approval = await engine.withWriterResult(ref, async (writer) => {
    const planned = await writer.plan();
    assert.ok(planned.ok);
    return writer.approve({
      planDigest: planned.value.planDigest,
      approver: "test",
      mode: "unattended",
    });
  });
  assert.ok(approval.ok);
  return { engine, ref };
}
async function bytes(content: AsyncIterable<Uint8Array>) {
  const chunks = [];
  for await (const chunk of content) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("archive destination retains three root objects and one byte-verified container per conversation", async () => {
  const home = await mkdtemp(join(tmpdir(), "migmate-archive-destination-"));
  const port = provider();
  const { engine, ref } = await approved(home, port);
  try {
    const result = await engine.withWriterResult(ref, (writer) => writer.execute());
    assert.ok(result.ok);
    assert.equal(result.value.outcome, "completed");
    const root = join(home, "jobs", ref.id, "archive");
    const manifest: PackageManifest = JSON.parse(
      await readFile(join(root, "manifest.json"), "utf8"),
    );
    const entries = await port.listDestinationChildren("archive-root");
    assert.deepEqual(
      entries.map((entry) => entry.name).sort(),
      [
        "index.html",
        "index.csv",
        "manifest.json",
        `${manifest.conversations[0]!.path.split("/").at(-1)}.zip`,
      ].sort(),
    );
    for (const entry of entries) {
      const downloaded = await bytes(port.streamDestinationContent(entry.id));
      if (!entry.name.endsWith(".zip"))
        assert.deepEqual(downloaded, await readFile(join(root, entry.name)));
      else assert.equal(downloaded.subarray(0, 4).toString("hex"), "504b0304");
      assert.equal(
        (await port.readDestinationMarker(entry.id))?.verifiedFingerprint,
        createHash("sha256").update(downloaded).digest("hex"),
      );
    }
    const verification = await engine.withWriterResult(ref, (writer) => writer.verify());
    assert.ok(verification.ok);
    assert.deepEqual(
      verification.value.findings.filter((f) => f.kind === "finding"),
      [],
    );
  } finally {
    engine.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a lost archive upload response resumes after reopening without replacing or duplicating copies", async () => {
  const home = await mkdtemp(join(tmpdir(), "migmate-archive-replay-"));
  const port = provider();
  port.interruptAfterUploadOnce("index-csv");
  const { engine, ref } = await approved(home, port);
  let reopened;
  try {
    const first = await engine.withWriterResult(ref, (writer) => writer.execute());
    assert.ok(first.ok);
    assert.equal(first.value.outcome, "interrupted");
    const before = await port.listDestinationChildren("archive-root");
    assert.deepEqual(before.map((entry) => entry.id).sort(), ["index-csv", "index-html"]);
    engine.close();
    reopened = openEngine({ home, now, provider: port });
    const resumed = await reopened.withWriterResult(ref, (writer) => writer.execute());
    assert.ok(resumed.ok);
    assert.equal(resumed.value.outcome, "completed");
    const after = await port.listDestinationChildren("archive-root");
    assert.deepEqual(after.map((entry) => entry.id).sort(), [
      "conversation",
      "index-csv",
      "index-html",
      "manifest",
    ]);
    for (const entry of before)
      assert.deepEqual(
        after.find((candidate) => candidate.id === entry.id),
        entry,
      );
    const verification = await reopened.withWriterResult(ref, (writer) => writer.verify());
    assert.ok(verification.ok);
    assert.deepEqual(
      verification.value.findings.filter((f) => f.kind === "finding"),
      [],
    );
  } finally {
    engine.close();
    reopened?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a local archive that fails self-verification sends no package objects to Drive", async () => {
  const home = await mkdtemp(join(tmpdir(), "migmate-archive-unverified-"));
  const port = provider();
  const { engine, ref } = await approved(home, port);
  try {
    port.archive!.failPageOnce(
      { scopeId: "user:a", route: "messages", cursor: null },
      Object.assign(new Error("Source access revoked"), { status: 403 }),
    );
    const result = await engine.withWriterResult(ref, (writer) => writer.execute());
    assert.ok(result.ok);
    const manifest: PackageManifest = JSON.parse(
      await readFile(join(home, "jobs", ref.id, "archive", "manifest.json"), "utf8"),
    );
    assert.equal(manifest.conversations[0]!.recordCount, 0);
    const gaps = await engine
      .reader(ref)
      .rows({ phase: "verify", codes: ["message_collection_incomplete"] });
    assert.ok(gaps.ok);
    assert.ok(gaps.value.totalRows > 0);
    assert.deepEqual(await port.listDestinationChildren("archive-root"), []);
  } finally {
    engine.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("an unproven same-name destination object is retained, not adopted or overwritten", async () => {
  const home = await mkdtemp(join(tmpdir(), "migmate-archive-collision-"));
  const port = provider();
  const original = await port.uploadDestinationContent({
    destinationId: "operator-copy",
    create: true,
    parentFolderId: "archive-root",
    name: "index.csv",
    content: Buffer.from("operator-owned content"),
    createdAt: now().toISOString(),
    modifiedAt: now().toISOString(),
    mimeType: "text/csv",
  });
  const { engine, ref } = await approved(home, port);
  try {
    const result = await engine.withWriterResult(ref, (writer) => writer.execute());
    assert.ok(result.ok);
    const copies = (await port.listDestinationChildren("archive-root")).filter(
      (entry) => entry.name === "index.csv",
    );
    assert.deepEqual(copies, [original]);
    assert.equal(
      (await bytes(port.streamDestinationContent(original.id))).toString(),
      "operator-owned content",
    );
    const gaps = await engine
      .reader(ref)
      .rows({ phase: "verify", codes: ["unowned_path_collision"] });
    assert.ok(gaps.ok);
    assert.equal(gaps.value.totalRows, 1);
  } finally {
    engine.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("archive byte verification streams missing checksums and never accepts size-only or drifted content", async () => {
  const home = await mkdtemp(join(tmpdir(), "migmate-archive-byte-proof-"));
  const port = provider();
  port.withholdDestinationChecksum("index-html");
  port.blockDestinationStream("index-html");
  const { engine, ref } = await approved(home, port);
  try {
    const result = await engine.withWriterResult(ref, (writer) => writer.execute());
    assert.ok(result.ok);
    port.archive!.setAvailable(false);
    const unproven = await engine.withWriterResult(ref, (writer) => writer.verify());
    assert.ok(unproven.ok);
    assert.ok(unproven.value.findings.some((f) => f.code === "content_verification_degraded"));
    port.unblockDestinationStream("index-html");
    const proven = await engine.withWriterResult(ref, (writer) => writer.verify());
    assert.ok(proven.ok);
    assert.ok(!proven.value.findings.some((f) => f.code === "content_verification_degraded"));
    const repairedRows = await engine
      .reader(ref)
      .rows({ phase: "verify", codes: ["content_verification_degraded"] });
    assert.ok(repairedRows.ok);
    assert.equal(repairedRows.value.totalRows, 0);
    const prior = await port.readDestinationObject({
      driveId: "destination",
      objectId: "index-html",
    });
    assert.ok(prior?.revision);
    const changed = await bytes(port.streamDestinationContent(prior.id));
    changed[0] = changed[0]! ^ 1; // Same size, different bytes.
    await port.uploadDestinationContent({
      destinationId: prior.id,
      create: false,
      expectedRevision: prior.revision,
      parentFolderId: "archive-root",
      name: prior.name,
      content: changed,
      createdAt: prior.createdAt,
      modifiedAt: prior.modifiedAt,
      mimeType: prior.mimeType,
    });
    const drifted = await engine.withWriterResult(ref, (writer) => writer.verify());
    assert.ok(drifted.ok);
    assert.ok(drifted.value.findings.some((f) => f.code === "content_mismatch"));
    assert.ok(drifted.value.findings.some((f) => f.code === "prior_copy_drift"));
    assert.ok(!drifted.value.findings.some((f) => f.code === "size_mismatch"));
  } finally {
    engine.close();
    await rm(home, { recursive: true, force: true });
  }
});
