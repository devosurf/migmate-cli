import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import {
  fileMigrationDriver,
  type FileMigrationConfig,
} from "../src/engine/drivers/file-migration.ts";
import type { DriverContext } from "../src/engine/drivers/types.ts";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import type { CommitUnit, FileCommitRow } from "../src/engine/commit.ts";
import { reportJson } from "../src/engine/report.ts";
import { canonicalJson } from "../src/engine/store/digest.ts";
import { openStore, SCHEMA_VERSION, type Store } from "../src/engine/store/store.ts";

import { approve, fileConfig, fileFixture, value } from "./engine-fixture.ts";
const NOW = "2026-09-01T00:00:00.000Z";

async function fixture(t: TestContext): Promise<Store> {
  const directory = await mkdtemp(join(tmpdir(), "migmate-store-paging-"));
  const opened = openStore(directory, { migmateVersion: "test", now: () => new Date(NOW) });
  assert.ok(opened.ok);
  const store = opened.value;
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.writeJob({
    id: "paging",
    type: "file_migration",
    state: "approved",
    schemaVersion: SCHEMA_VERSION,
    migmateVersion: "test",
    label: null,
    createdAt: NOW,
    planRevision: 1,
    verificationRevision: null,
    lastCheckpoint: null,
    hostId: null,
  });
  store.writePlanRevision({
    revision: 1,
    planDigest: "plan",
    inputsDigest: "inputs",
    createdAt: NOW,
    rowCount: 1,
    inputs: {},
    evidence: {},
    disclosures: [],
    sections: [],
  });
  return store;
}

function commitRow(
  store: Store,
  id: string,
  phase: FileCommitRow["phase"],
  scope?: FileCommitRow["fileScope"],
): void {
  const row: FileCommitRow = {
    id,
    rev: 1,
    phase,
    code: "unchanged",
    kind: "policy_outcome",
    jobType: "file_migration",
    mappingId: "mapping",
    sourceDriveId: "source",
    sourceItemId: "root",
    relativePath: "",
    itemType: "folder",
    size: null,
    ...(scope ? { fileScope: scope } : {}),
  };
  store.commit({ rev: 1, phase, unitKey: id, checkpoint: id, rows: [row], findings: [] });
}

it("recovery publishes one fresh settle generation after interruption between path pages", async (t) => {
  const store = await fixture(t);
  const port = new FakeFileMigrationPort(fileFixture());
  const worker = await port.startTransferWorker({ runDirectory: "/tmp/settle-generation-test" });
  t.after(() => port.stopTransferWorker(worker));
  let observation = 0;
  const freshPaths = Array.from(
    { length: 1501 },
    (_, index) => `new-${String(index).padStart(4, "0")}`,
  );
  t.mock.method(port, "compareFileListings", async () => {
    const paths =
      observation++ === 0
        ? Array.from({ length: 2001 }, (_, index) => `old-${String(index).padStart(4, "0")}`)
        : observation === 2
          ? freshPaths
          : [];
    return {
      new: paths.map((path) => ({ path, size: 1 })),
      changed: [],
      unchanged: [],
      deleted: [],
      retained: [],
      timestampOnly: [],
      modifyWindowNs: "1000000000",
    };
  });
  const ctx: DriverContext<FileMigrationConfig> = {
    jobDirectory: "/tmp/settle-generation-test",
    config: {
      ...fileConfig(),
      options: { staged: true, consistencyIntervalMs: 0, settleMaxPasses: 1 },
    },
    revision: 1,
    stage: "final",
    provider: port,
    now: () => new Date(NOW),
    resume: { checkpoint: null, ...store.readResume(1) },
  };
  for await (const unit of fileMigrationDriver.collect(ctx)) store.commit(unit);
  ctx.resume = { checkpoint: null, ...store.readResume(1) };
  const interrupted = fileMigrationDriver.execute(ctx)[Symbol.asyncIterator]();
  for (;;) {
    const next = await interrupted.next();
    assert.equal(next.done, false);
    if (next.done) throw new Error("Expected a pending path page");
    store.commit(next.value);
    if (next.value.watermark?.unitKey.startsWith("file-settle-paths:")) break;
  }
  await interrupted.return?.();
  const partial = JSON.parse([...reportJson(store.reportEvidence(1).settled("mapping"))].join(""));
  assert.deepEqual(partial.observations, [], "an unfinished generation is not published");
  ctx.resume = { checkpoint: null, ...store.readResume(1) };
  for await (const unit of fileMigrationDriver.execute(ctx)) store.commit(unit);
  const final = JSON.parse([...reportJson(store.reportEvidence(1).settled("mapping"))].join(""));
  assert.equal(final.outcome, "settled");
  assert.deepEqual(final.observations[0].changedPaths, freshPaths);
  assert.deepEqual(final.observations[1].changedPaths, []);
});

