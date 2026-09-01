import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import {
  acquire,
  buildRecoveryReport,
  evaluateReclaim,
  getHostId,
  getProcessStartTime,
  processAlive,
  reconcileWriterOpen,
  withLease,
  type LeaseAcquireOptions,
  type LeaseIdentity,
  type LeaseRow,
} from "../src/engine/store/lease.ts";

const schema = readFileSync(new URL("../src/engine/store/schema.sql", import.meta.url), "utf8");

function createWorkspace(): { root: string; home: string; db: DatabaseSync; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lease-test-"));
  const home = join(root, "engine-home");
  const db = new DatabaseSync(join(root, "job.sqlite"));
  db.exec(schema);
  return {
    root,
    home,
    db,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function seedJob(db: DatabaseSync, state: string, checkpoint: string, now: Date): void {
  db.prepare(
    `
      INSERT INTO job (
        id,
        type,
        state,
        schema_version,
        migmate_version,
        created_at,
        last_checkpoint
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run("job-1", "file_migration", state, 1, "test", now.toISOString(), checkpoint);
}

function seedLease(db: DatabaseSync, row: LeaseRow): void {
  db.prepare(
    `
      INSERT INTO lease (
        id,
        owner_uuid,
        host_id,
        pid,
        process_start_time,
        heartbeat_at,
        kind,
        socket_path,
        worker_group,
        worker_pid,
        last_checkpoint,
        migmate_version
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
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
    row.lastCheckpoint,
    row.migmateVersion,
  );
}

function readJobState(db: DatabaseSync): { state: string; lastCheckpoint: string | null } {
  return db
    .prepare("SELECT state, last_checkpoint AS lastCheckpoint FROM job WHERE id = 'job-1'")
    .get() as {
    state: string;
    lastCheckpoint: string | null;
  };
}

function readLeaseCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS count FROM lease").get() as { count: number };
  return row.count;
}

afterEach(() => {
  // Each test owns its own workspace and cleans it up inline.
});

describe("lease", () => {
  it("enumerates the full reclaim truth table with the documented precedence", () => {
    const rows: Array<{
      heartbeatExpired: boolean;
      hostMatches: boolean;
      ownerProcessGone: boolean;
      workerSocketSilent: boolean;
    }> = [];
    for (const heartbeatExpired of [false, true]) {
      for (const hostMatches of [false, true]) {
        for (const ownerProcessGone of [false, true]) {
          for (const workerSocketSilent of [false, true]) {
            rows.push({ heartbeatExpired, hostMatches, ownerProcessGone, workerSocketSilent });
          }
        }
      }
    }

    let reclaimableCount = 0;
    for (const input of rows) {
      const actual = evaluateReclaim(input);
      const expected = !input.hostMatches
        ? { reclaimable: false, code: "foreign_host" as const }
        : !input.heartbeatExpired
          ? { reclaimable: false, code: "lease_held" as const }
          : !input.ownerProcessGone || !input.workerSocketSilent
            ? { reclaimable: false, code: "lease_stale_worker_alive" as const }
            : { reclaimable: true, code: null };
      assert.deepStrictEqual(actual, expected);
      if (actual.reclaimable) {
        reclaimableCount += 1;
      }
    }
    assert.equal(reclaimableCount, 1);
  });

  it("refuses fresh heartbeats with lease_held even when the recorded pid is gone", () => {
    const actual = evaluateReclaim({
      heartbeatExpired: false,
      hostMatches: true,
      ownerProcessGone: true,
      workerSocketSilent: true,
    });
    assert.deepStrictEqual(actual, { reclaimable: false, code: "lease_held" });
  });

  it("refuses foreign hosts before every other reclaim consideration", () => {
    const actual = evaluateReclaim({
      heartbeatExpired: true,
      hostMatches: false,
      ownerProcessGone: true,
      workerSocketSilent: true,
    });
    assert.deepStrictEqual(actual, { reclaimable: false, code: "foreign_host" });
  });

  it("builds a recovery report that preserves the worker group and checkpoint", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const row: LeaseRow = {
      ownerUuid: "owner-uuid",
      hostId: "remote-host",
      pid: 4321,
      processStartTime: 111,
      heartbeatAt: new Date(now.getTime() - 31_000).toISOString(),
      kind: "web",
      socketPath: "/tmp/worker.sock",
      workerGroup: "group-a",
      workerPid: 8765,
      lastCheckpoint: "checkpoint-17",
      migmateVersion: "test",
    };

    const report = await buildRecoveryReport(row, "local-host", {
      now: () => now,
      expiryMs: 30_000,
      probeWorker: async () => true,
      processAlive: () => false,
    });

    assert.equal(report.workerGroup, "group-a");
    assert.equal(report.lastCheckpoint, "checkpoint-17");
    assert.equal(report.socketProbed, "/tmp/worker.sock");
    assert.equal(report.workerPid, 8765);
    assert.equal(report.workerAlive, true);
    assert.equal(report.reclaimable, false);
    assert.equal(report.holder?.ownerUuid, "owner-uuid");

    const staleSocketRefusal = evaluateReclaim({
      heartbeatExpired: true,
      hostMatches: true,
      ownerProcessGone: true,
      workerSocketSilent: false,
    });
    assert.deepStrictEqual(staleSocketRefusal, {
      reclaimable: false,
      code: "lease_stale_worker_alive",
    });
  });

  it("treats a live pid with a different start time as gone", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    try {
      await once(child, "spawn");
      const pid = child.pid;
      if (pid === null || pid === undefined) {
        throw new Error("child pid missing");
      }

      const actualStart = getProcessStartTime(pid);
      assert.notEqual(Number.isNaN(actualStart), true);
      assert.equal(processAlive(pid, actualStart + 1), false);
      assert.equal(processAlive(pid, actualStart), true);
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });

  it("releases the lease after a callback throws and clears the heartbeat timer", async () => {
    const { db, home, cleanup } = createWorkspace();
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const timer: NodeJS.Timeout & { unrefCount: number } = {
      unrefCount: 0,
      close() {
        return this;
      },
      hasRef() {
        return false;
      },
      ref() {
        return this;
      },
      refresh() {
        return this;
      },
      unref() {
        this.unrefCount += 1;
        return this;
      },
      [Symbol.toPrimitive]() {
        return 0;
      },
      [Symbol.dispose]() {},
      _onTimeout() {},
    };
    const cleared: Array<NodeJS.Timeout | null> = [];

    globalThis.setInterval = (() => timer) as typeof setInterval;
    globalThis.clearInterval = ((handle: NodeJS.Timeout | null | undefined) => {
      cleared.push(handle ?? null);
    }) as typeof clearInterval;

    try {
      const identity: LeaseIdentity = {
        hostId: getHostId(home),
        pid: process.pid,
        processStartTime: getProcessStartTime(),
      };
      await assert.rejects(async () => {
        await withLease(
          db,
          identity,
          {
            kind: "cli",
            heartbeatMs: 25,
            migmateVersion: "test",
          } satisfies LeaseAcquireOptions,
          async () => {
            throw new Error("boom");
          },
        );
      }, /boom/);

      assert.equal(timer.unrefCount, 1);
      assert.equal(cleared.length, 1);
      assert.equal(cleared[0], timer);
      assert.equal(readLeaseCount(db), 0);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      cleanup();
    }
  });

  it("reconciles executing to interrupted at the recorded checkpoint and leaves other states untouched", async () => {
    const states = [
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
    ] as const;
    const now = new Date("2026-09-01T12:00:00.000Z");

    for (const state of states) {
      const { db, cleanup } = createWorkspace();
      try {
        seedJob(db, state, "checkpoint-7", now);
        seedLease(db, {
          ownerUuid: "owner-uuid",
          hostId: "local-host",
          pid: 12345,
          processStartTime: 111,
          heartbeatAt: new Date(now.getTime() - 31_000).toISOString(),
          kind: "cli",
          socketPath: "/tmp/worker.sock",
          workerGroup: "workers",
          workerPid: 22222,
          lastCheckpoint: "checkpoint-7",
          migmateVersion: "test",
        });

        const result = await reconcileWriterOpen(
          db,
          (current) => (current === "executing" ? "interrupted" : current),
          {
            now: () => now,
            expiryMs: 30_000,
            probeWorker: async () => false,
            processAlive: () => false,
            hostId: "local-host",
          },
        );

        const job = readJobState(db);
        if (state === "executing") {
          assert.equal(result.changed, true);
          assert.equal(result.state, "interrupted");
          assert.equal(job.state, "interrupted");
          assert.equal(job.lastCheckpoint, "checkpoint-7");
          assert.equal(result.recovery?.lastCheckpoint, "checkpoint-7");
          assert.equal(result.recovery?.reclaimable, true);
        } else {
          assert.equal(result.changed, false);
          assert.equal(result.state, state);
          assert.equal(job.state, state);
          assert.equal(job.lastCheckpoint, "checkpoint-7");
        }
      } finally {
        cleanup();
      }
    }
  });
});
