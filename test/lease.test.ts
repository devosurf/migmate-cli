import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { EngineRefusalError, openEngine } from "../src/engine/index.ts";
import { reconcileOnWriterOpen } from "../src/engine/state-chart.ts";
import {
  acquire,
  evaluateReclaim,
  getHostId,
  getProcessStartTime,
  heartbeat,
  inspectLease,
  probeWorker,
  processAlive,
  readHostId,
  reconcileWriterOpen,
  release,
  stopOrphanWorker,
  withLease,
  type LeaseRow,
} from "../src/engine/store/lease.ts";
import type { JobState } from "../src/engine/types.ts";

const schema = readFileSync(new URL("../src/engine/store/schema.sql", import.meta.url), "utf8");
const NOW = new Date("2026-09-01T12:00:00.000Z");

function engineHome(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lease-")));
  const home = join(root, "home");
  const db = new DatabaseSync(join(root, "state.db"));
  db.exec(schema);
  db.prepare(
    `INSERT INTO job (id,type,state,schema_version,migmate_version,created_at,last_checkpoint)
  VALUES ('job-1','file_migration','new',2,'test',?,'checkpoint-7')`,
  ).run(NOW.toISOString());
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, db };
}

function staleRow(overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    ownerUuid: "dead-owner",
    hostId: "local-host",
    pid: process.pid,
    processStartTime: getProcessStartTime() + 1,
    heartbeatAt: new Date(NOW.getTime() - 31_000).toISOString(),
    kind: "cli",
    socketPath: null,
    workerGroup: null,
    workerPid: null,
    workerProcessStartTime: null,
    workerExecutable: null,
    lastCheckpoint: "checkpoint-7",
    migmateVersion: "test",
    ...overrides,
  };
}

function seedLease(db: DatabaseSync, row: LeaseRow): void {
  db.prepare(
    `INSERT INTO lease (id,owner_uuid,host_id,pid,process_start_time,heartbeat_at,kind,
    socket_path,worker_group,worker_pid,worker_process_start_time,worker_executable,last_checkpoint,migmate_version)
    VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.ownerUuid,
    row.hostId,
    row.pid,
    row.processStartTime,
    row.heartbeatAt,
    row.kind,
    row.socketPath,
    row.workerGroup,
    row.workerPid,
    row.workerProcessStartTime,
    row.workerExecutable,
    row.lastCheckpoint,
    row.migmateVersion,
  );
}

async function orphan(
  t: TestContext,
  stubborn = false,
): Promise<{ row: LeaseRow; child: ChildProcess; exited: Promise<unknown[]> }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lease-orphan-")));
  const directory = join(root, "run", "run-id", "rc-owned");
  // getHostId creates and secures this private engine-owned directory on all OSes.
  getHostId(directory);
  writeFileSync(
    join(directory, "rcd"),
    `
    ${stubborn ? "process.on('SIGTERM', () => {});" : ""}
    process.stdin.resume();
    process.stdout.write('ready\\n');`,
    { mode: 0o600 },
  );
  const executable = realpathSync(process.execPath),
    socketPath = join(directory, "s");
  const child = spawn(
    executable,
    [
      "rcd",
      "--rc-addr",
      "unix://s",
      "--rc-serve",
      "--config",
      "/dev/null",
      "--cache-dir",
      directory,
      "--temp-dir",
      directory,
    ],
    {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  assert.ok(child.stdout);
  await once(child.stdout, "data");
  assert.ok(child.pid);
  return {
    child,
    exited,
    row: staleRow({
      workerPid: child.pid,
      workerProcessStartTime: getProcessStartTime(child.pid),
      workerExecutable: executable,
      workerGroup: "migmate-recorded-run",
      socketPath,
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    }),
  };
}

describe("persistent host identity", () => {
  it("does not create a home during a reader-only lookup", (t) => {
    const { home } = engineHome(t);
    assert.equal(readHostId(home), null);
    assert.equal(existsSync(home), false);
  });

  it("installs one private identity shared by concurrent creators", async (t) => {
    const { home } = engineHome(t);
    const source = new URL("../src/engine/store/lease.ts", import.meta.url).href;
    const outputs = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import {getHostId} from ${JSON.stringify(source)}; console.log(getHostId(process.argv[1]));`,
            home,
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let text = "",
          stderr = "";
        child.stdout?.on("data", (chunk) => {
          text += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        const [code] = await once(child, "exit");
        assert.equal(code, 0, stderr);
        return text.trim();
      }),
    );
    assert.equal(new Set(outputs).size, 1);
    assert.equal(getHostId(home), outputs[0]);
    assert.equal(readHostId(home), outputs[0]);
    assert.equal(lstatSync(home).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(home, "hostId")).mode & 0o777, 0o600);
  });

  it("refuses a symlink identity instead of trusting or replacing its target", (t) => {
    const { root, home } = engineHome(t);
    mkdirSync(home, { mode: 0o700 });
    const target = join(root, "unrelated");
    const contents = "8a6ea0dd-5a15-4acd-a3c3-5cc35df2f2ed\n";
    writeFileSync(target, contents, { mode: 0o600 });
    symlinkSync(target, join(home, "hostId"));
    assert.throws(() => readHostId(home));
    assert.throws(() => getHostId(home));
    assert.equal(readFileSync(target, "utf8"), contents);
  });
});

