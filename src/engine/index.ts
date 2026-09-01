/**
 * Engine entry point. Internal: absent from `package.json` exports, imported by
 * the CLI and webview adapters by relative path in the same process.
 *
 * This module is the only place that knows how the store, the writer lease, the
 * state chart, and the job-type drivers fit together. Adapters see the seam
 * declared in `engine.ts` and nothing below it.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  Engine,
  EngineOptions,
  JobReader,
  JobWriter,
  PlanOptions,
  ExecuteOptions,
  ReclaimDecision,
} from "./engine.ts";
import {
  ok,
  refuse,
  type AcceptedException,
  type ApprovalRecord,
  type ArtifactSet,
  type Artifact,
  type Closure,
  type ExecuteResult,
  type FacetCount,
  type JobEvent,
  type JobRef,
  type JobSpec,
  type JobStatus,
  type JobType,
  type Outcome,
  type PlanRevision,
  type PreflightReport,
  type RowPage,
  type RowQuery,
  type VerificationRevision,
  type Verb,
} from "./types.ts";
import { isAcceptable } from "./codes.ts";
import { nextState, reconcileOnWriterOpen, refusalForClosedJob } from "./state-chart.ts";
import { openStore, type Store, type FindingRecord } from "./store/store.ts";
import { digestJson } from "./store/digest.ts";
import {
  acquire,
  getHostId,
  getProcessStartTime,
  release,
  reconcileWriterOpen,
  buildRecoveryReport,
  probeWorker,
  processAlive,
} from "./store/lease.ts";
import type { ProviderPort } from "./providers/port.ts";
import type { CommitUnit, DriverContext, JobTypeDriver } from "./drivers/types.ts";
import { fileMigrationDriver, type FileMappingConfig } from "./drivers/file-migration.ts";

export type { Engine, JobReader, JobWriter, EngineOptions, ReclaimDecision } from "./engine.ts";
export * from "./types.ts";

const MIGMATE_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/**
 * Job configuration is operator-authored. The spec's `job.toml` arrives with
 * credential onboarding; until that lands there is no TOML parser in the runtime
 * and inventing one here would be a second config surface to migrate off. The
 * config a job was initialised with is persisted verbatim beside its state.
 */
const CONFIG_FILENAME = "job.config.json";

interface EngineDeps {
  home: string;
  now: () => Date;
  adapter: "cli" | "web";
  provider: ProviderPort | null;
}

interface JobPaths {
  dir: string;
  configPath: string;
  artifactsDir: string;
}

export interface ProvidedEngineOptions extends EngineOptions {
  /**
   * The one substitution seam below the drivers. Real adapters (Graph, the
   * managed transfer worker) are not built yet, so an engine opened without one
   * refuses at preflight rather than pretending a route exists.
   */
  provider?: ProviderPort;
}

export function openEngine(opts: ProvidedEngineOptions): Engine {
  const deps: EngineDeps = {
    home: opts.home,
    now: opts.now ?? (() => new Date()),
    adapter: opts.adapter ?? "cli",
    provider: opts.provider ?? null,
  };
  mkdirSync(join(deps.home, "jobs"), { recursive: true });

  return {
    initJob: (spec) => initJob(deps, spec),
    reader: (ref) => makeReader(deps, ref),
    withWriter: (ref, fn) => withWriter(deps, ref, fn),
    withWriterResult: async (ref, fn) => {
      const outer = await withWriter(deps, ref, fn);
      return outer.ok ? outer.value : outer;
    },
    reclaim: (ref, decision) => reclaimJob(deps, ref, decision),
    close: () => {},
  };
}

function jobPaths(deps: EngineDeps, jobId: string): JobPaths {
  const dir = join(deps.home, "jobs", jobId);
  return {
    dir,
    configPath: join(dir, CONFIG_FILENAME),
    artifactsDir: join(dir, "artifacts"),
  };
}

