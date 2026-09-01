/**
 * Engine vocabulary. Internal to the package: nothing here is exported from
 * `package.json`, and these types carry no stability promise in 0.x. The stable
 * contracts are the code registry, the exit-code table, and the CLI envelope.
 */

export type JobType = "file_migration" | "teams_archive";

/** The ten durable job states. `closed` and `cancelled` are absorbing. */
export type JobState =
  | "new"
  | "planned"
  | "approved"
  | "executing"
  | "interrupted"
  | "blocked"
  | "needs_attention"
  | "verified"
  | "closed"
  | "cancelled";

export const TERMINAL_STATES = ["closed", "cancelled"] as const;

/** The ten lifecycle verbs, in rail order. */
export type Verb =
  | "init"
  | "doctor"
  | "plan"
  | "approve"
  | "execute"
  | "status"
  | "verify"
  | "report"
  | "close"
  | "cancel";

export const VERBS: readonly Verb[] = [
  "init",
  "doctor",
  "plan",
  "approve",
  "execute",
  "status",
  "verify",
  "report",
  "close",
  "cancel",
];

/** Phases that produce rows. Preflight produces check results, not rows. */
export type RowPhase = "plan" | "execute" | "verify";

export type CodeKind = "policy_outcome" | "planned_omission" | "finding";

export type RefusalCode =
  | "lease_held"
  | "lease_stale_worker_alive"
  | "foreign_host"
  | "preflight_failed"
  | "approval_required"
  | "approval_digest_stale"
  | "plan_revision_required"
  | "unqualified_route"
  | "verification_unaccepted"
  | "job_closed"
  | "job_cancelled"
  | "state_version_unsupported";

export interface Refusal {
  /** Stable string. The contract. Never a message. */
  code: RefusalCode;
  /** Human sentence. Never parsed by any caller. */
  message: string;
  /** Code-specific structured data. */
  detail?: Record<string, unknown>;
  /** Present on the three lease refusals. */
  recovery?: RecoveryReport;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export function ok<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

export function refuse<T>(
  code: RefusalCode,
  message: string,
  extra?: { detail?: Record<string, unknown>; recovery?: RecoveryReport },
): Outcome<T> {
  const refusal: Refusal = { code, message };
  if (extra?.detail !== undefined) refusal.detail = extra.detail;
  if (extra?.recovery !== undefined) refusal.recovery = extra.recovery;
  return { ok: false, refusal };
}

export interface JobRef {
  id: string;
}

export interface JobSpec {
  type: JobType;
  /** Operator-facing label. Never an identifier. */
  label?: string;
  /**
   * Operator-authored job configuration, persisted verbatim beside the job's
   * state and validated at the engine boundary before any driver sees it.
   */
  config?: unknown;
}

/**
 * Everything the three lease refusals must be able to render. The socket path and
 * worker pid are engine-internal: the CLI redacts both before they reach any
 * output surface.
 */
export interface RecoveryReport {
  workerAlive: boolean;
  recordedHostId: string;
  thisHostId: string;
  holder: {
    ownerUuid: string;
    pid: number;
    processStartTime: number;
    heartbeatAt: string;
    heartbeatAgeMs: number;
    kind: "cli" | "web";
  } | null;
  workerGroup: string | null;
  /** Redacted before output. */
  socketProbed: string | null;
  /** Redacted before output. */
  workerPid: number | null;
  lastCheckpoint: string | null;
  reclaimable: boolean;
}

export type ProgressUnit = "bytes" | "items" | "records" | "assets" | "conversations";

export interface Progress {
  unit: ProgressUnit;
  done: number;
  /** Null until a denominator exists. No caller may compute a percentage from null. */
  total: number | null;
}

export type EventKind =
  | "phase_started"
  | "phase_completed"
  | "check_result"
  | "unit_committed"
  | "progress"
  | "refusal"
  | "terminal";

export interface JobEvent {
  /** Durable row id: monotonic, gap-free, resumable. */
  cursor: number;
  at: string;
  verb: Verb;
  phase: Verb;
  kind: EventKind;
  payload: Record<string, unknown>;
}

export type TerminalState = "completed" | "interrupted" | "blocked" | "cancelled";

export interface ExecuteResult {
  outcome: "completed" | "interrupted" | "blocked";
  checkpoint: string | null;
  committedUnits: number;
  /** Populated when the run stopped in `blocked`. */
  budget?: { failedAttempts: number; failedUnitRatio: number };
}

export interface CheckResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  /** Present on failure; a code from the registry. */
  code?: string;
  /** Redacted by construction: identities and outcomes only, never secrets. */
  evidence: Record<string, unknown>;
}

export interface PreflightReport {
  passed: boolean;
  checks: CheckResult[];
}

export interface PlanRevision {
  revision: number;
  planDigest: string;
  inputsDigest: string;
  createdAt: string;
  sourceInventoryAt: string;
  rowCount: number;
}

export interface ApprovalRecord {
  revision: number;
  planDigest: string;
  approver: string;
  mode: "interactive" | "unattended";
  at: string;
}

export interface AcceptedException {
  code: string;
  note?: string;
}

export interface VerificationRevision {
  revision: number;
  verificationDigest: string;
  clean: boolean;
  findings: FacetCount[];
  acceptedCodes: string[];
  at: string;
}

export interface Artifact {
  name: string;
  format: "jsonl" | "html" | "json";
  path: string;
  digest: string;
}

export interface ArtifactSet {
  reportDigest: string | null;
  artifacts: Artifact[];
}

export interface Closure {
  state: "closed" | "cancelled";
  at: string;
  acceptedExceptions: string[];
  reason?: string;
}

export interface FacetCount {
  code: string;
  kind: CodeKind;
  count: number;
}

interface RowBase {
  /** Stable within a job and revision. */
  id: string;
  code: string;
  kind: CodeKind;
  phase: RowPhase;
  revision: number;
  /** True once an operator accepted this row's code against a verification digest. */
  accepted: boolean;
}

export interface FileItemRow extends RowBase {
  jobType: "file_migration";
  mappingId: string;
  sourceItemId: string;
  relativePath: string;
  size: number | null;
  destinationFileId: string | null;
  provenanceState: "none" | "marked" | "verified" | "drifted";
}

export interface ConversationRow extends RowBase {
  jobType: "teams_archive";
  scopeEntryId: string;
  conversationId: string;
  records: number;
  assets: number;
  watermark: string | null;
}

export type Row = FileItemRow | ConversationRow;

export interface RowQuery {
  revision?: number;
  phase: RowPhase;
  codes?: string[];
  search?: string;
  cursor?: string;
  limit?: number;
  sort?: "natural" | "path" | "size";
}

export interface RowPage {
  /** Always over the whole matching set, never the page. */
  facets: FacetCount[];
  rows: Row[];
  nextCursor: string | null;
  totalRows: number;
}

export type VerbState = "pending" | "done" | "current" | "blocked" | "checkpoint";

export interface JobStatus {
  jobId: string;
  jobType: JobType;
  state: JobState;
  schemaVersion: number;
  rail: { verb: Verb; state: VerbState }[];
  ownership: {
    held: boolean;
    heldByThisProcess: boolean;
    hostId: string | null;
    pid: number | null;
    heartbeatAt: string | null;
    kind: "cli" | "web" | null;
  };
  planRevision: number | null;
  planDigest: string | null;
  verificationDigest: string | null;
  progress: Progress | null;
  lastCheckpoint: string | null;
  outstandingFindings: FacetCount[];
}
