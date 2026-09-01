#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { openEngine } from "../engine/index.ts";
import type { Engine, JobReader, JobWriter } from "../engine/engine.ts";
import type {
  AcceptedException,
  ApprovalRecord,
  ExecuteResult,
  JobEvent,
  JobRef,
  JobStatus,
  Outcome,
  Refusal,
  RowPage,
} from "../engine/types.ts";
import {
  type CommandName,
  SCHEMA_VERSION,
  buildReviewEnvelope,
  terminalEnvelopeForExecute,
} from "./envelope.ts";
import { exitCodeForRefusalCode, exitCodeForSignal } from "./exit-codes.ts";
import { redact } from "./redact.ts";

export interface IoStream {
  isTTY: boolean;
  write(chunk: string): void | Promise<void>;
}

export interface IoInput {
  isTTY: boolean;
  readLine(): Promise<string | null>;
}

export interface Io {
  stdout: IoStream;
  stderr: IoStream;
  stdin: IoInput;
}

type OutputMode = "text" | "json" | "jsonl";

type JobType = "file_migration" | "teams_archive";

interface Invocation {
  command: CommandName;
  output: OutputMode;
  jobId: string | null;
  initType: JobType | null;
  label: string | null;
  approver: string | null;
  planDigest: string | null;
  verificationDigest: string | null;
  codes: string[];
  confirm: boolean;
  stopWorker: boolean;
  from: number | null;
  reason: string | null;
}

interface ParseFailure {
  message: string;
}

const DEFAULT_JOB_TYPE: JobType = "file_migration";
const COMMANDS: readonly CommandName[] = [
  "init",
  "doctor",
  "plan",
  "approve",
  "execute",
  "status",
  "verify",
  "accept",
  "report",
  "close",
  "cancel",
  "reclaim",
  "web",
];

async function writeChunk(stream: IoStream, chunk: string): Promise<void> {
  await stream.write(chunk);
}

async function emitJson(stream: IoStream, value: unknown): Promise<void> {
  await writeChunk(stream, `${JSON.stringify(redact(value))}\n`);
}

async function emitText(stream: IoStream, value: unknown): Promise<void> {
  await writeChunk(stream, `${JSON.stringify(redact(value), null, 2)}\n`);
}

function usage(message: string): ParseFailure {
  return { message };
}

function parseInvocation(argv: string[]): Invocation | ParseFailure {
  let command: CommandName | null = null;
  let output: OutputMode = "text";
  let jobId: string | null = null;
  let initType: JobType | null = null;
  let label: string | null = null;
  let approver: string | null = null;
  let planDigest: string | null = null;
  let verificationDigest: string | null = null;
  let confirm = false;
  let stopWorker = false;
  let from: number | null = null;
  let reason: string | null = null;
  const codes: string[] = [];

  const takeValue = (flag: string, index: number): string | ParseFailure => {
    const nextIndex = index + 1;
    const value = nextIndex < argv.length ? argv[nextIndex] : undefined;
    if (value === undefined || value.startsWith("--")) {
      return usage(`${flag} requires a value`);
    }

    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      return usage("missing command");
    }

    if (!token.startsWith("--")) {
      if (command !== null) {
        return usage(`unexpected argument: ${token}`);
      }

      if (!COMMANDS.includes(token as CommandName)) {
        return usage(`unknown command: ${token}`);
      }

      command = token as CommandName;
      continue;
    }

    switch (token) {
      case "--output": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        if (value !== "text" && value !== "json" && value !== "jsonl") {
          return usage(`unsupported output mode: ${value}`);
        }
        output = value;
        index += 1;
        break;
      }
      case "--job": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        jobId = value;
        index += 1;
        break;
      }
      case "--home": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        index += 1;
        break;
      }
      case "--type": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        if (value !== "file_migration" && value !== "teams_archive") {
          return usage(`unsupported job type: ${value}`);
        }
        initType = value;
        index += 1;
        break;
      }
      case "--label": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        label = value;
        index += 1;
        break;
      }
      case "--approver": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        approver = value;
        index += 1;
        break;
      }
      case "--plan-digest": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        planDigest = value;
        index += 1;
        break;
      }
      case "--verification-digest": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        verificationDigest = value;
        index += 1;
        break;
      }
      case "--code": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        codes.push(value);
        index += 1;
        break;
      }
      case "--confirm":
        confirm = true;
        break;
      case "--stop-worker":
        stopWorker = true;
        break;
      case "--from": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return usage(`invalid cursor: ${value}`);
        }
        from = parsed;
        index += 1;
        break;
      }
      case "--reason": {
        const value = takeValue(token, index);
        if (typeof value !== "string") return value;
        reason = value;
        index += 1;
        break;
      }
      default:
        return usage(`unknown option: ${token}`);
    }
  }

  if (command === null) {
    return usage("missing command");
  }

  return {
    command,
    output,
    jobId,
    initType,
    label,
    approver,
    planDigest,
    verificationDigest,
    codes,
    confirm,
    stopWorker,
    from,
    reason,
  };
}

