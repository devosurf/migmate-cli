import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { parse as parseToml } from "smol-toml";
import {
  EngineRefusalError,
  openEngine,
  type Engine,
  type JobEvent,
  type JobRef,
  type Outcome,
  type RefusalCode,
  type Row,
} from "../src/engine/index.ts";
import {
  FakeFileMigrationPort,
  type FakeArchiveFixture,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import type { FileMigrationConfig } from "../src/engine/drivers/file-migration.ts";
import type { ConversationManifest, PackageManifest } from "../src/engine/archive/package.ts";

const NOW = "2026-09-01T00:00:00.000Z";

function value<T>(outcome: Outcome<T>): T {
  assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.refusal.code);
  if (!outcome.ok) throw new Error(outcome.refusal.code);
  return outcome.value;
}

function refused<T>(outcome: Outcome<T>, code: RefusalCode): void {
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error(`Expected ${code}`);
  assert.equal(outcome.refusal.code, code);
}

function hash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(): FakeFileMigrationFixture {
  return {
    sourceDriveId: "source-drive",
    sourceRootId: "source-root",
    destinationDriveId: "destination-drive",
    destinationRootId: "destination-root",
    sourceItems: [
      { id: "source-root", parentId: null, name: "source", kind: "folder" },
      { id: "document", parentId: "source-root", name: "document.bin", kind: "file",
        content: "original", etag: "source-v1", createdAt: NOW, modifiedAt: NOW,
        mimeType: "application/octet-stream" },
    ],
    destinationItems: [
      { id: "destination-root", parentId: null, name: "destination", kind: "folder" },
    ],
  };
}

function config(exclusions: Array<{ sourceItemId: string; reason: string }> = []): FileMigrationConfig {
  return {
    mappings: [{ id: "mapping", sourceDriveId: "source-drive", sourceItemId: "source-root",
      destDriveId: "destination-drive", destFolderId: "destination-root", exclusions }],
  };
}

interface Harness {
  home: string;
  engine: Engine;
  port: FakeFileMigrationPort;
  ref: JobRef;
  now: string;
}

async function harness(
  t: TestContext,
  input = fixture(),
  selected: unknown = config(),
  type: "file_migration" | "teams_archive" = "file_migration",
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "migmate-durability-"));
  const port = new FakeFileMigrationPort(input);
  const clock = { now: NOW };
  const engine = openEngine({ home, provider: port, now: () => new Date(clock.now) });
  const ref = value(await engine.initJob({ type, config: selected }));
  const h: Harness = { home, engine, port, ref, get now() { return clock.now; }, set now(next) { clock.now = next; } };
  t.after(async () => { h.engine.close(); await rm(home, { recursive: true, force: true }); });
  return h;
}

function reopen(h: Harness): void {
  h.engine.close();
  h.engine = openEngine({ home: h.home, provider: h.port, now: () => new Date(h.now) });
}

async function approve(h: Harness): Promise<string> {
  return value(await h.engine.withWriter(h.ref, async (writer) => {
    const plan = value(await writer.plan());
    value(await writer.approve({ approver: "durability-test", mode: "unattended", planDigest: plan.planDigest }));
    return plan.planDigest;
  }));
}

async function execute(h: Harness) {
  return value(await h.engine.withWriterResult(h.ref, (writer) => writer.execute()));
}

async function verify(h: Harness) {
  return value(await h.engine.withWriterResult(h.ref, (writer) => writer.verify()));
}

async function events(engine: Engine, ref: JobRef, from?: number): Promise<JobEvent[]> {
  const result: JobEvent[] = [];
  for await (const event of engine.reader(ref).events(from === undefined ? {} : { from })) result.push(event);
  return result;
}

// Filesystem evidence is the public contract for read-only access and secret non-persistence.
// SQLite is used only to prepare a future-version fixture, never to assert engine internals.
async function diskSnapshot(root: string): Promise<Array<{ path: string; mode: number; modified: number; bytes: Buffer | null }>> {
  const result: Array<{ path: string; mode: number; modified: number; bytes: Buffer | null }> = [];
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative);
    const stat = await lstat(path);
    result.push({ path: relative, mode: stat.mode, modified: stat.mtimeMs, bytes: stat.isFile() ? await readFile(path) : null });
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(relative, child));
    }
  }
  await visit("");
  return result;
}

