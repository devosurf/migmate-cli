import type { CheckResult, Progress } from "../types.ts";
import type { ProviderPort } from "../providers/port.ts";

import type { CommitRow, CommitUnit } from "../commit.ts";

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

export interface DriverResumeState {
  checkpoint: string | null;
  watermarks: Record<string, string>;
}

export interface DriverContext<Cfg> {
  config: Cfg;
  revision: number;
  resume: DriverResumeState;
  provider: ProviderPort;
  now: () => Date;
  signal?: AbortSignal;
}

export interface ReportSection {
  title: string;
  body: string;
  format: "markdown" | "text";
}

export interface JobTypeDriver<Cfg> {
  preflight(ctx: DriverContext<Cfg>): AsyncIterable<CheckResult>;
  collect(ctx: DriverContext<Cfg>): AsyncIterable<CommitUnit>;
  execute(ctx: DriverContext<Cfg>): AsyncIterable<CommitUnit>;
  verify(ctx: DriverContext<Cfg>): AsyncIterable<CommitUnit>;
  reportSections(ctx: DriverContext<Cfg>): AsyncIterable<ReportSection>;
}
