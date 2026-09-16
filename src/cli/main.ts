#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import { hostname, userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import {
  openEngine,
  type Engine,
  type ExecuteResult,
  type JobReader,
  type JobWriter,
  type JobEvent,
  type JobStatus,
  type Outcome,
  type Refusal,
  type RowQuery,
} from "../engine/index.ts";
import { launchWeb } from "../web/index.ts";
import {
  parseInvocation,
  outputMode,
  commandLabel,
  UsageFailure,
  type Invocation,
  type OutputMode,
} from "./arguments.ts";
import {
  SCHEMA_VERSION,
  buildReviewEnvelope,
  knownContract,
  outcomeExit,
  terminalEnvelopeForExecute,
  type AdapterOutcome,
  type JobEnvelope,
} from "./envelope.ts";
import { errorCode, processIo, type Io } from "./io.ts";
import { redact } from "./redact.ts";

export type { Io, IoInput, IoStream } from "./io.ts";

const HELP = `Migmate — one ten-verb lifecycle, two job types

migmate init --type file_migration|teams_archive [--config job.toml|job.json]
migmate creds init --job ID --config job.toml|job.json
migmate doctor|plan|execute|status|verify|report|close --job ID
migmate approve --job ID --approver IDENTITY --plan-digest DIGEST --output json
migmate approve --job ID                    # human terminal: review, then literal yes
migmate accept --job ID --approver IDENTITY --verification-digest DIGEST --code CODE [--note NOTE]
migmate cancel --job ID [--reason TEXT]
migmate reclaim --job ID --confirm [--stop-worker]
migmate web --job ID

All commands: --home PATH, --output text|json|jsonl, --schema-version 1, --help
Home defaults: macOS ~/Library/Application Support/Migmate;
Linux \${XDG_STATE_HOME:-~/.local/state}/migmate. Any other platform is refused.
MIGMATE_HOME overrides the default. --home overrides MIGMATE_HOME.
Config input is TOML or JSON containing typed file credential references, never secrets.
Only the engine writes job.toml and probes credentials. Init without config creates
an unconfigured job: onboard with creds init before doctor/plan.

Review: plan|verify --review reads existing evidence without taking a writer lease.
--phase plan|execute|verify, --code CODE (repeatable), --search TEXT,
--cursor CURSOR, --limit 1..1000, --sort natural|path|size, --revision N.
status accepts the same row-query flags. Facets cover the whole matching set.
JSONL streams durable events live during a verb. --from CURSOR resumes exclusively;
without --from a writer streams only its new attempt. status --output jsonl replays
the log and exits; it is not a watcher. Terminals are durable, never synthesized.
Only text-mode approval with stdin/stdout/stderr all TTY may prompt, with no default.
Machine approval always requires both explicit identity and read-back plan digest.

Exit codes: 0 success; 1 internal defect or unknown code/enum; 2 usage/configuration
(including unavailable web runtime); 3 lease/recovery refusal; 4 preflight/approval/
route/verification gate; 5 retry budget exhausted, blocked at a checkpoint;
6 already closed; 7 already cancelled; 8 unsupported state version;
130 SIGINT; 141 broken pipe. Successful cancel exits 0.
`;

class Output {
  readonly commandId = randomUUID();
  job: JobEnvelope | null = null;
  attempted = false;
  failed: unknown;
  unknown = false;
  lastRefusal: string | undefined;
  readonly io: Io;
  readonly mode: OutputMode;
  command: string;
  readonly abort: AbortController;
  constructor(io: Io, mode: OutputMode, command: string, abort: AbortController) {
    this.io = io;
    this.mode = mode;
    this.command = command;
    this.abort = abort;
  }

  async write(value: unknown) {
    if (this.failed) throw this.failed;
    const line = `${JSON.stringify(redact(value), null, this.mode === "text" ? 2 : undefined)}\n`;
    this.attempted = true;
    try {
      await this.io.stdout.write(line);
    } catch (error) {
      this.failed = error;
      this.abort.abort(error);
      throw error;
    }
  }

