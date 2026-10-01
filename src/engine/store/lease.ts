import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import net from "node:net";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { ok, refuse } from "../types.ts";
import type { JobState, Outcome, RecoveryReport, RefusalCode } from "../types.ts";
import { withSocketPath } from "../providers/socket-path.ts";
import { reconcileOnWriterOpen } from "../state-chart.ts";
import { canonicalJson } from "./digest.ts";

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

export interface LeaseRow extends LeaseIdentity {
  ownerUuid: string;
  heartbeatAt: string;
  kind: "cli" | "web";
  socketPath: string | null;
  workerGroup: string | null;
  workerPid: number | null;
  workerProcessStartTime: number | null;
  workerExecutable: string | null;
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

type Presence = "alive" | "absent" | "unknown";
type ProcessStatus = Presence | "mismatched";

export interface LeaseInspectionOptions {
  now?: () => Date;
  expiryMs?: number;
  probeWorker?: (socketPath: string) => Promise<boolean | null>;
  processAlive?: (pid: number, startTime: number) => boolean | null;
}

export interface LeaseAcquireOptions extends LeaseInspectionOptions {
  kind: "cli" | "web";
  socketPath?: string | null;
  workerGroup?: string | null;
  workerPid?: number | null;
  workerProcessStartTime?: number | null;
  workerExecutable?: string | null;
  lastCheckpoint?: string | null;
  migmateVersion?: string;
  heartbeatMs?: number;
}

export interface LeaseInspection {
  report: RecoveryReport;
  decision: ReclaimDecision;
  stopEligible: boolean;
  ownerStatus: ProcessStatus;
  workerStatus: Presence;
  socketStatus: Presence;
}

export interface LeaseReconciliationResult {
  changed: boolean;
  state: JobState;
  recovery: RecoveryReport | null;
}

interface JobRow {
  id: string;
  state: JobState;
  hostId: string | null;
  lastCheckpoint: string | null;
}

interface ProcessIdentity {
  startTime: number;
  uid: string | null;
  executable: string | null;
  // Linux exposes argv boundaries. macOS ps exposes a flat command;
  // its exact rcd prefix is checked separately, never shell-tokenized.
  argv: string[] | null;
  command: string | null;
}

type ProcessObservation =
  { status: "alive"; identity: ProcessIdentity } | { status: "absent" | "unknown" };

const SELECT_LEASE_SQL = `SELECT owner_uuid AS ownerUuid, host_id AS hostId, pid,
  process_start_time AS processStartTime, heartbeat_at AS heartbeatAt, kind,
  socket_path AS socketPath, worker_group AS workerGroup, worker_pid AS workerPid,
  worker_process_start_time AS workerProcessStartTime, worker_executable AS workerExecutable,
  last_checkpoint AS lastCheckpoint, migmate_version AS migmateVersion FROM lease WHERE id = 1`;

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function readProcess(pid: number): ProcessObservation {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "unknown" };
  try {
    if (process.platform === "linux") {
      // Field 22 is the kernel start tick, not a wall-clock approximation. It is
      // compared as an opaque identity and cannot change when the clock changes.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(") ");
      if (end < 0) return { status: "unknown" };
      const fields = stat
        .slice(end + 2)
        .trim()
        .split(/\s+/u);
      const startTime = Number(fields[19]);
      if (!Number.isSafeInteger(startTime) || startTime <= 0) return { status: "unknown" };
      if (fields[0] === "Z" || fields[0] === "X") return { status: "absent" };
      const uid = /^Uid:\s+(\d+)\s+(\d+)/mu.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      let executable: string | null = null;
      let argv: string[] | null = null;
      try {
        executable = readlinkSync(`/proc/${pid}/exe`);
        argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (argv.at(-1) === "") argv.pop();
      } catch {
        /* Inaccessible process details never authorize termination. */
      }
      return {
        status: "alive",
        identity: { startTime, uid: uid?.[2] ?? null, executable, argv, command: null },
      };
    }
    if (process.platform === "darwin") {
      const result = spawnSync(
        "/bin/ps",
        ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "uid=", "-o", "stat=", "-o", "comm="],
        {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 1024 * 1024,
          env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
        },
      );
      if (result.error || result.status !== 0 || !result.stdout.trim()) {
        return processExistence(pid);
      }
      const match =
        /^\s*(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(
          result.stdout.trim(),
        );
      if (!match) return { status: "unknown" };
      const startTime = Date.parse(`${match[1]!} UTC`);
      if (!Number.isFinite(startTime)) return { status: "unknown" };
      if (match[3]!.startsWith("Z")) return { status: "absent" };
      const args = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "args="], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      });
      return {
        status: "alive",
        identity: {
          startTime,
          uid: match[2]!,
          executable: match[4]!,
          argv: null,
          command: args.error || args.status !== 0 ? null : args.stdout.trim(),
        },
      };
    }
  } catch (error) {
    // Only an absent process directory / ESRCH proves loss; EPERM, malformed
    // output, missing tools, timeouts and unsupported platforms remain unknown.
    if (process.platform === "linux" && isErrnoCode(error, "ENOENT")) return processExistence(pid);
  }
  return { status: "unknown" };
}