async function initJob(
  deps: EngineDeps,
  spec: JobSpec & { config?: unknown },
): Promise<Outcome<JobRef>> {
  const id = randomUUID();
  const paths = jobPaths(deps, id);
  mkdirSync(paths.dir, { recursive: true });

  const opened = openStore(paths.dir, { migmateVersion: MIGMATE_VERSION, now: deps.now });
  if (!opened.ok) return opened;

  const store = opened.value;
  try {
    store.writeJob({
      id,
      type: spec.type,
      state: "new",
      schemaVersion: 1,
      migmateVersion: MIGMATE_VERSION,
      label: spec.label ?? null,
      createdAt: deps.now().toISOString(),
      planRevision: null,
      verificationRevision: null,
      lastCheckpoint: null,
    });
    writeFileSync(paths.configPath, `${JSON.stringify(spec.config ?? {}, null, 2)}\n`, "utf8");
    store.appendEvent({ verb: "init", phase: "init", kind: "phase_completed", payload: { id } });
  } finally {
    store.close();
  }

  return ok({ id });
}

/**
 * The config file is outside-controlled input, so it is validated once here and
 * read as a typed value everywhere else. Unknown shapes are dropped rather than
 * trusted: a malformed mapping must not silently become part of a plan digest.
 */
export interface JobConfig {
  mappings: FileMappingConfig[];
  options: Record<string, unknown>;
  route: string;
  guarantees: string;
}

function stringField(value: object, key: string): string | null {
  if (!(key in value)) return null;
  const raw = Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
  return typeof raw === "string" ? raw : null;
}

function parseMapping(raw: unknown): FileMappingConfig | null {
  if (raw === null || typeof raw !== "object") return null;
  const id = stringField(raw, "id");
  const sourceDriveId = stringField(raw, "sourceDriveId");
  const sourceItemId = stringField(raw, "sourceItemId");
  const destDriveId = stringField(raw, "destDriveId");
  const destFolderId = stringField(raw, "destFolderId");
  if (
    id === null ||
    sourceDriveId === null ||
    sourceItemId === null ||
    destDriveId === null ||
    destFolderId === null
  ) {
    return null;
  }

  const exclusionsRaw =
    "exclusions" in raw ? Object.getOwnPropertyDescriptor(raw, "exclusions")?.value : undefined;
  const exclusions = Array.isArray(exclusionsRaw)
    ? exclusionsRaw.filter((e): e is string => typeof e === "string")
    : [];
  return { id, sourceDriveId, sourceItemId, destDriveId, destFolderId, exclusions };
}

function parseJobConfig(raw: unknown): JobConfig {
  const empty: JobConfig = { mappings: [], options: {}, route: "", guarantees: "" };
  if (raw === null || typeof raw !== "object") return empty;

  const mappingsRaw =
    "mappings" in raw ? Object.getOwnPropertyDescriptor(raw, "mappings")?.value : undefined;
  const mappings = Array.isArray(mappingsRaw)
    ? mappingsRaw.map(parseMapping).filter((m): m is FileMappingConfig => m !== null)
    : [];
  const optionsRaw =
    "options" in raw ? Object.getOwnPropertyDescriptor(raw, "options")?.value : undefined;

  return {
    mappings,
    options: optionsRaw !== null && typeof optionsRaw === "object" ? { ...optionsRaw } : {},
    route: stringField(raw, "route") ?? "sharepoint_library_to_shared_drive",
    guarantees: stringField(raw, "guarantees") ?? "default",
  };
}

function readConfig(paths: JobPaths): JobConfig {
  try {
    return parseJobConfig(JSON.parse(readFileSync(paths.configPath, "utf8")) as unknown);
  } catch {
    return parseJobConfig(null);
  }
}

/**
 * The engine deliberately does not know a driver's config type: a driver
 * validates its own config at its own boundary, and TypeScript cannot express
 * that erasure without one cast. Two drivers, statically linked, no string lookup.
 */
function driverFor(type: JobType): JobTypeDriver<never> | null {
  const fileDriver = fileMigrationDriver as JobTypeDriver<never>;
  return type === "file_migration" ? fileDriver : null;
}

