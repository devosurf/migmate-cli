import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { openEngine, type Engine, type JobEvent, type JobRef } from "../src/engine/index.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import type {
  CopyPassReference,
  CopyPassStats,
  CopyPassStatus,
} from "../src/engine/providers/port.ts";
import { approve, fileConfig, fileFixture, value } from "./engine-fixture.ts";
import type { FileMigrationConfig } from "../src/engine/drivers/file-migration.ts";
import { createProtocolHandler } from "../src/web/protocol.ts";
import { WebSession } from "../src/web/session.ts";

interface Observation {
  at: number;
  status?: CopyPassStatus;
  stats?: Partial<CopyPassStats>;
  observe?: () => void;
}

interface Harness {
  engine: Engine;
  ref: JobRef;
  home: string;
  port: FakeFileMigrationPort;
}

async function harness(
  t: TestContext,
  observations: Observation[],
  config: FileMigrationConfig = fileConfig(),
  input: FakeFileMigrationFixture = fileFixture([
    { id: "file", parentId: "source-root", name: "file.txt", kind: "file", content: "hello" },
  ]),
  waitForConsistency?: () => Promise<void>,
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "migmate-progress-"));
  const port = new FakeFileMigrationPort(input);
  let time = 0;
  const polls = new Map<number, { index: number; startedAt: number }>();
  const stats = port.copyPassStats.bind(port);
  t.mock.method(
    port,
    "copyPassStatus",
    async (reference: CopyPassReference): Promise<CopyPassStatus> => {
      let poll = polls.get(reference.pass.jobid);
      if (!poll) {
        poll = { index: 0, startedAt: time };
        polls.set(reference.pass.jobid, poll);
      }
      const observation = observations[poll.index];
      assert.ok(observation, "unexpected provider poll");
      time = Math.max(time, poll.startedAt + observation.at);
      return observation.status ?? { state: "running", error: null };
    },
  );
  t.mock.method(port, "copyPassStats", async (reference: CopyPassReference) => {
    const poll = polls.get(reference.pass.jobid)!;
    const observation = observations[poll.index++]!;
    observation.observe?.();
    return { ...(await stats(reference)), ...observation.stats };
  });
  const engine = openEngine({
    home,
    now: () => new Date(Date.UTC(2026, 8, 1) + time),
    provider: port,
    ...(waitForConsistency ? { waitForConsistency } : {}),
  });
  t.after(async () => {
    engine.close();
    await rm(home, { recursive: true, force: true });
  });
  const ref = value(await engine.initJob({ type: "file_migration", config }));
  await approve({ engine, ref });
  return { engine, ref, home, port };
}

async function events(h: Harness) {
  const result: JobEvent[] = [];
  for await (const event of h.engine.reader(h.ref).events({})) result.push(event);
  return result;
}