function processExistence(pid: number): ProcessObservation {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) return { status: "absent" };
  }
  return { status: "unknown" };
}

function statusOf(observation: ProcessObservation, startTime: number): ProcessStatus {
  if (!Number.isSafeInteger(startTime) || startTime <= 0) return "unknown";
  if (observation.status !== "alive") return observation.status;
  return observation.identity.startTime === startTime ? "alive" : "mismatched";
}

export function getProcessStartTime(pid = process.pid): number {
  const observed = readProcess(pid);
  if (observed.status !== "alive")
    throw new Error("Process start identity could not be established");
  return observed.identity.startTime;
}

/** Unknown is deliberately distinct from false: callers must never negate it. */
export function processAlive(pid: number, startTime: number): boolean | null {
  const status = statusOf(readProcess(pid), startTime);
  return status === "unknown" ? null : status === "alive";
}

function privatePath(path: string, directory: boolean): boolean {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) return false;
    return (
      process.getuid !== undefined && info.uid === process.getuid() && (info.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

/** A reader must not create a home, repair permissions, or replace identity. */
export function readHostId(home: string): string | null {
  const file = join(home, "hostId");
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const before = lstatSync(file),
      opened = fstatSync(fd);
    if (
      !privatePath(home, true) ||
      !privatePath(file, false) ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      !opened.isFile()
    )
      throw new Error("Unsafe host identity file");
    const hostId = readFileSync(fd, "utf8").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(hostId))
      throw new Error("Invalid host identity file");
    return hostId;
  } finally {
    closeSync(fd);
  }
}

export function getHostId(home: string): string {
  const existing = readHostId(home);
  if (existing !== null) return existing;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (lstatSync(home).isSymbolicLink()) throw new Error("Unsafe engine home");
  if (!privatePath(home, true)) throw new Error("Unsafe engine home");
  const file = join(home, "hostId"),
    temp = join(home, `.hostId.${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      writeFileSync(fd, `${randomUUID()}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, file);
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
    }
  } finally {
    unlinkSync(temp);
    const directory = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  const installed = readHostId(home);
  if (installed === null) throw new Error("Host identity installation failed");
  return installed;
}

/** Any answer proves liveness; only definitive refusal/absence proves silence. */
export async function probeWorker(socketPath: string): Promise<boolean | null> {
  if (!socketPath || !isAbsolute(socketPath)) return null;
  try {
    return await withSocketPath(
      socketPath,
      async (path) =>
        await new Promise<boolean | null>((resolveProbe) => {
          const socket = net.createConnection({ path });
          const finish = (value: boolean | null): void => {
            socket.removeAllListeners();
            socket.destroy();
            resolveProbe(value);
          };
          socket.once("connect", () => finish(true));
          socket.once("error", (error) =>
            finish(
              isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ECONNREFUSED") ? false : null,
            ),
          );
          socket.setTimeout(1_000, () => finish(null));
        }),
    );
  } catch (error) {
    return isErrnoCode(error, "ENOENT") ? false : null;
  }
}