function makeReader(deps: EngineDeps, ref: JobRef): JobReader {
  const paths = jobPaths(deps, ref.id);

  async function withStore<T>(fn: (store: Store) => T): Promise<Outcome<T>> {
    const opened = openStore(paths.dir, { migmateVersion: MIGMATE_VERSION, now: deps.now });
    if (!opened.ok) return opened;
    try {
      return ok(fn(opened.value));
    } finally {
      opened.value.close();
    }
  }

  return {
    status: () => withStore((store) => store.status()),
    rows: (q: RowQuery) => withStore((store) => store.rows(q)),
    artifacts: () => withStore(() => readArtifacts(paths)),
    events(q) {
      const opened = openStore(paths.dir, { migmateVersion: MIGMATE_VERSION, now: deps.now });
      if (!opened.ok) {
        // A reader that cannot open the store has no events to stream; the same
        // refusal is reachable through `status()`, which is where callers see it.
        return (async function* empty(): AsyncIterable<JobEvent> {})();
      }
      const store = opened.value;
      return (async function* stream(): AsyncIterable<JobEvent> {
        try {
          yield* store.events(q);
        } finally {
          store.close();
        }
      })();
    },
  };
}

function readArtifacts(paths: JobPaths): ArtifactSet {
  const artifacts: Artifact[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(paths.artifactsDir);
  } catch {
    return { reportDigest: null, artifacts };
  }

  for (const dir of dirs.sort()) {
    const full = join(paths.artifactsDir, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const name of readdirSync(full).sort()) {
      const path = join(full, name);
      const body = readFileSync(path, "utf8");
      artifacts.push({
        name: `${dir}/${name}`,
        format: name.endsWith(".jsonl") ? "jsonl" : name.endsWith(".html") ? "html" : "json",
        path,
        digest: digestJson({ body }),
      });
    }
  }

  const last = artifacts.at(-1);
  return { reportDigest: last ? last.digest : null, artifacts };
}

async function withWriter<T>(
  deps: EngineDeps,
  ref: JobRef,
  fn: (w: JobWriter) => Promise<T>,
): Promise<Outcome<T>> {
  const paths = jobPaths(deps, ref.id);
  const opened = openStore(paths.dir, { migmateVersion: MIGMATE_VERSION, now: deps.now });
  if (!opened.ok) return opened;

  const store = opened.value;
  const hostId = getHostId(deps.home);
  const identity = {
    hostId,
    pid: process.pid,
    processStartTime: getProcessStartTime(),
  };

  try {
    // A durable `executing` with a stale lease is a claim to adjudicate, not a
    // state: reconciliation rewrites it to `interrupted` at the last checkpoint.
    await reconcileWriterOpen(store.db, reconcileOnWriterOpen, {
      now: deps.now,
      probeWorker,
      processAlive,
      hostId,
    });

    const acquired = await acquire(store.db, identity, {
      kind: deps.adapter,
      now: deps.now,
      probeWorker,
      processAlive,
    });
    if (!acquired.ok) return acquired;

    try {
      const writer = makeWriter(deps, store, paths);
      return ok(await fn(writer));
    } finally {
      release(store.db, acquired.value);
    }
  } finally {
    store.close();
  }
}

async function reclaimJob(deps: EngineDeps, ref: JobRef, decision: ReclaimDecision) {
  const paths = jobPaths(deps, ref.id);
  const opened = openStore(paths.dir, { migmateVersion: MIGMATE_VERSION, now: deps.now });
  if (!opened.ok) return opened;

  const store = opened.value;
  try {
    const lease = store.readLease();
    const hostId = getHostId(deps.home);
    if (lease === null) {
      return ok({
        workerAlive: false,
        recordedHostId: hostId,
        thisHostId: hostId,
        holder: null,
        workerGroup: null,
        socketProbed: null,
        workerPid: null,
        lastCheckpoint: store.readJob()?.lastCheckpoint ?? null,
        reclaimable: true,
      });
    }

    const report = await buildRecoveryReport(lease, hostId, {
      now: deps.now,
      probeWorker,
      processAlive,
    });
    if (!report.reclaimable) {
      const code =
        report.recordedHostId !== hostId
          ? "foreign_host"
          : report.workerAlive
            ? "lease_stale_worker_alive"
            : "lease_held";
      return refuse<typeof report>(code, "The job cannot be reclaimed in its current state.", {
        recovery: report,
      });
    }

    if (report.workerAlive && decision.stopWorker !== true) {
      return refuse<typeof report>(
        "lease_stale_worker_alive",
        "A prior worker still answers on the recorded run socket.",
        { recovery: report },
      );
    }

    store.clearLease();
    store.appendEvent({
      verb: "status",
      phase: "status",
      kind: "phase_completed",
      payload: { reclaimed: true },
    });
    return ok(report);
  } finally {
    store.close();
  }
}

