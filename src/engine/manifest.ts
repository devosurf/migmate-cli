import type { FileMappingConfig } from "./drivers/file-migration.ts";
import { digestJson } from "./store/digest.ts";
import type { DriveMember, ProviderPort } from "./providers/port.ts";
import { ProviderFault } from "./providers/credentials.ts";

export interface ManifestMapping {
  id: string;
  source:
    | { type: "sharepoint"; driveId: string; folderPath: string }
    | { type: "google_shared_drive"; driveId: string; folderId: string };
  destination:
    | ({ type: "google_shared_drive" } & (
        { driveId: string; folderId: string } | { create: string }
      ))
    | { type: "sharepoint"; driveId: string; folderPath: string };
  members?: DriveMember[];
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
  if (
    JSON.stringify(header) !== JSON.stringify(columns) &&
    JSON.stringify(header) !== JSON.stringify(columns.slice(0, 7)) &&
    JSON.stringify(header) !== JSON.stringify(columns.slice(0, 9))
  )
    throw new ManifestError(0, "header");
  return {
    version: 1,
    mappings: rows.map((r, i) => {
      if (r.length !== header!.length) throw new ManifestError(i + 1, "columns");
      let members: unknown;
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
          r[1] === "google_shared_drive"
            ? { type: r[1], driveId: r[2], folderId: r[9], ...(r[3] ? { folderPath: r[3] } : {}) }
            : { type: r[1], driveId: r[2], folderPath: r[3], ...(r[9] ? { folderId: r[9] } : {}) },
        destination: {
          type: r[4],
          ...(r[7] ? { create: r[7] } : {}),
          ...(r[5] || !r[7] ? { driveId: r[5] } : {}),
          ...(r[4] === "sharepoint"
            ? { folderPath: r[10], ...(r[6] ? { folderId: r[6] } : {}) }
            : {
                ...(r[6] || !r[7] ? { folderId: r[6] } : {}),
                ...(r[10] ? { folderPath: r[10] } : {}),
              }),
        },
        ...(members !== undefined ? { members } : {}),
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
    if (error instanceof ManifestError) throw error;
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
      m = object(raw, row, "", ["id", "source", "destination", "members"]);
    const id = text(m.id, row, "id");
    if (ids.has(id)) throw new ManifestError(row, "id", "Duplicate mapping id");
    ids.add(id);
    const members: DriveMember[] = [];
    if (m.members !== undefined) {
      if (!Array.isArray(m.members)) throw new ManifestError(row, "members");
      for (const [index, rawMember] of m.members.entries()) {
        const field = `members.${index}`;
        const member = object(rawMember, row, field, ["email", "type", "role"]);
        if (member.type !== "user" && member.type !== "group")
          throw new ManifestError(row, `${field}.type`);
        if (
          !["organizer", "fileOrganizer", "writer", "commenter", "reader"].includes(
            String(member.role),
          )
        )
          throw new ManifestError(row, `${field}.role`);
        if (!/^[^\s@]+@[^\s@]+$/u.test(text(member.email, row, `${field}.email`)))
          throw new ManifestError(row, `${field}.email`);
        const email = String(member.email).toLowerCase();
        if (members.some((m) => m.email === email))
          throw new ManifestError(row, `${field}.email`, "Duplicate member");
        members.push({ email, type: member.type, role: member.role as DriveMember["role"] });
      }
      if (!(m.destination && typeof m.destination === "object" && "create" in m.destination))
        throw new ManifestError(row, "members", "Members require a drive to create");
    }
    const s = object(m.source, row, "source", ["type", "driveId", "folderPath", "folderId"]);
    const d = object(m.destination, row, "destination", [
      "type",
      "driveId",
      "folderId",
      "folderPath",
      "create",
    ]);
    if (s.type !== "sharepoint" && s.type !== "google_shared_drive")
      throw new ManifestError(row, "source.type");
    if (d.type !== (s.type === "sharepoint" ? "google_shared_drive" : "sharepoint"))
      throw new ManifestError(row, "destination.type");
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
    if (s.type === "google_shared_drive") {
      if (s.folderPath !== undefined) throw new ManifestError(row, "source.folderPath");
      if (d.create !== undefined) throw new ManifestError(row, "destination.create");
      if (d.folderId !== undefined) throw new ManifestError(row, "destination.folderId");
      return {
        id,
        source: {
          type: s.type,
          driveId: stable(s.driveId, "source.driveId"),
          folderId: stable(s.folderId, "source.folderId"),
        },
        destination: {
          type: "sharepoint",
          driveId: stable(d.driveId, "destination.driveId"),
          folderPath: path(d.folderPath, "destination.folderPath"),
        },
      };
    }
    if (s.folderId !== undefined) throw new ManifestError(row, "source.folderId");
    if (d.folderPath !== undefined) throw new ManifestError(row, "destination.folderPath");
    if (d.create !== undefined && (d.driveId !== undefined || d.folderId !== undefined))
      throw new ManifestError(
        row,
        "destination.create",
        "Choose an existing destination or create",
      );
    return {
      id,
      source: {
        type: "sharepoint",
        driveId: stable(s.driveId, "source.driveId"),
        folderPath: path(s.folderPath, "source.folderPath"),
      },
      destination:
        d.create !== undefined
          ? { type: "google_shared_drive", create: text(d.create, row, "destination.create") }
          : {
              type: "google_shared_drive",
              driveId: stable(d.driveId, "destination.driveId"),
              folderId: stable(d.folderId, "destination.folderId"),
            },
      ...(d.create !== undefined ? { members } : {}),
    };
  });
  const sorted = [...mappings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { mappings, digest: digestJson({ version: 1, mappings: sorted }) };
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

/** Each file route reads one source type: a job's route fixes the direction of every mapping. */
export const FILE_ROUTE_SOURCES: Record<string, "sharepoint" | "google_shared_drive"> = {
  sharepoint_library_to_shared_drive: "sharepoint",
  shared_drive_to_sharepoint_library: "google_shared_drive",
};

export function validateMappingDirections(
  mappings: { sourceDriveId: string; sourceType?: "sharepoint" | "google_shared_drive" }[],
  route: string,
): void {
  // An unknown route refuses at the route gate, before any mapping is read.
  if (!Object.hasOwn(FILE_ROUTE_SOURCES, route)) return;
  const expected = FILE_ROUTE_SOURCES[route];
  for (const [index, mapping] of mappings.entries())
    if ((mapping.sourceType ?? "sharepoint") !== expected)
      throw new ManifestError(
        index + 1,
        "source.type",
        "Mapping direction does not match the job route",
      );
}

/** Compare stable ancestor identities, not display names or string prefixes. */
export async function validateMappingTrees(
  provider: ProviderPort,
  mappings: FileMappingConfig[],
): Promise<void> {
  for (const side of ["source", "destination"] as const) {
    const roots = new Map<string, number>();
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
        const key: string = JSON.stringify([drive, id]);
        if (seen.has(key))
          throw new ManifestError(index + 1, side, "Folder ancestry is not a tree");
        seen.add(key);
        const other = roots.get(key);
        if (other !== undefined && other !== index)
          throw new ManifestError(index + 1, side, "Mapping trees overlap");
        if (!parents.has(key)) {
          const entry =
            side === "source"
              ? await provider.resolveSourceRoot({ sourceDriveId: drive, sourceItemId: id })
              : await provider
                  .resolveDestinationFolder({ destDriveId: drive, destFolderId: id })
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
}
