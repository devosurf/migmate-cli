import { randomUUID } from "node:crypto";
import {
  readCredentialFile,
  type CredentialSession,
  type FileCredentialReference,
} from "../../src/engine/providers/credentials.ts";
import {
  fetchProvider,
  googleUrl,
  graphUrl,
  HttpProviderFault,
  requireSuccess,
  responseJson,
} from "../../src/engine/providers/http.ts";
import type { FileMappingConfig } from "../../src/engine/drivers/file-migration.ts";
import { LiveTestBlocked } from "./common.ts";

const folderMime = "application/vnd.google-apps.folder";
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stableId = /^[A-Za-z0-9_!.,@-]{1,512}$/;

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LiveTestBlocked("file_fixture_config_invalid");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !stableId.test(value))
    throw new LiveTestBlocked("file_fixture_identifier_invalid");
  return value;
}

export interface FileFixturesConfig {
  disposableRoots: {
    sourceDriveId: string;
    sourceItemId: string;
    destDriveId: string;
    destFolderId: string;
    acknowledged: true;
  };
  graphMutation: { tenantId: string; clientId: string; clientSecret: FileCredentialReference };
  specialSources: {
    packageId?: string;
    referenceId?: string;
    undownloadableId?: string;
  };
}

export function fixtureConfig(value: unknown, mapping: FileMappingConfig): FileFixturesConfig {
  const input = object(value);
  const roots = object(input.disposableRoots);
  const mutation = object(input.graphMutation);
  const secret = object(mutation.clientSecret);
  const special = input.specialSources === undefined ? {} : object(input.specialSources);
  if (
    roots.acknowledged !== true ||
    mutation.tenantId === undefined ||
    mutation.clientId === undefined ||
    !guid.test(String(mutation.tenantId)) ||
    !guid.test(String(mutation.clientId)) ||
    secret.resolver !== "file" ||
    typeof secret.path !== "string" ||
    (secret.mode !== undefined && secret.mode !== "0600")
  ) {
    throw new LiveTestBlocked("file_disposable_roots_and_mutation_credentials_required");
  }
  const disposableRoots = {
    sourceDriveId: identifier(roots.sourceDriveId),
    sourceItemId: identifier(roots.sourceItemId),
    destDriveId: identifier(roots.destDriveId),
    destFolderId: identifier(roots.destFolderId),
    acknowledged: true as const,
  };
  for (const key of ["sourceDriveId", "sourceItemId", "destDriveId", "destFolderId"] as const) {
    if (disposableRoots[key] !== mapping[key])
      throw new LiveTestBlocked("file_fixture_roots_must_match_mapping");
  }
  const specialSources: FileFixturesConfig["specialSources"] = {};
  for (const key of ["packageId", "referenceId", "undownloadableId"] as const) {
    if (special[key] !== undefined) specialSources[key] = identifier(special[key]);
  }
  if (new Set(Object.values(specialSources)).size !== Object.values(specialSources).length)
    throw new LiveTestBlocked("file_special_fixture_ids_must_be_distinct");
  return {
    disposableRoots,
    graphMutation: {
      tenantId: String(mutation.tenantId).toLowerCase(),
      clientId: String(mutation.clientId).toLowerCase(),
      clientSecret: { resolver: "file", path: secret.path, mode: "0600" },
    },
    specialSources,
  };
}

interface GraphItem {
  id: string;
  name: string;
  eTag?: string;
  folder?: unknown;
  parentReference?: { id?: string; driveId?: string };
}
interface GoogleItem {
  id: string;
  name: string;
  driveId?: string;
  parents?: string[];
  mimeType: string;
  appProperties?: Record<string, string>;
  modifiedTime?: string;
  headRevisionId?: string;
}

/** Drive publishes no ETag and honours no If-Match, and its `version` advances
 * on server-side changes nobody made: ADR-0004. */
function destinationRevision(item: GoogleItem): string | null {
  if (!item.modifiedTime) return null;
  return `${item.headRevisionId ?? "-"}:${item.modifiedTime}`;
}
interface OwnedDestination {
  privateOwner: boolean;
}

/** Mutation credentials are independent of the route's read-only Graph identity. No arbitrary mutation URL is accepted. */
export class FileFixtures {
  readonly owner = randomUUID();
  readonly #sources = new Map<string, boolean>();
  readonly #destinations = new Map<string, OwnedDestination>();
  readonly #session: CredentialSession;
  readonly #config: FileFixturesConfig;
  readonly #jobDirectory: string;
  readonly #signal: AbortSignal;
  #token: string | undefined;
  #expiresAt = 0;

  constructor(
    config: FileFixturesConfig,
    session: CredentialSession,
    jobDirectory: string,
    signal: AbortSignal,
  ) {
    this.#config = config;
    this.#session = session;
    this.#jobDirectory = jobDirectory;
    this.#signal = signal;
  }

