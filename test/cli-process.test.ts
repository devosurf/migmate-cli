import assert from "node:assert/strict";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stringify as stringifyToml } from "smol-toml";
import { CLI_JOB_CONFIG, CLI_ARCHIVE_CONFIG, FIXTURE_TIME } from "./cli-fixture.ts";
import type { JobEvent, JobStatus, JobType, PlanRevision, RowPage } from "../src/engine/index.ts";

interface WireEvent extends JobEvent {
  schemaVersion: number;
  commandId: string;
}
interface Document<T> {
  ok: boolean;
  value: T;
  refusal?: { code: string };
}
interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
interface DestinationRecord {
  id: string;
  name: string;
  kind: string;
  content: string;
}
interface Running {
  child: ChildProcessWithoutNullStreams;
  events: WireEvent[];
  done: Promise<ChildResult>;
  event(predicate: (event: WireEvent) => boolean, timeoutMs?: number): Promise<WireEvent>;
  checkpoint(predicate: (event: WireEvent) => boolean): Promise<WireEvent>;
  release(): Promise<void>;
}
function assertPiped(child: ChildProcess): asserts child is ChildProcessWithoutNullStreams {
  assert.ok(child.stdin);
  assert.ok(child.stdout);
  assert.ok(child.stderr);
}
function setup(t: TestContext, type: JobType = "file_migration", signal = t.signal) {
  const root = mkdtempSync(join(tmpdir(), "migmate-cli-process-"));
  const home = join(root, "home");
  const destination = join(root, "destination.json");
  const config = join(root, "input.toml");
  writeFileSync(
    config,
    stringifyToml(type === "teams_archive" ? CLI_ARCHIVE_CONFIG : CLI_JOB_CONFIG),
  );
  let now = Date.parse(FIXTURE_TIME);
  const destinationRecords = (): DestinationRecord[] =>
    existsSync(destination) ? JSON.parse(readFileSync(destination, "utf8")) : [];
  const children = new Set<Running>();
  const abort = () => {
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  signal.addEventListener("abort", abort, { once: true });
  t.after(async () => {
    signal.removeEventListener("abort", abort);
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all([...children].map((running) => running.done));
    rmSync(root, { recursive: true, force: true });
  });
  const start = (argv: string[], held = false): Running => {
    signal.throwIfAborted();
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./cli-process-fixture.ts", import.meta.url)), ...argv],
      {
        env: {
          ...process.env,
          CLI_TEST_HOME: home,
          CLI_TEST_DESTINATION: destination,
          CLI_TEST_HOLD: held ? "1" : "0",
          CLI_TEST_NOW: new Date(now).toISOString(),
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
    assertPiped(child);
    const emitter = new EventEmitter();
    const events: WireEvent[] = [];
    let stdout = "",
      stderr = "",
      pending = "",
      exited = false;
    let checkpoint = false;
    child.on("message", (message) => {
      if (message === "checkpoint") {
        checkpoint = true;
        emitter.emit("event");
      }
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (!line.trim()) continue;
        const value = JSON.parse(line);
        if (typeof value.cursor === "number") {
          events.push(value);
          emitter.emit("event", value);
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let spawnError: Error | undefined;
    const done = new Promise<ChildResult>((resolve) => {
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code, signal) => {
        exited = true;
        emitter.emit("exit");
        resolve({ code, signal, stdout, stderr });
      });
    });
    const failure = (reason: string) =>
      new Error(
        `${reason}${signal.aborted ? ` (${signal.reason})` : ""}: pid=${child.pid} code=${child.exitCode} signal=${child.signalCode}` +
          ` stdout=${stdout} stderr=${stderr} spawnError=${spawnError?.message ?? ""}`,
      );
    const waitFor = async <T>(
      description: string,
      ready: () => T | undefined,
      timeoutMs = 30000,
    ): Promise<T> => {
      const prior = ready();
      if (prior !== undefined) return prior;
      if (exited) throw failure(`Child exited before ${description}`);
      return new Promise<T>((resolve, reject) => {
        const onEvent = () => {
          const value = ready();
          if (value !== undefined) {
            cleanup();
            resolve(value);
          }
        };
        const onExit = () => {
          cleanup();
          reject(failure(`Child exited before ${description}`));
        };
        const timer = setTimeout(async () => {
          cleanup();
          child.kill("SIGKILL");
          await done;
          reject(failure(`Timed out waiting for ${description}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          emitter.off("event", onEvent);
          emitter.off("exit", onExit);
        };
        emitter.on("event", onEvent);
        emitter.once("exit", onExit);
      });
    };
    const running: Running = {
      child,
      events,
      done,
      event: (predicate, timeoutMs) =>
        waitFor("durable event", () => events.find(predicate), timeoutMs),
      async checkpoint(predicate) {
        const event = await waitFor("durable event", () => events.find(predicate));
        await waitFor("held provider operation", () => checkpoint || undefined);
        if (exited) throw failure("Child exited before held checkpoint");
        return event;
      },
      release: () =>
        new Promise<void>((resolve, reject) => {
          child.send("release", (error) => (error ? reject(error) : resolve()));
        }),
    };
    children.add(running);
    return running;
  };
  const command = async <T>(argv: string[]): Promise<Document<T>> => {
    const result = await start([...argv, "--output", "json"]).done;
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  };
  const approve = async () => {
    const init = await command<{ id: string }>(["init", "--type", type, "--config", config]);
    assert.equal(init.ok, true);
    const id = init.value.id;
    const plan = await command<PlanRevision>(["plan", "--job", id]);
    const approval = await command<{ planDigest: string }>([
      "approve",
      "--job",
      id,
      "--approver",
      "ci:process-contract",
      "--plan-digest",
      plan.value.planDigest,
    ]);
    assert.equal(approval.value.planDigest, plan.value.planDigest);
    return id;
  };
  const reclaimKilledWriter = async (id: string, observed: WireEvent[]) => {
    const before = await command<JobStatus>(["status", "--job", id]);
    assert.equal(before.value.state, "executing");
    assert.equal(before.value.ownership.held, true);
    assert.notEqual(before.value.lastCheckpoint, null);
    const replay = start(["status", "--job", id, "--output", "jsonl"]);
    assert.equal((await replay.done).code, 0);
    assert.equal(
      replay.events.filter((event) => event.verb === "execute" && event.kind === "terminal").length,
      0,
    );
    for (const event of observed) {
      const durable = replay.events.find((candidate) => candidate.cursor === event.cursor);
      assert.ok(durable);
      assert.deepEqual(durable.payload, event.payload);
      assert.equal(durable.kind, event.kind);
    }
    const fresh = await start(["execute", "--job", id, "--output", "json"]).done;
    assert.equal(fresh.code, 3, fresh.stdout);
    assert.equal(JSON.parse(fresh.stdout).refusal.code, "lease_held");
    // Advance only the injected engine clock. The owner is a real dead process;
    // production's thirty-second expiry remains required for automatic takeover.
    now += 30_001;
    await command(["report", "--job", id]);
    const recovered = start(["status", "--job", id, "--output", "jsonl"]);
    assert.equal((await recovered.done).code, 0);
    assert.deepEqual(recovered.events.find((event) => event.payload.reclaimed === true)?.payload, {
      reclaimed: true,
      checkpoint: before.value.lastCheckpoint,
    });
    const ready = await command<JobStatus>(["status", "--job", id]);
    assert.equal(ready.value.state, "interrupted");
    assert.equal(ready.value.resumable, true);
    assert.equal(ready.value.ownership.held, false);
    assert.equal(ready.value.lastCheckpoint, before.value.lastCheckpoint);
  };
  return {
    root,
    home,
    destination,
    config,
    destinationRecords,
    start,
    command,
    approve,
    reclaimKilledWriter,
  };
}

for (const type of ["file_migration", "teams_archive"] as const) {
  it(
    `test cancellation reaps the held ${type} child and removes its fixture`,
    { timeout: 10000 },
    async (t) => {
      let root = "";
      await t.test("cancelled fixture", async (childTest) => {
        const controller = new AbortController();
        const h = setup(childTest, type, controller.signal);
        root = h.root;
        const id = await h.approve();
        const running = h.start(["execute", "--job", id, "--output", "jsonl"], true);
        await running.checkpoint((event) => event.kind === "unit_committed");
        const readiness = running.event(() => false);
        controller.abort(new Error("Test timed out"));
        await assert.rejects(
          readiness,
          /Test timed out.*signal=SIGKILL.*stdout=.*unit_committed.*stderr=/s,
        );
        assert.equal((await running.done).signal, "SIGKILL");
        assert.throws(() => process.kill(running.child.pid!, 0), { code: "ESRCH" });
      });
      assert.equal(existsSync(root), false);
    },
  );
}

it(
  "readiness rejects promptly on child exit with exit and output evidence",
  { timeout: 10000 },
  async (t) => {
    const h = setup(t);
    const running = h.start(["status", "--output", "jsonl"]);
    await assert.rejects(
      running.event((event) => event.kind === "mapping_progress"),
      /Child exited before durable event.*code=2.*signal=null.*stdout=.*usage.*stderr=/s,
    );
    assert.equal((await running.done).code, 2);
  },
);

it(
  "readiness timeout kills a held child and reports its checkpoint output",
  { timeout: 10000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const running = h.start(["execute", "--job", id, "--output", "jsonl"], true);
    await running.checkpoint(
      (event) => event.kind === "mapping_progress" && event.payload.files === 1,
    );
    await assert.rejects(
      running.event(() => false, 20),
      /Timed out waiting for durable event.*signal=SIGKILL.*stdout=.*mapping_progress.*stderr=/s,
    );
    assert.equal((await running.done).signal, "SIGKILL");
  },
);

for (const type of ["file_migration", "teams_archive"] as const) {
  it(
    `a delayed parent retains the ${type} executing checkpoint and writer`,
    { timeout: 30000 },
    async (t) => {
      const h = setup(t, type);
      const id = await h.approve();
      const running = h.start(["execute", "--job", id, "--output", "jsonl"], true);
      await running.checkpoint((event) => event.kind === "unit_committed");
      // Deliberately exceed the old fixture's 300ms * 8 auto-release window.
      // This is the regression stimulus, not synchronization or a longer fixture delay.
      await delay(3000, undefined, { signal: t.signal });
      const status = await h.command<JobStatus>(["status", "--job", id]);
      assert.equal(status.value.state, "executing");
      assert.equal(status.value.ownership.held, true);
      assert.equal(status.value.ownership.pid, running.child.pid);
      assert.equal(status.value.ownership.heldByThisProcess, false);
      running.child.kill("SIGINT");
      assert.equal((await running.done).code, 130);
    },
  );
}

for (const type of ["file_migration", "teams_archive"] as const) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(
      `long ${type} plan releases its lease within 10 seconds after ${signal}`,
      { timeout: 30000 },
      async (t) => {
        const h = setup(t, type);
        const init = await h.command<{ id: string }>([
          "init",
          "--type",
          type,
          "--config",
          h.config,
        ]);
        const id = init.value.id;
        const running = h.start(["plan", "--job", id, "--output", "jsonl"], true);
        await running.checkpoint(
          (event) => event.verb === "plan" && event.kind === "phase_started",
        );
        // The child has its own real event loop; a platform-clock deadline catches ignored signals.
        const deadline = setTimeout(() => running.child.kill("SIGKILL"), 10000);
        t.after(() => clearTimeout(deadline));
        running.child.kill(signal);
        const stopped = await running.done;
        clearTimeout(deadline);
        assert.equal(stopped.code, signal === "SIGINT" ? 130 : 143, stopped.stdout);
        assert.equal(stopped.signal, null);
        assert.equal(stopped.stderr, "");
        const status = await h.command<JobStatus>(["status", "--job", id]);
        assert.equal(status.value.ownership.held, false);
        const plan = await h.command<PlanRevision>(["plan", "--job", id]);
        assert.ok(plan.value.planDigest);
      },
    );
  }
}

it(
  "SIGINT checkpoints before exit130; resume emits one new terminal and no duplicate writes",
  { timeout: 120000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const first = h.start(["execute", "--job", id, "--output", "jsonl"], true);
    const progress = await first.checkpoint(
      (event) => event.kind === "mapping_progress" && event.payload.files === 1,
    );
    assert.equal(first.events.find((event) => event.kind === "mapping_progress")?.payload.files, 1);
    assert.equal(progress.payload.mappingId, "map-1");
    assert.equal(progress.payload.bytes, 9);
    assert.equal(progress.payload.errors, 0);
    assert.equal(typeof progress.payload.speed, "number");
    first.child.kill("SIGINT");
    const stopped = await first.done;
    assert.equal(stopped.code, 130);
    assert.equal(stopped.stderr, "");
    const terminals = first.events.filter((event) => event.kind === "terminal");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.payload.state, "interrupted");
    assert.equal(terminals[0]?.payload.resumable, true);
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(status.value.state, "interrupted");
    assert.equal(status.value.resumable, true);
    assert.notEqual(status.value.lastCheckpoint, null);
    assert.equal(status.value.mappingPasses[0]?.status, "interrupted");
    assert.equal(status.value.worker.active, false);
    const resumed = h.start(["execute", "--job", id, "--output", "jsonl"]);
    const finished = await resumed.done;
    assert.equal(finished.code, 0, finished.stdout);
    assert.equal(finished.stderr, "");
    assert.deepEqual(
      resumed.events
        .filter((event) => event.kind === "terminal")
        .map((event) => event.payload.state),
      ["completed"],
    );
    const destination: Array<{ id: string; name: string; kind: string }> = JSON.parse(
      readFileSync(h.destination, "utf8"),
    );
    assert.equal(destination.filter((row) => row.kind === "file").length, 8);
    assert.equal(new Set(destination.map((row) => row.id)).size, destination.length);
    assert.equal(new Set(destination.map((row) => row.name)).size, destination.length);
    const cursor = first.events.at(-1)!.cursor;
    const replay = h.start(["status", "--job", id, "--output", "jsonl", "--from", String(cursor)]);
    assert.equal((await replay.done).code, 0);
    assert.ok(replay.events.every((event) => event.cursor > cursor));
    assert.deepEqual(
      replay.events.map(({ cursor, verb, kind, phase, payload }) => ({
        cursor,
        verb,
        kind,
        phase,
        payload,
      })),
      resumed.events.map(({ cursor, verb, kind, phase, payload }) => ({
        cursor,
        verb,
        kind,
        phase,
        payload,
      })),
    );
  },
);

it(
  "a broken stdout pipe aborts the run, persists its checkpoint, then exits141",
  { timeout: 120000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const running = h.start(["execute", "--job", id, "--output", "jsonl"], true);
    await running.checkpoint(
      (event) => event.verb === "execute" && event.kind === "unit_committed",
    );
    running.child.stdout.destroy();
    await running.release();
    const stopped = await running.done;
    assert.equal(stopped.code, 141);
    assert.equal(stopped.stderr, "");
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(status.value.state, "interrupted");
    assert.equal(status.value.resumable, true);
    assert.notEqual(status.value.lastCheckpoint, null);
    assert.equal(status.value.ownership.held, false);
    const replay = h.start(["status", "--job", id, "--output", "jsonl"]);
    assert.equal((await replay.done).code, 0);
    assert.deepEqual(
      replay.events
        .filter((event) => event.kind === "terminal")
        .map((event) => event.payload.state),
      ["interrupted"],
    );
  },
);

it(
  "a second actual process reads status without acquiring the executing writer's lease",
  { timeout: 120000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const running = h.start(["execute", "--job", id, "--output", "jsonl"], true);
    await running.checkpoint(
      (event) => event.verb === "execute" && event.kind === "unit_committed",
    );
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(status.value.state, "executing");
    assert.equal(status.value.ownership.held, true);
    assert.equal(status.value.ownership.pid, running.child.pid);
    assert.equal(status.value.ownership.heldByThisProcess, false);
    await running.release();
    assert.equal((await running.done).code, 0);
  },
);

it(
  "SIGKILL leaves durable commits replayable and a clean resume has no duplicate destination objects",
  { timeout: 120000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const running = h.start(["execute", "--job", id, "--output", "jsonl"], true);
    await running.checkpoint(
      (event) => event.kind === "mapping_progress" && event.payload.files === 1,
    );
    running.child.kill("SIGKILL");
    assert.equal((await running.done).signal, "SIGKILL");
    const prior = h.destinationRecords();
    assert.ok(
      prior.some(
        (row) => row.kind === "file" && row.name === "0.txt" && row.content === "content-0",
      ),
    );
    await h.reclaimKilledWriter(id, running.events);
    const interrupted = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(interrupted.value.mappingPasses[0]?.status, "interrupted");
    const resumed = h.start(["execute", "--job", id, "--output", "jsonl"]);
    const done = await resumed.done;
    assert.equal(done.code, 0, done.stdout);
    assert.equal(done.stderr, "");
    assert.deepEqual(
      resumed.events
        .filter((event) => event.kind === "terminal")
        .map((event) => event.payload.state),
      ["completed"],
    );
    const after = h.destinationRecords();
    for (const row of prior) {
      const resumedRow = after.find((candidate) => candidate.name === row.name);
      assert.equal(resumedRow?.id, row.id);
      assert.equal(resumedRow?.content, row.content);
    }
    assert.equal(after.filter((row) => row.kind === "file").length, 8);
    assert.equal(new Set(after.map((row) => row.name)).size, after.length);
    assert.equal(new Set(after.map((row) => row.id)).size, after.length);
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.deepEqual(
      status.value.mappingPasses.map((pass) => [pass.passNumber, pass.status]),
      [
        [1, "interrupted"],
        [2, "completed"],
      ],
    );
    assert.equal(status.value.mappingPasses[1]?.lastStats?.files, 7);
  },
);

it(
  "the actual source bin symlink initializes structured output for usage failures",
  { timeout: 30000 },
  async (t) => {
    const h = setup(t);
    const shim = join(h.root, "migmate");
    const source = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
    symlinkSync(source, shim);
    const child = spawn(shim, ["status", "--output", "json"], {
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
      stdio: "pipe",
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 2);
    assert.equal(stderr, "");
    const doc = JSON.parse(stdout);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.refusal.code, "usage");
  },
);

for (const stop of ["SIGINT", "SIGKILL", "EPIPE"] as const) {
  it(
    `Teams archive ${stop} and resume preserve durable records with one terminal per attempt`,
    { timeout: 120000 },
    async (t) => {
      const h = setup(t, "teams_archive");
      const id = await h.approve();
      const running = h.start(["execute", "--job", id, "--output", "jsonl"], true);
      await running.checkpoint(
        (event) => event.verb === "execute" && event.kind === "unit_committed",
      );
      const status = await h.command<JobStatus>(["status", "--job", id]);
      assert.equal(status.value.state, "executing");
      assert.equal(status.value.ownership.held, true);
      assert.equal(status.value.ownership.pid, running.child.pid);
      assert.equal(status.value.ownership.heldByThisProcess, false);
      if (stop === "EPIPE") {
        running.child.stdout.destroy();
        await running.release();
      } else running.child.kill(stop);
      const stopped = await running.done;
      assert.equal(stopped.stderr, "");
      if (stop === "SIGKILL") {
        assert.equal(stopped.signal, "SIGKILL");
        await h.reclaimKilledWriter(id, running.events);
      } else {
        assert.equal(stopped.code, stop === "SIGINT" ? 130 : 141);
        const checkpoint = await h.command<JobStatus>(["status", "--job", id]);
        assert.equal(checkpoint.value.state, "interrupted");
        assert.equal(checkpoint.value.resumable, true);
        assert.notEqual(checkpoint.value.lastCheckpoint, null);
        assert.equal(checkpoint.value.ownership.held, false);
      }
      if (stop === "SIGINT")
        assert.deepEqual(
          running.events
            .filter((event) => event.kind === "terminal")
            .map((event) => event.payload.state),
          ["interrupted"],
        );
      const resumed = h.start(["execute", "--job", id, "--output", "jsonl"]);
      const completed = await resumed.done;
      assert.equal(completed.code, 0, completed.stdout);
      assert.equal(completed.stderr, "");
      assert.deepEqual(
        resumed.events
          .filter((event) => event.kind === "terminal")
          .map((event) => event.payload.state),
        ["completed"],
      );
      const verification = await h.command<{ findings: Array<{ code: string }> }>([
        "verify",
        "--job",
        id,
      ]);
      assert.equal(
        verification.value.findings.some((finding) =>
          ["record_duplicated", "record_count_mismatch", "record_unrendered"].includes(
            finding.code,
          ),
        ),
        false,
      );
      const review = await h.command<{ review: RowPage }>([
        "status",
        "--job",
        id,
        "--phase",
        "execute",
        "--code",
        "collected",
      ]);
      assert.equal(review.value.review.totalRows, 1);
      const conversation = review.value.review.rows[0];
      assert.ok(conversation && conversation.jobType === "teams_archive");
      assert.equal(conversation.records, 8);
    },
  );
}