function heartbeatAgeMs(heartbeatAt: string, now: () => Date): number {
  const elapsed = now().getTime() - Date.parse(heartbeatAt);
  // Malformed clocks must not manufacture an expired heartbeat.
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

export function evaluateReclaim(i: ReclaimInputs): ReclaimDecision {
  if (!i.hostMatches) return { reclaimable: false, code: "foreign_host" };
  if (!i.heartbeatExpired || !i.ownerProcessGone) return { reclaimable: false, code: "lease_held" };
  if (!i.workerSocketSilent) return { reclaimable: false, code: "lease_stale_worker_alive" };
  return { reclaimable: true, code: null };
}

// CWD is an OS fact, not inferred from the worker's --cache-dir argument.
function readProcessCwd(pid: number): string | null {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    if (process.platform === "darwin") {
      const result = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F0n"], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 65536,
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin" },
      });
      if (result.error || result.status !== 0) return null;
      const names = result.stdout.split("\0").filter((field) => field.startsWith("n"));
      return names.length === 1 ? names[0]!.slice(1) : null;
    }
  } catch {
    /* Unknown cwd cannot prove relative socket ownership. */
  }
  return null;
}

function workerOwned(row: LeaseRow, observed: ProcessObservation): boolean {
  if (
    observed.status !== "alive" ||
    !row.workerPid ||
    !row.workerProcessStartTime ||
    !row.workerExecutable ||
    !row.socketPath ||
    !row.workerGroup?.trim() ||
    !isAbsolute(row.workerExecutable) ||
    !isAbsolute(row.socketPath) ||
    statusOf(observed, row.workerProcessStartTime) !== "alive"
  )
    return false;
  const identity = observed.identity,
    directory = dirname(row.socketPath),
    cwd = readProcessCwd(row.workerPid);
  if (
    identity.uid !== String(process.getuid?.()) ||
    !identity.executable ||
    !isAbsolute(identity.executable) ||
    !cwd ||
    !isAbsolute(cwd) ||
    !privatePath(directory, true)
  )
    return false;
  try {
    if (
      realpathSync(identity.executable) !== realpathSync(row.workerExecutable) ||
      realpathSync(directory) !== resolve(directory) ||
      realpathSync(cwd) !== realpathSync(directory)
    )
      return false;
  } catch {
    return false;
  }
  if (basename(row.socketPath) !== "s" || !basename(directory).startsWith("rc-")) return false;
  const expected = "unix://s";
  if (identity.argv !== null) {
    const argv = identity.argv;
    if (
      argv[1] !== "rcd" ||
      argv[2] !== "--rc-addr" ||
      argv[3] !== expected ||
      argv[4] !== "--rc-serve"
    )
      return false;
    for (const flag of ["--cache-dir", "--temp-dir"]) {
      const index = argv.indexOf(flag);
      if (index < 0 || argv[index + 1] !== directory || argv.lastIndexOf(flag) !== index)
        return false;
    }
    return argv.lastIndexOf("--rc-addr") === 2;
  }
  // macOS ps returns the actual kernel executable separately. Its argv display
  // is not shell syntax: compare the complete fixed leading arguments including
  // the trailing flag, so a socket substring or quoted lookalike cannot match.
  const directories = ` --cache-dir ${directory} --temp-dir ${directory}`;
  return (
    identity.command !== null &&
    identity.command.startsWith(
      `${row.workerExecutable} rcd --rc-addr ${expected} --rc-serve --config `,
    ) &&
    (identity.command.includes(`${directories} `) || identity.command.endsWith(directories)) &&
    identity.command.indexOf(" --rc-addr ", identity.command.indexOf(" --rc-addr ") + 1) === -1
  );
}