  async initialize(): Promise<void> {
    const evidence = object(await this.#session.evidence());
    const route = object(evidence.graph);
    if (
      route.clientId === this.#config.graphMutation.clientId ||
      route.tenantId !== this.#config.graphMutation.tenantId
    ) {
      throw new LiveTestBlocked("file_fixture_mutator_must_be_separate_same_tenant_app");
    }
    await this.#mutationToken();
    const roots = this.#config.disposableRoots;
    const drive = await this.#graph<{ id: string; driveType: string }>(
      `/v1.0/drives/${encodeURIComponent(roots.sourceDriveId)}`,
    );
    if (drive.id !== roots.sourceDriveId || drive.driveType !== "documentLibrary")
      throw new LiveTestBlocked("file_fixture_source_must_be_sharepoint_library");
    const source = await this.#source(roots.sourceItemId);
    const destination = await this.#destination(roots.destFolderId);
    if (
      !source.folder ||
      destination.item.mimeType !== folderMime ||
      destination.item.driveId !== roots.destDriveId
    ) {
      throw new LiveTestBlocked("file_fixture_roots_unavailable");
    }
    // Special fixtures are read-only prerequisites, not tool-owned cleanup targets.
    for (const id of Object.values(this.#config.specialSources)) {
      const item = await this.#source(id);
      if (
        item.parentReference?.id !== roots.sourceItemId ||
        item.parentReference.driveId !== roots.sourceDriveId
      ) {
        throw new LiveTestBlocked("file_special_fixtures_must_be_direct_children_of_source_root");
      }
    }
  }

  async #mutationToken(cleanup = false): Promise<string> {
    if (this.#token && this.#expiresAt > Date.now() + 60_000) return this.#token;
    const settings = this.#config.graphMutation;
    const credential = await readCredentialFile(settings.clientSecret, this.#jobDirectory);
    try {
      const secret = new TextDecoder("utf-8", { fatal: true })
        .decode(credential.bytes)
        .replace(/\r?\n$/, "");
      if (!secret || secret.length > 4096 || /[\x00-\x20\x7f]/.test(secret))
        throw new LiveTestBlocked("file_fixture_mutation_secret_invalid");
      const result = object(
        await responseJson(
          await fetchProvider(
            new URL(`https://login.microsoftonline.com/${settings.tenantId}/oauth2/v2.0/token`),
            {
              method: "POST",
              signal: cleanup ? AbortSignal.timeout(60_000) : this.#signal,
              body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: settings.clientId,
                client_secret: secret,
                scope: "https://graph.microsoft.com/.default",
              }),
            },
          ),
        ),
      );
      if (
        typeof result.access_token !== "string" ||
        result.token_type !== "Bearer" ||
        typeof result.expires_in !== "number" ||
        result.expires_in < 120
      ) {
        throw new LiveTestBlocked("file_fixture_mutation_authentication_failed");
      }
      this.#token = result.access_token;
      this.#expiresAt = Date.now() + result.expires_in * 1000;
      return this.#token;
    } finally {
      credential.bytes.fill(0);
    }
  }

