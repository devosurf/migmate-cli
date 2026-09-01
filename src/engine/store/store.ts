import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, posix, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ok,
  refuse,
  type ApprovalRecord,
  type CheckResult,
  type Closure,
  type EventKind,
  type FacetCount,
  type JobEvent,
  type JobState,
  type JobStatus,
  type JobType,
  type Outcome,
  type PlanRevision,
  type Progress,
  type ProgressUnit,
  type Refusal,
  type Row,
  type RowPage,
  type RowPhase,
  type RowQuery,
  type TerminalState,
  type VerificationRevision,
  type Verb,
  VERBS,
} from "../types.ts";

import { canonicalJson, digestJson } from "./digest.ts";

import type {
  CommitFinding,
  CommitReceipt,
  CommitRow,
  CommitUnit,
  DurableAsset,
} from "../commit.ts";

export const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const STAGING_DIRNAME = ".staging";
const ASSETS_DIRNAME = "assets";
const ARTIFACTS_DIRNAME = "artifacts";
const RUN_DIRNAME = "run";
const FINAL_ASSET_PREFIX = "assets";

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

export interface Store {
  close(): void;
  // Lease handling and crash reconciliation are the only legitimate raw-SQL consumers; everything else goes through Store methods.
  readonly db: DatabaseSync;
  readJob(): JobRecord | null;
  writeJob(job: JobRecord): void;
  readLease(): LeaseRecord | null;
  writeLease(lease: LeaseRecord): void;
  clearLease(): void;
  touchLease(update: { heartbeatAt: string; lastCheckpoint?: string | null }): void;
  readPlanRevision(revision: number): PlanRevisionRecord | null;
  writePlanRevision(record: PlanRevisionRecord): void;
  readApproval(revision: number): ApprovalRecord | null;
  writeApproval(record: ApprovalRecord): void;
  readVerificationRevision(revision: number): VerificationRevisionRecord | null;
  writeVerificationRevision(record: VerificationRevisionRecord): void;
  readAcceptances(verificationDigest: string): AcceptanceRecord[];
  writeAcceptance(record: AcceptanceRecord): void;
  readFindings(revision: number, phase?: RowPhase): FindingRecord[];
  writeFinding(record: FindingRecord): void;
  readCheckResults(verb?: Verb): CheckResultRecord[];
  writeCheckResult(record: CheckResultRecord): void;
  commit(unit: CommitUnit): CommitReceipt;
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

const moduleDir = import.meta.dirname;
const schemaSql = readFileSync(join(moduleDir, "schema.sql"), "utf8");
const STATE_DB_NAME = "state.db";

function ensureJobTree(jobDir: string): void {
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(jobDir, ASSETS_DIRNAME), { recursive: true, mode: 0o700 });
  mkdirSync(join(jobDir, ASSETS_DIRNAME, STAGING_DIRNAME), { recursive: true, mode: 0o700 });
  mkdirSync(join(jobDir, ARTIFACTS_DIRNAME), { recursive: true, mode: 0o700 });
  mkdirSync(join(jobDir, RUN_DIRNAME), { recursive: true, mode: 0o700 });
}

function dbPath(jobDir: string): string {
  return join(jobDir, STATE_DB_NAME);
}

function setPragmas(db: DatabaseSync, writable: boolean): void {
  if (writable) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
}

function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const value = fn();
    db.exec("COMMIT;");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ROLLBACK is best-effort after a failed statement inside the transaction.
    }
    throw error;
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name) as { ok?: number } | undefined;
  return row !== undefined;
}

function readJobSchemaVersion(db: DatabaseSync): number | null {
  if (!tableExists(db, "job")) {
    return null;
  }
  const row = db.prepare("SELECT schema_version AS schemaVersion FROM job LIMIT 1").get() as
    { schemaVersion?: number } | undefined;
  return row?.schemaVersion ?? null;
}

function migrateSchemaVersion1(db: DatabaseSync): void {
  // Future forward migrations start here.
  db.prepare("UPDATE job SET schema_version = ? WHERE schema_version < ?").run(
    SCHEMA_VERSION,
    SCHEMA_VERSION,
  );
}

function insertSchema(db: DatabaseSync): void {
  withTransaction(db, () => {
    db.exec(schemaSql);
  });
}

function rowToJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    type: row.type as JobType,
    state: row.state as JobState,
    schemaVersion: Number(row.schema_version),
    migmateVersion: String(row.migmate_version),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    createdAt: String(row.created_at),
    planRevision:
      row.plan_revision === null || row.plan_revision === undefined
        ? null
        : Number(row.plan_revision),
    verificationRevision:
      row.verification_revision === null || row.verification_revision === undefined
        ? null
        : Number(row.verification_revision),
    lastCheckpoint:
      row.last_checkpoint === null || row.last_checkpoint === undefined
        ? null
        : String(row.last_checkpoint),
  };
}

function rowToLease(row: Record<string, unknown>): LeaseRecord {
  return {
    ownerUuid: String(row.owner_uuid),
    hostId: String(row.host_id),
    pid: Number(row.pid),
    processStartTime: Number(row.process_start_time),
    heartbeatAt: String(row.heartbeat_at),
    kind: row.kind as "cli" | "web",
    socketPath:
      row.socket_path === null || row.socket_path === undefined ? null : String(row.socket_path),
    workerGroup:
      row.worker_group === null || row.worker_group === undefined ? null : String(row.worker_group),
    workerPid:
      row.worker_pid === null || row.worker_pid === undefined ? null : Number(row.worker_pid),
    lastCheckpoint:
      row.last_checkpoint === null || row.last_checkpoint === undefined
        ? null
        : String(row.last_checkpoint),
    migmateVersion: String(row.migmate_version),
  };
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function stringifyEvidence(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return canonicalJson(value);
}

function readPlanInputs(db: DatabaseSync, revision: number): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM plan_input WHERE rev = ? ORDER BY key")
    .all(revision) as Array<{ key: string; value: string }>;
  const inputs: Record<string, string> = {};
  for (const row of rows) {
    inputs[row.key] = row.value;
  }
  return inputs;
}

