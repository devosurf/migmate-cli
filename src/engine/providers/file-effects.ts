import { createHash, randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { ProviderFault, type CredentialSession } from "./credentials.ts";
import {
  authenticatedStream,
  createGraphTransport,
  fetchProvider,
  googleUrl,
  responseJson,
  requireSuccess,
  type GraphTransport,
  HttpProviderFault,
  cursorPages,
} from "./http.ts";
import type { CheckResult } from "../types.ts";
import type {
  DestinationEntry,
  GoogleAbout,
  DriveMember,
  DriveMembership,
  SharedDrive,
  ProvenanceRecord,
  ProviderPort,
  SourceEntry,
} from "./port.ts";

interface DestinationRoot {
  destDriveId: string;
  destFolderId: string;
}
interface Mapping {
  sourceType?: "sharepoint" | "google_shared_drive";
  sourceDriveId: string;
  sourceItemId?: string;
  sourceSiteId?: string;
  destDriveId?: string;
  destFolderId?: string;
}
interface GraphItem {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  parentReference?: { id?: string; driveId?: string; path?: string };
  file?: { mimeType?: string; hashes?: Record<string, string> };
  folder?: { childCount?: number };
  package?: { type?: string };
  remoteItem?: unknown;
  malware?: unknown;
  fileSystemInfo?: Record<string, unknown>;
  sharepointIds?: Record<string, string>;
  listItem?: { fields?: Record<string, unknown> };
  retentionLabel?: unknown;
}
interface GoogleFile {
  id: string;
  name: string;
  driveId?: string;
  parents?: string[];
  mimeType: string;
  size?: string;
  createdTime: string;
  modifiedTime: string;
  sha256Checksum?: string;
  headRevisionId?: string;
  appProperties?: Record<string, string>;
  capabilities?: { canAddChildren?: boolean; canEdit?: boolean; canDownload?: boolean };
  trashed?: boolean;
}
export interface SourceWorker {
  /**
   * `path` is the object's path from the drive root, already bound to the exact
   * item id by the caller: rclone's onedrive object lookup resolves paths from
   * the drive root and ignores `root_folder_id`, so a parent-id-relative read
   * silently resolves a same-named object at the root instead.
   */
  read(input: { remote: string; driveId: string; path: string }): AsyncIterable<Uint8Array>;
}

const FILE_FIELDS =
  "id,name,driveId,parents,mimeType,size,createdTime,modifiedTime,sha256Checksum,headRevisionId,appProperties,capabilities,trashed";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Archive verification detects drift using `headRevisionId` for binary content
 * and `modifiedTime` for metadata. Uploads are create-only, so this observation
 * never authorizes an overwrite.
 *
 * `version` is deliberately excluded. Drive documents it as reflecting every
 * server-side change "even those not visible to the user", and it was observed
 * advancing from 1 to 2 within four seconds of an upload with no writer
 * present, which would report drift that never happened. A null token means
 * Drive told us nothing, which is never treated as a match.
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/files
 */
function destinationRevision(file: GoogleFile): string | null {
  if (!file.modifiedTime) return null;
  return `${file.headRevisionId ?? "-"}:${file.modifiedTime}`;
}
const MARKER_PREFIX = "mm";
const MARKER_CHUNKS = 28;
const MARKER_PART_BYTES = 118;

/** Chunking observes Google's 30 private-property / 124-byte key+value limits. */
function markerProperties(marker: ProvenanceRecord): Record<string, string> {
  const properties: Record<string, string> = {};
  const bytes = deflateRawSync(Buffer.from(JSON.stringify(marker)));
  const encoded = bytes.toString("base64url");
  const count = Math.ceil(encoded.length / MARKER_PART_BYTES);
  if (count > MARKER_CHUNKS)
    throw new ProviderFault(
      "path_unrepresentable",
      "The destination cannot hold this provenance cross-check.",
    );
  properties.mmv = `1:${count}`;
  for (let i = 0; i < count; i++)
    properties[`${MARKER_PREFIX}${i.toString().padStart(2, "0")}`] = encoded.slice(
      i * MARKER_PART_BYTES,
      (i + 1) * MARKER_PART_BYTES,
    );
  return properties;
}

function readMarker(properties: Record<string, string> | undefined): ProvenanceRecord | null {
  if (!properties?.mmv) return null;
  const match = /^1:([1-9]|1[0-9]|2[0-8])$/.exec(properties.mmv);
  if (!match) return null;
  let encoded = "";
  for (let i = 0; i < Number(match[1]); i++) {
    const part = properties[`${MARKER_PREFIX}${i.toString().padStart(2, "0")}`];
    if (!part || !/^[A-Za-z0-9_-]+$/.test(part) || part.length > MARKER_PART_BYTES) return null;
    encoded += part;
  }
  try {
    const raw: unknown = JSON.parse(
      inflateRawSync(Buffer.from(encoded, "base64url"), { maxOutputLength: 32_768 }).toString(
        "utf8",
      ),
    );
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    for (const field of [
      "mappingId",
      "sourceDriveId",
      "sourceItemId",
      "sourceIdentity",
      "sourceKind",
      "sourceRelativePath",
      "createdAt",
      "modifiedAt",
    ]) {
      if (typeof value[field] !== "string") return null;
    }
    for (const field of ["sourceFingerprint", "verifiedFingerprint", "mimeType"]) {
      if (value[field] !== null && typeof value[field] !== "string") return null;
    }
    if (value.stateRevision !== undefined && typeof value.stateRevision !== "string") return null;
    if (
      !["file", "folder", "package", "reference", "undownloadable"].includes(
        String(value.sourceKind),
      )
    )
      return null;
    return value as unknown as ProvenanceRecord;
  } catch {
    return null;
  }
}

function requireName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[\/\u0000]/u.test(name) ||
    Buffer.byteLength(name) > 32_768
  ) {
    throw new ProviderFault(
      "path_unrepresentable",
      "An exact destination name cannot be represented.",
    );
  }
}

/** Graph item IDs are unique only within a drive: one site's library roots share an ID. */
function sourceKey(driveId: string, itemId: string): string {
  return JSON.stringify([driveId, itemId]);
}