function jobEnvelope(id: string, type: JobType): { id: string; type: JobType } {
  return { id, type };
}

function refusalEnvelope(
  command: CommandName,
  commandId: string,
  job: { id: string; type: JobType },
  refusal: Refusal,
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    commandId,
    job,
    ok: false as const,
    refusal,
  };
}

function resultEnvelope<T>(
  command: CommandName,
  commandId: string,
  job: { id: string; type: JobType },
  value: T,
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    commandId,
    job,
    ok: true as const,
    value,
  };
}

function normalizeTerminalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const state =
    typeof payload.state === "string"
      ? payload.state
      : typeof payload.outcome === "string"
        ? payload.outcome
        : null;

  const resumable =
    typeof payload.resumable === "boolean"
      ? payload.resumable
      : state === "blocked" || state === "interrupted";

  return {
    ...payload,
    ...(state === null ? {} : { state }),
    resumable,
  };
}

function eventEnvelope(
  command: CommandName,
  commandId: string,
  job: { id: string; type: JobType },
  event: JobEvent,
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    commandId,
    job,
    cursor: event.cursor,
    at: event.at,
    verb: event.verb,
    phase: event.phase,
    kind: event.kind,
    payload: event.kind === "terminal" ? normalizeTerminalPayload(event.payload) : event.payload,
  };
}

function terminalEventFromExecute(result: ExecuteResult) {
  return {
    ...result,
    terminal: terminalEnvelopeForExecute(result),
  };
}

async function emitOutcome<T>(
  io: Io,
  command: CommandName,
  commandId: string,
  job: { id: string; type: JobType },
  outcome: Outcome<T>,
  output: OutputMode,
): Promise<number> {
  if (output === "jsonl") {
    return outcome.ok ? 0 : exitCodeForRefusalCode(outcome.refusal.code);
  }

  const envelope = outcome.ok
    ? resultEnvelope(command, commandId, job, outcome.value)
    : refusalEnvelope(command, commandId, job, outcome.refusal);

  if (output === "json") {
    await emitJson(io.stdout, envelope);
  } else {
    await emitText(io.stdout, envelope);
  }

  return outcome.ok ? 0 : exitCodeForRefusalCode(outcome.refusal.code);
}

async function streamEvents(
  io: Io,
  command: CommandName,
  commandId: string,
  job: { id: string; type: JobType },
  reader: JobReader,
  from: number | null,
): Promise<void> {
  const query = from === null ? { follow: false } : { from, follow: false };
  for await (const event of reader.events(query)) {
    await emitJson(io.stdout, eventEnvelope(command, commandId, job, event));
  }
}

async function promptForYes(io: Io): Promise<boolean> {
  if (!io.stdin.isTTY || !io.stdout.isTTY || !io.stderr.isTTY) {
    return false;
  }

  await writeChunk(io.stdout, "Type yes to approve: ");
  const answer = await io.stdin.readLine();
  return answer === "yes";
}

function writeUsage(io: Io, message: string): Promise<void> {
  return writeChunk(io.stderr, `${message}\n`);
}
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function jobTypeFromStatus(status: Outcome<JobStatus> | null): JobType {
  if (status?.ok) {
    return status.value.jobType;
  }

  return DEFAULT_JOB_TYPE;
}

async function statusRefutation(
  io: Io,
  command: CommandName,
  commandId: string,
  job: { id: string; type: JobType },
  status: Outcome<JobStatus>,
  output: OutputMode,
): Promise<number> {
  return emitOutcome(io, command, commandId, job, status, output);
}

