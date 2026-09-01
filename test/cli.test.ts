import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run, type Io } from "../src/cli/main.ts";
import { type Engine, type JobReader, type JobWriter } from "../src/engine/engine.ts";
import {
  ok,
  type AcceptedException,
  type ApprovalRecord,
  type ArtifactSet,
  type Closure,
  type ExecuteResult,
  type JobEvent,
  type JobRef,
  type JobStatus,
  type Outcome,
  type PlanRevision,
  type PreflightReport,
  type RecoveryReport,
  type Refusal,
  type RowPage,
  type VerificationRevision,
} from "../src/engine/types.ts";

type JobType = "file_migration" | "teams_archive";

type JsonDoc = {
  schemaVersion: number;
  command: string;
  commandId: string;
  job: { id: string; type: JobType };
  ok: boolean;
  value?: unknown;
  refusal?: { code: string; message: string; recovery?: unknown };
};

type JsonlBase = {
  schemaVersion: number;
  cursor: number;
  at: string;
  verb: JobEvent["verb"];
  phase: JobEvent["phase"];
};

type JsonlTerminalDoc = JsonlBase & {
  kind: "terminal";
  payload: { state: string; resumable: boolean };
};

type JsonlDoc =
  | JsonlTerminalDoc
  | (JsonlBase & { kind: Exclude<JobEvent["kind"], "terminal">; payload: JobEvent["payload"] });

interface EngineConfig {
  init: Outcome<JobRef>;
  status: Outcome<JobStatus>;
  rows: Outcome<RowPage>;
  plan: Outcome<PlanRevision>;
  doctor: Outcome<PreflightReport>;
  approve: Outcome<ApprovalRecord>;
  execute: Outcome<ExecuteResult>;
  verify: Outcome<VerificationRevision>;
  accept: Outcome<VerificationRevision>;
  artifacts: Outcome<ArtifactSet>;
  close: Outcome<Closure>;
  cancel: Outcome<Closure>;
  reclaim: Outcome<RecoveryReport>;
  leaseRefusal?: Refusal;
  events: JobEvent[];
}

interface EngineState {
  approveArgs: { approver: string; planDigest: string; mode: "interactive" | "unattended" } | null;
  acceptArgs: { verificationDigest: string; codes: AcceptedException[]; approver: string } | null;
  cancelArgs: string | null;
  reclaimArgs: { confirm: true; stopWorker?: boolean } | null;
  calls: string[];
}

function defaultStatus(jobType: JobType = "file_migration"): JobStatus {
  return {
    jobId: "job-1",
    jobType,
    state: "executing",
    schemaVersion: 1,
    rail: [
      { verb: "init", state: "done" },
      { verb: "doctor", state: "done" },
      { verb: "plan", state: "done" },
      { verb: "approve", state: "done" },
      { verb: "execute", state: "current" },
      { verb: "status", state: "checkpoint" },
      { verb: "verify", state: "pending" },
      { verb: "report", state: "pending" },
      { verb: "close", state: "pending" },
      { verb: "cancel", state: "pending" },
    ],
    ownership: {
      held: false,
      heldByThisProcess: false,
      hostId: null,
      pid: null,
      heartbeatAt: null,
      kind: null,
    },
    planRevision: 7,
    planDigest: "plan-digest",
    verificationDigest: "verification-digest",
    progress: { unit: "items", done: 2, total: null },
    lastCheckpoint: "checkpoint-1",
    outstandingFindings: [],
  };
}

function defaultPlan(): PlanRevision {
  return {
    revision: 7,
    planDigest: "plan-digest",
    inputsDigest: "inputs-digest",
    createdAt: "2026-09-01T00:00:00.000Z",
    sourceInventoryAt: "2026-09-01T00:00:00.000Z",
    rowCount: 1,
  };
}

function defaultRows(): RowPage {
  return {
    facets: [{ code: "updated", kind: "policy_outcome", count: 1 }],
    rows: [
      {
        id: "item-1",
        jobType: "file_migration",
        code: "updated",
        kind: "policy_outcome",
        phase: "plan",
        revision: 7,
        accepted: false,
        mappingId: "map-1",
        sourceItemId: "source-1",
        relativePath: "docs/readme.md",
        size: 12,
        destinationFileId: "dest-1",
        provenanceState: "marked",
      },
    ],
    nextCursor: null,
    totalRows: 1,
  };
}

