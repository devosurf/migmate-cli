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
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { EngineRefusalError, openEngine } from "../src/engine/index.ts";
import { DiskListing } from "../src/engine/providers/listing.ts";
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

describe("own-process identity acquisition", () => {
  async function identityChild(t: TestContext, mode: string, detached = false) {
    const { root, home } = engineHome(t);
    const output = join(root, "identity.json");
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./lease-identity-fixture.ts", import.meta.url)), home, mode, output],
      { detached, stdio: "ignore" },
    );
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    });
    const deadline = performance.now() + 15_000;
    while (!existsSync(output)) {
      assert.equal(child.exitCode, null, "identity child exited before publishing evidence");
      assert.ok(performance.now() < deadline, "identity child did not publish evidence");
      await delay(10);
    }
    const result = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(result.error, undefined, result.stack);
    assert.ok(child.pid);
    return { result, pid: child.pid };
  }

  for (const detached of [false, true]) {
    it(
      `retries first and subsequent acquisitions with independently compatible identity (detached=${detached})`,
      { skip: process.platform !== "darwin" },
      async (t) => {
        const { result, pid } = await identityChild(t, "transient", detached);
        assert.equal(result.identity, getProcessStartTime(pid));
        assert.equal(processAlive(pid, result.identity), true);
        assert.equal(processAlive(pid, result.identity + 1), false);
      },
    );
  }

  for (const mode of [
    "permanent",
    "ENOENT",
    "EACCES",
    "EAGAIN",
    "nonzero",
    "signal",
    "empty",
    "malformed",
    "invalid-date",
    "foreign",
  ]) {
    it(
      `fails closed for ${mode} inspection without broadening retries`,
      {
        skip: process.platform !== "darwin",
      },
      async (t) => {
        await identityChild(t, mode);
      },
    );
  }

  for (const mode of ["linux", "linux-failure"]) {
    it(`preserves ${mode} /proc behavior without subprocess retries`, async (t) => {
      await identityChild(t, mode);
    });
  }
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
  it("takes over a proven-dead lease and records recovery at its checkpoint", async (t) => {
    const { db } = engineHome(t),
      row = staleRow();
    db.exec("UPDATE job SET state='executing'");
    seedLease(db, row);
    const acquired = await acquire(
      db,
      { hostId: row.hostId, pid: process.pid, processStartTime: getProcessStartTime() },
      { kind: "cli", now: () => NOW },
    );
    assert.ok(acquired.ok);
    assert.equal(db.prepare("SELECT state FROM job").get()?.state, "interrupted");
    assert.equal(
      db.prepare("SELECT owner_uuid FROM lease").get()?.owner_uuid,
      acquired.value.row.ownerUuid,
    );
    assert.deepEqual(
      JSON.parse(
        String(db.prepare("SELECT payload FROM event WHERE kind='phase_completed'").get()?.payload),
      ),
      { reclaimed: true, checkpoint: "checkpoint-7" },
    );
    release(db, acquired.value);
  });

  it("does not clear a lease whose heartbeat changed during inspection", async (t) => {
    const { db } = engineHome(t),
      row = staleRow();
    seedLease(db, row);
    const acquired = await acquire(
      db,
      { hostId: row.hostId, pid: process.pid, processStartTime: getProcessStartTime() },
      {
        kind: "cli",
        now: () => NOW,
        processAlive: () => {
          db.prepare("UPDATE lease SET heartbeat_at = ?").run(NOW.toISOString());
          return false;
        },
      },
    );
    assert.equal(acquired.ok, false);
    if (acquired.ok) throw new Error("Refreshed lease was stolen");
    assert.equal(acquired.refusal.code, "lease_held");
    assert.equal(
      db.prepare("SELECT heartbeat_at FROM lease").get()?.heartbeat_at,
      NOW.toISOString(),
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM event").get()?.count, 0);
  });

  it("lets only one competing acquirer take over and record recovery", async (t) => {
    const { db } = engineHome(t),
      row = staleRow();
    seedLease(db, row);
    const identity = {
      hostId: row.hostId,
      pid: process.pid,
      processStartTime: getProcessStartTime(),
    };
    const results = await Promise.all([
      acquire(db, identity, { kind: "cli", now: () => NOW }),
      acquire(db, identity, { kind: "cli", now: () => NOW }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM event").get()?.count, 1);
    for (const result of results) {
      if (result.ok) release(db, result.value);
      else assert.equal(result.refusal.code, "lease_held");
    }
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
  it("reclaims SIGKILL-abandoned listing scratch only after acquiring that job's writer", async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lease-listing-")));
    const home = join(root, "home");
    const temporary = join(root, "temporary");
    mkdirSync(temporary);
    let now = NOW;
    const engine = openEngine({ home, now: () => now });
    const created = await engine.initJob({ type: "file_migration" });
    assert.ok(created.ok);
    const jobDirectory = join(home, "jobs", created.value.id);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { readdirSync } from "node:fs";
          import { join, dirname } from "node:path";
          import { openEngine } from ${JSON.stringify(new URL("../src/engine/index.ts", import.meta.url).href)};
          import { DiskListing } from ${JSON.stringify(new URL("../src/engine/providers/listing.ts", import.meta.url).href)};
          const engine = openEngine({ home: process.argv[1], now: () => new Date(${JSON.stringify(NOW.toISOString())}) });
          const result = await engine.withWriter({ id: process.argv[2] }, async () => {
            const listing = new DiskListing();
            listing.add({ path: "still-live" });
            const root = process.argv[3];
            const file = readdirSync(root, { recursive: true }).find(path => path.endsWith("/listing.sqlite"));
            if (!file) throw new Error("No listing scratch created");
            process.send({ directory: dirname(join(root, file)) });
            process.on("message", () => process.send({ value: listing.get("still-live") }));
            await Promise.withResolvers().promise;
          });
          throw new Error(JSON.stringify(result));
        `,
        home,
        created.value.id,
        root,
      ],
      { env: { ...process.env, TMPDIR: temporary }, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      engine.close();
      rmSync(root, { recursive: true, force: true });
    });
    const [message] = await Promise.race([
      once(child, "message"),
      exited.then(() => {
        throw new Error(`Scratch child exited: ${stderr}`);
      }),
    ]);
    assert.ok(message && typeof message === "object" && "directory" in message);
    assert.equal(typeof message.directory, "string");
    const directory = String(message.directory);
    assert.ok(existsSync(join(directory, "listing.sqlite")));
    assert.ok((await engine.reader(created.value).status()).ok);
    const contending = await engine.withWriter(created.value, async () =>
      assert.fail("Live lease acquired"),
    );
    assert.equal(contending.ok, false);
    if (!contending.ok) assert.equal(contending.refusal.code, "lease_held");
    assert.ok(existsSync(join(directory, "listing.sqlite")));
    const stillLive = once(child, "message");
    child.send("read");
    assert.deepEqual((await stillLive)[0], { value: { path: "still-live" } });
    child.kill("SIGKILL");
    await exited;
    assert.ok(existsSync(directory), "SIGKILL must leave the scratch for recovery");
    now = new Date(NOW.getTime() + 60_000);
    assert.ok((await engine.reader(created.value).status()).ok);
    assert.ok(existsSync(directory), "Readers must not reclaim abandoned writer scratch");
    const recovered = await engine.withWriter(created.value, async () => {
      assert.equal(
        existsSync(directory),
        false,
        "The acquired writer must remove abandoned indexes",
      );
      using listing = new DiskListing<{ path: string }>();
      listing.add({ path: "recovered" });
      assert.deepEqual([...listing], [{ path: "recovered" }]);
      assert.ok(
        readdirSync(jobDirectory, { recursive: true, encoding: "utf8" }).some((path) =>
          path.endsWith("/listing.sqlite"),
        ),
      );
    });
    assert.ok(recovered.ok);
    assert.ok(
      !readdirSync(jobDirectory, { recursive: true, encoding: "utf8" }).some((path) =>
        path.endsWith("/listing.sqlite"),
      ),
    );
  });

  it("cleans all writer indexes on failure without touching another live job's indexes", async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lease-listing-")));
    const engine = openEngine({ home: root });
    t.after(() => {
      engine.close();
      rmSync(root, { recursive: true, force: true });
    });
    const first = await engine.initJob({ type: "file_migration" });
    const second = await engine.initJob({ type: "file_migration" });
    assert.ok(first.ok && second.ok);
    const firstDirectory = join(root, "jobs", first.value.id, "listing-scratch");
    const secondDirectory = join(root, "jobs", second.value.id, "listing-scratch");
    const failure = new Error("writer callback failed");
    let abandoned: DiskListing<{ path: string }> | undefined;
    const result = await engine.withWriter(first.value, async () => {
      using live = new DiskListing<{ path: string }>();
      live.add({ path: "first" });
      const liveIndexes = readdirSync(firstDirectory, { recursive: true });
      await assert.rejects(
        engine.withWriter(second.value, async () => {
          await Promise.resolve();
          abandoned = new DiskListing<{ path: string }>();
          abandoned.add({ path: "second" });
          assert.ok(
            readdirSync(secondDirectory, { recursive: true, encoding: "utf8" }).some((path) =>
              path.endsWith("/listing.sqlite"),
            ),
          );
          throw failure;
        }),
        (error) => error === failure,
      );
      assert.deepEqual(readdirSync(secondDirectory), []);
      assert.deepEqual(readdirSync(firstDirectory, { recursive: true }), liveIndexes);
      assert.deepEqual([...live], [{ path: "first" }]);
      assert.throws(() => abandoned?.get("second"), /disposed/);
    });
    assert.ok(result.ok);
    assert.deepEqual(readdirSync(firstDirectory), []);
  });

  it("automatically opens an interrupted writer at the durable checkpoint", async (t) => {
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
    const opened = await engine.withWriter(created.value, async () =>
      engine.reader(created.value).status(),
    );
    assert.ok(opened.ok);
    assert.ok(opened.value.ok);
    assert.equal(opened.value.value.state, "interrupted");
    assert.equal(opened.value.value.lastCheckpoint, "committed-page-3");
    const events = [];
    for await (const event of engine.reader(created.value).events({})) events.push(event);
    assert.deepEqual(events.find((event) => event.payload.reclaimed === true)?.payload, {
      reclaimed: true,
      checkpoint: "committed-page-3",
    });
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