function countRowsForRevision(db: DatabaseSync, revision: number): number {
  const itemCount = db
    .prepare("SELECT COUNT(*) AS count FROM item WHERE rev = ? AND phase = 'plan'")
    .get(revision) as { count?: number } | undefined;
  const conversationCount = db
    .prepare("SELECT COUNT(*) AS count FROM conversation WHERE rev = ? AND phase = 'plan'")
    .get(revision) as { count?: number } | undefined;
  return Number(itemCount?.count ?? 0) + Number(conversationCount?.count ?? 0);
}

function readFindingFacets(db: DatabaseSync, revision: number, phase: RowPhase): FacetCount[] {
  const rows = db
    .prepare(
      "SELECT code, kind, COUNT(*) AS count FROM finding WHERE rev = ? AND phase = ? GROUP BY code, kind ORDER BY code",
    )
    .all(revision, phase) as Array<{ code: string; kind: FacetCount["kind"]; count: number }>;
  return rows.map((row) => ({ code: row.code, kind: row.kind, count: Number(row.count) }));
}

function readAcceptedCodes(db: DatabaseSync, verificationDigest: string): string[] {
  const rows = db
    .prepare("SELECT code FROM acceptance WHERE verification_digest = ? ORDER BY code")
    .all(verificationDigest) as Array<{ code: string }>;
  return rows.map((row) => row.code);
}

function readCheckResultRows(db: DatabaseSync, verb?: Verb): CheckResultRecord[] {
  const rows = verb
    ? db
        .prepare(
          "SELECT verb, check_id, title, status, code, evidence, at FROM check_result WHERE verb = ? ORDER BY id",
        )
        .all(verb)
    : db
        .prepare(
          "SELECT verb, check_id, title, status, code, evidence, at FROM check_result ORDER BY id",
        )
        .all();
  return (
    rows as Array<{
      verb: Verb;
      check_id: string;
      title: string;
      status: CheckResult["status"];
      code: string | null;
      evidence: string;
      at: string;
    }>
  ).map((row) => {
    const base = {
      verb: row.verb,
      id: row.check_id,
      title: row.title,
      status: row.status,
      evidence: parseJsonText(row.evidence) as Record<string, unknown>,
      at: row.at,
    };
    return row.code === null ? base : { ...base, code: row.code };
  });
}

function readFindingRows(db: DatabaseSync, revision: number, phase?: RowPhase): FindingRecord[] {
  const rows = phase
    ? db
        .prepare(
          "SELECT id, rev, phase, code, kind, subject_kind, subject_id, evidence, at FROM finding WHERE rev = ? AND phase = ? ORDER BY id",
        )
        .all(revision, phase)
    : db
        .prepare(
          "SELECT id, rev, phase, code, kind, subject_kind, subject_id, evidence, at FROM finding WHERE rev = ? ORDER BY id",
        )
        .all(revision);
  return (
    rows as Array<{
      id: number;
      rev: number;
      phase: RowPhase;
      code: string;
      kind: FindingRecord["kind"];
      subject_kind: string;
      subject_id: string;
      evidence: string;
      at: string;
    }>
  ).map((row) => ({
    id: row.id,
    rev: row.rev,
    phase: row.phase,
    code: row.code,
    kind: row.kind,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    evidence: parseJsonText(row.evidence),
    at: row.at,
  }));
}

function readPlanRevisionRow(db: DatabaseSync, revision: number): PlanRevisionRecord | null {
  const row = db
    .prepare(
      "SELECT rev, plan_digest, inputs_digest, created_at, source_inventory_at, evidence FROM plan_revision WHERE rev = ?",
    )
    .get(revision) as
    | {
        rev: number;
        plan_digest: string;
        inputs_digest: string;
        created_at: string;
        source_inventory_at: string;
        evidence: string;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    revision: row.rev,
    planDigest: row.plan_digest,
    inputsDigest: row.inputs_digest,
    createdAt: row.created_at,
    sourceInventoryAt: row.source_inventory_at,
    rowCount: countRowsForRevision(db, row.rev),
    inputs: readPlanInputs(db, row.rev),
    evidence: parseJsonText(row.evidence),
  };
}

function readVerificationRevisionRow(
  db: DatabaseSync,
  revision: number,
): VerificationRevisionRecord | null {
  const row = db
    .prepare(
      "SELECT rev, plan_rev, verification_digest, clean, at FROM verification_revision WHERE rev = ?",
    )
    .get(revision) as
    | {
        rev: number;
        plan_rev: number;
        verification_digest: string;
        clean: number;
        at: string;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    revision: row.rev,
    planRev: row.plan_rev,
    verificationDigest: row.verification_digest,
    clean: row.clean !== 0,
    findings: readFindingFacets(db, row.rev, "verify"),
    acceptedCodes: readAcceptedCodes(db, row.verification_digest),
    at: row.at,
  };
}

function readApprovalRow(db: DatabaseSync, revision: number): ApprovalRecord | null {
  const row = db
    .prepare(
      "SELECT rev, plan_digest, approver, mode, at FROM approval WHERE rev = ? ORDER BY id DESC LIMIT 1",
    )
    .get(revision) as
    | {
        rev: number;
        plan_digest: string;
        approver: string;
        mode: "interactive" | "unattended";
        at: string;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    revision: row.rev,
    planDigest: row.plan_digest,
    approver: row.approver,
    mode: row.mode,
    at: row.at,
  };
}

/**
 * Only verbs with a durable projection row. Pre-filling every verb with
 * "pending" would mask the fallback entirely, so a job whose projection has not
 * been written yet would report a rail of all-pending regardless of its state.
 */
function verbStatesFromRows(
  rows: Array<{ verb: Verb; state: string; checkpoint: string | null }>,
): Partial<Record<Verb, string>> {
  const map: Partial<Record<Verb, string>> = {};
  for (const row of rows) {
    map[row.verb] = row.state;
  }
  return map;
}