describe("lease adjudication", () => {
  it("permits exactly one of the sixteen documented reclaim combinations", () => {
    const codes = [
      "foreign_host",
      "foreign_host",
      "foreign_host",
      "foreign_host",
      "lease_held",
      "lease_held",
      "lease_held",
      "lease_held",
      "foreign_host",
      "foreign_host",
      "foreign_host",
      "foreign_host",
      "lease_held",
      "lease_held",
      "lease_stale_worker_alive",
      null,
    ];
    for (let mask = 0; mask < 16; mask++) {
      assert.deepEqual(
        evaluateReclaim({
          heartbeatExpired: Boolean(mask & 8),
          hostMatches: Boolean(mask & 4),
          ownerProcessGone: Boolean(mask & 2),
          workerSocketSilent: Boolean(mask & 1),
        }),
        {
          reclaimable: mask === 15,
          code: codes[mask],
        },
      );
    }
  });

  it("never mistakes the live owner for the transfer worker", async () => {
    const row = staleRow({ processStartTime: getProcessStartTime() });
    const inspection = await inspectLease(row, row.hostId, { now: () => NOW });
    assert.equal(inspection.ownerStatus, "alive");
    assert.equal(inspection.report.workerAlive, false);
    assert.equal(inspection.workerStatus, "absent");
    assert.equal(inspection.decision.reclaimable, false);
    assert.equal(inspection.decision.code, "lease_held");
    assert.equal(inspection.stopEligible, false);
  });

  it("treats PID reuse as owner loss, without inventing a process start fallback", async () => {
    const row = staleRow();
    assert.equal(processAlive(process.pid, row.processStartTime), false);
    assert.equal(processAlive(process.pid, getProcessStartTime()), true);
    assert.equal(processAlive(-1, 1), null);
    assert.throws(() => getProcessStartTime(-1));
    const inspection = await inspectLease(row, row.hostId, { now: () => NOW });
    assert.equal(inspection.ownerStatus, "mismatched");
    assert.equal(inspection.decision.reclaimable, true);
  });

  it("does not probe local processes or sockets for a foreign host", async () => {
    const row = staleRow({ socketPath: "/private/worker/s", workerGroup: "run" });
    const result = await inspectLease(row, "another-host", {
      now: () => NOW,
      processAlive: () => {
        throw new Error("must not inspect this host's PID");
      },
      probeWorker: async () => {
        throw new Error("must not dial this host's socket");
      },
    });
    assert.equal(result.decision.code, "foreign_host");
    assert.equal(result.workerStatus, "unknown");
    assert.equal(result.stopEligible, false);
    assert.equal(result.report.lastCheckpoint, "checkpoint-7");
    assert.equal(result.report.workerGroup, "run");
    assert.equal("socketProbed" in result.report, false);
    assert.equal("socketPath" in result.report, false);
    assert.equal("workerPid" in result.report, false);
  });

  it("refuses unknown owner, unknown socket and malformed heartbeat evidence", async () => {
    const row = staleRow();
    const owner = await inspectLease(row, row.hostId, { now: () => NOW, processAlive: () => null });
    assert.equal(owner.ownerStatus, "unknown");
    assert.equal(owner.decision.reclaimable, false);
    assert.equal(owner.decision.code, "lease_held");
    const socket = await inspectLease({ ...row, socketPath: "/not-readable/s" }, row.hostId, {
      now: () => NOW,
      probeWorker: async () => null,
    });
    assert.equal(socket.socketStatus, "unknown");
    assert.equal(socket.decision.reclaimable, false);
    assert.equal(socket.stopEligible, false);
    const invalid = await inspectLease({ ...row, heartbeatAt: "corrupt" }, row.hostId, {
      now: () => NOW,
    });
    assert.equal(invalid.decision.code, "lease_held");
  });

  it("refuses a live worker even with an absent socket, and mismatched worker identity cannot grant reclaim", async () => {
    const row = staleRow({ workerPid: process.pid, workerProcessStartTime: getProcessStartTime() });
    const live = await inspectLease(row, row.hostId, { now: () => NOW });
    assert.equal(live.workerStatus, "alive");
    assert.equal(live.decision.reclaimable, false);
    const reused = await inspectLease(
      { ...row, workerProcessStartTime: row.workerProcessStartTime! + 1 },
      row.hostId,
      { now: () => NOW },
    );
    assert.equal(reused.workerStatus, "unknown");
    assert.equal(reused.decision.reclaimable, false);
    assert.equal(reused.stopEligible, false);
  });

  it("distinguishes definite socket absence from invalid probe input", async (t) => {
    const { root } = engineHome(t);
    assert.equal(await probeWorker(join(root, "missing-socket")), false);
    assert.equal(await probeWorker(""), null);
  });

  it("does not mistake a live long-path AF_UNIX worker for an absent socket", async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lease-long-socket-")));
    const directory = join(root, "long-engine-home-".repeat(8), "run", "rc-owned");
    getHostId(directory);
    const socketPath = join(directory, "s");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer(s=>s.end()).listen('s',()=>process.stdout.write('ready\\n'));",
      ],
      {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      rmSync(root, { recursive: true, force: true });
    });
    assert.ok(child.stdout);
    await once(child.stdout, "data");
    assert.equal(await probeWorker(socketPath), true);
    const row = staleRow({
      socketPath,
      workerPid: child.pid!,
      workerProcessStartTime: getProcessStartTime(child.pid),
    });
    const result = await inspectLease(row, row.hostId, { now: () => NOW });
    assert.equal(result.workerStatus, "alive");
    assert.equal(result.decision.reclaimable, false);
  });

  it("does not bless a launch intent with a missing PID merely because its socket is absent", async () => {
    const row = staleRow({
      socketPath: "/not-started/s",
      workerGroup: "pending-run",
      workerExecutable: process.execPath,
    });
    const result = await inspectLease(row, row.hostId, {
      now: () => NOW,
      probeWorker: async () => false,
    });
    assert.equal(result.workerStatus, "unknown");
    assert.equal(result.decision.reclaimable, false);
    assert.equal(result.stopEligible, false);
  });
});

