import type {
  ArtifactSet,
  Engine,
  JobRef,
  JobStatus,
  JobWriter,
  Outcome,
  PlanRevision,
  PreflightReport,
  Refusal,
  RowPage,
  RowQuery,
  Verb,
  VerificationRevision,
} from "../engine/index.ts";
import { VERBS } from "../engine/index.ts";
import { CODE_BY_NAME, isAcceptable } from "../engine/codes.ts";

export interface ViewQuery extends RowQuery {
  stage: Verb;
}
export interface WebSnapshot {
  job: JobRef;
  status: JobStatus | null;
  readonly: boolean;
  busy: string | null;
  refusal: Refusal | null;
  plan: PlanRevision | null;
  preflight: PreflightReport | null;
  verification: VerificationRevision | null;
  artifacts: ArtifactSet | null;
  rows: RowPage | null;
  result: { action: string; value: unknown } | null;
}
export interface WebCommand {
  action: string;
  input: Record<string, unknown>;
}

function invalid(message: string): Outcome<never> {
  return { ok: false, refusal: { code: "configuration_invalid", message } };
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function exact(input: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(input).every((key) => keys.includes(key));
}

/** A window is a viewport. Its Node process holds this callback-scoped lease. */
export class WebSession {
  readonly engine: Engine;
  readonly job: JobRef;
  readonly abort = new AbortController();
  interrupted = false;
  #writer: JobWriter | null = null;
  #lease: Promise<void> | null = null;
  #release: (() => void) | null = null;
  #pending: Promise<void> | null = null;
  #busy: string | null = null;
  #closing = false;
  #refusal: Refusal | null = null;
  #plan: PlanRevision | null = null;
  #preflight: PreflightReport | null = null;
  #verification: VerificationRevision | null = null;
  #result: WebSnapshot["result"] = null;
  #defect: unknown;

  constructor(options: { engine: Engine; job: JobRef }) {
    this.engine = options.engine;
    this.job = Object.freeze({ id: options.job.id });
  }

  async open(): Promise<void> {
    if (this.#closing || this.#writer || this.#lease) return;
    let ready!: () => void;
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const lifetime = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    this.#lease = this.engine
      .withWriter(this.job, async (writer) => {
        this.#writer = writer;
        this.#refusal = null;
        ready();
        await lifetime;
        this.#writer = null;
      })
      .then((outcome) => {
        if (!outcome.ok) this.#refusal = outcome.refusal;
      })
      .catch((error: unknown) => {
        this.#defect = error;
      })
      .finally(() => {
        this.#writer = null;
        this.#lease = null;
        this.#release = null;
        ready();
      });
    await acquired;
    this.#throwDefect();
  }

  async #releaseWriter(): Promise<void> {
    this.#release?.();
    await this.#lease;
  }

  #throwDefect(): void {
    if (this.#defect !== undefined) throw this.#defect;
  }

  /** Closing a window waits; only actual process quit supplies an interrupt. */
  async close(interrupt = false): Promise<void> {
    this.#closing = true;
    if (interrupt) this.abort.abort();
    await this.#pending;
    await this.#releaseWriter();
    this.#throwDefect();
  }

  #validate({ action, input }: WebCommand): Outcome<true> {
    if (
      !VERBS.includes(action as Verb) &&
      !["onboard", "accept", "reclaim", "acquire"].includes(action)
    ) {
      return invalid("Unknown web action.");
    }
    switch (action) {
      case "init":
        return invalid(
          "This page is already bound to its initialized job. Use onboarding to configure it.",
        );
      case "onboard":
        if (
          !exact(input, ["config"]) ||
          !input.config ||
          typeof input.config !== "object" ||
          Array.isArray(input.config)
        )
          return invalid(
            "Onboarding requires a JSON configuration object containing credential references, never secret values.",
          );
        break;
      case "plan":
        if (
          !exact(input, ["final"]) ||
          (input.final !== undefined && typeof input.final !== "boolean")
        )
          return invalid("Final planning requires an explicit boolean final option.");
        break;
      case "approve":
        if (
          !exact(input, [
            "approver",
            "planDigest",
            "confirm",
            "freezeBy",
            "freezeAt",
            "freezeHow",
          ]) ||
          !text(input.approver) ||
          !text(input.planDigest) ||
          input.confirm !== true
        )
          return invalid(
            "Approval requires your identity, the exact reviewed plan digest, and an explicit approval action.",
          );
        if (
          input.freezeBy !== undefined ||
          input.freezeAt !== undefined ||
          input.freezeHow !== undefined
        ) {
          if (
            !text(input.freezeBy) ||
            !text(input.freezeAt) ||
            !text(input.freezeHow) ||
            !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(String(input.freezeAt)) ||
            !Number.isFinite(Date.parse(String(input.freezeAt)))
          )
            return invalid(
              "Freeze attestation requires who, a timestamp with timezone, and how the source was frozen.",
            );
        }
        break;
      case "accept":
        if (
          !exact(input, ["approver", "verificationDigest", "codes"]) ||
          !text(input.approver) ||
          !text(input.verificationDigest) ||
          !Array.isArray(input.codes) ||
          input.codes.length === 0 ||
          input.codes.some((entry: unknown) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
            const item = entry as Record<string, unknown>;
            return (
              !exact(item, ["code", "note"]) ||
              !text(item.code) ||
              !isAcceptable(item.code) ||
              (item.note !== undefined && !text(item.note))
            );
          })
        )
          return invalid(
            "Accept explicitly named registered exception codes against the exact verification digest; accept-all is not supported.",
          );
        break;
      case "cancel":
        if (!exact(input, ["reason", "confirm"]) || !text(input.reason) || input.confirm !== true)
          return invalid(
            "Terminal cancellation requires a reason and explicit confirmation; it never rolls back writes.",
          );
        break;
      case "close":
        if (!exact(input, ["confirm"]) || input.confirm !== true)
          return invalid("Closing a job requires explicit confirmation.");
        break;
      case "reclaim":
        if (
          !exact(input, ["confirm", "stopWorker"]) ||
          input.confirm !== true ||
          (input.stopWorker !== undefined && typeof input.stopWorker !== "boolean")
        )
          return invalid("Reclaim requires explicit acknowledgement of the recovery report.");
        break;
      default:
        if (!exact(input, [])) return invalid("This action does not accept options.");
    }
    return { ok: true, value: true };
  }

  /** Start once, then let the native protocol return while execution continues. */
  command(command: WebCommand): Outcome<{ started: true }> {
    if (this.#closing) return invalid("The window is closing. No new actions can start.");
    if (this.#pending)
      return invalid("An action is already running. Read status while it reaches a checkpoint.");
    const valid = this.#validate(command);
    if (!valid.ok) return valid;
    if (!this.#writer && !["reclaim", "acquire", "status"].includes(command.action)) {
      return {
        ok: false,
        refusal: this.#refusal ?? {
          code: "lease_held",
          message:
            "This window is read-only. Request writer access explicitly before changing the job.",
        },
      };
    }
    this.#busy = command.action;
    this.#pending = this.#perform(command)
      .catch((error: unknown) => {
        this.#defect = error;
      })
      .finally(async () => {
        if (this.#refusal || this.#defect !== undefined) await this.#releaseWriter();
        this.#busy = null;
        this.#pending = null;
      });
    return { ok: true, value: { started: true } };
  }

  async #perform({ action, input }: WebCommand): Promise<void> {
    let result: Outcome<unknown>;
    if (action === "acquire") {
      await this.open();
      return;
    }
    if (action === "reclaim") {
      await this.#releaseWriter();
      result = await this.engine.reclaim(this.job, {
        confirm: true,
        stopWorker: input.stopWorker === true,
      });
      if (result.ok) await this.open();
    } else if (action === "status") {
      result = await this.engine.reader(this.job).status();
    } else {
      const writer = this.#writer;
      if (!writer) return;
      switch (action) {
        case "onboard": {
          this.#preflight = null;
          const outcome = await writer.onboard(input.config);
          if (outcome.ok) this.#preflight = outcome.value;
          this.#plan = null;
          this.#verification = null;
          result = outcome;
          break;
        }
        case "doctor": {
          this.#preflight = null;
          const outcome = await writer.doctor();
          if (outcome.ok) this.#preflight = outcome.value;
          result = outcome;
          break;
        }
        case "plan": {
          const outcome = await writer.plan({
            ...(input.final === true ? { final: true } : {}),
            signal: this.abort.signal,
          });
          if (outcome.ok) this.#plan = outcome.value;
          this.interrupted = !outcome.ok && outcome.refusal.detail?.interrupted === true;
          this.#verification = null;
          result = outcome;
          break;
        }
        case "approve":
          result = await writer.approve({
            approver: String(input.approver),
            planDigest: String(input.planDigest),
            mode: "interactive",
            ...(input.freezeBy !== undefined
              ? {
                  freeze: {
                    by: String(input.freezeBy),
                    at: String(input.freezeAt),
                    how: String(input.freezeHow),
                  },
                }
              : {}),
          });
          break;
        case "execute": {
          this.#verification = null;
          const outcome = await writer.execute({ signal: this.abort.signal });
          if (outcome.ok) this.interrupted = outcome.value.outcome === "interrupted";
          result = outcome;
          break;
        }
        case "verify": {
          const outcome = await writer.verify();
          if (outcome.ok) this.#verification = outcome.value;
          result = outcome;
          break;
        }
        case "accept": {
          const outcome = await writer.accept({
            approver: String(input.approver),
            verificationDigest: String(input.verificationDigest),
            codes: input.codes as { code: string; note?: string }[],
          });
          if (outcome.ok) this.#verification = outcome.value;
          result = outcome;
          break;
        }
        case "report":
          result = await writer.report();
          break;
        case "close":
          result = await writer.close();
          break;
        case "cancel":
          result = await writer.cancel(String(input.reason));
          break;
        default:
          result = invalid("Unknown web action.");
      }
    }
    if (!result.ok) this.#refusal = result.refusal;
    else this.#result = { action, value: result.value };
  }

  async snapshot(query: ViewQuery): Promise<WebSnapshot> {
    this.#throwDefect();
    const reader = this.engine.reader(this.job);
    const status = await reader.status();
    if (!status.ok) this.#refusal = status.refusal;
    let rows: RowPage | null = null;
    let artifacts: ArtifactSet | null = null;
    if (status.ok && ["plan", "approve", "execute", "verify"].includes(query.stage)) {
      const result = await reader.rows(query);
      if (result.ok) {
        rows = result.value;
        const unknown =
          rows.facets.find((facet) => !Object.hasOwn(CODE_BY_NAME, facet.code)) ??
          rows.rows.find((row) => !Object.hasOwn(CODE_BY_NAME, row.code));
        if (unknown)
          this.#refusal = {
            code: "configuration_invalid",
            message: "Unrecognized evidence code; this window is read-only.",
            detail: { code: unknown.code },
          };
      } else this.#refusal = result.refusal;
    }
    if (status.ok && ["report", "close"].includes(query.stage)) {
      const result = await reader.artifacts();
      if (result.ok) artifacts = result.value;
      else this.#refusal = result.refusal;
    }
    if (this.#refusal && !this.#pending) await this.#releaseWriter();
    return {
      job: this.job,
      status: status.ok ? status.value : null,
      readonly: !this.#writer || this.#refusal !== null || this.#closing,
      busy: this.#busy,
      refusal: this.#refusal,
      plan: status.ok
        ? (status.value.currentPlan ??
          (this.#plan?.planDigest === status.value.planDigest ? this.#plan : null))
        : null,
      preflight: this.#preflight,
      verification:
        status.ok && this.#verification?.verificationDigest === status.value.verificationDigest
          ? this.#verification
          : null,
      artifacts,
      rows,
      result: this.#result,
    };
  }
}