function fallbackRailState(jobState: JobState): Record<Verb, string> {
  const rail = Object.fromEntries(VERBS.map((verb) => [verb, "pending"])) as Record<Verb, string>;
  const currentVerb: Record<JobState, Verb> = {
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
  const current = currentVerb[jobState];
  for (const verb of VERBS) {
    if (jobState === "new") {
      // `doctor` has not run on a fresh job; `plan` runs preflight itself, so it is the actionable verb.
      rail[verb] = verb === "plan" ? "current" : verb === "init" ? "done" : "pending";
      continue;
    }
    if (jobState === "planned") {
      rail[verb] =
        verb === "approve"
          ? "current"
          : verb === "init" || verb === "doctor" || verb === "plan"
            ? "done"
            : "pending";
      continue;
    }
    if (jobState === "approved") {
      rail[verb] =
        verb === "execute"
          ? "current"
          : verb === "init" || verb === "doctor" || verb === "plan" || verb === "approve"
            ? "done"
            : "pending";
      continue;
    }
    if (jobState === "executing" || jobState === "interrupted" || jobState === "blocked") {
      rail[verb] =
        verb === "execute"
          ? "current"
          : verb === "init" || verb === "doctor" || verb === "plan" || verb === "approve"
            ? "done"
            : "pending";
      continue;
    }
    if (jobState === "needs_attention") {
      rail[verb] =
        verb === "verify"
          ? "current"
          : verb === "init" ||
              verb === "doctor" ||
              verb === "plan" ||
              verb === "approve" ||
              verb === "execute"
            ? "done"
            : "pending";
      continue;
    }
    if (jobState === "verified") {
      rail[verb] =
        verb === "report"
          ? "current"
          : verb === "init" ||
              verb === "doctor" ||
              verb === "plan" ||
              verb === "approve" ||
              verb === "execute" ||
              verb === "verify"
            ? "done"
            : "pending";
      continue;
    }
    if (jobState === "closed" || jobState === "cancelled") {
      rail[verb] = "done";
      continue;
    }
    rail[verb] = verb === current ? "current" : "pending";
  }
  return rail;
}

function readProgressRow(db: DatabaseSync): Progress | null {
  const row = db
    .prepare(
      "SELECT unit, done, total FROM projection_progress ORDER BY updated_at DESC, unit DESC LIMIT 1",
    )
    .get() as { unit: ProgressUnit; done: number; total: number | null } | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    unit: row.unit,
    done: Number(row.done),
    total: row.total === null ? null : Number(row.total),
  };
}

function readOutstandingFindings(db: DatabaseSync, revision: number): FacetCount[] {
  const rows = db
    .prepare(
      "SELECT code, kind, count FROM projection_facet WHERE rev = ? AND kind = 'finding' ORDER BY code",
    )
    .all(revision) as Array<{ code: string; kind: FacetCount["kind"]; count: number }>;
  return rows.map((row) => ({ code: row.code, kind: row.kind, count: Number(row.count) }));
}

function hashAndSyncFile(filePath: string): { sha256: string; size: number } {
  const stat = statSync(filePath);
  const fd = openSync(filePath, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) {
        break;
      }
      hash.update(buffer.subarray(0, read));
    }
    fsyncSync(fd);
    return { sha256: hash.digest("hex"), size: stat.size };
  } finally {
    closeSync(fd);
  }
}

function assetFinalPath(jobDir: string, sha256: string): string {
  return join(jobDir, ASSETS_DIRNAME, sha256);
}

function assetFinalPathForDb(sha256: string): string {
  return posix.join(FINAL_ASSET_PREFIX, sha256);
}

function materializeAsset(jobDir: string, asset: DurableAsset): string {
  const verified = hashAndSyncFile(asset.stagedPath);
  if (verified.sha256 !== asset.sha256 || verified.size !== asset.size) {
    throw new Error(`asset digest mismatch for ${asset.id}`);
  }
  const finalPath = assetFinalPath(jobDir, asset.sha256);
  if (existsSync(finalPath)) {
    const current = hashAndSyncFile(finalPath);
    if (current.sha256 !== asset.sha256 || current.size !== asset.size) {
      throw new Error(`content-addressed asset collision for ${asset.id}`);
    }
    unlinkSync(asset.stagedPath);
    return finalPath;
  }
  renameSync(asset.stagedPath, finalPath);
  return finalPath;
}

