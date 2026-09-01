import type { JobState } from "./types.ts";

export type Transition =
  | "plan"
  | "approve"
  | "execute"
  | "interrupt"
  | "budget_exhausted"
  | "finish_gaps"
  | "finish_clean"
  | "accept"
  | "verify_gaps"
  | "verify_clean"
  | "close"
  | "cancel"
  | "reconcile";

export const TRANSITIONS: Record<JobState, Partial<Record<Transition, JobState>>> = {
  new: {
    plan: "planned",
    cancel: "cancelled",
  },
  planned: {
    plan: "planned",
    approve: "approved",
    cancel: "cancelled",
  },
  approved: {
    plan: "planned",
    execute: "executing",
    cancel: "cancelled",
  },
  executing: {
    plan: "planned",
    interrupt: "interrupted",
    budget_exhausted: "blocked",
    finish_gaps: "needs_attention",
    finish_clean: "verified",
    cancel: "cancelled",
    reconcile: "interrupted",
  },
  interrupted: {
    plan: "planned",
    execute: "executing",
    cancel: "cancelled",
  },
  blocked: {
    plan: "planned",
    execute: "executing",
    cancel: "cancelled",
  },
  needs_attention: {
    plan: "planned",
    accept: "verified",
    verify_gaps: "needs_attention",
    verify_clean: "verified",
    cancel: "cancelled",
  },
  verified: {
    plan: "planned",
    execute: "executing",
    verify_gaps: "needs_attention",
    verify_clean: "verified",
    close: "closed",
    cancel: "cancelled",
  },
  closed: {},
  cancelled: {},
};

export function nextState(from: JobState, t: Transition): JobState | null {
  return TRANSITIONS[from][t] ?? null;
}

export function reconcileOnWriterOpen(state: JobState): JobState {
  return state === "executing" ? "interrupted" : state;
}

export function refusalForClosedJob(state: JobState): "job_closed" | "job_cancelled" | null {
  if (state === "closed") {
    return "job_closed";
  }

  if (state === "cancelled") {
    return "job_cancelled";
  }

  return null;
}