function defaultPreflight(): PreflightReport {
  return {
    passed: true,
    checks: [{ id: "check-1", title: "ok", status: "pass", evidence: {} }],
  };
}

function defaultApproval(): ApprovalRecord {
  return {
    revision: 8,
    planDigest: "plan-digest",
    approver: "alice",
    mode: "unattended",
    at: "2026-09-01T00:00:00.000Z",
  };
}

function defaultExecute(outcome: ExecuteResult["outcome"] = "completed"): ExecuteResult {
  const result: ExecuteResult = {
    outcome,
    checkpoint: "checkpoint-2",
    committedUnits: 4,
  };

  if (outcome === "blocked") {
    result.budget = { failedAttempts: 3, failedUnitRatio: 0.75 };
  }

  return result;
}

function defaultVerification(): VerificationRevision {
  return {
    revision: 9,
    verificationDigest: "verification-digest",
    clean: true,
    findings: [],
    acceptedCodes: [],
    at: "2026-09-01T00:00:00.000Z",
  };
}

function defaultArtifacts(): ArtifactSet {
  return {
    reportDigest: "report-digest",
    artifacts: [{ name: "report", format: "json", path: "/tmp/report.json", digest: "digest-1" }],
  };
}

function defaultClosure(state: "closed" | "cancelled"): Closure {
  return {
    state,
    at: "2026-09-01T00:00:00.000Z",
    acceptedExceptions: [],
  };
}

function defaultRecovery(): RecoveryReport {
  return {
    workerAlive: false,
    recordedHostId: "host-a",
    thisHostId: "host-a",
    holder: {
      ownerUuid: "owner-1",
      pid: 9001,
      processStartTime: 111,
      heartbeatAt: "2026-09-01T00:00:00.000Z",
      heartbeatAgeMs: 2000,
      kind: "cli",
    },
    workerGroup: "worker-group",
    socketProbed: null,
    workerPid: null,
    lastCheckpoint: "checkpoint-1",
    reclaimable: true,
  };
}

function makeEngine(config: Partial<EngineConfig> = {}): Engine & { state: EngineState } {
  const state: EngineState = {
    approveArgs: null,
    acceptArgs: null,
    cancelArgs: null,
    reclaimArgs: null,
    calls: [],
  };

  const writer: JobWriter = {
    doctor: async () => {
      state.calls.push("writer.doctor");
      return config.doctor ?? ok(defaultPreflight());
    },
    plan: async () => {
      state.calls.push("writer.plan");
      return config.plan ?? ok(defaultPlan());
    },
    approve: async (args) => {
      state.calls.push("writer.approve");
      state.approveArgs = args;
      return config.approve ?? ok(defaultApproval());
    },
    execute: async () => {
      state.calls.push("writer.execute");
      return config.execute ?? ok(defaultExecute());
    },
    verify: async () => {
      state.calls.push("writer.verify");
      return config.verify ?? ok(defaultVerification());
    },
    accept: async (args) => {
      state.calls.push("writer.accept");
      state.acceptArgs = args;
      return config.accept ?? ok(defaultVerification());
    },
    report: async () => {
      state.calls.push("writer.report");
      return config.artifacts ?? ok(defaultArtifacts());
    },
    close: async () => {
      state.calls.push("writer.close");
      return config.close ?? ok(defaultClosure("closed"));
    },
    cancel: async (reason) => {
      state.calls.push("writer.cancel");
      state.cancelArgs = reason;
      return config.cancel ?? ok(defaultClosure("cancelled"));
    },
  };

  const reader: JobReader = {
    status: async () => {
      state.calls.push("reader.status");
      return config.status ?? ok(defaultStatus());
    },
    rows: async (query) => {
      state.calls.push(`reader.rows:${query.phase}:${query.revision ?? "none"}`);
      return config.rows ?? ok(defaultRows());
    },
    events: async function* (query) {
      state.calls.push(`reader.events:${query.from ?? "none"}:${query.follow ?? false}`);
      for (const event of config.events ?? []) {
        yield event;
      }
    },
    artifacts: async () => {
      state.calls.push("reader.artifacts");
      return config.artifacts ?? ok(defaultArtifacts());
    },
  };

  return {
    state,
    initJob: async (spec) => {
      state.calls.push(`initJob:${spec.type}`);
      return config.init ?? ok({ id: "job-new" });
    },
    reader: () => {
      state.calls.push("reader");
      return reader;
    },
    withWriter: async <T>(_ref: JobRef, fn: (w: JobWriter) => Promise<T>): Promise<Outcome<T>> => {
      state.calls.push("withWriter");
      return fn(writer) as unknown as Outcome<T>;
    },
    withWriterResult: async <T>(
      _ref: JobRef,
      fn: (w: JobWriter) => Promise<Outcome<T>>,
    ): Promise<Outcome<T>> => {
      state.calls.push("withWriterResult");
      if (config.leaseRefusal !== undefined) {
        return { ok: false, refusal: config.leaseRefusal };
      }

      return fn(writer);
    },
    reclaim: async (_ref, decision) => {
      state.calls.push("engine.reclaim");
      state.reclaimArgs = decision;
      return config.reclaim ?? ok(defaultRecovery());
    },
    close: () => {
      state.calls.push("engine.close");
    },
  };
}

