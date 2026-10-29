import type { CredentialSession } from "../credentials.ts";
import { ProviderFault } from "../fault.ts";
import {
  createGraphTransport,
  HttpProviderFault,
  cursorPages,
  type GraphTransport,
} from "../http.ts";
import type { DestinationEntry, ProviderPort, SourceEntry, FilePassRoot } from "../port.ts";
import { discoverSharePoint } from "../discovery.ts";
import {
  sourceKey,
  type AdapterInput,
  type DestinationRoot,
  type Mapping,
  type SourceWorker,
  type FileAdapter,
  type FilePassInput,
} from "./effects.ts";

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

export class SharePointAdapter implements FileAdapter {
  readonly mappings: Mapping[];
  readonly #destinationRoots: DestinationRoot[];
  readonly #session: CredentialSession;
  readonly #graph: GraphTransport;
  readonly #graphDestination: GraphTransport;
  readonly #worker: SourceWorker;
  readonly #resolvedSources = new Set<string>();
  readonly #destDrive = new Map<string, string>();

  constructor(input: AdapterInput) {
    this.mappings = input.mappings;
    this.#destinationRoots = input.destinationRoots;
    this.#session = input.session;
    this.#graph = input.graph;
    // The write app is paced and authenticated as itself, never as the read-only source app.
    this.#graphDestination = createGraphTransport({
      ...input.session,
      graphToken: (signal) => input.session.graphDestinationToken(signal),
      evidence: async (signal) => ({
        graph: (await input.session.evidence(signal)).graphDestination,
      }),
    });
    this.#worker = input.worker;
    for (const mapping of this.mappings) {
      if (mapping.sourceItemId)
        this.#resolvedSources.add(sourceKey(mapping.sourceDriveId, mapping.sourceItemId));
    }
    for (const root of this.#destinationRoots)
      this.#destDrive.set(root.destFolderId, root.destDriveId);
  }

  async #source(raw: GraphItem, driveId: string, signal?: AbortSignal): Promise<SourceEntry> {
    signal?.throwIfAborted();
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
            }>(cursor!, { signal: signal ?? null });
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
  async #sourceMetadata(entry: SourceEntry, signal?: AbortSignal): Promise<SourceEntry> {
    signal?.throwIfAborted();
    if (entry.kind !== "file") return entry;
    const base = `/v1.0/drives/${encodeURIComponent(entry.driveId)}/items/${encodeURIComponent(entry.id)}`;
    let versionCount = 0;
    for await (const versions of cursorPages(
      `${base}/versions?$select=id`,
      async (cursor) => {
        const page = await this.#graph.request<{ value: unknown[]; "@odata.nextLink"?: string }>(
          cursor!,
          { signal: signal ?? null },
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
      retentionLabel = await this.#graph.request(`${base}/retentionLabel`, {
        signal: signal ?? null,
      });
    } catch (error) {
      // A missing label is not a missing source item. Authorization/transient faults still escape.
      if (!(error instanceof HttpProviderFault && error.status === 404)) throw error;
    }
    entry.metadata = { ...entry.metadata, versionCount, retentionLabel };
    return entry;
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
      const item = await this.#graph.request<GraphItem>(
        `/v1.0/drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.itemId)}?$expand=listItem($expand=fields)`,
        { signal: input.signal ?? null },
      );
      return await this.#sourceMetadata(
        await this.#source(item, input.driveId, input.signal),
        input.signal,
      );
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

  async resolveSourcePass(input: FilePassInput): Promise<FilePassRoot> {
    const source = await this.resolveSourceRoot(input);
    if (!source || source.kind !== "folder")
      throw new ProviderFault("unsupported_route", "The source root is not an ordinary folder.");
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
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
      fs: `${this.#session.sourceRemote},drive_id=${quote(input.sourceDriveId)},root_folder_id=,encoding=Slash:${path}`,
      kind: "sharepoint" as const,
      ignoreSizeAndChecksum: true,
    };
  }

  async resolveDestinationPass(input: FilePassInput): Promise<FilePassRoot> {
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
      fs: `${this.#session.sharepointDestinationRemote},drive_id=${quote(input.destDriveId)},encoding=Slash:${path}`,
      kind: "sharepoint" as const,
      ignoreSizeAndChecksum: true,
    };
  }

  async discoverSharePoint() {
    return discoverSharePoint(this.#graph);
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
    if (!this.mappings.some((mapping) => mapping.destDriveId === input.driveId))
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
    const initial = `/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(sourceItemId)}/children?$top=200&$expand=listItem($expand=fields)`;
    for await (const page of cursorPages(
      initial,
      async (cursor) => {
        const page = await this.#graph.request<{ value: GraphItem[]; "@odata.nextLink"?: string }>(
          cursor!,
          { signal: input.signal ?? null },
        );
        return { value: page.value, next: page["@odata.nextLink"] };
      },
      () => new ProviderFault("provider_request_failed", "Source paging repeated a cursor."),
    )) {
      for (const raw of page)
        items.push(
          await this.#sourceMetadata(await this.#source(raw, driveId, input.signal), input.signal),
        );
    }
    return items;
  }

  async *openSourceContent(input: { driveId: string; itemId: string }): AsyncIterable<Uint8Array> {
    const { driveId, itemId: sourceItemId } = input;
    if (!this.#resolvedSources.has(sourceKey(driveId, sourceItemId)))
      throw new ProviderFault("source_read_failed", "The source identity has not been resolved.");
    const before = await this.readSourceItem({ driveId, itemId: sourceItemId });
    if (!before?.downloadable || !before.etag || !before.parentId || !this.#session.sourceRemote)
      throw new ProviderFault(
        "source_read_failed",
        "The source does not expose stable downloadable ordinary file content.",
      );
    const path = await this.#sourcePath({ driveId, item: before });
    yield* this.#worker.read({ remote: this.#session.sourceRemote, driveId, path }) ??
      this.#graph.stream(
        `/v1.0/drives/${encodeURIComponent(driveId)}/root:/${path
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}:/content`,
      );
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

  async readDestinationObject(
    input: Parameters<NonNullable<ProviderPort["readDestinationObject"]>>[0],
  ): Promise<DestinationEntry | null> {
    if (!this.#destinationRoots.some((root) => root.destDriveId === input.driveId))
      throw new ProviderFault(
        "preflight_failed",
        "The destination drive is outside the configured roots.",
      );
    try {
      const raw = await this.#graphDestination.request<GraphItem>(
        `/v1.0/drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.objectId)}`,
        { signal: input.signal ?? null },
      );
      return this.#sharepointDestination(raw, input.driveId);
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
    const driveId = this.#destDrive.get(destFolderId);
    if (!driveId)
      throw new ProviderFault(
        "unsupported_route",
        "The destination parent is not in a configured library.",
      );
    const items: DestinationEntry[] = [];
    for await (const page of cursorPages(
      `/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(destFolderId)}/children?$top=200`,
      async (cursor) => {
        const page = await this.#graphDestination.request<{
          value: GraphItem[];
          "@odata.nextLink"?: string;
        }>(cursor!, { signal: signal ?? null });
        return { value: page.value, next: page["@odata.nextLink"] };
      },
      () => new ProviderFault("provider_request_failed", "Destination paging repeated a cursor."),
    ))
      for (const raw of page) items.push(this.#sharepointDestination(raw, driveId));
    return items;
  }

  async preflightSource(mapping: Mapping, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const drive = await this.#graph.request<{
      id: string;
      driveType: string;
      sharepointIds?: { siteId?: string };
      webUrl?: string;
    }>(`/v1.0/drives/${encodeURIComponent(mapping.sourceDriveId)}`, {
      signal: signal ?? null,
    });
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
      ...(signal ? { signal } : {}),
    });
    if (!source || source.kind !== "folder")
      throw new ProviderFault("preflight_failed", "The source root is not an enumerable folder.");
    await this.listSourceChildren({
      driveId: source.driveId,
      itemId: source.id,
      ...(signal ? { signal } : {}),
    });
    if (mapping.sourceSiteId) {
      const initial = `/v1.0/sites/${encodeURIComponent(mapping.sourceSiteId)}/drives?$select=id`;
      let found = false;
      for await (const items of cursorPages(
        initial,
        async (cursor) => {
          const page = await this.#graph.request<{
            value: { id: string }[];
            "@odata.nextLink"?: string;
          }>(cursor!, { signal: signal ?? null });
          return { value: page.value, next: page["@odata.nextLink"] };
        },
        () => new ProviderFault("provider_request_failed", "Site drive paging repeated a cursor."),
      )) {
        found ||= items.some((item) => item.id === mapping.sourceDriveId);
      }
      if (!found)
        throw new ProviderFault(
          "preflight_failed",
          "The source drive does not belong to the configured SharePoint site.",
        );
    }
    return {
      sourceSiteId: mapping.sourceSiteId ?? drive.sharepointIds?.siteId ?? null,
      sourceDriveType: drive.driveType,
    };
  }

  async preflightDestination(root: DestinationRoot, signal?: AbortSignal): Promise<void> {
    const drive = await this.#graphDestination.request<{ id: string; driveType: string }>(
      `/v1.0/drives/${encodeURIComponent(root.destDriveId)}`,
      { signal: signal ?? null },
    );
    if (drive.id !== root.destDriveId || drive.driveType !== "documentLibrary")
      throw new ProviderFault(
        "unsupported_route",
        "The destination is not the exact SharePoint document library.",
      );
    const destination = await this.resolveDestinationFolder({
      destDriveId: root.destDriveId,
      destFolderId: root.destFolderId,
      ...(signal ? { signal } : {}),
    });
    if (!destination || destination.kind !== "folder")
      throw new ProviderFault("preflight_failed", "The destination folder is inaccessible.");
    await this.listDestinationChildren(destination.id, signal);
  }
}
