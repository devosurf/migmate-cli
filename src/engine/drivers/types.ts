import type {
  CheckResult,
  CreatedDrive,
  MemberGrant,
  MappingPass,
  GoLiveAcknowledgment,
} from "../types.ts";
import type { ProviderPort } from "../providers/port.ts";

import type { CommitFinding, CommitRow, CommitUnit } from "../commit.ts";
import type { ArchiveResumeState } from "../providers/archive.ts";
import type { ReportArray, ReportText } from "../report.ts";
import type { UploadAttempt } from "../store/uploads.ts";

export type {
  CommitFinding,
  CommitRow,
  CommitUnit,
  ConversationCommitRow,
  DurableAsset,
  FileCommitRow,
} from "../commit.ts";

/** Which lifecycle phase a commit unit belongs to. Doubles as the unit-key suffix. */
export type AttemptClass = "plan" | "execute" | "verify";

export interface DriverResumeState extends ArchiveResumeState {
  checkpoint: string | null;
  watermarks: Record<string, string>;
  rows?: CommitRow[];
  mappingPasses?: MappingPass[];
  createdDrives?: CreatedDrive[];
  memberGrants?: MemberGrant[];
  goLiveAcknowledgments?: GoLiveAcknowledgment[];
  goLiveAuthorityDigest?: string;
}

export interface DriverContext<Cfg> {
  jobDirectory: string;
  config: Cfg;
  revision: number;
  stage?: "prestage" | "delta" | "final";
  /** Observed in preflight and retained in the plan, never refreshed while reporting. */
  actingGoogleAccount?: string;
  /** Account belongs to this attempt, so each approved pool account uses the same ledger. */
  beginUpload?: (
    source: "file" | "teams",
    identity: string,
    account: string | undefined,
  ) => UploadAttempt;
  resume: DriverResumeState;
  reportEvidence?: {
    settled(mappingId: string): unknown;
    sourcePlanning(mappingId: string): {
      sourceObservation?: Record<string, unknown>;
      sourceDisclosures?: readonly string[];
    } | undefined;
    coverage: ReportArray;
  };
  provider: ProviderPort;
  now: () => Date;
  signal?: AbortSignal;
  waitForConsistency?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface ReportSection {
  title: string;
  body: string | ReportText;
  format: "markdown" | "text";
}

export interface JobTypeDriver<Cfg> {
  preflight(ctx: DriverContext<Cfg>): AsyncIterable<CheckResult>;
  collect(ctx: DriverContext<Cfg>): AsyncIterable<CommitUnit>;
  execute(ctx: DriverContext<Cfg>): AsyncIterable<CommitUnit>;
  verify(ctx: DriverContext<Cfg>): AsyncIterable<CommitUnit>;
  reportSections(ctx: DriverContext<Cfg>): AsyncIterable<ReportSection>;
}