function makeIo(
  opts: {
    stdoutTTY?: boolean;
    stderrTTY?: boolean;
    stdinTTY?: boolean;
    answers?: string[];
  } = {},
): { io: Io; stdout: string[]; stderr: string[]; prompts: () => number } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let promptCount = 0;
  const answers = [...(opts.answers ?? [])];

  return {
    stdout,
    stderr,
    prompts: () => promptCount,
    io: {
      stdout: {
        isTTY: opts.stdoutTTY ?? false,
        write(chunk: string) {
          stdout.push(chunk);
        },
      },
      stderr: {
        isTTY: opts.stderrTTY ?? false,
        write(chunk: string) {
          stderr.push(chunk);
        },
      },
      stdin: {
        isTTY: opts.stdinTTY ?? false,
        async readLine() {
          promptCount += 1;
          return answers.shift() ?? null;
        },
      },
    },
  };
}

function parseJson(text: string): JsonDoc {
  return JSON.parse(text.trim()) as JsonDoc;
}

function parseJsonLines(text: string): JsonlDoc[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonlDoc);
}

function assertTerminalJsonlDoc(doc: JsonlDoc): asserts doc is JsonlTerminalDoc {
  assert.equal(doc.kind, "terminal");
}

function assertBaseEnvelope(doc: JsonDoc, command: string, jobId: string, jobType: JobType) {
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.command, command);
  assert.equal(typeof doc.commandId, "string");
  assert.equal(doc.commandId.length > 0, true);
  assert.deepEqual(doc.job, { id: jobId, type: jobType });
}

async function invoke(
  argv: string[],
  engineConfig: Partial<EngineConfig> = {},
  ioOpts: Parameters<typeof makeIo>[0] = {},
) {
  const built = makeIo(ioOpts);
  const engine = makeEngine(engineConfig);
  const code = await run(argv, built.io, engine);
  return {
    code,
    stdout: built.stdout,
    stderr: built.stderr,
    prompts: built.prompts,
    state: engine.state,
  };
}

