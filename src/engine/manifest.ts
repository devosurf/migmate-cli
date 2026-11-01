import type { FileMappingConfig } from "./drivers/file-migration.ts";
import { digestJson } from "./store/digest.ts";
import type { DriveMember, ProviderPort } from "./providers/port.ts";
import { ProviderFault } from "./providers/fault.ts";
import {
  fileProvider,
  fileProviderPair,
  mappingSourceProvider,
  type FileProviderId,
} from "./providers/adapters/capabilities.ts";

export type ManifestRoot = { type: FileProviderId; driveId: string } & (
  { folderPath: string } | { folderId: string }
);
/**
 * A container the job creates. Rows naming the same type, name and parent share one
 * container (ADR-0020 D5), each in its own folder, and must name the same members.
 */
export interface ManifestCreation {
  type: FileProviderId;
  create: string;
  siteId?: string;
  /** The mapping's folder inside the created container; absent means its root. */
  folderPath?: string;
}
export interface ManifestMapping {
  id: string;
  source: ManifestRoot;
  destination: ManifestRoot | ManifestCreation;
  members?: DriveMember[];
  /** ADR-0020 D4: only the files directly inside the source root, not its subfolders. */
  filesOnly?: true;
}

/** One created container per type, name and parent: rows with equal keys share it. */
export function creationKey(destination: {
  type?: string;
  create?: string;
  name?: string;
  siteId?: string;
}): string {
  return JSON.stringify([
    destination.type ?? null,
    destination.create ?? destination.name ?? null,
    destination.siteId ?? null,
  ]);
}
export interface LoadedManifest {
  mappingCount: number;
  manifestDigest: string;
  planRevision: number | null;
}
export interface StoredMappings {
  digest: string;
  mappings: FileMappingConfig[];
}
export class ManifestError extends Error {
  readonly code = "configuration_invalid";
  readonly detail: { row: number; field: string };
  constructor(row: number, field: string, message = "Invalid or unsupported manifest field") {
    super(`${message}: row ${row}, field ${field}.`);
    this.detail = { row, field };
  }
}
const columns = [
  "id",
  "source.type",
  "source.driveId",
  "source.folderPath",
  "destination.type",
  "destination.driveId",
  "destination.folderId",
  "destination.create",
  "members",
  "source.folderId",
  "destination.folderPath",
  "destination.siteId",
  "filesOnly",
];
function csv(text: string): unknown {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === undefined) throw new ManifestError(rows.length, columns[row.length] ?? "csv");
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
    } else if (c === "," || c === "\n" || c === "\r" || c === undefined) {
      row.push(cell);
      cell = "";
      closed = false;
      if (c !== ",") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (c !== undefined || row.length !== 1 || row[0] !== "") rows.push(row);
        row = [];
      }
    } else if (c === '"' && cell === "" && !closed) quoted = true;
    else if (closed || c === '"')
      throw new ManifestError(rows.length, columns[row.length] ?? "csv");
    else cell += c;
  }
  const header = rows.shift();
  const namespaceHeader = columns.map((column) =>
    column === "source.driveId" ? "source.namespaceId" : column,
  );
  if (
    JSON.stringify(header) !== JSON.stringify(columns) &&
    JSON.stringify(header) !== JSON.stringify(columns.slice(0, 12)) &&
    JSON.stringify(header) !== JSON.stringify(columns.slice(0, 11)) &&
    JSON.stringify(header) !== JSON.stringify(columns.slice(0, 7)) &&
    JSON.stringify(header) !== JSON.stringify(columns.slice(0, 9)) &&
    JSON.stringify(header) !== JSON.stringify(namespaceHeader) &&
    JSON.stringify(header) !== JSON.stringify(namespaceHeader.slice(0, 12))
  )
    throw new ManifestError(0, "header");
  return {
    version: 1,
    mappings: rows.map((r, i) => {
      if (r.length !== header!.length) throw new ManifestError(i + 1, "columns");
      let members: unknown;
      // Only the literal "true" marks a files-only row; anything else names the field.
      if (r[12] !== undefined && r[12] !== "" && r[12] !== "true")
        throw new ManifestError(i + 1, "filesOnly");
      if (r[8]) {
        try {
          members = JSON.parse(r[8]);
        } catch {
          throw new ManifestError(i + 1, "members");
        }
      }
      return {
        id: r[0],
        source:
          fileProviderPair({ sourceProvider: r[1], destinationProvider: r[4] }).source.rootField ===
          "folderId"
            ? { type: r[1], driveId: r[2], folderId: r[9], ...(r[3] ? { folderPath: r[3] } : {}) }
            : {
                type: r[1],
                [fileProviderPair({ sourceProvider: r[1], destinationProvider: r[4] }).source
                  .containerField ?? "driveId"]: r[2],
                folderPath: r[3],
                ...(r[9] ? { folderId: r[9] } : {}),
              },
        destination: {
          type: r[4],
          ...(r[7] ? { create: r[7] } : {}),
          ...(r[11] ? { siteId: r[11] } : {}),
          ...(r[5] || !r[7]
            ? {
                [fileProviderPair({ sourceProvider: r[1], destinationProvider: r[4] }).destination
                  .containerField ?? "driveId"]: r[5],
              }
            : {}),
          ...(fileProviderPair({ sourceProvider: r[1], destinationProvider: r[4] }).destination
            .rootField === "folderPath"
            ? {
                ...(!r[7] || r[10] ? { folderPath: r[10] } : {}),
                ...(r[6] ? { folderId: r[6] } : {}),
              }
            : {
                ...(r[6] || !r[7] ? { folderId: r[6] } : {}),
                ...(r[10] ? { folderPath: r[10] } : {}),
              }),
        },
        ...(members !== undefined ? { members } : {}),
        ...(r[12] === "true" ? { filesOnly: true } : {}),
      };
    }),
  };
}
export function parseManifest(
  content: string,
  format: "json" | "csv",
): { mappings: ManifestMapping[]; digest: string } {
  let raw: unknown;
  try {
    raw = format === "csv" ? csv(content) : JSON.parse(content);
  } catch (error) {
    if (error instanceof ManifestError || error instanceof ProviderFault) throw error;
    throw new ManifestError(0, "json");
  }
  function object(
    value: unknown,
    row: number,
    field: string,
    keys: string[],
  ): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ManifestError(row, field);
    for (const key of Object.keys(value))
      if (!keys.includes(key)) throw new ManifestError(row, field ? `${field}.${key}` : key);
    return value as Record<string, unknown>;
  }
  function text(value: unknown, row: number, field: string, empty = false): string {
    if (typeof value !== "string" || (!empty && !value.trim()) || /[\u0000-\u001f]/u.test(value))
      throw new ManifestError(row, field);
    return value;
  }
  const root = object(raw, 0, "", ["version", "mappings"]);
  if (root.version !== 1) throw new ManifestError(0, "version");
  if (!Array.isArray(root.mappings) || root.mappings.length === 0)
    throw new ManifestError(0, "mappings");
  const ids = new Set<string>();
  const mappings = root.mappings.map((raw, index): ManifestMapping => {
    const row = index + 1,
      m = object(raw, row, "", ["id", "source", "destination", "members", "filesOnly"]);
    if (m.filesOnly !== undefined && m.filesOnly !== true)
      throw new ManifestError(row, "filesOnly");
    const filesOnly = m.filesOnly === true ? { filesOnly: true as const } : {};
    const id = text(m.id, row, "id");
    if (ids.has(id)) throw new ManifestError(row, "id", "Duplicate mapping id");
    ids.add(id);
    const s = object(m.source, row, "source", [
      "type",
      "driveId",
      "namespaceId",
      "folderPath",
      "folderId",
    ]);
    const d = object(m.destination, row, "destination", [
      "type",
      "driveId",
      "namespaceId",
      "folderId",
      "folderPath",
      "create",
      "siteId",
    ]);
    if (s.type === undefined) throw new ManifestError(row, "source.type");
    if (d.type === undefined) throw new ManifestError(row, "destination.type");
    const pair = fileProviderPair({ sourceProvider: s.type, destinationProvider: d.type });
    const sourceContainerField = pair.source.containerField ?? "driveId";
    if (s[sourceContainerField === "driveId" ? "namespaceId" : "driveId"] !== undefined)
      throw new ManifestError(row, `source.${sourceContainerField}`);
    const destinationContainerField = pair.destination.containerField ?? "driveId";
    if (d[destinationContainerField === "driveId" ? "namespaceId" : "driveId"] !== undefined)
      throw new ManifestError(row, `destination.${destinationContainerField}`);
    const groupMembers = pair.destination.memberIdentity === "dropbox_group";
    const members: DriveMember[] = [];
    if (m.members !== undefined) {
      if (!Array.isArray(m.members)) throw new ManifestError(row, "members");
      for (const [index, rawMember] of m.members.entries()) {
        const field = `members.${index}`;
        const member = object(
          rawMember,
          row,
          field,
          groupMembers ? ["groupId", "type", "role"] : ["email", "type", "role"],
        );
        if (member.type !== "user" && member.type !== "group")
          throw new ManifestError(row, `${field}.type`);
        // Dropbox team folders are shared with groups only, named by group ID.
        if (groupMembers && member.type !== "group")
          throw new ManifestError(row, `${field}.type`, "Dropbox team folders take groups only");
        const role = pair.destination.memberRole(member.role);
        if (!role)
          throw new ManifestError(
            row,
            `${field}.role`,
            "The destination cannot represent this role",
          );
        const identity = groupMembers ? "groupId" : "email";
        if (
          !(groupMembers ? /^g:[0-9a-f]{1,64}$/iu : /^[^\s@]+@[^\s@]+$/u).test(
            text(member[identity], row, `${field}.${identity}`),
          )
        )
          throw new ManifestError(row, `${field}.${identity}`);
        // A Dropbox group ID is the member's identity key, held where emails are.
        const email = String(member[identity]).toLowerCase();
        if (members.some((m) => m.email === email))
          throw new ManifestError(row, `${field}.${identity}`, "Duplicate member");
        members.push({ email, type: member.type, role });
      }
      if (!(m.destination && typeof m.destination === "object" && "create" in m.destination))
        throw new ManifestError(row, "members", "Members require a drive to create");
    }
    function stable(value: unknown, field: string): string {
      if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9_!.,@-]{1,512}$/u.test(value) ||
        [".", "..", "root"].includes(value)
      )
        throw new ManifestError(row, field);
      return value;
    }
    function path(value: unknown, field: string): string {
      const result = text(value, row, field, true);
      if (
        result.startsWith("/") ||
        result.endsWith("/") ||
        result.includes("\\") ||
        (result && result.split("/").some((p) => !p || p === "." || p === ".."))
      )
        throw new ManifestError(row, field);
      return result;
    }
    const source: ManifestRoot =
      pair.source.rootField === "folderId"
        ? {
            type: pair.source.id,
            driveId: stable(s[sourceContainerField], `source.${sourceContainerField}`),
            folderId: stable(s.folderId, "source.folderId"),
          }
        : {
            type: pair.source.id,
            driveId: stable(s[sourceContainerField], `source.${sourceContainerField}`),
            folderPath: path(s.folderPath, "source.folderPath"),
          };
    const invalidSourceField = pair.source.rootField === "folderId" ? "folderPath" : "folderId";
    if (s[invalidSourceField] !== undefined)
      throw new ManifestError(row, `source.${invalidSourceField}`);
    const invalidDestinationField =
      pair.destination.rootField === "folderId" ? "folderPath" : "folderId";
    // Every created container names its folders by path, whatever its existing roots use.
    if (d.create === undefined && d[invalidDestinationField] !== undefined)
      throw new ManifestError(row, `destination.${invalidDestinationField}`);
    if (d.create !== undefined) {
      if (pair.destination.creationParent === "siteId") stable(d.siteId, "destination.siteId");
      else if (d.siteId !== undefined) throw new ManifestError(row, "destination.siteId");
      if (d[destinationContainerField] !== undefined || d.folderId !== undefined)
        throw new ManifestError(
          row,
          "destination.create",
          "Choose an existing destination or create",
        );
      // A folder inside the created container, never its root: omit it for the root.
      const folderPath =
        d.folderPath === undefined ? undefined : path(d.folderPath, "destination.folderPath");
      if (folderPath === "") throw new ManifestError(row, "destination.folderPath");
      return {
        id,
        source,
        destination: {
          type: pair.destination.id,
          create: text(d.create, row, "destination.create"),
          ...(d.siteId !== undefined ? { siteId: stable(d.siteId, "destination.siteId") } : {}),
          ...(folderPath !== undefined ? { folderPath } : {}),
        },
        members,
        ...filesOnly,
      };
    }
    if (d.siteId !== undefined) throw new ManifestError(row, "destination.siteId");
    const destination: ManifestRoot =
      pair.destination.rootField === "folderId"
        ? {
            type: pair.destination.id,
            driveId: stable(d.driveId, "destination.driveId"),
            folderId: stable(d.folderId, "destination.folderId"),
          }
        : {
            type: pair.destination.id,
            driveId: stable(
              d[destinationContainerField],
              `destination.${destinationContainerField}`,
            ),
            folderPath: path(d.folderPath, "destination.folderPath"),
          };
    return { id, source, destination, ...filesOnly };
  });
  validateSharedCreations(mappings);
  const sorted = [...mappings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { mappings, digest: digestJson({ version: 1, mappings: sorted }) };
}

