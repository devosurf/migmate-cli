import type { FileMappingConfig, FileMigrationConfig } from "./drivers/file-migration.ts";
import type { ApprovalAuthority } from "./types.ts";
import type { PlanRevisionRecord } from "./store/store.ts";
import { canonicalJson } from "./store/digest.ts";
import { mappingSourceProvider } from "./providers/adapters/capabilities.ts";
import { containerKey } from "./drivers/created-containers.ts";

function roots(mapping: FileMappingConfig): string {
  return canonicalJson({
    sourceType: mappingSourceProvider(mapping).id,
    sourceDriveId: mapping.sourceDriveId,
    sourceItemId: mapping.sourceItemId,
    sourceFolderPath: mapping.sourceFolderPath,
    destDriveId: mapping.destDriveId,
    destFolderId: mapping.destFolderId,
    destFolderPath: mapping.destFolderPath,
    // Widening a files-only mapping widens what mirror may delete.
    filesOnly: mapping.filesOnly,
    createDrive: mapping.createDrive?.name,
    creationSiteId: mapping.createDrive?.siteId,
    // A move to another folder of the same created container is a new root.
    creationFolderPath: mapping.createDrive?.folderPath,
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
  // ADR-0020 D5: access belongs to a created container, so each change is reviewed once.
  const sharing = (mapping: FileMappingConfig) =>
    (next.mappings ?? []).filter(
      (candidate) =>
        mapping.createDrive &&
        candidate.createDrive &&
        containerKey(candidate.createDrive) === containerKey(mapping.createDrive),
    );
  const reviewed = new Set<string>();
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
        source: `${mapping.sourceDriveId}/${mapping.sourceFolderPath ?? mapping.sourceItemId}${mapping.filesOnly ? " (files only)" : ""}`,
        destination:
          mapping.createDrive?.name ??
          `${mapping.destDriveId}/${mapping.destFolderPath ?? mapping.destFolderId ?? ""}`,
        deleteLimit,
        previousDeleteLimit: previousLimit,
      });
    // Access belongs to the destination, independently of the source mirrored into it.
    const shared = sharing(mapping);
    const previousAccess =
      (previousMapping &&
      previousMapping.destDriveId === mapping.destDriveId &&
      previousMapping.destFolderId === mapping.destFolderId &&
      previousMapping.destFolderPath === mapping.destFolderPath &&
      previousMapping.createDrive?.name === mapping.createDrive?.name &&
      previousMapping.createDrive?.siteId === mapping.createDrive?.siteId
        ? previousMapping.createDrive
        : undefined) ??
      // A mapping joining a container still held by an approved mapping inherits its access;
      // a renamed sole mapping is a new creation identity and is reviewed afresh.
      (mapping.createDrive
        ? previous.mappings?.find(
            (candidate) =>
              candidate.createDrive &&
              containerKey(candidate.createDrive) === containerKey(mapping.createDrive!) &&
              shared.some((kept) => kept.id === candidate.id),
          )?.createDrive
        : undefined);
    for (const member of mapping.createDrive?.members ?? []) {
      const prior = previousAccess?.members.find(
        (candidate) =>
          candidate.email.toLowerCase() === member.email.toLowerCase() &&
          candidate.type === member.type,
      );
      const key = JSON.stringify([
        containerKey(mapping.createDrive!),
        member.email.toLowerCase(),
        member.type,
        member.role,
      ]);
      if (reviewed.has(key)) continue;
      reviewed.add(key);
      if (!prior || (roles[member.role] ?? Infinity) > (roles[prior.role] ?? -1))
        result.accessChanges.push({
          mappingId: mapping.id,
          ...(shared.length > 1 ? { mappingIds: shared.map((candidate) => candidate.id) } : {}),
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
