import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ok,
  refuse,
  VERBS,
  type ApprovalRecord,
  type ArtifactSet,
  type CheckResult,
  type EventKind,
  type FacetCount,
  type FileItemRow,
  type JobEvent,
  type JobState,
  type JobStatus,
  type JobType,
  type Outcome,
  type PlanRevision,
  type Progress,
  type Row,
  type RowPage,
  type RowPhase,
  type RowQuery,
  type VerificationRevision,
  type Verb,
} from "../types.ts";
import type {
  CommitRow,
  CommitUnit,
  CommitReceipt,
  DurableAsset,
  FileCommitRow,
} from "../commit.ts";
import type {
  ArchiveCollectionEvidence,
  ArchivePlan,
  ArchiveRecord,
  ArchiveResumeState,
} from "../providers/archive.ts";
import { canonicalJson, digestJson } from "./digest.ts";

export const SCHEMA_VERSION = 2;
const BUSY_TIMEOUT_MS = 5_000;
const schemaSql = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
const extensionMarker = "-- Full file intents/results are retained";
type SqlRow = Record<string, unknown>;
interface StoredResource {
  kind: "asset" | "package";
  path: string;
  sha256: string;
  size: number;
}

export type {
  CommitFinding,
  CommitReceipt,
  CommitRow,
  CommitRowBase,
  CommitUnit,
  ConversationCommitRow,
  DurableAsset,
  FileCommitRow,
} from "../commit.ts";

