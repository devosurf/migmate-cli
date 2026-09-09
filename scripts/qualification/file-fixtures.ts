import assert from "node:assert/strict";
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
import type { FileState } from "../../src/engine/drivers/file-state.ts";
import { QualificationBlocked } from "./common.ts";

const folderMime = "application/vnd.google-apps.folder";
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stableId = /^[A-Za-z0-9_!.,@-]{1,512}$/;

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new QualificationBlocked("file_fixture_config_invalid");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !stableId.test(value))
    throw new QualificationBlocked("file_fixture_identifier_invalid");
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
    pathUnrepresentableId?: string;
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
    throw new QualificationBlocked("file_disposable_roots_and_mutation_credentials_required");
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
      throw new QualificationBlocked("file_fixture_roots_must_match_mapping");
  }
  const specialSources: FileFixturesConfig["specialSources"] = {};
  for (const key of [
    "packageId",
    "referenceId",
    "undownloadableId",
    "pathUnrepresentableId",
  ] as const) {
    if (special[key] !== undefined) specialSources[key] = identifier(special[key]);
  }
  if (new Set(Object.values(specialSources)).size !== Object.values(specialSources).length)
    throw new QualificationBlocked("file_special_fixture_ids_must_be_distinct");
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
}
interface OwnedDestination {
  privateOwner: boolean;
  mappingIds: Set<string>;
  revisions: Set<string>;
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
      throw new QualificationBlocked("file_fixture_mutator_must_be_separate_same_tenant_app");
    }
    await this.#mutationToken();
    const roots = this.#config.disposableRoots;
    const drive = await this.#graph<{ id: string; driveType: string }>(
      `/v1.0/drives/${encodeURIComponent(roots.sourceDriveId)}`,
    );
    if (drive.id !== roots.sourceDriveId || drive.driveType !== "documentLibrary")
      throw new QualificationBlocked("file_fixture_source_must_be_sharepoint_library");
    const source = await this.#source(roots.sourceItemId);
    const destination = await this.#destination(roots.destFolderId);
    if (
      !source.folder ||
      destination.item.mimeType !== folderMime ||
      destination.item.driveId !== roots.destDriveId
    ) {
      throw new QualificationBlocked("file_fixture_roots_unavailable");
    }
    // Special fixtures are read-only prerequisites, not tool-owned cleanup targets.
    for (const id of Object.values(this.#config.specialSources)) {
      const item = await this.#source(id);
      if (
        item.parentReference?.id !== roots.sourceItemId ||
        item.parentReference.driveId !== roots.sourceDriveId
      ) {
        throw new QualificationBlocked(
          "file_special_fixtures_must_be_direct_children_of_source_root",
        );
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
        throw new QualificationBlocked("file_fixture_mutation_secret_invalid");
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
        throw new QualificationBlocked("file_fixture_mutation_authentication_failed");
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
  ): Promise<{ item: GoogleItem; etag: string | null }> {
    const response = await this.#google(
      `/drive/v3/files/${encodeURIComponent(identifier(id))}?supportsAllDrives=true&fields=id,name,driveId,parents,mimeType,appProperties,modifiedTime`,
      {},
      cleanup,
    );
    return { item: await responseJson<GoogleItem>(response), etag: response.headers.get("etag") };
  }
  async #sourceParent(id: string, cleanup = false): Promise<void> {
    const seen = new Set<string>();
    while (id !== this.#config.disposableRoots.sourceItemId) {
      if (seen.has(id) || this.#sources.get(id) !== true)
        throw new QualificationBlocked("file_fixture_mutation_outside_owned_source");
      seen.add(id);
      const item = await this.#source(id, cleanup);
      if (
        item.parentReference?.driveId !== this.#config.disposableRoots.sourceDriveId ||
        !item.parentReference.id
      ) {
        throw new QualificationBlocked("file_fixture_mutation_outside_owned_source");
      }
      id = item.parentReference.id;
    }
  }
  async #destinationParent(id: string, cleanup = false): Promise<void> {
    const seen = new Set<string>();
    while (id !== this.#config.disposableRoots.destFolderId) {
      if (seen.has(id) || !this.#destinations.has(id))
        throw new QualificationBlocked("file_fixture_mutation_outside_owned_destination");
      seen.add(id);
      const current = await this.#destination(id, cleanup);
      if (
        current.item.driveId !== this.#config.disposableRoots.destDriveId ||
        current.item.parents?.length !== 1
      ) {
        throw new QualificationBlocked("file_fixture_mutation_outside_owned_destination");
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
    if (/[\/\\\u0000]/.test(name) || !name)
      throw new QualificationBlocked("file_fixture_name_invalid");
    // Every upload is beneath a freshly tool-created folder. Never overwrite a supplied root child.
    if (!this.#sources.has(parent))
      throw new QualificationBlocked("file_fixture_file_requires_owned_parent");
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
  async updateSource(id: string, bytes: Uint8Array): Promise<void> {
    if (this.#sources.get(id) !== false)
      throw new QualificationBlocked("file_fixture_update_requires_owned_source_file");
    const before = await this.#source(id);
    await this.#sourceParent(identifier(before.parentReference?.id));
    if (!before.eTag) throw new QualificationBlocked("file_fixture_source_etag_required");
    const after = await this.#graph<GraphItem>(`${this.#sourcePath(id)}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "If-Match": before.eTag },
      body: bytes,
    });
    assert.deepStrictEqual(after.id, id);
  }
  async moveSource(id: string, parent: string, name: string): Promise<void> {
    if (!this.#sources.has(id) || !this.#sources.has(parent))
      throw new QualificationBlocked("file_fixture_move_requires_owned_source");
    const before = await this.#source(id);
    await this.#sourceParent(parent);
    await this.#sourceParent(identifier(before.parentReference?.id));
    if (!before.eTag) throw new QualificationBlocked("file_fixture_source_etag_required");
    const after = await this.#graph<GraphItem>(this.#sourcePath(id), {
      method: "PATCH",
      headers: { "If-Match": before.eTag },
      body: JSON.stringify({ parentReference: { id: parent }, name }),
    });
    assert.deepStrictEqual(after.id, id);
  }
  async deleteSource(id: string, cleanup = false): Promise<void> {
    if (!this.#sources.has(id))
      throw new QualificationBlocked("file_fixture_delete_requires_owned_source");
    const item = await this.#source(id, cleanup);
    await this.#sourceParent(identifier(item.parentReference?.id), cleanup);
    if (item.folder) {
      const children = await this.#graph<{ value: unknown[] }>(
        `${this.#sourcePath(id)}/children?$top=1`,
        {},
        cleanup,
      );
      if (children.value.length)
        throw new QualificationBlocked("file_fixture_cleanup_source_not_empty");
    }
    if (!item.eTag) throw new QualificationBlocked("file_fixture_source_etag_required");
    await this.#graph(
      this.#sourcePath(id),
      { method: "DELETE", headers: { "If-Match": item.eTag } },
      cleanup,
    );
    this.#sources.delete(id);
  }
  async rejectedSourceName(parent: string): Promise<number> {
    if (!this.#sources.has(parent))
      throw new QualificationBlocked("file_fixture_invalid_name_requires_owned_parent");
    await this.#sourceParent(parent);
    try {
      // This is a real source route-limit observation, NOT a driver path_unrepresentable finding.
      const item = await this.#graph<GraphItem>(`${this.#sourcePath(parent)}/children`, {
        method: "POST",
        body: JSON.stringify({
          name: "invalid\\name",
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      });
      this.#sources.set(identifier(item.id), true);
      throw new QualificationBlocked("file_source_invalid_name_was_not_rejected");
    } catch (error) {
      if (error instanceof HttpProviderFault && error.status === 400) return error.status;
      throw error;
    }
  }
  async destinationObject(
    parent: string,
    name: string,
    mimeType = folderMime,
    shortcutTarget?: string,
  ): Promise<string> {
    await this.#destinationParent(parent);
    if (shortcutTarget && !this.#destinations.has(shortcutTarget))
      throw new QualificationBlocked("file_fixture_shortcut_target_not_owned");
    const item = await responseJson<GoogleItem>(
      await this.#google("/drive/v3/files?supportsAllDrives=true&fields=id", {
        method: "POST",
        body: JSON.stringify({
          name,
          parents: [parent],
          mimeType,
          appProperties: { qowner: this.owner },
          ...(shortcutTarget ? { shortcutDetails: { targetId: shortcutTarget } } : {}),
        }),
      }),
    );
    const id = identifier(item.id);
    this.#destinations.set(id, { privateOwner: true, mappingIds: new Set(), revisions: new Set() });
    return id;
  }
  registerIntent(state: FileState): void {
    if (!state.output.id || state.output.driveId !== this.#config.disposableRoots.destDriveId)
      return;
    const owned = this.#destinations.get(state.output.id) ?? {
      privateOwner: false,
      mappingIds: new Set<string>(),
      revisions: new Set<string>(),
    };
    owned.mappingIds.add(state.marker.mappingId);
    if (state.marker.stateRevision) owned.revisions.add(state.marker.stateRevision);
    this.#destinations.set(state.output.id, owned);
  }
  async tagDestination(id: string, stateRevision: string, expectedEtag: string): Promise<void> {
    const owned = this.#destinations.get(id);
    if (!owned || !owned.revisions.has(stateRevision))
      throw new QualificationBlocked("file_fixture_destination_not_owned");
    const current = await this.#destination(id);
    if (
      current.item.driveId !== this.#config.disposableRoots.destDriveId ||
      current.etag !== expectedEtag
    ) {
      throw new QualificationBlocked("file_fixture_destination_changed_before_tag");
    }
    if (current.item.appProperties?.qowner === this.owner) {
      owned.privateOwner = true;
      return;
    }
    if (current.item.appProperties?.qowner !== undefined)
      throw new QualificationBlocked("file_fixture_destination_has_different_owner");
    await this.#patchDestination(
      id,
      { appProperties: { qowner: this.owner }, modifiedTime: current.item.modifiedTime },
      current.etag,
    );
    owned.privateOwner = true;
  }
  async #patchDestination(
    id: string,
    patch: Record<string, unknown>,
    etag: string | null,
  ): Promise<void> {
    if (!this.#destinations.has(id) || !etag)
      throw new QualificationBlocked("file_fixture_destination_ownership_or_etag_missing");
    const current = await this.#destination(id);
    if (current.etag !== etag || current.item.parents?.length !== 1)
      throw new QualificationBlocked("file_fixture_destination_changed_before_mutation");
    await this.#destinationParent(current.item.parents[0]!);
    const response = await this.#google(
      `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id`,
      {
        method: "PATCH",
        headers: { "If-Match": etag },
        body: JSON.stringify(patch),
      },
    );
    await requireSuccess(response);
    await response.body?.cancel();
  }
  async renameDestination(id: string, name: string): Promise<void> {
    const current = await this.#destination(id);
    await this.#patchDestination(
      id,
      { name, modifiedTime: current.item.modifiedTime },
      current.etag,
    );
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
      throw new QualificationBlocked("file_fixture_cleanup_inventory_incomplete");
    return result.files.map((item) => item.id);
  }
  async cleanup(): Promise<void> {
    let failed = false;
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
            error instanceof QualificationBlocked &&
            error.gate === "file_fixture_cleanup_source_not_empty"
          ))
            failed = true;
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
            throw new QualificationBlocked("file_fixture_cleanup_destination_drive_changed");
          if (current.item.parents?.length !== 1)
            throw new QualificationBlocked("file_fixture_cleanup_destination_parent_changed");
          await this.#destinationParent(current.item.parents[0]!, true);
          if (owned.privateOwner) {
            if (current.item.appProperties?.qowner !== this.owner)
              throw new QualificationBlocked("file_fixture_cleanup_owner_changed");
          } else {
            // Unfinished intents are never adopted by name. Decode through the real effects in the suite before tagging;
            // absent objects are safe, but an untagged materialized object remains for manual recovery.
            throw new QualificationBlocked("file_fixture_cleanup_untagged_intent");
          }
          if (
            current.item.mimeType === folderMime &&
            (await this.destinationChildren(id, true)).length
          )
            continue;
          if (!current.etag)
            throw new QualificationBlocked("file_fixture_destination_etag_required");
          const response = await this.#google(
            `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
            {
              method: "DELETE",
              headers: { "If-Match": current.etag },
            },
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
          } else failed = true;
        }
      }
      if (!progress) break;
    }
    this.#token = undefined;
    if (failed || this.#sources.size || this.#destinations.size)
      throw new QualificationBlocked("file_fixture_cleanup_incomplete");
  }
}