describe("CLI JSON envelope", () => {
  it("emits one JSON document for each supported verb", async () => {
    const cases = [
      {
        command: "init",
        argv: ["init", "--type", "file_migration", "--output", "json"],
        config: { init: ok({ id: "job-new" }) },
        jobId: "job-new",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as { id: string };
          assert.equal(value.id, "job-new");
        },
      },
      {
        command: "doctor",
        argv: ["doctor", "--job", "job-1", "--output", "json"],
        config: { doctor: ok(defaultPreflight()) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as { passed: boolean };
          assert.equal(value.passed, true);
        },
      },
      {
        command: "plan",
        argv: ["plan", "--job", "job-1", "--output", "json"],
        config: { plan: ok(defaultPlan()), rows: ok(defaultRows()) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as {
            planDigest: string;
            review: { totalRows: number; rows: unknown[] };
          };
          assert.equal(value.planDigest, "plan-digest");
          assert.equal(value.review.totalRows, 1);
          assert.equal(value.review.rows.length, 1);
        },
      },
      {
        command: "approve",
        argv: [
          "approve",
          "--job",
          "job-1",
          "--approver",
          "alice",
          "--plan-digest",
          "plan-digest",
          "--output",
          "json",
        ],
        config: { approve: ok(defaultApproval()) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as { approver: string };
          assert.equal(value.approver, "alice");
        },
      },
      {
        command: "execute",
        argv: ["execute", "--job", "job-1", "--output", "json"],
        config: { execute: ok(defaultExecute("completed")) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as {
            state: string;
            resumable: boolean;
            checkpoint: string | null;
            committedUnits?: number;
            budget?: { failedAttempts: number; failedUnitRatio: number };
          };
          assert.equal(value.state, "completed");
          assert.equal(value.resumable, false);
          assert.equal(value.checkpoint, "checkpoint-2");
          assert.equal(value.committedUnits, undefined);
        },
      },
      {
        command: "status",
        argv: ["status", "--job", "job-1", "--output", "json"],
        config: { status: ok(defaultStatus()) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as { state: string };
          assert.equal(value.state, "executing");
        },
      },
      {
        command: "verify",
        argv: ["verify", "--job", "job-1", "--output", "json"],
        config: { verify: ok(defaultVerification()) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as { verificationDigest: string };
          assert.equal(value.verificationDigest, "verification-digest");
        },
      },
      {
        command: "accept",
        argv: [
          "accept",
          "--job",
          "job-1",
          "--verification-digest",
          "verification-digest",
          "--code",
          "record_count_mismatch",
          "--approver",
          "alice",
          "--output",
          "json",
        ],
        config: { accept: ok(defaultVerification()) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as { acceptedCodes: string[] };
          assert.equal(value.acceptedCodes.length, 0);
        },
      },
      {
        command: "report",
        argv: ["report", "--job", "job-1", "--output", "json"],
        config: { artifacts: ok(defaultArtifacts()) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as { reportDigest: string };
          assert.equal(value.reportDigest, "report-digest");
        },
      },
      {
        command: "close",
        argv: ["close", "--job", "job-1", "--output", "json"],
        config: { close: ok(defaultClosure("closed")) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as { state: string };
          assert.equal(value.state, "closed");
        },
      },
      {
        command: "cancel",
        argv: ["cancel", "--job", "job-1", "--reason", "stop", "--output", "json"],
        config: { cancel: ok(defaultClosure("cancelled")) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as { state: string };
          assert.equal(value.state, "cancelled");
        },
      },
      {
        command: "reclaim",
        argv: ["reclaim", "--job", "job-1", "--confirm", "--output", "json"],
        config: { reclaim: ok(defaultRecovery()) },
        jobId: "job-1",
        jobType: "file_migration" as const,
        verify(doc: JsonDoc) {
          const value = doc.value as { workerGroup: string };
          assert.equal(value.workerGroup, "worker-group");
        },
      },
    ] as const;

    for (const testCase of cases) {
      const argv = [...testCase.argv];
      const { code, stdout, stderr } = await invoke(argv, testCase.config);
      assert.equal(code, 0, testCase.command);
      assert.equal(stderr.join(""), "", testCase.command);
      assert.equal(stdout.length, 1, testCase.command);
      const doc = parseJson(stdout.join(""));
      assertBaseEnvelope(doc, testCase.command, testCase.jobId, testCase.jobType);
      assert.equal(doc.ok, true);
      assert.ok("value" in doc);
      assert.equal("refusal" in doc, false);
      testCase.verify(doc);
    }
  });
});

describe("CLI refusal codes", () => {
  const refusalCases = [
    ["lease_held", 3],
    ["foreign_host", 3],
    ["lease_stale_worker_alive", 3],
    ["preflight_failed", 4],
    ["approval_required", 4],
    ["approval_digest_stale", 4],
    ["plan_revision_required", 4],
    ["unqualified_route", 4],
    ["verification_unaccepted", 4],
    ["job_closed", 6],
    ["job_cancelled", 7],
    ["state_version_unsupported", 8],
    ["not_a_real_code", 1],
  ] as const;

  for (const [code, exitCode] of refusalCases) {
    it(`maps ${code} to exit ${exitCode}`, async () => {
      const statusOutcome = {
        ok: false,
        refusal: { code, message: `${code} happened` },
      } as Outcome<JobStatus>;
      const { code: actual, stdout } = await invoke(
        ["status", "--job", "job-1", "--output", "json"],
        {
          status: statusOutcome,
        },
      );

      assert.equal(actual, exitCode);
      assert.equal(stdout.length, 1);
      const doc = parseJson(stdout.join(""));
      assert.equal(doc.ok, false);
      assert.equal(doc.refusal?.code, code);
    });
  }
});