/**
 * ADR-0020 D5: rows sharing a created container name the same members, and their
 * folders neither repeat nor nest, except beneath a files-only row's folder.
 */
function validateSharedCreations(mappings: ManifestMapping[]): void {
  const groups = new Map<string, number[]>();
  for (const [index, mapping] of mappings.entries())
    if ("create" in mapping.destination) {
      const key = creationKey(mapping.destination);
      groups.set(key, [...(groups.get(key) ?? []), index]);
    }
  const memberKey = (mapping: ManifestMapping) =>
    JSON.stringify(
      (mapping.members ?? []).map((m) => JSON.stringify([m.email, m.type, m.role])).sort(),
    );
  for (const indexes of groups.values()) {
    const first = mappings[indexes[0]!]!;
    for (const index of indexes.slice(1)) {
      if (memberKey(mappings[index]!) !== memberKey(first))
        throw new ManifestError(
          index + 1,
          "members",
          "Mappings sharing a created container must name the same members",
        );
    }
    // Siblings a case-insensitive destination cannot hold apart name one folder.
    const sibling = fileProvider(first.destination.type).destinationSiblingKey ?? ((n) => n);
    const folders = indexes.map((index) => {
      const destination = mappings[index]!.destination as ManifestCreation;
      return {
        index,
        parts: destination.folderPath ? destination.folderPath.split("/").map(sibling) : [],
      };
    });
    for (const a of folders)
      for (const b of folders) {
        if (a.index === b.index) continue;
        const nested =
          a.parts.length <= b.parts.length && a.parts.every((part, i) => b.parts[i] === part);
        if (!nested) continue;
        // A files-only root covers only its own files, so another root may sit beneath it.
        if (a.parts.length < b.parts.length && mappings[a.index]!.filesOnly) continue;
        throw new ManifestError(
          Math.max(a.index, b.index) + 1,
          "destination.folderPath",
          "Mapping trees overlap",
        );
      }
  }
}