  async outcome(outcome: AdapterOutcome) {
    const projected = outcome.ok
      ? outcome
      : {
          ok: false,
          refusal: {
            kind: "refusal",
            phase: this.command === "creds init" ? "doctor" : this.command,
            detail: {},
            ...outcome.refusal,
          },
        };
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      command: this.command,
      commandId: this.commandId,
      job: this.job,
      ...projected,
    };
    if (this.mode === "text" && !outcome.ok) {
      await this.io.stderr.write(`${JSON.stringify(redact(envelope), null, 2)}\n`);
    } else await this.write(envelope);
  }

  async event(event: JobEvent) {
    await this.write({
      schemaVersion: SCHEMA_VERSION,
      command: this.command,
      commandId: this.commandId,
      job: this.job,
      ...event,
    });
    if (event.kind === "refusal" && typeof event.payload.code === "string")
      this.lastRefusal = event.payload.code;
    if (!knownContract(event)) {
      this.unknown = true;
      this.abort.abort();
    }
  }
}

function refusal(code: string, message: string): AdapterOutcome<never> {
  return { ok: false, refusal: { code, message } };
}

function caught(error: unknown): AdapterOutcome<never> {
  // Reader event iteration is the one expected refusal represented by a throw.
  if (error && typeof error === "object" && "refusal" in error) {
    const value = error.refusal;
    if (
      value &&
      typeof value === "object" &&
      "code" in value &&
      typeof value.code === "string" &&
      "message" in value &&
      typeof value.message === "string"
    ) {
      return { ok: false, refusal: value as Omit<Refusal, "code"> & { code: string } };
    }
  }
  if (error instanceof UsageFailure) return refusal("usage", error.message);
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(errorCode(error) ?? ""))
    return refusal("configuration_invalid", "The engine home or job input is not accessible.");
  // Never echo parser input, provider exception messages, stacks or paths that
  // could contain credential bytes or transient URLs.
  return refusal(
    "internal_defect",
    "The command could not complete because of an internal defect.",
  );
}

async function readConfig(path: string): Promise<AdapterOutcome<unknown>> {
  let file;
  try {
    if (![".json", ".toml"].includes(extname(path).toLowerCase()))
      return refusal("configuration_invalid", "Config input must be a .json or .toml file.");
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      return refusal(
        "configuration_invalid",
        "Config input must be a regular file no larger than 4 MiB.",
      );
    const buffer = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > stat.size)
      return refusal("configuration_invalid", "Config input changed while being read.");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    const value: unknown =
      extname(path).toLowerCase() === ".json" ? JSON.parse(source) : parseToml(source);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return refusal(
        "configuration_invalid",
        "Config input must be an object of typed references and job options.",
      );
    return { ok: true, value };
  } catch {
    return refusal(
      "configuration_invalid",
      "Config input could not be read or parsed as UTF-8 TOML or JSON.",
    );
  } finally {
    await file?.close();
  }
}

async function withEvents(
  invocation: Invocation,
  output: Output,
  reader: JobReader,
  operation: () => Promise<AdapterOutcome>,
): Promise<AdapterOutcome> {
  if (invocation.output !== "jsonl") return operation();
  let cursor = invocation.from ?? 0;
  if (invocation.from === undefined) {
    // Capture the existing high-water mark before the writer begins. Replaying
    // previous attempts by default would produce duplicate terminal records.
    for await (const event of reader.events({ follow: false })) cursor = event.cursor;
  }
  const tailAbort = new AbortController();
  let tailFailure: unknown;
  const emit = async (follow: boolean) => {
    for await (const event of reader.events({
      from: cursor,
      follow,
      ...(follow ? { signal: tailAbort.signal } : {}),
    })) {
      await output.event(event);
      cursor = event.cursor;
      if (output.unknown) break;
    }
  };
  // Attach the rejection handler immediately; a broken output aborts execution,
  // but the writer must settle and release its lease before the adapter returns.
  const tail = emit(true).catch((error) => {
    if (tailAbort.signal.aborted && error instanceof Error && error.name === "AbortError") return;
    tailFailure = error;
    output.abort.abort(error);
  });
  let result: AdapterOutcome;
  try {
    result = await operation();
  } catch (error) {
    result = caught(error);
  } finally {
    tailAbort.abort();
    await tail;
  }
  if (tailFailure) throw tailFailure;
  if (!output.unknown) await emit(false); // drain commits made between the final poll and writer release
  return result;
}

