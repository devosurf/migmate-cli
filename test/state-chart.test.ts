import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TRANSITIONS,
  nextState,
  reconcileOnWriterOpen,
  refusalForClosedJob,
  type Transition,
} from "../src/engine/state-chart.ts";
import { TERMINAL_STATES, type JobState } from "../src/engine/types.ts";

const ALL_TRANSITIONS = [
  "plan",
  "approve",
  "execute",
  "interrupt",
  "budget_exhausted",
  "finish_gaps",
  "finish_clean",
  "accept",
  "verify_gaps",
  "verify_clean",
  "close",
  "cancel",
  "reconcile",
] as const satisfies readonly Transition[];

const STATES = Object.keys(TRANSITIONS) as JobState[];
const STATE_SET = new Set<JobState>(STATES);
const TERMINAL_SET = new Set<JobState>(TERMINAL_STATES);

function reachableFrom(start: JobState): Set<JobState> {
  const seen = new Set<JobState>([start]);
  const queue: JobState[] = [start];

  while (queue.length > 0) {
    const state = queue.shift();
    if (state === undefined) {
      continue;
    }

    for (const target of Object.values(TRANSITIONS[state]) as JobState[]) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }

  return seen;
}

describe("state chart", () => {
  it("matches the table for every state and transition", () => {
    for (const from of STATES) {
      for (const transition of ALL_TRANSITIONS) {
        const expected = TRANSITIONS[from][transition] ?? null;
        assert.equal(nextState(from, transition), expected);
      }
    }
  });

  it("makes all ten states reachable from new", () => {
    const reachable = reachableFrom("new");

    assert.equal(STATES.length, 10);
    assert.equal(reachable.size, 10);
    assert.deepStrictEqual(reachable, STATE_SET);
  });

  it("keeps the absorbing states empty", () => {
    assert.deepStrictEqual(Object.keys(TRANSITIONS.closed), []);
    assert.deepStrictEqual(Object.keys(TRANSITIONS.cancelled), []);
  });

  it("reconciles writer-open state deterministically", () => {
    for (const state of STATES) {
      const reconciled = reconcileOnWriterOpen(state);
      assert.ok(STATE_SET.has(reconciled));
      if (state === "executing") {
        assert.equal(reconciled, "interrupted");
        continue;
      }

      assert.equal(reconciled, state);
    }
  });

  it("treats cancel as a terminalizing edge from every non-terminal state", () => {
    for (const state of STATES) {
      const expected = TERMINAL_SET.has(state) ? null : "cancelled";
      assert.equal(nextState(state, "cancel"), expected);
    }
  });

  it("treats plan as a re-plan edge from every non-terminal state", () => {
    for (const state of STATES) {
      const expected = TERMINAL_SET.has(state) ? null : "planned";
      assert.equal(nextState(state, "plan"), expected);
    }
  });

  it("keeps every table edge inside the ten-state domain", () => {
    for (const [from, edges] of Object.entries(TRANSITIONS) as Array<
      [JobState, Partial<Record<Transition, JobState>>]
    >) {
      for (const [transition, target] of Object.entries(edges) as Array<[Transition, JobState]>) {
        assert.ok(STATE_SET.has(target), `${from} --${transition}--> ${target}`);
      }
    }
  });

  it("maps closed jobs to the right refusal code", () => {
    assert.equal(refusalForClosedJob("closed"), "job_closed");
    assert.equal(refusalForClosedJob("cancelled"), "job_cancelled");
    for (const state of STATES) {
      if (TERMINAL_SET.has(state)) {
        continue;
      }

      assert.equal(refusalForClosedJob(state), null);
    }
  });
});
