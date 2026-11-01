import { ProviderFault } from "../fault.ts";
import { DiskListing } from "../listing.ts";
import { HttpProviderFault, fetchProvider, responseBytes, responseJson } from "../http.ts";
import type { CredentialSession } from "../credentials.ts";
import type {
  DestinationContainer,
  DestinationEntry,
  DriveMember,
  DriveMembership,
  FilePassRoot,
  ProviderPort,
  SourceEntry,
} from "../port.ts";
import { markCreationRejected } from "../port.ts";
import type {
  AdapterInput,
  DestinationRoot,
  FileAdapter,
  FilePassInput,
  Mapping,
} from "./effects.ts";
import {
  DROPBOX_ENCODING,
  dropboxDestinationName,
  dropboxDestinationNameToStandard,
} from "./rclone-name-encoding.ts";
import { discoverDropbox } from "./dropbox-discovery.ts";
import type { SourceDiscovery } from "../../partition.ts";

interface Namespace {
  namespace_id: string;
  name: string;
  namespace_type: { ".tag": string };
}
interface DropboxItem {
  ".tag": "file" | "folder" | "deleted";
  id: string;
  name: string;
  path_display?: string;
  path_lower?: string;
  size?: number;
  rev?: string;
  content_hash?: string;
  client_modified?: string;
  server_modified?: string;
  is_downloadable?: boolean;
  export_info?: { export_as?: string; export_options?: string[] };
}

/** Keeps Dropbox's error tag, never its message or path, for creation and quota decisions. */
export class DropboxApiFault extends HttpProviderFault {
  readonly summary: string;
  constructor(status: number, retryAfter: string | null, summary: string, host?: string) {
    const tag = /^[a-z_]+(?:\/[a-z_]+)?/u.exec(summary)?.[0];
    super(status, retryAfter, tag, host);
    this.summary = summary;
  }
}

function unsupported(): never {
  throw new ProviderFault(
    "unsupported_route",
    "The Dropbox route needs a configured source or destination app.",
  );
}

interface TeamFolder {
  team_folder_id: string;
  name: string;
  status?: { ".tag": string };
}
interface FolderMembers {
  users?: { access_type: { ".tag": string }; user: { account_id: string; email?: string } }[];
  groups?: { access_type: { ".tag": string }; group: { group_id: string } }[];
  invitees?: { access_type: { ".tag": string }; invitee: { ".tag": string; email?: string } }[];
  cursor?: string;
}
const ROOT_PREFIX = "ns:";
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function chooseExportFormat(raw: DropboxItem): "html" | "markdown" | undefined {
  if (raw[".tag"] !== "file" || raw.is_downloadable !== false) return undefined;
  // rclone v1.75.0 backend/dropbox chooseExportFormat: prefer configured HTML,
  // then the first recognized API format in export_as followed by export_options.
  let fallback: "markdown" | undefined;
  for (const format of [raw.export_info?.export_as, ...(raw.export_info?.export_options ?? [])]) {
    if (format === "html") return "html";
    if (format === "markdown") fallback = "markdown";
  }
  return fallback;
}

/** Namespace identity, not a member's mount name, determines every Dropbox source read. */
export class DropboxAdapter implements FileAdapter {
  readonly #session: CredentialSession;
  readonly #mappings: Mapping[];
  #namespaces: Promise<Map<string, Namespace>> | undefined;
  readonly #writableNamespaces = new Set<string>();
  readonly #destinationItems = new Map<string, { namespace: string; path: string }>();

  constructor(input: AdapterInput) {
    this.#session = input.session;
    this.#mappings = input.mappings;
  }