async function review(
  reader: JobReader,
  invocation: Invocation,
  status: JobStatus,
  value?: unknown,
): Promise<AdapterOutcome> {
  const query: RowQuery = { ...invocation.query };
  if (query.revision === undefined && query.phase === "plan" && status.planRevision !== null)
    query.revision = status.planRevision;
  const page = await reader.rows(query);
  if (!page.ok) return page;
  return {
    ok: true,
    value: {
      ...(value && typeof value === "object" ? value : {}),
      planDigest: status.planDigest,
      verificationDigest: status.verificationDigest,
      review: buildReviewEnvelope(query, page.value),
    },
  };
}

async function approve(
  invocation: Invocation,
  output: Output,
  engine: Engine,
  reader: JobReader,
  status: JobStatus,
): Promise<AdapterOutcome> {
  const interactive =
    invocation.output === "text" &&
    output.io.stdin.isTTY &&
    output.io.stdout.isTTY &&
    output.io.stderr.isTTY;
  let approver = invocation.approver;
  let planDigest = invocation.planDigest;
  if (interactive) {
    planDigest ??= status.planDigest ?? undefined;
    if (!planDigest) return refusal("approval_required", "Review a plan before approving it.");
    const plan = status.currentPlan;
    if (!plan || plan.planDigest !== planDigest)
      return refusal("approval_required", "Read back the current plan before approving it.");
    const preview = await review(reader, invocation, status, plan);
    if (!preview.ok) return preview;
    await output.io.stderr.write(
      `${JSON.stringify(redact(preview.value), null, 2)}\nApprove plan ${planDigest}. Type yes to approve: `,
    );
    if (
      (await output.io.stdin.readLine(output.abort.signal)) !== "yes" ||
      output.abort.signal.aborted
    )
      return refusal("approval_required", "Approval requires literal yes.");
    approver = `${userInfo().username}@${hostname()}`;
  }
  if (!approver?.trim() || !planDigest?.trim())
    return refusal(
      "approval_required",
      "Unattended approval requires an explicit approver and the plan digest read from plan.",
    );
  const approval = {
    approver,
    planDigest,
    mode: interactive ? ("interactive" as const) : ("unattended" as const),
  };
  const result = await engine.withWriterResult({ id: invocation.jobId! }, (writer) =>
    writer.approve(approval),
  );
  if (!result.ok) return result;
  return review(reader, invocation, status, { ...result.value, plan: status.currentPlan });
}

async function executeCommand(
  invocation: Invocation,
  output: Output,
  engine: Engine,
): Promise<AdapterOutcome> {
  let config: unknown;
  if (invocation.config !== undefined) {
    const input = await readConfig(invocation.config);
    if (!input.ok) return input;
    config = input.value;
  }
  if (invocation.command === "init") {
    const result = await engine.initJob({
      type: invocation.type!,
      ...(invocation.label === undefined ? {} : { label: invocation.label }),
      ...(config === undefined ? {} : { config }),
    });
    if (result.ok) {
      output.job = { id: result.value.id, type: invocation.type! };
      if (invocation.output === "jsonl")
        for await (const event of engine
          .reader(result.value)
          .events({ from: invocation.from ?? 0, follow: false }))
          await output.event(event);
    }
    return result;
  }
  const job = { id: invocation.jobId! };
  output.job = { ...job, type: null };
  const reader = engine.reader(job);
  const status = await reader.status();
  if (!status.ok) return status;
  output.job.type = status.value.jobType;
  if (!knownContract(status.value)) return { ok: true, value: status.value };
  if (invocation.command === "web") {
    return launchWeb({ engine, job });
  }
  if (invocation.command === "status") {
    if (invocation.output === "jsonl") {
      for await (const event of reader.events({
        from: invocation.from ?? 0,
        follow: false,
        signal: output.abort.signal,
      }))
        await output.event(event);
      return status;
    }
    return review(reader, invocation, status.value, status.value);
  }
  if ((invocation.command === "plan" || invocation.command === "verify") && invocation.review)
    return review(
      reader,
      invocation,
      status.value,
      invocation.command === "plan" ? status.value.currentPlan : undefined,
    );
  if (invocation.command === "accept") {
    if (!invocation.verificationDigest)
      return refusal(
        "verification_unaccepted",
        "Acceptance requires the exact verification digest.",
      );
    if (!invocation.approver?.trim() || !invocation.codes.length)
      return refusal("usage", "Acceptance requires an approver and named codes.");
  }
  const result = await withEvents(invocation, output, reader, async () => {
    if (invocation.command === "approve")
      return approve(invocation, output, engine, reader, status.value);
    if (invocation.command === "reclaim")
      return engine.reclaim(job, { confirm: true, stopWorker: invocation.stopWorker });
    return engine.withWriterResult(job, async (writer: JobWriter): Promise<Outcome<unknown>> => {
      switch (invocation.command) {
        case "creds init":
          return writer.onboard(config);
        case "doctor":
          return writer.doctor();
        case "plan":
          return writer.plan();
        case "execute":
          return writer.execute({ signal: output.abort.signal });
        case "verify":
          return writer.verify();
        case "accept":
          return writer.accept({
            verificationDigest: invocation.verificationDigest!,
            approver: invocation.approver!,
            codes: invocation.codes.map((code, index) => ({
              code,
              ...(invocation.notes[index] === undefined ? {} : { note: invocation.notes[index] }),
            })),
          });
        case "report":
          return writer.report();
        case "close":
          return writer.close();
        case "cancel":
          return writer.cancel(invocation.reason ?? "Operator cancelled the job.");
        default:
          throw new Error("Unexpected writer command");
      }
    });
  });
  if (!result.ok) return result;
  if (invocation.command === "execute")
    return { ok: true, value: terminalEnvelopeForExecute(result.value as ExecuteResult) };
  if (invocation.command === "plan" || invocation.command === "verify") {
    const current = await reader.status();
    if (!current.ok) return current;
    return review(reader, invocation, current.value, result.value);
  }
  return result;
}