function encodeCursor(cursor: {
  sort: string;
  bucket: number;
  value: string | number | null;
  id: string;
}): string {
  return Buffer.from(canonicalJson(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): {
  sort: string;
  bucket: number;
  value: string | number | null;
  id: string;
} {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    sort: string;
    bucket: number;
    value: string | number | null;
    id: string;
  };
  if (
    typeof parsed.sort !== "string" ||
    typeof parsed.bucket !== "number" ||
    typeof parsed.id !== "string"
  ) {
    throw new Error("Invalid row cursor");
  }
  return parsed;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return 100;
  }
  return Math.floor(limit);
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function buildSearchClause(columns: string[], search: string): { sql: string; params: string[] } {
  const escaped = `%${escapeLike(search.toLowerCase())}%`;
  const clause = columns.map((column) => `lower(${column}) LIKE ? ESCAPE '\\'`).join(" OR ");
  return { sql: `(${clause})`, params: columns.map(() => escaped) };
}

function rowKindFromAccepted(accepted: unknown): boolean {
  return accepted !== 0 && accepted !== null && accepted !== undefined;
}

class StoreImpl implements Store {
  readonly db: DatabaseSync;
  readonly #db: DatabaseSync;
  readonly #jobDir: string;

  constructor(db: DatabaseSync, jobDir: string) {
    this.db = db;
    this.#db = db;
    this.#jobDir = jobDir;
  }

  close(): void {
    this.#db.close();
  }

  readJob(): JobRecord | null {
    const row = this.#db.prepare("SELECT * FROM job LIMIT 1").get() as
      Record<string, unknown> | undefined;
    return row === undefined ? null : rowToJob(row);
  }

  writeJob(job: JobRecord): void {
    this.#db
      .prepare(
        `
        INSERT INTO job (
          id, type, state, schema_version, migmate_version, label, created_at, plan_revision, verification_revision, last_checkpoint
        ) VALUES (
          $id, $type, $state, $schemaVersion, $migmateVersion, $label, $createdAt, $planRevision, $verificationRevision, $lastCheckpoint
        )
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          state = excluded.state,
          schema_version = excluded.schema_version,
          migmate_version = excluded.migmate_version,
          label = excluded.label,
          created_at = excluded.created_at,
          plan_revision = excluded.plan_revision,
          verification_revision = excluded.verification_revision,
          last_checkpoint = excluded.last_checkpoint
        `,
      )
      .run({
        $id: job.id,
        $type: job.type,
        $state: job.state,
        $schemaVersion: job.schemaVersion,
        $migmateVersion: job.migmateVersion,
        $label: job.label,
        $createdAt: job.createdAt,
        $planRevision: job.planRevision,
        $verificationRevision: job.verificationRevision,
        $lastCheckpoint: job.lastCheckpoint,
      });
  }

  readLease(): LeaseRecord | null {
    const row = this.#db.prepare("SELECT * FROM lease WHERE id = 1").get() as
      Record<string, unknown> | undefined;
    return row === undefined ? null : rowToLease(row);
  }

  writeLease(lease: LeaseRecord): void {
    this.#db
      .prepare(
        `
        INSERT INTO lease (
          id, owner_uuid, host_id, pid, process_start_time, heartbeat_at, kind, socket_path, worker_group, worker_pid, last_checkpoint, migmate_version
        ) VALUES (
          1, $ownerUuid, $hostId, $pid, $processStartTime, $heartbeatAt, $kind, $socketPath, $workerGroup, $workerPid, $lastCheckpoint, $migmateVersion
        )
        ON CONFLICT(id) DO UPDATE SET
          owner_uuid = excluded.owner_uuid,
          host_id = excluded.host_id,
          pid = excluded.pid,
          process_start_time = excluded.process_start_time,
          heartbeat_at = excluded.heartbeat_at,
          kind = excluded.kind,
          socket_path = excluded.socket_path,
          worker_group = excluded.worker_group,
          worker_pid = excluded.worker_pid,
          last_checkpoint = excluded.last_checkpoint,
          migmate_version = excluded.migmate_version
        `,
      )
      .run({
        $ownerUuid: lease.ownerUuid,
        $hostId: lease.hostId,
        $pid: lease.pid,
        $processStartTime: lease.processStartTime,
        $heartbeatAt: lease.heartbeatAt,
        $kind: lease.kind,
        $socketPath: lease.socketPath,
        $workerGroup: lease.workerGroup,
        $workerPid: lease.workerPid,
        $lastCheckpoint: lease.lastCheckpoint,
        $migmateVersion: lease.migmateVersion,
      });
  }

  clearLease(): void {
    this.#db.prepare("DELETE FROM lease WHERE id = 1").run();
  }

  touchLease(update: { heartbeatAt: string; lastCheckpoint?: string | null }): void {
    this.#db
      .prepare(
        "UPDATE lease SET heartbeat_at = $heartbeatAt, last_checkpoint = COALESCE($lastCheckpoint, last_checkpoint) WHERE id = 1",
      )
      .run({ $heartbeatAt: update.heartbeatAt, $lastCheckpoint: update.lastCheckpoint ?? null });
  }

  readPlanRevision(revision: number): PlanRevisionRecord | null {
    return readPlanRevisionRow(this.#db, revision);
  }

  writePlanRevision(record: PlanRevisionRecord): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `
          INSERT INTO plan_revision (rev, plan_digest, inputs_digest, created_at, source_inventory_at, evidence)
          VALUES ($rev, $planDigest, $inputsDigest, $createdAt, $sourceInventoryAt, $evidence)
          `,
        )
        .run({
          $rev: record.revision,
          $planDigest: record.planDigest,
          $inputsDigest: record.inputsDigest,
          $createdAt: record.createdAt,
          $sourceInventoryAt: record.sourceInventoryAt,
          $evidence: stringifyEvidence(record.evidence),
        });
      const inputStmt = this.#db.prepare(
        "INSERT INTO plan_input (rev, key, value) VALUES ($rev, $key, $value)",
      );
      for (const [key, value] of Object.entries(record.inputs).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        inputStmt.run({ $rev: record.revision, $key: key, $value: value });
      }
      this.#db
        .prepare(
          "UPDATE job SET plan_revision = $planRevision WHERE id = (SELECT id FROM job LIMIT 1)",
        )
        .run({ $planRevision: record.revision });
    });
  }

  readApproval(revision: number): ApprovalRecord | null {
    return readApprovalRow(this.#db, revision);
  }

  writeApproval(record: ApprovalRecord): void {
    this.#db
      .prepare(
        `
        INSERT INTO approval (rev, plan_digest, approver, mode, at)
        VALUES ($rev, $planDigest, $approver, $mode, $at)
        `,
      )
      .run({
        $rev: record.revision,
        $planDigest: record.planDigest,
        $approver: record.approver,
        $mode: record.mode,
        $at: record.at,
      });
  }

  readVerificationRevision(revision: number): VerificationRevisionRecord | null {
    return readVerificationRevisionRow(this.#db, revision);
  }

  writeVerificationRevision(record: VerificationRevisionRecord): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `
          INSERT INTO verification_revision (rev, plan_rev, verification_digest, clean, at)
          VALUES ($rev, $planRev, $verificationDigest, $clean, $at)
          `,
        )
        .run({
          $rev: record.revision,
          $planRev: record.planRev,
          $verificationDigest: record.verificationDigest,
          $clean: record.clean ? 1 : 0,
          $at: record.at,
        });
      this.#db
        .prepare(
          "UPDATE job SET verification_revision = $verificationRevision WHERE id = (SELECT id FROM job LIMIT 1)",
        )
        .run({ $verificationRevision: record.revision });
    });
  }

  readAcceptances(verificationDigest: string): AcceptanceRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT verification_digest, code, approver, note, at FROM acceptance WHERE verification_digest = ? ORDER BY code",
      )
      .all(verificationDigest) as Array<{
      verification_digest: string;
      code: string;
      approver: string;
      note: string | null;
      at: string;
    }>;
    return rows.map((row) => ({
      verificationDigest: row.verification_digest,
      code: row.code,
      approver: row.approver,
      note: row.note,
      at: row.at,
    }));
  }

  writeAcceptance(record: AcceptanceRecord): void {
    this.#db
      .prepare(
        `
        INSERT INTO acceptance (verification_digest, code, approver, note, at)
        VALUES ($verificationDigest, $code, $approver, $note, $at)
        ON CONFLICT(verification_digest, code) DO UPDATE SET
          approver = excluded.approver,
          note = excluded.note,
          at = excluded.at
        `,
      )
      .run({
        $verificationDigest: record.verificationDigest,
        $code: record.code,
        $approver: record.approver,
        $note: record.note,
        $at: record.at,
      });
  }

  readFindings(revision: number, phase?: RowPhase): FindingRecord[] {
    return readFindingRows(this.#db, revision, phase);
  }

  writeFinding(record: FindingRecord): void {
    this.#db
      .prepare(
        `
        INSERT INTO finding (rev, phase, code, kind, subject_kind, subject_id, evidence, at)
        VALUES ($rev, $phase, $code, $kind, $subjectKind, $subjectId, $evidence, $at)
        `,
      )
      .run({
        $rev: record.rev,
        $phase: record.phase,
        $code: record.code,
        $kind: record.kind,
        $subjectKind: record.subjectKind,
        $subjectId: record.subjectId,
        $evidence: stringifyEvidence(record.evidence),
        $at: record.at,
      });
  }

  readCheckResults(verb?: Verb): CheckResultRecord[] {
    return readCheckResultRows(this.#db, verb);
  }

  writeCheckResult(record: CheckResultRecord): void {
    this.#db
      .prepare(
        `
        INSERT INTO check_result (verb, check_id, title, status, code, evidence, at)
        VALUES ($verb, $checkId, $title, $status, $code, $evidence, $at)
        `,
      )
      .run({
        $verb: record.verb,
        $checkId: record.id,
        $title: record.title,
        $status: record.status,
        $code: record.code ?? null,
        $evidence: stringifyEvidence(record.evidence),
        $at: record.at,
      });
  }

  commit(unit: CommitUnit): CommitReceipt {
    const assets = unit.assets ?? [];
    for (const asset of assets) {
      materializeAsset(this.#jobDir, asset);
    }

    const eventPayload = {
      unitKey: unit.unitKey,
      checkpoint: unit.checkpoint,
      rev: unit.rev,
      phase: unit.phase,
      rows: unit.rows.length,
      findings: unit.findings.length,
      assets: assets.length,
      watermark: unit.watermark ?? null,
      progress: unit.progress ?? null,
    };

    return withTransaction(this.#db, () => {
      const gate = this.#db
        .prepare(
          "INSERT OR IGNORE INTO commit_log (rev, phase, unit_key, checkpoint, at) VALUES ($rev, $phase, $unitKey, $checkpoint, $at)",
        )
        .run({
          $rev: unit.rev,
          $phase: unit.phase,
          $unitKey: unit.unitKey,
          $checkpoint: unit.checkpoint,
          $at: new Date().toISOString(),
        });
      if (gate.changes === 0) {
        return { applied: false };
      }

      const itemStmt = this.#db.prepare(
        `
        INSERT INTO item (
          id, rev, phase, code, kind, accepted, mapping_id, source_drive_id, source_item_id, relative_path,
          item_type, size, source_etag, source_fingerprint, dest_drive_id, dest_file_id, dest_fingerprint, provenance_state
        ) VALUES (
          $id, $rev, $phase, $code, $kind, $accepted, $mappingId, $sourceDriveId, $sourceItemId, $relativePath,
          $itemType, $size, $sourceEtag, $sourceFingerprint, $destDriveId, $destFileId, $destFingerprint, $provenanceState
        )
        ON CONFLICT(rev, phase, id) DO UPDATE SET
          code = excluded.code,
          kind = excluded.kind,
          accepted = excluded.accepted,
          mapping_id = excluded.mapping_id,
          source_drive_id = excluded.source_drive_id,
          source_item_id = excluded.source_item_id,
          relative_path = excluded.relative_path,
          item_type = excluded.item_type,
          size = excluded.size,
          source_etag = excluded.source_etag,
          source_fingerprint = excluded.source_fingerprint,
          dest_drive_id = excluded.dest_drive_id,
          dest_file_id = excluded.dest_file_id,
          dest_fingerprint = excluded.dest_fingerprint,
          provenance_state = excluded.provenance_state
        `,
      );
      const conversationStmt = this.#db.prepare(
        `
        INSERT INTO conversation (
          id, rev, phase, code, kind, accepted, scope_entry_id, conversation_id, title, records, assets, watermark
        ) VALUES (
          $id, $rev, $phase, $code, $kind, $accepted, $scopeEntryId, $conversationId, $title, $records, $assets, $watermark
        )
        ON CONFLICT(rev, phase, id) DO UPDATE SET
          code = excluded.code,
          kind = excluded.kind,
          accepted = excluded.accepted,
          scope_entry_id = excluded.scope_entry_id,
          conversation_id = excluded.conversation_id,
          title = excluded.title,
          records = excluded.records,
          assets = excluded.assets,
          watermark = excluded.watermark
        `,
      );
      const facetCounts = new Map<string, { kind: CommitRow["kind"]; count: number }>();
      for (const row of unit.rows) {
        if (row.jobType === "file_migration") {
          itemStmt.run({
            $id: row.id,
            $rev: row.rev,
            $phase: row.phase,
            $code: row.code,
            $kind: row.kind,
            $accepted: row.accepted ? 1 : 0,
            $mappingId: row.mappingId,
            $sourceDriveId: row.sourceDriveId,
            $sourceItemId: row.sourceItemId,
            $relativePath: row.relativePath,
            $itemType: row.itemType,
            $size: row.size,
            $sourceEtag: row.sourceEtag ?? null,
            $sourceFingerprint: row.sourceFingerprint ?? null,
            $destDriveId: row.destinationDriveId ?? null,
            $destFileId: row.destinationFileId ?? null,
            $destFingerprint: row.destinationFingerprint ?? null,
            $provenanceState: row.provenanceState ?? "none",
          });
        } else {
          conversationStmt.run({
            $id: row.id,
            $rev: row.rev,
            $phase: row.phase,
            $code: row.code,
            $kind: row.kind,
            $accepted: row.accepted ? 1 : 0,
            $scopeEntryId: row.scopeEntryId,
            $conversationId: row.conversationId,
            $title: row.title ?? null,
            $records: row.records,
            $assets: row.assets,
            $watermark: row.watermark ?? null,
          });
        }
        const key = `${row.phase}\u0000${row.rev}\u0000${row.code}`;
        const current = facetCounts.get(key);
        if (current === undefined) {
          facetCounts.set(key, { kind: row.kind, count: 1 });
        } else {
          current.count += 1;
        }
      }

      const findingStmt = this.#db.prepare(
        `
        INSERT INTO finding (rev, phase, code, kind, subject_kind, subject_id, evidence, at)
        VALUES ($rev, $phase, $code, $kind, $subjectKind, $subjectId, $evidence, $at)
        `,
      );
      for (const finding of unit.findings) {
        findingStmt.run({
          $rev: finding.rev,
          $phase: finding.phase,
          $code: finding.code,
          $kind: finding.kind,
          $subjectKind: finding.subjectKind,
          $subjectId: finding.subjectId,
          $evidence: stringifyEvidence(finding.evidence),
          $at: finding.at,
        });
      }

      const assetStmt = this.#db.prepare(
        `
        INSERT INTO asset (id, conversation_id, source_kind, path, size, sha256, retrieved_at)
        VALUES ($id, $conversationId, $sourceKind, $path, $size, $sha256, $retrievedAt)
        ON CONFLICT(id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          source_kind = excluded.source_kind,
          path = excluded.path,
          size = excluded.size,
          sha256 = excluded.sha256,
          retrieved_at = excluded.retrieved_at
        `,
      );
      for (const asset of assets) {
        assetStmt.run({
          $id: asset.id,
          $conversationId: asset.conversationId,
          $sourceKind: asset.sourceKind,
          $path: assetFinalPathForDb(asset.sha256),
          $size: asset.size,
          $sha256: asset.sha256,
          $retrievedAt: asset.retrievedAt,
        });
      }

      if (unit.watermark !== undefined) {
        this.#db
          .prepare(
            `
            INSERT INTO watermark (unit_key, value, updated_at)
            VALUES ($unitKey, $value, $updatedAt)
            ON CONFLICT(unit_key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at
            `,
          )
          .run({
            $unitKey: unit.watermark.unitKey,
            $value: unit.watermark.value,
            $updatedAt: new Date().toISOString(),
          });
      }

      this.#db
        .prepare(
          `
          INSERT INTO event (at, verb, phase, kind, payload)
          VALUES ($at, $verb, $phase, $kind, $payload)
          `,
        )
        .run({
          $at: new Date().toISOString(),
          $verb: unit.phase,
          $phase: unit.phase,
          $kind: "unit_committed",
          $payload: canonicalJson(eventPayload),
        });

      const facetStmt = this.#db.prepare(
        `
        INSERT INTO projection_facet (phase, rev, code, kind, count)
        VALUES ($phase, $rev, $code, $kind, $count)
        ON CONFLICT(phase, rev, code) DO UPDATE SET
          kind = excluded.kind,
          count = count + excluded.count
        `,
      );
      for (const [key, entry] of facetCounts) {
        const [phase, rev, code] = key.split("\u0000") as [RowPhase, string, string];
        facetStmt.run({
          $phase: phase,
          $rev: Number(rev),
          $code: code,
          $kind: entry.kind,
          $count: entry.count,
        });
      }

      this.#db
        .prepare(
          `
          INSERT INTO projection_verb_state (verb, state, checkpoint, updated_at)
          VALUES ($verb, $state, $checkpoint, $updatedAt)
          ON CONFLICT(verb) DO UPDATE SET
            state = excluded.state,
            checkpoint = excluded.checkpoint,
            updated_at = excluded.updated_at
          `,
        )
        .run({
          $verb: unit.phase,
          $state: "current",
          $checkpoint: unit.checkpoint,
          $updatedAt: new Date().toISOString(),
        });

      if (unit.progress !== undefined) {
        this.#db
          .prepare(
            `
            INSERT INTO projection_progress (unit, done, total, updated_at)
            VALUES ($unit, $done, $total, $updatedAt)
            ON CONFLICT(unit) DO UPDATE SET
              done = excluded.done,
              total = excluded.total,
              updated_at = excluded.updated_at
            `,
          )
          .run({
            $unit: unit.progress.unit,
            $done: unit.progress.done,
            $total: unit.progress.total,
            $updatedAt: new Date().toISOString(),
          });
      }

      this.#db
        .prepare(
          "UPDATE job SET last_checkpoint = $checkpoint WHERE id = (SELECT id FROM job LIMIT 1)",
        )
        .run({ $checkpoint: unit.checkpoint });

      return { applied: true };
    });
  }

  rows(query: RowQuery): RowPage {
    const job = this.readJob();
    if (job === null) {
      throw new Error("job row missing");
    }

    const table = job.type === "file_migration" ? "item" : "conversation";
    const revision =
      query.revision ??
      (query.phase === "verify"
        ? (job.verificationRevision ?? job.planRevision)
        : (job.planRevision ?? job.verificationRevision));
    if (revision === null || revision === undefined) {
      return { facets: [], rows: [], nextCursor: null, totalRows: 0 };
    }

    const limit = clampLimit(query.limit);
    const sort = query.sort ?? "natural";
    const filters: string[] = ["rev = ?", "phase = ?"];
    const params: Array<string | number> = [revision, query.phase];

    if (query.codes !== undefined && query.codes.length > 0) {
      filters.push(`code IN (${query.codes.map(() => "?").join(",")})`);
      params.push(...query.codes);
    }

    let searchClause: { sql: string; params: string[] } | null = null;
    if (query.search !== undefined && query.search.length > 0) {
      searchClause =
        table === "item"
          ? buildSearchClause(
              ["id", "relative_path", "source_item_id", "mapping_id", "code", "kind"],
              query.search,
            )
          : buildSearchClause(
              ["id", "conversation_id", "scope_entry_id", "title", "code", "kind"],
              query.search,
            );
      filters.push(searchClause.sql);
      params.push(...searchClause.params);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const facetRows =
      query.search !== undefined || (query.codes !== undefined && query.codes.length > 0)
        ? this.#db
            .prepare(
              `SELECT code, kind, COUNT(*) AS count FROM ${table} ${where} GROUP BY code, kind ORDER BY code`,
            )
            .all(...params)
        : this.#db
            .prepare(
              "SELECT code, kind, count FROM projection_facet WHERE phase = ? AND rev = ? ORDER BY code",
            )
            .all(query.phase, revision);
    const facets = (
      facetRows as Array<{ code: string; kind: FacetCount["kind"]; count: number }>
    ).map((row) => ({
      code: row.code,
      kind: row.kind,
      count: Number(row.count),
    }));

    const countRow = this.#db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`)
      .get(...params) as { count?: number } | undefined;
    const totalRows = Number(countRow?.count ?? 0);

    let orderBy = "";
    let cursorClause = "";
    const cursorArgs: Array<string | number> = [];

    if (table === "item") {
      if (sort === "size") {
        orderBy = "ORDER BY (size IS NULL) ASC, size ASC, relative_path ASC, id ASC";
      } else {
        orderBy = "ORDER BY relative_path ASC, id ASC";
      }
      if (query.cursor !== undefined) {
        const decoded = decodeCursor(query.cursor);
        if (decoded.sort !== sort) {
          throw new Error("Cursor sort mismatch");
        }
        if (sort === "size") {
          cursorClause =
            decoded.bucket === 1
              ? "AND ((size IS NULL AND id > ?) )"
              : "AND ((size IS NULL) > ? OR ((size IS NULL) = ? AND (size > ? OR (size = ? AND id > ?))))";
          if (decoded.bucket === 1) {
            cursorArgs.push(decoded.id);
          } else {
            cursorArgs.push(
              decoded.bucket,
              decoded.bucket,
              Number(decoded.value),
              Number(decoded.value),
              decoded.id,
            );
          }
        } else {
          cursorClause = "AND ((relative_path > ?) OR (relative_path = ? AND id > ?))";
          cursorArgs.push(String(decoded.value), String(decoded.value), decoded.id);
        }
      }
    } else {
      if (sort === "size") {
        orderBy = "ORDER BY records ASC, assets ASC, conversation_id ASC, id ASC";
      } else {
        orderBy = "ORDER BY conversation_id ASC, id ASC";
      }
      if (query.cursor !== undefined) {
        const decoded = decodeCursor(query.cursor);
        if (decoded.sort !== sort) {
          throw new Error("Cursor sort mismatch");
        }
        if (sort === "size") {
          cursorClause =
            "AND ((records > ?) OR (records = ? AND (assets > ? OR (assets = ? AND id > ?))))";
          cursorArgs.push(
            Number(decoded.value),
            Number(decoded.value),
            Number(decoded.bucket),
            Number(decoded.bucket),
            decoded.id,
          );
        } else {
          cursorClause = "AND ((conversation_id > ?) OR (conversation_id = ? AND id > ?))";
          cursorArgs.push(String(decoded.value), String(decoded.value), decoded.id);
        }
      }
    }

    const rowSql = `${this.rowSelectSql(table)} ${where}${cursorClause ? ` ${cursorClause}` : ""} ${orderBy} LIMIT ?`;
    const rows = this.#db.prepare(rowSql).all(...params, ...cursorArgs, limit + 1) as Record<
      string,
      unknown
    >[];
    const pageRows = rows.slice(0, limit).map((row) => this.mapRow(table, row));
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const last = pageRows.at(-1);
      if (last !== undefined) {
        switch (last.jobType) {
          case "file_migration":
            nextCursor =
              sort === "size"
                ? encodeCursor({
                    sort,
                    bucket: last.size === null ? 1 : 0,
                    value: last.size,
                    id: last.id,
                  })
                : encodeCursor({ sort, bucket: 0, value: last.relativePath, id: last.id });
            break;
          case "teams_archive":
            nextCursor =
              sort === "size"
                ? encodeCursor({ sort, bucket: 0, value: last.records, id: last.id })
                : encodeCursor({ sort, bucket: 0, value: last.conversationId, id: last.id });
            break;
        }
      }
    }

    return { facets, rows: pageRows, nextCursor, totalRows };
  }

  appendEvent(e: {
    verb: Verb;
    phase: Verb;
    kind: EventKind;
    payload: Record<string, unknown>;
  }): number {
    const result = withTransaction(this.#db, () =>
      this.#db
        .prepare(
          "INSERT INTO event (at, verb, phase, kind, payload) VALUES ($at, $verb, $phase, $kind, $payload)",
        )
        .run({
          $at: new Date().toISOString(),
          $verb: e.verb,
          $phase: e.phase,
          $kind: e.kind,
          $payload: canonicalJson(e.payload),
        }),
    );
    return Number(result.lastInsertRowid);
  }

  events(query: {
    from?: number;
    follow?: boolean;
    signal?: AbortSignal;
  }): AsyncIterable<JobEvent> {
    const db = this.#db;
    const from = query.from ?? 0;
    const follow = query.follow ?? false;
    const signal = query.signal;

    const stream = async function* (): AsyncGenerator<JobEvent> {
      let cursor = from;
      for (;;) {
        if (signal?.aborted) {
          return;
        }
        const rows = db
          .prepare(
            "SELECT cursor, at, verb, phase, kind, payload FROM event WHERE cursor > ? ORDER BY cursor ASC",
          )
          .all(cursor) as Array<{
          cursor: number;
          at: string;
          verb: Verb;
          phase: Verb;
          kind: JobEvent["kind"];
          payload: string;
        }>;
        if (rows.length === 0) {
          if (!follow) {
            return;
          }
          await sleep(200, undefined, { signal }).catch(() => undefined);
          continue;
        }
        for (const row of rows) {
          cursor = row.cursor;
          yield {
            cursor: row.cursor,
            at: row.at,
            verb: row.verb,
            phase: row.phase,
            kind: row.kind,
            payload: parseJsonText(row.payload) as Record<string, unknown>,
          };
        }
        if (!follow) {
          return;
        }
      }
    };

    return stream();
  }

  status(): JobStatus {
    const job = this.readJob();
    if (job === null) {
      throw new Error("job row missing");
    }
    const lease = this.readLease();
    const verbStateRows = this.#db
      .prepare("SELECT verb, state, checkpoint FROM projection_verb_state ORDER BY verb")
      .all() as Array<{ verb: Verb; state: string; checkpoint: string | null }>;
    const verbStates = verbStatesFromRows(verbStateRows);
    const fallback = fallbackRailState(job.state);
    const rail = VERBS.map((verb) => ({
      verb,
      state: (verbStates[verb] ?? fallback[verb]) as JobStatus["rail"][number]["state"],
    }));
    const currentRevision = job.verificationRevision ?? job.planRevision ?? 0;
    const progress = readProgressRow(this.#db);
    const lastCheckpoint = job.lastCheckpoint ?? lease?.lastCheckpoint ?? null;

    let planDigest: string | null = null;
    if (job.planRevision !== null) {
      const plan = readPlanRevisionRow(this.#db, job.planRevision);
      planDigest = plan?.planDigest ?? null;
    }
    let verificationDigest: string | null = null;
    if (job.verificationRevision !== null) {
      const verification = readVerificationRevisionRow(this.#db, job.verificationRevision);
      verificationDigest = verification?.verificationDigest ?? null;
    }

    return {
      jobId: job.id,
      jobType: job.type,
      state: job.state,
      schemaVersion: job.schemaVersion,
      rail,
      ownership: {
        held: lease !== null,
        heldByThisProcess: false,
        hostId: lease?.hostId ?? null,
        pid: lease?.pid ?? null,
        heartbeatAt: lease?.heartbeatAt ?? null,
        kind: lease?.kind ?? null,
      },
      planRevision: job.planRevision,
      planDigest,
      verificationDigest,
      progress,
      lastCheckpoint,
      outstandingFindings: readOutstandingFindings(this.#db, currentRevision),
    };
  }

  rowSelectSql(table: "item" | "conversation"): string {
    if (table === "item") {
      return `
        SELECT
          id, rev, phase, code, kind, accepted, mapping_id, source_item_id, relative_path,
          item_type, size, dest_file_id, provenance_state
        FROM item
      `;
    }
    return `
      SELECT
        id, rev, phase, code, kind, accepted, scope_entry_id, conversation_id, title, records, assets, watermark
      FROM conversation
    `;
  }

  mapRow(table: "item" | "conversation", row: Record<string, unknown>): Row {
    if (table === "item") {
      return {
        jobType: "file_migration",
        id: String(row.id),
        code: String(row.code),
        kind: row.kind as Row["kind"],
        phase: row.phase as RowPhase,
        revision: Number(row.rev),
        accepted: rowKindFromAccepted(row.accepted),
        mappingId: String(row.mapping_id),
        sourceItemId: String(row.source_item_id),
        relativePath: String(row.relative_path),
        size: row.size === null || row.size === undefined ? null : Number(row.size),
        destinationFileId:
          row.dest_file_id === null || row.dest_file_id === undefined
            ? null
            : String(row.dest_file_id),
        provenanceState:
          (row.provenance_state as "none" | "marked" | "verified" | "drifted" | null | undefined) ??
          "none",
      };
    }
    return {
      jobType: "teams_archive",
      id: String(row.id),
      code: String(row.code),
      kind: row.kind as Row["kind"],
      phase: row.phase as RowPhase,
      revision: Number(row.rev),
      accepted: rowKindFromAccepted(row.accepted),
      scopeEntryId: String(row.scope_entry_id),
      conversationId: String(row.conversation_id),
      records: Number(row.records),
      assets: Number(row.assets),
      watermark:
        row.watermark === null || row.watermark === undefined ? null : String(row.watermark),
    };
  }
}

function inspectUnsupportedVersion(dbPathValue: string): number | null {
  if (!existsSync(dbPathValue)) {
    return null;
  }
  const db = new DatabaseSync(dbPathValue, {
    open: true,
    readOnly: true,
    enableForeignKeyConstraints: true,
  });
  try {
    setPragmas(db, false);
    return readJobSchemaVersion(db);
  } finally {
    db.close();
  }
}

function createWritableStore(
  dbPathValue: string,
  jobDir: string,
  migmateVersion: string,
  now: () => Date,
): Store {
  const db = new DatabaseSync(dbPathValue, { open: true, enableForeignKeyConstraints: true });
  try {
    setPragmas(db, true);
    if (!tableExists(db, "job")) {
      insertSchema(db);
    } else {
      const schemaVersion = readJobSchemaVersion(db);
      if (schemaVersion !== null && schemaVersion < SCHEMA_VERSION) {
        withTransaction(db, () => {
          migrateSchemaVersion1(db);
        });
      }
    }
    return new StoreImpl(db, jobDir);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Best-effort cleanup for a failed open.
    }
    throw error;
  }
}

export function openStore(
  jobDir: string,
  opts: { migmateVersion: string; now: () => Date },
): Outcome<Store> {
  ensureJobTree(jobDir);
  const dbPathValue = dbPath(jobDir);
  const unsupported = inspectUnsupportedVersion(dbPathValue);
  if (unsupported !== null && unsupported > SCHEMA_VERSION) {
    return refuse(
      "state_version_unsupported",
      `job schema version ${unsupported} is newer than this Migmate`,
      {
        detail: { schemaVersion: unsupported, currentVersion: SCHEMA_VERSION },
      },
    );
  }

  const store = createWritableStore(dbPathValue, jobDir, opts.migmateVersion, opts.now);
  return ok(store);
}