function readMappings(config: unknown): Mapping[] {
  if (!config || typeof config !== "object")
    throw new ProviderFault("preflight_failed", "The file mapping configuration is invalid.");
  if (!("mappings" in config) || config.mappings === undefined) return [];
  if (!Array.isArray(config.mappings))
    throw new ProviderFault("preflight_failed", "The file mapping configuration is invalid.");
  return config.mappings.map((raw: unknown) => {
    if (!raw || typeof raw !== "object")
      throw new ProviderFault("preflight_failed", "A file mapping is invalid.");
    const record = raw as Record<string, unknown>;
    const hasDestination = record.createDrive === undefined || record.destDriveId !== undefined;
    // A SharePoint destination path resolves to its folder id while the manifest loads.
    const required = [
      "sourceDriveId",
      ...(hasDestination ? ["destDriveId"] : []),
      ...(hasDestination && typeof record.destFolderPath !== "string" ? ["destFolderId"] : []),
    ];
    for (const field of required) {
      if (
        typeof record[field] !== "string" ||
        !record[field] ||
        /[\u0000-\u001f]/u.test(record[field])
      ) {
        throw new ProviderFault("preflight_failed", "A file mapping needs stable identifiers.");
      }
    }
    return {
      sourceDriveId: String(record.sourceDriveId),
      ...(record.sourceType === "google_shared_drive"
        ? { sourceType: "google_shared_drive" as const }
        : {}),
      ...(typeof record.sourceItemId === "string" ? { sourceItemId: record.sourceItemId } : {}),
      ...(typeof record.destDriveId === "string" ? { destDriveId: record.destDriveId } : {}),
      ...(typeof record.destFolderId === "string" ? { destFolderId: record.destFolderId } : {}),
      ...(typeof record.sourceSiteId === "string" ? { sourceSiteId: record.sourceSiteId } : {}),
    };
  });
}

/** Stable IDs drive every mutation. Names are never used to select an overwrite target. */
export class FileEffects {
  readonly mappings: Mapping[];
  readonly #destinationRoots: DestinationRoot[];
  readonly #session: CredentialSession;
  readonly #graph: GraphTransport;
  readonly #graphDestination: GraphTransport;
  readonly #worker: SourceWorker;
  /** Source items resolved by stable ID, keyed by drive and item. */
  readonly #resolvedSources = new Set<string>();
  readonly #destDrive = new Map<string, string>();
  /** Direction is decided once: reverse mappings read Google drives and write SharePoint ones. */
  readonly #googleSourceDrives = new Set<string>();
  readonly #sharepointDestinationDrives = new Set<string>();

