import assert from "node:assert/strict";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { stringify as stringifyToml } from "smol-toml";
import {
  CLI_JOB_CONFIG,
  CLI_REVERSE_JOB_CONFIG,
  CLI_REVERSE_MANIFEST,
  CLI_ARCHIVE_CONFIG,
  FIXTURE_TIME,
} from "./cli-fixture.ts";
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
  breakStdout(): Promise<void>;
}
function assertPiped(child: ChildProcess): asserts child is ChildProcessWithoutNullStreams {
  assert.ok(child.stdin);
  assert.ok(child.stdout);
  assert.ok(child.stderr);
}
function setup(
  t: TestContext,
  type: JobType = "file_migration",
  signal = t.signal,
  fileConfig: typeof CLI_JOB_CONFIG | typeof CLI_REVERSE_JOB_CONFIG = CLI_JOB_CONFIG,
) {
  const root = mkdtempSync(join(tmpdir(), "migmate-cli-process-"));
  const home = join(root, "home");
  const destination = join(root, "destination.json");
  const config = join(root, "input.toml");
  writeFileSync(config, stringifyToml(type === "teams_archive" ? CLI_ARCHIVE_CONFIG : fileConfig));
  let now = Date.parse(FIXTURE_TIME);
  const destinationRecords = (): DestinationRecord[] =>
    existsSync(destination) ? JSON.parse(readFileSync(destination, "utf8")) : [];
  const children = new Set<Running>();
  const detached = new Set<number>();
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
      throw error;
    }
  };
  const reapDetached = async (pid: number) => {
    for (let attempt = 0; attempt < 300 && !gone(pid); attempt++) await delay(20);
    assert.ok(gone(pid), `Detached coordinator ${pid} did not exit`);
    detached.delete(pid);
  };
  const abort = () => {
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  signal.addEventListener("abort", abort, { once: true });
  t.after(async () => {
    signal.removeEventListener("abort", abort);
    for (const pid of detached) if (!gone(pid)) process.kill(pid, "SIGTERM");
    for (const pid of detached) await reapDetached(pid);
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all([...children].map((running) => running.done));
    rmSync(root, { recursive: true, force: true });
  });
  const start = (
    argv: string[],
    held = false,
    blockOnAbort = false,
    admissionMarker = "",
  ): Running => {
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
          CLI_TEST_BLOCK_ON_ABORT: blockOnAbort ? "1" : "",
          CLI_TEST_ADMISSION_MARKER: admissionMarker,
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        detached: true,
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
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "migmate:launch-ready"
      )
        child.send({ type: "migmate:launch", detached: false });
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
        if (value.ok && value.value?.detached && typeof value.value.pid === "number")
          detached.add(value.value.pid);
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
      async breakStdout() {
        const closed = once(child.stdout, "close");
        child.stdout.destroy();
        await closed;
        // Provoke a real OS EPIPE while provider work remains held. Releasing
        // the whole pass could finish it before the JSONL follower writes again.
        await new Promise<void>((resolve, reject) => {
          child.send("write-stdout", (error) => (error ? reject(error) : resolve()));
        });
      },
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
    if (type === "file_migration" && fileConfig.sourceProvider === "google_shared_drive") {
      const manifest = join(root, "reverse.json");
      writeFileSync(manifest, JSON.stringify(CLI_REVERSE_MANIFEST));
      await command(["manifest", "load", "--job", id, "--file", manifest]);
    }
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
    reapDetached,
    trackDetached: (pid: number) => detached.add(pid),
  };
}