describe("durable mapping progress", () => {
  it("coalesces routine observations before committing, independently of poll frequency", async (t) => {
    const histories = [];
    for (const interval of [1000, 500]) {
      const observations: Observation[] = Array.from({ length: 20000 / interval + 1 }, (_, i) => ({
        at: i * interval,
        stats: { bytes: i * interval, files: 1, errors: 0 },
      }));
      observations.push({ at: 21000, status: { state: "completed", error: null } });
      const h = await harness(t, observations);
      assert.equal(
        value(await h.engine.withWriterResult(h.ref, (w) => w.execute())).outcome,
        "completed",
      );
      const history = await events(h);
      const progress = history.filter((event) => event.kind === "mapping_progress");
      assert.deepEqual(
        progress.map((event) => event.payload.bytes),
        [0, 10000, 20000, 5],
      );
      assert.deepEqual(
        progress.map((event) => event.payload.status),
        ["running", "running", "running", "completed"],
      );
      const commits = history.filter(
        (event) =>
          event.kind === "unit_committed" &&
          event.phase === "execute" &&
          String(event.payload.unitKey).startsWith('["mapping",'),
      );
      assert.equal(commits.length, 6, "only pending, start, three samples and completion commit");
      const database = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"), {
        readOnly: true,
      });
      try {
        assert.equal(
          database
            .prepare(
              "SELECT count(*) AS count FROM commit_log WHERE phase = 'execute' AND unit_key LIKE '[\"mapping\",%'",
            )
            .get()?.count,
          6,
        );
      } finally {
        database.close();
      }
      histories.push(history.length);
    }
    assert.equal(histories[0], histories[1], "more polls do not grow durable history");
  });
  it("bounds in-flight detail in snapshots and events without truncating counters", async (t) => {
    const transferring = Array.from({ length: 8 }, (_, i) => ({
      path: `file-${i}.txt`,
      bytes: i,
      size: 100,
    }));
    const h = await harness(t, [
      { at: 0, stats: { transferring } },
      {
        at: 100,
        status: { state: "completed", error: null },
        stats: {
          transferring,
          bytes: 1000,
          files: 100,
          errors: 0,
          speed: 200,
        },
      },
    ]);
    await h.engine.withWriterResult(h.ref, (w) => w.execute());
    const expected = {
      transferring: transferring.slice(0, 5),
      transferringTotal: 8,
      transferringTruncated: true,
      bytes: 1000,
      files: 100,
      errors: 0,
      speed: 200,
    };
    assert.deepEqual(
      value(await h.engine.reader(h.ref).status()).mappingPasses[0]?.lastStats,
      expected,
    );
    const progress = (await events(h)).filter((event) => event.kind === "mapping_progress");
    assert.equal(progress.length, 2, "short passes retain both first and final stats");
    assert.deepEqual(progress.at(-1)?.payload, {
      mappingId: "mapping",
      passNumber: 1,
      status: "completed",
      error: null,
      ...expected,
    });
  });
  it("captures changed error counts and messages immediately inside the routine window", async (t) => {
    const h = await harness(t, [
      { at: 0, stats: { errors: 0 } },
      { at: 100, stats: { errors: 1 } },
      { at: 200, stats: { errors: 1 } },
      { at: 300, stats: { errors: 1 }, status: { state: "running", error: "new error evidence" } },
      { at: 400, stats: { errors: 1 }, status: { state: "running", error: "new error evidence" } },
      { at: 500, stats: { errors: 2 }, status: { state: "failed", error: "pass failed" } },
    ]);
    assert.equal(
      value(await h.engine.withWriterResult(h.ref, (w) => w.execute())).outcome,
      "blocked",
    );
    const progress = (await events(h)).filter((event) => event.kind === "mapping_progress");
    assert.deepEqual(
      progress.map((event) => [event.at, event.payload.errors, event.payload.status]),
      [
        ["2026-09-01T00:00:00.000Z", 0, "running"],
        ["2026-09-01T00:00:00.100Z", 1, "running"],
        ["2026-09-01T00:00:00.300Z", 1, "running"],
        ["2026-09-01T00:00:00.500Z", 2, "failed"],
      ],
    );
    assert.equal(progress[2]?.payload.error, "new error evidence");
    assert.equal(
      value(await h.engine.reader(h.ref).status()).mappingPasses[0]?.error,
      "pass failed",
    );
  });
  for (const terminal of ["interrupted", "failed"] as const) {
    it(`retains suppressed final stats on ${terminal}, replays live events and resumes`, async (t) => {
      const controller = new AbortController();
      const observations: Observation[] = [
        { at: 0, stats: { bytes: 1, errors: 0 } },
        { at: 100, stats: { bytes: 2, errors: 0 } },
        {
          at: 200,
          stats: { bytes: 3, errors: 0 },
          ...(terminal === "interrupted"
            ? { observe: () => controller.abort() }
            : { status: { state: "failed", error: "copy failed" } satisfies CopyPassStatus }),
        },
      ];
      const h = await harness(t, observations);
      const cursor = (await events(h)).at(-1)!.cursor;
      const live: JobEvent[] = [];
      const collecting = (async () => {
        for await (const event of h.engine.reader(h.ref).events({
          from: cursor,
          follow: true,
          signal: AbortSignal.timeout(10000),
        })) {
          live.push(event);
          if (event.kind === "terminal") break;
        }
      })();
      const result = value(
        await h.engine.withWriterResult(h.ref, (w) => w.execute({ signal: controller.signal })),
      );
      assert.equal(result.outcome, terminal === "failed" ? "blocked" : "interrupted");
      await collecting;
      const progress = live.filter((event) => event.kind === "mapping_progress");
      assert.deepEqual(
        progress.map((event) => [event.payload.status, event.payload.bytes]),
        [
          ["running", 1],
          [terminal, 3],
        ],
      );
      assert.deepEqual(
        live,
        (await events(h)).filter((event) => event.cursor > cursor),
      );
      const replay: JobEvent[] = [];
      for await (const event of h.engine.reader(h.ref).events({ from: progress[0]!.cursor }))
        replay.push(event);
      assert.deepEqual(
        replay,
        live.filter((event) => event.cursor > progress[0]!.cursor),
      );
      const status = value(await h.engine.reader(h.ref).status());
      assert.equal(status.mappingPasses[0]?.lastStats?.bytes, 3);
      assert.equal(status.uploadActivity?.accounts[0]?.observedBytesInWindow, 3);
      if (terminal === "interrupted")
        assert.ok(
          status.uploadActivity?.accounts[0]?.gaps.some(
            (gap) => gap.reason === "terminal_counter_unavailable_after_stop",
          ),
        );
      assert.equal(status.mappingPasses[0]?.lastStats?.transferringTotal, 0);
      assert.equal(status.mappingPasses[0]?.lastStats?.transferringTruncated, false);
      assert.equal(status.worker.active, false);
      const session = new WebSession({ engine: h.engine, job: h.ref });
      const handle = createProtocolHandler({ session });
      const html = await (
        await handle(new Request("migmate://localhost/view?stage=status"))
      ).text();
      assert.match(html, new RegExp(terminal));
      await session.close();
      const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
      const json = await readFile(
        report.artifacts.find((artifact) => artifact.name === "report.json")!.path,
        "utf8",
      );
      assert.match(json, /transferringTotal/);
      assert.match(json, new RegExp(terminal));
      observations.splice(
        0,
        observations.length,
        { at: 0, stats: { errors: 0 } },
        { at: 100, status: { state: "completed", error: null } },
      );
      assert.equal(
        value(await h.engine.withWriterResult(h.ref, (w) => w.execute())).outcome,
        "completed",
      );
      assert.deepEqual(
        value(await h.engine.reader(h.ref).status()).mappingPasses.map((pass) => [
          pass.passNumber,
          pass.status,
        ]),
        [
          [1, terminal],
          [2, "completed"],
        ],
      );
    });
  }

  it("samples two concurrent mappings independently while polling both through suppressed rounds", async (t) => {
    const input = fileFixture([
      { id: "a", parentId: "source-root", name: "a", kind: "folder" },
      { id: "b", parentId: "source-root", name: "b", kind: "folder" },
      { id: "a-file", parentId: "a", name: "one.txt", kind: "file", content: "one" },
      { id: "b-file", parentId: "b", name: "two.txt", kind: "file", content: "two" },
    ]);
    input.destinationItems.push(
      { id: "dest-a", parentId: "destination-root", name: "a", kind: "folder" },
      { id: "dest-b", parentId: "destination-root", name: "b", kind: "folder" },
    );
    const config: FileMigrationConfig = {
      mappings: ["a", "b"].map((id) => ({
        ...fileConfig().mappings[0]!,
        id,
        sourceItemId: id,
        destFolderId: `dest-${id}`,
      })),
      options: { mappingsInFlight: 2 },
    };
    const observations: Observation[] = Array.from({ length: 12 }, (_, i) => ({
      at: i * 1000,
      stats: { bytes: i, errors: 0 },
    }));
    observations.push({ at: 12000, status: { state: "completed", error: null } });
    const h = await harness(t, observations, config, input);
    assert.equal(
      value(await h.engine.withWriterResult(h.ref, (w) => w.execute())).outcome,
      "completed",
    );
    const progress = (await events(h)).filter((event) => event.kind === "mapping_progress");
    assert.deepEqual(
      progress.map((event) => [event.payload.mappingId, event.payload.status, event.payload.bytes]),
      [
        ["a", "running", 0],
        ["b", "running", 0],
        ["a", "running", 10],
        ["b", "running", 10],
        ["a", "completed", 3],
        ["b", "completed", 3],
      ],
    );
  });

  it("starts fresh sampling for staged revisions and each final settle pass", async (t) => {
    let checks = 0;
    const observations: Observation[] = [
      { at: 0, stats: { errors: 0 } },
      { at: 100, stats: { errors: 0 } },
      { at: 200, status: { state: "completed", error: null } },
    ];
    const h = await harness(
      t,
      observations,
      {
        ...fileConfig(),
        options: { staged: true, consistencyIntervalMs: 0 },
      },
      undefined,
      async () => {
        if (checks++ === 0) h.port.mutateSourceItem("file", { content: "changed during settling" });
      },
    );
    assert.equal(
      value(await h.engine.withWriterResult(h.ref, (w) => w.execute())).outcome,
      "completed",
    );
    await approve(h);
    assert.equal(
      value(await h.engine.withWriterResult(h.ref, (w) => w.execute())).outcome,
      "completed",
    );
    const final = value(await h.engine.withWriterResult(h.ref, (w) => w.plan({ final: true })));
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.approve({
          approver: "operator",
          mode: "unattended",
          planDigest: final.planDigest,
          freeze: { by: "operator", at: "2026-09-01T00:00:00.000Z", how: "writers stopped" },
        }),
      ),
    );
    assert.equal(
      value(await h.engine.withWriterResult(h.ref, (w) => w.execute())).outcome,
      "completed",
    );
    const progress = (await events(h)).filter((event) => event.kind === "mapping_progress");
    assert.deepEqual(
      progress.map((event) => [event.payload.passNumber, event.payload.status]),
      [
        [1, "running"],
        [1, "completed"],
        [1, "running"],
        [1, "completed"],
        [1, "running"],
        [1, "completed"],
        [2, "running"],
        [2, "completed"],
      ],
    );
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.state, "verified");
    assert.equal(status.mappingPasses.at(-1)?.lastStats?.bytes, 23);
  });
  it("retains quota evidence immediately during a suppressed window without charging the failure budget", async (t) => {
    const error = "googleapi: Error 403: User rate limit exceeded., userRateLimitExceeded";
    const h = await harness(t, [
      { at: 0, stats: { bytes: 1, errors: 0 } },
      { at: 100, stats: { bytes: 2, errors: 0 } },
      { at: 200, stats: { bytes: 3, errors: 7 }, status: { state: "failed", error } },
    ]);
    const result = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    assert.equal(result.outcome, "blocked");
    assert.equal(result.budget?.failedAttempts, 0);
    assert.equal(result.uploadQuota?.hitAt, "2026-09-01T00:00:00.200Z");
    const pass = value(await h.engine.reader(h.ref).status()).mappingPasses[0]!;
    assert.equal(pass.lastStats?.errors, null);
    assert.equal(pass.lastStats?.rcloneErrors, 7);
    assert.equal(pass.lastStats?.bytes, 3);
    assert.equal(
      value(await h.engine.reader(h.ref).status()).uploadActivity?.accounts[0]
        ?.observedBytesInWindow,
      3,
    );
    assert.deepEqual(pass.uploadQuota, result.uploadQuota);
    const progress = (await events(h)).filter((event) => event.kind === "mapping_progress");
    assert.equal(progress.length, 2);
    assert.equal(progress[1]?.payload.errors, null);
    assert.equal(progress[1]?.payload.rcloneErrors, 7);
    assert.equal(progress[1]?.payload.error, error);
  });
});