function unacceptedBlockingCodes(
  store: Store,
  revision: number,
  verificationDigest: string | null,
): string[] {
  const accepted = new Set(
    verificationDigest === null ? [] : store.readAcceptances(verificationDigest).map((a) => a.code),
  );
  const outstanding = new Set<string>();
  for (const finding of store.readFindings(revision)) {
    if (isAcceptable(finding.code) && !accepted.has(finding.code)) outstanding.add(finding.code);
  }
  return [...outstanding];
}

function makeWriter(deps: EngineDeps, store: Store, paths: JobPaths): JobWriter {
  const config = readConfig(paths);

  function job() {
    const record = store.readJob();
    if (record === null) throw new Error("job record missing");
    return record;
  }

  function guardOpen<T>(): Outcome<T> | null {
    const closed = refusalForClosedJob(job().state);
    return closed === null ? null : refuse<T>(closed, "The job has reached a terminal state.");
  }

  function driverContext(
    provider: ProviderPort,
    revision: number,
    signal?: AbortSignal,
  ): DriverContext<never> {
    // The driver reads its own config shape; the engine only carries it across.
    const ctx: DriverContext<never> = {
      config: config as unknown as never,
      revision,
      resume: { checkpoint: job().lastCheckpoint, watermarks: {} },
      provider,
      now: deps.now,
    };
    return signal === undefined ? ctx : { ...ctx, signal };
  }

  function requireProvider<T>(): { provider: ProviderPort } | Outcome<T> {
    const provider = deps.provider;
    return provider === null
      ? refuse<T>(
          "preflight_failed",
          "No provider adapter is configured for this engine, so no route can be reached.",
          { detail: { check: "provider_adapter_present" } },
        )
      : { provider };
  }

  function isRefusal<T>(r: { provider: ProviderPort } | Outcome<T>): r is Outcome<T> {
    return "ok" in r;
  }

  function moveTo(transition: Parameters<typeof nextState>[1]): void {
    const record = job();
    const target = nextState(record.state, transition);
    if (target === null) throw new Error(`illegal transition ${record.state} --${transition}-->`);
    store.writeJob({ ...record, state: target });
  }

  async function drain(
    units: AsyncIterable<CommitUnit>,
    verb: Verb,
    signal?: AbortSignal,
  ): Promise<{ committed: number; checkpoint: string | null; interrupted: boolean }> {
    let committed = 0;
    let checkpoint: string | null = null;
    for await (const unit of units) {
      const receipt = store.commit(unit);
      if (receipt.applied) committed += 1;
      checkpoint = unit.checkpoint;
      store.writeJob({ ...job(), lastCheckpoint: checkpoint });
      // Interrupt is checked at the commit boundary, never mid-unit: that is what
      // makes an interrupted run resumable rather than half-applied.
      if (signal?.aborted === true) return { committed, checkpoint, interrupted: true };
    }
    store.appendEvent({ verb, phase: verb, kind: "phase_completed", payload: { committed } });
    return { committed, checkpoint, interrupted: false };
  }

  return {
    async doctor(): Promise<Outcome<PreflightReport>> {
      const guard = guardOpen<PreflightReport>();
      if (guard) return guard;
      const resolved = requireProvider<PreflightReport>();
      if (isRefusal(resolved)) return resolved;

      const driver = driverFor(job().type);
      if (driver === null) {
        return refuse<PreflightReport>(
          "preflight_failed",
          "No driver is registered for this job type.",
        );
      }

      const at = deps.now().toISOString();
      const checks = [];
      for await (const check of driver.preflight(
        driverContext(resolved.provider, job().planRevision ?? 0),
      )) {
        checks.push(check);
        store.writeCheckResult({ ...check, verb: "doctor", at });
        store.appendEvent({
          verb: "doctor",
          phase: "doctor",
          kind: "check_result",
          payload: { id: check.id, status: check.status },
        });
      }
      return ok({ passed: checks.every((c) => c.status !== "fail"), checks });
    },

    async plan(_opts?: PlanOptions): Promise<Outcome<PlanRevision>> {
      const guard = guardOpen<PlanRevision>();
      if (guard) return guard;
      const resolved = requireProvider<PlanRevision>();
      if (isRefusal(resolved)) return resolved;

      const preflight = await this.doctor();
      if (!preflight.ok) return preflight;
      if (!preflight.value.passed) {
        return refuse<PlanRevision>("preflight_failed", "Preflight did not pass.", {
          detail: {
            failed: preflight.value.checks.filter((c) => c.status === "fail").map((c) => c.id),
          },
        });
      }

      const driver = driverFor(job().type);
      if (driver === null) return refuse<PlanRevision>("preflight_failed", "No driver registered.");

      const revision = (job().planRevision ?? 0) + 1;
      store.appendEvent({
        verb: "plan",
        phase: "plan",
        kind: "phase_started",
        payload: { revision },
      });
      await drain(driver.collect(driverContext(resolved.provider, revision)), "plan");

      const inputs = planInputs(config);
      const inputsDigest = digestJson(inputs);
      const rows = store.rows({ phase: "plan", revision, limit: 1 });
      const facets = rows.facets;
      const planDigest = digestJson({ inputsDigest, facets, totalRows: rows.totalRows });
      const createdAt = deps.now().toISOString();

      const record = {
        revision,
        planDigest,
        inputsDigest,
        createdAt,
        sourceInventoryAt: createdAt,
        rowCount: rows.totalRows,
        inputs,
        evidence: { facets },
      };
      store.writePlanRevision(record);
      store.writeJob({ ...job(), planRevision: revision });
      moveTo("plan");
      return ok(record);
    },

    async approve(a): Promise<Outcome<ApprovalRecord>> {
      const guard = guardOpen<ApprovalRecord>();
      if (guard) return guard;

      const revision = job().planRevision;
      const current = revision === null ? null : store.readPlanRevision(revision);
      if (current === null) {
        return refuse<ApprovalRecord>("approval_required", "There is no plan to approve.");
      }
      if (current.planDigest !== a.planDigest) {
        return refuse<ApprovalRecord>(
          "approval_digest_stale",
          "The supplied plan digest is not the current revision.",
          { detail: { expected: current.planDigest } },
        );
      }

      const record: ApprovalRecord = {
        revision: current.revision,
        planDigest: current.planDigest,
        approver: a.approver,
        mode: a.mode,
        at: deps.now().toISOString(),
      };
      store.writeApproval(record);
      moveTo("approve");
      return ok(record);
    },

    async execute(opts?: ExecuteOptions): Promise<Outcome<ExecuteResult>> {
      const guard = guardOpen<ExecuteResult>();
      if (guard) return guard;
      const resolved = requireProvider<ExecuteResult>();
      if (isRefusal(resolved)) return resolved;

      const revision = job().planRevision;
      const plan = revision === null ? null : store.readPlanRevision(revision);
      if (plan === null) return refuse<ExecuteResult>("approval_required", "There is no plan.");

      const approval = store.readApproval(plan.revision);
      if (approval === null) {
        return refuse<ExecuteResult>("approval_required", "The plan has not been approved.");
      }
      if (approval.planDigest !== plan.planDigest) {
        return refuse<ExecuteResult>(
          "approval_digest_stale",
          "The approval does not match the current plan revision.",
        );
      }

      const driver = driverFor(job().type);
      if (driver === null)
        return refuse<ExecuteResult>("preflight_failed", "No driver registered.");

      moveTo("execute");
      store.appendEvent({
        verb: "execute",
        phase: "execute",
        kind: "phase_started",
        payload: { revision: plan.revision },
      });

      const drained = await drain(
        driver.execute(driverContext(resolved.provider, plan.revision, opts?.signal)),
        "execute",
        opts?.signal,
      );

      if (drained.interrupted) {
        moveTo("interrupt");
        store.appendEvent({
          verb: "execute",
          phase: "execute",
          kind: "terminal",
          payload: { state: "interrupted", resumable: true },
        });
        return ok({
          outcome: "interrupted",
          checkpoint: drained.checkpoint,
          committedUnits: drained.committed,
        });
      }

      // Verification is the tail of execute, not a separate operator step.
      const verified = await runVerify(
        resolved.provider,
        deps,
        store,
        driver,
        plan.revision,
        config,
      );
      moveTo(verified.clean ? "finish_clean" : "finish_gaps");
      store.appendEvent({
        verb: "execute",
        phase: "verify",
        kind: "terminal",
        payload: { state: "completed", resumable: false, clean: verified.clean },
      });
      return ok({
        outcome: "completed",
        checkpoint: drained.checkpoint,
        committedUnits: drained.committed,
      });
    },

    async verify(): Promise<Outcome<VerificationRevision>> {
      const guard = guardOpen<VerificationRevision>();
      if (guard) return guard;
      const resolved = requireProvider<VerificationRevision>();
      if (isRefusal(resolved)) return resolved;

      const revision = job().planRevision;
      const driver = driverFor(job().type);
      if (revision === null || driver === null) {
        return refuse<VerificationRevision>("approval_required", "There is nothing to verify.");
      }

      const result = await runVerify(resolved.provider, deps, store, driver, revision, config);
      // A fresh verification digest strands prior acceptances: an accepted
      // exception must never outlive the evidence it was accepted against.
      moveTo(result.clean ? "verify_clean" : "verify_gaps");
      return ok(result);
    },

    async accept(x): Promise<Outcome<VerificationRevision>> {
      const guard = guardOpen<VerificationRevision>();
      if (guard) return guard;

      const revision = job().verificationRevision;
      const current = revision === null ? null : store.readVerificationRevision(revision);
      if (current === null || current.verificationDigest !== x.verificationDigest) {
        return refuse<VerificationRevision>(
          "verification_unaccepted",
          "The supplied verification digest is not the current one.",
          { detail: { expected: current?.verificationDigest ?? null } },
        );
      }

      const at = deps.now().toISOString();
      for (const accepted of x.codes) {
        if (!isAcceptable(accepted.code)) {
          return refuse<VerificationRevision>(
            "verification_unaccepted",
            "That code is a policy outcome and is not an acceptable exception.",
            { detail: { code: accepted.code } },
          );
        }
        store.writeAcceptance({
          verificationDigest: x.verificationDigest,
          code: accepted.code,
          approver: x.approver,
          note: accepted.note ?? null,
          at,
        });
      }

      const outstanding = unacceptedBlockingCodes(store, current.planRev, x.verificationDigest);
      const updated = {
        ...current,
        clean: outstanding.length === 0,
        acceptedCodes: store.readAcceptances(x.verificationDigest).map((a) => a.code),
      };
      store.writeVerificationRevision(updated);
      if (outstanding.length === 0) moveTo("accept");
      return ok(updated);
    },

    async report(): Promise<Outcome<ArtifactSet>> {
      const guard = guardOpen<ArtifactSet>();
      if (guard) return guard;

      const revision = job().planRevision ?? 0;
      const dir = join(paths.artifactsDir, `report-${revision}`);
      mkdirSync(dir, { recursive: true });

      const page = store.rows({ phase: "verify", revision, limit: 1000 });
      const findings = store.readFindings(revision);
      const verificationRev = job().verificationRevision;
      const verification =
        verificationRev === null ? null : store.readVerificationRevision(verificationRev);
      const accepted = verification
        ? store.readAcceptances(verification.verificationDigest).map((a) => a.code)
        : [];

      const lines = [
        JSON.stringify({ kind: "job", job: job() }),
        JSON.stringify({ kind: "facets", facets: page.facets }),
        ...findings.map((f: FindingRecord) => JSON.stringify({ kind: "finding", finding: f })),
        JSON.stringify({ kind: "accepted_exceptions", codes: accepted }),
      ];
      writeFileSync(join(dir, "report.jsonl"), `${lines.join("\n")}\n`, "utf8");
      writeFileSync(
        join(dir, "report.html"),
        renderReportHtml(job().id, page.facets, accepted),
        "utf8",
      );

      const artifacts = readArtifacts(paths);
      store.appendEvent({
        verb: "report",
        phase: "report",
        kind: "phase_completed",
        payload: { artifacts: artifacts.artifacts.length },
      });
      return ok(artifacts);
    },

    async close(): Promise<Outcome<Closure>> {
      const guard = guardOpen<Closure>();
      if (guard) return guard;

      const revision = job().planRevision ?? 0;
      const verificationRev = job().verificationRevision;
      const verification =
        verificationRev === null ? null : store.readVerificationRevision(verificationRev);
      const digest = verification?.verificationDigest ?? null;
      const outstanding = unacceptedBlockingCodes(store, revision, digest);
      if (verification === null || outstanding.length > 0) {
        return refuse<Closure>(
          "verification_unaccepted",
          "Closure requires a clean verification or explicitly accepted exceptions.",
          { detail: { outstanding } },
        );
      }

      moveTo("close");
      const closure: Closure = {
        state: "closed",
        at: deps.now().toISOString(),
        acceptedExceptions: store
          .readAcceptances(verification.verificationDigest)
          .map((a) => a.code),
      };
      store.appendEvent({
        verb: "close",
        phase: "close",
        kind: "terminal",
        payload: { state: "completed", resumable: false },
      });
      return ok(closure);
    },

    async cancel(reason: string): Promise<Outcome<Closure>> {
      const guard = guardOpen<Closure>();
      if (guard) return guard;

      moveTo("cancel");
      store.appendEvent({
        verb: "cancel",
        phase: "cancel",
        kind: "terminal",
        payload: { state: "cancelled", resumable: false },
      });
      // Cancel never rolls back destination writes: it is a stop, not an undo.
      return ok({
        state: "cancelled",
        at: deps.now().toISOString(),
        acceptedExceptions: [],
        reason,
      });
    },
  };
}