for (const [direction, config] of [
  ["forward", CLI_JOB_CONFIG],
  ["reverse", CLI_REVERSE_JOB_CONFIG],
] as const) {
  it(`runs the real CLI from plan through close with ${direction} providers`, async (t) => {
    const h = setup(t, "file_migration", t.signal, config);
    const id = await h.approve();
    await h.command(["execute", "--job", id]);
    await h.command(["verify", "--job", id]);
    const ready = await h.command<JobStatus>(["status", "--job", id]);
    assert.ok(ready.value.closeReview);
    await h.command([
      "close",
      "--job",
      id,
      "--close-digest",
      ready.value.closeReview.evidenceDigest,
      "--approver",
      "ci:process-contract",
    ]);
    const closed = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(closed.value.state, "closed");
    assert.equal(h.destinationRecords().filter((item) => item.kind === "file").length, 8);
  });
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
  for (const stop of ["SIGINT", "EPIPE"] as const) {
    it(
      `a delayed parent retains the ${type} executing checkpoint and writer before ${stop}`,
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
        if (stop === "EPIPE") await running.breakStdout();
        else running.child.kill(stop);
        const stopped = await running.done;
        assert.equal(stopped.code, stop === "SIGINT" ? 130 : 141, JSON.stringify(stopped));
        const interrupted = await h.command<JobStatus>(["status", "--job", id]);
        assert.equal(interrupted.value.state, "interrupted");
        assert.equal(interrupted.value.ownership.held, false);
      },
    );
  }
}

for (const type of ["file_migration", "teams_archive"] as const) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
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
        assert.equal(
          stopped.code,
          signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143,
          stopped.stdout,
        );
        assert.equal(stopped.signal, null);
        assert.equal(stopped.stderr, "");
        const status = await h.command<JobStatus>(["status", "--job", id]);
        assert.equal(status.value.ownership.held, false);
        assert.equal(status.value.currentPlan, null);
        const plan = await h.command<PlanRevision>(["plan", "--job", id]);
        assert.ok(plan.value.planDigest);
      },
    );
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  it(
    `${signal} checkpoints before exit; resume emits one new terminal and no duplicate writes`,
    { timeout: 120000 },
    async (t) => {
      const h = setup(t);
      const id = await h.approve();
      const first = h.start(["execute", "--job", id, "--output", "jsonl"], true);
      const progress = await first.checkpoint(
        (event) => event.kind === "mapping_progress" && event.payload.files === 1,
      );
      assert.equal(
        first.events.find((event) => event.kind === "mapping_progress")?.payload.files,
        1,
      );
      assert.equal(progress.payload.mappingId, "map-1");
      assert.equal(progress.payload.bytes, 9);
      assert.equal(progress.payload.errors, 0);
      assert.equal(typeof progress.payload.speed, "number");
      first.child.kill(signal);
      const stopped = await first.done;
      assert.equal(stopped.code, signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
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
      assert.equal(status.value.ownership.held, false);
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
      const replay = h.start([
        "status",
        "--job",
        id,
        "--output",
        "jsonl",
        "--from",
        String(cursor),
      ]);
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
      const completed = await h.command<JobStatus>(["status", "--job", id]);
      assert.deepEqual(
        completed.value.mappingPasses.map((pass) => pass.status),
        ["interrupted", "completed"],
      );
      assert.equal(completed.value.mappingPasses[1]?.lastStats?.files, 7);
      const records = h.destinationRecords();
      await h.command(["execute", "--job", id]);
      const repeated = await h.command<JobStatus>(["status", "--job", id]);
      assert.deepEqual(repeated.value.mappingPasses, completed.value.mappingPasses);
      assert.deepEqual(h.destinationRecords(), records);
    },
  );
}

it("SIGHUP exits129 after cleanup even when stdout cannot flush", { timeout: 30000 }, async (t) => {
  const h = setup(t);
  const id = await h.approve();
  const running = h.start(["execute", "--job", id, "--output", "jsonl"], true, true);
  await running.checkpoint(
    (event) => event.kind === "mapping_progress" && event.payload.files === 1,
  );
  running.child.stdout.pause();
  running.child.once("exit", () => running.child.stdout.resume());
  // A real subprocess's pending OS pipe write cannot be tested with a fake clock.
  const deadline = setTimeout(() => running.child.kill("SIGKILL"), 15000);
  t.after(() => clearTimeout(deadline));
  running.child.kill("SIGHUP");
  const stopped = await running.done;
  clearTimeout(deadline);
  assert.equal(stopped.code, 129);
  assert.equal(stopped.signal, null);
  const status = await h.command<JobStatus>(["status", "--job", id]);
  assert.equal(status.value.state, "interrupted");
  assert.equal(status.value.resumable, true);
  assert.equal(status.value.worker.active, false);
  assert.equal(status.value.ownership.held, false);
  assert.equal((await h.start(["execute", "--job", id, "--output", "json"]).done).code, 0);
});

