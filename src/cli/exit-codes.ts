export const EXIT_CODE_BY_REFUSAL_CODE: Record<string, number> = {
  usage: 2,
  configuration_invalid: 2,
  job_not_found: 2,
  local_filesystem_required: 4,
  retry_budget_exhausted: 5,
  web_runtime_unavailable: 2,
  internal_defect: 1,
  lease_held: 3,
  foreign_host: 3,
  lease_stale_worker_alive: 3,
  preflight_failed: 4,
  approval_required: 4,
  approval_digest_stale: 4,
  plan_revision_required: 4,
  cutover_incomplete: 4,
  delete_limit_exceeded: 4,
  unsupported_route: 4,
  drive_creation_ambiguous: 4,
  verification_unaccepted: 4,
  job_closed: 6,
  job_cancelled: 7,
  state_version_unsupported: 8,
};

export function exitCodeForRefusalCode(code: string): number {
  return Object.hasOwn(EXIT_CODE_BY_REFUSAL_CODE, code) ? EXIT_CODE_BY_REFUSAL_CODE[code]! : 1;
}
