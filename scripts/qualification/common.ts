import type { ProbeCapture } from "../../src/qualification/bundle.ts";
import type { Stats } from "node:fs";
import { CODE_BY_NAME } from "../../src/engine/codes.ts";
import { canonicalJson } from "../../src/engine/store/digest.ts";

export function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function qualificationAssertion(
  prefix: string, id: string, expected: unknown, observed: unknown,
): ProbeCapture["assertions"][number] {
  if (!same(expected, observed)) throw new QualificationBlocked(`${prefix}${id}`);
  return { id, expected, observed };
}

export function registeredCodes(values: Iterable<string>, gate: string): string[] {
  const codes = new Set<string>();
  for (const code of values) {
    if (!Object.hasOwn(CODE_BY_NAME, code)) throw new QualificationBlocked(gate);
    codes.add(code);
  }
  return [...codes].sort();
}

export function privatePathOwned(info: Stats, kind: "file" | "directory"): boolean {
  return (kind === "file" ? info.isFile() : info.isDirectory()) && !info.isSymbolicLink() &&
    (process.platform === "win32" || ((info.mode & 0o077) === 0 && info.uid === process.getuid?.()));
}

export interface QualificationInput {
  config: Record<string, unknown>;
  jobDirectory: string;
  signal: AbortSignal;
  capture: (capture: ProbeCapture) => void;
}

export interface QualificationResult {
  tuple: Record<string, unknown>;
  requiredProbes: string[];
  binarySha256: string;
}

/** Only this explicitly selected gate identifier is safe to emit on failure. */
export class QualificationBlocked extends Error {
  readonly gate: string;
  constructor(gate: string) {
    super("Live qualification prerequisites or observed route guarantees were not satisfied.");
    this.gate = /^[a-z][a-z0-9_]{0,127}$/.test(gate) ? gate : "live_probe_failed";
  }
}
