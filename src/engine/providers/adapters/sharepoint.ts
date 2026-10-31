import type { CredentialSession } from "../credentials.ts";
import { ProviderFault } from "../fault.ts";
import { DiskListing, disposeListing } from "../listing.ts";
import {
  SHAREPOINT_DESTINATION_ENCODING,
  sharepointDestinationName,
  sharepointDestinationNameToStandard,
} from "./rclone-name-encoding.ts";
import {
  createGraphTransport,
  HttpProviderFault,
  cursorPages,
  fetchProvider,
  responseJson,
  type GraphTransport,
} from "../http.ts";
import type {
  DestinationContainer,
  DestinationEntry,
  DriveMember,
  DriveMembership,
  ProviderPort,
  SourceEntry,
  FilePassRoot,
} from "../port.ts";
import { sharepointOrigin } from "./credentials/sharepoint.ts";
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

const CREATION_REQUEST_PREFIX = "migmate:creation-request:";

interface GraphLibrary {
  id: string;
  displayName: string;
  description?: string | null;
  createdDateTime?: string;
  list?: { template?: string };
}

interface LibraryAccess {
  siteUrl: string;
  listPath: string;
}

interface SharePointPrincipal {
  Id: number;
  Email?: string;
  LoginName?: string;
  Title?: string;
  PrincipalType: number;
}

export class SharePointAdapter implements FileAdapter {
  readonly mappings: Mapping[];
  readonly #destinationRoots: DestinationRoot[];
  readonly #session: CredentialSession;
  readonly #graph: GraphTransport;
  readonly #graphDestination: GraphTransport;
  readonly #worker: SourceWorker;
  readonly #destDrive = new Map<string, string>();
  readonly #libraryAccess = new Map<string, LibraryAccess>();

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
    for (const root of this.#destinationRoots)
      this.#destDrive.set(root.destFolderId, root.destDriveId);
  }

  async destinationCreator(): Promise<string> {
    // Client credentials identify an application, not an implicit library member.
    return "";
  }

