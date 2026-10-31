import type { ProviderPort, SourceEntry } from "./port.ts";
import type {
  DestinationConstraintRoot,
  FileProviderCapabilities,
} from "./adapters/capabilities.ts";
import { DiskListing, disposeListing } from "./listing.ts";

export interface DestinationConstraint {
  code: string;
  blocking: boolean;
  /** Original native mapping-relative path, even when several source IDs share it. */
  path: string;
  sourceId: string;
  kind: "file" | "folder";
  detail: Record<string, unknown> & { message: string };
}

type DestinationConstraints = Pick<
  FileProviderCapabilities,
  | "destinationName"
  | "destinationSiblingKey"
  | "destinationNameFindings"
  | "destinationPathFindings"
>;

interface PendingFolder {
  itemId: string;
  path: string;
  encodedPath: string | null;
  blockers: number;
  blockerCount: number;
  position: number;
}

interface SiblingGroup {
  key: string;
  count: number;
  /** Two witnesses suffice; never retain an entire duplicate group. */
  sourceIds: string[];
}

interface ProjectedChild {
  id: string;
  name: string;
  kind: SourceEntry["kind"];
  encodedName: string | null;
  key: string | null;
}

/**
 * Walk native source IDs, not rclone's flattened listing, which can hide duplicate
 * siblings. Planning may defer root path proof; this walk is not a frozen inventory.
 * Only blocking ancestor findings propagate. Every changed descendant path receives
 * its own encoding notice, even if its basename did not change. Listing errors and
 * repeated directory identities refuse the walk, never return partial success.
 *
 * The caller owns the returned disk listing. Native listings and temporary indexes
 * are disposed here, including on abort. Siblings, the traversal stack, inherited
 * blockers and results stay on disk, including duplicate-heavy flat directories.
 */