describe("exact orphan termination", () => {
  it("stops only the recorded worker, without authenticating RC or signalling an OS group", async (t) => {
    const { row, child, exited } = await orphan(t);
    const inspection = await inspectLease(row, row.hostId);
    assert.equal(inspection.stopEligible, true);
    assert.equal(inspection.decision.reclaimable, false);
    assert.equal(await stopOrphanWorker(row), true);
    await exited;
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
    assert.equal((await inspectLease(row, row.hostId)).decision.reclaimable, true);
  });

  it("rechecks ownership before escalating an unresponsive exact worker", async (t) => {
    // This exercises the production bounded OS kill escalation, not a sleep
    // standing in for readiness. A child-process clock cannot use test timers.
    const { row, child, exited } = await orphan(t, true);
    assert.equal(await stopOrphanWorker(row), true);
    await exited;
    assert.equal(child.signalCode, "SIGKILL");
  });

  it("refuses mismatched executable, PID start, socket argv, group and live-owner claims without killing the child", async (t) => {
    const { row } = await orphan(t);
    const invalid: LeaseRow[] = [
      { ...row, workerProcessStartTime: row.workerProcessStartTime! + 1 },
      { ...row, workerExecutable: join(join(row.socketPath!, ".."), "not-the-executable") },
      { ...row, socketPath: join(row.socketPath!, "..", "different") },
      { ...row, workerGroup: null },
      { ...row, processStartTime: getProcessStartTime() },
      { ...row, heartbeatAt: new Date().toISOString() },
    ];
    for (const claim of invalid) {
      assert.equal((await inspectLease(claim, claim.hostId)).stopEligible, false);
      assert.equal(await stopOrphanWorker(claim), false);
      assert.equal(processAlive(row.workerPid!, row.workerProcessStartTime!), true);
    }
    const unknown = await inspectLease(row, row.hostId, { probeWorker: async () => null });
    assert.equal(unknown.stopEligible, false);
    assert.equal(unknown.decision.reclaimable, false);
  });
});