it("resumes file jobs from mapping metadata, not item rows, coverage pages or committed keys", async (t) => {
  const store = await fixture(t);
  commitRow(store, "scope", "plan", { mapOnly: true });
  store.beginVerification(1, 1);
  for (let index = 0; index < 32; index++) {
    commitRow(store, `item-${index}`, "execute");
    commitRow(store, JSON.stringify(["mapping", "root", "verify", "coverage", index]), "verify", {
      mapOnly: true,
      verification: { scope: "full", coveredPaths: [`path-${index}`] },
    });
    store.db
      .prepare("INSERT INTO watermark VALUES (?,?,?,?)")
      .run(1, `file-settle-paths:mapping:0:${index}`, JSON.stringify([`path-${index}`]), NOW);
  }
  const settled = {
    revision: 1,
    outcome: "settled",
    observations: [{ at: NOW, outcome: "changed", changedPaths: [], changedPathPages: 32 }],
  };
  store.db
    .prepare("INSERT INTO watermark VALUES (?,?,?,?)")
    .run(1, "file-settle:mapping", JSON.stringify(settled), NOW);
  const resume = store.readResume(1);
  assert.deepEqual(
    resume.rows.map((row) => row.id),
    ["scope"],
  );
  assert.deepEqual(resume.committedUnits, []);
  assert.deepEqual(Object.keys(resume.watermarks), ["file-settle:mapping"]);
  assert.deepEqual(JSON.parse(resume.watermarks["file-settle:mapping"]!), settled);
  assert.deepEqual(
    store.readPlanScopes(1).map((row) => row.id),
    ["scope"],
  );
  assert.deepEqual(
    store.readReportResume(1).rows.map((row) => row.id),
    ["scope"],
  );
});

it("renders paged and historical coverage with identical mapping evidence and ordering", async (t) => {
  const store = await fixture(t);
  store.beginVerification(1, 1);
  const paths = Array.from({ length: 12 }, (_, index) => `path-${String(index).padStart(2, "0")}`);
  const legacyId = JSON.stringify(["mapping", "root", "verify", "coverage"]);
  commitRow(store, legacyId, "verify", {
    mapOnly: true,
    verification: { scope: "full", coveredPaths: paths },
  });
  const legacy = [...reportJson(store.reportEvidence(1).coverage)].join("");
  assert.equal(
    legacy,
    canonicalJson([{ mappingId: "mapping", scope: "full", coveredPaths: paths }]),
  );
  store.beginVerification(1, 2);
  for (let page = paths.length - 1; page >= 0; page--)
    commitRow(store, JSON.stringify(["mapping", "root", "verify", "coverage", page]), "verify", {
      mapOnly: true,
      verification: { scope: "full", coveredPaths: [paths[page]!] },
    });
  const coverage = store.reportEvidence(1).coverage;
  assert.equal([...reportJson(coverage)].join(""), legacy);
  assert.equal([...reportJson(coverage)].join(""), legacy);
  assert.deepEqual(store.readReportResume(1).rows, []);
});