  async #container(siteId: string, library: GraphLibrary): Promise<DestinationContainer> {
    const drive = await this.#graphDestination.request<{ id: string }>(
      `/v1.0/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(library.id)}/drive?$select=id`,
    );
    const root = await this.#graphDestination.request<{ id: string }>(
      `/v1.0/drives/${encodeURIComponent(drive.id)}/root?$select=id`,
    );
    if (!drive.id || !root.id || !library.displayName)
      throw new ProviderFault("provider_request_failed", "Library identity is incomplete.");
    this.#destDrive.set(root.id, drive.id);
    const requestId =
      typeof library.description === "string" &&
      library.description.startsWith(CREATION_REQUEST_PREFIX)
        ? library.description.slice(CREATION_REQUEST_PREFIX.length)
        : "";
    return {
      id: drive.id,
      name: library.displayName,
      ...(library.createdDateTime ? { createdTime: library.createdDateTime } : {}),
      rootFolderId: root.id,
      ...(requestId && !/[^A-Za-z0-9_-]/u.test(requestId) ? { creationRequestId: requestId } : {}),
    };
  }

  async createDestinationContainer(
    input: Parameters<ProviderPort["createDestinationContainer"]>[0],
  ): Promise<DestinationContainer | null> {
    if (!input.siteId)
      throw new ProviderFault(
        "destination_site_required",
        "Library creation requires an existing site.",
      );
    // The marker is persisted with creation, not in a later crash-prone update.
    // It correlates recovery to the durable intent; it is not an idempotency key.
    // https://learn.microsoft.com/graph/api/list-create
    // https://learn.microsoft.com/graph/api/resources/list
    let library: GraphLibrary;
    try {
      library = await this.#graphDestination.request<GraphLibrary>(
        `/v1.0/sites/${encodeURIComponent(input.siteId)}/lists`,
        {
          method: "POST",
          body: JSON.stringify({
            displayName: input.name,
            description: `${CREATION_REQUEST_PREFIX}${input.requestId}`,
            list: { template: "documentLibrary" },
          }),
        },
      );
    } catch (error) {
      if (error instanceof HttpProviderFault && error.status === 409) return null;
      throw error;
    }
    return this.#container(input.siteId, library);
  }

  async findDestinationContainers(
    input: Parameters<ProviderPort["findDestinationContainers"]>[0],
  ): Promise<DestinationContainer[]> {
    if (!input.siteId)
      throw new ProviderFault(
        "destination_site_required",
        "Library recovery requires its existing site.",
      );
    const found: DestinationContainer[] = [];
    for await (const libraries of cursorPages(
      `/v1.0/sites/${encodeURIComponent(input.siteId)}/lists?$select=id,displayName,description,createdDateTime,list`,
      async (cursor) => {
        const page = await this.#graphDestination.request<{
          value: GraphLibrary[];
          "@odata.nextLink"?: string;
        }>(cursor!);
        return { value: page.value, next: page["@odata.nextLink"] };
      },
      () => new ProviderFault("provider_request_failed", "Library listing cursor repeated."),
    )) {
      for (const library of libraries) {
        if (library.displayName === input.name && library.list?.template === "documentLibrary")
          found.push(await this.#container(input.siteId, library));
      }
    }
    return found;
  }

  async validateDestinationCreation(
    input: Parameters<NonNullable<ProviderPort["validateDestinationCreation"]>>[0],
  ): Promise<void> {
    // Ordinary libraries inherit site access; this route neither reads their ACL
    // nor opens the optional certificate when no manifest members are named.
    if (input.members.length === 0) return;
    if (!input.siteId)
      throw new ProviderFault(
        "destination_site_required",
        "Library creation requires an existing site.",
      );
    try {
      const site = await this.#graphDestination.request<{ webUrl: string }>(
        `/v1.0/sites/${encodeURIComponent(input.siteId)}?$select=webUrl`,
      );
      await this.#membershipPermissions({ siteUrl: site.webUrl, listPath: "" });
    } catch (error) {
      if (!(error instanceof ProviderFault)) throw error;
      throw new ProviderFault("preflight_failed", error.message, {
        check: error.code,
        siteId: input.siteId,
      });
    }
  }

  async #access(driveId: string): Promise<LibraryAccess> {
    const cached = this.#libraryAccess.get(driveId);
    if (cached) return cached;
    const drive = await this.#graphDestination.request<{
      sharepointIds?: { siteUrl?: string; listId?: string };
    }>(`/v1.0/drives/${encodeURIComponent(driveId)}?$select=sharepointIds`);
    const { siteUrl, listId } = drive.sharepointIds ?? {};
    if (!siteUrl || !listId || !/^[0-9a-f-]{36}$/i.test(listId))
      throw new ProviderFault(
        "provider_request_failed",
        "Library SharePoint identity is unavailable.",
      );
    sharepointOrigin(siteUrl);
    const access = { siteUrl: siteUrl.replace(/\/$/, ""), listPath: `/web/lists(guid'${listId}')` };
    this.#libraryAccess.set(driveId, access);
    return access;
  }

  async #rest<T>(access: LibraryAccess, path: string, init: RequestInit = {}): Promise<T> {
    if (!this.#session.sharepointDestinationToken)
      throw new ProviderFault(
        "sharepoint_membership_credentials_required",
        "Named library members require the optional SharePoint certificate setup in CREDENTIALS.md.",
      );
    sharepointOrigin(access.siteUrl);
    const base = new URL(`${access.siteUrl.replace(/\/$/, "")}/_api/`);
    const url = new URL(path.startsWith("/") ? `${base.href}${path.slice(1)}` : path, base);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new ProviderFault(
        "provider_request_failed",
        "SharePoint paging escaped the selected site.",
      );
    const headers = new Headers(init.headers);
    headers.set(
      "Authorization",
      `Bearer ${await this.#session.sharepointDestinationToken(access.siteUrl)}`,
    );
    headers.set("Accept", "application/json;odata=nometadata");
    if (init.body) headers.set("Content-Type", "application/json;odata=nometadata");
    return responseJson<T>(await fetchProvider(url, { ...init, headers }));
  }

  async #membershipPermissions(access: LibraryAccess): Promise<void> {
    // Observe the named site's current capabilities, not merely the token's
    // Sites.Selected scope or an operator assertion of a fullcontrol grant.
    // https://learn.microsoft.com/previous-versions/office/sharepoint-visio/jj245395(v=office.15)
    let permissions: { High?: unknown; Low?: unknown };
    try {
      permissions = await this.#rest(access, "/web/effectiveBasePermissions");
    } catch (error) {
      if (!(error instanceof HttpProviderFault && (error.status === 401 || error.status === 403)))
        throw error;
      throw new ProviderFault(
        "sharepoint_membership_permissions_unproven",
        "The selected site's permission-management access was denied. See CREDENTIALS.md.",
      );
    }
    const halves = [permissions?.High, permissions?.Low];
    if (
      !halves.every(
        (part) =>
          (typeof part === "number" || typeof part === "string") &&
          /^\d+$/.test(String(part)) &&
          Number.isSafeInteger(Number(part)) &&
          Number(part) <= 0xffff_ffff,
      )
    )
      throw new ProviderFault(
        "sharepoint_membership_permissions_unproven",
        "SharePoint returned no usable site permission evidence. See CREDENTIALS.md.",
      );
    const mask = (BigInt(String(halves[0])) << 32n) | BigInt(String(halves[1]));
    // ManageLists, ManagePermissions, EnumeratePermissions. These are capabilities,
    // not proof of the assigned role's name. Never demand tenant-wide FullControl.
    // https://learn.microsoft.com/openspecs/sharepoint_protocols/ms-wssfo/e301f73a-002c-40a0-a24d-25a43784e840
    const required = 0x4000_0000_0200_0800n;
    if ((mask & required) !== required)
      throw new ProviderFault(
        "sharepoint_membership_permissions_unproven",
        "The selected site lacks observed permission-management capabilities. See CREDENTIALS.md.",
      );
  }

  async prepareDestinationMembers(driveId: string): Promise<void> {
    const access = await this.#access(driveId);
    await this.#membershipPermissions(access);
    const list = await this.#rest<{ HasUniqueRoleAssignments: boolean }>(
      access,
      `${access.listPath}?$select=HasUniqueRoleAssignments`,
    );
    if (list.HasUniqueRoleAssignments === true) return;
    if (list.HasUniqueRoleAssignments !== false)
      throw new ProviderFault(
        "provider_request_failed",
        "Library inheritance evidence is unavailable.",
      );
    // Only named-member libraries reach this effect. Retry must not reset grants.
    // The service may install an implicit current-principal grant: enumerate it,
    // do not assert an empty ACL or remove an unrecognized app/system principal.
    // https://learn.microsoft.com/sharepoint/dev/sp-add-ins/set-custom-permissions-on-a-list-by-using-the-rest-interface
    await this.#rest(
      access,
      `${access.listPath}/breakroleinheritance(copyRoleAssignments=false,clearSubscopes=false)`,
      { method: "POST" },
    );
  }

  async listDriveMembers(driveId: string): Promise<DriveMembership[]> {
    const access = await this.#access(driveId);
    const members: DriveMembership[] = [];
    for await (const assignments of cursorPages(
      `${access.listPath}/roleassignments?$expand=Member,RoleDefinitionBindings`,
      async (cursor) => {
        const page = await this.#rest<{
          value: {
            Member: SharePointPrincipal;
            RoleDefinitionBindings: { RoleTypeKind: number; Name: string }[];
          }[];
          "odata.nextLink"?: string;
          "@odata.nextLink"?: string;
        }>(access, cursor!);
        return { value: page.value, next: page["odata.nextLink"] ?? page["@odata.nextLink"] };
      },
      () => new ProviderFault("provider_request_failed", "Library membership cursor repeated."),
    )) {
      for (const assignment of assignments) {
        const principal = assignment.Member;
        for (const role of assignment.RoleDefinitionBindings) {
          members.push({
            email:
              principal.Email || principal.LoginName || principal.Title || String(principal.Id),
            type:
              principal.PrincipalType === 1
                ? "user"
                : [2, 4, 8].includes(principal.PrincipalType)
                  ? "group"
                  : `principal:${principal.PrincipalType}`,
            role:
              role.RoleTypeKind === 2
                ? "read"
                : role.RoleTypeKind === 3
                  ? "write"
                  : role.RoleTypeKind === 5
                    ? "owner"
                    : `sharepoint:${role.Name}`,
          });
        }
      }
    }
    return members;
  }

  async addDriveMember(driveId: string, member: DriveMember): Promise<void> {
    const roleTypes: Record<string, number> = { read: 2, write: 3, owner: 5 };
    const roleType = roleTypes[member.role];
    if (!roleType)
      throw new ProviderFault(
        "unsupported_member_role",
        "The member role is not supported by SharePoint.",
      );
    await this.prepareDestinationMembers(driveId);
    const access = await this.#access(driveId);
    let principal: SharePointPrincipal;
    if (member.type === "group") {
      // Resolve an exact registered group email, never guess directory claims.
      // Graph list permissions only grant applications, not named people.
      // https://learn.microsoft.com/graph/api/list-post-permissions
      const query = new URLSearchParams({
        $filter: `Email eq '${member.email.replace(/'/g, "''")}'`,
        $select: "Id,Email,LoginName,PrincipalType",
      });
      const groups: SharePointPrincipal[] = [];
      for await (const candidates of cursorPages(
        `/web/siteusers?${query}`,
        async (cursor) => {
          const page = await this.#rest<{
            value: SharePointPrincipal[];
            "odata.nextLink"?: string;
            "@odata.nextLink"?: string;
          }>(access, cursor!);
          return { value: page.value, next: page["odata.nextLink"] ?? page["@odata.nextLink"] };
        },
        () => new ProviderFault("provider_request_failed", "Group identity cursor repeated."),
      )) {
        groups.push(
          ...candidates.filter(
            (candidate) =>
              [2, 4].includes(candidate.PrincipalType) &&
              candidate.Email?.toLowerCase() === member.email.toLowerCase(),
          ),
        );
      }
      if (groups.length !== 1)
        throw new ProviderFault(
          "member_identity_unresolved",
          "The named group must be uniquely registered by email in the selected SharePoint site.",
        );
      principal = groups[0]!;
    } else {
      principal = await this.#rest<SharePointPrincipal>(access, "/web/ensureuser", {
        method: "POST",
        body: JSON.stringify({ logonName: member.email }),
      });
    }
    const actualType =
      principal.PrincipalType === 1
        ? "user"
        : [2, 4, 8].includes(principal.PrincipalType)
          ? "group"
          : "unsupported";
    if (
      !Number.isSafeInteger(principal.Id) ||
      actualType !== member.type ||
      principal.Email?.toLowerCase() !== member.email.toLowerCase()
    )
      throw new ProviderFault(
        "member_identity_unresolved",
        "SharePoint could not prove the named member identity.",
      );
    const role = await this.#rest<{ Id: number }>(
      access,
      `/web/roledefinitions/getbytype(${roleType})?$select=Id`,
    );
    if (!Number.isSafeInteger(role.Id))
      throw new ProviderFault(
        "provider_request_failed",
        "SharePoint role definition is unavailable.",
      );
    const assignmentPath = `${access.listPath}/roleassignments/getbyprincipalid(${principal.Id})`;
    let bindings: { RoleTypeKind: number }[] = [];
    try {
      const assignment = await this.#rest<{ RoleDefinitionBindings: { RoleTypeKind: number }[] }>(
        access,
        `${assignmentPath}?$expand=RoleDefinitionBindings`,
      );
      bindings = assignment.RoleDefinitionBindings;
    } catch (error) {
      if (!(error instanceof HttpProviderFault && error.status === 404)) throw error;
    }
    if (bindings.length === 1 && bindings[0]!.RoleTypeKind === roleType) return;
    if (bindings.length > 0) await this.#rest(access, assignmentPath, { method: "DELETE" });
    await this.#rest(
      access,
      `${access.listPath}/roleassignments/addroleassignment(principalid=${principal.Id},roledefid=${role.Id})`,
      { method: "POST" },
    );
  }

  async #source(raw: GraphItem, driveId: string, signal?: AbortSignal): Promise<SourceEntry> {
    signal?.throwIfAborted();
    if (raw.parentReference?.driveId && raw.parentReference.driveId !== driveId)
      throw new ProviderFault("unsupported_route", "The source belongs to another library.");
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
      using folders = new DiskListing<{ position: number; id: string }>((folder) =>
        String(folder.position),
      );
      let queued = 0;
      let visited = 0;
      folders.add({ position: queued++, id: raw.id });
      while (visited < queued) {
        signal?.throwIfAborted();
        const key = String(visited++);
        const folderId = folders.get(key)!.id;
        folders.delete(key);
        using cursors = new DiskListing<string>((cursor) => cursor);
        let cursor: string | undefined =
          `/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}/children?$top=200&$select=id,name,file,folder`;
        while (cursor) {
          signal?.throwIfAborted();
          if (cursors.has(cursor))
            throw new ProviderFault(
              "provider_request_failed",
              "Notebook section paging repeated a cursor.",
            );
          cursors.add(cursor);
          const page: { value: GraphItem[]; "@odata.nextLink"?: string } =
            await this.#graph.request<{
              value: GraphItem[];
              "@odata.nextLink"?: string;
            }>(cursor, { signal: signal ?? null });
          for (const child of page.value) {
            signal?.throwIfAborted();
            if (child.file && child.name.endsWith(".one")) packageSections++;
            else if (child.folder && child.name !== "OneNote_RecycleBin")
              folders.add({ position: queued++, id: child.id });
          }
          cursor = page["@odata.nextLink"];
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
      ...(raw.webUrl ? { webUrl: raw.webUrl } : {}),
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
      if (item.id !== input.itemId)
        throw new ProviderFault("source_read_failed", "The source stable item ID did not match.");
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
    const nativeParts = path.split("/");
    const standardParts = nativeParts.map(sharepointDestinationNameToStandard);
    if (
      standardParts.some(
        (part, index) => part === null || sharepointDestinationName(part) !== nativeParts[index],
      )
    )
      throw new ProviderFault(
        "unsupported_route",
        "The destination root has no lossless transfer path.",
      );
    return {
      fs: `${this.#session.sharepointDestinationRemote},drive_id=${quote(input.destDriveId)},encoding=${quote(SHAREPOINT_DESTINATION_ENCODING)}:${standardParts.join("/")}`,
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
  ): Promise<DiskListing<SourceEntry>> {
    const { driveId, itemId: sourceItemId } = input;
    const parent = await this.readSourceItem(input);
    if (
      !parent ||
      !(parent.kind === "folder" || (parent.kind === "package" && parent.packageSections !== null))
    )
      throw new ProviderFault(
        "preflight_failed",
        "The source parent is not an accessible directory at its stable ID.",
      );
    const items = new DiskListing<SourceEntry>((entry) => sourceKey(entry.driveId, entry.id));
    try {
      using cursors = new DiskListing<string>((cursor) => cursor);
      let cursor: string | undefined =
        `/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(sourceItemId)}/children?$top=200&$expand=listItem($expand=fields)`;
      while (cursor) {
        if (cursors.has(cursor))
          throw new ProviderFault("provider_request_failed", "Source paging repeated a cursor.");
        cursors.add(cursor);
        const page: { value: GraphItem[]; "@odata.nextLink"?: string } = await this.#graph.request<{
          value: GraphItem[];
          "@odata.nextLink"?: string;
        }>(cursor, { signal: input.signal ?? null });
        for (const raw of page.value)
          items.add(
            await this.#sourceMetadata(
              await this.#source(raw, driveId, input.signal),
              input.signal,
            ),
          );
        cursor = page["@odata.nextLink"];
      }
      input.signal?.throwIfAborted();
      return items;
    } catch (error) {
      disposeListing(items);
      throw error;
    }
  }

  async *openSourceContent(input: { driveId: string; itemId: string }): AsyncIterable<Uint8Array> {
    const { driveId, itemId: sourceItemId } = input;
    const before = await this.readSourceItem({ driveId, itemId: sourceItemId });
    if (!before?.downloadable || !before.etag || !before.parentId || !this.#session.sourceRemote)
      throw new ProviderFault(
        "source_read_failed",
        "The source does not expose stable downloadable ordinary file content.",
      );
    const path = await this.#sourcePath({ driveId, item: before });
    // OneDrive resolves streamed objects from the drive root, not root_folder_id.
    // Keep the exact library identity while the path remains bound to the item above.
    if (!driveId || /[\[\]\u0000-\u001f\u007f/\\]/u.test(driveId))
      throw new ProviderFault("preflight_failed", "The source identity is invalid.");
    const fs = `${this.#session.sourceRemote},drive_id='${driveId.replaceAll("'", "''")}',encoding=Slash:`;
    yield* this.#worker.read({ fs, path }) ??
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
    disposeListing(
      await this.listSourceChildren({
        driveId: source.driveId,
        itemId: source.id,
        ...(signal ? { signal } : {}),
      }),
    );
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
