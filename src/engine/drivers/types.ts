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
  verificationBaseline?: {
    revision: number;
    rows: CommitRow[];
    findings: CommitFinding[];
    acceptedCodes: string[];
  };
  resume: DriverResumeState;
  reportEvidence?: {
    settled(mappingId: string): unknown;
    preview(mappingId: string): { value: unknown; byteTotals: unknown } | undefined;
    coverage: ReportArray;
    sourceMetadata: ReportArray;
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