describe("writer ownership and reconciliation", () => {
  it("does not acquire or reconcile a stale row until explicit reclaim", async (t) => {
    const { db } = engineHome(t),
      row = staleRow();
    db.exec("UPDATE job SET state='executing'");
    seedLease(db, row);
    const refused = await acquire(
      db,
      { hostId: row.hostId, pid: process.pid, processStartTime: getProcessStartTime() },
      { kind: "cli", now: () => NOW },
    );
    assert.equal(refused.ok, false);
    if (refused.ok) throw new Error("stale lease silently stolen");
    assert.equal(refused.refusal.recovery?.reclaimable, true);
    const reconciled = await reconcileWriterOpen(db, reconcileOnWriterOpen, {
      hostId: row.hostId,
      now: () => NOW,
    });
    assert.equal(reconciled.changed, false);
    assert.equal(reconciled.state, "executing");
    assert.equal(db.prepare("SELECT owner_uuid FROM lease").get()?.owner_uuid, row.ownerUuid);
  });

  it("reconciles only the acquired owner's executing state, preserving checkpoints and all other states", async (t) => {
    const { db, home } = engineHome(t);
    const identity = {
      hostId: getHostId(home),
      pid: process.pid,
      processStartTime: getProcessStartTime(),
    };
    const states: JobState[] = [
      "new",
      "planned",
      "approved",
      "executing",
      "interrupted",
      "blocked",
      "needs_attention",
      "verified",
      "closed",
      "cancelled",
    ];
    for (const state of states) {
      db.prepare("UPDATE job SET state=?").run(state);
      const acquired = await acquire(db, identity, { kind: "cli" });
      assert.ok(acquired.ok);
      try {
        const wrong = await reconcileWriterOpen(db, reconcileOnWriterOpen, {
          hostId: identity.hostId,
          ownerUuid: "not-owner",
        });
        assert.equal(wrong.changed, false);
        const result = await reconcileWriterOpen(db, reconcileOnWriterOpen, {
          hostId: identity.hostId,
          ownerUuid: acquired.value.row.ownerUuid,
        });
        assert.equal(result.state, state === "executing" ? "interrupted" : state);
        assert.equal(result.changed, state === "executing");
        assert.equal(
          db.prepare("SELECT last_checkpoint FROM job").get()?.last_checkpoint,
          "checkpoint-7",
        );
      } finally {
        release(db, acquired.value);
      }
    }
  });

  it("persists the host after release and rejects an empty-lease foreign writer", async (t) => {
    const { db, home } = engineHome(t);
    const identity = {
      hostId: getHostId(home),
      pid: process.pid,
      processStartTime: getProcessStartTime(),
    };
    const first = await acquire(db, identity, { kind: "cli" });
    assert.ok(first.ok);
    assert.equal(release(db, first.value), true);
    const foreign = await acquire(db, { ...identity, hostId: "different-host" }, { kind: "web" });
    assert.equal(foreign.ok, false);
    if (foreign.ok) throw new Error("foreign writer acquired");
    assert.equal(foreign.refusal.code, "foreign_host");
    assert.equal(db.prepare("SELECT host_id FROM job").get()?.host_id, identity.hostId);
  });

  it("releases on callback failure but never clears a surviving worker claim or another owner's lease", async (t) => {
    const { db, home } = engineHome(t);
    const identity = {
      hostId: getHostId(home),
      pid: process.pid,
      processStartTime: getProcessStartTime(),
    };
    await assert.rejects(
      withLease(db, identity, { kind: "cli" }, async () => {
        throw new Error("callback failed");
      }),
      /callback failed/u,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM lease").get()?.n, 0);
    const acquired = await acquire(db, identity, { kind: "cli" });
    assert.ok(acquired.ok);
    db.prepare("UPDATE lease SET worker_pid=?, socket_path='recorded-worker'").run(process.pid);
    assert.equal(release(db, acquired.value), false);
    db.exec("UPDATE lease SET owner_uuid='other-owner',worker_pid=NULL,socket_path=NULL");
    assert.equal(heartbeat(db, acquired.value), false);
    assert.equal(release(db, acquired.value), false);
    assert.equal(db.prepare("SELECT owner_uuid FROM lease").get()?.owner_uuid, "other-owner");
  });
});

describe("engine recovery seam", () => {
  it("requires explicit reclaim before opening an interrupted writer at the durable checkpoint", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "lease-engine-")),
      home = join(root, "home");
    const engine = openEngine({ home, now: () => NOW });
    t.after(() => {
      engine.close();
      rmSync(root, { recursive: true, force: true });
    });
    const created = await engine.initJob({ type: "file_migration" });
    assert.ok(created.ok);
    const db = new DatabaseSync(join(home, "jobs", created.value.id, "state.db"));
    try {
      db.exec("UPDATE job SET state='executing',last_checkpoint='committed-page-3'");
      seedLease(db, staleRow({ hostId: getHostId(home), lastCheckpoint: "committed-page-3" }));
    } finally {
      db.close();
    }
    let entered = false;
    const blocked = await engine.withWriter(created.value, async () => {
      entered = true;
    });
    assert.equal(blocked.ok, false);
    assert.equal(entered, false);
    const recovered = await engine.reclaim(created.value, { confirm: true });
    assert.ok(recovered.ok);
    assert.equal(recovered.value.lastCheckpoint, "committed-page-3");
    const opened = await engine.withWriter(created.value, async () =>
      engine.reader(created.value).status(),
    );
    assert.ok(opened.ok);
    assert.ok(opened.value.ok);
    assert.equal(opened.value.value.state, "interrupted");
    assert.equal(opened.value.value.lastCheckpoint, "committed-page-3");
  });

  it("refuses a copied foreign-host job even after its original lease was released", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "lease-copy-")),
      home = join(root, "origin"),
      otherHome = join(root, "foreign");
    const engine = openEngine({ home }),
      other = openEngine({ home: otherHome });
    t.after(() => {
      engine.close();
      other.close();
      rmSync(root, { recursive: true, force: true });
    });
    const created = await engine.initJob({ type: "file_migration" });
    assert.ok(created.ok);
    assert.ok((await engine.withWriter(created.value, async () => "released")).ok);
    getHostId(otherHome);
    cpSync(join(home, "jobs", created.value.id), join(otherHome, "jobs", created.value.id), {
      recursive: true,
    });
    const foreignReader = other.reader(created.value);
    const reader = await foreignReader.status();
    const rows = await foreignReader.rows({ phase: "plan" });
    const artifacts = await foreignReader.artifacts();
    const writer = await other.withWriter(created.value, async () => {
      throw new Error("foreign callback entered");
    });
    const reclaim = await other.reclaim(created.value, { confirm: true, stopWorker: true });
    for (const result of [reader, rows, artifacts, writer, reclaim]) {
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("foreign job accepted");
      assert.equal(result.refusal.code, "foreign_host");
      assert.equal(result.refusal.recovery?.reclaimable, false);
    }
    await assert.rejects(
      async () => {
        for await (const _event of foreignReader.events({}))
          assert.fail("Foreign-host events must not be exposed");
      },
      (error) =>
        error instanceof EngineRefusalError &&
        error.refusal.code === "foreign_host" &&
        error.refusal.recovery?.reclaimable === false,
    );
  });
});