async function runVerify(
  provider: ProviderPort,
  deps: EngineDeps,
  store: Store,
  driver: JobTypeDriver<never>,
  revision: number,
  config: JobConfig,
): Promise<VerificationRevision & { planRev: number }> {
  const record = store.readJob();
  const ctx: DriverContext<never> = {
    // The driver reads its own config shape; the engine only carries it across.
    config: config as unknown as never,
    revision,
    resume: { checkpoint: record?.lastCheckpoint ?? null, watermarks: {} },
    provider,
    now: deps.now,
  };

  for await (const unit of driver.verify(ctx)) store.commit(unit);

  const page = store.rows({ phase: "verify", revision, limit: 1 });
  const at = deps.now().toISOString();
  const verificationDigest = digestJson({
    revision,
    facets: page.facets,
    totalRows: page.totalRows,
  });
  const outstanding = unacceptedBlockingCodes(store, revision, verificationDigest);
  const nextRev = (record?.verificationRevision ?? 0) + 1;

  const result = {
    revision: nextRev,
    planRev: revision,
    verificationDigest,
    clean: outstanding.length === 0,
    findings: page.facets.filter((f: FacetCount) => f.kind === "finding"),
    acceptedCodes: store.readAcceptances(verificationDigest).map((a) => a.code),
    at,
  };
  store.writeVerificationRevision(result);
  if (record !== null) store.writeJob({ ...record, verificationRevision: nextRev });
  return result;
}

