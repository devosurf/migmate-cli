import type { FileMappingConfig, FileMigrationConfig } from "./drivers/file-migration.ts";
import type { ApprovalAuthority } from "./types.ts";
import type { PlanRevisionRecord } from "./store/store.ts";
import { canonicalJson } from "./store/digest.ts";
import { mappingSourceProvider } from "./providers/adapters/capabilities.ts";

function roots(mapping: FileMappingConfig): string {
  return canonicalJson({
    sourceType: mappingSourceProvider(mapping).id,
    sourceDriveId: mapping.sourceDriveId,
    sourceItemId: mapping.sourceItemId,
    sourceFolderPath: mapping.sourceFolderPath,
    destDriveId: mapping.destDriveId,
    destFolderId: mapping.destFolderId,
    destFolderPath: mapping.destFolderPath,
    createDrive: mapping.createDrive?.name,
    creationSiteId: mapping.createDrive?.siteId,
  });
}
const roles: Record<string, number> = {
  reader: 0,
  read: 0,
  commenter: 1,
  writer: 2,
  write: 2,
  fileOrganizer: 3,
  organizer: 4,
  owner: 5,
};

/** Compare only immutable, actually approved authority; generated revisions confer none. */
export function approvalAuthority(
  plan: PlanRevisionRecord | null,
  baseline: PlanRevisionRecord | null,
): ApprovalAuthority {
  const next: Partial<FileMigrationConfig> = JSON.parse(plan?.inputs.configuration ?? "{}");
  const previous: Partial<FileMigrationConfig> = JSON.parse(baseline?.inputs.configuration ?? "{}");
  const result: ApprovalAuthority = { mirrorChanges: [], accessChanges: [] };
  for (const mapping of next.mappings ?? []) {
    const previousMapping = previous.mappings?.find((candidate) => candidate.id === mapping.id);
    const old =
      previousMapping && roots(previousMapping) === roots(mapping) ? previousMapping : undefined;
    const previousLimit =
      old && previous.options?.mirror ? (previous.options.deleteLimit ?? 0) : null;
    const deleteLimit = next.options?.deleteLimit ?? 0;
    if (next.options?.mirror && (previousLimit === null || deleteLimit > previousLimit))
      result.mirrorChanges.push({
        mappingId: mapping.id,
        source: `${mapping.sourceDriveId}/${mapping.sourceFolderPath ?? mapping.sourceItemId}`,
        destination:
          mapping.createDrive?.name ??
          `${mapping.destDriveId}/${mapping.destFolderPath ?? mapping.destFolderId ?? ""}`,
        deleteLimit,
        previousDeleteLimit: previousLimit,
      });
    // Access belongs to the destination, independently of the source mirrored into it.
    const previousAccess =
      previousMapping &&
      previousMapping.destDriveId === mapping.destDriveId &&
      previousMapping.destFolderId === mapping.destFolderId &&
      previousMapping.destFolderPath === mapping.destFolderPath &&
      previousMapping.createDrive?.name === mapping.createDrive?.name &&
      previousMapping.createDrive?.siteId === mapping.createDrive?.siteId
        ? previousMapping.createDrive
        : undefined;
    for (const member of mapping.createDrive?.members ?? []) {
      const prior = previousAccess?.members.find(
        (candidate) =>
          candidate.email.toLowerCase() === member.email.toLowerCase() &&
          candidate.type === member.type,
      );
      if (!prior || (roles[member.role] ?? Infinity) > (roles[prior.role] ?? -1))
        result.accessChanges.push({
          mappingId: mapping.id,
          ...member,
          previousRole: prior?.role ?? null,
          timing:
            next.options?.memberGrants ??
            (next.options?.staged ? "after_verification" : "before_copy"),
        });
    }
  }
  return result;
}