  async #response(
    endpoint: string,
    body: unknown,
    namespace?: string,
    signal?: AbortSignal,
    content = false,
    selectUser = false,
    role: "source" | "destination" | "discovery" = "source",
  ): Promise<Response> {
    const host = content ? "content.dropboxapi.com" : "api.dropboxapi.com";
    const destination = role === "destination";
    // Discovery reads as the source app but keeps error tags and acts as the admin.
    const tagged = destination || role === "discovery";
    const adminId = destination
      ? this.#session.dropboxDestinationAdminId
      : this.#session.dropboxAdminId;
    const token = destination
      ? await this.#destinationToken(signal)
      : await this.#session.dropboxToken(signal);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const requireAdmin = () => {
      if (!adminId)
        throw new ProviderFault(
          "credential_config_invalid",
          "A Dropbox team administrator identity is required.",
        );
      return adminId;
    };
    if (namespace !== undefined) {
      headers["Dropbox-API-Select-Admin"] = requireAdmin();
      headers["Dropbox-API-Path-Root"] = JSON.stringify({
        ".tag": "namespace_id",
        namespace_id: namespace,
      });
    } else if (tagged && !endpoint.startsWith("team/")) {
      // Sharing calls act in team-admin mode; team endpoints take the team token itself.
      headers["Dropbox-API-Select-Admin"] = requireAdmin();
    }
    if (selectUser) headers["Dropbox-API-Select-User"] = requireAdmin();
    if (content) headers["Dropbox-API-Arg"] = JSON.stringify(body);
    else headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetchProvider(new URL(`https://${host}/2/${endpoint}`), {
        method: "POST",
        headers,
        ...(content ? {} : { body: JSON.stringify(body) }),
        signal: signal ?? null,
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new HttpProviderFault(0, null, undefined, host);
    }
    if (!response.ok) {
      const status = response.status;
      const retryAfter = response.headers.get("retry-after");
      // Only a missing path is absence; permission and namespace errors must not disappear.
      const error: unknown = await response.json().catch(() => null);
      const summary =
        error && typeof error === "object" && "error_summary" in error
          ? String(error.error_summary)
          : "";
      if (status === 409 && summary.startsWith("path/not_found/"))
        throw new HttpProviderFault(404, retryAfter);
      throw tagged
        ? new DropboxApiFault(status, retryAfter, summary, host)
        : new HttpProviderFault(status, retryAfter, undefined, host);
    }
    return response;
  }

  async #destinationToken(signal?: AbortSignal): Promise<string> {
    if (!this.#session.dropboxDestinationToken)
      throw new ProviderFault(
        "credential_dropbox_unavailable",
        "The Dropbox destination write app is not configured.",
      );
    return this.#session.dropboxDestinationToken(signal);
  }

  async #request<T>(
    endpoint: string,
    body: unknown,
    namespace?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return responseJson<T>(await this.#response(endpoint, body, namespace, signal));
  }

  async #write<T>(
    endpoint: string,
    body: unknown,
    namespace?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return responseJson<T>(
      await this.#response(endpoint, body, namespace, signal, false, false, "destination"),
    );
  }

  async #namespace(id: string, signal?: AbortSignal): Promise<Namespace> {
    if (!/^[0-9]+$/.test(id) || !this.#mappings.some((mapping) => mapping.sourceDriveId === id))
      throw new ProviderFault(
        "unsupported_route",
        "The namespace is outside the explicit mappings.",
      );
    this.#namespaces ??= this.#loadNamespaces(signal).catch((error: unknown) => {
      this.#namespaces = undefined;
      throw error;
    });
    const namespace = (await this.#namespaces).get(id);
    if (!namespace || !["team_folder", "shared_folder"].includes(namespace.namespace_type[".tag"]))
      throw new ProviderFault(
        "unsupported_route",
        "Dropbox sources must be shared namespaces; member homes and app folders are out of scope.",
        { namespaceId: id },
      );
    return namespace;
  }

  async #loadNamespaces(signal?: AbortSignal): Promise<Map<string, Namespace>> {
    using namespaces = new DiskListing<Namespace>((entry) => entry.namespace_id);
    using cursors = new DiskListing<string>((cursor) => cursor);
    let cursor: string | null = null;
    for (;;) {
      signal?.throwIfAborted();
      const page: { namespaces: Namespace[]; has_more: boolean; cursor: string } =
        await this.#request(
          cursor === null ? "team/namespaces/list" : "team/namespaces/list/continue",
          cursor === null ? {} : { cursor },
          undefined,
          signal,
        );
      for (const entry of page.namespaces) {
        signal?.throwIfAborted();
        const previous = namespaces.get(entry.namespace_id);
        if (previous && previous.namespace_type[".tag"] !== entry.namespace_type[".tag"])
          throw new ProviderFault(
            "provider_request_failed",
            "Dropbox returned conflicting namespace identities.",
          );
        if (previous) namespaces.delete(entry.namespace_id);
        namespaces.add(entry);
      }
      if (!page.has_more) break;
      if (!page.cursor || cursors.has(page.cursor))
        throw new ProviderFault(
          "provider_request_failed",
          "Dropbox namespace paging repeated a cursor.",
        );
      cursor = page.cursor;
      cursors.add(cursor);
    }
    // Retain only explicit mapping roots, never the complete tenant inventory.
    const selected = new Map<string, Namespace>();
    for (const mapping of this.#mappings) {
      const namespace = namespaces.get(mapping.sourceDriveId);
      if (namespace) selected.set(mapping.sourceDriveId, namespace);
    }
    return selected;
  }

  #root(namespace: Namespace): SourceEntry {
    return {
      id: "/",
      driveId: namespace.namespace_id,
      parentId: null,
      name: namespace.name,
      kind: "folder",
      size: null,
      etag: null,
      createdAt: "",
      modifiedAt: "",
      mimeType: null,
      identity: `${namespace.namespace_id}:/`,
      downloadable: false,
      webUrl: null,
      packageSections: null,
    };
  }

  #entry(raw: DropboxItem, namespace: string, parentId: string): SourceEntry {
    const folder = raw[".tag"] === "folder";
    const exportFormat = chooseExportFormat(raw);
    const unsupportedExport = !folder && raw.is_downloadable === false && !exportFormat;
    const path = raw.path_display ?? raw.path_lower;
    if (!path || !path.startsWith("/"))
      throw new ProviderFault(
        "provider_request_failed",
        "Dropbox returned an item without a namespace-relative path.",
      );
    return {
      id: raw.id,
      driveId: namespace,
      parentId,
      name: exportFormat
        ? (raw.name.endsWith(".paper") ? raw.name.slice(0, -6) : raw.name) +
          (exportFormat === "html" ? ".html" : ".md")
        : raw.name,
      kind: folder ? "folder" : unsupportedExport ? "undownloadable" : "file",
      size: folder || exportFormat || unsupportedExport ? null : (raw.size ?? null),
      etag: raw.rev ?? null,
      createdAt: raw.client_modified ?? "",
      modifiedAt: raw.server_modified ?? "",
      mimeType:
        exportFormat === "html"
          ? "text/html"
          : exportFormat === "markdown"
            ? "text/markdown"
            : null,
      identity: `${namespace}:${raw.id}`,
      downloadable: !folder && !unsupportedExport,
      webUrl: null,
      packageSections: null,
      metadata: {
        path,
        originalName: raw.name,
        ...(exportFormat
          ? {
              contentDisposition: exportFormat === "html" ? "paper_html" : "document_export",
              exportFormat,
            }
          : unsupportedExport
            ? { contentDisposition: "unsupported_export" }
            : /\.web$/i.test(raw.name)
              ? { contentDisposition: "web_pointer" }
              : {}),
      },
    };
  }

  async readSourceItem(
    input: Parameters<NonNullable<ProviderPort["readSourceItem"]>>[0],
  ): Promise<SourceEntry | null> {
    const namespace = await this.#namespace(input.driveId, input.signal);
    if (input.itemId === "/" || input.itemId === "") return this.#root(namespace);
    try {
      const raw = await this.#request<DropboxItem>(
        "files/get_metadata",
        { path: input.itemId },
        input.driveId,
        input.signal,
      );
      const path = raw.path_display ?? raw.path_lower ?? "";
      const parentPath = path.slice(0, path.lastIndexOf("/"));
      const parentId = parentPath
        ? (
            await this.#request<DropboxItem>(
              "files/get_metadata",
              { path: parentPath },
              input.driveId,
              input.signal,
            )
          ).id
        : "/";
      return this.#entry(raw, input.driveId, parentId);
    } catch (error) {
      if (error instanceof HttpProviderFault && error.status === 404) return null;
      throw error;
    }
  }

  resolveSourceRoot(
    input: Parameters<ProviderPort["resolveSourceRoot"]>[0],
  ): Promise<SourceEntry | null> {
    return this.readSourceItem({
      driveId: input.sourceDriveId,
      itemId: input.sourceItemId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  resolveSourceFolder(
    input: Parameters<ProviderPort["resolveSourceFolder"]>[0],
  ): Promise<SourceEntry | null> {
    return this.readSourceItem({ driveId: input.driveId, itemId: `/${input.folderPath}` });
  }

  async *#sourceChildPages(
    input: Parameters<ProviderPort["listSourceChildren"]>[0],
  ): AsyncIterable<DropboxItem[]> {
    using cursors = new DiskListing<string>((cursor) => cursor);
    let cursor: string | null = null;
    for (;;) {
      input.signal?.throwIfAborted();
      const result: { entries: DropboxItem[]; has_more: boolean; cursor: string } =
        await this.#request(
          cursor === null ? "files/list_folder" : "files/list_folder/continue",
          cursor === null
            ? {
                path: input.itemId === "/" ? "" : input.itemId,
                recursive: false,
                include_deleted: false,
                include_non_downloadable_files: true,
                include_mounted_folders: false,
                limit: 1000,
              }
            : { cursor },
          input.driveId,
          input.signal,
        );
      input.signal?.throwIfAborted();
      yield result.entries;
      if (!result.has_more) return;
      if (!result.cursor || cursors.has(result.cursor))
        throw new ProviderFault(
          "provider_request_failed",
          "Dropbox folder paging repeated a cursor.",
        );
      cursor = result.cursor;
      cursors.add(cursor);
    }
  }

  async listSourceChildren(
    input: Parameters<ProviderPort["listSourceChildren"]>[0],
  ): Promise<DiskListing<SourceEntry>> {
    await this.#namespace(input.driveId, input.signal);
    const entries = new DiskListing<SourceEntry>((entry) => entry.id);
    try {
      for await (const page of this.#sourceChildPages(input)) {
        for (const raw of page) {
          input.signal?.throwIfAborted();
          if (raw[".tag"] !== "deleted" && !entries.has(raw.id))
            entries.add(this.#entry(raw, input.driveId, input.itemId));
        }
      }
      return entries;
    } catch (error) {
      entries[Symbol.dispose]();
      throw error;
    }
  }

  async *openSourceContent(
    input: Parameters<ProviderPort["openSourceContent"]>[0],
  ): AsyncIterable<Uint8Array> {
    const entry = await this.readSourceItem(input);
    if (!entry?.downloadable)
      throw new ProviderFault(
        "source_read_failed",
        "The Dropbox item has no supported downloadable representation.",
      );
    const exportFormat = entry.metadata?.exportFormat;
    const response = await this.#response(
      exportFormat ? "files/export" : "files/download",
      { path: input.itemId, ...(exportFormat ? { export_format: exportFormat } : {}) },
      input.driveId,
      undefined,
      true,
    );
    if (!response.body)
      throw new ProviderFault("source_read_failed", "Dropbox returned no content stream.");
    yield* responseBytes(response);
  }

  async resolveSourcePass(input: FilePassInput): Promise<FilePassRoot> {
    const root = await this.resolveSourceRoot(input);
    if (
      !root ||
      root.kind !== "folder" ||
      !this.#session.dropboxRemote ||
      !this.#session.dropboxAdminId
    )
      unsupported();
    const path = root.id === "/" ? "" : String(root.metadata?.path ?? "");
    return {
      fs: `${this.#session.dropboxRemote},root_namespace=${quote(input.sourceDriveId)},impersonate_admin=${quote(this.#session.dropboxAdminId)},export_formats=html,skip_exports=false,show_all_exports=false:${path}`,
      kind: "dropbox",
    };
  }

  async preflightSource(mapping: Mapping, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const namespace = await this.#namespace(mapping.sourceDriveId, signal);
    if (mapping.sourceItemId) {
      const root = await this.readSourceItem({
        driveId: mapping.sourceDriveId,
        itemId: mapping.sourceItemId,
        ...(signal ? { signal } : {}),
      });
      if (root?.kind !== "folder")
        throw new ProviderFault(
          "preflight_failed",
          "The Dropbox mapping root is not a readable folder.",
        );
    }
    return {
      namespaceId: namespace.namespace_id,
      namespaceType: namespace.namespace_type[".tag"],
      selectAdmin: true,
      readOnly: true,
      exportFormat: "html",
      recursiveListing: "folder_walk",
    };
  }

  async discoverSource(signal?: AbortSignal): Promise<SourceDiscovery> {
    const evidence = await this.#session.evidence(signal);
    const dropbox = evidence.dropbox as { grantedScopes?: unknown } | undefined;
    return discoverDropbox({
      grantedScopes: dropbox?.grantedScopes,
      request: async <T>(endpoint: string, body: unknown, namespace?: string) =>
        responseJson<T>(
          await this.#response(endpoint, body, namespace, signal, false, false, "discovery"),
        ),
      ...(signal ? { signal } : {}),
    });
  }

  async sourcePlanningEvidence(signal?: AbortSignal) {
    let paperAsFiles: boolean | null = null;
    try {
      const response = await this.#response(
        "users/features/get_values",
        {
          features: [{ ".tag": "paper_as_files" }],
        },
        undefined,
        signal,
        false,
        true,
      );
      const result = await responseJson<{
        values?: { ".tag": string; paper_as_files?: { ".tag": string; enabled?: boolean } }[];
      }>(response);
      const feature = result.values?.find(
        (value) => value[".tag"] === "paper_as_files",
      )?.paper_as_files;
      if (feature?.[".tag"] === "enabled" && typeof feature.enabled === "boolean")
        paperAsFiles = feature.enabled;
    } catch {
      signal?.throwIfAborted();
      // Failure to observe the creation model never proves an empty legacy store.
    }
    return {
      evidence: {
        paperAsFiles,
        selectedAdminId: this.#session.dropboxAdminId ?? null,
      },
      notices:
        paperAsFiles === true
          ? []
          : [
              paperAsFiles === false
                ? "Legacy Paper is enabled for the selected administrator. Legacy Paper documents live outside file namespaces and this route does not migrate them."
                : "The selected administrator's paper_as_files feature could not be checked. Legacy Paper documents live outside file namespaces and this route does not migrate them.",
            ],
    };
  }

  // Destination: the separate write app (ADR-0018 D4) inside team-folder namespaces.
  // destDriveId is the namespace ID; folder IDs are Dropbox `id:` IDs, `ns:<id>` for a root.

  async #features(signal?: AbortSignal): Promise<{
    teamSharedDropbox: boolean | null;
    uploadApiRateLimit: number | "unlimited" | null;
  }> {
    // https://www.dropbox.com/developers/documentation/http/teams#team-features-get_values
    const result = await this.#write<{
      values?: {
        ".tag": string;
        has_team_shared_dropbox?: { ".tag": string; has_team_shared_dropbox?: boolean };
        upload_api_rate_limit?: { ".tag": string; limit?: number };
      }[];
    }>(
      "team/features/get_values",
      { features: [{ ".tag": "has_team_shared_dropbox" }, { ".tag": "upload_api_rate_limit" }] },
      undefined,
      signal,
    );
    const shared = result.values?.find(
      (value) => value[".tag"] === "has_team_shared_dropbox",
    )?.has_team_shared_dropbox;
    const limit = result.values?.find(
      (value) => value[".tag"] === "upload_api_rate_limit",
    )?.upload_api_rate_limit;
    return {
      teamSharedDropbox:
        typeof shared?.has_team_shared_dropbox === "boolean"
          ? shared.has_team_shared_dropbox
          : null,
      uploadApiRateLimit:
        limit?.[".tag"] === "unlimited"
          ? "unlimited"
          : limit?.[".tag"] === "limit" && Number.isSafeInteger(limit.limit)
            ? limit.limit!
            : null,
    };
  }

  async #destinationNamespace(id: string, signal?: AbortSignal): Promise<void> {
    if (this.#writableNamespaces.has(id)) return;
    if (!/^[0-9]+$/.test(id))
      throw new ProviderFault("unsupported_route", "The destination is not a Dropbox namespace.");
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (;;) {
      signal?.throwIfAborted();
      const page: { namespaces: Namespace[]; has_more: boolean; cursor: string } =
        await this.#write(
          cursor === null ? "team/namespaces/list" : "team/namespaces/list/continue",
          cursor === null ? {} : { cursor },
          undefined,
          signal,
        );
      const found = page.namespaces.find((entry) => entry.namespace_id === id);
      if (found) {
        // Member homes and app folders are never written; only team-owned folders are.
        if (found.namespace_type[".tag"] !== "team_folder")
          throw new ProviderFault(
            "unsupported_route",
            "Dropbox destinations must be team folders; member homes, shared and app folders are out of scope.",
            { namespaceId: id },
          );
        this.#writableNamespaces.add(id);
        return;
      }
      if (!page.has_more) break;
      if (!page.cursor || cursors.has(page.cursor))
        throw new ProviderFault(
          "provider_request_failed",
          "Dropbox namespace paging repeated a cursor.",
        );
      cursor = page.cursor;
      cursors.add(cursor);
    }
    throw new ProviderFault("preflight_failed", "The destination team folder is not visible.", {
      namespaceId: id,
    });
  }

  #destinationRoot(namespace: string): DestinationEntry {
    return {
      id: `${ROOT_PREFIX}${namespace}`,
      driveId: namespace,
      parentId: null,
      name: "",
      kind: "folder",
      size: null,
      revision: null,
      createdAt: "",
      modifiedAt: "",
      mimeType: null,
      reportedChecksum: null,
      provenance: null,
    };
  }

  #destinationEntry(
    raw: DropboxItem,
    namespace: string,
    parentId: string | null,
  ): DestinationEntry {
    if (raw[".tag"] === "deleted")
      throw new ProviderFault("provider_request_failed", "Dropbox returned a deleted entry.");
    const path = raw.path_display ?? raw.path_lower;
    if (!path || !path.startsWith("/"))
      throw new ProviderFault(
        "provider_request_failed",
        "Dropbox returned an item without a namespace-relative path.",
      );
    this.#destinationItems.set(raw.id, { namespace, path });
    return {
      id: raw.id,
      driveId: namespace,
      parentId,
      name: raw.name,
      kind: raw[".tag"] === "folder" ? "folder" : "file",
      size: raw[".tag"] === "folder" ? null : (raw.size ?? null),
      revision: raw.rev ?? null,
      createdAt: raw.client_modified ?? "",
      modifiedAt: raw.server_modified ?? "",
      mimeType: null,
      reportedChecksum: raw.content_hash ?? null,
      provenance: null,
    };
  }

  #folderNamespace(folderId: string): { namespace: string; path: string } {
    if (folderId.startsWith(ROOT_PREFIX))
      return { namespace: folderId.slice(ROOT_PREFIX.length), path: "" };
    const known = this.#destinationItems.get(folderId);
    if (!known)
      throw new ProviderFault(
        "unsupported_route",
        "The destination parent is not in a resolved team folder.",
      );
    return known;
  }

  async destinationCreator(): Promise<string> {
    // API-created team folders give access to no one, not even administrators:
    // the writer is a team-admin token, never an implicit folder member.
    // https://developers.dropbox.com/dbx-team-files-guide#creating-and-managing-team-folders
    return "";
  }

  async validateDestinationCreation(
    input: Parameters<NonNullable<ProviderPort["validateDestinationCreation"]>>[0],
  ): Promise<void> {
    void input;
    const features = await this.#features();
    // A team-space team makes every new top-level folder visible at once: no fence exists.
    if (features.teamSharedDropbox !== false)
      throw new ProviderFault(
        "preflight_failed",
        features.teamSharedDropbox
          ? "This Dropbox team uses a team space, where new folders are visible to the whole team at once. Migmate cannot fence them before go-live; copy into an existing team folder instead."
          : "Dropbox did not report whether this team uses a team space; team-folder creation is refused.",
        { check: "dropbox_team_space_unfenced" },
      );
  }

  #teamFolder(folder: TeamFolder): DestinationContainer {
    if (!/^[0-9]+$/.test(folder.team_folder_id) || !folder.name)
      throw new ProviderFault("provider_request_failed", "Team folder identity is incomplete.");
    this.#writableNamespaces.add(folder.team_folder_id);
    // A team folder's shared_folder_id and namespace ID are its team_folder_id.
    return {
      id: folder.team_folder_id,
      name: folder.name,
      rootFolderId: `${ROOT_PREFIX}${folder.team_folder_id}`,
    };
  }

  async createDestinationContainer(
    input: Parameters<ProviderPort["createDestinationContainer"]>[0],
  ): Promise<DestinationContainer | null> {
    // No request key exists, so the engine records the attempt before calling and
    // never retries a lost response by creating again.
    // https://www.dropbox.com/developers/documentation/http/teams#team-team_folder-create
    try {
      return this.#teamFolder(
        await this.#write<TeamFolder>("team/team_folder/create", { name: input.name }),
      );
    } catch (error) {
      if (error instanceof DropboxApiFault && error.status === 409) {
        if (error.summary.startsWith("folder_name_already_used")) return null;
        if (error.summary.startsWith("folder_name_reserved"))
          throw markCreationRejected(
            new ProviderFault("destination_invalid_name", "Dropbox reserves this name."),
          );
        if (error.summary.startsWith("team_shared_dropbox_error"))
          throw markCreationRejected(
            new ProviderFault(
              "preflight_failed",
              "This Dropbox team uses a team space; team folders cannot be created.",
              { check: "dropbox_team_space_unfenced" },
            ),
          );
      }
      // Any 4xx, 409 route errors and 429 included, is refused before the folder exists;
      // only a lost response or 5xx leaves the outcome unknown.
      if (error instanceof HttpProviderFault && error.status >= 400 && error.status < 500)
        throw markCreationRejected(error);
      throw error;
    }
  }

  async findDestinationContainers(
    input: Parameters<ProviderPort["findDestinationContainers"]>[0],
  ): Promise<DestinationContainer[]> {
    const found: DestinationContainer[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const page: { team_folders: TeamFolder[]; has_more: boolean; cursor: string } =
        await this.#write(
          cursor === null ? "team/team_folder/list" : "team/team_folder/list/continue",
          cursor === null ? { limit: 1000 } : { cursor },
        );
      // Names are case-insensitive: an archived same-name folder still blocks creation.
      for (const folder of page.team_folders)
        if (folder.name.toLowerCase() === input.name.toLowerCase())
          found.push(this.#teamFolder(folder));
      if (!page.has_more) break;
      if (!page.cursor || cursors.has(page.cursor))
        throw new ProviderFault("provider_request_failed", "Team folder listing cursor repeated.");
      cursor = page.cursor;
      cursors.add(cursor);
    }
    return found;
  }

  async prepareDestinationMembers(driveId: string): Promise<void> {
    // Team folders are not inherited: membership is the folder's own ACL.
    await this.#destinationNamespace(driveId);
  }

  async listDriveMembers(driveId: string): Promise<DriveMembership[]> {
    await this.#destinationNamespace(driveId);
    // https://www.dropbox.com/developers/documentation/http/documentation#sharing-list_folder_members
    const members: DriveMembership[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const page: FolderMembers = await this.#write(
        cursor === null ? "sharing/list_folder_members" : "sharing/list_folder_members/continue",
        cursor === null ? { shared_folder_id: driveId, limit: 1000 } : { cursor },
      );
      for (const group of page.groups ?? [])
        members.push({
          email: group.group.group_id.toLowerCase(),
          type: "group",
          role: group.access_type[".tag"],
        });
      for (const user of page.users ?? [])
        members.push({
          email: (user.user.email ?? user.user.account_id).toLowerCase(),
          type: "user",
          role: user.access_type[".tag"],
        });
      for (const invitee of page.invitees ?? [])
        members.push({
          email: (invitee.invitee.email ?? invitee.invitee[".tag"]).toLowerCase(),
          type: "invitee",
          role: invitee.access_type[".tag"],
        });
      if (!page.cursor) break;
      if (cursors.has(page.cursor))
        throw new ProviderFault("provider_request_failed", "Folder membership cursor repeated.");
      cursor = page.cursor;
      cursors.add(cursor);
    }
    return members;
  }

  async addDriveMember(driveId: string, member: DriveMember): Promise<void> {
    if (member.type !== "group")
      throw new ProviderFault(
        "unsupported_member_role",
        "Dropbox team folders are shared with groups only.",
      );
    if (member.role !== "viewer" && member.role !== "editor")
      throw new ProviderFault(
        "unsupported_member_role",
        "Dropbox grants team-folder groups viewer or editor access only.",
      );
    await this.#destinationNamespace(driveId);
    // https://www.dropbox.com/developers/documentation/http/documentation#sharing-add_folder_member
    await this.#write("sharing/add_folder_member", {
      shared_folder_id: driveId,
      members: [
        {
          member: { ".tag": "dropbox_id", dropbox_id: member.email },
          access_level: { ".tag": member.role },
        },
      ],
      quiet: true,
    });
  }

  async readDestinationObject(
    input: Parameters<NonNullable<ProviderPort["readDestinationObject"]>>[0],
  ): Promise<DestinationEntry | null> {
    await this.#destinationNamespace(input.driveId, input.signal);
    if (input.objectId === `${ROOT_PREFIX}${input.driveId}`)
      return this.#destinationRoot(input.driveId);
    if (!/^id:[A-Za-z0-9_-]+$/u.test(input.objectId))
      throw new ProviderFault(
        "unsupported_route",
        "The destination object ID is not a Dropbox ID.",
      );
    try {
      const raw = await this.#write<DropboxItem>(
        "files/get_metadata",
        { path: input.objectId },
        input.driveId,
        input.signal,
      );
      return this.#destinationEntry(raw, input.driveId, null);
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

  async resolveDestinationPath(input: {
    driveId: string;
    folderPath: string;
  }): Promise<DestinationEntry | null> {
    await this.#destinationNamespace(input.driveId);
    if (!input.folderPath) return this.#destinationRoot(input.driveId);
    try {
      const raw = await this.#write<DropboxItem>(
        "files/get_metadata",
        { path: `/${input.folderPath}` },
        input.driveId,
      );
      return this.#destinationEntry(raw, input.driveId, null);
    } catch (error) {
      if (error instanceof HttpProviderFault && error.status === 404) return null;
      throw error;
    }
  }

  async listDestinationChildren(
    destFolderId: string,
    signal?: AbortSignal,
  ): Promise<DestinationEntry[]> {
    const { namespace } = this.#folderNamespace(destFolderId);
    const path = destFolderId.startsWith(ROOT_PREFIX) ? "" : destFolderId;
    const items: DestinationEntry[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      signal?.throwIfAborted();
      const page: { entries: DropboxItem[]; has_more: boolean; cursor: string } = await this.#write(
        cursor === null ? "files/list_folder" : "files/list_folder/continue",
        cursor === null ? { path, include_non_downloadable_files: true, limit: 2000 } : { cursor },
        namespace,
        signal,
      );
      for (const raw of page.entries)
        if (raw[".tag"] !== "deleted")
          items.push(this.#destinationEntry(raw, namespace, destFolderId));
      if (!page.has_more) break;
      if (!page.cursor || cursors.has(page.cursor))
        throw new ProviderFault("provider_request_failed", "Destination paging repeated a cursor.");
      cursor = page.cursor;
      cursors.add(cursor);
    }
    return items;
  }

  /** ADR-0020 D5: a mapping's folder inside a team folder this job created. */
  async createDestinationFolder(
    input: Parameters<ProviderPort["createDestinationFolder"]>[0],
  ): Promise<DestinationEntry> {
    if (input.destinationId !== undefined || input.marker !== undefined)
      throw new ProviderFault(
        "unsupported_route",
        "Dropbox folders take neither reserved IDs nor markers.",
      );
    const { namespace, path } = this.#folderNamespace(input.parentFolderId);
    await this.#destinationNamespace(namespace);
    // autorename false: a same-named entry refuses with a path conflict, never a renamed copy.
    // https://www.dropbox.com/developers/documentation/http/documentation#files-create_folder_v2
    const result = await this.#write<{ metadata: Omit<DropboxItem, ".tag"> }>(
      "files/create_folder_v2",
      { path: `${path}/${input.name}`, autorename: false },
      namespace,
    );
    // The result carries FolderMetadata, not the tagged Metadata union.
    return this.#destinationEntry(
      { ...result.metadata, ".tag": "folder" },
      namespace,
      input.parentFolderId,
    );
  }

  async resolveDestinationPass(input: FilePassInput): Promise<FilePassRoot> {
    const destination = await this.resolveDestinationFolder(input);
    if (
      !destination ||
      destination.kind !== "folder" ||
      !this.#session.dropboxDestinationRemote ||
      !this.#session.dropboxDestinationAdminId
    )
      unsupported();
    const nativePath = this.#folderNamespace(destination.id).path;
    const nativeParts = nativePath.split("/").filter(Boolean);
    const standardParts = nativeParts.map(dropboxDestinationNameToStandard);
    if (
      standardParts.some(
        (part, index) => part === null || dropboxDestinationName(part) !== nativeParts[index],
      )
    )
      throw new ProviderFault(
        "unsupported_route",
        "The destination root has no lossless transfer path.",
      );
    // batch_mode=sync commits up to --transfers files per finish_batch and reports
    // per-file failures; async would hide which file failed.
    // https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L566-L590
    return {
      fs: `${this.#session.dropboxDestinationRemote},root_namespace=${quote(input.destDriveId)},impersonate_admin=${quote(this.#session.dropboxDestinationAdminId)},batch_mode=sync,encoding=${quote(DROPBOX_ENCODING)}:${standardParts.join("/")}`,
      kind: "dropbox",
    };
  }

  async preflightDestination(root: DestinationRoot, signal?: AbortSignal): Promise<void> {
    const destination = await this.resolveDestinationFolder({
      destDriveId: root.destDriveId,
      destFolderId: root.destFolderId,
      ...(signal ? { signal } : {}),
    });
    if (!destination || destination.kind !== "folder")
      throw new ProviderFault("preflight_failed", "The destination folder is inaccessible.");
    await this.listDestinationChildren(destination.id, signal);
  }

  async probeDestination(
    root: DestinationRoot,
    mapping?: Mapping,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    void root;
    void mapping;
    // The monthly allowance is a team-wide call count; only its ceiling is observable.
    const features = await this.#features(signal);
    return {
      teamSharedDropbox: features.teamSharedDropbox,
      uploadApiRateLimit: features.uploadApiRateLimit,
      batchMode: "sync",
    };
  }
}
