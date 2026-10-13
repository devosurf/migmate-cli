import { ReportText, reportJson } from "./report.ts";
import type { FileMigrationConfig } from "./drivers/file-migration.ts";
import type { Store, FindingRecord, AcceptanceRecord } from "./store/store.ts";
import type { ApprovalRecord, VerificationRevision } from "./types.ts";

interface CsvEvidence {
  store: Store;
  revision: number;
  config: FileMigrationConfig | undefined;
  findings: () => Iterable<FindingRecord>;
  accepted: AcceptanceRecord[];
  approval: ApprovalRecord | null;
  verification: VerificationRevision | null;
}

function* exceptions(evidence: CsvEvidence) {
  const { store, config, approval, accepted } = evidence;
  const acceptedOmissions = store.readPlanAcceptedOmissions(evidence.revision);
  for (const finding of evidence.findings()) {
    if (finding.kind === "policy_outcome") continue;
    const details =
      finding.evidence !== null && typeof finding.evidence === "object"
        ? (finding.evidence as Record<string, unknown>)
        : {};
    const recorded = accepted.find((entry) => entry.code === finding.code);
    const plannedAcceptance =
      finding.phase === "plan" && approval && acceptedOmissions.includes(finding.code);
    const inAdvance =
      plannedAcceptance ||
      recorded?.note ===
        `Accepted in advance by approving plan ${approval?.planDigest} with [options] acceptedOmissions.`;
    const acceptance =
      recorded ??
      (plannedAcceptance ? { approver: approval.approver, note: undefined } : undefined);
    const status = acceptance ? (inAdvance ? "accepted in advance" : "accepted") : "outstanding";
    let located = false;
    for (const mapping of config?.mappings ?? []) {
      const path = store.reportItemPath(
        finding.rev,
        finding.phase,
        mapping.id,
        mapping.sourceDriveId,
        finding.subjectId,
      );
      if (
        path === undefined &&
        finding.subjectId !== mapping.id &&
        details.mappingId !== mapping.id
      )
        continue;
      located = true;
      yield {
        mappingId: mapping.id,
        path: details.path ?? path,
        finding,
        status,
        acceptance,
        reason: details.reason,
      };
    }
    if (!located)
      yield {
        mappingId: undefined,
        path: details.path,
        finding,
        status,
        acceptance,
        reason: details.reason,
      };
  }
}

export function* exceptionsCsv(evidence: CsvEvidence): Generator<string> {
  if (evidence.config?.options?.proof === "rclone")
    yield* csvRow([
      "rclone proof: per-file omission findings are not collected at this proof level.",
    ]);
  yield* csvRow(exceptionColumns);
  for (const item of exceptions(evidence))
    yield* csvRow([
      item.mappingId,
      item.path,
      item.finding.code,
      item.status,
      item.acceptance?.approver,
      item.acceptance?.note,
      item.reason,
    ]);
}

export function* mappingsCsv(evidence: CsvEvidence): Generator<string> {
  yield* csvRow(mappingColumns);
  const { store, revision, config, approval, verification } = evidence;
  const counts = new Map<string, { outstanding: number; accepted: number }>();
  for (const item of exceptions(evidence)) {
    if (item.mappingId === undefined) continue;
    const count = counts.get(item.mappingId) ?? { outstanding: 0, accepted: 0 };
    if (item.status === "outstanding") count.outstanding++;
    else count.accepted++;
    counts.set(item.mappingId, count);
  }
  const resume = store.readReportResume(revision);
  for (const mapping of config?.mappings ?? []) {
    const drive = resume.createdDrives.find((entry) => entry.mappingId === mapping.id);
    const pass = resume.mappingPasses.findLast(
      (entry) => entry.mappingId === mapping.id && entry.status === "completed",
    );
    const count = counts.get(mapping.id) ?? { outstanding: 0, accepted: 0 };
    const grants = resume.memberGrants.filter(
      (entry) => entry.mappingId === mapping.id && entry.at !== undefined,
    );
    const sourceType = mapping.sourceType ?? "sharepoint";
    yield* csvRow([
      mapping.id,
      sourceType,
      mapping.sourceDriveId,
      mapping.sourceFolderPath,
      undefined,
      undefined,
      sourceType === "sharepoint" ? "google_shared_drive" : "sharepoint",
      drive?.driveId ?? mapping.destDriveId,
      drive?.name ?? mapping.createDrive?.name,
      undefined,
      Boolean(drive?.driveId),
      pass?.lastStats?.files,
      pass?.lastStats?.bytes,
      verification ? (count.outstanding + count.accepted ? "findings" : "clean") : undefined,
      count.outstanding,
      count.accepted,
      grants.length ? grants : undefined,
      approval?.freeze?.by,
      approval?.freeze?.at,
      approval?.freeze?.how,
    ]);
  }
}

// Match archive CSV: quote every field, preserving data (including formula prefixes) verbatim.
export function* csvRow(values: readonly unknown[]): Generator<string> {
  for (const [index, value] of values.entries()) {
    if (index) yield ",";
    yield '"';
    const chunks =
      value instanceof ReportText
        ? value.chunks()
        : value !== null && typeof value === "object"
          ? reportJson(value)
          : [value === undefined || value === null ? "" : String(value)];
    for (const chunk of chunks) yield chunk.replaceAll('"', '""');
    yield '"';
  }
  yield "\n";
}

export const mappingColumns = [
  "mapping_id",
  "source_type",
  "source_drive_id",
  "source_folder_path",
  "source_site_name",
  "source_library_name",
  "destination_type",
  "destination_drive_id",
  "destination_name",
  "destination_web_link",
  "created_by_job",
  "files",
  "bytes",
  "verification_outcome",
  "outstanding_exceptions",
  "accepted_exceptions",
  "go_live_member_grants",
  "freeze_by",
  "freeze_at",
  "freeze_how",
];
export const exceptionColumns = [
  "mapping_id",
  "path",
  "code",
  "status",
  "approver",
  "note",
  "reason",
];
