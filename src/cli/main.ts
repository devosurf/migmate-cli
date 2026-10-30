#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants, realpathSync, readFileSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { hostname, userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import {
  MIGMATE_VERSION,
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
import { unsupportedNode } from "../versions.ts";

export type { Io, IoInput, IoStream } from "./io.ts";

const HELP = `Migmate — one ten-verb lifecycle, two job types

migmate init --type file_migration|teams_archive [--config job.toml|job.json]
migmate creds init --job ID --config job.toml|job.json
migmate manifest load --job ID --file manifest.json|manifest.csv
migmate discover --job ID [--file draft.json]
migmate doctor|plan|execute|status|verify|report|close --job ID
migmate plan --job ID --final               # staged final cutover revision
migmate approve --job ID --approver IDENTITY --plan-digest DIGEST --output json
  [--freeze-by IDENTITY --freeze-at TIMESTAMP --freeze-how TEXT]
migmate approve --job ID                    # human terminal: review, then type yes
migmate accept --job ID                     # human terminal: select groups and rationale
migmate accept --job ID --approver IDENTITY --verification-digest DIGEST --code CODE --note RATIONALE
  [--code CODE ...]                          # unattended; one rationale for the selection
migmate close --job ID                      # human go-live review, or authorized recovery
migmate close --job ID --close-digest DIGEST --approver IDENTITY  # unattended initial close
migmate acknowledge --job ID                # review and acknowledge selected post-grant failures
migmate acknowledge --job ID --go-live-digest DIGEST --mapping ID [--mapping ID ...]
  --note RATIONALE --approver IDENTITY --output json  # explicit unattended acknowledgment
migmate cancel --job ID [--reason TEXT]
migmate reclaim --job ID --confirm [--stop-worker]
migmate web --job ID
migmate --version                           # installed release

All commands: --home PATH, --output text|json|jsonl, --schema-version 1, --help
Home selection: --home > MIGMATE_HOME > nearest .migmate directory in the current
folder or its parents > OS default. A workspace marker must not be a file or symlink.
Create a local workspace and its first job once:
  migmate init --type file_migration --home .migmate --output json
Later commands find it automatically, including from subfolders and new sessions.
Without a workspace, defaults remain macOS ~/Library/Application Support/Migmate;
Linux \${XDG_STATE_HOME:-~/.local/state}/migmate. Any other platform is refused.
Config input is TOML or JSON containing typed file credential references, never secrets.
Only the engine writes job.toml and probes credentials. Init without config creates
an unconfigured job: onboard with creds init before doctor/plan.

Review: plan|verify --review reads existing evidence without taking a writer lease.
--phase plan|execute|verify, --code CODE (repeatable), --search TEXT,
--cursor CURSOR, --limit 1..1000, --sort natural|path|size, --revision N.
status accepts the same row-query flags. Facets cover the whole matching set.
--view mappings pages mapping definitions and their latest copy pass, ordered by id;
--mapping ID selects one mapping (also works with item rows). Default --view items.
JSONL streams durable events live during a verb. --from CURSOR resumes exclusively;
without --from a writer streams only its new attempt. status --output jsonl replays
the log and exits; it is not a watcher. Terminals are durable, never synthesized.
json and jsonl write refusals to stdout; only text mode diverts them to stderr.
Text-mode approve, accept, acknowledge and initial close prompt only with stdin and stderr TTYs
and no explicit evidence digest. Each displays an editable unverified declared identity.
Confirmations have no affirmative default. Explicit digest and identity select unattended
local attestation, not authenticated human authorization. JSON/JSONL never prompt.
Acceptance requires named groups and one non-empty rationale. Matching durable close
authorization permits recovery without a new decision. Freeze attestation flags are unchanged.
Acknowledgment records selected failed checks, not a pass or new access authority.
Unavailable checks remain unverified. Inspect status afterward, then separately retry close.

Exit codes: 0 success; 1 internal defect or unknown code/enum; 2 usage/configuration
(including unavailable web runtime); 3 lease/recovery refusal; 4 preflight/approval/
route/verification gate; 5 retry budget exhausted, blocked at a checkpoint;
6 already closed; 7 already cancelled; 8 unsupported state version;
129 SIGHUP; 130 SIGINT; 141 broken pipe; 143 SIGTERM. Successful cancel exits 0.

SIGHUP/SIGINT/SIGTERM stop foreground work cooperatively, including plan,
execute and verify. After successful cleanup, inspect status and repeat the
interrupted command; execute stays resumable, not cancelled. Partial planning
is not approvable and interrupted verification is not success. SIGHUP exits
129 even if output cannot flush. SIGKILL, host loss or failed worker cleanup
may still require recovery/reclaim; this is not detached execution.
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
  const summary: Record<string, unknown> = value && typeof value === "object" ? { ...value } : {};
  if (query.view === "mappings") delete summary.mappingPasses;
  return {
    ok: true,
    value: {
      ...summary,
      planDigest: status.planDigest,
      verificationDigest: status.verificationDigest,
      review: buildReviewEnvelope(query, page.value),
    },
  };
}

function interactiveDecision(invocation: Invocation, output: Output, digest?: string): boolean {
  return (
    digest === undefined &&
    invocation.output === "text" &&
    output.io.stdin.isTTY &&
    output.io.stderr.isTTY
  );
}

async function answer(output: Output, prompt: string): Promise<string | null> {
  if (output.abort.signal.aborted) return null;
  await output.io.stderr.write(prompt);
  const value = await output.io.stdin.readLine(output.abort.signal);
  return output.abort.signal.aborted ? null : (value?.trim() ?? null);
}

async function confirm(output: Output, prompt: string): Promise<boolean> {
  return (await answer(output, `${prompt} Type yes to confirm: `))?.toLowerCase() === "yes";
}

async function declaredIdentity(
  invocation: Invocation,
  output: Output,
  status: JobStatus,
): Promise<string | null> {
  const suggestion =
    invocation.approver?.trim() ||
    status.lastInteractiveIdentity ||
    `${userInfo().username}@${hostname()}`;
  const value = await answer(
    output,
    `Unverified declared identity [${suggestion}] (Enter to keep, or edit; /cancel to cancel): `,
  );
  return value === null || value === "/cancel" ? null : value || suggestion;
}

function interruptedDecision(): Outcome<never> {
  return {
    ok: false,
    refusal: { code: "approval_required", message: "Decision interrupted before recording." },
  };
}

async function approve(
  invocation: Invocation,
  output: Output,
  engine: Engine,
  reader: JobReader,
  status: JobStatus,
): Promise<AdapterOutcome> {
  const interactive = interactiveDecision(invocation, output, invocation.planDigest);
  let approver = invocation.approver?.trim();
  const planDigest = interactive ? status.planDigest : invocation.planDigest;
  const riskConfirmations: { mirror?: boolean; access?: boolean } = {};
  if (interactive) {
    const plan = status.currentPlan;
    if (!planDigest || !plan || plan.planDigest !== planDigest)
      return refusal("approval_required", "Review a current plan before approving it.");
    const preview = await review(reader, invocation, status, plan);
    if (!preview.ok) return preview;
    await output.io.stderr.write(`${JSON.stringify(redact(preview.value), null, 2)}\n`);
    approver = (await declaredIdentity(invocation, output, status)) ?? undefined;
    if (!approver) return refusal("approval_required", "Approval was cancelled.");
    const authority = status.approvalAuthority;
    if (authority?.mirrorChanges.length) {
      await output.io.stderr.write(
        `Expanded mirror deletion authority (limits, not predicted deletions):\n${JSON.stringify(redact(authority.mirrorChanges), null, 2)}\n`,
      );
      if (
        !(await confirm(
          output,
          `Authorize this changed set of mirror mappings and deletion limits as ${approver} (unverified)?`,
        ))
      )
        return refusal("approval_required", "Mirror authority was not confirmed.");
      riskConfirmations.mirror = true;
    }
    if (authority?.accessChanges.length) {
      await output.io.stderr.write(
        `Expanded access authority (all new grants and escalations):\n${JSON.stringify(redact(authority.accessChanges), null, 2)}\n`,
      );
      if (
        !(await confirm(
          output,
          `Authorize this changed set of identities, roles and grant timing as ${approver} (unverified)?`,
        ))
      )
        return refusal("approval_required", "Access authority was not confirmed.");
      riskConfirmations.access = true;
    }
    if (
      !approver ||
      !(await confirm(output, `Approve reviewed plan ${planDigest} as ${approver} (unverified)?`))
    )
      return refusal("approval_required", "Approval was not confirmed.");
  }
  if (!approver || !planDigest?.trim() || output.abort.signal.aborted)
    return refusal(
      "approval_required",
      "Unattended approval requires --approver and --plan-digest.",
    );
  const result = await engine.withWriterResult({ id: invocation.jobId! }, async (writer) =>
    output.abort.signal.aborted
      ? interruptedDecision()
      : writer.approve({
          approver,
          planDigest,
          mode: interactive ? "interactive" : "unattended",
          ...(interactive ? { riskConfirmations } : {}),
          ...(invocation.freeze ? { freeze: invocation.freeze } : {}),
        }),
  );
  if (!result.ok) return result;
  return review(reader, invocation, status, { ...result.value, plan: status.currentPlan });
}

async function accept(
  invocation: Invocation,
  output: Output,
  engine: Engine,
  status: JobStatus,
): Promise<AdapterOutcome> {
  const interactive = interactiveDecision(invocation, output, invocation.verificationDigest);
  const verificationDigest = interactive
    ? status.verificationDigest
    : invocation.verificationDigest;
  let approver = invocation.approver?.trim();
  let codes = [...new Set(invocation.codes)];
  let rationale = invocation.note?.trim();
  if (interactive) {
    if (!verificationDigest)
      return refusal("verification_unaccepted", "Review current verification before acceptance.");
    const groups = status.exceptionGroups ?? [];
    await output.io.stderr.write(
      `Verification ${verificationDigest}: named exception groups (counts may overlap):\n${JSON.stringify(redact(groups), null, 2)}\n`,
    );
    const selection = await answer(
      output,
      "Select exact codes separated by commas (no default; blank cancels): ",
    );
    codes = [...new Set(selection?.split(",").map((code) => code.trim()) ?? [])];
    if (
      !codes.length ||
      codes.some(
        (code) =>
          !groups.some((group) => group.code === code && group.acceptable && !group.accepted),
      )
    )
      return refusal(
        "verification_unaccepted",
        "Select only named, acceptable, unaccepted groups.",
      );
    rationale =
      (await answer(output, "One required rationale for the selected groups: ")) ?? undefined;
    if (!rationale || rationale === "/cancel")
      return refusal("verification_unaccepted", "Acceptance requires a non-empty rationale.");
    await output.io.stderr.write(
      `Selected ${codes.length} groups; affected-item counts per group (not distinct totals):\n${JSON.stringify(redact(groups.filter((group) => codes.includes(group.code))), null, 2)}\nRationale: ${rationale}\n`,
    );
    approver = (await declaredIdentity(invocation, output, status)) ?? undefined;
    if (
      !approver ||
      !(await confirm(
        output,
        `Accept ${codes.length} selected groups as ${approver} (unverified)?`,
      ))
    )
      return refusal("verification_unaccepted", "Acceptance was not confirmed.");
  }
  if (
    !verificationDigest?.trim() ||
    !approver ||
    !codes.length ||
    codes.some((code) => !code.trim()) ||
    !rationale ||
    output.abort.signal.aborted
  )
    return refusal(
      "verification_unaccepted",
      "Unattended acceptance requires --verification-digest, --approver, named --code values and one non-empty --note rationale.",
    );
  return engine.withWriterResult({ id: invocation.jobId! }, async (writer) =>
    output.abort.signal.aborted
      ? interruptedDecision()
      : writer.accept({
          verificationDigest,
          approver,
          codes,
          rationale,
          mode: interactive ? "interactive" : "unattended",
        }),
  );
}

async function acknowledge(
  invocation: Invocation,
  output: Output,
  engine: Engine,
  status: JobStatus,
): Promise<AdapterOutcome> {
  const interactive = interactiveDecision(invocation, output, invocation.goLiveDigest);
  const review = status.goLiveReview;
  const evidenceDigest = interactive ? review?.evidenceDigest : invocation.goLiveDigest;
  let mappingIds = [...new Set(invocation.mappingIds)];
  let rationale = invocation.note?.trim();
  let approver = invocation.approver?.trim();
  if (interactive) {
    if (!evidenceDigest || !review?.checks.length)
      return refusal("verification_unaccepted", "No eligible post-grant failures to acknowledge.");
    await output.io.stderr.write(
      `Post-grant failure evidence and consequences (unavailable checks remain unverified; acknowledgment does not make a check pass):\n${JSON.stringify(redact(review), null, 2)}\nFailures:\n${review.checks.map((check, index) => `  ${index + 1}. ${JSON.stringify(redact(check.mappingId))} · ${check.check.check}\n`).join("")}`,
    );
    // Numbers, not IDs: valid mapping IDs may contain commas or surrounding whitespace.
    const selection = await answer(
      output,
      "Select failure numbers separated by commas or spaces (no default; blank cancels): ",
    );
    const numbers = selection?.split(/[\s,]+/u).filter(Boolean) ?? [];
    if (
      !numbers.length ||
      numbers.some((number) => !/^[1-9]\d*$/u.test(number) || Number(number) > review.checks.length)
    )
      return refusal(
        "verification_unaccepted",
        "Select only displayed failure numbers from this review.",
      );
    mappingIds = [
      ...new Set(numbers.map((number) => review.checks[Number(number) - 1]!.mappingId)),
    ];
    rationale =
      (await answer(output, "One required rationale for the selected failures: ")) ?? undefined;
    if (!rationale || rationale === "/cancel")
      return refusal("verification_unaccepted", "Acknowledgment requires a non-empty rationale.");
    await output.io.stderr.write(
      `Selected failures:\n${JSON.stringify(redact(review.checks.filter((check) => mappingIds.includes(check.mappingId))), null, 2)}\nRationale: ${rationale}\n`,
    );
    approver = (await declaredIdentity(invocation, output, status)) ?? undefined;
    if (
      !approver ||
      !(await confirm(
        output,
        `Acknowledge ${mappingIds.length} selected post-grant failures as ${approver} (unverified)?`,
      ))
    )
      return refusal("verification_unaccepted", "Acknowledgment was not confirmed.");
  }
  if (
    !evidenceDigest?.trim() ||
    !mappingIds.length ||
    mappingIds.some((id) => !id.trim()) ||
    !rationale ||
    !approver ||
    output.abort.signal.aborted
  )
    return refusal(
      "verification_unaccepted",
      "Unattended acknowledgment requires --go-live-digest, named --mapping values, one non-empty --note rationale and --approver.",
    );
  return engine.withWriterResult({ id: invocation.jobId! }, async (writer) =>
    output.abort.signal.aborted
      ? interruptedDecision()
      : writer.acknowledgeGoLive({
          evidenceDigest,
          mappingIds,
          rationale,
          approver,
          mode: interactive ? "interactive" : "unattended",
        }),
  );
}

async function close(
  invocation: Invocation,
  output: Output,
  engine: Engine,
  status: JobStatus,
): Promise<AdapterOutcome> {
  const review = status.closeReview;
  if (
    invocation.closeDigest === undefined &&
    review?.authorized &&
    status.closeAuthorization?.evidenceDigest === review.evidenceDigest
  )
    return engine.withWriterResult({ id: invocation.jobId! }, async (writer) =>
      output.abort.signal.aborted ? interruptedDecision() : writer.close(),
    );
  const interactive = interactiveDecision(invocation, output, invocation.closeDigest);
  const evidenceDigest = interactive ? review?.evidenceDigest : invocation.closeDigest;
  let approver = invocation.approver?.trim();
  if (interactive) {
    if (!review)
      return refusal("approval_required", "Review current close evidence before go-live.");
    await output.io.stderr.write(
      `Go-live review:\n${JSON.stringify(
        redact({
          closeReview: review,
          verificationDigest: status.verificationDigest,
          exceptionGroups: status.exceptionGroups,
          acceptedExceptions: status.acceptedExceptions,
        }),
        null,
        2,
      )}\n`,
    );
    approver = (await declaredIdentity(invocation, output, status)) ?? undefined;
    if (
      !approver ||
      !(await confirm(
        output,
        `Authorize initial go-live and the reviewed access consequences as ${approver} (unverified)?`,
      ))
    )
      return refusal("approval_required", "Go-live was not confirmed.");
  }
  if (!evidenceDigest?.trim() || !approver || output.abort.signal.aborted)
    return refusal(
      "approval_required",
      "Initial unattended close requires --close-digest and --approver.",
    );
  return engine.withWriterResult({ id: invocation.jobId! }, async (writer) =>
    output.abort.signal.aborted
      ? interruptedDecision()
      : writer.close({
          evidenceDigest,
          approver,
          signal: output.abort.signal,
          mode: interactive ? "interactive" : "unattended",
          ...(interactive ? { confirmGoLive: true } : {}),
        }),
  );
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
  if (invocation.command === "discover") {
    const result = await reader.discover();
    if (!result.ok) return result;
    if (invocation.file) {
      try {
        await writeFile(invocation.file, `${JSON.stringify(result.value.manifest, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
      } catch {
        return refusal(
          "configuration_invalid",
          "The draft file could not be created; choose a new writable path.",
        );
      }
    }
    return result;
  }
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
  const result = await withEvents(invocation, output, reader, async () => {
    if (invocation.command === "approve")
      return approve(invocation, output, engine, reader, status.value);
    if (invocation.command === "accept") return accept(invocation, output, engine, status.value);
    if (invocation.command === "acknowledge")
      return acknowledge(invocation, output, engine, status.value);
    if (invocation.command === "close") return close(invocation, output, engine, status.value);
    if (invocation.command === "reclaim")
      return engine.reclaim(job, { confirm: true, stopWorker: invocation.stopWorker });
    return engine.withWriterResult(job, async (writer: JobWriter): Promise<Outcome<unknown>> => {
      switch (invocation.command) {
        case "manifest load": {
          const format = extname(invocation.file!).toLowerCase().slice(1);
          if (format !== "json" && format !== "csv")
            return {
              ok: false,
              refusal: {
                code: "configuration_invalid",
                message: "Manifest files must use .json or .csv.",
                detail: { row: 0, field: "file" },
              },
            };
          let content: string;
          try {
            content = readFileSync(invocation.file!, "utf8");
          } catch {
            return {
              ok: false,
              refusal: {
                code: "configuration_invalid",
                message: "The manifest file could not be read.",
                detail: { row: 0, field: "file" },
              },
            };
          }
          return writer.loadManifest({ content, format });
        }
        case "creds init":
          return writer.onboard(config);
        case "doctor":
          return writer.doctor();
        case "plan":
          return writer.plan({
            ...(invocation.final ? { final: true } : {}),
            signal: output.abort.signal,
          });
        case "execute":
          return writer.execute({ signal: output.abort.signal });
        case "verify":
          return writer.verify({ signal: output.abort.signal });
        case "report":
          return writer.report();
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
    // Answered before the Node floor and the store, like help, so a bug report can
    // always name the release.
    else if (invocation.command === "version")
      result = { ok: true, value: { version: MIGMATE_VERSION } };
    else {
      // The durable store is node:sqlite, a release-candidate API. A runtime below
      // its floor refuses here rather than reaching the store, and --help still
      // answers so an operator can read the requirement off the tool itself.
      const unsupported = unsupportedNode();
      if (unsupported !== null) throw new UsageFailure(unsupported);
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
  const signalExit =
    signal === "SIGHUP" ? 129 : signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : undefined;
  if (signal === "EPIPE" || errorCode(output.failed) === "EPIPE") return signalExit ?? 141;
  if (output.failed) return signalExit ?? 1;
  const code = output.unknown ? 1 : outcomeExit(invocation?.command ?? output.command, result);
  try {
    // JSONL has no synthetic cursor or synthetic terminal. A pre-lease refusal
    // still needs a result envelope when no matching durable refusal was logged.
    if (invocation?.help && output.mode === "text" && result.ok) await io.stdout.write(HELP);
    else if (invocation?.command === "version" && output.mode === "text" && result.ok)
      await io.stdout.write(`${MIGMATE_VERSION}\n`);
    else if (
      output.mode !== "jsonl" ||
      (!result.ok && output.lastRefusal !== result.refusal.code) ||
      (!output.attempted && result.ok)
    )
      await output.outcome(result);
  } catch (error) {
    if (errorCode(error) === "EPIPE") return signalExit ?? 141;
    if (!output.failed && !output.attempted) {
      try {
        await output.outcome(
          refusal("internal_defect", "The command result could not be serialized."),
        );
      } catch (failure) {
        if (errorCode(failure) === "EPIPE") return signalExit ?? 141;
      }
    }
    return signalExit ?? 1;
  }
  return signalExit ?? code;
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
  // Engine cleanup and bounded output writes have finished. A pending OS pipe
  // write must not keep an interrupted foreground process alive.
  if (transport.io.signal?.aborted) process.exit(process.exitCode);
}
