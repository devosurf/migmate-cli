import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import {
  nextState,
  reconcileOnWriterOpen,
  refusalForClosedJob,
  type Transition,
} from "../src/engine/state-chart.ts";
import type { JobState } from "../src/engine/types.ts";
import { fileConfig, fileFixture } from "./engine-fixture.ts";

const STATES: readonly JobState[] = [
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
];
const ACTIONS: readonly Transition[] = [
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
];

function journey(steps: readonly Transition[]): JobState {
  let state: JobState = "new";
  for (const action of steps) {
    const next = nextState(state, action);
    assert.notEqual(next, null, `${state} refused ${action}`);
    if (next === null) throw new Error("invalid journey");
    state = next;
  }
  return state;
}

describe("durable lifecycle model", () => {
  it("reaches all ten specified states through executable transitions", () => {
    const seen = new Set<JobState>(["new"]);
    const queue: JobState[] = ["new"];
    for (const state of queue) {
      for (const action of ACTIONS) {
        const next = nextState(state, action);
        if (next !== null && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    assert.deepEqual([...seen].sort(), [...STATES].sort());
  });

  it("never permits execution before approval or closure before verification", () => {
    for (const state of ["new", "planned", "needs_attention"] as const)
      assert.equal(nextState(state, "execute"), null);
    for (const state of STATES.filter((value) => value !== "verified"))
      assert.equal(nextState(state, "close"), null);
    assert.equal(journey(["plan", "approve", "execute", "finish_clean", "close"]), "closed");
  });

  it("resumes interruption and exhausted budgets without a new approval edge", () => {
    assert.equal(
      journey(["plan", "approve", "execute", "interrupt", "execute", "finish_clean"]),
      "verified",
    );
    assert.equal(
      journey(["plan", "approve", "execute", "budget_exhausted", "execute", "finish_clean"]),
      "verified",
    );
    assert.equal(
      journey(["plan", "approve", "execute", "reconcile", "execute", "finish_gaps"]),
      "needs_attention",
    );
  });

  it("requires renewed resolution when independent re-verification finds gaps", () => {
    assert.equal(
      journey(["plan", "approve", "execute", "finish_gaps", "accept", "verify_gaps"]),
      "needs_attention",
    );
    assert.equal(
      journey(["plan", "approve", "execute", "finish_gaps", "verify_clean", "close"]),
      "closed",
    );
    assert.equal(nextState("needs_attention", "close"), null);
  });

  it("makes both terminals absorbing for every operation and crash reconciliation", () => {
    for (const state of ["closed", "cancelled"] as const) {
      for (const action of ACTIONS) assert.equal(nextState(state, action), null);
      assert.equal(reconcileOnWriterOpen(state), state);
      assert.equal(refusalForClosedJob(state), state === "closed" ? "job_closed" : "job_cancelled");
    }
  });

  it("replans and cancels every non-terminal state, while only executing reconciles", () => {
    for (const state of STATES.filter((value) => value !== "closed" && value !== "cancelled")) {
      assert.equal(nextState(state, "plan"), "planned");
      assert.equal(nextState(state, "cancel"), "cancelled");
      assert.equal(reconcileOnWriterOpen(state), state === "executing" ? "interrupted" : state);
      assert.equal(refusalForClosedJob(state), null);
    }
  });
});

describe("engine lifecycle boundaries", () => {
  it("keeps an approval across reopen, but a new plan revision requires approval again", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "state-model-"));
    const provider = new FakeFileMigrationPort(fileFixture());
    const engine = openEngine({ home, provider });
    t.after(() => {
      engine.close();
      rmSync(home, { recursive: true, force: true });
    });
    const created = await engine.initJob({
      type: "file_migration",
      config: fileConfig(),
    });
    assert.ok(created.ok);
    const approved = await engine.withWriter(created.value, async (writer) => {
      const plan = await writer.plan();
      assert.ok(plan.ok);
      const approval = await writer.approve({
        planDigest: plan.value.planDigest,
        approver: "model-test",
        mode: "unattended",
      });
      assert.ok(approval.ok);
      return plan.value;
    });
    assert.ok(approved.ok);
    const status = await engine.reader(created.value).status();
    assert.ok(status.ok);
    assert.equal(status.value.state, "approved");
    const replanned = await engine.withWriter(created.value, async (writer) => {
      const next = await writer.plan();
      assert.ok(next.ok);
      assert.equal(next.value.planDigest, approved.value.planDigest);
      const execution = await writer.execute();
      assert.equal(execution.ok, false);
      if (execution.ok) throw new Error("new plan revision reused approval");
      assert.equal(execution.refusal.code, "approval_required");
    });
    assert.ok(replanned.ok);
    const planned = await engine.reader(created.value).status();
    assert.ok(planned.ok);
    assert.equal(planned.value.state, "planned");
  });

  it("keeps cancellation terminal across writer sessions, with no new approval or execute escape", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "state-cancel-")),
      engine = openEngine({ home });
    t.after(() => {
      engine.close();
      rmSync(home, { recursive: true, force: true });
    });
    const created = await engine.initJob({ type: "file_migration" });
    assert.ok(created.ok);
    const cancelled = await engine.withWriter(created.value, async (writer) =>
      writer.cancel("Operator withdrew this migration request"),
    );
    assert.ok(cancelled.ok);
    assert.ok(cancelled.value.ok);
    assert.equal(cancelled.value.value.reason, "Operator withdrew this migration request");
    const reopened = await engine.withWriter(created.value, async (writer) => {
      for (const result of [await writer.plan(), await writer.execute(), await writer.close()]) {
        assert.equal(result.ok, false);
        if (result.ok) throw new Error("cancelled job reopened");
        assert.equal(result.refusal.code, "job_cancelled");
      }
    });
    assert.ok(reopened.ok);
    const status = await engine.reader(created.value).status();
    assert.ok(status.ok);
    assert.equal(status.value.state, "cancelled");
    assert.equal(status.value.resumable, false);
    assert.equal(status.value.terminalState, "cancelled");
    const states = Object.fromEntries(status.value.rail.map(({ verb, state }) => [verb, state]));
    assert.equal(states.cancel, "done");
    assert.equal(states.close, "pending");
    assert.equal(states.execute, "pending");
    assert.equal(
      status.value.rail.some(({ state }) => state === "current"),
      false,
    );
  });
});
