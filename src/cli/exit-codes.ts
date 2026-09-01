export const EXIT_CODE_BY_REFUSAL_CODE: Record<string, number> = {
  lease_held: 3,
  foreign_host: 3,
  lease_stale_worker_alive: 3,
  preflight_failed: 4,
  approval_required: 4,
  approval_digest_stale: 4,
  plan_revision_required: 4,
  unqualified_route: 4,
  verification_unaccepted: 4,
  blocked: 5,
  job_closed: 6,
  job_cancelled: 7,
  state_version_unsupported: 8,
};

export function exitCodeForRefusalCode(code: string): number {
  return EXIT_CODE_BY_REFUSAL_CODE[code] ?? 1;
}

export function exitCodeForSignal(signal: "SIGINT" | "EPIPE"): number {
  return signal === "SIGINT" ? 130 : 141;
}
