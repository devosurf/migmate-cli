import { createHash, randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { CredentialSession } from "../credentials.ts";
import { ProviderFault } from "../fault.ts";
import type { CheckResult } from "../../types.ts";
import type {
  DestinationEntry,
  GoogleAbout,
  DriveMember,
  DriveMembership,
  SharedDrive,
  ProvenanceRecord,
  ProviderPort,
  SourceEntry,
  FilePassRoot,
} from "../port.ts";
import {
  sourceKey,
  type AdapterInput,
  type DestinationRoot,
  type Mapping,
  type FileAdapter,
  type FilePassInput,
} from "./effects.ts";
import {
  authenticatedStream,
  fetchProvider,
  googleUrl,
  responseJson,
  requireSuccess,
  HttpProviderFault,
  cursorPages,
} from "../http.ts";
import type { SharePointDiscovery } from "../discovery.ts";

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

export class GoogleAdapter implements FileAdapter {
  readonly mappings: Mapping[];
  readonly #destinationRoots: DestinationRoot[];
  readonly #session: CredentialSession;
  readonly #resolvedSources = new Set<string>();
  readonly #destDrive = new Map<string, string>();

  constructor(input: AdapterInput) {
    this.mappings = input.mappings;
    this.#destinationRoots = input.destinationRoots;
    this.#session = input.session;
    for (const mapping of this.mappings) {
      if (mapping.sourceItemId)
        this.#resolvedSources.add(sourceKey(mapping.sourceDriveId, mapping.sourceItemId));
    }
    for (const root of this.#destinationRoots)
      this.#destDrive.set(root.destFolderId, root.destDriveId);
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
    init.signal?.throwIfAborted();
    headers.set(
      "Authorization",
      `Bearer ${await this.#session.googleToken(init.signal ?? undefined)}`,
    );
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetchProvider(googleUrl(path), { ...init, headers });
  }

  async #getRaw(objectId: string, signal?: AbortSignal): Promise<{ file: GoogleFile }> {
    const response = await this.#google(
      `/drive/v3/files/${encodeURIComponent(objectId)}?supportsAllDrives=true&fields=${FILE_FIELDS}`,
      { signal: signal ?? null },
    );
    const file = await responseJson<GoogleFile>(response);
    if (file.trashed) throw new HttpProviderFault(404);
    return { file };
  }
  async readSourceItem(
    input: Parameters<NonNullable<ProviderPort["readSourceItem"]>>[0],
  ): Promise<SourceEntry | null> {
    if (!this.mappings.some((mapping) => mapping.sourceDriveId === input.driveId))
      throw new ProviderFault(
        "preflight_failed",
        "The source drive is outside the explicit mappings.",
      );
    try {
      return this.#googleSource(
        (await this.#getRaw(input.itemId, input.signal)).file,
        input.driveId,
      );
    } catch (error) {
      if (error instanceof HttpProviderFault && error.status === 404) return null;
      throw error;
    }
  }
  async readSharedDrive(driveId: string, signal?: AbortSignal): Promise<SharedDrive | null> {
    try {
      return await responseJson<SharedDrive>(
        await this.#google(
          `/drive/v3/drives/${encodeURIComponent(driveId)}?fields=id,name,createdTime`,
          { signal: signal ?? null },
        ),
      );
    } catch (error) {
      if (error instanceof HttpProviderFault && (error.status === 403 || error.status === 404))
        return null;
      throw error;
    }
  }

  async googleAbout(signal?: AbortSignal): Promise<GoogleAbout> {
    const response = await this.#google(
      "/drive/v3/about?fields=user(emailAddress),canCreateDrives",
      { signal: signal ?? null },
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

  async resolveSourcePass(input: FilePassInput): Promise<FilePassRoot> {
    const source = await this.resolveSourceRoot(input);
    if (!source || source.kind !== "folder")
      throw new ProviderFault("unsupported_route", "The source root is not an ordinary folder.");
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    return {
      fs: `${this.#session.destinationRemote},team_drive=${quote(input.sourceDriveId)},root_folder_id=${quote(input.sourceItemId)}${this.#session.delegatedSubject ? `,impersonate=${quote(this.#session.delegatedSubject)}` : ""}:`,
      kind: "google_drive" as const,
    };
  }

  async resolveDestinationPass(input: FilePassInput): Promise<FilePassRoot> {
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    return {
      fs: `${this.#session.destinationRemote},team_drive=${quote(input.destDriveId)},root_folder_id=${quote(input.destFolderId)}${this.#session.delegatedSubject ? `,impersonate=${quote(this.#session.delegatedSubject)}` : ""}:`,
      kind: "google_drive" as const,
    };
  }

  async resolveSourceFolder(): Promise<SourceEntry | null> {
    throw new ProviderFault(
      "unsupported_route",
      "Shared Drive sources require stable folder identifiers.",
    );
  }

  async resolveDestinationPath(): Promise<DestinationEntry | null> {
    throw new ProviderFault(
      "unsupported_route",
      "Shared Drive destinations require stable folder identifiers.",
    );
  }

  async discoverSharePoint(): Promise<SharePointDiscovery> {
    throw new ProviderFault(
      "unsupported_route",
      "Discovery requires a SharePoint source file job.",
    );
  }

  async resolveSourceRoot(
    input: Parameters<ProviderPort["resolveSourceRoot"]>[0],
  ): Promise<SourceEntry | null> {
    return this.readSourceItem({
      driveId: input.sourceDriveId,
      itemId: input.sourceItemId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async listSourceChildren(
    input: Parameters<ProviderPort["listSourceChildren"]>[0],
  ): Promise<SourceEntry[]> {
    const { driveId, itemId: sourceItemId } = input;
    if (!this.#resolvedSources.has(sourceKey(driveId, sourceItemId)))
      throw new ProviderFault(
        "preflight_failed",
        "The source parent has not been resolved by stable ID.",
      );
    const items: SourceEntry[] = [];
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
        }>(await this.#google(`/drive/v3/files?${query}`, { signal: input.signal ?? null }));
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
  async *openSourceContent(input: { driveId: string; itemId: string }): AsyncIterable<Uint8Array> {
    const { driveId, itemId: sourceItemId } = input;
    if (!this.#resolvedSources.has(sourceKey(driveId, sourceItemId)))
      throw new ProviderFault("source_read_failed", "The source identity has not been resolved.");
    const before = await this.readSourceItem({ driveId, itemId: sourceItemId });
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
  }
  async readDestinationObject(
    input: Parameters<NonNullable<ProviderPort["readDestinationObject"]>>[0],
  ): Promise<DestinationEntry | null> {
    if (!this.#destinationRoots.some((root) => root.destDriveId === input.driveId))
      throw new ProviderFault(
        "preflight_failed",
        "The destination drive is outside the configured roots.",
      );
    try {
      const { file } = await this.#getRaw(input.objectId, input.signal);
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
  async resolveDestinationFolder(
    input: Parameters<ProviderPort["resolveDestinationFolder"]>[0],
  ): Promise<DestinationEntry | null> {
    return this.readDestinationObject({
      driveId: input.destDriveId,
      objectId: input.destFolderId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async listDestinationChildren(
    destFolderId: string,
    signal?: AbortSignal,
  ): Promise<DestinationEntry[]> {
    let driveId = this.#destDrive.get(destFolderId);
    if (!driveId) {
      const parent = await this.#getRaw(destFolderId, signal);
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
        }>(await this.#google(`/drive/v3/files?${query}`, { signal: signal ?? null }));
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

  async reserveDestinationId(signal?: AbortSignal): Promise<string> {
    const result = await responseJson<{ ids: string[] }>(
      await this.#google("/drive/v3/files/generateIds?count=1&space=drive&type=files", {
        signal: signal ?? null,
      }),
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

  async *streamDestinationContent(
    objectId: string,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const { file } = await this.#getRaw(objectId, signal);
    if (file.mimeType.startsWith("application/vnd.google-apps."))
      throw new ProviderFault(
        "destination_read_failed",
        "The destination does not expose ordinary binary content.",
      );
    yield* authenticatedStream(
      googleUrl(`/drive/v3/files/${encodeURIComponent(objectId)}?alt=media&supportsAllDrives=true`),
      await this.#session.googleToken(signal),
      signal,
    );
  }

  async preflightSource(mapping: Mapping, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!(await this.readSharedDrive(mapping.sourceDriveId, signal)))
      throw new ProviderFault(
        "preflight_failed",
        "The acting account cannot read this source Shared Drive.",
        { unreadableSourceDrives: [mapping.sourceDriveId] },
      );
    if (!mapping.sourceItemId || !mapping.destDriveId || !mapping.destFolderId)
      throw new ProviderFault("preflight_failed", "Load exact mapping roots before planning.");
    const source = await this.resolveSourceRoot({
      sourceDriveId: mapping.sourceDriveId,
      sourceItemId: mapping.sourceItemId,
      ...(signal ? { signal } : {}),
    });
    if (!source || source.kind !== "folder")
      throw new ProviderFault("preflight_failed", "The source folder is inaccessible.");
    await this.listSourceChildren({
      driveId: source.driveId,
      itemId: source.id,
      ...(signal ? { signal } : {}),
    });
    return {};
  }

  async preflightDestination(root: DestinationRoot, signal?: AbortSignal): Promise<void> {
    const destination = await this.#getRaw(root.destFolderId, signal);
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
  }

  quotaCheck(): CheckResult {
    // Drive v3 about.storageQuota is the user's quota, not the Shared Drive's.
    return {
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

  async probeDestination(
    root: DestinationRoot,
    mapping?: Mapping,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const marker = randomUUID();
    const ids: string[] = [];
    const probeName = `.migmate-probe-${marker}`;
    const createdTime = "2001-02-03T04:05:06.000Z";
    const modifiedTime = "2002-03-04T05:06:07.000Z";
    try {
      const rootId = await this.reserveDestinationId(signal);
      ids.push(rootId);
      const probeRoot = await responseJson<GoogleFile>(
        await this.#google(`/drive/v3/files?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
          signal: signal ?? null,
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
      const childId = await this.reserveDestinationId(signal);
      ids.push(childId);
      await responseJson(
        await this.#google(`/drive/v3/files?supportsAllDrives=true&fields=id`, {
          signal: signal ?? null,
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
      const fileId = await this.reserveDestinationId(signal);
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
            signal: signal ?? null,
            method: "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body: multipart,
          },
        ),
      );
      const observed = await this.#getRaw(fileId, signal);
      const entry = this.#destination(observed.file);
      const expectedHash = createHash("sha256").update(bytes).digest("hex");
      const streamHash = createHash("sha256");
      for await (const chunk of this.streamDestinationContent(fileId, signal))
        streamHash.update(chunk);
      const folder = await this.#getRaw(childId, signal);
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
      // Cancellation still gives privately marked probe objects a bounded cleanup attempt.
      const cleanup = new AbortController();
      let deadline: NodeJS.Timeout | undefined;
      const interruptCleanup = () => {
        deadline ??= setTimeout(() => cleanup.abort(), 5000);
      };
      signal?.addEventListener("abort", interruptCleanup, { once: true });
      if (signal?.aborted) interruptCleanup();
      try {
        // Only IDs reserved by this invocation, only while their private disposable marker matches.
        for (const id of ids.reverse()) {
          try {
            const current = await this.#getRaw(id, cleanup.signal);
            if (current.file.appProperties?.migmateProbe !== marker)
              throw new ProviderFault(
                "preflight_failed",
                "A disposable probe object no longer has this run's private marker.",
              );
            if (
              current.file.mimeType === FOLDER_MIME &&
              (await this.listDestinationChildren(id, cleanup.signal)).length !== 0
            ) {
              throw new ProviderFault(
                "preflight_failed",
                "A disposable probe folder contains objects not eligible for cleanup.",
              );
            }
            const response = await this.#google(
              `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
              { method: "DELETE", signal: cleanup.signal },
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
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", interruptCleanup);
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