it("retains empty coverage and streams large historical single-row inventories", async (t) => {
  const store = await fixture(t);
  store.beginVerification(1, 1);
  const id = JSON.stringify(["mapping", "root", "verify", "coverage", 0]);
  commitRow(store, id, "verify", {
    mapOnly: true,
    verification: { scope: "full", coveredPaths: [] },
  });
  assert.equal(
    [...reportJson(store.reportEvidence(1).coverage)].join(""),
    canonicalJson([{ mappingId: "mapping", scope: "full", coveredPaths: [] }]),
  );
  store.beginVerification(1, 2);
  const paths = Array.from({ length: 2000 }, (_, index) => `${index}-${"x".repeat(64)}`);
  commitRow(store, "historical", "verify", {
    mapOnly: true,
    verification: { scope: "full", coveredPaths: paths },
  });
  assert.equal(
    [...reportJson(store.reportEvidence(1).coverage)].join(""),
    canonicalJson([{ mappingId: "mapping", scope: "full", coveredPaths: paths }]),
  );
});

it("reconstructs paged settle observations without exposing storage metadata or changing inline history", async (t) => {
  const store = await fixture(t);
  const expected = {
    revision: 1,
    mappingId: "mapping",
    outcome: "settled",
    observations: [
      { at: NOW, outcome: "changed", changedPaths: ["old-inline"] },
      { at: NOW, outcome: "changed", changedPaths: ["a", "b", "c"] },
      { at: NOW, outcome: "settled", changedPaths: [] },
    ],
  };
  const stored = structuredClone(expected);
  const observation = { ...stored.observations[1]!, changedPaths: [], changedPathPages: 2 };
  stored.observations[1] = observation;
  const insert = store.db.prepare("INSERT INTO watermark VALUES (?,?,?,?)");
  insert.run(1, "file-settle:mapping", JSON.stringify(stored), NOW);
  insert.run(1, "file-settle-paths:mapping:1:1", JSON.stringify(["c"]), NOW);
  insert.run(1, "file-settle-paths:mapping:1:0", JSON.stringify(["a", "b"]), NOW);
  const evidence = store.reportEvidence(1).settled("mapping");
  assert.equal([...reportJson(evidence)].join(""), canonicalJson(expected));
  assert.equal([...reportJson(evidence)].join(""), canonicalJson(expected));
  assert.equal(store.reportEvidence(1).settled("missing"), undefined);
});

it("snapshots verification rows canonically and retains them across recovery", async (t) => {
  const store = await fixture(t);
  store.beginVerification(1, 1);
  commitRow(store, "legacy-coverage", "verify", {
    mapOnly: true,
    verification: {
      scope: "full",
      coveredPaths: ['quotes"', "line\n", "unicode-Ω", "back\\slash"],
    },
  });
  store.writeFinding({
    rev: 1,
    phase: "verify",
    code: "content_mismatch",
    kind: "finding",
    subjectKind: "item",
    subjectId: "root",
    evidence: { detail: "line\n\t\u0000" },
    at: NOW,
  });
  const expected = ["item", "finding"].map((table) => ({
    category: table,
    payload: canonicalJson(
      store.db.prepare(`SELECT * FROM ${table} WHERE rev=1 AND phase='verify'`).get(),
    ),
  }));
  const digest = store.readVerificationEvidenceDigest(1);
  store.writeVerificationRevision({
    revision: 1,
    planRev: 1,
    verificationDigest: "verification",
    clean: false,
    findings: [],
    acceptedCodes: [],
    at: NOW,
  });
  assert.equal(store.readVerificationEvidenceDigest(1), digest);
  for (const row of expected)
    assert.equal(
      store.db
        .prepare("SELECT payload FROM verification_history WHERE run=1 AND category=?")
        .get(row.category)?.payload,
      row.payload,
    );
  store.beginVerification(1, 2);
  assert.deepEqual(store.readAllRows(1, "verify"), []);
  for (const row of expected)
    assert.equal(
      store.db
        .prepare("SELECT payload FROM verification_history WHERE run=1 AND category=?")
        .get(row.category)?.payload,
      row.payload,
    );
});

