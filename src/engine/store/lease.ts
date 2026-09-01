import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import net from "node:net";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ok, refuse } from "../types.ts";
import type { JobState, Outcome, RecoveryReport, RefusalCode } from "../types.ts";

const HEARTBEAT_MS = 5_000;
const LEASE_EXPIRY_MS = 30_000;
const MIGMATE_VERSION = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version as string;

export interface LeaseIdentity {
  hostId: string;
  pid: number;
  processStartTime: number;
}

export interface LeaseRow {
  ownerUuid: string;
  hostId: string;
  pid: number;
  processStartTime: number;
  heartbeatAt: string;
  kind: "cli" | "web";
  socketPath: string | null;
  workerGroup: string | null;
  workerPid: number | null;
  lastCheckpoint: string | null;
  migmateVersion: string;
}

export interface LeaseHandle {
  row: LeaseRow;
  timer: NodeJS.Timeout | null;
}

export interface ReclaimInputs {
  heartbeatExpired: boolean;
  hostMatches: boolean;
  ownerProcessGone: boolean;
  workerSocketSilent: boolean;
}

export interface ReclaimDecision {
  reclaimable: boolean;
  code: RefusalCode | null;
}

export interface LeaseAcquireOptions {
  kind: "cli" | "web";
  socketPath?: string | null;
  workerGroup?: string | null;
  workerPid?: number | null;
  lastCheckpoint?: string | null;
  migmateVersion?: string;
  heartbeatMs?: number;
  expiryMs?: number;
  now?: () => Date;
  probeWorker?: (socketPath: string) => Promise<boolean>;
  processAlive?: (pid: number, startTime: number) => boolean;
}

export interface LeaseReconciliationResult {
  changed: boolean;
  state: JobState;
  recovery: RecoveryReport | null;
}

interface LeaseInspection {
  report: RecoveryReport;
  decision: ReclaimDecision;
}

interface JobRow {
  id: string;
  state: JobState;
  lastCheckpoint: string | null;
}

interface LeaseDbRow {
  ownerUuid: string;
  hostId: string;
  pid: number;
  processStartTime: number;
  heartbeatAt: string;
  kind: "cli" | "web";
  socketPath: string | null;
  workerGroup: string | null;
  workerPid: number | null;
  lastCheckpoint: string | null;
  migmateVersion: string;
}

const SELECT_LEASE_SQL = `
  SELECT
    owner_uuid AS ownerUuid,
    host_id AS hostId,
    pid,
    process_start_time AS processStartTime,
    heartbeat_at AS heartbeatAt,
    kind,
    socket_path AS socketPath,
    worker_group AS workerGroup,
    worker_pid AS workerPid,
    last_checkpoint AS lastCheckpoint,
    migmate_version AS migmateVersion
  FROM lease
  WHERE id = 1
`;

const SELECT_JOB_SQL = `
  SELECT
    id,
    state,
    last_checkpoint AS lastCheckpoint
  FROM job
  LIMIT 1
`;

function isErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const errno = error.code;
  return typeof errno === "string" && errno === code;
}

function readProcessStartTime(pid: number): number | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const text = result.stdout.trim();
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function readCurrentProcessStartTime(): number {
  const fallback = Math.round(Date.now() - globalThis.performance.now());
  const startTime = readProcessStartTime(process.pid);
  return startTime ?? fallback;
}

function readHostIdFile(home: string): string | null {
  const file = join(home, "hostId");
  if (!existsSync(file)) {
    return null;
  }
  const hostId = readFileSync(file, "utf8").trim();
  if (!hostId) {
    throw new Error(`empty host identity file at ${file}`);
  }
  return hostId;
}

function writeHostIdFile(home: string, hostId: string): void {
  mkdirSync(home, { recursive: true });
  const file = join(home, "hostId");
  if (existsSync(file)) {
    return;
  }
  const temp = join(home, `.hostId.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx");
  try {
    writeSync(fd, `${hostId}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, file);
  } catch (error) {
    if (!isErrnoCode(error, "EEXIST")) {
      throw error;
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Another process may have already consumed the temp file after winning the race.
    }
  }
}

function readLeaseRow(db: DatabaseSync): LeaseRow | null {
  const row = db.prepare(SELECT_LEASE_SQL).get() as LeaseDbRow | undefined;
  return row ?? null;
}

function readJobRow(db: DatabaseSync): JobRow {
  const row = db.prepare(SELECT_JOB_SQL).get() as JobRow | undefined;
  if (row === undefined) {
    throw new Error("job row missing");
  }
  return row;
}