export async function inspectLease(
  row: LeaseRow,
  thisHostId: string,
  opts: LeaseInspectionOptions = {},
): Promise<LeaseInspection> {
  const now = opts.now ?? (() => new Date());
  const age = heartbeatAgeMs(row.heartbeatAt, now);
  const hostMatches = row.hostId === thisHostId;
  let ownerStatus: ProcessStatus = "unknown",
    socketStatus: Presence = "unknown",
    workerStatus: Presence = "unknown";
  let worker: ProcessObservation = { status: "unknown" };
  if (hostMatches) {
    try {
      if (opts.processAlive) {
        const alive = opts.processAlive(row.pid, row.processStartTime);
        ownerStatus = alive === true ? "alive" : alive === false ? "absent" : "unknown";
      } else ownerStatus = statusOf(readProcess(row.pid), row.processStartTime);
    } catch {
      ownerStatus = "unknown";
    }
    if (row.socketPath === null) socketStatus = "absent";
    else {
      try {
        const alive = await (opts.probeWorker ?? probeWorker)(row.socketPath);
        socketStatus = alive === true ? "alive" : alive === false ? "absent" : "unknown";
      } catch {
        socketStatus = "unknown";
      }
    }
    worker = row.workerPid === null ? { status: "absent" } : readProcess(row.workerPid);
    if (socketStatus === "alive") workerStatus = "alive";
    else if (worker.status === "alive") {
      workerStatus =
        row.workerProcessStartTime !== null &&
        statusOf(worker, row.workerProcessStartTime) === "alive"
          ? "alive"
          : "unknown";
    } else if (socketStatus === "absent" && worker.status === "absent") {
      // A socket/group claim without its PID is incomplete, not proof of loss.
      workerStatus =
        row.workerPid !== null ||
        (row.socketPath === null &&
          row.workerGroup === null &&
          row.workerProcessStartTime === null &&
          row.workerExecutable === null)
          ? "absent"
          : "unknown";
    }
  }
  const ownerGone = ownerStatus === "absent" || ownerStatus === "mismatched";
  const expired = age >= (opts.expiryMs ?? LEASE_EXPIRY_MS);
  const decision = evaluateReclaim({
    heartbeatExpired: expired,
    hostMatches,
    ownerProcessGone: ownerGone,
    workerSocketSilent: socketStatus === "absent" && workerStatus === "absent",
  });
  return {
    decision,
    ownerStatus,
    workerStatus,
    socketStatus,
    stopEligible:
      hostMatches &&
      expired &&
      ownerGone &&
      workerStatus === "alive" &&
      socketStatus !== "unknown" &&
      workerOwned(row, worker),
    report: {
      workerAlive: workerStatus === "alive",
      workerStatus,
      recordedHostId: row.hostId,
      thisHostId,
      holder: {
        ownerUuid: row.ownerUuid,
        pid: row.pid,
        processStartTime: row.processStartTime,
        heartbeatAt: row.heartbeatAt,
        heartbeatAgeMs: age,
        kind: row.kind,
      },
      workerGroup: row.workerGroup,
      lastCheckpoint: row.lastCheckpoint,
      reclaimable: decision.reclaimable,
    },
  };
}

export async function buildRecoveryReport(
  row: LeaseRow,
  thisHostId: string,
  opts: LeaseInspectionOptions = {},
): Promise<RecoveryReport> {
  return (await inspectLease(row, thisHostId, opts)).report;
}

/** Only called after inspectLease authorizes deliberate recovery on this host.
 * The durable group is a run association, not an OS group or usable RC job id.
 * Lost memory-only RC credentials preclude cooperative RC shutdown. */
export async function stopOrphanWorker(row: LeaseRow): Promise<boolean> {
  if (row.workerPid === null || row.workerPid === process.pid) return false;
  const maySignal = async (): Promise<boolean> => {
    const owner = statusOf(readProcess(row.pid), row.processStartTime);
    if (owner !== "absent" && owner !== "mismatched") return false;
    if (
      heartbeatAgeMs(row.heartbeatAt, () => new Date()) < LEASE_EXPIRY_MS ||
      row.socketPath === null ||
      (await probeWorker(row.socketPath)) === null
    )
      return false;
    return (
      workerOwned(row, readProcess(row.workerPid!)) &&
      statusOf(readProcess(row.workerPid!), row.workerProcessStartTime ?? Number.NaN) === "alive"
    );
  };
  // Each signal is authorized by maySignal's full ownership proof. Waiting for
  // the exit cannot repeat it: a dying process loses its executable, argv and
  // cwd links before it is reaped, so an unreadable identity would read as
  // "not ours" and abandon a worker this host has already terminated. The
  // recorded start time still identifies the pid, so only proven reuse stops
  // the bounded wait.
  const awaitAbsent = async (timeout: number): Promise<boolean> => {
    const deadline = performance.now() + timeout;
    do {
      const observed = readProcess(row.workerPid!);
      if (observed.status === "absent") return true;
      if (statusOf(observed, row.workerProcessStartTime ?? Number.NaN) === "mismatched")
        return false;
      await delay(50);
    } while (performance.now() < deadline);
    return false;
  };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!(await maySignal())) return false;
    try {
      process.kill(row.workerPid, signal);
    } catch (error) {
      return isErrnoCode(error, "ESRCH");
    }
    if (await awaitAbsent(signal === "SIGTERM" ? 3_000 : 1_000)) return true;
  }
  return false;
}

