import type { FileMappingConfig } from "./drivers/file-migration.ts";
import { digestJson } from "./store/digest.ts";
import type { ProviderPort } from "./providers/port.ts";

export interface ManifestMapping {
  id: string;
  source: { type: "sharepoint"; driveId: string; folderPath: string };
  destination: { type: "google_shared_drive"; driveId: string; folderId: string };
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
  if (JSON.stringify(rows.shift()) !== JSON.stringify(columns))
    throw new ManifestError(0, "header");
  return {
    version: 1,
    mappings: rows.map((r, i) => {
      if (r.length !== columns.length) throw new ManifestError(i + 1, "columns");
      return {
        id: r[0],
        source: { type: r[1], driveId: r[2], folderPath: r[3] },
        destination: { type: r[4], driveId: r[5], folderId: r[6] },
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
      m = object(raw, row, "", ["id", "source", "destination"]);
    const id = text(m.id, row, "id");
    if (ids.has(id)) throw new ManifestError(row, "id", "Duplicate mapping id");
    ids.add(id);
    const s = object(m.source, row, "source", ["type", "driveId", "folderPath"]);
    const d = object(m.destination, row, "destination", ["type", "driveId", "folderId"]);
    if (s.type !== "sharepoint") throw new ManifestError(row, "source.type");
    if (d.type !== "google_shared_drive") throw new ManifestError(row, "destination.type");
    for (const [value, field] of [
      [s.driveId, "source.driveId"],
      [d.driveId, "destination.driveId"],
      [d.folderId, "destination.folderId"],
    ] as const) {
      if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9_!.,@-]{1,512}$/u.test(value) ||
        [".", "..", "root"].includes(value)
      )
        throw new ManifestError(row, field);
    }
    const path = text(s.folderPath, row, "source.folderPath", true);
    if (
      path.startsWith("/") ||
      path.endsWith("/") ||
      path.includes("\\") ||
      (path && path.split("/").some((p) => !p || p === "." || p === ".."))
    )
      throw new ManifestError(row, "source.folderPath");
    return {
      id,
      source: {
        type: "sharepoint",
        driveId: text(s.driveId, row, "source.driveId"),
        folderPath: path,
      },
      destination: {
        type: "google_shared_drive",
        driveId: text(d.driveId, row, "destination.driveId"),
        folderId: text(d.folderId, row, "destination.folderId"),
      },
    };
  });
  const sorted = [...mappings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { mappings, digest: digestJson({ version: 1, mappings: sorted }) };
}

/** Compare stable ancestor identities, not display names or string prefixes. */
export async function validateMappingTrees(
  provider: ProviderPort,
  mappings: FileMappingConfig[],
): Promise<void> {
  for (const side of ["source", "destination"] as const) {
    const roots = new Map<string, number>();
    for (const [index, m] of mappings.entries()) {
      const key = JSON.stringify(
        side === "source" ? [m.sourceDriveId, m.sourceItemId] : [m.destDriveId, m.destFolderId],
      );
      if (roots.has(key)) throw new ManifestError(index + 1, side, "Mapping trees overlap");
      roots.set(key, index);
    }
    const parents = new Map<string, string | null>();
    for (const [index, m] of mappings.entries()) {
      const drive = side === "source" ? m.sourceDriveId : m.destDriveId;
      let id: string | null = side === "source" ? m.sourceItemId : m.destFolderId;
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
              : await provider.resolveDestinationFolder({ destDriveId: drive, destFolderId: id });
          if (!entry || entry.kind !== "folder" || entry.driveId !== drive)
            throw new ManifestError(index + 1, side, "Folder ancestry cannot be resolved");
          parents.set(key, entry.parentId);
        }
        id = parents.get(key)!;
      }
    }
  }
}