it(
  "SIGHUP during verification publishes no successful verification",
  { timeout: 30000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    await h.command(["execute", "--job", id]);
    const running = h.start(["verify", "--job", id, "--output", "jsonl"], true);
    await running.checkpoint((event) => event.verb === "verify" && event.kind === "phase_started");
    running.child.kill("SIGHUP");
    const stopped = await running.done;
    assert.equal(stopped.code, 129, stopped.stdout);
    assert.equal(stopped.signal, null);
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(status.value.verificationDigest, null);
    assert.equal(status.value.ownership.held, false);
    assert.equal(
      running.events.some((event) => event.verb === "verify" && event.kind === "phase_completed"),
      false,
    );
    await h.command(["verify", "--job", id]);
    const verified = await h.command<JobStatus>(["status", "--job", id]);
    assert.ok(verified.value.verificationDigest);
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
      (event) => event.kind === "mapping_progress" && event.payload.files === 1,
    );
    await running.breakStdout();
    const stopped = await running.done;
    assert.equal(stopped.code, 141, JSON.stringify(stopped));
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
      if (stop === "EPIPE") await running.breakStdout();
      else running.child.kill(stop);
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

interface DetachedLaunch {
  detached: true;
  pid: number;
  commandId: string;
  logPath: string;
}

it(
  "detached admission survives launcher session and stop releases ownership before success",
  { timeout: 45000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const launcher = h.start(["execute", "--job", id, "--detach", "--output", "json"], true);
    const launched = await launcher.done;
    assert.equal(launched.code, 0, launched.stdout + launched.stderr);
    const ack: Document<DetachedLaunch> = JSON.parse(launched.stdout);
    assert.equal(ack.value.detached, true);
    assert.notEqual(ack.value.pid, launcher.child.pid);
    try {
      process.kill(-launcher.child.pid!, "SIGTERM");
    } catch (error) {
      assert.ok(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(status.value.state, "executing");
    assert.equal(status.value.ownership.pid, ack.value.pid);
    assert.equal(status.value.ownership.detached, true);
    assert.ok(status.value.ownership.logPath?.startsWith("logs/execute-"));
    assert.equal(statSync(dirname(ack.value.logPath)).mode & 0o777, 0o700);
    assert.equal(statSync(ack.value.logPath).mode & 0o777, 0o600);
    for (const extra of [[], ["--detach"]]) {
      const duplicate = await h.start(["execute", "--job", id, ...extra, "--output", "json"]).done;
      assert.equal(duplicate.code, 3, duplicate.stdout);
      assert.equal(JSON.parse(duplicate.stdout).refusal.code, "lease_held");
    }
    const stopped = await h.command<{ stopped: boolean }>(["stop", "--job", id]);
    assert.equal(stopped.value.stopped, true);
    const after = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(after.value.state, "interrupted");
    assert.equal(after.value.resumable, true);
    assert.equal(after.value.ownership.held, false);
    await h.reapDetached(ack.value.pid);
    const lines = readFileSync(ack.value.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.kind === "terminal"));
    assert.ok("ok" in lines.at(-1));
    assert.equal(lines.at(-1).commandId, ack.value.commandId);
    const idle = await h.command<{ stopped: boolean }>(["stop", "--job", id]);
    assert.equal(idle.value.stopped, false);
    await h.command(["execute", "--job", id]);
  },
);

it(
  "racing detached launches admit one owner and running cancellation is acknowledged after release",
  { timeout: 45000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const results = await Promise.all(
      [0, 1].map(
        () => h.start(["execute", "--job", id, "--detach", "--output", "json"], true).done,
      ),
    );
    assert.deepEqual(results.map((result) => result.code).sort(), [0, 3]);
    const winner = results.find((result) => result.code === 0)!;
    const ack: Document<DetachedLaunch> = JSON.parse(winner.stdout);
    await h.command(["cancel", "--job", id, "--reason", "operator request"]);
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(status.value.state, "cancelled");
    assert.equal(status.value.ownership.held, false);
    await h.reapDetached(ack.value.pid);
    const replay = await h.start(["status", "--job", id, "--output", "jsonl"]).done;
    const events = replay.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some(
        (event) =>
          event.kind === "control_request" &&
          event.payload.kind === "cancel" &&
          event.payload.outcome === "cancelled",
      ),
    );
    for (const verb of ["stop", "cancel"]) {
      const terminal = await h.start([verb, "--job", id, "--output", "json"]).done;
      assert.equal(terminal.code, 7, terminal.stdout);
    }
  },
);

it(
  "detached admission refusal leaves private evidence without an owner or worker",
  { timeout: 20000 },
  async (t) => {
    const h = setup(t);
    const init = await h.command<{ id: string }>([
      "init",
      "--type",
      "file_migration",
      "--config",
      h.config,
    ]);
    const id = init.value.id;
    const refused = await h.start(["execute", "--job", id, "--detach", "--output", "json"]).done;
    assert.equal(refused.code, 4, refused.stdout + refused.stderr);
    assert.equal(JSON.parse(refused.stdout).ok, false);
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(status.value.ownership.held, false);
    const logs = join(h.home, "jobs", id, "logs");
    const files = readdirSync(logs);
    assert.equal(files.length, 1);
    const records = readFileSync(join(logs, files[0]!), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.at(-1).ok, false);
  },
);

for (const verb of ["stop", "cancel"]) {
  it(`${verb} reaches a foreground owner and waits for release`, { timeout: 30000 }, async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const owner = h.start(["execute", "--job", id, "--output", "jsonl"], true);
    await owner.checkpoint((event) => event.kind === "unit_committed");
    await h.command([verb, "--job", id]);
    assert.equal((await owner.done).code, verb === "stop" ? 130 : 7);
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(status.value.state, verb === "stop" ? "interrupted" : "cancelled");
    assert.equal(status.value.ownership.held, false);
  });
}