/**
 * Exactly the inputs whose change forces a new plan revision. Everything else a
 * later run discovers is an execution delta against the same approval.
 */
function planInputs(config: JobConfig): Record<string, string> {
  const mappings = config.mappings.map((m) =>
    [m.id, m.sourceDriveId, m.sourceItemId, m.destDriveId, m.destFolderId].join("|"),
  );
  return {
    mappings: mappings.sort().join(","),
    exclusions: config.mappings
      .flatMap((m) => m.exclusions ?? [])
      .sort()
      .join(","),
    options: JSON.stringify(config.options),
    route: config.route,
    guarantees: config.guarantees,
  };
}

function renderReportHtml(jobId: string, facets: FacetCount[], accepted: string[]): string {
  const rows = facets
    .map((f) => `<tr><td>${f.code}</td><td>${f.kind}</td><td>${f.count}</td></tr>`)
    .join("");
  const acceptedList =
    accepted.length === 0
      ? "<p>None.</p>"
      : `<ul>${accepted.map((c) => `<li>${c}</li>`).join("")}</ul>`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>Migmate report</title></head><body>',
    `<h1>Job ${jobId}</h1>`,
    "<h2>Outcomes</h2>",
    `<table><thead><tr><th>Code</th><th>Kind</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>`,
    "<h2>Accepted exceptions</h2>",
    acceptedList,
    "</body></html>",
    "",
  ].join("\n");
}
