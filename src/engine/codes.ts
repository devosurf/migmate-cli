/**
 * The one public code namespace. Refusals, planned omissions, collection findings,
 * verification findings, and policy outcomes all travel through the same `code`
 * field, disambiguated by `kind` and `phase`.
 *
 * These strings are stable contract. A code is never renamed, never collapsed by
 * acceptance, and never replaced by a catch-all.
 */

import type { CodeKind, JobType, RowPhase } from "./types.ts";

export interface CodeEntry {
  code: string;
  kind: CodeKind;
  phase: RowPhase;
  jobType: JobType;
  /** Whether a run may retry the underlying condition, or must stop and report. */
  retryable: boolean;
}

function entry(
  code: string,
  kind: CodeKind,
  phase: RowPhase,
  jobType: JobType,
  retryable = false,
): CodeEntry {
  return { code, kind, phase, jobType, retryable };
}

const FILE = "file_migration" as const;
const TEAMS = "teams_archive" as const;

export const CODES: readonly CodeEntry[] = [
  // ---- file migration: policy outcomes -------------------------------------
  entry("created", "policy_outcome", "execute", FILE),
  entry("updated", "policy_outcome", "execute", FILE),
  entry("moved", "policy_outcome", "execute", FILE),
  entry("unchanged", "policy_outcome", "execute", FILE),
  entry("destination_only_retained", "policy_outcome", "plan", FILE),
  entry("source_deleted_destination_retained", "policy_outcome", "plan", FILE),

  // ---- file migration: planned omissions -----------------------------------
  entry("source_package_omitted", "planned_omission", "plan", FILE),
  entry("source_reference_omitted", "planned_omission", "plan", FILE),
  entry("source_content_unavailable", "planned_omission", "plan", FILE),
  entry("route_limit_omission", "planned_omission", "plan", FILE),
  entry("version_history_omitted", "planned_omission", "plan", FILE),
  entry("source_metadata_export_only", "planned_omission", "plan", FILE),
  entry("destination_collision_omitted", "planned_omission", "plan", FILE),
  entry("metadata_not_preserved", "planned_omission", "plan", FILE),
  entry("content_verification_degraded", "planned_omission", "verify", FILE),
  entry("omitted_by_rule", "planned_omission", "plan", FILE),

  // ---- file migration: plan / collision blockers ---------------------------
  entry("mapping_overlap", "finding", "plan", FILE),
  entry("path_unrepresentable", "finding", "plan", FILE),
  entry("destination_duplicate_name", "finding", "plan", FILE),
  entry("destination_type_conflict", "finding", "plan", FILE),
  entry("unowned_path_collision", "finding", "plan", FILE),
  entry("prior_copy_drift", "finding", "plan", FILE),
  entry("source_identity_reuse_collision", "finding", "plan", FILE),

  // ---- file migration: execution / verification findings -------------------
  entry("source_read_failed", "finding", "execute", FILE, true),
  entry("destination_write_failed", "finding", "execute", FILE, true),
  entry("drive_creation_ambiguous", "finding", "execute", FILE),
  entry("drive_membership_mismatch", "finding", "verify", FILE),
  entry("destination_missing", "finding", "verify", FILE),
  entry("destination_path_mismatch", "finding", "verify", FILE),
  entry("provenance_mismatch", "finding", "verify", FILE),
  // The source lists a size its repeatable download contradicts; the copy holds the served bytes.
  entry("source_size_inconsistent", "finding", "verify", FILE),
  entry("size_mismatch", "finding", "verify", FILE),
  entry("content_mismatch", "finding", "verify", FILE),
  entry("destination_rewrote_file", "finding", "verify", FILE),
  entry("metadata_mismatch", "finding", "verify", FILE),

  // ---- teams archive: policy outcomes --------------------------------------
  entry("collected", "policy_outcome", "execute", TEAMS),
  entry("empty_conversation", "policy_outcome", "execute", TEAMS),
  entry("asset_stored", "policy_outcome", "execute", TEAMS),
  entry("asset_deduplicated_within_conversation", "policy_outcome", "execute", TEAMS),

  // ---- teams archive: planned omissions ------------------------------------
  entry("retained_history_not_requested", "planned_omission", "plan", TEAMS),
  entry("transcript_unsupported_channel_meeting", "planned_omission", "plan", TEAMS),
  entry("attachment_metadata_only", "planned_omission", "plan", TEAMS),

  // ---- teams archive: collection findings ----------------------------------
  entry("message_collection_incomplete", "finding", "execute", TEAMS, true),
  entry("hosted_content_unavailable_deleted_thread", "finding", "execute", TEAMS),
  entry("hosted_content_unavailable_retained_message", "finding", "execute", TEAMS),
  entry("attachment_content_unavailable", "finding", "execute", TEAMS, true),
  entry("attachment_reference_unresolvable", "finding", "execute", TEAMS),
  entry("transcript_unavailable", "finding", "execute", TEAMS),
  entry("render_downgraded", "finding", "execute", TEAMS),
  entry("identity_unresolved", "finding", "execute", TEAMS),

  // ---- teams archive: verification findings --------------------------------
  entry("record_count_mismatch", "finding", "verify", TEAMS),
  entry("record_unrendered", "finding", "verify", TEAMS),
  entry("record_duplicated", "finding", "verify", TEAMS),
  entry("asset_missing", "finding", "verify", TEAMS),
  entry("asset_digest_mismatch", "finding", "verify", TEAMS),
  entry("page_parse_failed", "finding", "verify", TEAMS),
  entry("manifest_digest_mismatch", "finding", "verify", TEAMS),
];

export const CODE_BY_NAME: Record<string, CodeEntry> = Object.create(null);
for (const code of CODES) CODE_BY_NAME[code.code] = code;

/**
 * A code an operator may accept as an exception, and therefore a code that blocks
 * closure until accepted. Policy outcomes are neither.
 */
export function isAcceptable(code: string): boolean {
  const kind = CODE_BY_NAME[code]?.kind;
  return kind !== undefined && kind !== "policy_outcome";
}