it("an unusable attempt-log directory refuses before admission", { timeout: 20000 }, async (t) => {
  const h = setup(t);
  const id = await h.approve();
  writeFileSync(join(h.home, "jobs", id, "logs"), "not a directory");
  const result = await h.start(["execute", "--job", id, "--detach", "--output", "json"]).done;
  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, false);
  const status = await h.command<JobStatus>(["status", "--job", id]);
  assert.equal(status.value.ownership.held, false);
  assert.notEqual(status.value.state, "executing");
});

for (const condition of ["foreign", "stale"] as const) {
  it(
    `${condition} ownership refuses control without delivering a request`,
    { timeout: 30000 },
    async (t) => {
      const h = setup(t);
      const id = await h.approve();
      const owner = h.start(["execute", "--job", id, "--output", "jsonl"], true);
      await owner.checkpoint((event) => event.kind === "unit_committed");
      const db = new DatabaseSync(join(h.home, "jobs", id, "state.db"));
      try {
        if (condition === "foreign") db.prepare("UPDATE lease SET host_id = 'another-host'").run();
        else
          db.prepare("UPDATE lease SET heartbeat_at = ?").run(
            new Date(Date.parse(FIXTURE_TIME) - 60000).toISOString(),
          );
        const result = await h.start(["stop", "--job", id, "--output", "json"]).done;
        assert.equal(result.code, 3, result.stdout);
        const count = db.prepare("SELECT COUNT(*) AS n FROM control_request").get();
        assert.equal(count?.n, 0);
      } finally {
        db.close();
        owner.child.kill("SIGTERM");
        await owner.done;
      }
    },
  );
}