/** Command-layer seam: argv in, stdout/stderr and exit code out. Engine owns all state. */
export async function run(argv: string[], io: Io, suppliedEngine?: Engine): Promise<number> {
  const abort = new AbortController();
  const onAbort = () => abort.abort(io.signal?.reason);
  io.signal?.addEventListener("abort", onAbort, { once: true });
  if (io.signal?.aborted) onAbort();
  const output = new Output(io, outputMode(argv), commandLabel(argv), abort);
  let engine = suppliedEngine;
  let result: AdapterOutcome;
  let invocation: Invocation | undefined;
  try {
    invocation = parseInvocation(argv);
    if (!invocation.help || output.command !== "help") output.command = invocation.command;
    if (invocation.jobId) output.job = { id: invocation.jobId, type: null };
    if (invocation.help) result = { ok: true, value: { help: HELP } };
    else {
      engine ??= openEngine({ home: invocation.home, adapter: "cli" });
      result = await executeCommand(invocation, output, engine);
    }
  } catch (error) {
    result = caught(error);
  } finally {
    try {
      engine?.close();
    } catch (error) {
      result = caught(error);
    }
    io.signal?.removeEventListener("abort", onAbort);
  }
  const signal = errorCode(io.signal?.reason);
  if (signal === "EPIPE" || errorCode(output.failed) === "EPIPE") return 141;
  if (output.failed) return signal === "SIGINT" ? 130 : 1;
  let code = output.unknown ? 1 : outcomeExit(invocation?.command ?? output.command, result);
  try {
    // JSONL has no synthetic cursor or synthetic terminal. A pre-lease refusal
    // still needs a result envelope when no matching durable refusal was logged.
    if (invocation?.help && output.mode === "text" && result.ok) await io.stdout.write(HELP);
    else if (
      output.mode !== "jsonl" ||
      (!result.ok && output.lastRefusal !== result.refusal.code) ||
      (!output.attempted && result.ok)
    )
      await output.outcome(result);
  } catch (error) {
    if (errorCode(error) === "EPIPE") return 141;
    if (!output.failed && !output.attempted) {
      try {
        await output.outcome(
          refusal("internal_defect", "The command result could not be serialized."),
        );
      } catch (failure) {
        if (errorCode(failure) === "EPIPE") return 141;
      }
    }
    return signal === "SIGINT" ? 130 : 1;
  }
  if (signal === "SIGINT") code = 130;
  if (signal === "SIGTERM") code = 143;
  return code;
}

// npm's POSIX bin is a symlink; emitted .js and source .ts share the same guard.
let direct = false;
if (process.argv[1]) {
  try {
    direct = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    direct = false;
  }
}
if (direct) {
  const transport = processIo();
  try {
    process.exitCode = await run(process.argv.slice(2), transport.io);
  } finally {
    transport.dispose();
  }
}