export async function collectDestinationConstraints(input: {
  provider: Pick<ProviderPort, "listSourceChildren">;
  destination: DestinationConstraints;
  source?: Pick<FileProviderCapabilities, "sourceName">;
  sourceDriveId: string;
  sourceItemId: string;
  root?: DestinationConstraintRoot;
  checkPaths?: boolean;
  signal?: AbortSignal;
}): Promise<DiskListing<DestinationConstraint>> {
  const { provider, destination, source, sourceDriveId, sourceItemId, root, signal } = input;
  const checkPaths = input.checkPaths ?? true;
  const findings = new DiskListing<DestinationConstraint>();
  try {
    signal?.throwIfAborted();
    if (
      !destination.destinationName &&
      !destination.destinationSiblingKey &&
      !destination.destinationNameFindings &&
      !destination.destinationPathFindings
    )
      return findings;

    using pending = new DiskListing<PendingFolder>((folder) => String(folder.position));
    using directories = new DiskListing<string>((id) => JSON.stringify(id));
    using blockers = new DiskListing<{ key: string; finding: DestinationConstraint }>(
      (row) => row.key,
    );
    let sequence = 0;
    let rootBlockerCount = 0;
    for (const finding of destination.destinationPathFindings?.("", "folder", root, {
      checkPaths,
    }) ?? []) {
      const constraint: DestinationConstraint = {
        code: finding.code,
        blocking: true,
        path: "",
        sourceId: sourceItemId,
        kind: "folder",
        detail: { message: finding.message },
      };
      findings.add(constraint);
      blockers.add({ key: JSON.stringify([0, rootBlockerCount++]), finding: constraint });
    }
    // Retain missing-root proof even for an empty source tree.
    pending.add({
      itemId: sourceItemId,
      path: "",
      encodedPath: "",
      blockers: 0,
      blockerCount: rootBlockerCount,
      position: 0,
    });
    directories.add(sourceItemId);
    let pendingCount = 1;
    while (pendingCount > 0) {
      signal?.throwIfAborted();
      const position = String(--pendingCount);
      const parent = pending.get(position)!;
      pending.delete(position);
      using projected = new DiskListing<ProjectedChild>((child) => JSON.stringify(child.id));
      using originals = new DiskListing<SiblingGroup>((group) => group.key);
      using effective = new DiskListing<SiblingGroup>((group) => group.key);
      using memberships = new DiskListing<string>((key) => key);
      const indexSibling = (
        index: DiskListing<SiblingGroup>,
        scope: string,
        name: string,
        id: string,
      ) => {
        // JSON keys preserve native lone surrogates, which SQLite TEXT cannot.
        const membership = JSON.stringify([scope, name, id]);
        if (memberships.has(membership)) return;
        memberships.add(membership);
        const key = JSON.stringify(name);
        const group = index.get(key) ?? { key, count: 0, sourceIds: [] };
        group.count++;
        if (group.sourceIds.length < 2) group.sourceIds.push(id);
        index.delete(key);
        index.add(group);
      };
      const children = await provider.listSourceChildren({
        driveId: sourceDriveId,
        itemId: parent.itemId,
        ...(signal ? { signal } : {}),
      });
      try {
        signal?.throwIfAborted();
        for (const child of children) {
          signal?.throwIfAborted();
          const standardName = !child.name.isWellFormed()
            ? null
            : source?.sourceName
              ? source.sourceName(child.name)
              : child.name;
          const encodedName =
            standardName === null
              ? null
              : (destination.destinationName?.(standardName) ?? standardName);
          const key =
            encodedName === null
              ? null
              : (destination.destinationSiblingKey?.(encodedName) ?? encodedName);
          indexSibling(originals, "original", child.name, child.id);
          if (key !== null) indexSibling(effective, "effective", key, child.id);
          projected.add({
            id: child.id,
            name: child.name,
            // OneNote packages are directories in the transfer backend, including
            // their nested section groups; other package kinds remain files.
            kind:
              child.kind === "package" && child.packageSections !== null ? "folder" : child.kind,
            encodedName,
            key,
          });
        }
      } finally {
        disposeListing(children);
      }
      for (const child of projected) {
        signal?.throwIfAborted();
        const { encodedName, key } = child;
        const path = parent.path ? `${parent.path}/${child.name}` : child.name;
        // Never split a native basename: Google permits a literal slash inside one.
        const encodedPath =
          parent.encodedPath === null || encodedName === null
            ? null
            : parent.encodedPath
              ? `${parent.encodedPath}/${encodedName}`
              : encodedName;
        const kind = child.kind === "folder" ? "folder" : "file";
        const itemSequence = ++sequence;
        let blockerCount = 0;
        const emit = (finding: DestinationConstraint) => {
          findings.add(finding);
          if (finding.blocking)
            blockers.add({ key: JSON.stringify([itemSequence, blockerCount++]), finding });
        };
        for (let index = 0; index < parent.blockerCount; index++) {
          signal?.throwIfAborted();
          const { finding } = blockers.get(JSON.stringify([parent.blockers, index]))!;
          emit({
            code: finding.code,
            blocking: true,
            path,
            sourceId: child.id,
            kind,
            detail: {
              ...finding.detail,
              ancestorPath: finding.detail.ancestorPath ?? finding.path,
              ancestorSourceId: finding.detail.ancestorSourceId ?? finding.sourceId,
            },
          });
        }
        // Deterministic name projection makes an original group a subset of its
        // effective group. Unrepresentable projections still use the native index.
        const group =
          key === null
            ? originals.get(JSON.stringify(child.name))!
            : effective.get(JSON.stringify(key))!;
        // Destinations without a sibling key (Shared Drives) accept duplicate names.
        if (destination.destinationSiblingKey && group.count > 1)
          emit({
            code: "destination_duplicate_name",
            blocking: true,
            path,
            sourceId: child.id,
            kind,
            detail: {
              message:
                "Multiple source siblings resolve to the same destination name; no automatic merge or rename is permitted.",
              siblingSourceIds: group.sourceIds,
              siblingSourceCount: group.count,
            },
          });
        const emitPathFinding = (finding: { code: string; message: string }) => {
          for (let index = 0; index < blockerCount; index++) {
            signal?.throwIfAborted();
            const { finding: existing } = blockers.get(JSON.stringify([itemSequence, index]))!;
            if (existing.code === finding.code && existing.detail.message === finding.message)
              return;
          }
          emit({
            code: finding.code,
            blocking: true,
            path,
            sourceId: child.id,
            kind,
            detail: { message: finding.message },
          });
        };
        if (encodedName === null) {
          emitPathFinding({
            code: "destination_invalid_name",
            message:
              "The source basename cannot be represented in rclone STANDARD losslessly through UTF-8/JSON; repair the source name.",
          });
        } else {
          for (const finding of destination.destinationNameFindings?.(child.name, kind) ?? [])
            emitPathFinding(finding);
          if (encodedName !== child.name)
            for (const finding of destination.destinationNameFindings?.(encodedName, kind) ?? [])
              emitPathFinding(finding);
          if (encodedPath !== null)
            for (const finding of destination.destinationPathFindings?.(encodedPath, kind, root, {
              checkPaths,
            }) ?? [])
              emitPathFinding(finding);
        }
        if (encodedPath !== null && encodedPath !== path)
          emit({
            code: "destination_name_encoded",
            blocking: false,
            path,
            sourceId: child.id,
            kind,
            detail: {
              message: "The transfer backend encodes this source path for the destination.",
              originalName: child.name,
              encodedName,
              originalPath: path,
              encodedPath,
            },
          });
        if (kind === "folder") {
          if (directories.has(JSON.stringify(child.id)))
            throw new Error(
              `Cannot collect destination constraints: repeated source directory identity ${JSON.stringify(child.id)} at ${JSON.stringify(path)}.`,
            );
          directories.add(child.id);
          pending.add({
            itemId: child.id,
            path,
            encodedPath,
            blockers: itemSequence,
            blockerCount,
            position: pendingCount++,
          });
        }
      }
    }
    signal?.throwIfAborted();
    return findings;
  } catch (error) {
    disposeListing(findings);
    throw error;
  }
}