it(
  "SIGTERM stops a detached coordinator resumably and retains separate attempt logs",
  { timeout: 30000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const first = await h.start(["execute", "--job", id, "--detach", "--output", "json"], true)
      .done;
    assert.equal(first.code, 0, first.stdout);
    const ack: Document<DetachedLaunch> = JSON.parse(first.stdout);
    process.kill(ack.value.pid, "SIGTERM");
    await h.reapDetached(ack.value.pid);
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(status.value.state, "interrupted");
    assert.equal(status.value.ownership.held, false);
    const original = readFileSync(ack.value.logPath, "utf8");
    const second = await h.start(["execute", "--job", id, "--detach", "--output", "json"], true)
      .done;
    assert.equal(second.code, 0, second.stdout);
    const next: Document<DetachedLaunch> = JSON.parse(second.stdout);
    assert.notEqual(next.value.logPath, ack.value.logPath);
    await h.command(["stop", "--job", id]);
    await h.reapDetached(next.value.pid);
    assert.equal(readFileSync(ack.value.logPath, "utf8"), original);
  },
);

for (const target of ["launcher", "child"] as const) {
  it(
    `${target} death before admission never acknowledges or leaves work running`,
    { timeout: 20000 },
    async (t) => {
      const h = setup(t);
      const id = await h.approve();
      const marker = join(h.root, "admission");
      const launcher = h.start(
        ["execute", "--job", id, "--detach", "--output", "json"],
        false,
        false,
        marker,
      );
      for (let attempt = 0; attempt < 500 && !existsSync(marker); attempt++) await delay(10);
      assert.ok(existsSync(marker), "child reached pre-admission barrier");
      const pid = Number(readFileSync(marker, "utf8"));
      h.trackDetached(pid);
      if (target === "launcher") launcher.child.kill("SIGTERM");
      else process.kill(pid, "SIGKILL");
      const result = await launcher.done;
      assert.equal(result.code, target === "launcher" ? 143 : 1, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).ok, false);
      await h.reapDetached(pid);
      const status = await h.command<JobStatus>(["status", "--job", id]);
      assert.equal(status.value.ownership.held, false);
      assert.notEqual(status.value.state, "executing");
    },
  );
}

it("detach refuses non-execute verbs and JSONL launch output", { timeout: 10000 }, async (t) => {
  const h = setup(t);
  for (const args of [
    ["plan", "--job", "unused", "--detach", "--output", "json"],
    ["execute", "--job", "unused", "--detach", "--output", "jsonl"],
  ]) {
    const result = await h.start(args).done;
    assert.equal(result.code, 2, result.stdout);
    assert.equal(JSON.parse(result.stdout).refusal.code, "usage");
  }
});

it("a detached stale approval refuses before acknowledgement", { timeout: 20000 }, async (t) => {
  const h = setup(t);
  const id = await h.approve();
  const db = new DatabaseSync(join(h.home, "jobs", id, "state.db"));
  db.prepare(
    "UPDATE approval SET plan_digest = 'older-plan', payload = json_set(payload, '$.planDigest', 'older-plan')",
  ).run();
  db.close();
  const result = await h.start(["execute", "--job", id, "--detach", "--output", "json"]).done;
  assert.equal(result.code, 4, result.stdout);
  assert.equal(JSON.parse(result.stdout).refusal.code, "approval_digest_stale");
  const status = await h.command<JobStatus>(["status", "--job", id]);
  assert.equal(status.value.ownership.held, false);
  assert.notEqual(status.value.state, "executing");
});

