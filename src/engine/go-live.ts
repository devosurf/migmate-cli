import type {
  CreatedDrive,
  GoLiveAcknowledgment,
  GoLiveCheck,
  GoLiveFailure,
  GoLiveReview,
} from "./types.ts";
import { canonicalJson, digestJson } from "./store/digest.ts";

const consequences = {
  drive_membership_mismatch:
    "Membership differs from the approved plan. Acknowledgment accepts the recorded missing, extra or differently privileged access; it does not repair permissions.",
  go_live_check_unavailable:
    "This check could not obtain proof and remains unverified. Acknowledgment does not establish that access or content is correct.",
  destination_drift:
    "Destination content differs from the original verification baseline. Acknowledgment does not establish whether this is legitimate user activity or migration damage.",
} as const;

const unobservedContent =
  " Destination content was not observed; close still checks it separately against the original verification baseline.";

/** Content passed before this drive's first fence, so post-grant checks cover membership only. */
export function checkedBeforeGrant(drive: CreatedDrive): boolean {
  const { goLive, preGrantCheck } = drive;
  return (
    !!goLive &&
    !!preGrantCheck &&
    preGrantCheck.revision === goLive.revision &&
    preGrantCheck.verificationAt === goLive.verificationAt &&
    preGrantCheck.check.status === "passed" &&
    preGrantCheck.check.check === "destination"
  );
}

/** An already-live membership failure stops before content; that proof remains separate work. */
function contentUnobserved(drive: CreatedDrive): boolean {
  return drive.goLive?.check?.check === "drive_membership_mismatch" && !checkedBeforeGrant(drive);
}

function acknowledgeable(
  drive: CreatedDrive,
  check: GoLiveCheck | undefined,
): check is GoLiveCheck {
  return (
    !!drive.driveId &&
    !!drive.goLive &&
    check?.status === "failed" &&
    Object.hasOwn(consequences, check.check)
  );
}

/** Only the exact recorded failure, under unchanged authority, is acknowledged. */
export function goLiveAcknowledgment(
  drive: CreatedDrive,
  check: GoLiveCheck | undefined,
  authorityDigest: string | undefined,
  acknowledgments: GoLiveAcknowledgment[],
): GoLiveAcknowledgment | undefined {
  const live = drive.goLive;
  if (!authorityDigest || !live || !acknowledgeable(drive, check)) return undefined;
  return acknowledgments.find(
    (record) =>
      record.authorityDigest === authorityDigest &&
      record.checks.some(
        (selected) =>
          selected.mappingId === drive.mappingId &&
          selected.driveId === drive.driveId &&
          selected.startedAt === live.startedAt &&
          selected.revision === live.revision &&
          selected.verificationAt === live.verificationAt &&
          canonicalJson(selected.check) === canonicalJson(check),
      ),
  );
}

function settled(
  drive: CreatedDrive,
  check: GoLiveCheck | undefined,
  authorityDigest: string | undefined,
  acknowledgments: GoLiveAcknowledgment[],
): boolean {
  return (
    check?.status === "passed" ||
    goLiveAcknowledgment(drive, check, authorityDigest, acknowledgments) !== undefined
  );
}

/** The first required post-grant observation that neither passed nor was exactly acknowledged. */
export function unsettledGoLiveCheck(
  drive: CreatedDrive,
  authorityDigest: string | undefined,
  acknowledgments: GoLiveAcknowledgment[],
): "check" | "destinationCheck" | null {
  if (!settled(drive, drive.goLive?.check, authorityDigest, acknowledgments)) return "check";
  if (
    contentUnobserved(drive) &&
    !settled(drive, drive.goLive?.destinationCheck, authorityDigest, acknowledgments)
  )
    return "destinationCheck";
  return null;
}

/** Settled is not passed: a missing required check remains unfinished. */
export function goLiveCheckSettled(
  drive: CreatedDrive,
  authorityDigest: string | undefined,
  acknowledgments: GoLiveAcknowledgment[],
): boolean {
  return unsettledGoLiveCheck(drive, authorityDigest, acknowledgments) === null;
}

/** Bind the complete current review, while retaining only explicitly selected checks on submission. */
export function reviewGoLiveFailures(
  drives: CreatedDrive[],
  authorityDigest: string,
  acknowledgments: GoLiveAcknowledgment[],
): GoLiveReview | null {
  const checks: GoLiveFailure[] = [];
  for (const drive of drives) {
    const slot = unsettledGoLiveCheck(drive, authorityDigest, acknowledgments);
    const check = slot ? drive.goLive?.[slot] : undefined;
    if (!acknowledgeable(drive, check)) continue;
    const live = drive.goLive!;
    checks.push({
      mappingId: drive.mappingId,
      driveId: drive.driveId!,
      startedAt: live.startedAt,
      revision: live.revision,
      verificationAt: live.verificationAt,
      check,
      consequence:
        consequences[check.check as keyof typeof consequences] +
        (slot === "check" && contentUnobserved(drive) ? unobservedContent : ""),
    });
  }
  if (!checks.length) return null;
  checks.sort((a, b) => a.mappingId.localeCompare(b.mappingId));
  return { authorityDigest, checks, evidenceDigest: digestJson({ authorityDigest, checks }) };
}
