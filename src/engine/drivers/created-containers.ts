import { creationKey } from "../manifest.ts";
import type { CreatedDrive } from "../types.ts";

interface Creation {
  name: string;
  siteId?: string;
  folderPath?: string;
}
interface Creating {
  id: string;
  createDrive?: Creation;
}

/** ADR-0020 D5: one created container per name and parent, whichever mapping created it. */
export function containerKey(creation: { name: string; siteId?: string }): string {
  return creationKey({
    name: creation.name,
    ...(creation.siteId ? { siteId: creation.siteId } : {}),
  });
}

/**
 * A mapping's container record. Its own comes first, so a job from before shared
 * containers keeps each mapping's container even where two share a name.
 */
export function createdDriveFor<T extends CreatedDrive>(
  drives: readonly T[] | undefined,
  mapping: Creating,
): T | undefined {
  if (!mapping.createDrive || !drives) return undefined;
  const key = containerKey(mapping.createDrive);
  return (
    drives.find((drive) => drive.mappingId === mapping.id) ??
    drives.find((drive) => containerKey(drive) === key)
  );
}

/** Mappings grouped by the container they write into, in mapping order. */
export function createdContainers<M extends Creating>(
  drives: readonly CreatedDrive[] | undefined,
  mappings: readonly M[],
): { key: string; drive: CreatedDrive | undefined; mappings: M[] }[] {
  const groups = new Map<string, { key: string; drive: CreatedDrive | undefined; mappings: M[] }>();
  for (const mapping of mappings) {
    if (!mapping.createDrive) continue;
    const drive = createdDriveFor(drives, mapping);
    // A record names its container; before one exists, the creation key does.
    const key = drive ? `record:${drive.mappingId}` : `key:${containerKey(mapping.createDrive)}`;
    const group = groups.get(key) ?? { key, drive, mappings: [] };
    group.mappings.push(mapping);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The mappings writing into the same container as this one, itself included. */
export function sharingMappings<M extends Creating>(
  drives: readonly CreatedDrive[] | undefined,
  mappings: readonly M[],
  mapping: Creating,
): M[] {
  return (
    createdContainers(drives, mappings).find((group) =>
      group.mappings.some((candidate) => candidate.id === mapping.id),
    )?.mappings ?? []
  );
}

/** The container root's folder identity; it differs from the container's on SharePoint and Dropbox. */
export function containerRootId(drive: CreatedDrive): string | undefined {
  return drive.rootFolderId ?? drive.driveId ?? undefined;
}

/** The folder a mapping writes into: the container root, or its recorded folder once created. */
export function mappingFolderId(drive: CreatedDrive, mapping: Creating): string | undefined {
  const path = mapping.createDrive?.folderPath;
  return path ? drive.folders?.[path] : containerRootId(drive);
}

/** A created mapping's destination once its container and folder exist; otherwise unchanged. */
export function provisionedDestination<M extends Creating>(
  drives: readonly CreatedDrive[] | undefined,
  mapping: M,
): M {
  const drive = createdDriveFor(drives, mapping);
  const folder = drive?.driveId ? mappingFolderId(drive, mapping) : undefined;
  return drive?.driveId && folder
    ? { ...mapping, destDriveId: drive.driveId, destFolderId: folder }
    : mapping;
}