  async #graph<T>(path: string, init: RequestInit = {}, cleanup = false): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.#mutationToken(cleanup)}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return responseJson<T>(
      await fetchProvider(graphUrl(path), {
        ...init,
        headers,
        signal: cleanup ? AbortSignal.timeout(60_000) : this.#signal,
      }),
    );
  }
  #sourcePath(id: string): string {
    return `/v1.0/drives/${encodeURIComponent(this.#config.disposableRoots.sourceDriveId)}/items/${encodeURIComponent(identifier(id))}`;
  }
  #source(id: string, cleanup = false): Promise<GraphItem> {
    return this.#graph(this.#sourcePath(id), {}, cleanup);
  }
  async #google(path: string, init: RequestInit = {}, cleanup = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.#session.googleToken()}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetchProvider(googleUrl(path), {
      ...init,
      headers,
      signal: cleanup ? AbortSignal.timeout(60_000) : this.#signal,
    });
  }
  async #destination(
    id: string,
    cleanup = false,
  ): Promise<{ item: GoogleItem; revision: string | null }> {
    const response = await this.#google(
      `/drive/v3/files/${encodeURIComponent(identifier(id))}?supportsAllDrives=true&fields=id,name,driveId,parents,mimeType,appProperties,modifiedTime,headRevisionId`,
      {},
      cleanup,
    );
    const item = await responseJson<GoogleItem>(response);
    return { item, revision: destinationRevision(item) };
  }
  async #sourceParent(id: string, cleanup = false): Promise<void> {
    const seen = new Set<string>();
    while (id !== this.#config.disposableRoots.sourceItemId) {
      if (seen.has(id) || this.#sources.get(id) !== true)
        throw new LiveTestBlocked("file_fixture_mutation_outside_owned_source");
      seen.add(id);
      const item = await this.#source(id, cleanup);
      if (
        item.parentReference?.driveId !== this.#config.disposableRoots.sourceDriveId ||
        !item.parentReference.id
      ) {
        throw new LiveTestBlocked("file_fixture_mutation_outside_owned_source");
      }
      id = item.parentReference.id;
    }
  }
  async #destinationParent(id: string, cleanup = false): Promise<void> {
    const seen = new Set<string>();
    while (id !== this.#config.disposableRoots.destFolderId) {
      if (seen.has(id) || !this.#destinations.has(id))
        throw new LiveTestBlocked("file_fixture_mutation_outside_owned_destination");
      seen.add(id);
      const current = await this.#destination(id, cleanup);
      if (
        current.item.driveId !== this.#config.disposableRoots.destDriveId ||
        current.item.parents?.length !== 1
      ) {
        throw new LiveTestBlocked("file_fixture_mutation_outside_owned_destination");
      }
      id = current.item.parents[0]!;
    }
  }
  async sourceFolder(parent: string, name: string): Promise<string> {
    await this.#sourceParent(parent);
    const item = await this.#graph<GraphItem>(`${this.#sourcePath(parent)}/children`, {
      method: "POST",
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    const id = identifier(item.id);
    this.#sources.set(id, true);
    return id;
  }
  async sourceFile(parent: string, name: string, bytes: Uint8Array): Promise<string> {
    await this.#sourceParent(parent);
    if (/[\/\\\u0000]/.test(name) || !name) throw new LiveTestBlocked("file_fixture_name_invalid");
    // Every upload is beneath a freshly tool-created folder. Never overwrite a supplied root child.
    if (!this.#sources.has(parent))
      throw new LiveTestBlocked("file_fixture_file_requires_owned_parent");
    const item = await this.#graph<GraphItem>(
      `${this.#sourcePath(parent)}:/${encodeURIComponent(name)}:/content?%40microsoft.graph.conflictBehavior=fail`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" },
        body: bytes,
      },
    );
    const id = identifier(item.id);
    this.#sources.set(id, false);
    return id;
  }
  async deleteSource(id: string, cleanup = false): Promise<void> {
    if (!this.#sources.has(id))
      throw new LiveTestBlocked("file_fixture_delete_requires_owned_source");
    const item = await this.#source(id, cleanup);
    await this.#sourceParent(identifier(item.parentReference?.id), cleanup);
    if (item.folder) {
      const children = await this.#graph<{ value: unknown[] }>(
        `${this.#sourcePath(id)}/children?$top=1`,
        {},
        cleanup,
      );
      if (children.value.length) throw new LiveTestBlocked("file_fixture_cleanup_source_not_empty");
    }
    if (!item.eTag) throw new LiveTestBlocked("file_fixture_source_etag_required");
    await this.#graph(
      this.#sourcePath(id),
      { method: "DELETE", headers: { "If-Match": item.eTag } },
      cleanup,
    );
    this.#sources.delete(id);
  }
  /** A reference is a `remoteItem`, which a document library refuses to hold: ADR-0006. */
  async rejectedReferenceItem(parent: string): Promise<number> {
    if (!this.#sources.has(parent))
      throw new LiveTestBlocked("file_fixture_reference_requires_owned_parent");
    await this.#sourceParent(parent);
    let created: string;
    try {
      // A real create attempt naming a real item of this same drive, not a fabricated facet.
      const item = await this.#graph<GraphItem>(`${this.#sourcePath(parent)}/children`, {
        method: "POST",
        body: JSON.stringify({
          name: `reference-${this.owner}`,
          remoteItem: {
            id: parent,
            parentReference: { driveId: this.#config.disposableRoots.sourceDriveId },
          },
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      });
      created = identifier(item.id);
      this.#sources.set(created, false);
    } catch (error) {
      if (error instanceof HttpProviderFault && error.status === 400) return error.status;
      throw error;
    }
    try {
      await this.deleteSource(created);
    } catch {
      // A leftover stays in the cleanup set and is reported there. The creatable
      // reference is the finding the operator must act on, so it wins here.
    }
    throw new LiveTestBlocked("file_live_reference_fixture_creatable");
  }
  async destinationObject(parent: string, name: string): Promise<string> {
    await this.#destinationParent(parent);
    const item = await responseJson<GoogleItem>(
      await this.#google("/drive/v3/files?supportsAllDrives=true&fields=id", {
        method: "POST",
        body: JSON.stringify({
          name,
          parents: [parent],
          mimeType: folderMime,
          appProperties: { qowner: this.owner },
        }),
      }),
    );
    const id = identifier(item.id);
    this.#destinations.set(id, { privateOwner: true });
    return id;
  }
  async destinationChildren(parent: string, cleanup = false): Promise<string[]> {
    const q = `'${parent.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}' in parents and trashed=false`;
    const query = new URLSearchParams({
      q,
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      pageSize: "1000",
      fields: "files(id),nextPageToken,incompleteSearch",
      corpora: "drive",
      driveId: this.#config.disposableRoots.destDriveId,
    });
    const result = await responseJson<{
      files: { id: string }[];
      nextPageToken?: string;
      incompleteSearch?: boolean;
    }>(await this.#google(`/drive/v3/files?${query}`, {}, cleanup));
    if (result.nextPageToken || result.incompleteSearch)
      throw new LiveTestBlocked("file_fixture_cleanup_inventory_incomplete");
    return result.files.map((item) => item.id);
  }
  /** Copy output is confined to newly created, explicitly disposable mapping roots.
   * The root's fixture tag authorizes teardown, not production file provenance. */
  async collectCopyOutputs(root: string): Promise<void> {
    const owned = this.#destinations.get(root);
    const current = await this.#destination(root, true);
    if (!owned?.privateOwner || current.item.appProperties?.qowner !== this.owner)
      throw new LiveTestBlocked("file_fixture_copy_root_not_owned");
    await this.#destinationParent(root, true);
    const parents = [root];
    for (const parent of parents) {
      for (const id of await this.destinationChildren(parent, true)) {
        const child = await this.#destination(id, true);
        if (
          child.item.driveId !== this.#config.disposableRoots.destDriveId ||
          child.item.parents?.length !== 1 ||
          child.item.parents[0] !== parent
        )
          throw new LiveTestBlocked("file_fixture_copy_output_unconfined");
        this.#destinations.set(id, { privateOwner: false });
        if (child.item.mimeType === folderMime) parents.push(id);
      }
    }
  }
  async cleanup(): Promise<void> {
    let failed = false;
    // A swallowed cleanup error is unactionable at the gate, so keep the first
    // reason per side: gate identifiers and HTTP statuses only.
    const reasons: Record<string, unknown> = {};
    const note = (side: "source" | "destination", id: string, error: unknown): void => {
      reasons[side] ??= {
        id,
        reason:
          error instanceof LiveTestBlocked
            ? error.gate
            : error instanceof HttpProviderFault
              ? `http_${error.status}`
              : "unknown",
      };
    };
    // Reverse creation order alone is insufficient after a source move. Delete only observed-empty folders, in bounded passes.
    for (let pass = 0, limit = this.#sources.size + 1; this.#sources.size && pass < limit; pass++) {
      let progress = false;
      for (const id of [...this.#sources.keys()].reverse()) {
        try {
          await this.deleteSource(id, true);
          progress = true;
        } catch (error) {
          if (error instanceof HttpProviderFault && error.status === 404) {
            this.#sources.delete(id);
            progress = true;
          } else if (!(
            error instanceof LiveTestBlocked &&
            error.gate === "file_fixture_cleanup_source_not_empty"
          )) {
            note("source", id, error);
            failed = true;
          }
        }
      }
      if (!progress) break;
    }
    for (
      let pass = 0, limit = this.#destinations.size + 1;
      this.#destinations.size && pass < limit;
      pass++
    ) {
      let progress = false;
      for (const [id, owned] of [...this.#destinations.entries()].reverse()) {
        try {
          const current = await this.#destination(id, true);
          if (current.item.driveId !== this.#config.disposableRoots.destDriveId)
            throw new LiveTestBlocked("file_fixture_cleanup_destination_drive_changed");
          if (current.item.parents?.length !== 1)
            throw new LiveTestBlocked("file_fixture_cleanup_destination_parent_changed");
          await this.#destinationParent(current.item.parents[0]!, true);
          if (owned.privateOwner) {
            if (current.item.appProperties?.qowner !== this.owner)
              throw new LiveTestBlocked("file_fixture_cleanup_owner_changed");
          }
          if (
            current.item.mimeType === folderMime &&
            (await this.destinationChildren(id, true)).length
          )
            continue;
          if (!current.revision)
            throw new LiveTestBlocked("file_fixture_destination_revision_required");
          const response = await this.#google(
            `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
            { method: "DELETE" },
            true,
          );
          await requireSuccess(response);
          await response.body?.cancel();
          this.#destinations.delete(id);
          progress = true;
        } catch (error) {
          if (error instanceof HttpProviderFault && error.status === 404) {
            this.#destinations.delete(id);
            progress = true;
          } else {
            note("destination", id, error);
            failed = true;
          }
        }
      }
      if (!progress) break;
    }
    this.#token = undefined;
    if (failed || this.#sources.size || this.#destinations.size)
      throw new LiveTestBlocked("file_fixture_cleanup_incomplete", {
        ...reasons,
        remaining: { sources: this.#sources.size, destinations: this.#destinations.size },
      });
  }
}
