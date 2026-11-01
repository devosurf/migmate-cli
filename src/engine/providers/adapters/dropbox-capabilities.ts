import type { DestinationPathFinding, FileProviderCapabilities } from "./capabilities.ts";
import type { FileContext } from "../../drivers/file-state.ts";
import type { UploadQuotaStop } from "../../types.ts";
import { dropboxDestinationName, dropboxSourceName } from "./rclone-name-encoding.ts";

// rclone v1.75.0 refuses these before any request; D8 makes them visible blockers.
// https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L1775-L1790
const reserved: Record<string, true> = {
  "desktop.ini": true,
  "thumbs.db": true,
  ".ds_store": true,
  "icon\r": true,
  ".dropbox": true,
  ".dropbox.attr": true,
};

export const dropboxCapabilities: FileProviderCapabilities = {
  id: "dropbox",
  rcloneBackend: "dropbox",
  rootField: "folderPath",
  containerField: "namespaceId",
  // team_folder/create documents no request key; a lost response is never replayed.
  // https://www.dropbox.com/developers/documentation/http/teams#team-team_folder-create
  idempotentCreation: false,
  sourceName: dropboxSourceName,
  destinationName: dropboxDestinationName,
  // Dropbox paths are case-insensitive and case-preserving; rclone's march folds
  // NFC before case, so NFC/NFD twins collide too.
  destinationSiblingKey: (name) => name.normalize("NFC").toLowerCase(),
  destinationNameFindings: nameFindings,
  // rclone's Dropbox hash: SHA-256 over the SHA-256 of each 4 MiB block.
  hashType: "dropbox",
  ignoreSizeAndChecksum: false,
  uploadQuota: false,
  ledgerAccountedUploads: false,
  quotaStop: monthlyUploadStop,
  quotaWhileRunning: true,
  creatorRole: "owner",
  memberRole(role) {
    switch (role) {
      case "reader":
      case "viewer":
        return "viewer";
      case "writer":
      case "editor":
        return "editor";
      default:
        // add_folder_member cannot grant owner, so `manager` is unrepresentable.
        return undefined;
    }
  },
  memberIdentity: "dropbox_group",
  rewritesPath: () => false,
};

// No API path-length or depth ceiling is documented; only rclone's component limit applies.
function nameFindings(name: string): DestinationPathFinding[] {
  if (name.length === 0 || !name.isWellFormed())
    return [
      {
        code: "destination_invalid_name",
        message: "Dropbox cannot represent an empty name or malformed Unicode basename.",
      },
    ];
  if (Object.hasOwn(reserved, name.toLowerCase()))
    return [
      {
        code: "destination_invalid_name",
        message: "Dropbox refuses this reserved file or folder name.",
      },
    ];
  // rclone measures runes after encoding and refuses longer components.
  // https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L1792-L1803
  const runes = [...name].length;
  if (runes > 255)
    return [
      {
        code: "destination_path_too_long",
        message: `This Dropbox path component is ${runes} characters after encoding; at most 255 are allowed.`,
      },
    ];
  return [];
}

/**
 * The per-team monthly upload-call allowance: HTTP 403 `invalid_account_type/feature`.
 * rclone retries it like any error, so the copy pass text is the only signal.
 * https://developers.dropbox.com/dbx-performance-guide#data-transport-limit
 */
function monthlyUploadStop(ctx: FileContext, error: string | null): UploadQuotaStop | undefined {
  if (!error || !/\binvalid_account_type\/feature\b/u.test(error)) return;
  const hitAt = ctx.now();
  return {
    code: "upload_quota_exceeded",
    hitAt: hitAt.toISOString(),
    actingGoogleAccount: null,
    limit: "dropbox_team_monthly_upload_calls",
    // The allowance resets on the first of the month; Dropbox names no time zone,
    // so estimate the latest plausible midnight, US Pacific standard time (08:00 UTC).
    earliestResumeAt: new Date(
      Date.UTC(hitAt.getUTCFullYear(), hitAt.getUTCMonth() + 1, 1, 8),
    ).toISOString(),
    resumeTimeIsEstimate: true,
  };
}