it("retains archive row and watermark resume semantics", async (t) => {
  const store = await fixture(t);
  store.writeJob({ ...store.readJob()!, type: "teams_archive" });
  const row = {
    id: "conversation",
    rev: 1,
    phase: "execute",
    code: "unchanged",
    kind: "policy_outcome",
    jobType: "teams_archive",
    scopeEntryId: "scope",
    conversationId: "conversation",
    records: 1,
    assets: 0,
  };
  store.db
    .prepare(
      "INSERT INTO conversation (id,rev,phase,code,kind,scope_entry_id,conversation_id,records,assets,payload) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      row.id,
      row.rev,
      row.phase,
      row.code,
      row.kind,
      row.scopeEntryId,
      row.conversationId,
      row.records,
      row.assets,
      JSON.stringify(row),
    );
  store.db
    .prepare("INSERT INTO watermark VALUES (?,?,?,?)")
    .run(1, "archive:scope:messages", "complete", NOW);
  const resume = store.readResume(1);
  assert.deepEqual(resume.rows, [row]);
  assert.deepEqual(resume.watermarks, { "archive:scope:messages": "complete" });
});

for (const ending of ["complete", "abort", "read-failure"] as const)
  it(`retains every yielded verification unit across a partial batch on ${ending}`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "migmate-verification-batch-"));
    const engine = openEngine({ home, provider: new FakeFileMigrationPort(fileFixture()) });
    t.after(async () => {
      engine.close();
      await rm(home, { recursive: true, force: true });
    });
    const ref = value(await engine.initJob({ type: "file_migration", config: fileConfig() }));
    await approve({ engine, ref });
    value(await engine.withWriterResult(ref, (writer) => writer.execute()));
    const controller = new AbortController();
    t.mock.method(
      fileMigrationDriver,
      "verify",
      async function* (
        ctx: Parameters<typeof fileMigrationDriver.verify>[0],
      ): AsyncGenerator<CommitUnit> {
        for (let index = 0; index < 260; index++) {
          const id = `batch-${index}`;
          const row: FileCommitRow = {
            id,
            rev: ctx.revision,
            phase: "verify",
            code: "unchanged",
            kind: "policy_outcome",
            jobType: "file_migration",
            mappingId: "mapping",
            sourceDriveId: "source-drive",
            sourceItemId: id,
            relativePath: id,
            itemType: "file",
            size: 0,
          };
          yield {
            rev: ctx.revision,
            phase: "verify",
            unitKey: id,
            checkpoint: id,
            rows: [row],
            findings: [],
            watermark: { unitKey: id, value: id },
          };
        }
        if (ending === "abort") {
          controller.abort();
          throw new DOMException("Interrupted", "AbortError");
        }
        if (ending === "read-failure") throw new Error("injected verification read failure");
      },
    );
    const result = engine.withWriterResult(ref, (writer) =>
      writer.verify({ signal: controller.signal }),
    );
    if (ending === "read-failure")
      await assert.rejects(result, /injected verification read failure/);
    else if (ending === "abort") assert.equal((await result).ok, false);
    else value(await result);
    assert.equal(
      value(await engine.reader(ref).rows({ phase: "verify", limit: 1 })).totalRows,
      260,
    );
    const committed: string[] = [];
    for await (const event of engine.reader(ref).events({}))
      if (event.kind === "unit_committed" && String(event.payload.unitKey).startsWith("batch-"))
        committed.push(String(event.payload.unitKey));
    assert.deepEqual(
      committed,
      Array.from({ length: 260 }, (_, index) => `batch-${index}`),
    );
    assert.equal(value(await engine.reader(ref).status()).lastCheckpoint, "batch-259");
    const db = new DatabaseSync(join(home, "jobs", ref.id, "state.db"), { readOnly: true });
    try {
      assert.equal(
        Number(
          db.prepare("SELECT COUNT(*) AS count FROM watermark WHERE unit_key LIKE 'batch-%'").get()!
            .count,
        ),
        260,
      );
    } finally {
      db.close();
    }
  });
