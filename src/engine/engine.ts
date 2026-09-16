/**
 * The seam. Both adapters — CLI and webview — link this in-process. There is no
 * RPC, no serialization hop, and no service to version-skew against.
 *
 * The writer/reader split is the load-bearing decision: a `JobWriter` cannot be
 * obtained except inside `withWriter`, which acquires the lease bound to
 * (hostId, pid, processStartTime), heartbeats it for the callback's lifetime, and
 * releases it on every exit path including throw. A `JobReader` has no acquisition
 * step at all, so a second shell reading `status` while the first executes is the
 * only thing this interface permits.
 */

import type {
  AcceptedException,
  ApprovalRecord,
  ArtifactSet,
  Closure,
  ExecuteResult,
  JobEvent,
  JobRef,
  JobSpec,
  JobStatus,
  Outcome,
  PlanRevision,
  PreflightReport,
  RecoveryReport,
  RowPage,
  RowQuery,
  VerificationRevision,
} from "./types.ts";

export interface EngineOptions {
  /** Engine home. Holds the host identity file and one job folder per job. */
  home: string;
  now?: () => Date;
  /** Which adapter opened the engine. Recorded on the lease. */
  adapter?: "cli" | "web";
}

export interface ExecuteOptions {
  /** Interrupt, never cancellation: aborting stops at the next commit boundary. */
  signal?: AbortSignal;
}

export interface ReclaimDecision {
  /** Acknowledges the recovery report; a reclaim is an explicit operator act. */
  confirm: true;
  /** Stop and terminate a worker that still answers on the recorded run socket. */
  stopWorker?: boolean;
}

export interface Engine {
  initJob(spec: JobSpec): Promise<Outcome<JobRef>>;
  /** Never takes the lease. */
  reader(ref: JobRef): JobReader;
  withWriter<T>(ref: JobRef, fn: (w: JobWriter) => Promise<T>): Promise<Outcome<T>>;
  /**
   * The form every adapter wants: a lease refusal and a verb refusal collapse into
   * one envelope. Nesting them makes a refused verb look like a successful call,
   * which is how a caller ends up reporting exit 0 for a job that refused.
   */
  withWriterResult<T>(ref: JobRef, fn: (w: JobWriter) => Promise<Outcome<T>>): Promise<Outcome<T>>;
  reclaim(ref: JobRef, decision: ReclaimDecision): Promise<Outcome<RecoveryReport>>;
  close(): void;
}

/** Exists only inside `withWriter`, where the lease is provably held. */
export interface JobWriter {
  /** Validate and persist typed references, then immediately run the proof probes. */
  onboard(config: unknown): Promise<Outcome<PreflightReport>>;
  doctor(): Promise<Outcome<PreflightReport>>;
  plan(): Promise<Outcome<PlanRevision>>;
  approve(a: {
    approver: string;
    planDigest: string;
    mode: "interactive" | "unattended";
  }): Promise<Outcome<ApprovalRecord>>;
  execute(opts?: ExecuteOptions): Promise<Outcome<ExecuteResult>>;
  verify(): Promise<Outcome<VerificationRevision>>;
  accept(x: {
    verificationDigest: string;
    codes: AcceptedException[];
    approver: string;
  }): Promise<Outcome<VerificationRevision>>;
  report(): Promise<Outcome<ArtifactSet>>;
  close(): Promise<Outcome<Closure>>;
  cancel(reason: string): Promise<Outcome<Closure>>;
}

/** Concurrent, cross-process, lease-free, read-only. */
export interface JobReader {
  status(): Promise<Outcome<JobStatus>>;
  rows(q: RowQuery): Promise<Outcome<RowPage>>;
  events(q: { from?: number; follow?: boolean; signal?: AbortSignal }): AsyncIterable<JobEvent>;
  artifacts(): Promise<Outcome<ArtifactSet>>;
}