function readLeaseRow(db: DatabaseSync): LeaseRow | null {
  return (db.prepare(SELECT_LEASE_SQL).get() as LeaseRow | undefined) ?? null;
}

function readJobRow(db: DatabaseSync): JobRow {
  const row = db
    .prepare(
      "SELECT id, state, host_id AS hostId, last_checkpoint AS lastCheckpoint FROM job LIMIT 1",
    )
    .get() as JobRow | undefined;
  if (!row) throw new Error("Job row missing");
  return row;
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* The failed transaction is already unwound. */
  }
}

/** Caller holds the write transaction after inspection authorizes recovery.
 * Compare the snapshot before clearing it and recording durable recovery. */
export function reclaimLease(db: DatabaseSync, lease: LeaseRow, now: () => Date): boolean {
  const cleared = db
    .prepare("DELETE FROM lease WHERE id = 1 AND owner_uuid = ? AND heartbeat_at = ?")
    .run(lease.ownerUuid, lease.heartbeatAt);
  if (cleared.changes !== 1) return false;
  const job = readJobRow(db);
  db.prepare("UPDATE job SET state = ?, host_id = COALESCE(host_id, ?) WHERE id = ?").run(
    reconcileOnWriterOpen(job.state),
    lease.hostId,
    job.id,
  );
  const at = now().toISOString();
  db.prepare(
    "INSERT INTO projection_verb_state (verb,state,checkpoint,updated_at) VALUES ('status','done',NULL,?) ON CONFLICT(verb) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at",
  ).run(at);
  db.prepare(
    "INSERT INTO event (at,verb,phase,kind,payload) VALUES (?,'status','status','phase_completed',?)",
  ).run(at, canonicalJson({ reclaimed: true, checkpoint: job.lastCheckpoint }));
  return true;
}