async function readerRefusals(engine: Engine, ref: JobRef, code: RefusalCode): Promise<void> {
  const reader = engine.reader(ref);
  refused(await reader.status(), code);
  refused(await reader.rows({ phase: "plan" }), code);
  refused(await reader.artifacts(), code);
  await assert.rejects(async () => { for await (const event of reader.events({})) void event; }, (error: unknown) => {
    assert.ok(error instanceof EngineRefusalError);
    assert.equal(error.refusal.code, code);
    return true;
  });
}

describe("engine durability seam", () => {
  it("binds same-count changed content while unchanged replans ignore observation time and revision", async (t) => {
    const h = await harness(t);
    const first = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    h.now = "2026-09-02T00:00:00.000Z";
    reopen(h);
    const unchanged = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan({ force: true })));
    assert.ok(unchanged.revision > first.revision);
    assert.equal(unchanged.planDigest, first.planDigest);
    assert.equal(unchanged.inputsDigest, first.inputsDigest);
    h.port.mutateSourceItem("document", { content: "modified", etag: "source-v2" });
    const changed = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    assert.equal(changed.rowCount, first.rowCount);
    assert.notEqual(changed.planDigest, first.planDigest);
    refused(await h.engine.withWriterResult(h.ref, (writer) => writer.approve({
      approver: "durability-test", mode: "unattended", planDigest: first.planDigest,
    })), "approval_digest_stale");
  });

  it("keeps identical exception evidence stable when a new plan stores fresh finding records", async (t) => {
    const h = await harness(t, fixture(), config([{ sourceItemId: "document", reason: "Approved exclusion" }]));
    const first = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    h.now = "2026-09-02T00:00:00.000Z";
    reopen(h);
    const next = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    assert.ok(next.revision > first.revision);
    assert.equal(next.planDigest, first.planDigest);
    assert.ok(value(await h.engine.reader(h.ref).rows({ phase: "plan" })).facets.some((facet) => facet.code === "omitted_by_rule"));
  });

  it("reconciles atomically marked reserved uploads and moves after their responses are lost", async (t) => {
    const input = fixture();
    input.reservedDestinationIds = ["reserved-document"];
    const h = await harness(t, input);
    await approve(h);
    h.port.loseResponseOnce("uploadDestinationContent", "reserved-document");
    assert.equal((await execute(h)).outcome, "interrupted");
    const applied = h.port.snapshotDestination().filter((entry) => entry.path === "document.bin");
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.id, "reserved-document");
    assert.equal(applied[0]?.checksum, hash("original"));
    assert.equal(applied[0]?.provenance?.sourceItemId, "document");
    reopen(h);
    assert.equal((await execute(h)).outcome, "completed");
    assert.equal((await verify(h)).clean, true);
    h.port.renameSourceItem("document", "renamed.bin");
    h.port.loseResponseOnce("moveDestinationObject", "reserved-document");
    assert.equal((await execute(h)).outcome, "interrupted");
    const moved = h.port.snapshotDestination().find((entry) => entry.id === "reserved-document");
    assert.equal(moved?.path, "renamed.bin");
    assert.equal(moved?.provenance?.sourceRelativePath, "renamed.bin");
    reopen(h);
    assert.equal((await execute(h)).outcome, "completed");
    assert.deepEqual(h.port.snapshotDestination().filter((entry) => entry.kind === "file").map((entry) => ({
      id: entry.id, path: entry.path, checksum: entry.checksum,
    })), [{ id: "reserved-document", path: "renamed.bin", checksum: hash("original") }]);
    assert.equal((await verify(h)).clean, true);
  });

  it("resumes a lost folder-create response into that exact reserved parent", async (t) => {
    const input = fixture();
    input.sourceItems.push({ id: "folder", parentId: "source-root", name: "nested", kind: "folder" });
    input.sourceItems[1]!.parentId = "folder";
    input.reservedDestinationIds = ["reserved-folder", "reserved-child"];
    const h = await harness(t, input);
    await approve(h);
    h.port.loseResponseOnce("createDestinationFolder", "reserved-folder");
    assert.equal((await execute(h)).outcome, "interrupted");
    const folder = h.port.snapshotDestination().find((entry) => entry.path === "nested");
    assert.equal(folder?.id, "reserved-folder");
    assert.equal(folder?.provenance?.sourceItemId, "folder");
    reopen(h);
    assert.equal((await execute(h)).outcome, "completed");
    assert.deepEqual(h.port.snapshotDestination().filter((entry) => entry.path !== ".").map((entry) => ({
      id: entry.id, parentId: entry.parentId, path: entry.path,
    })), [
      { id: "reserved-folder", parentId: "destination-root", path: "nested" },
      { id: "reserved-child", parentId: "reserved-folder", path: "nested/document.bin" },
    ]);
    assert.equal((await verify(h)).clean, true);
  });

  it("requeues source changes after an atomic upload without losing authority over the prior output", async (t) => {
    const input = fixture();
    input.reservedDestinationIds = ["reserved-document"];
    input.sourceMutations = [{ sourceItemId: "document", nextContent: "new authoritative source",
      nextEtag: "source-v2", when: "destination-upload" }];
    const h = await harness(t, input);
    await approve(h);
    assert.equal((await execute(h)).outcome, "completed");
    const files = h.port.snapshotDestination().filter((entry) => entry.kind === "file");
    assert.deepEqual(files.map((entry) => ({ id: entry.id, checksum: entry.checksum })), [
      { id: "reserved-document", checksum: hash("new authoritative source") },
    ]);
    assert.equal((await verify(h)).clean, true);
  });

  it("requires fresh acceptance after every verification, even for unchanged exception evidence", async (t) => {
    const h = await harness(t, fixture(), config([{ sourceItemId: "document", reason: "Approved exclusion" }]));
    await approve(h);
    await execute(h);
    const first = await verify(h);
    assert.ok(first.findings.some((finding) => finding.code === "omitted_by_rule"));
    const accepted = value(await h.engine.withWriterResult(h.ref, (writer) => writer.accept({
      verificationDigest: first.verificationDigest,
      codes: [{ code: "omitted_by_rule", note: "Keep this source outside the destination" }],
      approver: "operator",
    })));
    assert.deepEqual(accepted.acceptedCodes, ["omitted_by_rule"]);
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).outstandingFindings, []);
    reopen(h);
    const fresh = await verify(h);
    assert.notEqual(fresh.verificationDigest, first.verificationDigest);
    assert.ok(fresh.revision > first.revision);
    assert.deepEqual(fresh.acceptedCodes, []);
    assert.ok(value(await h.engine.reader(h.ref).status()).outstandingFindings.some((finding) => finding.code === "omitted_by_rule"));
    refused(await h.engine.withWriterResult(h.ref, (writer) => writer.accept({
      verificationDigest: first.verificationDigest, codes: [{ code: "omitted_by_rule" }], approver: "operator",
    })), "verification_unaccepted");
    refused(await h.engine.withWriterResult(h.ref, (writer) => writer.close()), "verification_unaccepted");
    value(await h.engine.withWriterResult(h.ref, (writer) => writer.accept({
      verificationDigest: fresh.verificationDigest, codes: [{ code: "omitted_by_rule" }], approver: "operator",
    })));
    assert.deepEqual(value(await h.engine.withWriterResult(h.ref, (writer) => writer.close())).acceptedExceptions, ["omitted_by_rule"]);
  });

  it("exports immutable byte-addressed evidence after closure with named accepted exceptions", async (t) => {
    const h = await harness(t, fixture(), config([{ sourceItemId: "document", reason: "Approved exclusion" }]));
    await approve(h);
    await execute(h);
    const verification = await verify(h), note = "<script>operator-note()</script>";
    value(await h.engine.withWriterResult(h.ref, (writer) => writer.accept({
      verificationDigest: verification.verificationDigest, codes: [{ code: "omitted_by_rule", note }], approver: "archive-owner",
    })));
    value(await h.engine.withWriterResult(h.ref, (writer) => writer.close()));
    const first = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
    const json = first.artifacts.find((artifact) => artifact.name === "report.json");
    const html = first.artifacts.find((artifact) => artifact.name === "report.html");
    assert.ok(json && html);
    for (const artifact of first.artifacts) assert.equal(artifact.digest, hash(await readFile(artifact.path)));
    const report = JSON.parse(await readFile(json.path, "utf8"));
    assert.equal(report.job.state, "closed");
    assert.equal(report.acceptedExceptions[0].approver, "archive-owner");
    assert.equal(report.acceptedExceptions[0].note, note);
    assert.ok(report.acceptedExceptions[0].items.some((item: { subjectId: string }) => item.subjectId === "document"));
    const rendered = await readFile(html.path, "utf8");
    assert.equal(rendered.includes(note), false);
    assert.ok(rendered.includes("&lt;script&gt;operator-note()&lt;/script&gt;"));
    reopen(h);
    const repeated = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
    assert.deepEqual(repeated, first);
    refused(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()), "job_closed");
  });

  it("refuses the whole named acceptance set when a later code is not in the current verification", async (t) => {
    const h = await harness(t, fixture(), config([{ sourceItemId: "document", reason: "Out of scope" }]));
    await approve(h);
    await execute(h);
    const verification = await verify(h);
    const outstanding = value(await h.engine.reader(h.ref).status()).outstandingFindings;
    refused(await h.engine.withWriterResult(h.ref, (writer) => writer.accept({
      verificationDigest: verification.verificationDigest,
      codes: [{ code: "omitted_by_rule" }, { code: "content_mismatch" }], approver: "operator",
    })), "verification_unaccepted");
    reopen(h);
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).outstandingFindings, outstanding);
    const omissions = value(await h.engine.reader(h.ref).rows({ phase: "verify", codes: ["omitted_by_rule"] }));
    assert.equal(omissions.totalRows, 1);
    assert.equal(omissions.rows[0]?.accepted, false);
    refused(await h.engine.withWriterResult(h.ref, (writer) => writer.close()), "verification_unaccepted");
  });

  it("keeps full-set facets and stable row pages and event cursors across engine reopening", async (t) => {
    const input = fixture();
    input.sourceItems.push(
      { id: "excluded-folder", parentId: "source-root", name: "excluded", kind: "folder" },
      { id: "excluded-child", parentId: "excluded-folder", name: "child.bin", kind: "file", content: "omit" },
      { id: "another", parentId: "source-root", name: "another.bin", kind: "file", content: "retain" },
    );
    const h = await harness(t, input, config([{ sourceItemId: "excluded-folder", reason: "Separate archive" }]));
    await approve(h);
    await execute(h);
    const full = value(await h.engine.reader(h.ref).rows({ phase: "verify", sort: "path", limit: 1000 }));
    assert.equal(full.facets.find((facet) => facet.code === "omitted_by_rule")?.count, 2);
    const beforeEvents = await events(h.engine, h.ref);
    const middle = beforeEvents[Math.floor(beforeEvents.length / 2)];
    assert.ok(middle);
    const gathered: Row[] = [];
    let cursor: string | undefined;
    do {
      const page = value(await h.engine.reader(h.ref).rows({ phase: "verify", sort: "path", limit: 1,
        ...(cursor === undefined ? {} : { cursor }) }));
      assert.equal(page.totalRows, full.totalRows);
      assert.equal(page.rows.length, 1);
      assert.deepEqual(page.facets, full.facets);
      gathered.push(...page.rows);
      assert.ok(gathered.length <= full.totalRows, "A continuation must not repeat earlier rows");
      cursor = page.nextCursor ?? undefined;
      reopen(h);
    } while (cursor !== undefined);
    assert.deepEqual(gathered, full.rows);
    assert.equal(new Set(gathered.map((row) => row.id)).size, full.totalRows);
    assert.deepEqual(await events(h.engine, h.ref), beforeEvents);
    assert.deepEqual(await events(h.engine, h.ref, middle.cursor), beforeEvents.filter((event) => event.cursor > middle.cursor));
  });

  it("persists real TOML with exact exclusion objects and credential references, never supplied secret text", async (t) => {
    const selected = { ...config([{ sourceItemId: "document", reason: "Operator-approved exclusion" }]),
      rclone: { config: { resolver: "file", path: join(tmpdir(), "operator-owned", "rclone.conf"), mode: "0600" },
        sourceRemote: "sp-source", destinationRemote: "gdrive-dest" } };
    const h = await harness(t, fixture(), selected);
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const original = await readFile(path, "utf8");
    const parsed = parseToml(original);
    assert.deepEqual(parsed.mappings, selected.mappings);
    assert.deepEqual(parsed.rclone, selected.rclone);
    reopen(h);
    value(await h.engine.withWriterResult(h.ref, (writer) => writer.doctor()));
    const secret = "MIGMATE-SECRET-MUST-NOT-PERSIST-0a163d";
    const invalid = { ...selected, rclone: { ...selected.rclone,
      config: { ...selected.rclone.config, value: secret } } };
    refused(await h.engine.initJob({ type: "file_migration", config: invalid }), "configuration_invalid");
    refused(await h.engine.withWriterResult(h.ref, (writer) => writer.onboard(invalid)), "configuration_invalid");
    assert.equal(await readFile(path, "utf8"), original);
    for (const file of await diskSnapshot(h.home)) {
      assert.equal(file.bytes?.includes(Buffer.from(secret)) ?? false, false, `Secret persisted in ${file.path}`);
    }
    assert.equal(JSON.stringify(await events(h.engine, h.ref)).includes(secret), false);
  });

  it("does not silently discard malformed mappings or string exclusions with an injected provider", async (t) => {
    const h = await harness(t);
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const before = await readFile(path, "utf8");
    for (const invalid of [
      { mappings: [{ sourceDriveId: "source-drive", sourceItemId: "source-root", destDriveId: "destination-drive", destFolderId: "destination-root" }] },
      { mappings: [{ ...config().mappings[0], exclusions: ["*.bin"] }] },
    ]) {
      refused(await h.engine.withWriterResult(h.ref, (writer) => writer.onboard(invalid)), "configuration_invalid");
      assert.equal(await readFile(path, "utf8"), before);
    }
  });

  it("does not turn an unregistered provider defect into a handled collection finding", async (t) => {
    const h = await harness(t);
    await approve(h);
    const defect = Object.assign(new Error("Unexpected provider defect"), { code: "constructor" });
    h.port.scriptEffect({ method: "streamSourceContent", objectId: "document", count: 1, error: defect });
    await assert.rejects(() => h.engine.withWriterResult(h.ref, (writer) => writer.execute()), (error) => error === defect);
    assert.equal(value(await h.engine.reader(h.ref).status()).state, "interrupted");
  });

  it("refuses changed application identity before making any approved destination mutation", async (t) => {
    const h = await harness(t);
    await approve(h);
    const before = h.port.snapshotDestination();
    h.port.setApplicationIdentity("another-authenticated-application");
    refused(await h.engine.withWriterResult(h.ref, (writer) => writer.execute()), "plan_revision_required");
    assert.deepEqual(h.port.snapshotDestination(), before);
  });

  it("refuses missing reader state without creating an engine home or a missing job folder", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "migmate-reader-missing-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "not-created");
    const engine = openEngine({ home, provider: new FakeFileMigrationPort(fixture()) });
    const before = await diskSnapshot(root);
    await readerRefusals(engine, { id: "missing-job" }, "job_not_found");
    engine.close();
    assert.deepEqual(await diskSnapshot(root), before);
    const h = await harness(t);
    const existing = await diskSnapshot(h.home);
    await readerRefusals(h.engine, { id: "missing-job" }, "job_not_found");
    assert.deepEqual(await diskSnapshot(h.home), existing);
  });

  it("refuses newer read-only state without changing database bytes, metadata, or sidecar files", async (t) => {
    const h = await harness(t);
    const database = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
    try { database.exec("UPDATE job SET schema_version = 2147483647"); } finally { database.close(); }
    const before = await diskSnapshot(h.home);
    await readerRefusals(h.engine, h.ref, "state_version_unsupported");
    assert.deepEqual(await diskSnapshot(h.home), before);
  });
});