function heartbeatAgeMs(heartbeatAt: string, now: () => Date): number {
  const parsed = Date.parse(heartbeatAt);
  if (Number.isNaN(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, now().getTime() - parsed);
}

function heartbeatExpired(heartbeatAt: string, now: () => Date, expiryMs: number): boolean {
  return heartbeatAgeMs(heartbeatAt, now) >= expiryMs;
}

function inspectProcessGone(
  pid: number,
  startTime: number,
  processAliveFn: (pid: number, startTime: number) => boolean,
): boolean {
  return !processAliveFn(pid, startTime);
}

async function inspectLeaseRow(
  row: LeaseRow,
  thisHostId: string,
  opts: {
    now?: () => Date;
    expiryMs?: number;
    probeWorker?: (socketPath: string) => Promise<boolean>;
    processAlive?: (pid: number, startTime: number) => boolean;
  } = {},
): Promise<LeaseInspection> {
  const now = opts.now ?? (() => new Date());
  const expiryMs = opts.expiryMs ?? LEASE_EXPIRY_MS;
  const probe = opts.probeWorker ?? probeWorker;
  const processAliveFn = opts.processAlive ?? processAlive;
  const socketAlive = row.socketPath === null ? false : await probe(row.socketPath);
  const ownerGone = inspectProcessGone(row.pid, row.processStartTime, processAliveFn);
  const decision = evaluateReclaim({
    heartbeatExpired: heartbeatExpired(row.heartbeatAt, now, expiryMs),
    hostMatches: row.hostId === thisHostId,
    ownerProcessGone: ownerGone,
    workerSocketSilent: !socketAlive,
  });
  const report: RecoveryReport = {
    workerAlive: socketAlive || !ownerGone,
    recordedHostId: row.hostId,
    thisHostId,
    holder: {
      ownerUuid: row.ownerUuid,
      pid: row.pid,
      processStartTime: row.processStartTime,
      heartbeatAt: row.heartbeatAt,
      heartbeatAgeMs: heartbeatAgeMs(row.heartbeatAt, now),
      kind: row.kind,
    },
    workerGroup: row.workerGroup,
    socketProbed: row.socketPath,
    workerPid: row.workerPid,
    lastCheckpoint: row.lastCheckpoint,
    reclaimable: decision.reclaimable,
  };
  return { report, decision };
}

function insertLeaseRow(
  db: DatabaseSync,
  identity: LeaseIdentity,
  ownerUuid: string,
  opts: Required<Pick<LeaseAcquireOptions, "kind">> & {
    socketPath: string | null;
    workerGroup: string | null;
    workerPid: number | null;
    lastCheckpoint: string | null;
    migmateVersion: string;
    now: () => Date;
  },
): void {
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
    ownerUuid,
    identity.hostId,
    identity.pid,
    identity.processStartTime,
    opts.now().toISOString(),
    opts.kind,
    opts.socketPath,
    opts.workerGroup,
    opts.workerPid,
    opts.lastCheckpoint,
    opts.migmateVersion,
  );
}

function updateLeaseHeartbeat(db: DatabaseSync, row: LeaseRow, now: () => Date): boolean {
  const result = db
    .prepare(
      `
        UPDATE lease
        SET heartbeat_at = ?
        WHERE id = 1
          AND owner_uuid = ?
          AND host_id = ?
          AND pid = ?
          AND process_start_time = ?
      `,
    )
    .run(now().toISOString(), row.ownerUuid, row.hostId, row.pid, row.processStartTime);
  return result.changes === 1;
}

function deleteLeaseRow(db: DatabaseSync, row: LeaseRow): boolean {
  const result = db
    .prepare(
      `
        DELETE FROM lease
        WHERE id = 1
          AND owner_uuid = ?
          AND host_id = ?
          AND pid = ?
          AND process_start_time = ?
      `,
    )
    .run(row.ownerUuid, row.hostId, row.pid, row.processStartTime);
  return result.changes === 1;
}

function startHeartbeatTimer(
  db: DatabaseSync,
  handle: LeaseHandle,
  heartbeatMs: number,
  now: () => Date,
): void {
  const timer = setInterval(() => {
    if (!updateLeaseHeartbeat(db, handle.row, now)) {
      const currentTimer = handle.timer;
      if (currentTimer !== null) {
        clearInterval(currentTimer);
        handle.timer = null;
      }
    }
  }, heartbeatMs);
  timer.unref();
  handle.timer = timer;
}

function selectRefusalCode(decision: ReclaimDecision): RefusalCode {
  if (decision.code !== null) {
    return decision.code;
  }
  return "lease_stale_worker_alive";
}

/** Pid alone is worthless because pid reuse can make a dead holder look alive. */
export function getHostId(home: string): string {
  const existing = readHostIdFile(home);
  if (existing !== null) {
    return existing;
  }
  const hostId = randomUUID();
  writeHostIdFile(home, hostId);
  return readHostIdFile(home) ?? hostId;
}

export function getProcessStartTime(pid = process.pid): number {
  const startTime = readProcessStartTime(pid);
  if (startTime !== null) {
    return startTime;
  }
  return pid === process.pid ? readCurrentProcessStartTime() : Number.NaN;
}

export function processAlive(pid: number, startTime: number): boolean {
  const actual = readProcessStartTime(pid);
  if (actual !== null) {
    return actual === startTime;
  }
  if (pid !== process.pid) {
    return false;
  }
  return readCurrentProcessStartTime() === startTime;
}