it("new ownership voids a pending request for an older owner", { timeout: 30000 }, async (t) => {
  const h = setup(t);
  const id = await h.approve();
  const db = new DatabaseSync(join(h.home, "jobs", id, "state.db"));
  try {
    db.prepare(
      `INSERT INTO control_request
      (kind,owner_uuid,reason,host_id,pid,command_id,requested_at)
      VALUES ('cancel','older-owner','old request','local',?,'older-command',?)`,
    ).run(process.pid, FIXTURE_TIME);
    const owner = h.start(["execute", "--job", id, "--output", "jsonl"], true);
    await owner.checkpoint((event) => event.kind === "unit_committed");
    const old = db
      .prepare("SELECT answered_at, outcome FROM control_request WHERE command_id='older-command'")
      .get();
    assert.ok(old?.answered_at);
    assert.equal(old?.outcome, "lease_held");
    const status = await h.command<JobStatus>(["status", "--job", id]);
    assert.equal(status.value.state, "executing");
    await h.command(["stop", "--job", id]);
    assert.equal((await owner.done).code, 130);
  } finally {
    db.close();
  }
});

it(
  "repeated stops join and cancellation upgrades one pending owner request",
  { timeout: 30000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const owner = h.start(["execute", "--job", id, "--output", "jsonl"], true);
    await owner.checkpoint((event) => event.kind === "unit_committed");
    const first = h.start(["stop", "--job", id, "--output", "json"]);
    const db = new DatabaseSync(join(h.home, "jobs", id, "state.db"));
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (db.prepare("SELECT id FROM control_request WHERE answered_at IS NULL").get()) break;
        await delay(10);
      }
      assert.ok(db.prepare("SELECT id FROM control_request WHERE answered_at IS NULL").get());
      const second = h.start(["stop", "--job", id, "--output", "json"]);
      const cancel = h.start(["cancel", "--job", id, "--output", "json"]);
      const results = await Promise.all([first.done, second.done, cancel.done]);
      for (const result of results) assert.equal(result.code, 0, result.stdout);
      assert.equal((await owner.done).code, 7);
      const requests = db.prepare("SELECT kind,outcome FROM control_request").all();
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.kind, "cancel");
      assert.equal(requests[0]?.outcome, "cancelled");
    } finally {
      db.close();
    }
  },
);

it(
  "go-live refusal answers cancellation without interrupting the owner",
  { timeout: 30000 },
  async (t) => {
    const h = setup(t);
    const id = await h.approve();
    const owner = h.start(["execute", "--job", id, "--output", "jsonl"], true);
    await owner.checkpoint((event) => event.kind === "unit_committed");
    const db = new DatabaseSync(join(h.home, "jobs", id, "state.db"));
    try {
      db.prepare("INSERT INTO created_drive (mapping_id,payload) VALUES (?,?)").run(
        "fenced",
        JSON.stringify({
          mappingId: "fenced",
          requestId: "request",
          name: "fenced",
          driveId: "fenced-drive",
          creatorEmail: "fixture@example.invalid",
          goLive: { startedAt: FIXTURE_TIME, revision: 1, verificationAt: FIXTURE_TIME },
        }),
      );
      const cancel = h.start(["cancel", "--job", id, "--output", "json"]);
      let answered = false;
      for (let attempt = 0; attempt < 800; attempt++) {
        const request = db.prepare("SELECT outcome FROM control_request WHERE kind='cancel'").get();
        if (request?.outcome === "go_live_started") {
          answered = true;
          break;
        }
        await delay(10);
      }
      assert.equal(answered, true);
      assert.equal(owner.child.exitCode, null);
      const status = await h.command<JobStatus>(["status", "--job", id]);
      assert.equal(status.value.state, "executing");
      await h.command(["stop", "--job", id]);
      assert.equal((await owner.done).code, 130);
      const refused = await cancel.done;
      assert.equal(refused.code, 4, refused.stdout);
      assert.equal(JSON.parse(refused.stdout).refusal.code, "go_live_started");
    } finally {
      db.close();
    }
  },
);
