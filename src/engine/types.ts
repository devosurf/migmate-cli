/**
 * Engine vocabulary. Internal to the package: nothing here is exported from
 * `package.json`, and these types carry no stability promise in 0.x. The stable
 * contracts are the code registry, the exit-code table, and the CLI envelope.
 */

import type { CopyPassStats, DriveMember } from "./providers/port.ts";
import type { FileMappingConfig } from "./drivers/file-migration.ts";

export interface UploadQuotaStop {
  code: "upload_quota_exceeded";
  /** Time Migmate first observed the failed upload pass. */
  hitAt: string;
  /** Null only for older plans that did not record a non-impersonated account. */
  actingGoogleAccount: string | null;
  earliestResumeAt: string;
  resumeTimeIsEstimate: true;
}

export interface MappingPass {
  revision: number;
  mappingId: string;
  passNumber: number;
  mode: "copy" | "mirror";
  executeId: string | null;
  jobid: number | null;
  group: string | null;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
  startedAt: string | null;
  endedAt: string | null;
  lastStats:
    | (Omit<CopyPassStats, "errors"> & {
        /** Unknown when rclone's aggregate includes upload-quota errors. */
        errors: number | null;
        rcloneErrors?: number;
      })
    | null;
  error: string | null;
  uploadQuota?: UploadQuotaStop;
}

export interface GoLiveCheck {
  at: string;
  status: "passed" | "failed";
  check:
    | "drive_membership_mismatch"
    | "destination_drift"
    | "go_live_check_unavailable"
    | "membership_and_destination"
    | "destination"
    | "membership";
  evidence: Record<string, unknown>;
}

export interface CreatedDrive {
  mappingId: string;
  requestId: string;
  name: string;
  driveId: string | null;
  creatorEmail: string;
  /** Absent on schema-5 records written before creation provenance was recorded. */
  intentAt?: string;
  provenance?: { kind: "create_response" } | { kind: "name_recovery"; createdTime: string };
  /** Irreversible job-local transfer fence, committed before deferred access starts. */
  goLive?: {
    startedAt: string;
    revision: number;
    verificationAt: string;
    check?: GoLiveCheck;
    /**
     * Already-live drives without passed pre-grant proof whose membership check failed
     * before observing content: the separately finished original-baseline content check.
     */
    destinationCheck?: GoLiveCheck;
  };
  /** Point-in-time destination proof before this batch's first fence or grant. */
  preGrantCheck?: {
    revision: number;
    verificationAt: string;
    check: GoLiveCheck;
  };
  /** Listing observed by the latest verification; never rebased once go-live starts. */
  verifiedDestination?: {
    revision: number;
    hashType: "sha256" | "quickxor";
    md5: boolean;
    digest: string;
  };
}
export interface MemberGrant {
  mappingId: string;
  driveId: string;
  member: DriveMember;
  /** Present for grants observed at deferred go-live, after verification. */
  at?: string;
}

export const JOB_TYPES = ["file_migration", "teams_archive"] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** The ten durable job states. `closed` and `cancelled` are absorbing. */
export const JOB_STATES = [
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
export type JobState = (typeof JOB_STATES)[number];

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
  | "configuration_invalid"
  | "job_not_found"
  | "local_filesystem_required"
  | "retry_budget_exhausted"
  | "lease_held"
  | "lease_stale_worker_alive"
  | "foreign_host"
  | "preflight_failed"
  | "approval_required"
  | "approval_digest_stale"
  | "plan_revision_required"
  | "cutover_incomplete"
  | "delete_limit_exceeded"
  | "unsupported_route"
  | "drive_creation_ambiguous"
  | "go_live_started"
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
  /** Operator configuration validated as safe typed references before persistence. */
  config?: unknown;
}