export async function acquire(
  db: DatabaseSync,
  identity: LeaseIdentity,
  opts: LeaseAcquireOptions,
): Promise<Outcome<LeaseHandle>> {
  const now = opts.now ?? (() => new Date());
  if (
    !identity.hostId ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    !Number.isSafeInteger(identity.processStartTime) ||
    identity.processStartTime <= 0
  )
    throw new Error("Invalid lease identity");
  const ownerUuid = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  let row: LeaseRow;
  try {
    const job = readJobRow(db),
      existing = readLeaseRow(db);
    if (job.hostId !== null && job.hostId !== identity.hostId) {
      db.exec("ROLLBACK");
      return refuse("foreign_host", "Live job state belongs to another host", {
        recovery: {
          recordedHostId: job.hostId,
          thisHostId: identity.hostId,
          holder: null,
          workerAlive: false,
          workerStatus: "unknown",
          workerGroup: existing?.workerGroup ?? null,
          lastCheckpoint: job.lastCheckpoint,
          reclaimable: false,
        },
      });
    }
    if (existing !== null) {
      db.exec("ROLLBACK");
      const inspection = await inspectLease(existing, identity.hostId, opts);
      if (!inspection.decision.reclaimable)
        return refuse(
          inspection.decision.code ?? "lease_held",
          "The existing lease requires explicit recovery",
          { recovery: inspection.report },
        );
      db.exec("BEGIN IMMEDIATE");
      if (!reclaimLease(db, existing, now)) {
        db.exec("ROLLBACK");
        return refuse("lease_held", "Ownership changed during recovery.", {
          recovery: inspection.report,
        });
      }
    }
    row = {
      ...identity,
      ownerUuid,
      heartbeatAt: now().toISOString(),
      kind: opts.kind,
      socketPath: opts.socketPath ?? null,
      workerGroup: opts.workerGroup ?? null,
      workerPid: opts.workerPid ?? null,
      workerProcessStartTime: opts.workerProcessStartTime ?? null,
      workerExecutable: opts.workerExecutable ?? null,
      lastCheckpoint: opts.lastCheckpoint ?? job.lastCheckpoint,
      migmateVersion: opts.migmateVersion ?? MIGMATE_VERSION,
    };
    db.prepare(
      `INSERT INTO lease (id, owner_uuid, host_id, pid, process_start_time, heartbeat_at, kind,
      socket_path, worker_group, worker_pid, worker_process_start_time, worker_executable, last_checkpoint, migmate_version)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    db.prepare("UPDATE job SET host_id = ? WHERE id = ? AND host_id IS NULL").run(
      identity.hostId,
      job.id,
    );
    db.exec("COMMIT");
  } catch (error) {
    rollback(db);
    throw error;
  }
  const handle: LeaseHandle = { row, timer: null };
  handle.timer = setInterval(() => {
    try {
      heartbeat(db, handle, now);
    } catch {
      clearInterval(handle.timer ?? undefined);
      handle.timer = null;
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  handle.timer.unref();
  return ok(handle);
}

export function heartbeat(
  db: DatabaseSync,
  handle: LeaseHandle,
  now: () => Date = () => new Date(),
): boolean {
  const row = handle.row;
  const updated =
    db
      .prepare(
        `UPDATE lease SET heartbeat_at = ? WHERE id = 1 AND owner_uuid = ?
    AND host_id = ? AND pid = ? AND process_start_time = ?`,
      )
      .run(now().toISOString(), row.ownerUuid, row.hostId, row.pid, row.processStartTime)
      .changes === 1;
  if (!updated && handle.timer !== null) {
    clearInterval(handle.timer);
    handle.timer = null;
  }
  return updated;
}

export function release(db: DatabaseSync, handle: LeaseHandle): boolean {
  if (handle.timer !== null) {
    clearInterval(handle.timer);
    handle.timer = null;
  }
  const row = handle.row;
  // A surviving worker claim must be recovered explicitly, never discarded by
  // a finally block. The controlled supervisor clears the claim after exit.
  return (
    db
      .prepare(
        `DELETE FROM lease WHERE id = 1 AND owner_uuid = ? AND host_id = ?
    AND pid = ? AND process_start_time = ? AND socket_path IS NULL AND worker_pid IS NULL
    AND worker_group IS NULL AND worker_process_start_time IS NULL AND worker_executable IS NULL`,
      )
      .run(row.ownerUuid, row.hostId, row.pid, row.processStartTime).changes === 1
  );
}

export async function withLease<T>(
  db: DatabaseSync,
  identity: LeaseIdentity,
  opts: LeaseAcquireOptions,
  fn: (lease: LeaseHandle) => Promise<T>,
): Promise<Outcome<T>> {
  const acquired = await acquire(db, identity, opts);
  if (!acquired.ok) return acquired;
  try {
    return ok(await fn(acquired.value));
  } finally {
    release(db, acquired.value);
  }
}

/** Writer-open reconciliation is not reclaim. Only the freshly acquired owner
 * may rewrite executing, under the same write lock that rechecks ownership. */
export async function reconcileWriterOpen(
  db: DatabaseSync,
  reconcile: (state: JobState) => JobState,
  opts: LeaseInspectionOptions & { hostId?: string; ownerUuid?: string } = {},
): Promise<LeaseReconciliationResult> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = readJobRow(db),
      lease = readLeaseRow(db);
    const owned =
      lease !== null &&
      opts.ownerUuid !== undefined &&
      lease.ownerUuid === opts.ownerUuid &&
      opts.hostId === lease.hostId &&
      job.hostId === opts.hostId &&
      lease.pid === process.pid &&
      statusOf(readProcess(lease.pid), lease.processStartTime) === "alive";
    if (!owned || job.state !== "executing") {
      db.exec("ROLLBACK");
      const recovery =
        lease === null ? null : (await inspectLease(lease, opts.hostId ?? "", opts)).report;
      return { changed: false, state: job.state, recovery };
    }
    const next = reconcile(job.state);
    db.prepare("UPDATE job SET state = ? WHERE id = ?").run(next, job.id);
    db.exec("COMMIT");
    return { changed: next !== job.state, state: next, recovery: null };
  } catch (error) {
    rollback(db);
    throw error;
  }
}