it("surfaces a lease refusal as ok false and the mapped exit code", async () => {
  const { code, stdout, state } = await invoke(["doctor", "--job", "job-1", "--output", "json"], {
    leaseRefusal: { code: "lease_held", message: "lease held" },
  });

  assert.equal(code, 3);
  assert.ok(state.calls.includes("withWriterResult"));
  assert.equal(state.calls.includes("writer.doctor"), false);
  const doc = parseJson(stdout.join(""));
  assert.equal(doc.ok, false);
  assert.equal(doc.refusal?.code, "lease_held");
});

describe("CLI lease refusal redaction", () => {
  it("redacts worker socket data from lease_stale_worker_alive refusals", async () => {
    const socketPath = "/private/var/run/migmate-worker.sock";
    const { code, stdout } = await invoke(
      ["reclaim", "--job", "job-1", "--confirm", "--output", "json"],
      {
        reclaim: {
          ok: false,
          refusal: {
            code: "lease_stale_worker_alive",
            message: `worker still answering at ${socketPath}`,
            recovery: {
              workerAlive: true,
              recordedHostId: "host-a",
              thisHostId: "host-a",
              holder: {
                ownerUuid: "owner-1",
                pid: 9001,
                processStartTime: 111,
                heartbeatAt: "2026-09-01T00:00:00.000Z",
                heartbeatAgeMs: 6000,
                kind: "cli",
              },
              workerGroup: "group-a",
              socketProbed: socketPath,
              workerPid: 4242,
              lastCheckpoint: "checkpoint-1",
              reclaimable: false,
            },
          },
        },
      },
    );

    assert.equal(code, 3);
    assert.equal(stdout.length, 1);
    const raw = stdout.join("");
    assert.equal(raw.includes(socketPath), false);
    assert.equal(raw.includes("4242"), false);
    const doc = parseJson(raw);
    assert.equal(doc.ok, false);
    assert.equal(doc.refusal?.code, "lease_stale_worker_alive");
    const recovery = doc.refusal?.recovery as {
      socketProbed: null;
      workerPid: null;
      recordedHostId: string;
      holder: { pid: number };
      workerGroup: string;
      lastCheckpoint: string;
    };
    assert.equal(recovery.socketProbed, null);
    assert.equal(recovery.workerPid, null);
    assert.equal(recovery.recordedHostId, "host-a");
    assert.equal(recovery.holder.pid, 9001);
    assert.equal(recovery.workerGroup, "group-a");
    assert.equal(recovery.lastCheckpoint, "checkpoint-1");
  });
});

describe("CLI approve prompt policy", () => {
  it("refuses without prompting when approve lacks --plan-digest in non-TTY mode", async () => {
    const { code, stdout, prompts, state } = await invoke(
      ["approve", "--job", "job-1", "--approver", "alice", "--output", "json"],
      {},
      { stdinTTY: false, stdoutTTY: false, stderrTTY: false },
    );

    assert.equal(code, 4);
    assert.equal(prompts(), 0);
    assert.equal(state.approveArgs, null);
    const doc = parseJson(stdout.join(""));
    assert.equal(doc.ok, false);
    assert.equal(doc.refusal?.code, "approval_required");
  });

  it("accepts literal yes in TTY mode", async () => {
    const { code, stdout, prompts, state } = await invoke(
      [
        "approve",
        "--job",
        "job-1",
        "--approver",
        "alice",
        "--plan-digest",
        "plan-digest",
        "--output",
        "text",
      ],
      { approve: ok(defaultApproval()) },
      { stdinTTY: true, stdoutTTY: true, stderrTTY: true, answers: ["yes"] },
    );

    assert.equal(code, 0);
    assert.equal(prompts(), 1);
    assert.deepEqual(state.approveArgs, {
      approver: "alice",
      planDigest: "plan-digest",
      mode: "interactive",
    });
    const rendered = stdout.join("");
    const doc = parseJson(rendered.slice(rendered.indexOf("{")));
    assert.equal(doc.ok, true);
    const value = doc.value as { approver: string };
    assert.equal(value.approver, "alice");
  });

  it("rejects anything other than literal yes in TTY mode", async () => {
    const { code, stdout, prompts, state } = await invoke(
      [
        "approve",
        "--job",
        "job-1",
        "--approver",
        "alice",
        "--plan-digest",
        "plan-digest",
        "--output",
        "text",
      ],
      {},
      { stdinTTY: true, stdoutTTY: true, stderrTTY: true, answers: ["no"] },
    );

    assert.equal(code, 4);
    assert.equal(prompts(), 1);
    assert.equal(state.approveArgs, null);
    const rendered = stdout.join("");
    const doc = parseJson(rendered.slice(rendered.indexOf("{")));
    assert.equal(doc.ok, false);
    assert.equal(doc.refusal?.code, "approval_required");
  });
});

