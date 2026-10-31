import { ProviderFault } from "../fault.ts";
import {
  HttpProviderFault,
  cursorPages,
  fetchProvider,
  responseBytes,
  responseJson,
} from "../http.ts";
import type { CredentialSession } from "../credentials.ts";
import type { SourceEntry, DestinationEntry, FilePassRoot, ProviderPort } from "../port.ts";
import type { AdapterInput, FileAdapter, FilePassInput, Mapping } from "./effects.ts";

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
  client_modified?: string;
  server_modified?: string;
  is_downloadable?: boolean;
  export_info?: { export_as?: string; export_options?: string[] };
}

function unsupported(): never {
  throw new ProviderFault(
    "unsupported_route",
    "Dropbox is supported only as a source into Google Shared Drives.",
  );
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Namespace identity, not a member's mount name, determines every Dropbox source read. */
export class DropboxAdapter implements FileAdapter {
  readonly #session: CredentialSession;
  readonly #mappings: Mapping[];
  #namespaces: Promise<Map<string, Namespace>> | undefined;

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
  ): Promise<Response> {
    const host = content ? "content.dropboxapi.com" : "api.dropboxapi.com";
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.#session.dropboxToken(signal)}`,
    };
    if (namespace !== undefined) {
      if (!this.#session.dropboxAdminId)
        throw new ProviderFault(
          "credential_config_invalid",
          "A Dropbox team administrator identity is required.",
        );
      headers["Dropbox-API-Select-Admin"] = this.#session.dropboxAdminId;
      headers["Dropbox-API-Path-Root"] = JSON.stringify({
        ".tag": "namespace_id",
        namespace_id: namespace,
      });
    }
    if (selectUser) {
      if (!this.#session.dropboxAdminId)
        throw new ProviderFault(
          "credential_config_invalid",
          "A Dropbox team administrator identity is required.",
        );
      headers["Dropbox-API-Select-User"] = this.#session.dropboxAdminId;
    }
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
      throw new HttpProviderFault(status, retryAfter, undefined, host);
    }
    return response;
  }

  async #request<T>(
    endpoint: string,
    body: unknown,
    namespace?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return responseJson<T>(await this.#response(endpoint, body, namespace, signal));
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
    const namespaces = new Map<string, Namespace>();
    for await (const entries of cursorPages(
      null,
      async (cursor) => {
        const page = await this.#request<{
          namespaces: Namespace[];
          has_more: boolean;
          cursor: string;
        }>(
          cursor ? "team/namespaces/list/continue" : "team/namespaces/list",
          cursor ? { cursor } : {},
          undefined,
          signal,
        );
        return { value: page.namespaces, next: page.has_more ? page.cursor : null };
      },
      () =>
        new ProviderFault("provider_request_failed", "Dropbox namespace paging repeated a cursor."),
    )) {
      for (const entry of entries) {
        const previous = namespaces.get(entry.namespace_id);
        if (previous && previous.namespace_type[".tag"] !== entry.namespace_type[".tag"])
          throw new ProviderFault(
            "provider_request_failed",
            "Dropbox returned conflicting namespace identities.",
          );
        namespaces.set(entry.namespace_id, entry);
      }
    }
    return namespaces;
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
    const exportFormats = [raw.export_info?.export_as, ...(raw.export_info?.export_options ?? [])];
    const paper = raw.is_downloadable === false && exportFormats.includes("html");
    const unsupportedExport = !folder && raw.is_downloadable === false && !paper;
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
      name: paper ? raw.name.replace(/\.paper$/, "") + ".html" : raw.name,
      kind: folder ? "folder" : unsupportedExport ? "undownloadable" : "file",
      size: folder || paper || unsupportedExport ? null : (raw.size ?? null),
      etag: raw.rev ?? null,
      createdAt: raw.client_modified ?? "",
      modifiedAt: raw.server_modified ?? "",
      mimeType: paper ? "text/html" : null,
      identity: `${namespace}:${raw.id}`,
      downloadable: !folder && !unsupportedExport,
      webUrl: null,
      packageSections: null,
      metadata: {
        path,
        originalName: raw.name,
        ...(paper
          ? { contentDisposition: "paper_html" }
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

  async listSourceChildren(
    input: Parameters<ProviderPort["listSourceChildren"]>[0],
  ): Promise<SourceEntry[]> {
    await this.#namespace(input.driveId, input.signal);
    const entries: SourceEntry[] = [];
    const seen = new Set<string>();
    for await (const page of cursorPages(
      null,
      async (cursor) => {
        const result = await this.#request<{
          entries: DropboxItem[];
          has_more: boolean;
          cursor: string;
        }>(
          cursor ? "files/list_folder/continue" : "files/list_folder",
          cursor
            ? { cursor }
            : {
                path: input.itemId === "/" ? "" : input.itemId,
                recursive: false,
                include_deleted: false,
                include_non_downloadable_files: true,
                include_mounted_folders: false,
                limit: 1000,
              },
          input.driveId,
          input.signal,
        );
        return { value: result.entries, next: result.has_more ? result.cursor : null };
      },
      () =>
        new ProviderFault("provider_request_failed", "Dropbox folder paging repeated a cursor."),
    )) {
      for (const raw of page)
        if (raw[".tag"] !== "deleted" && !seen.has(raw.id)) {
          seen.add(raw.id);
          entries.push(this.#entry(raw, input.driveId, input.itemId));
        }
    }
    return entries;
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
    const paper = entry.metadata?.contentDisposition === "paper_html";
    const response = await this.#response(
      paper ? "files/export" : "files/download",
      { path: input.itemId, ...(paper ? { export_format: "html" } : {}) },
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

  async resolveDestinationPass(): Promise<FilePassRoot> {
    return unsupported();
  }
  async preflightDestination(): Promise<void> {
    unsupported();
  }
  async resolveDestinationFolder(): Promise<DestinationEntry | null> {
    return unsupported();
  }
  async resolveDestinationPath(): Promise<DestinationEntry | null> {
    return unsupported();
  }
  async readDestinationObject(): Promise<DestinationEntry | null> {
    return unsupported();
  }
  async listDestinationChildren(): Promise<DestinationEntry[]> {
    return unsupported();
  }
}
