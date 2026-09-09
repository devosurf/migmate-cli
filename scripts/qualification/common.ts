import type { ProbeCapture } from "../../src/qualification/bundle.ts";

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