describe("CLI jsonl events", () => {
  it("resumes exclusively from --from and flushes one line per event", async () => {
    const events: JobEvent[] = [
      {
        cursor: 42,
        at: "2026-09-01T00:00:00.000Z",
        verb: "status",
        phase: "status",
        kind: "phase_started",
        payload: { phase: "status" },
      },
      {
        cursor: 43,
        at: "2026-09-01T00:00:01.000Z",
        verb: "status",
        phase: "status",
        kind: "progress",
        payload: { unit: "items", done: 2, total: null },
      },
    ];

    const { code, stdout, state } = await invoke(
      ["status", "--job", "job-1", "--from", "41", "--output", "jsonl"],
      {
        events,
      },
    );

    assert.equal(code, 0);
    assert.ok(state.calls.includes("reader.events:41:false"));
    assert.equal(stdout.length, 2);
    assert.equal(
      stdout.every((chunk) => chunk.endsWith("\n")),
      true,
    );
    const docs = parseJsonLines(stdout.join(""));
    assert.equal(docs.length, 2);
    const first = docs[0];
    const second = docs[1];
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.cursor, 42);
    assert.equal(second.cursor, 43);
  });

  it("marks execute blocked as resumable and emits one terminal event", async () => {
    const events: JobEvent[] = [
      {
        cursor: 88,
        at: "2026-09-01T00:00:00.000Z",
        verb: "execute",
        phase: "execute",
        kind: "terminal",
        payload: { state: "blocked", resumable: true },
      },
    ];

    const { code, stdout } = await invoke(["execute", "--job", "job-1", "--output", "jsonl"], {
      execute: ok(defaultExecute("blocked")),
      events,
    });

    assert.equal(code, 5);
    assert.equal(stdout.length, 1);
    const docs = parseJsonLines(stdout.join(""));
    const doc = docs[0];
    assert.ok(doc);
    assertTerminalJsonlDoc(doc);
    const value = doc.payload;
    assert.equal(value.state, "blocked");
    assert.equal(value.resumable, true);
  });

  it("reports interrupted as resumable and not cancelled", async () => {
    const events: JobEvent[] = [
      {
        cursor: 89,
        at: "2026-09-01T00:00:00.000Z",
        verb: "execute",
        phase: "execute",
        kind: "terminal",
        payload: { state: "interrupted", resumable: true },
      },
    ];

    const { code, stdout } = await invoke(["execute", "--job", "job-1", "--output", "jsonl"], {
      execute: ok(defaultExecute("interrupted")),
      events,
    });

    assert.equal(code, 0);
    const docs = parseJsonLines(stdout.join(""));
    const doc = docs[0];
    assert.ok(doc);
    assertTerminalJsonlDoc(doc);
    const value = doc.payload;
    assert.equal(value.state, "interrupted");
    assert.equal(value.resumable, true);
    assert.notEqual(value.state, "cancelled");
  });
});

describe("CLI stderr discipline", () => {
  it("keeps stderr empty for a successful JSON invocation", async () => {
    const { code, stdout, stderr } = await invoke(
      ["status", "--job", "job-1", "--output", "json"],
      {},
    );

    assert.equal(code, 0);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.join(""), "");
  });
});

describe("CLI stage 4 web usage", () => {
  it("refuses web with a usage error", async () => {
    const { code, stderr } = await invoke(["web"], {});

    assert.equal(code, 2);
    assert.notEqual(stderr.join(""), "");
  });
});