export async function probeWorker(socketPath: string): Promise<boolean> {
  if (!socketPath) {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    const finish = (alive: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

export function evaluateReclaim(i: ReclaimInputs): ReclaimDecision {
  if (!i.hostMatches) {
    return { reclaimable: false, code: "foreign_host" };
  }
  if (!i.heartbeatExpired) {
    return { reclaimable: false, code: "lease_held" };
  }
  if (!i.ownerProcessGone || !i.workerSocketSilent) {
    return { reclaimable: false, code: "lease_stale_worker_alive" };
  }
  return { reclaimable: true, code: null };
}

export async function buildRecoveryReport(
  row: LeaseRow,
  thisHostId: string,
  opts: {
    now?: () => Date;
    expiryMs?: number;
    probeWorker?: (socketPath: string) => Promise<boolean>;
    processAlive?: (pid: number, startTime: number) => boolean;
  } = {},
): Promise<RecoveryReport> {
  return (await inspectLeaseRow(row, thisHostId, opts)).report;
}

export async function acquire(
  db: DatabaseSync,
  identity: LeaseIdentity,
  opts: LeaseAcquireOptions,
): Promise<Outcome<LeaseHandle>> {
  const existing = readLeaseRow(db);
  const now = opts.now ?? (() => new Date());
  const migmateVersion = opts.migmateVersion ?? MIGMATE_VERSION;
  if (existing !== null) {
    const inspection = await inspectLeaseRow(existing, identity.hostId, opts);
    return refuse(selectRefusalCode(inspection.decision), "writer lease is already held", {
      recovery: inspection.report,
    });
  }

  const ownerUuid = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = readLeaseRow(db);
    if (current !== null) {
      db.exec("ROLLBACK");
      const inspection = await inspectLeaseRow(current, identity.hostId, opts);
      return refuse(selectRefusalCode(inspection.decision), "writer lease is already held", {
        recovery: inspection.report,
      });
    }
    insertLeaseRow(db, identity, ownerUuid, {
      kind: opts.kind,
      socketPath: opts.socketPath ?? null,
      workerGroup: opts.workerGroup ?? null,
      workerPid: opts.workerPid ?? null,
      lastCheckpoint: opts.lastCheckpoint ?? null,
      migmateVersion,
      now,
    });
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already have been unwound.
    }
    throw error;
  }

  const row = readLeaseRow(db);
  if (row === null) {
    throw new Error("writer lease vanished after acquisition");
  }
  return ok({ row, timer: null });
}

export function heartbeat(
  db: DatabaseSync,
  handle: LeaseHandle,
  now: () => Date = () => new Date(),
): boolean {
  const updated = updateLeaseHeartbeat(db, handle.row, now);
  if (!updated) {
    const timer = handle.timer;
    if (timer !== null) {
      clearInterval(timer);
      handle.timer = null;
    }
  }
  return updated;
}

export function release(db: DatabaseSync, handle: LeaseHandle): boolean {
  const timer = handle.timer;
  if (timer !== null) {
    clearInterval(timer);
    handle.timer = null;
  }
  return deleteLeaseRow(db, handle.row);
}

export async function withLease<T>(
  db: DatabaseSync,
  identity: LeaseIdentity,
  opts: LeaseAcquireOptions,
  fn: (lease: LeaseHandle) => Promise<T>,
): Promise<Outcome<T>> {
  const acquired = await acquire(db, identity, opts);
  if (!acquired.ok) {
    return acquired;
  }

  const handle = acquired.value;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const now = opts.now ?? (() => new Date());
  startHeartbeatTimer(db, handle, heartbeatMs, now);

  try {
    return ok(await fn(handle));
  } finally {
    release(db, handle);
  }
}

export async function reconcileWriterOpen(
  db: DatabaseSync,
  reconcileOnWriterOpen: (state: JobState) => JobState,
  opts: {
    now?: () => Date;
    expiryMs?: number;
    probeWorker?: (socketPath: string) => Promise<boolean>;
    processAlive?: (pid: number, startTime: number) => boolean;
    hostId?: string;
  } = {},
): Promise<LeaseReconciliationResult> {
  const job = readJobRow(db);
  const lease = readLeaseRow(db);
  if (lease === null) {
    return { changed: false, state: job.state, recovery: null };
  }

  const inspection = await inspectLeaseRow(lease, opts.hostId ?? lease.hostId, opts);
  if (!inspection.decision.reclaimable || job.state !== "executing") {
    return { changed: false, state: job.state, recovery: inspection.report };
  }

  const nextState = reconcileOnWriterOpen(job.state);
  if (nextState === job.state) {
    return { changed: false, state: job.state, recovery: inspection.report };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE job SET state = ? WHERE id = ?").run(nextState, job.id);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already have failed closed.
    }
    throw error;
  }

  return { changed: true, state: nextState, recovery: inspection.report };
}