async function renderJobCommand<T>(
  io: Io,
  command: CommandName,
  commandId: string,
  job: { id: string; type: JobType },
  outcome: Outcome<T>,
  output: OutputMode,
  reader: JobReader,
  from: number | null,
): Promise<number> {
  const code = await emitOutcome(io, command, commandId, job, outcome, output);
  if (output === "jsonl") {
    await streamEvents(io, command, commandId, job, reader, from);
  }

  return code;
}

async function runInit(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.initType === null) {
    await writeUsage(io, "init requires --type file_migration|teams_archive");
    return 2;
  }

  const outcome = await engine.initJob(
    invocation.label === null
      ? { type: invocation.initType }
      : { type: invocation.initType, label: invocation.label },
  );
  const job = outcome.ok
    ? jobEnvelope(outcome.value.id, invocation.initType)
    : jobEnvelope("", invocation.initType);

  if (invocation.output === "jsonl") {
    if (outcome.ok) {
      const reader = engine.reader({ id: outcome.value.id });
      await streamEvents(io, "init", commandId, job, reader, invocation.from);
    }

    return outcome.ok ? 0 : exitCodeForRefusalCode(outcome.refusal.code);
  }

  return emitOutcome(io, "init", commandId, job, outcome, invocation.output);
}

async function runDoctor(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "doctor requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "doctor", commandId, job, status, invocation.output);
  }

  const outcome = await engine.withWriterResult({ id: invocation.jobId }, (writer: JobWriter) =>
    writer.doctor(),
  );
  return renderJobCommand(
    io,
    "doctor",
    commandId,
    job,
    outcome,
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runPlan(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "plan requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "plan", commandId, job, status, invocation.output);
  }

  const revisionOutcome = await engine.withWriterResult(
    { id: invocation.jobId },
    (writer: JobWriter) => writer.plan(),
  );
  if (!revisionOutcome.ok) {
    return emitOutcome(io, "plan", commandId, job, revisionOutcome, invocation.output);
  }

  const query = { phase: "plan" as const, revision: revisionOutcome.value.revision };
  const rows = await reader.rows(query);
  if (!rows.ok) {
    return renderJobCommand(
      io,
      "plan",
      commandId,
      job,
      rows,
      invocation.output,
      reader,
      invocation.from,
    );
  }

  const value = {
    ...revisionOutcome.value,
    review: buildReviewEnvelope(query, rows.value),
  };

  return renderJobCommand(
    io,
    "plan",
    commandId,
    job,
    { ok: true, value },
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runApprove(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "approve requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "approve", commandId, job, status, invocation.output);
  }

  if (invocation.approver === null || invocation.planDigest === null) {
    const refusal: Refusal = {
      code: "approval_required",
      message: "approve requires --approver and --plan-digest",
    };
    return emitOutcome(io, "approve", commandId, job, { ok: false, refusal }, invocation.output);
  }

  const humanMode =
    invocation.output === "text" && io.stdin.isTTY && io.stdout.isTTY && io.stderr.isTTY;
  if (humanMode) {
    const accepted = await promptForYes(io);
    if (!accepted) {
      const refusal: Refusal = {
        code: "approval_required",
        message: "approve requires literal yes",
      };
      return emitOutcome(io, "approve", commandId, job, { ok: false, refusal }, invocation.output);
    }
  }

  const approver = invocation.approver;
  const planDigest = invocation.planDigest;
  const mode = humanMode ? "interactive" : "unattended";
  const outcome = await engine.withWriterResult({ id: invocation.jobId }, (writer: JobWriter) =>
    writer.approve({
      approver,
      planDigest,
      mode,
    }),
  );

  return renderJobCommand(
    io,
    "approve",
    commandId,
    job,
    outcome,
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runExecute(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "execute requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "execute", commandId, job, status, invocation.output);
  }
  const outcome = await engine.withWriterResult({ id: invocation.jobId }, (writer: JobWriter) =>
    writer.execute(),
  );
  if (!outcome.ok) {
    return emitOutcome(io, "execute", commandId, job, outcome, invocation.output);
  }

  const result = outcome.value;
  if (invocation.output === "jsonl") {
    await streamEvents(io, "execute", commandId, job, reader, invocation.from);
    return result.outcome === "blocked" ? 5 : 0;
  }

  await emitOutcome(
    io,
    "execute",
    commandId,
    job,
    { ok: true, value: terminalEnvelopeForExecute(result) },
    invocation.output,
  );
  return result.outcome === "blocked" ? 5 : 0;
}

async function runStatus(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "status requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "status", commandId, job, status, invocation.output);
  }

  return renderJobCommand(
    io,
    "status",
    commandId,
    job,
    status,
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runVerify(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "verify requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "verify", commandId, job, status, invocation.output);
  }
  const outcome = await engine.withWriterResult({ id: invocation.jobId }, (writer: JobWriter) =>
    writer.verify(),
  );
  return renderJobCommand(
    io,
    "verify",
    commandId,
    job,
    outcome,
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runAccept(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "accept requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "accept", commandId, job, status, invocation.output);
  }

  if (invocation.verificationDigest === null) {
    const refusal: Refusal = {
      code: "verification_unaccepted",
      message: "accept requires --verification-digest",
    };
    return emitOutcome(io, "accept", commandId, job, { ok: false, refusal }, invocation.output);
  }

  if (invocation.approver === null || invocation.codes.length === 0) {
    await writeUsage(io, "accept requires --approver and at least one --code");
    return 2;
  }

  const verificationDigest = invocation.verificationDigest;
  const approver = invocation.approver;
  const outcome = await engine.withWriterResult({ id: invocation.jobId }, (writer: JobWriter) =>
    writer.accept({
      verificationDigest,
      codes: invocation.codes.map((code) => ({ code }) as AcceptedException),
      approver,
    }),
  );

  return renderJobCommand(
    io,
    "accept",
    commandId,
    job,
    outcome,
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runReport(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "report requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "report", commandId, job, status, invocation.output);
  }

  const outcome = await engine.withWriterResult({ id: invocation.jobId }, (writer: JobWriter) =>
    writer.report(),
  );
  return renderJobCommand(
    io,
    "report",
    commandId,
    job,
    outcome,
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runClose(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "close requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "close", commandId, job, status, invocation.output);
  }

  const outcome = await engine.withWriterResult({ id: invocation.jobId }, (writer: JobWriter) =>
    writer.close(),
  );
  return renderJobCommand(
    io,
    "close",
    commandId,
    job,
    outcome,
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runCancel(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "cancel requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "cancel", commandId, job, status, invocation.output);
  }

  const outcome = await engine.withWriterResult({ id: invocation.jobId }, (writer: JobWriter) =>
    writer.cancel(invocation.reason ?? "cli cancel"),
  );
  return renderJobCommand(
    io,
    "cancel",
    commandId,
    job,
    outcome,
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runDoctorLike(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "doctor requires --job <id>");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "doctor", commandId, job, status, invocation.output);
  }

  const outcome = await engine.withWriterResult({ id: invocation.jobId }, (writer: JobWriter) =>
    writer.doctor(),
  );
  return renderJobCommand(
    io,
    "doctor",
    commandId,
    job,
    outcome,
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runReclaim(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  if (invocation.jobId === null) {
    await writeUsage(io, "reclaim requires --job <id>");
    return 2;
  }

  if (!invocation.confirm) {
    await writeUsage(io, "reclaim requires --confirm");
    return 2;
  }

  const reader = engine.reader({ id: invocation.jobId });
  const status = await reader.status();
  const job = jobEnvelope(invocation.jobId, jobTypeFromStatus(status));
  if (!status.ok) {
    return statusRefutation(io, "reclaim", commandId, job, status, invocation.output);
  }

  const outcome = await engine.reclaim(
    { id: invocation.jobId },
    { confirm: true, stopWorker: invocation.stopWorker },
  );
  return renderJobCommand(
    io,
    "reclaim",
    commandId,
    job,
    outcome,
    invocation.output,
    reader,
    invocation.from,
  );
}

async function runWeb(io: Io): Promise<number> {
  await writeUsage(io, "web is not available yet; stage 4 will introduce the webview adapter");
  return 2;
}

async function handleInvocation(
  invocation: Invocation,
  io: Io,
  engine: Engine,
  commandId: string,
): Promise<number> {
  switch (invocation.command) {
    case "init":
      return runInit(invocation, io, engine, commandId);
    case "doctor":
      return runDoctorLike(invocation, io, engine, commandId);
    case "plan":
      return runPlan(invocation, io, engine, commandId);
    case "approve":
      return runApprove(invocation, io, engine, commandId);
    case "execute":
      return runExecute(invocation, io, engine, commandId);
    case "status":
      return runStatus(invocation, io, engine, commandId);
    case "verify":
      return runVerify(invocation, io, engine, commandId);
    case "accept":
      return runAccept(invocation, io, engine, commandId);
    case "report":
      return runReport(invocation, io, engine, commandId);
    case "close":
      return runClose(invocation, io, engine, commandId);
    case "cancel":
      return runCancel(invocation, io, engine, commandId);
    case "reclaim":
      return runReclaim(invocation, io, engine, commandId);
    case "web":
      return runWeb(io);
    default: {
      const neverCommand: never = invocation.command;
      return neverCommand;
    }
  }
}

const HELP = `migmate — finite, one-way movement or preservation of organizational content

Usage: migmate <verb> [flags]

Lifecycle verbs, in rail order:
  init      create a job of an explicit type
  doctor    run preflight and record its evidence
  plan      collect evidence and produce an immutable, digest-bound plan
  approve   bind an approver identity to an exact plan digest
  execute   run the approved plan in the foreground; resumable after interrupt
  status    read job state, rail, ownership, and progress without taking the lease
  verify    prove the result; re-runnable without re-approval
  accept    accept named exceptions against the current verification digest
  report    write the durable report artifacts
  close     close the job; requires a clean verification or accepted exceptions
  cancel    stop the job terminally; never rolls back destination writes
  reclaim   take a job from a dead owner after reading its recovery report

Flags:
  --output text|json|jsonl   machine-facing output; json and jsonl never prompt
  --job <id>                 the job to act on
  --home <path>              engine home; defaults to MIGMATE_HOME
  --type <job type>          init only: file_migration or teams_archive
  --approver <string>        approve and accept: the identity being recorded
  --plan-digest <digest>     approve: the digest read back from plan output
  --verification-digest <d>  accept: the digest the acceptance binds to
  --code <code>              accept: an exception code; repeatable
  --from <cursor>            jsonl: resume exclusively from a durable cursor
  --confirm / --stop-worker  reclaim: acknowledge the recovery report
  --reason <string>          cancel: why the job was stopped

Exit codes: 0 success, 1 defect, 2 usage, 3 lease, 4 gate refusal, 5 blocked,
6 closed, 7 cancelled, 8 state version, 130 interrupt, 141 broken pipe.
`;

export async function run(argv: string[], io: Io, engine: Engine): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    await io.stdout.write(HELP);
    return 0;
  }

  const parsed = parseInvocation(argv);
  const commandId = randomUUID();

  try {
    if ("message" in parsed) {
      await writeUsage(io, parsed.message);
      return 2;
    }

    return await handleInvocation(parsed, io, engine, commandId);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EPIPE") return exitCodeForSignal("EPIPE");
    if (code === "SIGINT") return exitCodeForSignal("SIGINT");
    throw error;
  } finally {
    await engine.close();
  }
}

function bootstrapHome(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--home") {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        return next;
      }
    }
  }

  return process.env.MIGMATE_HOME ?? `${process.env.HOME ?? ""}/.migmate`;
}

function processIo(): Io {
  return {
    stdout: {
      isTTY: Boolean(process.stdout.isTTY),
      write(chunk: string) {
        process.stdout.write(chunk);
      },
    },
    stderr: {
      isTTY: Boolean(process.stderr.isTTY),
      write(chunk: string) {
        process.stderr.write(chunk);
      },
    },
    stdin: {
      isTTY: Boolean(process.stdin.isTTY),
      async readLine() {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question("");
        } finally {
          rl.close();
        }
      },
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const engine = openEngine({ home: bootstrapHome(process.argv.slice(2)), adapter: "cli" });
  process.exit(await run(process.argv.slice(2), processIo(), engine));
}