export interface JobRecord {
  id: string;
  type: JobType;
  state: JobState;
  schemaVersion: number;
  migmateVersion: string;
  label: string | null;
  createdAt: string;
  planRevision: number | null;
  verificationRevision: number | null;
  lastCheckpoint: string | null;
  hostId: string | null;
  executionCompleted?: boolean;
}
export interface LeaseRecord {
  ownerUuid: string;
  hostId: string;
  pid: number;
  processStartTime: number;
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
export interface PlanRevisionRecord extends PlanRevision {
  inputs: Record<string, string>;
  evidence: unknown;
}
export interface VerificationRevisionRecord extends VerificationRevision {
  planRev: number;
}
export interface AcceptanceRecord {
  verificationDigest: string;
  code: string;
  approver: string;
  note: string | null;
  at: string;
}
export interface FindingRecord {
  id?: number;
  rev: number;
  phase: RowPhase;
  code: string;
  kind: "policy_outcome" | "planned_omission" | "finding";
  subjectKind: string;
  subjectId: string;
  evidence: unknown;
  at: string;
}
export interface CheckResultRecord extends CheckResult {
  verb: Verb;
  at: string;
}
export interface ResumeRecord extends ArchiveResumeState {
  rows: CommitRow[];
  watermarks: Record<string, string>;
  committedUnits: string[];
}
export interface Store {
  close(): void;
  // Only lease handling and crash reconciliation may use raw SQL.
  readonly db: DatabaseSync;
  atomic<T>(fn: () => T): T;
  readJob(): JobRecord | null;
  writeJob(job: JobRecord): void;
  readLease(): LeaseRecord | null;
  writeLease(lease: LeaseRecord): void;
  clearLease(): void;
  touchLease(update: { heartbeatAt: string; lastCheckpoint?: string | null }): void;
  nextPlanRevision(): number;
  nextVerificationRun(): number;
  readPlanRevision(revision: number): PlanRevisionRecord | null;
  writePlanRevision(record: PlanRevisionRecord): void;
  readApproval(revision: number): ApprovalRecord | null;
  writeApproval(record: ApprovalRecord): void;
  readVerificationRevision(revision: number): VerificationRevisionRecord | null;
  writeVerificationRevision(record: VerificationRevisionRecord): void;
  beginVerification(planRev: number, verificationRun: number): void;
  readAcceptances(verificationDigest: string): AcceptanceRecord[];
  writeAcceptance(record: AcceptanceRecord): void;
  writeAcceptances(records: AcceptanceRecord[]): void;
  readFindings(revision: number, phase?: RowPhase): FindingRecord[];
  currentPhase(revision: number): RowPhase;
  readCurrentFindings(revision: number, phase: RowPhase): FindingRecord[];
  currentFindingCounts(revision: number, phase: RowPhase): FacetCount[];
  writeFinding(record: FindingRecord): void;
  readCheckResults(verb?: Verb): CheckResultRecord[];
  writeCheckResult(record: CheckResultRecord): void;
  readResume(revision: number): ResumeRecord;
  readAllRows(revision: number, phase?: RowPhase): CommitRow[];
  writeArtifactSet(value: ArtifactSet): void;
  readArtifactSet(): ArtifactSet;
  commit(unit: CommitUnit): CommitReceipt;
  publishProgress(): void;
  finishOperation(): void;
  rows(query: RowQuery): RowPage;
  appendEvent(e: {
    verb: Verb;
    phase: Verb;
    kind: EventKind;
    payload: Record<string, unknown>;
  }): number;
  events(query: { from?: number; follow?: boolean; signal?: AbortSignal }): AsyncIterable<JobEvent>;
  status(): JobStatus;
}

const transactionDepth = new WeakMap<DatabaseSync, number>();
function transaction<T>(db: DatabaseSync, fn: () => T, write = true): T {
  const depth = transactionDepth.get(db) ?? 0;
  const savepoint = `store_${depth}`;
  db.exec(depth === 0 ? (write ? "BEGIN IMMEDIATE" : "BEGIN") : `SAVEPOINT ${savepoint}`);
  transactionDepth.set(db, depth + 1);
  try {
    const value = fn();
    if (value !== null && typeof value === "object" && "then" in value) {
      throw new TypeError("Store transactions require a synchronous callback");
    }
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
    return value;
  } catch (error) {
    try {
      db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    } catch {
      /* Preserve the original failure if SQLite already rolled back. */
    }
    throw error;
  } finally {
    transactionDepth.set(db, depth);
  }
}
function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
function parseEvidence(value: unknown): unknown {
  // Version 1 also allowed unquoted string evidence. New writes are always JSON.
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
function rowToJob(row: SqlRow): JobRecord {
  return {
    id: String(row.id),
    type: row.type as JobType,
    state: row.state as JobState,
    schemaVersion: Number(row.schema_version),
    migmateVersion: String(row.migmate_version),
    label: nullableString(row.label),
    createdAt: String(row.created_at),
    planRevision: nullableNumber(row.plan_revision),
    verificationRevision: nullableNumber(row.verification_revision),
    lastCheckpoint: nullableString(row.last_checkpoint),
    hostId: nullableString(row.host_id),
    executionCompleted: Number(row.execution_completed) === 1,
  };
}
function rowToLease(row: SqlRow): LeaseRecord {
  return {
    ownerUuid: String(row.owner_uuid),
    hostId: String(row.host_id),
    pid: Number(row.pid),
    processStartTime: Number(row.process_start_time),
    heartbeatAt: String(row.heartbeat_at),
    kind: row.kind as LeaseRecord["kind"],
    socketPath: nullableString(row.socket_path),
    workerGroup: nullableString(row.worker_group),
    workerPid: nullableNumber(row.worker_pid),
    workerProcessStartTime: nullableNumber(row.worker_process_start_time),
    workerExecutable: nullableString(row.worker_executable),
    lastCheckpoint: nullableString(row.last_checkpoint),
    migmateVersion: String(row.migmate_version),
  };
}
function rowToFinding(row: SqlRow): FindingRecord {
  return {
    id: Number(row.id),
    rev: Number(row.rev),
    phase: row.phase as RowPhase,
    code: String(row.code),
    kind: row.kind as FindingRecord["kind"],
    subjectKind: String(row.subject_kind),
    subjectId: String(row.subject_id),
    evidence: parseEvidence(row.evidence),
    at: String(row.at),
  };
}
function rowToCommit(table: "item" | "conversation", row: SqlRow): CommitRow {
  if (typeof row.payload === "string") return JSON.parse(row.payload) as CommitRow;
  const base = {
    id: String(row.id),
    rev: Number(row.rev),
    phase: row.phase as RowPhase,
    code: String(row.code),
    kind: row.kind as CommitRow["kind"],
    accepted: Number(row.accepted) === 1,
  };
  if (table === "item")
    return {
      ...base,
      jobType: "file_migration",
      mappingId: String(row.mapping_id),
      sourceDriveId: String(row.source_drive_id),
      sourceItemId: String(row.source_item_id),
      relativePath: String(row.relative_path),
      itemType: row.item_type as "file" | "folder",
      size: nullableNumber(row.size),
      sourceEtag: nullableString(row.source_etag),
      sourceFingerprint: nullableString(row.source_fingerprint),
      destinationDriveId: nullableString(row.dest_drive_id),
      destinationFileId: nullableString(row.dest_file_id),
      destinationFingerprint: nullableString(row.dest_fingerprint),
      provenanceState: row.provenance_state as FileItemRow["provenanceState"],
    };
  return {
    ...base,
    jobType: "teams_archive",
    scopeEntryId: String(row.scope_entry_id),
    conversationId: String(row.conversation_id),
    title: nullableString(row.title),
    records: Number(row.records),
    assets: Number(row.assets),
    watermark: nullableString(row.watermark),
  };
}
function facets(rows: SqlRow[]): FacetCount[] {
  return rows.map((row) => ({
    code: String(row.code),
    kind: row.kind as FacetCount["kind"],
    count: Number(row.count),
  }));
}
function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}
function schemaVersion(db: DatabaseSync): number | null {
  if (!tableExists(db, "job")) return null;
  const row = db.prepare("SELECT schema_version FROM job LIMIT 1").get();
  return row === undefined ? null : Number(row.schema_version);
}
function migrateVersion1(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE job ADD COLUMN host_id TEXT;
    ALTER TABLE job ADD COLUMN execution_completed INTEGER NOT NULL DEFAULT 0 CHECK (execution_completed IN (0, 1));
    UPDATE job SET host_id = (SELECT host_id FROM lease WHERE id = 1);
    UPDATE job SET execution_completed = 1 WHERE type = 'teams_archive' AND verification_revision IS NOT NULL;
    ALTER TABLE lease ADD COLUMN worker_process_start_time INTEGER;
    ALTER TABLE lease ADD COLUMN worker_executable TEXT;
    ALTER TABLE item ADD COLUMN payload TEXT;
    ALTER TABLE conversation ADD COLUMN payload TEXT;
    ALTER TABLE plan_revision ADD COLUMN payload TEXT;
    ALTER TABLE approval ADD COLUMN payload TEXT;
    ALTER TABLE verification_revision ADD COLUMN payload TEXT;
    ALTER TABLE verification_revision ADD COLUMN findings TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE commit_log RENAME TO commit_log_v1;
    CREATE TABLE commit_log (
      rev INTEGER NOT NULL, phase TEXT NOT NULL, unit_key TEXT NOT NULL,
      verification_run INTEGER NOT NULL DEFAULT 0, migmate_version TEXT NOT NULL,
      checkpoint TEXT NOT NULL, at TEXT NOT NULL, resources TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (rev, phase, verification_run, unit_key)
    ) STRICT;
    INSERT INTO commit_log (rev,phase,unit_key,verification_run,migmate_version,checkpoint,at) SELECT rev, phase, unit_key,
      CASE WHEN phase = 'verify' THEN COALESCE((SELECT verification_revision FROM job), 0) ELSE 0 END,
      (SELECT migmate_version FROM job), checkpoint, at FROM commit_log_v1;
    DROP TABLE commit_log_v1;
    ALTER TABLE watermark RENAME TO watermark_v1;
    CREATE TABLE watermark (
      rev INTEGER NOT NULL, unit_key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (rev, unit_key)
    ) STRICT;
    INSERT INTO watermark SELECT COALESCE((SELECT plan_revision FROM job), 0), unit_key, value, updated_at FROM watermark_v1;
    DROP TABLE watermark_v1;
  `);
  db.exec(schemaSql.slice(schemaSql.indexOf(extensionMarker)));
  for (const record of db
    .prepare("SELECT rev, plan_rev, at FROM verification_revision ORDER BY rev")
    .all()) {
    const summary = facets(
      db
        .prepare(
          "SELECT code, kind, COUNT(*) AS count FROM finding WHERE rev = ? AND phase = 'verify' GROUP BY code, kind ORDER BY code",
        )
        .all(Number(record.plan_rev)),
    );
    db.prepare("UPDATE verification_revision SET findings = ? WHERE rev = ?").run(
      canonicalJson(summary),
      Number(record.rev),
    );
    db.prepare(
      "INSERT INTO verification_run (plan_rev, run, started_at) VALUES (?, ?, ?) ON CONFLICT(plan_rev) DO UPDATE SET run = excluded.run, started_at = excluded.started_at",
    ).run(Number(record.plan_rev), Number(record.rev), String(record.at));
  }
  const conflictingAsset = db
    .prepare(
      "SELECT path FROM asset GROUP BY path HAVING COUNT(DISTINCT sha256)>1 OR COUNT(DISTINCT size)>1 LIMIT 1",
    )
    .get();
  if (conflictingAsset !== undefined)
    throw new Error("Legacy asset registrations disagree about the same path");
  db.exec(`
    INSERT INTO revision_asset SELECT DISTINCT COALESCE((SELECT plan_revision FROM job), 0), path, size, sha256 FROM asset;
    DELETE FROM projection_facet;
    INSERT INTO projection_facet (phase, rev, code, kind, count)
      SELECT phase, rev, code, kind, COUNT(*) FROM (
        SELECT phase, rev, code, kind FROM item UNION ALL SELECT phase, rev, code, kind FROM conversation
      ) GROUP BY phase, rev, code, kind;
  `);
  db.prepare("UPDATE job SET schema_version = ?").run(SCHEMA_VERSION);
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function directory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Durable path has a non-directory or symbolic-link parent");
}
function relativeParts(path: string): string[] {
  const parts = path.split("/");
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path) ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Unsafe durable relative path");
  }
  return parts;
}
function safePath(
  root: string,
  path: string,
  createParents = false,
  allowMissingParents = false,
): string {
  directory(root);
  const parts = relativeParts(path);
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    const child = join(parent, part);
    if (!existsSync(child) && createParents) {
      // lstat below rejects dangling symlinks rather than following them.
      mkdirSync(child, { mode: 0o700 });
      syncDirectory(parent);
    }
    try {
      directory(child);
    } catch (error) {
      if (allowMissingParents && (error as NodeJS.ErrnoException).code === "ENOENT")
        return join(root, ...parts);
      throw error;
    }
    parent = child;
  }
  const result = join(parent, parts[parts.length - 1]!);
  try {
    const info = lstatSync(result);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Durable file is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}
function ensureJobTree(jobDir: string): void {
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  directory(jobDir);
  syncDirectory(dirname(jobDir));
  for (const part of [
    "assets",
    "assets/.staging",
    "assets/staging",
    "archive",
    "artifacts",
    "run",
  ]) {
    let parent = jobDir;
    for (const component of part.split("/")) {
      const child = join(parent, component);
      if (!existsSync(child)) {
        mkdirSync(child, { mode: 0o700 });
        syncDirectory(parent);
      }
      directory(child);
      parent = child;
    }
  }
}
function hashAndSyncFile(path: string): { sha256: string; size: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("Durable bytes must be a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      size += count;
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (
      size !== before.size ||
      size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Durable bytes changed while hashing");
    }
    fsyncSync(fd);
    return { sha256: hash.digest("hex"), size };
  } finally {
    closeSync(fd);
  }
}
function digestShape(sha256: string, size?: number): void {
  if (
    !/^[a-f0-9]{64}$/.test(sha256) ||
    (size !== undefined && (!Number.isSafeInteger(size) || size < 0))
  ) {
    throw new Error("Invalid durable asset digest or size");
  }
}
function verifyFile(path: string, sha256: string, size?: number): void {
  digestShape(sha256, size);
  const actual = hashAndSyncFile(path);
  if (actual.sha256 !== sha256 || (size !== undefined && actual.size !== size))
    throw new Error("Durable file digest or size mismatch");
}
function assetPath(asset: DurableAsset): string {
  return asset.archivePath === undefined
    ? `assets/${asset.sha256}`
    : `archive/${asset.archivePath}`;
}
function stagedPath(jobDir: string, staged: string): string {
  const path = relative(jobDir, resolve(staged)).split(sep).join("/");
  if (!path.startsWith("assets/.staging/") && !path.startsWith("assets/staging/"))
    throw new Error("Asset staging must be inside the job staging directory");
  return safePath(jobDir, path, false, true);
}
function installAsset(jobDir: string, asset: DurableAsset): string {
  digestShape(asset.sha256, asset.size);
  if (asset.archivePath !== undefined) relativeParts(asset.archivePath);
  const destination = safePath(jobDir, assetPath(asset), true);
  const staged = stagedPath(jobDir, asset.stagedPath);
  if (existsSync(staged)) verifyFile(staged, asset.sha256, asset.size);
  if (existsSync(destination)) {
    verifyFile(destination, asset.sha256, asset.size);
    if (existsSync(staged)) {
      unlinkSync(staged);
      syncDirectory(dirname(staged));
    }
    syncDirectory(dirname(destination));
    return destination;
  }
  // A replay may have lost staging only after the first install; absent final bytes
  // are never converted into an asset registration.
  verifyFile(staged, asset.sha256, asset.size);
  renameSync(staged, destination);
  syncDirectory(dirname(destination));
  syncDirectory(dirname(staged));
  return destination;
}
function installText(jobDir: string, path: string, content: string, sha256: string): void {
  digestShape(sha256);
  const bytes = Buffer.from(content, "utf8");
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new Error("Archive package content digest mismatch");
  const destination = safePath(jobDir, path, true);
  if (existsSync(destination)) {
    const existing = hashAndSyncFile(destination);
    if (existing.sha256 === sha256 && existing.size === bytes.length) {
      syncDirectory(dirname(destination));
      return;
    }
  }
  const temporary = safePath(jobDir, `assets/.staging/package-${randomUUID()}`);
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    verifyFile(temporary, sha256, bytes.length);
    renameSync(temporary, destination);
    syncDirectory(dirname(destination));
    syncDirectory(dirname(temporary));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function fallbackRailState(jobState: JobState): Record<Verb, string> {
  const current: Record<JobState, Verb> = {
    new: "plan",
    planned: "approve",
    approved: "execute",
    executing: "execute",
    interrupted: "execute",
    blocked: "execute",
    needs_attention: "verify",
    verified: "report",
    closed: "close",
    cancelled: "cancel",
  };
  const completed: Record<JobState, Verb[]> = {
    new: ["init"],
    planned: ["init", "doctor", "plan"],
    approved: ["init", "doctor", "plan", "approve"],
    executing: ["init", "doctor", "plan", "approve"],
    interrupted: ["init", "doctor", "plan", "approve"],
    blocked: ["init", "doctor", "plan", "approve"],
    needs_attention: ["init", "doctor", "plan", "approve", "execute"],
    verified: ["init", "doctor", "plan", "approve", "execute", "verify"],
    closed: ["init", "doctor", "plan", "approve", "execute", "verify", "close"],
    cancelled: ["init", "cancel"],
  };
  return Object.fromEntries(
    VERBS.map((verb) => [
      verb,
      completed[jobState].includes(verb)
        ? "done"
        : verb === current[jobState]
          ? jobState === "interrupted"
            ? "checkpoint"
            : jobState === "blocked" || jobState === "needs_attention"
              ? "blocked"
              : "current"
          : "pending",
    ]),
  ) as Record<Verb, string>;
}

class StoreImpl implements Store {
  readonly db: DatabaseSync;
  readonly #jobDir: string;
  readonly #now: () => Date;
  readonly #writable: boolean;
  readonly #version: string;
  #pendingProgress: RowPhase | undefined;
  #lastProgressAt: number | undefined;
  constructor(
    db: DatabaseSync,
    jobDir: string,
    opts: { now: () => Date; migmateVersion: string },
    writable: boolean,
  ) {
    this.db = db;
    this.#jobDir = jobDir;
    this.#now = opts.now;
    this.#version = opts.migmateVersion;
    this.#writable = writable;
  }
  close(): void {
    this.db.close();
  }
  atomic<T>(fn: () => T): T {
    if (!this.#writable) throw new Error("Store was opened read-only");
    return transaction(this.db, fn);
  }
  #snapshot<T>(fn: () => T): T {
    return transaction(this.db, fn, false);
  }
  readJob(): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM job LIMIT 1").get();
    return row === undefined ? null : rowToJob(row);
  }
  writeJob(job: JobRecord): void {
    this.atomic(() => {
      const current = this.readJob();
      if (current?.hostId && job.hostId !== current.hostId)
        throw new Error("Persistent job host identity cannot be changed");
      if (job.schemaVersion !== SCHEMA_VERSION)
        throw new Error("Cannot write an unsupported job schema version");
      this.db
        .prepare(
          `INSERT INTO job (id,type,state,schema_version,migmate_version,label,created_at,plan_revision,verification_revision,last_checkpoint,host_id,execution_completed)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        type=excluded.type,state=excluded.state,schema_version=excluded.schema_version,migmate_version=excluded.migmate_version,
        label=excluded.label,created_at=excluded.created_at,plan_revision=excluded.plan_revision,verification_revision=excluded.verification_revision,
        last_checkpoint=excluded.last_checkpoint,host_id=excluded.host_id,execution_completed=MAX(job.execution_completed,excluded.execution_completed)`,
        )
        .run(
          job.id,
          job.type,
          job.state,
          job.schemaVersion,
          job.migmateVersion,
          job.label,
          job.createdAt,
          job.planRevision,
          job.verificationRevision,
          job.lastCheckpoint,
          job.hostId ?? null,
          job.executionCompleted ? 1 : 0,
        );
    });
  }
  readLease(): LeaseRecord | null {
    const row = this.db.prepare("SELECT * FROM lease WHERE id=1").get();
    return row === undefined ? null : rowToLease(row);
  }
  writeLease(lease: LeaseRecord): void {
    this.atomic(() => {
      const job = this.readJob();
      if (job?.hostId && job.hostId !== lease.hostId)
        throw new Error("Foreign host cannot own this job");
      this.db.prepare("UPDATE job SET host_id=? WHERE host_id IS NULL").run(lease.hostId);
      this.db
        .prepare(
          `INSERT INTO lease (id,owner_uuid,host_id,pid,process_start_time,heartbeat_at,kind,socket_path,worker_group,worker_pid,worker_process_start_time,worker_executable,last_checkpoint,migmate_version)
        VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        owner_uuid=excluded.owner_uuid,host_id=excluded.host_id,pid=excluded.pid,process_start_time=excluded.process_start_time,
        heartbeat_at=excluded.heartbeat_at,kind=excluded.kind,socket_path=excluded.socket_path,worker_group=excluded.worker_group,
        worker_pid=excluded.worker_pid,worker_process_start_time=excluded.worker_process_start_time,worker_executable=excluded.worker_executable,last_checkpoint=excluded.last_checkpoint,migmate_version=excluded.migmate_version`,
        )
        .run(
          lease.ownerUuid,
          lease.hostId,
          lease.pid,
          lease.processStartTime,
          lease.heartbeatAt,
          lease.kind,
          lease.socketPath,
          lease.workerGroup,
          lease.workerPid,
          lease.workerProcessStartTime ?? null,
          lease.workerExecutable ?? null,
          lease.lastCheckpoint,
          lease.migmateVersion,
        );
    });
  }
  clearLease(): void {
    this.db.prepare("DELETE FROM lease WHERE id=1").run();
  }
  touchLease(update: { heartbeatAt: string; lastCheckpoint?: string | null }): void {
    this.db
      .prepare(
        "UPDATE lease SET heartbeat_at=?,last_checkpoint=COALESCE(?,last_checkpoint) WHERE id=1",
      )
      .run(update.heartbeatAt, update.lastCheckpoint ?? null);
  }
  nextPlanRevision(): number {
    return this.atomic(() => {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(rev),0)+1 AS next FROM (SELECT rev FROM plan_revision UNION ALL SELECT rev FROM commit_log UNION ALL SELECT rev FROM archive_plan UNION ALL SELECT value AS rev FROM revision_sequence WHERE name='plan')",
        )
        .get()!;
      const revision = Number(row.next);
      this.db
        .prepare(
          "INSERT INTO revision_sequence (name,value) VALUES ('plan',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        )
        .run(revision);
      return revision;
    });
  }
  nextVerificationRun(): number {
    return this.atomic(() => {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(run),0)+1 AS next FROM (SELECT run FROM verification_run UNION ALL SELECT rev AS run FROM verification_revision UNION ALL SELECT run FROM verification_history UNION ALL SELECT verification_run AS run FROM commit_log UNION ALL SELECT value AS run FROM revision_sequence WHERE name='verification')",
        )
        .get()!;
      const run = Number(row.next);
      this.db
        .prepare(
          "INSERT INTO revision_sequence (name,value) VALUES ('verification',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        )
        .run(run);
      return run;
    });
  }
  readPlanRevision(revision: number): PlanRevisionRecord | null {
    return this.#snapshot(() => {
      const row = this.db.prepare("SELECT * FROM plan_revision WHERE rev=?").get(revision);
      if (row === undefined) return null;
      const payload =
        typeof row.payload === "string"
          ? (JSON.parse(row.payload) as PlanRevisionRecord)
          : undefined;
      const inputs = Object.fromEntries(
        this.db
          .prepare("SELECT key,value FROM plan_input WHERE rev=? ORDER BY key")
          .all(revision)
          .map((entry) => [String(entry.key), String(entry.value)]),
      );
      const count = this.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM item WHERE rev=? AND phase='plan') + (SELECT COUNT(*) FROM conversation WHERE rev=? AND phase='plan') AS count",
        )
        .get(revision, revision)!;
      return {
        ...payload,
        revision,
        planDigest: String(row.plan_digest),
        inputsDigest: String(row.inputs_digest),
        createdAt: String(row.created_at),
        sourceInventoryAt: String(row.source_inventory_at),
        rowCount: Number(count.count),
        inputs,
        evidence: parseEvidence(row.evidence),
        disclosures: payload?.disclosures ?? [],
        sections: payload?.sections ?? [],
      };
    });
  }
  writePlanRevision(record: PlanRevisionRecord): void {
    this.atomic(() => {
      this.db
        .prepare(
          "INSERT INTO plan_revision (rev,plan_digest,inputs_digest,created_at,source_inventory_at,evidence,payload) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          record.revision,
          record.planDigest,
          record.inputsDigest,
          record.createdAt,
          record.sourceInventoryAt,
          canonicalJson(record.evidence),
          canonicalJson(record),
        );
      const insert = this.db.prepare("INSERT INTO plan_input (rev,key,value) VALUES (?,?,?)");
      for (const [key, value] of Object.entries(record.inputs))
        insert.run(record.revision, key, value);
      this.db
        .prepare("UPDATE job SET plan_revision=?,verification_revision=NULL")
        .run(record.revision);
      this.db.prepare("DELETE FROM projection_progress").run();
      this.db.prepare("DELETE FROM projection_verb_state WHERE verb IN ('approve','execute','verify','report','close','cancel')").run();
    });
  }
  readApproval(revision: number): ApprovalRecord | null {
    const row = this.db
      .prepare("SELECT * FROM approval WHERE rev=? ORDER BY id DESC LIMIT 1")
      .get(revision);
    if (row === undefined) return null;
    if (typeof row.payload === "string") return JSON.parse(row.payload) as ApprovalRecord;
    const approval = {
      revision: Number(row.rev),
      planDigest: String(row.plan_digest),
      approver: String(row.approver),
      mode: row.mode as ApprovalRecord["mode"],
      at: String(row.at),
    };
    return { ...approval, approvalDigest: digestJson(approval) };
  }
  writeApproval(record: ApprovalRecord): void {
    this.db
      .prepare(
        "INSERT INTO approval (rev,plan_digest,approver,mode,at,payload) VALUES (?,?,?,?,?,?)",
      )
      .run(
        record.revision,
        record.planDigest,
        record.approver,
        record.mode,
        record.at,
        canonicalJson(record),
      );
  }
  #snapshotVerification(planRev: number, run: number): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO verification_history (run,plan_rev,category,row_key,payload) VALUES (?,?,?,?,?)",
    );
    for (const table of ["item", "conversation", "finding"] as const) {
      for (const row of this.db
        .prepare(`SELECT * FROM ${table} WHERE rev=? AND phase='verify' ORDER BY id`)
        .all(planRev)) {
        insert.run(run, planRev, table, String(row.id), canonicalJson(row));
      }
    }
  }
  beginVerification(planRev: number, verificationRun: number): void {
    this.atomic(() => {
      if (!Number.isSafeInteger(verificationRun) || verificationRun < 1)
        throw new Error("Invalid verification run");
      const job = this.readJob();
      if (job?.planRevision !== planRev)
        throw new Error("Verification must use the current plan revision");
      const maximum = this.db
        .prepare(
          "SELECT MAX(run) AS run FROM (SELECT run FROM verification_run UNION ALL SELECT rev AS run FROM verification_revision)",
        )
        .get();
      if (verificationRun <= Number(maximum?.run ?? 0))
        throw new Error("Verification runs must increase");
      const previous = this.db
        .prepare("SELECT run FROM verification_run WHERE plan_rev=?")
        .get(planRev);
      if (previous !== undefined) this.#snapshotVerification(planRev, Number(previous.run));
      for (const table of ["item", "conversation", "finding", "projection_facet"])
        this.db.prepare(`DELETE FROM ${table} WHERE rev=? AND phase='verify'`).run(planRev);
      this.db.prepare("DELETE FROM projection_verb_state WHERE verb IN ('verify','report','close')").run();
      this.db.prepare("DELETE FROM projection_progress").run();
      this.db
        .prepare(
          "UPDATE job SET verification_revision=NULL,state=CASE WHEN state='verified' THEN 'needs_attention' ELSE state END",
        )
        .run();
      this.db
        .prepare(
          "INSERT INTO verification_run (plan_rev,run,started_at) VALUES (?,?,?) ON CONFLICT(plan_rev) DO UPDATE SET run=excluded.run,started_at=excluded.started_at",
        )
        .run(planRev, verificationRun, this.#now().toISOString());
    });
  }
  readVerificationRevision(revision: number): VerificationRevisionRecord | null {
    return this.#snapshot(() => {
      const row = this.db.prepare("SELECT * FROM verification_revision WHERE rev=?").get(revision);
      if (row === undefined) return null;
      const payload =
        typeof row.payload === "string"
          ? (JSON.parse(row.payload) as VerificationRevisionRecord)
          : undefined;
      const findings = JSON.parse(String(row.findings)) as FacetCount[];
      const acceptedCodes = this.readAcceptances(String(row.verification_digest)).map(
        (entry) => entry.code,
      );
      const accepted = new Set(acceptedCodes);
      return {
        ...payload,
        revision: Number(row.rev),
        planRev: Number(row.plan_rev),
        verificationDigest: String(row.verification_digest),
        clean: findings.every(
          (finding) => finding.kind === "policy_outcome" || accepted.has(finding.code),
        ),
        findings,
        acceptedCodes,
        at: String(row.at),
      };
    });
  }
  writeVerificationRevision(record: VerificationRevisionRecord): void {
    this.atomic(() => {
      const run = this.db
        .prepare("SELECT run FROM verification_run WHERE plan_rev=?")
        .get(record.planRev);
      if (run === undefined || Number(run.run) !== record.revision)
        throw new Error("Verification was not begun for this run");
      if (
        this.db
          .prepare("SELECT 1 FROM verification_revision WHERE verification_digest=?")
          .get(record.verificationDigest)
      )
        throw new Error("Verification digest must be fresh");
      this.#snapshotVerification(record.planRev, record.revision);
      const summary = facets(
        this.db
          .prepare(
            "SELECT code,kind,COUNT(*) AS count FROM finding WHERE rev=? AND phase='verify' GROUP BY code,kind ORDER BY code",
          )
          .all(record.planRev),
      );
      this.db
        .prepare(
          "INSERT INTO verification_revision (rev,plan_rev,verification_digest,clean,findings,payload,at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          record.revision,
          record.planRev,
          record.verificationDigest,
          record.clean ? 1 : 0,
          canonicalJson(summary),
          canonicalJson(record),
          record.at,
        );
      this.db.prepare("UPDATE job SET verification_revision=?").run(record.revision);
    });
  }
  readAcceptances(verificationDigest: string): AcceptanceRecord[] {
    return this.db
      .prepare("SELECT * FROM acceptance WHERE verification_digest=? ORDER BY code")
      .all(verificationDigest)
      .map((row) => ({
        verificationDigest: String(row.verification_digest),
        code: String(row.code),
        approver: String(row.approver),
        note: nullableString(row.note),
        at: String(row.at),
      }));
  }
  writeAcceptance(record: AcceptanceRecord): void {
    this.writeAcceptances([record]);
  }
  writeAcceptances(records: AcceptanceRecord[]): void {
    this.atomic(() => {
      const job = this.readJob();
      const verification =
        job?.verificationRevision == null
          ? null
          : this.readVerificationRevision(job.verificationRevision);
      for (const record of records) {
        if (
          verification === null ||
          record.verificationDigest !== verification.verificationDigest ||
          !record.approver.trim() ||
          !verification.findings.some(
            (finding) => finding.code === record.code && finding.kind !== "policy_outcome",
          )
        ) {
          throw new Error("Acceptance does not match a current verification finding");
        }
      }
      const insert = this.db.prepare(
        "INSERT INTO acceptance (verification_digest,code,approver,note,at) VALUES (?,?,?,?,?) ON CONFLICT(verification_digest,code) DO NOTHING",
      );
      for (const record of records)
        insert.run(record.verificationDigest, record.code, record.approver, record.note, record.at);
    });
  }
  readFindings(revision: number, phase?: RowPhase): FindingRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM finding WHERE rev=?${phase === undefined ? "" : " AND phase=?"} ORDER BY id`,
      )
      .all(...(phase === undefined ? [revision] : [revision, phase]))
      .map(rowToFinding);
  }
  currentPhase(revision: number): RowPhase {
    const active = this.db.prepare(
      "SELECT verb FROM projection_verb_state WHERE state='current' AND verb IN ('plan','execute','verify') LIMIT 1",
    ).get()?.verb;
    if (active === "execute" || active === "verify") return active;
    if (active === "plan" && this.readJob()?.planningRevision === revision) return "plan";
    const phase = this.db.prepare(
      "SELECT phase FROM commit_log WHERE rev=? ORDER BY rowid DESC LIMIT 1",
    ).get(revision)?.phase;
    return phase === "execute" || phase === "verify" ? phase : "plan";
  }
  #currentFindingIds(revision: number, phase: RowPhase): { sql: string; params: (number | string)[] } {
    const archive = this.readJob()?.type === "teams_archive";
    const phases: RowPhase[] = archive
      ? phase === "plan" ? ["plan"] : phase === "execute" ? ["plan", "execute"] : ["plan", "execute", "verify"]
      : [phase];
    return {
      sql: `SELECT MAX(id) FROM finding WHERE rev=? AND phase IN (${phases.map(() => "?").join(",")}) GROUP BY code,subject_kind,subject_id`,
      params: [revision, ...phases],
    };
  }
  readCurrentFindings(revision: number, phase: RowPhase): FindingRecord[] {
    const selection = this.#currentFindingIds(revision, phase);
    return this.db.prepare(`SELECT * FROM finding WHERE id IN (${selection.sql}) ORDER BY id`)
      .all(...selection.params).map(rowToFinding);
  }
  currentFindingCounts(revision: number, phase: RowPhase): FacetCount[] {
    const selection = this.#currentFindingIds(revision, phase);
    return facets(this.db.prepare(
      `SELECT code,kind,COUNT(*) AS count FROM finding WHERE id IN (${selection.sql}) AND kind<>'policy_outcome' GROUP BY code,kind ORDER BY code`,
    ).all(...selection.params));
  }
  writeFinding(record: FindingRecord): void {
    this.db
      .prepare(
        "INSERT INTO finding (rev,phase,code,kind,subject_kind,subject_id,evidence,at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        record.rev,
        record.phase,
        record.code,
        record.kind,
        record.subjectKind,
        record.subjectId,
        canonicalJson(record.evidence),
        record.at,
      );
  }
  readCheckResults(verb?: Verb): CheckResultRecord[] {
    return this.db
      .prepare(`SELECT * FROM check_result${verb === undefined ? "" : " WHERE verb=?"} ORDER BY id`)
      .all(...(verb === undefined ? [] : [verb]))
      .map((row) => ({
        verb: row.verb as Verb,
        id: String(row.check_id),
        title: String(row.title),
        status: row.status as CheckResult["status"],
        ...(row.code === null ? {} : { code: String(row.code) }),
        evidence: parseEvidence(row.evidence) as Record<string, unknown>,
        at: String(row.at),
      }));
  }
  writeCheckResult(record: CheckResultRecord): void {
    this.db
      .prepare(
        "INSERT INTO check_result (verb,check_id,title,status,code,evidence,at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        record.verb,
        record.id,
        record.title,
        record.status,
        record.code ?? null,
        canonicalJson(record.evidence),
        record.at,
      );
  }
  readAllRows(revision: number, phase?: RowPhase): CommitRow[] {
    return this.#snapshot(() => {
      const result: CommitRow[] = [];
      for (const table of ["item", "conversation"] as const) {
        const rows = this.db
          .prepare(
            `SELECT * FROM ${table} WHERE rev=?${phase === undefined ? "" : " AND phase=?"} ORDER BY phase,id`,
          )
          .all(...(phase === undefined ? [revision] : [revision, phase]));
        for (const row of rows) result.push(rowToCommit(table, row));
      }
      return result;
    });
  }
  readResume(revision: number): ResumeRecord {
    return this.#snapshot(() => {
      const rows = this.readAllRows(revision).map((row) => {
        if (row.jobType !== "file_migration" || row.fileState === undefined) return row;
        const { fileState: _state, ...evidence } = row;
        return evidence;
      });
      for (const entry of this.db
        .prepare(
          "SELECT payload FROM file_authority ORDER BY mapping_id,source_drive_id,source_item_id",
        )
        .all()) {
        const authority = JSON.parse(String(entry.payload)) as FileCommitRow;
        // Keep the actual historical revision and full authority, rather than
        // manufacturing a new row or letting a plan row erase the last intent.
        rows.push(authority);
      }
      const watermarks = Object.fromEntries(
        this.db
          .prepare("SELECT unit_key,value FROM watermark WHERE rev=? ORDER BY unit_key")
          .all(revision)
          .map((row) => [String(row.unit_key), String(row.value)]),
      );
      const committedUnits = this.db
        .prepare(
          "SELECT DISTINCT unit_key FROM commit_log WHERE rev=? AND (phase <> 'verify' OR verification_run=COALESCE((SELECT run FROM verification_run WHERE plan_rev=?),0)) ORDER BY unit_key",
        )
        .all(revision, revision)
        .map((row) => String(row.unit_key));
      const plan = this.db
        .prepare("SELECT payload,manifest_digest FROM archive_plan WHERE rev=?")
        .get(revision);
      const result: ResumeRecord = { rows, watermarks, committedUnits };
      if (plan !== undefined) {
        result.archivePlan = JSON.parse(String(plan.payload)) as ArchivePlan;
        result.archiveRecords = this.db
          .prepare(
            "SELECT r.payload FROM archive_record r JOIN archive_revision_record v ON v.key=r.key WHERE v.rev=? ORDER BY r.key",
          )
          .all(revision)
          .map((row) => JSON.parse(String(row.payload)) as ArchiveRecord);
        result.archiveEvidence = this.db
          .prepare("SELECT payload FROM archive_evidence WHERE rev=? ORDER BY sequence")
          .all(revision)
          .map((row) => JSON.parse(String(row.payload)) as ArchiveCollectionEvidence);
        if (plan.manifest_digest !== null)
          result.archiveManifestDigest = String(plan.manifest_digest);
      }
      return result;
    });
  }
  writeArtifactSet(value: ArtifactSet): void {
    for (const artifact of value.artifacts) {
      const path = relative(this.#jobDir, resolve(this.#jobDir, artifact.path))
        .split(sep)
        .join("/");
      const file = safePath(this.#jobDir, path);
      verifyFile(file, artifact.digest);
      syncDirectory(dirname(file));
    }
    this.atomic(() => {
      this.db
        .prepare("INSERT INTO artifact_set (report_digest,payload,at) VALUES (?,?,?)")
        .run(value.reportDigest, canonicalJson(value), this.#now().toISOString());
    });
  }
  readArtifactSet(): ArtifactSet {
    const row = this.db
      .prepare("SELECT payload FROM artifact_set ORDER BY sequence DESC LIMIT 1")
      .get();
    return row === undefined
      ? { reportDigest: null, artifacts: [] }
      : (JSON.parse(String(row.payload)) as ArtifactSet);
  }
  #upsertRow(row: CommitRow, unit: CommitUnit, run: number): void {
    const table = row.jobType === "file_migration" ? "item" : "conversation";
    const prior = this.db
      .prepare(`SELECT code,kind FROM ${table} WHERE rev=? AND phase=? AND id=?`)
      .get(row.rev, row.phase, row.id);
    if (row.jobType === "file_migration") {
      this.db
        .prepare(
          `INSERT INTO item (id,rev,phase,code,kind,accepted,mapping_id,source_drive_id,source_item_id,relative_path,item_type,size,source_etag,source_fingerprint,dest_drive_id,dest_file_id,dest_fingerprint,provenance_state,payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(rev,phase,id) DO UPDATE SET
        code=excluded.code,kind=excluded.kind,accepted=excluded.accepted,mapping_id=excluded.mapping_id,source_drive_id=excluded.source_drive_id,source_item_id=excluded.source_item_id,
        relative_path=excluded.relative_path,item_type=excluded.item_type,size=excluded.size,source_etag=excluded.source_etag,source_fingerprint=excluded.source_fingerprint,
        dest_drive_id=excluded.dest_drive_id,dest_file_id=excluded.dest_file_id,dest_fingerprint=excluded.dest_fingerprint,provenance_state=excluded.provenance_state,payload=excluded.payload`,
        )
        .run(
          row.id,
          row.rev,
          row.phase,
          row.code,
          row.kind,
          0,
          row.mappingId,
          row.sourceDriveId,
          row.sourceItemId,
          row.relativePath,
          row.itemType,
          row.size,
          row.sourceEtag ?? null,
          row.sourceFingerprint ?? null,
          row.destinationDriveId ?? null,
          row.destinationFileId ?? null,
          row.destinationFingerprint ?? null,
          row.provenanceState ?? "none",
          canonicalJson(row),
        );
      this.db
        .prepare(
          "INSERT INTO file_state_history (rev,phase,verification_run,unit_key,payload) VALUES (?,?,?,?,?)",
        )
        .run(row.rev, row.phase, run, unit.unitKey, canonicalJson(row));
      if (row.fileState !== undefined) {
        const state = row.fileState;
        const rank = state.status === "verified" ? 2 : state.status === "unverified" ? 1 : 0;
        this.db
          .prepare(
            `INSERT INTO file_authority (mapping_id,source_drive_id,source_item_id,generation,state_rank,payload) VALUES (?,?,?,?,?,?)
          ON CONFLICT(mapping_id,source_drive_id,source_item_id) DO UPDATE SET generation=excluded.generation,state_rank=excluded.state_rank,payload=excluded.payload
          WHERE excluded.generation > file_authority.generation OR (excluded.generation=file_authority.generation AND excluded.state_rank >= file_authority.state_rank)`,
          )
          .run(
            row.mappingId,
            row.sourceDriveId,
            row.sourceItemId,
            state.generation,
            rank,
            canonicalJson(row),
          );
      }
    } else {
      this.db
        .prepare(
          `INSERT INTO conversation (id,rev,phase,code,kind,accepted,scope_entry_id,conversation_id,title,records,assets,watermark,payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(rev,phase,id) DO UPDATE SET
        code=excluded.code,kind=excluded.kind,accepted=excluded.accepted,scope_entry_id=excluded.scope_entry_id,conversation_id=excluded.conversation_id,
        title=excluded.title,records=excluded.records,assets=excluded.assets,watermark=excluded.watermark,payload=excluded.payload`,
        )
        .run(
          row.id,
          row.rev,
          row.phase,
          row.code,
          row.kind,
          0,
          row.scopeEntryId,
          row.conversationId,
          row.title ?? null,
          row.records,
          row.assets,
          row.watermark ?? null,
          canonicalJson(row),
        );
    }
    if (prior === undefined || prior.code !== row.code || prior.kind !== row.kind) {
      if (prior !== undefined) {
        this.db
          .prepare("UPDATE projection_facet SET count=count-1 WHERE rev=? AND phase=? AND code=?")
          .run(row.rev, row.phase, String(prior.code));
        this.db
          .prepare("DELETE FROM projection_facet WHERE rev=? AND phase=? AND code=? AND count=0")
          .run(row.rev, row.phase, String(prior.code));
      }
      this.db
        .prepare(
          "INSERT INTO projection_facet (phase,rev,code,kind,count) VALUES (?,?,?,?,1) ON CONFLICT(phase,rev,code) DO UPDATE SET count=count+1,kind=excluded.kind",
        )
        .run(row.phase, row.rev, row.code, row.kind);
    }
  }
  #archiveProgress(revision: number): void {
    const stored = this.db.prepare("SELECT payload FROM archive_plan WHERE rev=?").get(revision);
    if (stored === undefined) return;
    const plan = JSON.parse(String(stored.payload)) as ArchivePlan;
    const watermarks = new Map(
      this.db
        .prepare("SELECT unit_key,value FROM watermark WHERE rev=?")
        .all(revision)
        .map((row) => [String(row.unit_key), String(row.value)]),
    );
    const scopeComplete = new Map(
      plan.scopes.map((scope) => {
        const routes = [
          "messages",
          ...(plan.config.retainedHistory &&
          !(
            scope.kind === "channel" &&
            plan.conversations.find((conversation) => conversation.id === scope.conversationIds[0])
              ?.membershipType === "private"
          )
            ? ["retained"]
            : []),
          ...(plan.config.transcripts && scope.kind === "user-chats" ? ["transcripts"] : []),
        ];
        return [
          scope.id,
          routes.every((route) => watermarks.get(`archive:${scope.id}:${route}`) === "complete"),
        ] as const;
      }),
    );
    const conversations = plan.conversations.filter(
      (conversation) =>
        scopeComplete.get(conversation.scopeEntryId) === true &&
        conversation.participantScopeIds.every((scope) => scopeComplete.get(scope) === true),
    ).length;
    const count = Number(
      this.db
        .prepare("SELECT COUNT(*) AS count FROM archive_revision_record WHERE rev=?")
        .get(revision)!.count,
    );
    const assets = this.db
      .prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM revision_asset WHERE rev=? AND path LIKE 'archive/%'",
      )
      .get(revision)!;
    const total = [...scopeComplete.values()].every(Boolean) ? count : null;
    this.db
      .prepare(
        `INSERT INTO projection_archive (rev,conversations,total_conversations,records,total_records,assets,bytes) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(rev) DO UPDATE SET conversations=excluded.conversations,total_conversations=excluded.total_conversations,records=excluded.records,total_records=excluded.total_records,assets=excluded.assets,bytes=excluded.bytes`,
      )
      .run(
        revision,
        conversations,
        plan.conversations.length,
        count,
        total,
        Number(assets.count),
        Number(assets.bytes),
      );
  }
  commit(unit: CommitUnit): CommitReceipt {
    if (!this.#writable) throw new Error("Store was opened read-only");
    const job = this.readJob();
    if (job === null) throw new Error("Job row missing");
    if (
      unit.rows.some(
        (row) => row.rev !== unit.rev || row.phase !== unit.phase || row.jobType !== job.type,
      ) ||
      unit.findings.some((finding) => finding.rev !== unit.rev || finding.phase !== unit.phase)
    )
      throw new Error(
        "Commit rows and findings must match their unit revision, phase and job type",
      );
    const activeRun = this.db
      .prepare("SELECT run FROM verification_run WHERE plan_rev=?")
      .get(unit.rev);
    const run = unit.phase === "verify" ? (unit.verificationRun ?? Number(activeRun?.run ?? 0)) : 0;
    if (unit.phase === "verify" && (run < 1 || Number(activeRun?.run) !== run))
      throw new Error("Verification commit requires the active verification run");
    const authoritativeRecords = new Map<string, ArchiveRecord>();
    const referencedAssets = new Set<string>();
    for (const record of unit.archiveRecords ?? []) {
      const key = createHash("sha256")
        .update(`${record.conversationId}:${canonicalJson(record.raw)}`)
        .digest("hex");
      if (record.key !== key)
        throw new Error("Archive record key does not bind its semantic content");
      const prior = this.db
        .prepare("SELECT payload FROM archive_record WHERE key=?")
        .get(record.key);
      const authoritative =
        prior === undefined ? record : (JSON.parse(String(prior.payload)) as ArchiveRecord);
      if (
        authoritative.conversationId !== record.conversationId ||
        canonicalJson(authoritative.raw) !== canonicalJson(record.raw)
      )
        throw new Error("Archive record semantic key collision");
      authoritativeRecords.set(record.key, authoritative);
      for (const asset of authoritative.assets)
        referencedAssets.add(canonicalJson([asset.path, asset.sha256, asset.size]));
    }
    const assets = (unit.assets ?? []).filter(
      (asset) =>
        asset.archivePath === undefined ||
        unit.archiveRecords === undefined ||
        referencedAssets.has(canonicalJson([asset.archivePath, asset.sha256, asset.size])),
    );
    const files = unit.archiveFiles ?? [];
    if ((assets.length || files.length) && (transactionDepth.get(this.db) ?? 0) > 0)
      throw new Error("Asset installation must precede the database transaction");
    const committed = this.db
      .prepare(
        "SELECT resources FROM commit_log WHERE rev=? AND phase=? AND verification_run=? AND unit_key=?",
      )
      .get(unit.rev, unit.phase, run, unit.unitKey);
    if (committed !== undefined) {
      const resources = JSON.parse(String(committed.resources)) as StoredResource[];
      for (const resource of resources) {
        const asset =
          resource.kind === "asset"
            ? assets.find(
                (candidate) =>
                  assetPath(candidate) === resource.path &&
                  candidate.sha256 === resource.sha256 &&
                  candidate.size === resource.size,
              )
            : undefined;
        const file =
          resource.kind === "package"
            ? files.find(
                (candidate) =>
                  `archive/${candidate.path}` === resource.path &&
                  candidate.sha256 === resource.sha256,
              )
            : undefined;
        if (asset !== undefined) installAsset(this.#jobDir, asset);
        else if (file !== undefined)
          installText(this.#jobDir, resource.path, file.content, file.sha256);
        verifyFile(safePath(this.#jobDir, resource.path), resource.sha256, resource.size);
      }
      // Replayed input cannot install unrelated bytes or change a registration.
      return { applied: false };
    }
    const resources: StoredResource[] = [
      ...assets.map((asset) => ({
        kind: "asset" as const,
        path: assetPath(asset),
        sha256: asset.sha256,
        size: asset.size,
      })),
      ...files.map((file) => ({
        kind: "package" as const,
        path: `archive/${file.path}`,
        sha256: file.sha256,
        size: Buffer.byteLength(file.content, "utf8"),
      })),
    ];
    const expectedPaths = new Map<string, StoredResource>();
    for (const resource of resources) {
      const prior = expectedPaths.get(resource.path);
      if (
        prior !== undefined &&
        (prior.kind !== resource.kind ||
          prior.sha256 !== resource.sha256 ||
          prior.size !== resource.size)
      )
        throw new Error("A commit contains conflicting durable file paths");
      expectedPaths.set(resource.path, resource);
    }
    // All paths, supplied bytes and immutable associations are checked before any
    // final file is changed. Staging remains disposable; registrations do not.
    for (const asset of assets) {
      digestShape(asset.sha256, asset.size);
      const path = assetPath(asset);
      safePath(this.#jobDir, path, true);
      const prior = this.db.prepare("SELECT path,size,sha256 FROM asset WHERE id=?").get(asset.id);
      if (
        prior !== undefined &&
        (prior.path !== path || Number(prior.size) !== asset.size || prior.sha256 !== asset.sha256)
      )
        throw new Error("An immutable asset identity changed");
      const staged = stagedPath(this.#jobDir, asset.stagedPath);
      if (existsSync(staged)) verifyFile(staged, asset.sha256, asset.size);
      else verifyFile(safePath(this.#jobDir, path), asset.sha256, asset.size);
    }
    for (const file of files) {
      relativeParts(file.path);
      digestShape(file.sha256);
      if (createHash("sha256").update(file.content, "utf8").digest("hex") !== file.sha256)
        throw new Error("Archive package content digest mismatch");
      const prior = this.db
        .prepare("SELECT sha256 FROM archive_file WHERE path=? LIMIT 1")
        .get(file.path);
      if (prior !== undefined && prior.sha256 !== file.sha256)
        throw new Error("A committed archive package file cannot be overwritten");
      safePath(this.#jobDir, `archive/${file.path}`, true);
    }
    for (const asset of assets) installAsset(this.#jobDir, asset);
    for (const file of files)
      installText(this.#jobDir, `archive/${file.path}`, file.content, file.sha256);
    for (const record of authoritativeRecords.values()) {
      for (const asset of record.assets) {
        const path = `archive/${asset.path}`;
        const incoming = assets.find(
          (candidate) =>
            assetPath(candidate) === path &&
            candidate.sha256 === asset.sha256 &&
            candidate.size === asset.size,
        );
        const registered = this.db
          .prepare("SELECT sha256,size FROM revision_asset WHERE rev=? AND path=?")
          .get(unit.rev, path);
        if (
          incoming === undefined &&
          (registered === undefined ||
            registered.sha256 !== asset.sha256 ||
            Number(registered.size) !== asset.size)
        )
          throw new Error("Archive record references an unregistered asset");
        verifyFile(safePath(this.#jobDir, path), asset.sha256, asset.size);
      }
    }
    if (unit.archiveManifestDigest !== undefined) {
      digestShape(unit.archiveManifestDigest);
      const manifest = files.find((file) => file.path === "manifest.json");
      const prior = this.db
        .prepare("SELECT sha256 FROM archive_file WHERE rev=? AND path='manifest.json'")
        .get(unit.rev);
      if ((manifest?.sha256 ?? prior?.sha256) !== unit.archiveManifestDigest)
        throw new Error("Archive manifest digest has no matching package file");
      verifyFile(safePath(this.#jobDir, "archive/manifest.json"), unit.archiveManifestDigest);
    }
    const receipt = this.atomic(() => {
      const at = this.#now().toISOString();
      const gate = this.db
        .prepare(
          "INSERT OR IGNORE INTO commit_log (rev,phase,unit_key,verification_run,migmate_version,checkpoint,at,resources) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          unit.rev,
          unit.phase,
          unit.unitKey,
          run,
          this.#version,
          unit.checkpoint,
          at,
          canonicalJson(resources),
        );
      if (gate.changes === 0) return { applied: false };
      if (unit.archivePlan !== undefined) {
        const existing = this.db
          .prepare("SELECT payload FROM archive_plan WHERE rev=?")
          .get(unit.rev);
        const payload = canonicalJson(unit.archivePlan);
        if (existing !== undefined && existing.payload !== payload)
          throw new Error("Archive plan revision is immutable");
        this.db
          .prepare("INSERT OR IGNORE INTO archive_plan (rev,payload) VALUES (?,?)")
          .run(unit.rev, payload);
      }
      if (
        (unit.archiveRecords !== undefined ||
          unit.archiveEvidence !== undefined ||
          files.length ||
          unit.archiveManifestDigest !== undefined) &&
        !this.db.prepare("SELECT 1 FROM archive_plan WHERE rev=?").get(unit.rev)
      )
        throw new Error("Archive commit has no durable plan");
      for (const row of unit.rows) this.#upsertRow(row, unit, run);
      for (const finding of unit.findings) this.writeFinding(finding);
      for (const asset of assets) {
        const path = assetPath(asset);
        const existing = this.db
          .prepare("SELECT sha256,size FROM revision_asset WHERE rev=? AND path=?")
          .get(unit.rev, path);
        if (
          existing !== undefined &&
          (existing.sha256 !== asset.sha256 || Number(existing.size) !== asset.size)
        )
          throw new Error("An archive asset path changed");
        this.db
          .prepare(
            "INSERT OR IGNORE INTO asset (id,conversation_id,source_kind,path,size,sha256,retrieved_at) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            asset.id,
            asset.conversationId,
            asset.sourceKind,
            path,
            asset.size,
            asset.sha256,
            asset.retrievedAt,
          );
        this.db
          .prepare("INSERT OR IGNORE INTO revision_asset (rev,path,size,sha256) VALUES (?,?,?,?)")
          .run(unit.rev, path, asset.size, asset.sha256);
      }
      for (const record of unit.archiveRecords ?? []) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO archive_record (key,conversation_id,payload) VALUES (?,?,?)",
          )
          .run(record.key, record.conversationId, canonicalJson(record));
        this.db
          .prepare("INSERT OR IGNORE INTO archive_revision_record (rev,key) VALUES (?,?)")
          .run(unit.rev, record.key);
      }
      if (unit.archiveEvidence !== undefined) {
        for (const key of unit.archiveEvidence.recordKeys) {
          if (
            !this.db
              .prepare("SELECT 1 FROM archive_revision_record WHERE rev=? AND key=?")
              .get(unit.rev, key)
          )
            throw new Error("Archive evidence references a record outside its committed revision");
        }
        this.db
          .prepare("INSERT INTO archive_evidence (rev,phase,unit_key,payload) VALUES (?,?,?,?)")
          .run(unit.rev, unit.phase, unit.unitKey, canonicalJson(unit.archiveEvidence));
      }
      for (const file of files)
        this.db
          .prepare("INSERT OR IGNORE INTO archive_file (rev,path,size,sha256) VALUES (?,?,?,?)")
          .run(unit.rev, file.path, Buffer.byteLength(file.content, "utf8"), file.sha256);
      if (unit.archiveManifestDigest !== undefined)
        this.db
          .prepare("UPDATE archive_plan SET manifest_digest=? WHERE rev=?")
          .run(unit.archiveManifestDigest, unit.rev);
      if (unit.watermark !== undefined)
        this.db
          .prepare(
            "INSERT INTO watermark (rev,unit_key,value,updated_at) VALUES (?,?,?,?) ON CONFLICT(rev,unit_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
          )
          .run(unit.rev, unit.watermark.unitKey, unit.watermark.value, at);
      this.db
        .prepare("UPDATE projection_verb_state SET state='pending' WHERE state='current' AND verb<>?")
        .run(unit.phase);
      this.db
        .prepare(
          "INSERT INTO projection_verb_state (verb,state,checkpoint,updated_at) VALUES (?,'current',?,?) ON CONFLICT(verb) DO UPDATE SET state=excluded.state,checkpoint=excluded.checkpoint,updated_at=excluded.updated_at",
        )
        .run(unit.phase, unit.checkpoint, at);
      if (unit.progress !== undefined)
        this.db
          .prepare(
            "INSERT INTO projection_progress (unit,done,total,updated_at) VALUES (?,?,?,?) ON CONFLICT(unit) DO UPDATE SET done=excluded.done,total=excluded.total,updated_at=excluded.updated_at",
          )
          .run(unit.progress.unit, unit.progress.done, unit.progress.total, at);
      this.#archiveProgress(unit.rev);
      this.db
        .prepare("UPDATE job SET last_checkpoint=?,migmate_version=?")
        .run(unit.checkpoint, this.#version);
      this.db.prepare("UPDATE lease SET last_checkpoint=? WHERE id=1").run(unit.checkpoint);
      this.appendEvent({
        verb: unit.phase,
        phase: unit.phase,
        kind: "unit_committed",
        payload: {
          unitKey: unit.unitKey,
          checkpoint: unit.checkpoint,
          rev: unit.rev,
          phase: unit.phase,
          verificationRun: run,
          rows: unit.rows.length,
          findings: unit.findings.length,
          assets: assets.length,
          watermark: unit.watermark ?? null,
          progress: unit.progress ?? null,
        },
      });
      return { applied: true };
    });
    if (receipt.applied) this.#pendingProgress = unit.phase;
    return receipt;
  }
  rows(query: RowQuery): RowPage {
    return this.#snapshot(() => {
      const job = this.readJob();
      if (job === null) throw new Error("Job row missing");
      const revision = query.revision ?? job.planRevision;
      if (revision === null) return { facets: [], rows: [], nextCursor: null, totalRows: 0 };
      const table = job.type === "file_migration" ? "item" : "conversation";
      const filters = ["rev=?", "phase=?"];
      const params: Array<string | number> = [revision, query.phase];
      if (query.codes?.length) {
        filters.push(`code IN (${query.codes.map(() => "?").join(",")})`);
        params.push(...query.codes);
      }
      if (query.search) {
        const columns =
          table === "item"
            ? ["id", "relative_path", "source_item_id", "mapping_id", "code", "kind"]
            : ["id", "conversation_id", "scope_entry_id", "title", "code", "kind"];
        const search = `%${query.search.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        filters.push(
          `(${columns.map((column) => `lower(${column}) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
        );
        params.push(...columns.map(() => search));
      }
      const where = `WHERE ${filters.join(" AND ")}`;
      const counts =
        query.search || query.codes?.length
          ? facets(
              this.db
                .prepare(
                  `SELECT code,kind,COUNT(*) AS count FROM ${table} ${where} GROUP BY code,kind ORDER BY code`,
                )
                .all(...params),
            )
          : facets(
              this.db
                .prepare(
                  "SELECT code,kind,count FROM projection_facet WHERE rev=? AND phase=? ORDER BY code",
                )
                .all(revision, query.phase),
            );
      const totalRows = counts.reduce((sum, facet) => sum + facet.count, 0);
      const sort = query.sort ?? "natural";
      // Every ordering term is present in the continuation predicate. In
      // particular, tied sizes and NULL sizes cannot skip another item's path.
      const order =
        table === "item"
          ? sort === "size"
            ? ["(size IS NULL)", "COALESCE(size,0)", "relative_path", "id"]
            : ["relative_path", "id"]
          : sort === "size"
            ? ["records", "assets", "conversation_id", "id"]
            : ["conversation_id", "id"];
      const run =
        query.phase === "verify"
          ? Number(
              this.db.prepare("SELECT run FROM verification_run WHERE plan_rev=?").get(revision)
                ?.run ?? 0,
            )
          : 0;
      const binding = digestJson({
        revision,
        phase: query.phase,
        sort,
        codes: query.codes ?? [],
        search: query.search ?? "",
        run,
      });
      let continuation = "";
      const cursorParams: Array<string | number> = [];
      if (query.cursor !== undefined) {
        const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as {
          binding?: unknown;
          values?: unknown;
        };
        if (
          cursor.binding !== binding ||
          !Array.isArray(cursor.values) ||
          cursor.values.length !== order.length ||
          cursor.values.some(
            (value) =>
              typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)),
          )
        )
          throw new Error("Invalid or stale row cursor");
        continuation = ` AND (${order.join(",")}) > (${order.map(() => "?").join(",")})`;
        cursorParams.push(...(cursor.values as Array<string | number>));
      }
      const limit =
        query.limit === undefined || !Number.isFinite(query.limit) || query.limit <= 0
          ? 100
          : Math.min(10_000, Math.max(1, Math.floor(query.limit)));
      const selected = this.db
        .prepare(
          `SELECT *,${order.map((expression, index) => `${expression} AS cursor_${index}`).join(",")} FROM ${table} ${where}${continuation} ORDER BY ${order.map((expression) => `${expression} ASC`).join(",")} LIMIT ?`,
        )
        .all(...params, ...cursorParams, limit + 1);
      const page = selected.slice(0, limit);
      const verification =
        job.verificationRevision === null
          ? null
          : this.readVerificationRevision(job.verificationRevision);
      const accepted = new Set(
        verification?.planRev === revision && query.phase === "verify"
          ? verification.acceptedCodes
          : [],
      );
      const rows: Row[] = page.map((row) => {
        const base = {
          id: String(row.id),
          code: String(row.code),
          kind: row.kind as Row["kind"],
          phase: row.phase as RowPhase,
          revision: Number(row.rev),
          accepted: accepted.has(String(row.code)),
        };
        return table === "item"
          ? {
              ...base,
              jobType: "file_migration",
              mappingId: String(row.mapping_id),
              sourceItemId: String(row.source_item_id),
              relativePath: String(row.relative_path),
              size: nullableNumber(row.size),
              destinationFileId: nullableString(row.dest_file_id),
              provenanceState: row.provenance_state as "none" | "marked" | "verified" | "drifted",
            }
          : {
              ...base,
              jobType: "teams_archive",
              scopeEntryId: String(row.scope_entry_id),
              conversationId: String(row.conversation_id),
              records: Number(row.records),
              assets: Number(row.assets),
              watermark: nullableString(row.watermark),
            };
      });
      const last = page.at(-1);
      const nextCursor =
        selected.length > limit && last !== undefined
          ? Buffer.from(
              canonicalJson({ binding, values: order.map((_, index) => last[`cursor_${index}`]) }),
              "utf8",
            ).toString("base64url")
          : null;
      return { facets: counts, rows, nextCursor, totalRows };
    });
  }
  finishOperation(): void {
    this.db.prepare("UPDATE projection_verb_state SET state='pending' WHERE state='current'").run();
    this.#pendingProgress = undefined;
  }
  #readProgress(): Pick<JobStatus, "progress" | "archiveProgress"> {
    const job = this.readJob();
    const row = this.db.prepare(
      "SELECT unit,done,total FROM projection_progress ORDER BY updated_at DESC,unit DESC LIMIT 1",
    ).get();
    const archive = job?.type === "teams_archive"
      ? this.db.prepare("SELECT * FROM projection_archive WHERE rev=?").get(job.planRevision ?? 0)
      : undefined;
    const archiveProgress = archive ? {
      conversations: Number(archive.conversations),
      totalConversations: Number(archive.total_conversations),
      records: Number(archive.records),
      totalRecords: nullableNumber(archive.total_records),
      assets: Number(archive.assets),
      bytes: Number(archive.bytes),
    } : undefined;
    return {
      progress: archiveProgress
        ? { unit: "records", done: archiveProgress.records, total: archiveProgress.totalRecords }
        : row ? { unit: row.unit as Progress["unit"], done: Number(row.done), total: nullableNumber(row.total) } : null,
      ...(archiveProgress ? { archiveProgress } : {}),
    };
  }
  publishProgress(): void {
    if (!this.#pendingProgress) return;
    if (this.#lastProgressAt === undefined) {
      const previous = this.db.prepare("SELECT at FROM event WHERE kind='progress' ORDER BY cursor DESC LIMIT 1").get();
      this.#lastProgressAt = previous ? Date.parse(String(previous.at)) : -Infinity;
    }
    const at = this.#now().getTime();
    if (at - this.#lastProgressAt < 1000) return;
    this.atomic(() => {
      const status = this.#readProgress();
      if (!status.progress) return;
      this.appendEvent({
        verb: this.#pendingProgress!,
        phase: this.#pendingProgress!,
        kind: "progress",
        payload: { ...status },
      });
      this.#lastProgressAt = at;
      this.#pendingProgress = undefined;
    });
  }
  appendEvent(e: {
    verb: Verb;
    phase: Verb;
    kind: EventKind;
    payload: Record<string, unknown>;
  }): number {
    return this.atomic(() => {
      if (e.kind === "phase_started") {
        this.db.prepare("UPDATE projection_verb_state SET state='pending' WHERE state='current'").run();
      }
      if (e.kind === "phase_started" || e.kind === "phase_completed" || e.kind === "terminal") {
        const state = e.kind === "phase_started" ? "current"
          : e.payload.state === "interrupted" ? "checkpoint"
          : e.payload.state === "blocked" || e.payload.passed === false ? "blocked"
          : e.payload.state === "executing" ? "current" : "done";
        this.db.prepare(
          "INSERT INTO projection_verb_state (verb,state,checkpoint,updated_at) VALUES (?,?,NULL,?) ON CONFLICT(verb) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at",
        ).run(e.phase, state, this.#now().toISOString());
      }
      const result = this.db
        .prepare("INSERT INTO event (at,verb,phase,kind,payload) VALUES (?,?,?,?,?)")
        .run(this.#now().toISOString(), e.verb, e.phase, e.kind, canonicalJson(e.payload));
      return Number(result.lastInsertRowid);
    });
  }
  async *events(query: {
    from?: number;
    follow?: boolean;
    signal?: AbortSignal;
  }): AsyncIterable<JobEvent> {
    let cursor = query.from ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid event cursor");
    while (!query.signal?.aborted) {
      const page = this.db
        .prepare("SELECT * FROM event WHERE cursor>? ORDER BY cursor LIMIT 512")
        .all(cursor);
      for (const row of page) {
        cursor = Number(row.cursor);
        yield {
          cursor,
          at: String(row.at),
          verb: row.verb as Verb,
          phase: row.phase as Verb,
          kind: row.kind as EventKind,
          payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
        };
      }
      if (page.length === 512) continue;
      if (!query.follow) return;
      try {
        await sleep(200, undefined, { signal: query.signal });
      } catch (error) {
        if (!query.signal?.aborted) throw error;
      }
    }
  }
  status(): JobStatus {
    return this.#snapshot(() => {
      const job = this.readJob();
      if (job === null) throw new Error("Job row missing");
      const lease = this.readLease();
      const fallback = fallbackRailState(job.state);
      const states = new Map(
        this.db
          .prepare("SELECT verb,state FROM projection_verb_state")
          .all()
          .map((row) => [String(row.verb), String(row.state)]),
      );
      const terminal = job.state === "closed" || job.state === "cancelled";
      const active = !terminal && lease && job.state !== "interrupted" && job.state !== "blocked"
        ? VERBS.find((verb) => states.get(verb) === "current")
        : undefined;
      const gate = active ?? (job.state === "verified" && states.get("report") === "done"
        ? "close"
        : VERBS.find((verb) => ["current", "blocked", "checkpoint"].includes(fallback[verb])));
      const rail = VERBS.map((verb) => {
        let state = states.get(verb) === "done" ? "done" : fallback[verb];
        if (["current", "blocked", "checkpoint"].includes(state) && verb !== gate) state = "pending";
        if (!terminal && verb === gate)
          state = active || (verb === "close" && job.state === "verified") ? "current" : fallback[verb];
        if (terminal && (verb === "cancel" || verb === "close"))
          state = (job.state === "closed" ? verb === "close" : verb === "cancel") ? "done" : "pending";
        return { verb, state: state as JobStatus["rail"][number]["state"] };
      });
      const plan = job.planRevision === null ? null : this.readPlanRevision(job.planRevision);
      const verification =
        job.verificationRevision === null
          ? null
          : this.readVerificationRevision(job.verificationRevision);
      const accepted = new Set(verification?.acceptedCodes ?? []);
      const findings =
        verification?.findings ??
        this.currentFindingCounts(job.planRevision ?? 0, this.currentPhase(job.planRevision ?? 0));
      const { progress, archiveProgress } = this.#readProgress();
      // Strip internal inputs/evidence from the adapter-facing approval preview.
      const currentPlan =
        plan === null
          ? null
          : {
              revision: plan.revision,
              planDigest: plan.planDigest,
              inputsDigest: plan.inputsDigest,
              createdAt: plan.createdAt,
              sourceInventoryAt: plan.sourceInventoryAt,
              rowCount: plan.rowCount,
              disclosures: plan.disclosures,
              sections: plan.sections,
            };
      const resumable = job.state === "interrupted" || job.state === "blocked";
      const terminalState =
        job.state === "interrupted" || job.state === "blocked" || job.state === "cancelled"
          ? job.state
          : job.state === "verified" || job.state === "needs_attention" || job.state === "closed"
            ? "completed"
            : null;
      return {
        jobId: job.id,
        jobType: job.type,
        state: job.state,
        schemaVersion: job.schemaVersion,
        rail,
        ownership: {
          held: lease !== null,
          heldByThisProcess: false,
          hostId: lease?.hostId ?? job.hostId,
          pid: lease?.pid ?? null,
          heartbeatAt: lease?.heartbeatAt ?? null,
          kind: lease?.kind ?? null,
        },
        planRevision: job.planRevision,
        planDigest: plan?.planDigest ?? null,
        currentPlan,
        verificationDigest: verification?.verificationDigest ?? null,
        progress,
        lastCheckpoint: job.lastCheckpoint ?? lease?.lastCheckpoint ?? null,
        outstandingFindings: findings.filter(
          (finding) => finding.kind !== "policy_outcome" && !accepted.has(finding.code),
        ),
        worker: {
          active:
            lease !== null &&
            (lease.socketPath !== null || lease.workerPid !== null || lease.workerGroup !== null),
          group: lease?.workerGroup ?? null,
        },
        resumable,
        terminalState,
        ...(archiveProgress === undefined ? {} : { archiveProgress }),
      };
    });
  }
}

function versionRefusal(version: number | null): Outcome<never> {
  return refuse(
    "state_version_unsupported",
    version === null
      ? "Job state is absent or has no supported schema"
      : `Job schema version ${version} is not supported by this reader`,
    { detail: { schemaVersion: version, currentVersion: SCHEMA_VERSION } },
  );
}
function openInspector(path: string): DatabaseSync {
  // Node's SQLite opener supports URI filenames. Immutable is used only for a
  // short main-file probe with no WAL, never for a live reader or event stream.
  const noWal = !existsSync(`${path}-wal`);
  const location = noWal ? `${pathToFileURL(path).href}?mode=ro&immutable=1` : path;
  let db = new DatabaseSync(location, {
    open: true,
    readOnly: true,
    enableForeignKeyConstraints: false,
  });
  if (noWal && existsSync(`${path}-wal`)) {
    db.close();
    db = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      enableForeignKeyConstraints: false,
    });
  }
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  return db;
}
function inspectHost(
  db: DatabaseSync,
  opts: { hostId?: string; now: () => Date },
): Outcome<never> | null {
  if (opts.hostId === undefined) return null;
  const hostColumn = db
    .prepare("SELECT 1 FROM pragma_table_info('job') WHERE name='host_id'")
    .get();
  const persisted =
    hostColumn === undefined
      ? tableExists(db, "job")
        ? db.prepare("SELECT last_checkpoint FROM job LIMIT 1").get()
        : undefined
      : db.prepare("SELECT host_id,last_checkpoint FROM job LIMIT 1").get();
  const lease = tableExists(db, "lease")
    ? db
        .prepare(
          "SELECT host_id,owner_uuid,pid,process_start_time,heartbeat_at,kind,worker_group,last_checkpoint FROM lease WHERE id=1",
        )
        .get()
    : undefined;
  const hostId = nullableString(persisted?.host_id) ?? nullableString(lease?.host_id);
  if (hostId === null || opts.hostId === hostId) return null;
  const heartbeatAt = nullableString(lease?.heartbeat_at);
  const recovery = {
    workerAlive: false,
    workerStatus: "unknown" as const,
    recordedHostId: hostId,
    thisHostId: opts.hostId,
    holder:
      lease === undefined
        ? null
        : {
            ownerUuid: String(lease.owner_uuid),
            pid: Number(lease.pid),
            processStartTime: Number(lease.process_start_time),
            heartbeatAt: String(lease.heartbeat_at),
            heartbeatAgeMs: Math.max(
              0,
              opts.now().getTime() - Date.parse(String(lease.heartbeat_at)),
            ),
            kind: lease.kind as "cli" | "web",
          },
    workerGroup: nullableString(lease?.worker_group),
    lastCheckpoint:
      nullableString(persisted?.last_checkpoint) ?? nullableString(lease?.last_checkpoint),
    reclaimable: false,
  };
  return refuse("foreign_host", "This job belongs to another host", {
    detail: { hostId, pid: nullableNumber(lease?.pid), heartbeatAt },
    recovery,
  });
}
export function openReadStore(
  jobDir: string,
  opts: { migmateVersion: string; now: () => Date; hostId: string },
): Outcome<Store> {
  const path = join(resolve(jobDir), "state.db");
  if (!existsSync(path)) return refuse("job_not_found", "Job state does not exist");
  safePath(resolve(jobDir), "state.db");
  const inspector = openInspector(path);
  try {
    const version = schemaVersion(inspector);
    if (version !== SCHEMA_VERSION) return versionRefusal(version);
    const mismatch = inspectHost(inspector, opts);
    if (mismatch) return mismatch;
  } finally {
    inspector.close();
  }
  const db = new DatabaseSync(path, {
    open: true,
    readOnly: true,
    enableForeignKeyConstraints: false,
  });
  try {
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    const version = schemaVersion(db);
    if (version !== SCHEMA_VERSION) {
      db.close();
      return versionRefusal(version);
    }
    const mismatch = inspectHost(db, opts);
    if (mismatch) {
      db.close();
      return mismatch;
    }
    // No tree creation, migrations, or persistent PRAGMAs; busy_timeout is connection-local.
    return ok(new StoreImpl(db, resolve(jobDir), opts, false));
  } catch (error) {
    db.close();
    throw error;
  }
}
export function openStore(
  jobDir: string,
  opts: { migmateVersion: string; now: () => Date; hostId?: string; existingOnly?: boolean },
): Outcome<Store> {
  const root = resolve(jobDir);
  const path = join(root, "state.db");
  if (existsSync(path)) {
    safePath(root, "state.db");
    const inspector = openInspector(path);
    try {
      const version = schemaVersion(inspector);
      if (version !== null && (version > SCHEMA_VERSION || version < 1))
        return versionRefusal(version);
      if (version === null && opts.existingOnly)
        return refuse("job_not_found", "Job state does not contain a job");
      const mismatch = inspectHost(inspector, opts);
      if (mismatch) return mismatch;
    } finally {
      inspector.close();
    }
  } else if (opts.existingOnly) {
    return refuse("job_not_found", "Job state does not exist");
  }
  ensureJobTree(root);
  const db = new DatabaseSync(path, { open: true, enableForeignKeyConstraints: true });
  try {
    const liveVersion = schemaVersion(db);
    if (liveVersion !== null && (liveVersion > SCHEMA_VERSION || liveVersion < 1)) {
      db.close();
      return versionRefusal(liveVersion);
    }
    db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`,
    );
    transaction(db, () => {
      if (!tableExists(db, "job")) db.exec(schemaSql);
      else {
        const version = schemaVersion(db);
        if (version === 1) migrateVersion1(db);
        else if (version !== null && version !== SCHEMA_VERSION)
          throw new Error("Job schema changed while opening");
      }
    });
    syncDirectory(root);
    return ok(new StoreImpl(db, root, opts, true));
  } catch (error) {
    db.close();
    throw error;
  }
}