/** Safe ownership facts. Worker process identifiers and addresses remain internal. */
export interface RecoveryReport {
  workerAlive: boolean;
  workerStatus?: WorkerStatus;
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
  lastCheckpoint: string | null;
  reclaimable: boolean;
}
export const WORKER_STATUSES = ["alive", "absent", "unknown"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const PROGRESS_UNITS = ["bytes", "items", "records", "assets", "conversations"] as const;
export type ProgressUnit = (typeof PROGRESS_UNITS)[number];

export interface Progress {
  unit: ProgressUnit;
  done: number;
  /** Null until a denominator exists. No caller may compute a percentage from null. */
  total: number | null;
}

export const EVENT_KINDS = [
  "phase_started",
  "phase_completed",
  "check_result",
  "unit_committed",
  "progress",
  "mapping_progress",
  "refusal",
  "terminal",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface JobEvent {
  /** Durable row id: monotonic, gap-free, resumable. */
  cursor: number;
  at: string;
  verb: Verb;
  phase: Verb;
  kind: EventKind;
  payload: Record<string, unknown>;
}

export const EXECUTION_TERMINAL_STATES = [
  "completed",
  "interrupted",
  "blocked",
  "cancelled",
] as const;
export type TerminalState = (typeof EXECUTION_TERMINAL_STATES)[number];

export interface ExecuteResult {
  outcome: "completed" | "interrupted" | "blocked";
  resumable: boolean;
  checkpoint: string | null;
  committedUnits: number;
  /** Populated when the run stopped in `blocked`. */
  budget?: { failedAttempts: number; failedUnitRatio: number };
  uploadQuota?: UploadQuotaStop;
}

export interface CheckResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  /** Registry code for a failure or a recorded unavailable probe. */
  code?: string;
  /** Redacted by construction: identities and outcomes only, never secrets. */
  evidence: Record<string, unknown>;
}

export interface PreflightReport {
  passed: boolean;
  checks: CheckResult[];
}

export interface PlanRevision {
  stage?: "prestage" | "delta" | "final";
  revision: number;
  planDigest: string;
  inputsDigest: string;
  createdAt: string;
  rowCount: number;
  manifestDigest?: string;
  disclosures: string[];
  sections: { id: string; title: string; body: string }[];
  review?: RowPage;
}

export interface ApprovalRecord {
  revision: number;
  approvalDigest: string;
  planDigest: string;
  approver: string;
  mode: "interactive" | "unattended";
  identityAssurance: "declared_unverified";
  riskConfirmations?: { mirror?: boolean; access?: boolean };
  at: string;
  freeze?: { by: string; at: string; how: string };
}

export interface AcceptedException {
  verificationDigest: string;
  code: string;
  approver: string;
  mode: "interactive" | "unattended" | "legacy_unknown";
  identityAssurance: "declared_unverified";
  note: string;
  at: string;
}

export interface CloseAuthorization {
  evidenceDigest: string;
  approver: string;
  mode: "interactive" | "unattended";
  identityAssurance: "declared_unverified";
  at: string;
}

export interface GoLiveFailure {
  mappingId: string;
  driveId: string;
  startedAt: string;
  revision: number;
  verificationAt: string;
  check: GoLiveCheck;
  consequence: string;
}

export interface GoLiveReview {
  evidenceDigest: string;
  authorityDigest: string;
  checks: GoLiveFailure[];
}

export interface GoLiveAcknowledgment extends GoLiveReview {
  rationale: string;
  approver: string;
  mode: "interactive" | "unattended";
  identityAssurance: "declared_unverified";
  at: string;
}

export interface ApprovalAuthority {
  mirrorChanges: {
    mappingId: string;
    source: string;
    destination: string;
    deleteLimit: number;
    previousDeleteLimit: number | null;
  }[];
  accessChanges: {
    mappingId: string;
    email: string;
    type: string;
    role: string;
    previousRole: string | null;
    timing: string;
  }[];
}

export interface VerificationRevision {
  revision: number;
  verificationDigest: string;
  evidenceDigest?: string;
  clean: boolean;
  findings: FacetCount[];
  acceptedCodes: string[];
  at: string;
}

export interface Artifact {
  name: string;
  format: "jsonl" | "html" | "json" | "csv";
  path: string;
  digest: string;
}

export interface ArtifactSet {
  reportDigest: string | null;
  artifacts: Artifact[];
}

export const CLOSURE_OUTCOMES = [
  "completed",
  "completed_with_accepted_exceptions",
  "cancelled",
] as const;
export type ClosureOutcome = (typeof CLOSURE_OUTCOMES)[number];
export interface Closure {
  state: "closed" | "cancelled";
  at: string;
  acceptedExceptions: string[];
  goLiveAcknowledgments?: GoLiveAcknowledgment[];
  outcome?: ClosureOutcome;
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
  sourceWebUrl: string | null;
  sourcePackageSections: number | null;
  omissionReason: string | null;
  nextStep: string | null;
  relativePath: string;
  size: number | null;
  destinationFileId: string | null;
  provenanceState: "none" | "marked" | "verified" | "drifted";
  mapping?: FileMappingConfig;
  mappingPass?: MappingPass;
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
  view?: "items" | "mappings";
  mappingId?: string;
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

export const VERB_STATES = ["pending", "done", "current", "blocked", "checkpoint"] as const;
export type VerbState = (typeof VERB_STATES)[number];

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
  currentPlan: PlanRevision | null;
  lastInteractiveIdentity?: string | null;
  currentApproval?: ApprovalRecord | null;
  approvalAuthority?: ApprovalAuthority;
  exceptionGroups?: {
    code: string;
    consequence: string;
    count: number;
    examples: string[];
    acceptable: boolean;
    accepted: boolean;
  }[];
  acceptedExceptions?: AcceptedException[];
  closeReview?: { evidenceDigest: string; consequences: string[]; authorized: boolean } | null;
  closeAuthorization?: CloseAuthorization | null;
  goLiveReview?: GoLiveReview | null;
  goLiveAcknowledgments?: GoLiveAcknowledgment[];
  verificationDigest: string | null;
  progress: Progress | null;
  mappingPasses: MappingPass[];
  createdDrives: CreatedDrive[];
  memberGrants: MemberGrant[];
  /** Durable deferred go-live has begun, but close has not completed. */
  incompleteClose?: {
    accessMayExist: true;
    transfersFenced: true;
    checksPassed: boolean;
    /** Failed/unavailable checks remain failed, even when explicitly acknowledged. */
    checksSettled?: boolean;
    reporting: "unfinished" | "complete";
    nextAction: "close";
  };
  lastCheckpoint: string | null;
  outstandingFindings: FacetCount[];
  worker: { active: boolean; group: string | null };
  resumable: boolean;
  terminalState: TerminalState | null;
  closureOutcome?: ClosureOutcome;
  archiveProgress?: {
    conversations: number;
    totalConversations: number;
    records: number;
    totalRecords: number | null;
    assets: number;
    bytes: number;
  };
}