function archiveFixture(): { fixture: FakeArchiveFixture; cursor: string } {
  const conversation = { id: "chat:chat-one", kind: "chat" as const, title: "Preserved conversation",
    scopeEntryId: "user-chats:user-one", participantScopeIds: ["user-chats:user-one"], ownerUserId: "user-one",
    raw: { id: "chat-one", chatType: "group" } };
  const empty = { ...conversation, id: "chat:empty", title: "Empty conversation", raw: { id: "empty", chatType: "group" } };
  const scope = { id: "user-chats:user-one", kind: "user-chats" as const, userId: "user-one",
    conversationIds: [conversation.id, empty.id] };
  const message = { id: "message-one", chatId: "chat-one", createdDateTime: "2026-02-01T00:00:00Z",
    lastModifiedDateTime: "2026-02-02T00:00:00Z", from: { user: { id: "user-one", displayName: "Original author" } },
    body: { contentType: "html", content: "<p>First preserved message</p>" }, attachments: [], mentions: [] };
  const other = { ...message, id: "message-two", body: { contentType: "html", content: "<p>Second preserved message</p>" } };
  const transcript = { id: "transcript-one", createdDateTime: "2026-02-03T00:00:00Z", meetingId: "meeting-one",
    meetingOrganizer: { user: { id: "user-one", displayName: "Original organizer" } } };
  const cursor = "https://graph.microsoft.com/v1.0/users/user-one/chats/getAllMessages?$skiptoken=second";
  return { cursor, fixture: {
    scopes: [scope], conversations: [conversation, empty],
    checks: [{ id: "scripted-archive", title: "Explicit archive fixture", status: "pass", evidence: {} }],
    pages: [
      { scopeId: scope.id, route: "messages", cursor: null, page: { records: [message], nextLink: cursor } },
      { scopeId: scope.id, route: "messages", cursor, page: { records: [message, other], nextLink: null } },
      { scopeId: scope.id, route: "retained", cursor: null, page: { records: [message], nextLink: null } },
      { scopeId: scope.id, route: "transcripts", cursor: null, page: { records: [transcript], nextLink: null } },
    ],
    transcriptConversationIds: { "transcript-one": conversation.id },
    assets: [
      { conversationId: conversation.id, recordId: "message-one", route: "messages", kind: "hosted_content", id: "inline-one",
        name: "inline.png", content: new Uint8Array([1, 2, 3, 4]), chunkSize: 2 },
      { conversationId: conversation.id, recordId: "message-two", route: "messages", kind: "hosted_content", id: "inline-two",
        name: "same-inline.png", content: new Uint8Array([1, 2, 3, 4]) },
      { conversationId: conversation.id, recordId: "transcript-one", route: "transcripts", kind: "transcript", id: "transcript-one",
        name: "meeting.vtt", content: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nPreserved transcript\n" },
    ],
  } };
}

it("durably resumes archive pages and partial assets, deduplicates current/retained records, and verifies offline", async (t) => {
  const archive = archiveFixture();
  const input = fixture();
  input.archive = archive.fixture;
  input.effects = [{ method: "startTransferWorker", count: 1, error: new Error("Archive must never start a transfer worker") }];
  const h = await harness(t, input, {
    scopes: [{ kind: "user-chats", userId: "user-one" }], cloud: "Global", retainedHistory: true,
    transcripts: true, attachmentBytes: true, timezone: "UTC",
    window: { from: "2026-01-01T00:00:00Z", to: NOW },
  }, "teams_archive");
  await approve(h);
  const effects = h.port.archive;
  assert.ok(effects);
  effects.scriptEffect({ method: "openAsset", objectId: "inline-one", count: 1, afterChunks: 1,
    error: Object.assign(new Error("Transient asset stream failure"), { status: 503, transient: true, retryAfterMs: 0 }) });
  effects.failPageOnce({ scopeId: "user-chats:user-one", route: "messages", cursor: archive.cursor },
    Object.assign(new Error("Interrupted at the next page"), { name: "AbortError" }));
  assert.equal((await execute(h)).outcome, "interrupted");
  const partial = value(await h.engine.reader(h.ref).rows({ phase: "execute" })).rows;
  const conversation = partial.find((row) => row.jobType === "teams_archive" && row.conversationId === "chat:chat-one");
  assert.ok(conversation?.jobType === "teams_archive");
  assert.equal(conversation.records, 1);
  assert.equal(conversation.assets, 1);
  reopen(h);
  assert.equal((await execute(h)).outcome, "completed");
  const root = join(h.home, "jobs", h.ref.id, "archive");
  const manifest: PackageManifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.recordCount, 3);
  assert.equal(manifest.assetCount, 2);
  assert.deepEqual(manifest.conversations.map((entry) => ({ id: entry.id, records: entry.recordCount })).sort((a, b) => a.id.localeCompare(b.id)), [
    { id: "chat:chat-one", records: 3 }, { id: "chat:empty", records: 0 },
  ]);
  const retained = manifest.collection.filter((page) => page.route === "retained");
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.complete, true);
  assert.deepEqual(retained[0]?.recordKeys, []);
  const descriptor = manifest.conversations.find((entry) => entry.id === "chat:chat-one");
  assert.ok(descriptor);
  const detail: ConversationManifest = JSON.parse(await readFile(join(root, descriptor.manifest.path), "utf8"));
  const raw: Array<{ id: string }> = [];
  for (const part of detail.parts) {
    raw.push(...(await readFile(join(root, part.jsonl.path), "utf8")).trim().split("\n").map((line) => JSON.parse(line)));
  }
  assert.deepEqual(raw.map((record) => record.id).sort(), ["message-one", "message-two", "transcript-one"]);
  const storedInline = detail.assets.find((asset) => asset.sha256 === hash(new Uint8Array([1, 2, 3, 4])));
  assert.ok(storedInline);
  assert.deepEqual(await readFile(join(root, storedInline.path)), Buffer.from([1, 2, 3, 4]));
  assert.equal(storedInline.references.length, 2);
  effects.setAvailable(false);
  reopen(h);
  const verified = await verify(h);
  assert.equal(verified.clean, true);
  assert.deepEqual(verified.findings, []);
  assert.deepEqual(h.port.snapshotDestination().map((entry) => entry.path), ["."]);
});
