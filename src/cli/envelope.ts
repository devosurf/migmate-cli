import type {
  ArtifactSet,
  CheckResult,
  ExecuteResult,
  EventKind,
  JobEvent,
  JobState,
  JobType,
  Progress,
  Refusal,
  Row,
  RowPage,
  RowQuery,
  TerminalState,
  Verb,
} from "../engine/types.ts";

export const SCHEMA_VERSION = 1 as const;

export type OutputMode = "text" | "json" | "jsonl";
export type CommandName = Verb | "accept" | "reclaim" | "web";

export interface JobEnvelope {
  id: string;
  type: JobType;
}

export interface JsonEnvelope<T> {
  schemaVersion: typeof SCHEMA_VERSION;
  command: CommandName;
  commandId: string;
  job: JobEnvelope;
  ok: true;
  value: T;
}

export interface RefusalEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  command: CommandName;
  commandId: string;
  job: JobEnvelope;
  ok: false;
  refusal: Refusal;
}

export type CommandEnvelope<T> = JsonEnvelope<T> | RefusalEnvelope;

export interface ReviewEnvelope {
  query: RowQuery;
  facets: RowPage["facets"];
  rows: Row[];
  nextCursor: string | null;
  totalRows: number;
}

export interface EventEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  command: CommandName;
  commandId: string;
  job: JobEnvelope;
  cursor: number;
  at: string;
  verb: Verb;
  phase: Verb;
  kind: EventKind;
  payload: Record<string, unknown>;
}

export interface TerminalEnvelope {
  state: TerminalState;
  resumable: boolean;
  checkpoint: string | null;
  committedUnits?: number;
  budget?: { failedAttempts: number; failedUnitRatio: number };
}

export interface ExecuteEnvelope {
  outcome: ExecuteResult["outcome"];
  checkpoint: string | null;
  committedUnits: number;
  budget?: ExecuteResult["budget"];
  terminal: TerminalEnvelope;
}

export interface JsonlEventEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  command: CommandName;
  commandId: string;
  job: JobEnvelope;
  cursor: number;
  at: string;
  verb: Verb;
  phase: Verb;
  kind: EventKind;
  payload: Record<string, unknown>;
}

export function terminalEnvelopeForExecute(result: ExecuteResult): TerminalEnvelope {
  if (result.outcome === "completed") {
    return { state: "completed", resumable: false, checkpoint: result.checkpoint };
  }

  if (result.outcome === "blocked") {
    const envelope: TerminalEnvelope = {
      state: "blocked",
      resumable: true,
      checkpoint: result.checkpoint,
      committedUnits: result.committedUnits,
    };
    if (result.budget !== undefined) {
      envelope.budget = result.budget;
    }
    return envelope;
  }

  return {
    state: "interrupted",
    resumable: true,
    checkpoint: result.checkpoint,
    committedUnits: result.committedUnits,
  };
}

export function buildReviewEnvelope(query: RowQuery, page: RowPage): ReviewEnvelope {
  return {
    query,
    facets: page.facets,
    rows: page.rows,
    nextCursor: page.nextCursor,
    totalRows: page.totalRows,
  };
}

export function terminalStateFromJobState(state: JobState): TerminalState | null {
  if (state === "closed") return "completed";
  if (state === "cancelled") return "cancelled";
  return null;
}

export function attachEventEnvelope(
  base: Omit<EventEnvelope, "payload">,
  payload: Record<string, unknown>,
): EventEnvelope {
  return { ...base, payload };
}

export function jsonlEnvelopeFromEvent(
  event: JobEvent,
  base: Omit<JsonlEventEnvelope, "payload">,
): JsonlEventEnvelope {
  return { ...base, payload: event.payload };
}

export function isProgressPayload(payload: unknown): payload is Progress {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "unit" in payload &&
    "done" in payload &&
    "total" in payload &&
    typeof payload.unit === "string" &&
    typeof payload.done === "number" &&
    (typeof payload.total === "number" || payload.total === null)
  );
}

export function isCheckResultPayload(payload: unknown): payload is CheckResult {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "id" in payload &&
    "title" in payload &&
    "status" in payload &&
    typeof payload.id === "string" &&
    typeof payload.title === "string" &&
    typeof payload.status === "string"
  );
}

export function isArtifactSet(value: unknown): value is ArtifactSet {
  return (
    typeof value === "object" && value !== null && "artifacts" in value && "reportDigest" in value
  );
}
