import type { CreatedDrive, GoLiveAcknowledgment, GoLiveFailure, GoLiveReview } from "./types.ts";
import { canonicalJson, digestJson } from "./store/digest.ts";

const consequences = {
  drive_membership_mismatch:
    "Membership differs from the approved plan. Acknowledgment accepts the recorded missing, extra or differently privileged access; it does not repair permissions.",
  go_live_check_unavailable:
    "This check could not obtain proof and remains unverified. Acknowledgment does not establish that access or content is correct.",
  destination_drift:
    "Destination content differs from the original verification baseline. Acknowledgment does not establish whether this is legitimate user activity or migration damage.",
} as const;

function failure(drive: CreatedDrive): GoLiveFailure | null {
  const live = drive.goLive;
  const check = live?.check;
  if (
    !drive.driveId ||
    !live ||
    check?.status !== "failed" ||
    !Object.hasOwn(consequences, check.check)
  )
    return null;
  return {
    mappingId: drive.mappingId,
    driveId: drive.driveId,
    startedAt: live.startedAt,
    revision: live.revision,
    verificationAt: live.verificationAt,
    check,
    consequence: consequences[check.check as keyof typeof consequences],
  };
}

function matches(selected: GoLiveFailure, drive: CreatedDrive): boolean {
  const live = drive.goLive;
  if (!live?.check) return false;
  return (
    selected.mappingId === drive.mappingId &&
    selected.driveId === drive.driveId &&
    selected.startedAt === live.startedAt &&
    selected.revision === live.revision &&
    selected.verificationAt === live.verificationAt &&
    canonicalJson(selected.check) === canonicalJson(live.check)
  );
}

/** Settled is not passed: only the exact failed observation can be acknowledged. */
export function goLiveCheckSettled(
  drive: CreatedDrive,
  authorityDigest: string | undefined,
  acknowledgments: GoLiveAcknowledgment[],
): boolean {
  if (drive.goLive?.check?.status === "passed") return true;
  if (!authorityDigest || !failure(drive)) return false;
  return acknowledgments.some(
    (record) =>
      record.authorityDigest === authorityDigest &&
      record.checks.some((selected) => matches(selected, drive)),
  );
}

/** Bind the complete current review, while retaining only explicitly selected checks on submission. */
export function reviewGoLiveFailures(
  drives: CreatedDrive[],
  authorityDigest: string,
  acknowledgments: GoLiveAcknowledgment[],
): GoLiveReview | null {
  const checks: GoLiveFailure[] = [];
  for (const drive of drives) {
    if (goLiveCheckSettled(drive, authorityDigest, acknowledgments)) continue;
    const check = failure(drive);
    if (check) checks.push(check);
  }
  if (!checks.length) return null;
  checks.sort((a, b) => a.mappingId.localeCompare(b.mappingId));
  return { authorityDigest, checks, evidenceDigest: digestJson({ authorityDigest, checks }) };
}
