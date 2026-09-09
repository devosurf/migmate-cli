import type {
  ExecuteResult,
  JobType,
  Outcome,
  Refusal,
  RowPage,
  RowQuery,
} from "../engine/types.ts";
import { CODE_BY_NAME } from "../engine/codes.ts";
import { VERBS } from "../engine/types.ts";
import { EXIT_CODE_BY_REFUSAL_CODE, exitCodeForRefusalCode } from "./exit-codes.ts";

export const SCHEMA_VERSION = 1 as const;
export interface JobEnvelope {
  id: string;
  type: JobType | null;
}
export type AdapterOutcome<T = unknown> =
  | Outcome<T>
  | {
      ok: false;
      refusal: Omit<Refusal, "code"> & { code: string };
    };

export function buildReviewEnvelope(query: RowQuery, page: RowPage) {
  return { query: { ...query, cursor: query.cursor ?? null }, ...page };
}

export function terminalEnvelopeForExecute(result: ExecuteResult) {
  return { ...result, state: result.outcome };
}

const enums: Record<string, readonly unknown[]> = {
  ok: [true, false],
  resumable: [true, false],
  workerStatus: ["alive", "absent", "unknown"],
  jobType: ["file_migration", "teams_archive"],
  phase: VERBS,
  verb: VERBS,
  kind: [
    "policy_outcome",
    "planned_omission",
    "finding",
    "refusal",
    "phase_started",
    "phase_completed",
    "check_result",
    "unit_committed",
    "progress",
    "terminal",
    "cli",
    "web",
    null,
  ],
  state: [
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
    "completed",
    "pending",
    "done",
    "current",
    "checkpoint",
  ],
  terminalState: ["completed", "interrupted", "blocked", "cancelled", null],
  outcome: [
    "completed",
    "interrupted",
    "blocked",
    "cancelled",
    "completed_with_accepted_exceptions",
  ],
  mode: ["interactive", "unattended"],
  format: ["json", "jsonl", "html", "csv"],
  unit: ["bytes", "items", "records", "assets", "conversations"],
  status: ["pass", "fail", "skip"],
};
// Inspect only contract-bearing members. Arbitrary provider evidence, prose, and
// code-specific detail are not new enum namespaces for the adapter to interpret.
export function knownContract(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(knownContract);
  if (!value || typeof value !== "object") return true;
  const object = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(object)) {
    if (
      key === "code" &&
      (typeof entry !== "string" ||
        (!Object.hasOwn(CODE_BY_NAME, entry) && !Object.hasOwn(EXIT_CODE_BY_REFUSAL_CODE, entry)))
    )
      return false;
    if (Object.hasOwn(enums, key) && !enums[key]!.includes(entry)) return false;
    if (
      [
        "value",
        "payload",
        "review",
        "rows",
        "facets",
        "checks",
        "findings",
        "outstandingFindings",
        "rail",
        "ownership",
        "progress",
        "artifacts",
        "refusal",
        "currentPlan",
        "plan",
      ].includes(key) &&
      !knownContract(entry)
    )
      return false;
    if (
      ["acceptedCodes", "acceptedExceptions"].includes(key) &&
      Array.isArray(entry) &&
      entry.some((code) => typeof code !== "string" || !Object.hasOwn(CODE_BY_NAME, code))
    )
      return false;
  }
  return true;
}

export function outcomeExit(command: string, outcome: AdapterOutcome): number {
  if (!knownContract(outcome)) return 1;
  if (!outcome.ok) return exitCodeForRefusalCode(outcome.refusal.code);
  if (command === "execute") {
    const result = outcome.value as ExecuteResult;
    switch (result.outcome) {
      case "completed":
        return 0;
      case "interrupted":
        return 130;
      case "blocked":
        return 5;
      default:
        return 1;
    }
  }
  return 0;
}