export function validateMirrorDestinations(
  mappings: { id: string; createDrive?: unknown }[],
  mirror: boolean | undefined,
): void {
  if (!mirror) return;
  for (const [index, mapping] of mappings.entries())
    if (!mapping.createDrive)
      throw new ManifestError(
        index + 1,
        "destination",
        "Mirror requires a drive created by this job",
      );
}

/** A job fixes one source provider for every mapping. */
export function validateMappingDirections(
  mappings: { sourceDriveId: string; sourceType?: FileProviderId }[],
  sourceProvider: FileProviderId,
): void {
  for (const [index, mapping] of mappings.entries())
    if (mappingSourceProvider(mapping).id !== sourceProvider)
      throw new ManifestError(
        index + 1,
        "source.type",
        "Mapping direction does not match the job provider pair",
      );
}

/**
 * Compare stable ancestor identities, not display names or string prefixes. A
 * same-provider route also compares the two sides: provider IDs are global, so a shared
 * identity is the same folder, and a destination inside, on or above any source root would
 * write into the source with the destination's credential (ADR-0018 D10).
 */
export async function validateMappingTrees(
  provider: ProviderPort,
  mappings: FileMappingConfig[],
  signal?: AbortSignal,
  sameProvider = false,
): Promise<void> {
  const sides = { source: new Map<string, number>(), destination: new Map<string, number>() };
  const ancestry = {
    source: new Map<number, string[]>(),
    destination: new Map<number, string[]>(),
  };
  for (const side of ["source", "destination"] as const) {
    const roots = sides[side];
    for (const [index, m] of mappings.entries()) {
      if (side === "destination" && m.createDrive && !m.destDriveId) continue;
      const key = JSON.stringify(
        side === "source" ? [m.sourceDriveId, m.sourceItemId] : [m.destDriveId, m.destFolderId],
      );
      if (roots.has(key)) throw new ManifestError(index + 1, side, "Mapping trees overlap");
      roots.set(key, index);
    }
    const parents = new Map<string, string | null>();
    for (const [index, m] of mappings.entries()) {
      if (side === "destination" && m.createDrive && !m.destDriveId) continue;
      const drive = side === "source" ? m.sourceDriveId : m.destDriveId!;
      let id: string | null = side === "source" ? m.sourceItemId : m.destFolderId!;
      const seen = new Set<string>();
      while (id !== null) {
        signal?.throwIfAborted();
        const key: string = JSON.stringify([drive, id]);
        if (seen.has(key))
          throw new ManifestError(index + 1, side, "Folder ancestry is not a tree");
        seen.add(key);
        if (sameProvider) {
          const keys = ancestry[side].get(index);
          if (keys) keys.push(key);
          else ancestry[side].set(index, [key]);
        }
        const other = roots.get(key);
        // ADR-0020 D4: a files-only root covers only its direct files, so another root
        // may sit beneath it; the walk goes on, so a recursive ancestor still refuses.
        if (other !== undefined && other !== index && !mappings[other]!.filesOnly)
          throw new ManifestError(index + 1, side, "Mapping trees overlap");
        if (!parents.has(key)) {
          const entry =
            side === "source"
              ? await provider.resolveSourceRoot({
                  sourceDriveId: drive,
                  sourceItemId: id,
                  ...(signal ? { signal } : {}),
                })
              : await provider
                  .resolveDestinationFolder({
                    destDriveId: drive,
                    destFolderId: id,
                    ...(signal ? { signal } : {}),
                  })
                  .catch((error: unknown) => {
                    if (
                      error instanceof ProviderFault &&
                      error.code === "unsupported_route" &&
                      error.evidence.reason === "destination_drive_mismatch"
                    )
                      throw new ManifestError(
                        index + 1,
                        "destination.driveId",
                        "Destination folder belongs to a different Shared Drive",
                      );
                    throw error;
                  });
          if (side === "destination" && entry && entry.driveId !== drive)
            throw new ManifestError(
              index + 1,
              "destination.driveId",
              "Destination folder belongs to a different Shared Drive",
            );
          if (!entry || entry.kind !== "folder" || entry.driveId !== drive)
            throw new ManifestError(index + 1, side, "Folder ancestry cannot be resolved");
          parents.set(key, entry.parentId);
        }
        id = parents.get(key)!;
      }
    }
  }
  if (!sameProvider) return;
  for (const [from, to] of [
    ["destination", "source"],
    ["source", "destination"],
  ] as const)
    for (const [index, keys] of ancestry[from])
      if (keys.some((key) => sides[to].has(key)))
        throw new ManifestError(
          index + 1,
          "destination",
          "Source and destination trees overlap on a same-provider route",
        );
}
