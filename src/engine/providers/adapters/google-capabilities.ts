import type { FileProviderCapabilities } from "./capabilities.ts";
import { googlePreflight, unreadableSourceDrives } from "./google-preflight.ts";
import type { FileContext } from "../../drivers/file-state.ts";
import type { UploadQuotaStop } from "../../types.ts";

const roles: Record<string, true> = {
  organizer: true,
  fileOrganizer: true,
  writer: true,
  commenter: true,
  reader: true,
};
export const googleCapabilities: FileProviderCapabilities = {
  preflight: googlePreflight,
  unreadableSources: unreadableSourceDrives,
  id: "google_shared_drive",
  rcloneBackend: "drive",
  rootField: "folderId",
  hashType: "sha256",
  ignoreSizeAndChecksum: false,
  uploadQuota: true,
  ledgerAccountedUploads: true,
  quotaStop: uploadQuotaStop,
  creatorRole: "organizer",
  memberRole(role) {
    if (role === "manager") return "organizer";
    return typeof role === "string" && Object.hasOwn(roles, role)
      ? (role as "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader")
      : undefined;
  },
  rewritesPath: () => false,
};
function uploadQuotaStop(ctx: FileContext, error: string | null): UploadQuotaStop | undefined {
  if (!error) return;
  // Match v1.75.0's daily-upload heuristic, not every API rate limit or storage/file cap:
  // https://github.com/rclone/rclone/blob/v1.75.0/backend/drive/drive.go#L945-L982
  // FatalError preserves the Google error text; RC Job.finish serializes err.Error().
  // "Received upload limit error" is a log prefix, NOT a new RC fatal-error message.
  // https://github.com/rclone/rclone/blob/v1.75.0/fs/fserrors/error.go#L98-L130
  // https://github.com/rclone/rclone/blob/v1.75.0/fs/rc/jobs/job.go#L55-L74
  if (
    !/\bquotaExceeded\b/.test(error) &&
    !(
      /\b(?:userRateLimitExceeded|rateLimitExceeded)\b/.test(error) &&
      error.includes("User rate limit exceeded.")
    )
  )
    return;
  const hitAt = ctx.now();
  return {
    code: "upload_quota_exceeded",
    hitAt: hitAt.toISOString(),
    actingGoogleAccount:
      ctx.actingGoogleAccount ?? (ctx.config.impersonate ? (ctx.config.subject ?? null) : null),
    // Google documents a daily allowance, not a reset clock; this is not a retry fence.
    // https://developers.google.com/workspace/drive/api/guides/limits#additional_constraints
    earliestResumeAt: new Date(hitAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    resumeTimeIsEstimate: true,
  };
}