  constructor(input: {
    config: unknown;
    destination?: DestinationRoot;
    session: CredentialSession;
    graph: GraphTransport;
    worker: SourceWorker;
  }) {
    this.mappings = input.destination ? [] : readMappings(input.config);
    this.#destinationRoots = input.destination
      ? [input.destination]
      : this.mappings.flatMap((m) =>
          m.destDriveId && m.destFolderId
            ? [{ destDriveId: m.destDriveId, destFolderId: m.destFolderId }]
            : [],
        );
    this.#session = input.session;
    this.#graph = input.graph;
    // The write app is paced and authenticated as itself, never as the read-only source app.
    this.#graphDestination = createGraphTransport({
      ...input.session,
      graphToken: () => input.session.graphDestinationToken(),
      evidence: async () => ({ graph: (await input.session.evidence()).graphDestination }),
    });
    this.#worker = input.worker;
    for (const mapping of this.mappings) {
      if (mapping.sourceItemId)
        this.#resolvedSources.add(sourceKey(mapping.sourceDriveId, mapping.sourceItemId));
      if (mapping.sourceType === "google_shared_drive") {
        this.#googleSourceDrives.add(mapping.sourceDriveId);
        if (mapping.destDriveId) this.#sharepointDestinationDrives.add(mapping.destDriveId);
      }
    }
    for (const root of this.#destinationRoots) {
      this.#destDrive.set(root.destFolderId, root.destDriveId);
    }
  }

  async #source(raw: GraphItem, driveId: string): Promise<SourceEntry> {
    this.#resolvedSources.add(sourceKey(driveId, raw.id));
    const kind = raw.remoteItem
      ? "reference"
      : raw.package
        ? "package"
        : raw.folder
          ? "folder"
          : raw.file && !raw.malware
            ? "file"
            : "undownloadable";
    let packageSections: number | null = null;
    if (kind === "package" && raw.package?.type === "oneNote") {
      packageSections = 0;
      // Section groups are folders inside the notebook and nest; the recycle bin
      // holds deleted sections, which are not part of the notebook.
      const folders = [raw.id];
      while (folders.length) {
        const folderId = folders.pop()!;
        for await (const children of cursorPages(
          `/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}/children?$top=200&$select=id,name,file,folder`,
          async (cursor) => {
            const page = await this.#graph.request<{
              value: GraphItem[];
              "@odata.nextLink"?: string;
            }>(cursor!);
            return { value: page.value, next: page["@odata.nextLink"] };
          },
          () =>
            new ProviderFault(
              "provider_request_failed",
              "Notebook section paging repeated a cursor.",
            ),
        )) {
          for (const child of children) {
            if (child.file && child.name.endsWith(".one")) packageSections++;
            else if (child.folder && child.name !== "OneNote_RecycleBin") folders.push(child.id);
          }
        }
      }
    }
    return {
      id: raw.id,
      driveId,
      parentId: raw.parentReference?.id ?? null,
      name: raw.name,
      kind,
      webUrl: raw.webUrl ?? null,
      packageSections,
      size: kind === "file" ? (raw.size ?? null) : null,
      etag: raw.eTag ?? null,
      createdAt: raw.createdDateTime ?? "",
      modifiedAt: raw.lastModifiedDateTime ?? "",
      mimeType: raw.file?.mimeType ?? null,
      identity: `${driveId}:${raw.id}`,
      downloadable: kind === "file",
      metadata: {
        etag: raw.eTag ?? null,
        ctag: raw.cTag ?? null,
        hashes: raw.file?.hashes ?? {},
        listItemFields: raw.listItem?.fields ?? {},
        contentType: raw.file?.mimeType ?? null,
        retentionLabel: raw.retentionLabel ?? null,
      },
    };
  }

  #googleSource(raw: GoogleFile, driveId: string): SourceEntry {
    if (raw.driveId !== driveId)
      throw new ProviderFault("unsupported_route", "The source is not in the exact Shared Drive.");
    this.#resolvedSources.add(sourceKey(driveId, raw.id));
    const kind =
      raw.mimeType === FOLDER_MIME
        ? "folder"
        : raw.mimeType === "application/vnd.google-apps.shortcut"
          ? "reference"
          : raw.mimeType.startsWith("application/vnd.google-apps.") ||
              raw.capabilities?.canDownload === false
            ? "undownloadable"
            : "file";
    return {
      id: raw.id,
      driveId,
      parentId: raw.parents?.[0] ?? null,
      name: raw.name,
      kind,
      webUrl: null,
      packageSections: null,
      size: raw.size === undefined ? null : Number(raw.size),
      etag: raw.headRevisionId ?? null,
      createdAt: raw.createdTime,
      modifiedAt: raw.modifiedTime,
      mimeType: raw.mimeType,
      identity: `${driveId}:${raw.id}`,
      downloadable: kind === "file",
    };
  }

  #sharepointDestination(raw: GraphItem, driveId: string): DestinationEntry {
    if (raw.parentReference?.driveId && raw.parentReference.driveId !== driveId)
      throw new ProviderFault("unsupported_route", "The destination belongs to another library.");
    this.#destDrive.set(raw.id, driveId);
    return {
      id: raw.id,
      driveId,
      parentId: raw.parentReference?.id ?? null,
      name: raw.name,
      kind: raw.folder ? "folder" : raw.file ? "file" : "document",
      size: raw.size ?? null,
      revision: raw.cTag ?? raw.eTag ?? null,
      createdAt: raw.createdDateTime ?? "",
      modifiedAt: raw.lastModifiedDateTime ?? "",
      mimeType: raw.file?.mimeType ?? null,
      reportedChecksum: raw.file?.hashes?.quickXorHash ?? null,
      provenance: null,
    };
  }

  #destination(raw: GoogleFile): DestinationEntry {
    const driveId = raw.driveId ?? this.#destDrive.get(raw.id);
    if (!driveId)
      throw new ProviderFault("unsupported_route", "The destination is not a Shared Drive object.");
    this.#destDrive.set(raw.id, driveId);
    return {
      id: raw.id,
      driveId,
      parentId: raw.parents?.[0] ?? null,
      name: raw.name,
      kind:
        raw.mimeType === FOLDER_MIME
          ? "folder"
          : raw.mimeType === "application/vnd.google-apps.shortcut"
            ? "shortcut"
            : raw.mimeType.startsWith("application/vnd.google-apps.")
              ? "document"
              : "file",
      size: raw.size === undefined ? null : Number(raw.size),
      revision: destinationRevision(raw),
      createdAt: raw.createdTime,
      modifiedAt: raw.modifiedTime,
      mimeType: raw.mimeType,
      reportedChecksum: raw.sha256Checksum?.toLowerCase() ?? null,
      provenance: readMarker(raw.appProperties),
    };
  }

  async #google(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.#session.googleToken()}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetchProvider(googleUrl(path), { ...init, headers });
  }

  async #getRaw(objectId: string): Promise<{ file: GoogleFile }> {
    const response = await this.#google(
      `/drive/v3/files/${encodeURIComponent(objectId)}?supportsAllDrives=true&fields=${FILE_FIELDS}`,
    );
    const file = await responseJson<GoogleFile>(response);
    if (file.trashed) throw new HttpProviderFault(404);
    return { file };
  }

  async #sourceMetadata(entry: SourceEntry): Promise<SourceEntry> {
    if (entry.kind !== "file") return entry;
    const base = `/v1.0/drives/${encodeURIComponent(entry.driveId)}/items/${encodeURIComponent(entry.id)}`;
    let versionCount = 0;
    for await (const versions of cursorPages(
      `${base}/versions?$select=id`,
      async (cursor) => {
        const page = await this.#graph.request<{ value: unknown[]; "@odata.nextLink"?: string }>(
          cursor!,
        );
        return { value: page.value, next: page["@odata.nextLink"] };
      },
      () =>
        new ProviderFault("provider_request_failed", "Source version paging repeated a cursor."),
    )) {
      versionCount += versions.length;
    }
    let retentionLabel: unknown = null;
    try {
      retentionLabel = await this.#graph.request(`${base}/retentionLabel`);
    } catch (error) {
      // A missing label is not a missing source item. Authorization/transient faults still escape.
      if (!(error instanceof HttpProviderFault && error.status === 404)) throw error;
    }
    entry.metadata = { ...entry.metadata, versionCount, retentionLabel };
    return entry;
  }

  async readSourceItem(input: { driveId: string; itemId: string }): Promise<SourceEntry | null> {
    if (!this.mappings.some((mapping) => mapping.sourceDriveId === input.driveId))
      throw new ProviderFault(
        "preflight_failed",
        "The source drive is outside the explicit mappings.",
      );
    try {
      if (this.#googleSourceDrives.has(input.driveId))
        return this.#googleSource((await this.#getRaw(input.itemId)).file, input.driveId);
      const item = await this.#graph.request<GraphItem>(
        `/v1.0/drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.itemId)}?$expand=listItem($expand=fields)`,
      );
      return await this.#sourceMetadata(await this.#source(item, input.driveId));
    } catch (error) {
      if (error instanceof HttpProviderFault && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Path from the drive root for an item, proven to address that exact item.
   *
   * rclone's onedrive backend honours `root_folder_id` when listing but not
   * when resolving an object, so byte reads must be path-addressed. A path is
   * only safe to read once Graph confirms it resolves to the same id and etag:
   * otherwise a same-named object elsewhere in the drive could be served in
   * place of the intended one.
   */
  async #sourcePath(input: { driveId: string; item: SourceEntry }): Promise<string> {
    const raw = await this.#graph.request<GraphItem>(
      `/v1.0/drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.item.id)}?$select=id,name,eTag,parentReference`,
    );
    const reference = raw.parentReference?.path;
    if (typeof reference !== "string")
      throw new ProviderFault("source_read_failed", "The source item exposes no drive path.");
    const marker = "/root:";
    const start = reference.indexOf(marker);
    if (start === -1)
      throw new ProviderFault("source_read_failed", "The source item is outside its drive root.");
    // Graph reports this path percent-encoded; rclone is given the decoded form.
    const segments = [
      ...reference
        .slice(start + marker.length)
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => decodeURIComponent(segment)),
      input.item.name,
    ];
    if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("/")))
      throw new ProviderFault("source_read_failed", "The source path is not addressable.");
    const path = segments.join("/");
    const bound = await this.#graph.request<GraphItem>(
      `/v1.0/drives/${encodeURIComponent(input.driveId)}/root:/${segments
        .map((segment) => encodeURIComponent(segment))
        .join("/")}:/?$select=id,eTag`,
    );
    if (bound.id !== input.item.id || (bound.eTag ?? null) !== input.item.etag)
      throw new ProviderFault(
        "source_read_failed",
        "The source path does not address the source item.",
      );
    return path;
  }

  async readSharedDrive(driveId: string): Promise<SharedDrive | null> {
    try {
      return await responseJson<SharedDrive>(
        await this.#google(
          `/drive/v3/drives/${encodeURIComponent(driveId)}?fields=id,name,createdTime`,
        ),
      );
    } catch (error) {
      if (error instanceof HttpProviderFault && (error.status === 403 || error.status === 404))
        return null;
      throw error;
    }
  }

  async googleAbout(): Promise<GoogleAbout> {
    const response = await this.#google(
      "/drive/v3/about?fields=user(emailAddress),canCreateDrives",
    );
    const about = await responseJson<GoogleAbout>(response);
    if (typeof about?.user?.emailAddress !== "string" || typeof about.canCreateDrives !== "boolean")
      throw new ProviderFault("preflight_failed", "Google acting identity is unavailable.");
    return {
      user: { emailAddress: about.user.emailAddress },
      canCreateDrives: about.canCreateDrives,
    };
  }

  async createSharedDrive(input: { name: string; requestId: string }): Promise<SharedDrive | null> {
    const query = new URLSearchParams({
      requestId: input.requestId,
      fields: "id,name,createdTime",
    });
    const response = await this.#google(`/drive/v3/drives?${query}`, {
      method: "POST",
      body: JSON.stringify({ name: input.name }),
    });
    if (response.status === 409) {
      await response.body?.cancel();
      return null;
    }
    return responseJson<SharedDrive>(response);
  }

  async findSharedDrives(name: string): Promise<SharedDrive[]> {
    const found: SharedDrive[] = [];
    for await (const drives of cursorPages(
      null,
      async (cursor) => {
        const query = new URLSearchParams({
          q: `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`,
          fields: "nextPageToken,drives(id,name,createdTime)",
          pageSize: "100",
        });
        if (cursor) query.set("pageToken", cursor);
        const page = await responseJson<{ drives?: SharedDrive[]; nextPageToken?: string }>(
          await this.#google(`/drive/v3/drives?${query}`),
        );
        return { value: page.drives ?? [], next: page.nextPageToken };
      },
      () => new ProviderFault("provider_request_failed", "Drive listing cursor repeated."),
    ))
      found.push(...drives.filter((drive) => drive.name === name));
    return found;
  }

  async listDriveMembers(driveId: string): Promise<DriveMembership[]> {
    const members: DriveMembership[] = [];
    for await (const permissions of cursorPages(
      null,
      async (cursor) => {
        const query = new URLSearchParams({
          supportsAllDrives: "true",
          pageSize: "100",
          fields: "nextPageToken,permissions(id,emailAddress,domain,type,role,deleted)",
        });
        if (cursor) query.set("pageToken", cursor);
        const page = await responseJson<{
          permissions?: {
            emailAddress?: string;
            domain?: string;
            type: string;
            role: string;
            deleted?: boolean;
          }[];
          nextPageToken?: string;
        }>(
          await this.#google(`/drive/v3/files/${encodeURIComponent(driveId)}/permissions?${query}`),
        );
        return { value: page.permissions ?? [], next: page.nextPageToken };
      },
      () => new ProviderFault("provider_request_failed", "Member listing cursor repeated."),
    ))
      members.push(
        ...permissions.map((member) => ({
          email: member.emailAddress ?? member.domain ?? "",
          type: member.deleted ? "deleted" : member.type,
          role: member.role,
        })),
      );
    return members;
  }

  async addDriveMember(driveId: string, member: DriveMember): Promise<void> {
    await responseJson(
      await this.#google(
        `/drive/v3/files/${encodeURIComponent(driveId)}/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id`,
        {
          method: "POST",
          body: JSON.stringify({
            emailAddress: member.email,
            type: member.type,
            role: member.role,
          }),
        },
      ),
    );
  }

  async resolveFilePassSource(input: Parameters<ProviderPort["resolveFilePassSource"]>[0]) {
    if (
      (input.sourceType === "google_shared_drive") !==
      this.#googleSourceDrives.has(input.sourceDriveId)
    )
      throw new ProviderFault("unsupported_route", "The pass direction differs from its mapping.");
    const source = await this.resolveSourceRoot(input);
    if (!source || source.kind !== "folder")
      throw new ProviderFault("unsupported_route", "The source root is not an ordinary folder.");
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    if (input.sourceType === "google_shared_drive") {
      return {
        source: {
          fs: `${this.#session.destinationRemote},team_drive=${quote(input.sourceDriveId)},root_folder_id=${quote(input.sourceItemId)}${this.#session.delegatedSubject ? `,impersonate=${quote(this.#session.delegatedSubject)}` : ""}:`,
          kind: "google_drive" as const,
        },
      };
    }
    const root = await this.#graph.request<GraphItem>(
      `/v1.0/drives/${encodeURIComponent(input.sourceDriveId)}/root?$select=id`,
    );
    const path =
      root.id === source.id
        ? ""
        : await this.#sourcePath({
            driveId: input.sourceDriveId,
            item: source,
          });
    return {
      source: {
        fs: `${this.#session.sourceRemote},drive_id=${quote(input.sourceDriveId)},root_folder_id=,encoding=Slash:${path}`,
        kind: "sharepoint" as const,
      },
    };
  }

  async resolveFilePass(input: Parameters<ProviderPort["resolveFilePass"]>[0]) {
    const { source } = await this.resolveFilePassSource(input);
    if (input.sourceType === "google_shared_drive") {
      const destination = await this.resolveDestinationFolder(input);
      if (!destination || destination.kind !== "folder")
        throw new ProviderFault(
          "unsupported_route",
          "The destination root is not an ordinary folder.",
        );
      const root = await this.#graphDestination.request<GraphItem>(
        `/v1.0/drives/${encodeURIComponent(input.destDriveId)}/root?$select=id`,
      );
      let path = "";
      if (root.id !== destination.id) {
        const raw = await this.#graphDestination.request<GraphItem>(
          `/v1.0/drives/${encodeURIComponent(input.destDriveId)}/items/${encodeURIComponent(destination.id)}?$select=id,name,eTag,parentReference`,
        );
        const reference = raw.parentReference?.path;
        if (typeof reference !== "string" || !reference.includes("/root:"))
          throw new ProviderFault(
            "unsupported_route",
            "The destination exposes no library-relative path.",
          );
        const parts = [
          ...reference
            .slice(reference.indexOf("/root:") + 6)
            .split("/")
            .filter(Boolean)
            .map(decodeURIComponent),
          raw.name,
        ];
        if (
          parts.some((part) => !part || part === "." || part === ".." || /[\/\\\u0000]/u.test(part))
        )
          throw new ProviderFault("unsupported_route", "The destination path is not addressable.");
        path = parts.join("/");
        const bound = await this.#graphDestination.request<GraphItem>(
          `/v1.0/drives/${encodeURIComponent(input.destDriveId)}/root:/${parts.map(encodeURIComponent).join("/")}:/?$select=id`,
        );
        if (bound.id !== destination.id)
          throw new ProviderFault("unsupported_route", "The destination path changed identity.");
      }
      const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
      return {
        source,
        destination: {
          fs: `${this.#session.sharepointDestinationRemote},drive_id=${quote(input.destDriveId)},encoding=Slash:${path}`,
          kind: "sharepoint" as const,
        },
      };
    }
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    return {
      source,
      destination: {
        fs: `${this.#session.destinationRemote},team_drive=${quote(input.destDriveId)},root_folder_id=${quote(input.destFolderId)}${this.#session.delegatedSubject ? `,impersonate=${quote(this.#session.delegatedSubject)}` : ""}:`,
        kind: "google_drive" as const,
      },
    };
  }

  async resolveSourceFolder(input: {
    driveId: string;
    folderPath: string;
  }): Promise<SourceEntry | null> {
    const suffix = input.folderPath
      ? `root:/${input.folderPath.split("/").map(encodeURIComponent).join("/")}`
      : "root";
    try {
      const item = await this.#graph.request<GraphItem>(
        `/v1.0/drives/${encodeURIComponent(input.driveId)}/${suffix}`,
      );
      return this.readSourceItem({ driveId: input.driveId, itemId: item.id });
    } catch (error) {
      if (error instanceof HttpProviderFault && error.status === 404) return null;
      throw error;
    }
  }

  async resolveDestinationPath(input: {
    driveId: string;
    folderPath: string;
  }): Promise<DestinationEntry | null> {
    if (!this.#sharepointDestinationDrives.has(input.driveId))
      throw new ProviderFault("unsupported_route", "Destination is outside the explicit mappings.");
    const suffix = input.folderPath
      ? `root:/${input.folderPath.split("/").map(encodeURIComponent).join("/")}`
      : "root";
    try {
      const raw = await this.#graphDestination.request<GraphItem>(
        `/v1.0/drives/${encodeURIComponent(input.driveId)}/${suffix}`,
      );
      const folder = this.#sharepointDestination(raw, input.driveId);
      if (
        folder.kind === "folder" &&
        !this.#destinationRoots.some(
          (root) => root.destDriveId === input.driveId && root.destFolderId === folder.id,
        )
      )
        this.#destinationRoots.push({ destDriveId: input.driveId, destFolderId: folder.id });
      return folder;
    } catch (error) {
      if (error instanceof HttpProviderFault && error.status === 404) return null;
      throw error;
    }
  }

  async resolveSourceRoot(input: {
    sourceDriveId: string;
    sourceItemId: string;
  }): Promise<SourceEntry | null> {
    return this.readSourceItem({ driveId: input.sourceDriveId, itemId: input.sourceItemId });
  }

  async listSourceChildren(input: { driveId: string; itemId: string }): Promise<SourceEntry[]> {
    const { driveId, itemId: sourceItemId } = input;
    if (!this.#resolvedSources.has(sourceKey(driveId, sourceItemId)))
      throw new ProviderFault(
        "preflight_failed",
        "The source parent has not been resolved by stable ID.",
      );
    const items: SourceEntry[] = [];
    if (this.#googleSourceDrives.has(driveId)) {
      for await (const files of cursorPages(
        null,
        async (token) => {
          const query = new URLSearchParams({
            corpora: "drive",
            driveId,
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            q: `'${sourceItemId.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}' in parents and trashed = false`,
            pageSize: "1000",
            fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
            ...(token ? { pageToken: token } : {}),
          });
          const page = await responseJson<{
            files: GoogleFile[];
            nextPageToken?: string;
            incompleteSearch?: boolean;
          }>(await this.#google(`/drive/v3/files?${query}`));
          if (page.incompleteSearch)
            throw new ProviderFault("source_read_failed", "Source listing was incomplete.");
          return { value: page.files, next: page.nextPageToken };
        },
        () => new ProviderFault("source_read_failed", "Source paging repeated a cursor."),
      )) {
        for (const file of files) items.push(this.#googleSource(file, driveId));
      }
      return items;
    }
    const initial = `/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(sourceItemId)}/children?$top=200&$expand=listItem($expand=fields)`;
    for await (const page of cursorPages(
      initial,
      async (cursor) => {
        const page = await this.#graph.request<{ value: GraphItem[]; "@odata.nextLink"?: string }>(
          cursor!,
        );
        return { value: page.value, next: page["@odata.nextLink"] };
      },
      () => new ProviderFault("provider_request_failed", "Source paging repeated a cursor."),
    )) {
      for (const raw of page)
        items.push(await this.#sourceMetadata(await this.#source(raw, driveId)));
    }
    return items;
  }

  async *openSourceContent(input: { driveId: string; itemId: string }): AsyncIterable<Uint8Array> {
    const { driveId, itemId: sourceItemId } = input;
    if (!this.#resolvedSources.has(sourceKey(driveId, sourceItemId)))
      throw new ProviderFault("source_read_failed", "The source identity has not been resolved.");
    const before = await this.readSourceItem({ driveId, itemId: sourceItemId });
    if (this.#googleSourceDrives.has(driveId)) {
      if (!before?.downloadable || !before.etag)
        throw new ProviderFault("source_read_failed", "Source is not a stable downloadable file.");
      yield* authenticatedStream(
        googleUrl(
          `/drive/v3/files/${encodeURIComponent(sourceItemId)}?alt=media&supportsAllDrives=true`,
        ),
        await this.#session.googleToken(),
      );
      const after = await this.readSourceItem({ driveId, itemId: sourceItemId });
      if (!after || after.etag !== before.etag || after.size !== before.size)
        throw new ProviderFault(
          "source_changed_during_transfer",
          "The source changed during its content read.",
        );
      return;
    }
    if (!before?.downloadable || !before.etag || !before.parentId || !this.#session.sourceRemote)
      throw new ProviderFault(
        "source_read_failed",
        "The source does not expose stable downloadable ordinary file content.",
      );
    const path = await this.#sourcePath({ driveId, item: before });
    yield* this.#worker.read({ remote: this.#session.sourceRemote, driveId, path });
    const after = await this.readSourceItem({ driveId, itemId: sourceItemId });
    if (
      !after ||
      after.etag !== before.etag ||
      after.parentId !== before.parentId ||
      after.name !== before.name ||
      after.size !== before.size
    ) {
      throw new ProviderFault(
        "source_changed_during_transfer",
        "The source changed during its content read.",
      );
    }
  }

  async readDestinationObject(input: {
    driveId: string;
    objectId: string;
  }): Promise<DestinationEntry | null> {
    if (!this.#destinationRoots.some((root) => root.destDriveId === input.driveId))
      throw new ProviderFault(
        "preflight_failed",
        "The destination drive is outside the configured roots.",
      );
    try {
      if (this.#sharepointDestinationDrives.has(input.driveId)) {
        const raw = await this.#graphDestination.request<GraphItem>(
          `/v1.0/drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.objectId)}`,
        );
        return this.#sharepointDestination(raw, input.driveId);
      }
      const { file } = await this.#getRaw(input.objectId);
      if (file.driveId !== input.driveId)
        throw new ProviderFault(
          "unsupported_route",
          "The destination object does not belong to the exact Shared Drive.",
          { reason: "destination_drive_mismatch" },
        );
      return this.#destination(file);
    } catch (error) {
      if (error instanceof HttpProviderFault && error.status === 404) return null;
      throw error;
    }
  }

  async resolveDestinationFolder(input: {
    destDriveId: string;
    destFolderId: string;
  }): Promise<DestinationEntry | null> {
    return this.readDestinationObject({ driveId: input.destDriveId, objectId: input.destFolderId });
  }

  async listDestinationChildren(destFolderId: string): Promise<DestinationEntry[]> {
    let driveId = this.#destDrive.get(destFolderId);
    if (driveId && this.#sharepointDestinationDrives.has(driveId)) {
      const items: DestinationEntry[] = [];
      for await (const page of cursorPages(
        `/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(destFolderId)}/children?$top=200`,
        async (cursor) => {
          const page = await this.#graphDestination.request<{
            value: GraphItem[];
            "@odata.nextLink"?: string;
          }>(cursor!);
          return { value: page.value, next: page["@odata.nextLink"] };
        },
        () => new ProviderFault("provider_request_failed", "Destination paging repeated a cursor."),
      ))
        for (const raw of page) items.push(this.#sharepointDestination(raw, driveId));
      return items;
    }
    if (!driveId) {
      const parent = await this.#getRaw(destFolderId);
      driveId = parent.file.driveId;
    }
    if (!driveId || !this.#destinationRoots.some((root) => root.destDriveId === driveId))
      throw new ProviderFault(
        "unsupported_route",
        "The destination parent is not in a configured Shared Drive.",
      );
    const items: DestinationEntry[] = [];
    for await (const files of cursorPages(
      null,
      async (token) => {
        const query = new URLSearchParams({
          corpora: "drive",
          driveId: driveId!,
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          q: `'${destFolderId.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}' in parents and trashed = false`,
          pageSize: "1000",
          fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
          ...(token ? { pageToken: token } : {}),
        });
        const page = await responseJson<{
          files: GoogleFile[];
          nextPageToken?: string;
          incompleteSearch?: boolean;
        }>(await this.#google(`/drive/v3/files?${query}`));
        if (page.incompleteSearch)
          throw new ProviderFault("provider_request_failed", "Destination listing was incomplete.");
        return { value: page.files, next: page.nextPageToken };
      },
      () => new ProviderFault("provider_request_failed", "Destination paging repeated a cursor."),
    )) {
      for (const file of files) items.push(this.#destination(file));
    }
    return items;
  }

  async reserveDestinationId(): Promise<string> {
    const result = await responseJson<{ ids: string[] }>(
      await this.#google("/drive/v3/files/generateIds?count=1&space=drive&type=files"),
    );
    if (result.ids.length !== 1 || !result.ids[0])
      throw new ProviderFault(
        "provider_request_failed",
        "The destination did not reserve an object identity.",
      );
    return result.ids[0];
  }

  async #assertParent(parentFolderId: string): Promise<void> {
    const { file } = await this.#getRaw(parentFolderId);
    if (
      file.mimeType !== FOLDER_MIME ||
      !file.driveId ||
      !this.#destinationRoots.some((root) => root.destDriveId === file.driveId)
    )
      throw new ProviderFault(
        "destination_type_conflict",
        "The destination parent is not a configured Shared Drive folder.",
      );
    this.#destination(file);
  }

  async createDestinationFolder(
    input: Parameters<ProviderPort["createDestinationFolder"]>[0],
  ): Promise<DestinationEntry> {
    requireName(input.name);
    await this.#assertParent(input.parentFolderId);
    const response = await this.#google(
      `/drive/v3/files?supportsAllDrives=true&fields=${FILE_FIELDS}`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(input.destinationId ? { id: input.destinationId } : {}),
          name: input.name,
          mimeType: FOLDER_MIME,
          parents: [input.parentFolderId],
          ...(input.marker ? { appProperties: markerProperties(input.marker) } : {}),
        }),
      },
    );
    return this.#destination(await responseJson<GoogleFile>(response));
  }

  async uploadDestinationContent(
    input: Parameters<ProviderPort["uploadDestinationContent"]>[0],
  ): Promise<DestinationEntry> {
    requireName(input.name);
    if (input.mimeType?.startsWith("application/vnd.google-apps."))
      throw new ProviderFault(
        "destination_type_conflict",
        "Google-native import and conversion are forbidden.",
      );
    await this.#assertParent(input.parentFolderId);
    const marker = input.marker ? markerProperties(input.marker) : undefined;
    const query = new URLSearchParams({
      uploadType: "resumable",
      supportsAllDrives: "true",
      fields: FILE_FIELDS,
    });
    const path = `/upload/drive/v3/files?${query}`;
    const mimeType = input.mimeType ?? "application/octet-stream";
    const metadata = {
      ...(input.destinationId ? { id: input.destinationId } : {}),
      name: input.name,
      parents: [input.parentFolderId],
      createdTime: input.createdAt,
      modifiedTime: new Date(Math.floor(Date.parse(input.modifiedAt) / 1000) * 1000).toISOString(),
      mimeType,
      ...(marker ? { appProperties: marker } : {}),
    };
    const headers: Record<string, string> = {
      "X-Upload-Content-Type": mimeType,
    };
    const start = await this.#google(path, {
      method: "POST",
      headers,
      body: JSON.stringify(metadata),
    });
    await requireSuccess(start);
    const location = start.headers.get("location");
    await start.body?.cancel();
    if (!location)
      throw new ProviderFault(
        "provider_request_failed",
        "The destination did not provide an upload session.",
      );
    const upload = googleUrl(location);
    // One bounded chunk plus lookahead; never materialize an ordinary file in memory.
    const chunks = sizedChunks(input.content, 8 * 1024 * 1024)[Symbol.asyncIterator]();
    let current = await chunks.next();
    let offset = 0;
    try {
      if (current.done) {
        const response = await this.#google(upload.href, {
          method: "PUT",
          headers: {
            "Content-Type": mimeType,
            "Content-Length": "0",
            "Content-Range": "bytes */0",
          },
          body: new Uint8Array(0),
        });
        return this.#destination(await responseJson<GoogleFile>(response));
      }
      while (!current.done) {
        const next = await chunks.next();
        const end = offset + current.value.byteLength - 1;
        const response = await this.#google(upload.href, {
          method: "PUT",
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(current.value.byteLength),
            "Content-Range": `bytes ${offset}-${end}/${next.done ? end + 1 : "*"}`,
          },
          body: current.value,
        });
        if (next.done) return this.#destination(await responseJson<GoogleFile>(response));
        if (response.status !== 308 || response.headers.get("range") !== `bytes=0-${end}`) {
          await requireSuccess(response);
          throw new ProviderFault(
            "provider_request_failed",
            "The destination upload did not acknowledge the exact content range.",
          );
        }
        await response.body?.cancel();
        offset = end + 1;
        current = next;
      }
    } finally {
      await chunks.return?.();
    }
    throw new ProviderFault("provider_request_failed", "The destination upload did not complete.");
  }

  async readDestinationMarker(objectId: string): Promise<ProvenanceRecord | null> {
    return readMarker((await this.#getRaw(objectId)).file.appProperties);
  }

  async *streamDestinationContent(objectId: string): AsyncIterable<Uint8Array> {
    const { file } = await this.#getRaw(objectId);
    if (file.mimeType.startsWith("application/vnd.google-apps."))
      throw new ProviderFault(
        "content_verification_degraded",
        "The destination does not expose ordinary binary content.",
      );
    yield* authenticatedStream(
      googleUrl(`/drive/v3/files/${encodeURIComponent(objectId)}?alt=media&supportsAllDrives=true`),
      await this.#session.googleToken(),
    );
  }

  async *preflight(): AsyncIterable<CheckResult> {
    for (const root of this.mappings.length ? this.mappings : this.#destinationRoots) {
      const mapping = "sourceDriveId" in root ? root : undefined;
      const evidence = {
        ...(mapping
          ? { sourceDriveId: mapping.sourceDriveId, sourceItemId: mapping.sourceItemId }
          : {}),
        destDriveId: root.destDriveId,
        destFolderId: root.destFolderId,
        probedAt: new Date().toISOString(),
      };
      const checkId = mapping
        ? `provider.roots.${mapping.sourceDriveId}.${mapping.sourceItemId}`
        : `provider.roots.${root.destDriveId}.${root.destFolderId}`;
      const title = mapping ? "Exact source and destination access" : "Exact destination access";
      if (mapping?.sourceType === "google_shared_drive") {
        try {
          if (!(await this.readSharedDrive(mapping.sourceDriveId)))
            throw new ProviderFault(
              "preflight_failed",
              "The acting account cannot read this source Shared Drive.",
              { unreadableSourceDrives: [mapping.sourceDriveId] },
            );
          if (!mapping.sourceItemId || !root.destDriveId || !root.destFolderId)
            throw new ProviderFault(
              "preflight_failed",
              "Load exact mapping roots before planning.",
            );
          const source = await this.resolveSourceRoot({
            sourceDriveId: mapping.sourceDriveId,
            sourceItemId: mapping.sourceItemId,
          });
          if (!source || source.kind !== "folder")
            throw new ProviderFault("preflight_failed", "The source folder is inaccessible.");
          await this.listSourceChildren({ driveId: source.driveId, itemId: source.id });
          const drive = await this.#graphDestination.request<{ id: string; driveType: string }>(
            `/v1.0/drives/${encodeURIComponent(root.destDriveId)}`,
          );
          if (drive.id !== root.destDriveId || drive.driveType !== "documentLibrary")
            throw new ProviderFault(
              "unsupported_route",
              "The destination is not the exact SharePoint document library.",
            );
          const destination = await this.resolveDestinationFolder({
            destDriveId: root.destDriveId,
            destFolderId: root.destFolderId,
          });
          if (!destination || destination.kind !== "folder")
            throw new ProviderFault("preflight_failed", "The destination folder is inaccessible.");
          await this.listDestinationChildren(destination.id);
          yield { id: checkId, title, status: "pass", evidence };
        } catch (error) {
          yield failedCheck(checkId, title, error, evidence);
        }
        continue;
      }
      try {
        let sourceEvidence = {};
        if (mapping) {
          const drive = await this.#graph.request<{
            id: string;
            driveType: string;
            sharepointIds?: { siteId?: string };
            webUrl?: string;
          }>(`/v1.0/drives/${encodeURIComponent(mapping.sourceDriveId)}`);
          if (drive.id !== mapping.sourceDriveId || drive.driveType !== "documentLibrary")
            throw new ProviderFault(
              "unsupported_route",
              "The source is not the exact SharePoint document library.",
            );
          if (!mapping.sourceItemId)
            throw new ProviderFault("preflight_failed", "Load the source path before planning.");
          const source = await this.resolveSourceRoot({
            sourceDriveId: mapping.sourceDriveId,
            sourceItemId: mapping.sourceItemId,
          });
          if (!source || source.kind !== "folder")
            throw new ProviderFault(
              "preflight_failed",
              "The source root is not an enumerable folder.",
            );
          await this.listSourceChildren({ driveId: source.driveId, itemId: source.id });
          if (mapping.sourceSiteId) {
            const initial = `/v1.0/sites/${encodeURIComponent(mapping.sourceSiteId)}/drives?$select=id`;
            let found = false;
            for await (const items of cursorPages(
              initial,
              async (cursor) => {
                const page = await this.#graph.request<{
                  value: { id: string }[];
                  "@odata.nextLink"?: string;
                }>(cursor!);
                return { value: page.value, next: page["@odata.nextLink"] };
              },
              () =>
                new ProviderFault(
                  "provider_request_failed",
                  "Site drive paging repeated a cursor.",
                ),
            )) {
              found ||= items.some((item) => item.id === mapping.sourceDriveId);
            }
            if (!found)
              throw new ProviderFault(
                "preflight_failed",
                "The source drive does not belong to the configured SharePoint site.",
              );
          }
          sourceEvidence = {
            sourceSiteId: mapping.sourceSiteId ?? drive.sharepointIds?.siteId ?? null,
            sourceDriveType: drive.driveType,
          };
        }
        if (!root.destDriveId || !root.destFolderId) {
          yield {
            id: checkId,
            title: "Exact source access before provisioning",
            status: "pass",
            evidence: { ...evidence, ...sourceEvidence },
          };
          continue;
        }
        const destination = await this.#getRaw(root.destFolderId);
        if (
          destination.file.driveId !== root.destDriveId ||
          destination.file.mimeType !== FOLDER_MIME ||
          destination.file.capabilities?.canAddChildren !== true
        )
          throw new ProviderFault(
            "preflight_failed",
            "The exact destination Shared Drive root is not writable.",
          );
        this.#destination(destination.file);
        yield {
          id: checkId,
          title,
          status: "pass",
          evidence: { ...evidence, ...sourceEvidence },
        };
      } catch (error) {
        yield failedCheck(checkId, title, error, evidence);
        continue;
      }
      try {
        const result = await this.#probeDestination(
          {
            destDriveId: root.destDriveId!,
            destFolderId: root.destFolderId!,
          },
          mapping,
        );
        yield {
          id: `provider.probe.${root.destFolderId}`,
          title: "Disposable destination capability probe",
          status: "pass",
          evidence: { ...evidence, ...result },
        };
      } catch (error) {
        yield failedCheck(
          `provider.probe.${root.destFolderId}`,
          "Disposable destination capability probe",
          error,
          evidence,
        );
      }
    }
    // Drive v3 about.storageQuota is the authenticated user's quota, not the Shared Drive's.
    yield {
      id: "provider.destination_quota",
      title: "Destination quota where trustworthy",
      status: "skip",
      evidence: {
        trustworthy: false,
        reason:
          "Drive v3 exposes no trustworthy per-Shared-Drive storage quota; service-account personal quota does not apply.",
      },
    };
  }

  async #probeDestination(
    root: DestinationRoot,
    mapping?: Mapping,
  ): Promise<Record<string, unknown>> {
    const marker = randomUUID();
    const ids: string[] = [];
    const probeName = `.migmate-probe-${marker}`;
    const createdTime = "2001-02-03T04:05:06.000Z";
    const modifiedTime = "2002-03-04T05:06:07.000Z";
    try {
      const rootId = await this.reserveDestinationId();
      ids.push(rootId);
      const probeRoot = await responseJson<GoogleFile>(
        await this.#google(`/drive/v3/files?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
          method: "POST",
          body: JSON.stringify({
            id: rootId,
            name: probeName,
            parents: [root.destFolderId],
            mimeType: FOLDER_MIME,
            appProperties: { migmateProbe: marker },
          }),
        }),
      );
      this.#destination(probeRoot);
      const childId = await this.reserveDestinationId();
      ids.push(childId);
      await responseJson(
        await this.#google(`/drive/v3/files?supportsAllDrives=true&fields=id`, {
          method: "POST",
          body: JSON.stringify({
            id: childId,
            name: "empty",
            parents: [rootId],
            mimeType: FOLDER_MIME,
            appProperties: { migmateProbe: marker },
          }),
        }),
      );
      const bytes = Buffer.from([0, 255, 17, 0, 85, 128]);
      const fileId = await this.reserveDestinationId();
      ids.push(fileId);
      const boundary = `migmate${randomUUID().replaceAll("-", "")}`;
      const metadata = {
        id: fileId,
        name: "probe.bin",
        parents: [rootId],
        createdTime,
        modifiedTime,
        mimeType: "application/octet-stream",
        appProperties: {
          migmateProbe: marker,
          ...markerProperties({
            mappingId: "probe",
            sourceDriveId: mapping?.sourceDriveId ?? root.destDriveId,
            sourceItemId: mapping?.sourceItemId ?? root.destFolderId,
            sourceIdentity: "probe",
            sourceKind: "file",
            sourceRelativePath: "probe.bin",
            sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
            verifiedFingerprint: null,
            createdAt: createdTime,
            modifiedAt: modifiedTime,
            mimeType: "application/octet-stream",
            stateRevision: marker,
          }),
        },
      };
      const multipart = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      await responseJson(
        await this.#google(
          `/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id`,
          {
            method: "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body: multipart,
          },
        ),
      );
      const observed = await this.#getRaw(fileId);
      const entry = this.#destination(observed.file);
      const expectedHash = createHash("sha256").update(bytes).digest("hex");
      const streamHash = createHash("sha256");
      for await (const chunk of this.streamDestinationContent(fileId)) streamHash.update(chunk);
      const folder = await this.#getRaw(childId);
      if (
        entry.kind !== "file" ||
        entry.size !== bytes.length ||
        entry.mimeType !== "application/octet-stream" ||
        Date.parse(entry.createdAt) !== Date.parse(createdTime) ||
        Date.parse(entry.modifiedAt) !== Date.parse(modifiedTime) ||
        entry.provenance?.stateRevision !== marker ||
        observed.file.appProperties?.migmateProbe !== marker ||
        folder.file.mimeType !== FOLDER_MIME ||
        streamHash.digest("hex") !== expectedHash ||
        (entry.reportedChecksum !== null && entry.reportedChecksum !== expectedHash)
      ) {
        throw new ProviderFault(
          "preflight_failed",
          "The destination capability probe did not preserve the required metadata, marker, hierarchy, or bytes.",
        );
      }
      return {
        binaryUpload: true,
        emptyFolder: true,
        privateProperties: true,
        createdTime: true,
        modifiedTime: true,
        mimeType: true,
        checksumReported: entry.reportedChecksum !== null,
        destinationStreamProof: true,
      };
    } finally {
      // Only IDs reserved by this invocation, only while their private disposable marker matches.
      for (const id of ids.reverse()) {
        try {
          const current = await this.#getRaw(id);
          if (current.file.appProperties?.migmateProbe !== marker)
            throw new ProviderFault(
              "preflight_failed",
              "A disposable probe object no longer has this run's private marker.",
            );
          if (
            current.file.mimeType === FOLDER_MIME &&
            (await this.listDestinationChildren(id)).length !== 0
          ) {
            throw new ProviderFault(
              "preflight_failed",
              "A disposable probe folder contains objects not eligible for cleanup.",
            );
          }
          const response = await this.#google(
            `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
            { method: "DELETE" },
          );
          await requireSuccess(response);
          await response.body?.cancel();
        } catch (error) {
          if (!(error instanceof HttpProviderFault && error.status === 404))
            throw new ProviderFault(
              "preflight_failed",
              "Disposable destination probe cleanup could not be proven.",
              { probeCleanup: false },
            );
        }
      }
    }
  }
}

async function* sizedChunks(
  content: Uint8Array | AsyncIterable<Uint8Array>,
  size: number,
): AsyncIterable<Buffer<ArrayBuffer>> {
  if (content instanceof Uint8Array) {
    for (let offset = 0; offset < content.byteLength; offset += size)
      yield Buffer.from(content.subarray(offset, offset + size));
    return;
  }
  let pending: Buffer<ArrayBuffer> | undefined;
  let used = 0;
  for await (const incoming of content) {
    for (let offset = 0; offset < incoming.byteLength;) {
      pending ??= Buffer.allocUnsafe(size);
      const count = Math.min(size - used, incoming.byteLength - offset);
      // Copy before pulling again: AsyncIterable producers may reuse their read buffer.
      pending.set(incoming.subarray(offset, offset + count), used);
      used += count;
      offset += count;
      if (used === size) {
        yield pending;
        pending = undefined;
        used = 0;
      }
    }
  }
  if (pending && used) yield pending.subarray(0, used);
}

export function failedCheck(
  id: string,
  title: string,
  error: unknown,
  evidence: Record<string, unknown>,
): CheckResult {
  return {
    id,
    title,
    status: "fail",
    code:
      error instanceof ProviderFault &&
      ["unsupported_route", "plan_revision_required"].includes(error.code)
        ? error.code
        : "preflight_failed",
    evidence: {
      ...evidence,
      ...(error instanceof ProviderFault ? error.evidence : {}),
      failure: error instanceof ProviderFault ? error.code : "provider_failure",
    },
  };
}
