import type { ProbeCapture } from "./probes.ts";
import type { Stats } from "node:fs";
import { CODE_BY_NAME } from "../../src/engine/codes.ts";
import { canonicalJson } from "../../src/engine/store/digest.ts";

export function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function liveAssertion(
  prefix: string,
  id: string,
  expected: unknown,
  observed: unknown,
): ProbeCapture["assertions"][number] {
  if (!same(expected, observed)) throw new LiveTestBlocked(`${prefix}${id}`);
  return { id, expected, observed };
}

export function registeredCodes(values: Iterable<string>, gate: string): string[] {
  const codes = new Set<string>();
  for (const code of values) {
    if (!Object.hasOwn(CODE_BY_NAME, code)) throw new LiveTestBlocked(gate);
    codes.add(code);
  }
  return [...codes].sort();
}

export function privatePathOwned(info: Stats, kind: "file" | "directory"): boolean {
  return (
    (kind === "file" ? info.isFile() : info.isDirectory()) &&
    !info.isSymbolicLink() &&
    (info.mode & 0o077) === 0 &&
    info.uid === process.getuid?.()
  );
}

/** The operator's explicit consent, required verbatim in every live test config. */
export const LIVE_TEST_ACKNOWLEDGEMENT = "I authorize disposable live test probes";

export interface LiveTestInput {
  config: Record<string, unknown>;
  jobDirectory: string;
  signal: AbortSignal;
  capture: (capture: ProbeCapture) => void;
}

export interface LiveTestResult {
  requiredProbes: string[];
}

/** Only this explicitly selected gate identifier is safe to emit on failure. */
export class LiveTestBlocked extends Error {
  readonly gate: string;
  /** Redacted diagnosis: ids, counts, and statuses only. Never credentials or payloads. */
  readonly detail: Record<string, unknown> | undefined;
  constructor(gate: string, detail?: Record<string, unknown>) {
    super("Live test prerequisites or observed guarantees were not satisfied.");
    this.gate = /^[a-z][a-z0-9_]{0,127}$/.test(gate) ? gate : "live_probe_failed";
    this.detail = detail;
  }
}
