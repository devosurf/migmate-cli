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
  entry("to_be_deleted", "policy_outcome", "execute", FILE),
  entry("destination_only_retained", "policy_outcome", "plan", FILE),
  entry("source_deleted_destination_retained", "policy_outcome", "plan", FILE),

  // ---- file migration: plan / collision blockers ---------------------------
  entry("mapping_overlap", "finding", "plan", FILE),
  entry("delete_limit_exceeded", "finding", "plan", FILE),
  entry("cutover_incomplete", "finding", "execute", FILE),
  entry("path_unrepresentable", "finding", "plan", FILE),
  entry("destination_duplicate_name", "finding", "plan", FILE),
  entry("destination_type_conflict", "finding", "plan", FILE),
  entry("unowned_path_collision", "finding", "plan", FILE),
  entry("prior_copy_drift", "finding", "plan", FILE),
  entry("source_identity_reuse_collision", "finding", "plan", FILE),

  // ---- file migration: execution / verification findings -------------------
  entry("source_read_failed", "finding", "execute", FILE, true),
  entry("destination_write_failed", "finding", "execute", FILE, true),
  entry("upload_quota_exceeded", "finding", "execute", FILE, true),
  entry("drive_creation_ambiguous", "finding", "execute", FILE),
  entry("go_live_started", "finding", "execute", FILE),
  entry("drive_membership_mismatch", "finding", "verify", FILE),
  entry("destination_read_failed", "finding", "verify", FILE),
  entry("destination_missing", "finding", "verify", FILE),
  entry("destination_path_mismatch", "finding", "verify", FILE),
  entry("provenance_mismatch", "finding", "verify", FILE),
  // The source lists a size its repeatable download contradicts; the copy holds the served bytes.
  entry("source_size_inconsistent", "finding", "verify", FILE),
  entry("size_mismatch", "finding", "verify", FILE),
  entry("content_mismatch", "finding", "verify", FILE),
  entry("destination_rewrote_file", "finding", "verify", FILE),
  entry("metadata_mismatch", "finding", "verify", FILE),
  entry("source_paper_html", "policy_outcome", "verify", FILE),
  entry("source_web_pointer", "policy_outcome", "verify", FILE),
  entry("source_legacy_paper", "finding", "verify", FILE),
  entry("source_unsupported_export", "finding", "verify", FILE),
  entry("source_legacy_paper_scope_unverified", "finding", "verify", FILE),

  // ---- teams archive: policy outcomes --------------------------------------
  entry("collected", "policy_outcome", "execute", TEAMS),
  entry("empty_conversation", "policy_outcome", "execute", TEAMS),
  entry("asset_stored", "policy_outcome", "execute", TEAMS),
  entry("asset_deduplicated_within_conversation", "policy_outcome", "execute", TEAMS),

  // ---- teams archive: planned omissions ------------------------------------
  entry("retained_history_not_requested", "planned_omission", "plan", TEAMS),
  entry("transcript_unsupported_channel_meeting", "planned_omission", "plan", TEAMS),
  entry("attachment_metadata_only", "planned_omission", "plan", TEAMS),
  // Archive destination verification retains its existing exception contract.
  entry("content_verification_degraded", "planned_omission", "verify", TEAMS),

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

const consequences: Record<string, string> = {
  retained_history_not_requested: "Retained historical messages are outside this archive.",
  transcript_unsupported_channel_meeting: "Unsupported channel-meeting transcripts are absent.",
  attachment_metadata_only: "Attachment metadata is retained without attachment bytes.",
  content_verification_degraded: "Archive destination content equality is not fully proven.",
  source_read_failed: "Source content could not be read and may be absent.",
  destination_write_failed: "Destination writes failed; affected content is not proven complete.",
  destination_read_failed:
    "Destination content could not be verified; its required hash evidence is unavailable.",
  drive_membership_mismatch:
    "Destination membership differs from the approved member declarations.",
  destination_missing: "Verified source content is missing from the destination.",
  destination_path_mismatch: "Destination content is stored at a different path.",
  provenance_mismatch: "Destination provenance does not match the expected source.",
  source_size_inconsistent:
    "Source-listed size contradicts downloaded bytes; source parity is qualified.",
  size_mismatch: "Source and destination sizes differ.",
  content_mismatch: "Source and destination content differ.",
  destination_rewrote_file: "The destination rewrote the source file.",
  metadata_mismatch: "Destination metadata differs from the source.",
  source_legacy_paper: "Legacy Paper document content was not migrated.",
  source_unsupported_export:
    "The source document has no supported downloadable export and was not migrated.",
  source_legacy_paper_scope_unverified:
    "Legacy Paper coverage could not be attributed to the selected source namespaces; completeness is unproven.",
  message_collection_incomplete: "The archive does not contain every requested message.",
  hosted_content_unavailable_deleted_thread: "Hosted content from deleted threads is missing.",
  hosted_content_unavailable_retained_message: "Hosted content from retained messages is missing.",
  attachment_content_unavailable: "Some attachment bytes are unavailable.",
  attachment_reference_unresolvable: "Some attachment references cannot be resolved.",
  transcript_unavailable: "Some requested transcripts are unavailable.",
  render_downgraded: "Some messages have reduced rendering fidelity.",
  identity_unresolved: "Some participant identities could not be resolved.",
  record_count_mismatch: "Archive record counts do not match the collected evidence.",
  record_unrendered: "Some collected records are absent from rendered pages.",
  record_duplicated: "Some records appear more than once in rendered pages.",
  asset_missing: "Referenced archive assets are missing.",
  asset_digest_mismatch: "Archive asset bytes do not match their recorded digests.",
  page_parse_failed: "Some archive pages could not be parsed and verified.",
  manifest_digest_mismatch: "Archive manifest evidence does not match the stored content.",
};
/** Acceptance records a limitation, never repairs it or proves successful verification. */
export function exceptionConsequence(code: string): string {
  return (
    consequences[code] ??
    `The ${code.replaceAll("_", " ")} finding remains unresolved; acceptance does not repair affected content or prove completeness.`
  );
}
