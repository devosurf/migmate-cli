import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { JobType } from "../types.ts";
import {
  fileProviderPair,
  fileProvider,
  credentialBindings,
  type FileProviderId,
} from "./adapters/capabilities.ts";
import {
  assertSeparateSharePointApplications,
  loadArchiveGraph,
  requestGraphToken,
  loadSharePointCertificate,
  requestSharePointToken,
  sharepointOrigin,
} from "./adapters/credentials/sharepoint.ts";
import type { GraphCredential, SharePointCertificate } from "./adapters/credentials/sharepoint.ts";
import { loadArchiveGoogle, requestGoogleToken } from "./adapters/credentials/google.ts";
import type { GoogleCredential } from "./adapters/credentials/google.ts";
import { requestDropboxToken } from "./adapters/credentials/dropbox.ts";
import type { DropboxCredential } from "./adapters/credentials/dropbox.ts";
import { ProviderFault } from "./fault.ts";
import {
  allowedKeys,
  decodeUtf8,
  fileReference,
  record,
  refused,
  stableId,
  text,
} from "./adapters/credentials/shared.ts";
import type {
  CredentialMaterial,
  FileCredentialAdapter,
  FileCredentialReference,
  Token,
} from "./adapters/credentials/shared.ts";

export interface CredentialSession {
  graphToken(signal?: AbortSignal): Promise<string>;
  graphDestinationToken(signal?: AbortSignal): Promise<string>;
  sharepointDestinationToken?(siteUrl: string, signal?: AbortSignal): Promise<string>;
  googleToken(signal?: AbortSignal): Promise<string>;
  dropboxToken(signal?: AbortSignal): Promise<string>;
  readonly dropboxAdminId?: string | undefined;
  readonly dropboxRemote?: string | null;
  identity(signal?: AbortSignal): Promise<string>;
  evidence(signal?: AbortSignal): Promise<Record<string, unknown>>;
  readonly rcloneConfigPath: string | null;
  readonly sourceRemote: string | null;
  readonly destinationRemote: string | null;
  readonly sharepointDestinationRemote?: string | null;
  readonly delegatedSubject?: string | undefined;
  dispose(): void;
}

interface MappingIdentity {
  sourceType?: FileProviderId;
  sourceDriveId: string;
  sourceItemId?: string;
  sourceFolderPath?: string;
  destDriveId?: string;
  destFolderId?: string;
  sourceSiteId?: string;
}

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function inside(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function checkStat(stat: BigIntStats): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw refused("credential_ownership_unverifiable");
  if (!stat.isFile() || stat.nlink !== 1n) throw refused("credential_file_unsafe");
  if (stat.uid !== BigInt(uid)) throw refused("credential_owner_invalid");
  if ((stat.mode & 0o7177n) !== 0n || (stat.mode & 0o400n) === 0n) {
    throw refused("credential_permissions_invalid");
  }
  if (stat.size === 0n || stat.size > BigInt(MAX_CREDENTIAL_BYTES)) {
    throw refused("credential_file_invalid");
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function checkMacFileAcl(path: string): Promise<void> {
  // Darwin ACL grants are independent of mode bits. Refuse extended ACLs rather
  // than interpreting a second permission system as an owner-only file.
  // https://github.com/apple-oss-distributions/file_cmds/blob/main/ls/ls.1
  const { promise, resolve: accept, reject } = Promise.withResolvers<void>();
  execFile(
    "/bin/ls",
    ["-lde", path],
    {
      encoding: "buffer",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { LANG: "C", LC_ALL: "C" },
    },
    (error, stdout, stderr) => {
      const output = stdout.toString("utf8").trimEnd();
      // -e emits additional ACL rows even when extended attributes hide the '+'.
      const safe = !error && /^-r[w-]-------[ @] +/.test(output) && !output.includes("\n");
      stdout.fill(0);
      stderr.fill(0);
      if (safe) accept();
      else reject(refused("credential_permissions_invalid"));
    },
  );
  return promise;
}

/** Private maintainer seam: the caller must wipe bytes after use; never persist them. */
export async function readCredentialFile(
  ref: FileCredentialReference,
  jobDirectory: string,
): Promise<{ path: string; bytes: Buffer }> {
  try {
    const job = await realpath(resolve(jobDirectory));
    const requested = resolve(fileReference(ref).path);
    if (inside(job, requested)) throw refused("credential_inside_job");
    const before = await lstat(requested, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      throw refused("credential_file_unsafe");
    const path = await realpath(requested);
    if (inside(job, path)) throw refused("credential_inside_job");
    checkStat(before);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer | undefined;
    try {
      const opened = await file.stat({ bigint: true });
      checkStat(opened);
      if (!sameFile(before, opened)) throw refused("credential_file_changed");
      if (process.platform === "darwin") await checkMacFileAcl(path);
      // Size is bounded before allocation, including one byte to detect growth.
      bytes = Buffer.alloc(Number(opened.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      checkStat(after);
      const named = await lstat(path, { bigint: true });
      if (
        offset !== Number(opened.size) ||
        !sameFile(opened, after) ||
        !sameFile(after, named) ||
        (await realpath(requested)) !== path
      )
        throw refused("credential_file_changed");
      const result = bytes.subarray(0, offset);
      bytes = undefined;
      return { path, bytes: result };
    } finally {
      bytes?.fill(0);
      await file.close();
    }
  } catch (error) {
    if (error instanceof ProviderFault) throw error;
    throw refused("credential_file_unreadable");
  }
}

/** A deliberately narrow common subset of rclone's INI parser; no interpolation. */
export function parseCredentialIni(bytes: Buffer): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  const contents = decodeUtf8(bytes);
  if (contents.includes("\0")) throw refused("credential_config_invalid");
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const name = /^\[([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]$/.exec(line)?.[1];
      if (!name || sections.has(name)) throw refused("credential_config_invalid");
      section = new Map();
      sections.set(name, section);
      continue;
    }
    const pair = /^([a-z][a-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const key = pair?.[1];
    const value = pair?.[2];
    if (
      !section ||
      !key ||
      value === undefined ||
      section.has(key) ||
      /[\x00-\x1f\x7f#;]/.test(value) ||
      /^["'`]/.test(value) ||
      value.includes("${")
    ) {
      throw refused("credential_config_invalid");
    }
    section.set(key, value);
  }
  return sections;
}

function parseMappings(value: unknown, defaultSource: FileCredentialAdapter): MappingIdentity[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw refused("credential_mapping_invalid");
  return value.map((item: unknown) => {
    try {
      const mapping = record(item);
      const source =
        mapping.sourceType === undefined
          ? defaultSource
          : fileProvider(mapping.sourceType).credentials;
      const sourceType = mapping.sourceType === undefined ? undefined : source.mappingSourceType;
      const result: MappingIdentity = {
        sourceDriveId: stableId(mapping.sourceDriveId),
        ...(sourceType ? { sourceType } : {}),
        ...(mapping.createDrive === undefined || mapping.destDriveId !== undefined
          ? {
              destDriveId: stableId(mapping.destDriveId),
              // A SharePoint destination path resolves to its folder id while the manifest loads.
              ...(mapping.destFolderId !== undefined || typeof mapping.destFolderPath !== "string"
                ? { destFolderId: stableId(mapping.destFolderId) }
                : {}),
            }
          : {}),
      };
      if (mapping.sourceItemId !== undefined)
        result.sourceItemId = source.sourceItemId(mapping.sourceItemId);
      else if (typeof mapping.sourceFolderPath === "string")
        result.sourceFolderPath = mapping.sourceFolderPath;
      else throw refused("credential_mapping_invalid");
      if (mapping.sourceSiteId !== undefined) result.sourceSiteId = stableId(mapping.sourceSiteId);
      return result;
    } catch (error) {
      if (error instanceof ProviderFault) throw refused("credential_mapping_invalid");
      throw error;
    }
  });
}

interface CredentialState {
  jobType: JobType;
  graph: GraphCredential | undefined;
  graphDestination?: GraphCredential;
  sharepointDestinationRemote?: string;
  sharepointCertificateRef?: FileCredentialReference;
  google: GoogleCredential | undefined;
  dropbox?: DropboxCredential;
  dropboxRemote?: string;
  mappings: MappingIdentity[];
  configPath: string | null;
  sourceRemote: string | null;
  destinationRemote: string | null;
}

async function loadCredentials(
  jobType: JobType,
  config: unknown,
  jobDirectory: string,
  mode?: "archive_verification",
): Promise<CredentialState> {
  const input = record(config);
  if (mode && (jobType !== "teams_archive" || input.destination === undefined))
    throw refused("credential_config_unsupported");
  const material: CredentialMaterial = {};
  try {
    if (jobType === "teams_archive") {
      material.graph = await loadArchiveGraph(input, jobDirectory, readCredentialFile, mode);
      const google = await loadArchiveGoogle(input, jobDirectory, readCredentialFile);
      return {
        jobType,
        graph: material.graph,
        google,
        mappings: [],
        configPath: null,
        sourceRemote: null,
        destinationRemote: null,
      };
    }
    if (jobType !== "file_migration") throw refused("credential_config_unsupported");
    // File jobs authenticate with the same explicit credentials as the worker.
    if (input.graph !== undefined) throw refused("credential_config_unsupported");
    const pair = fileProviderPair(input);
    const mappings = parseMappings(input.mappings, pair.source.credentials);
    const rclone = record(input.rclone);
    allowedKeys(rclone, [
      "config",
      "sharepointDestinationCertificate",
      ...credentialBindings.map((binding) => binding.key),
    ]);
    const required = [
      pair.source.credentials.remoteKey.source,
      pair.destination.credentials.remoteKey.destination,
    ];
    const remotes = new Map<string, string>();
    for (const binding of credentialBindings) {
      const value = rclone[binding.key];
      const needed = required.includes(binding.key);
      if (value === undefined) {
        if (needed) throw refused("credential_config_invalid");
        continue;
      }
      if (!needed && !binding.allowUnused) throw refused("credential_config_invalid");
      const name = text(value);
      if (!REMOTE_NAME.test(name)) throw refused("credential_config_invalid");
      remotes.set(binding.key, name);
    }
    const names = [...remotes.values()];
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length)
      throw refused("credential_config_invalid");
    const loaded = await readCredentialFile(fileReference(rclone.config), jobDirectory);
    const sections = (() => {
      try {
        return parseCredentialIni(loaded.bytes);
      } finally {
        loaded.bytes.fill(0);
      }
    })();
    try {
      if (sections.size !== names.length || names.some((name) => !sections.has(name)))
        throw refused("credential_backend_unsupported");
      for (const binding of credentialBindings) {
        const name = remotes.get(binding.key);
        if (!name) continue;
        Object.assign(
          material,
          await binding.load(sections.get(name)!, { input, jobDirectory, readCredentialFile }),
        );
      }
      assertSeparateSharePointApplications(material.graph, material.graphDestination);
      const sharepointCertificateRef =
        rclone.sharepointDestinationCertificate === undefined
          ? undefined
          : fileReference(rclone.sharepointDestinationCertificate);
      if (sharepointCertificateRef && !material.graphDestination)
        throw refused("credential_config_invalid");
      return {
        jobType,
        graph: material.graph,
        ...(material.graphDestination ? { graphDestination: material.graphDestination } : {}),
        ...(sharepointCertificateRef ? { sharepointCertificateRef } : {}),
        ...(remotes.has("sharepointDestinationRemote")
          ? { sharepointDestinationRemote: remotes.get("sharepointDestinationRemote")! }
          : {}),
        google: material.google,
        ...(material.dropbox ? { dropbox: material.dropbox } : {}),
        ...(remotes.has("dropboxRemote") ? { dropboxRemote: remotes.get("dropboxRemote")! } : {}),
        mappings,
        configPath: loaded.path,
        sourceRemote: remotes.get("sourceRemote") ?? null,
        destinationRemote: remotes.get("destinationRemote") ?? null,
      };
    } finally {
      for (const section of sections.values()) section.clear();
      sections.clear();
    }
  } catch (error) {
    material.graph?.secret?.fill(0);
    material.graphDestination?.secret?.fill(0);
    material.dropbox?.refreshToken.fill(0);
    if (error instanceof ProviderFault) throw error;
    throw refused("credential_config_invalid");
  }
}

/** Secrets and caches stay in the closure, never enumerable properties or errors. */
export async function createCredentialSession(input: {
  jobType: JobType;
  config: unknown;
  jobDirectory: string;
  mode?: "archive_verification";
}): Promise<CredentialSession> {
  let state: CredentialState | undefined = await loadCredentials(
    input.jobType,
    input.config,
    input.jobDirectory,
    input.mode,
  );
  let graphCache: Token | undefined;
  let googleCache: Token | undefined;
  let destinationCache: Token | undefined;
  let destinationPending: Promise<string> | undefined;
  let graphPending: Promise<string> | undefined;
  let googlePending: Promise<string> | undefined;
  let dropboxCache: Token | undefined;
  let dropboxPending: Promise<string> | undefined;
  const sharepointCache = new Map<string, Token>();
  const sharepointPending = new Map<string, Promise<string>>();
  let certificatePending: Promise<SharePointCertificate> | undefined;
  const controller = new AbortController();

  function active(): CredentialState {
    if (!state) throw refused("credential_session_disposed");
    return state;
  }

  async function graphToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    active();
    if (graphCache && graphCache.expiresAt > Date.now() + 60_000) return graphCache.value;
    if (graphPending) return graphPending;
    graphCache = undefined;
    graphPending = (async () => {
      const current = active();
      if (!current.graph?.secret) throw refused("credential_graph_unavailable");
      const token = await requestGraphToken(
        current.graph,
        current.jobType,
        false,
        signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      );
      active();
      graphCache = token;
      return token.value;
    })();
    try {
      return await graphPending;
    } finally {
      graphPending = undefined;
    }
  }

  async function graphDestinationToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const credential = active().graphDestination;
    if (!credential?.secret) throw refused("credential_graph_unavailable");
    if (destinationCache && destinationCache.expiresAt > Date.now() + 60_000)
      return destinationCache.value;
    if (destinationPending) return destinationPending;
    destinationPending = (async () => {
      const token = await requestGraphToken(
        credential,
        "file_migration",
        true,
        signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      );
      active();
      destinationCache = token;
      return token.value;
    })();
    try {
      return await destinationPending;
    } finally {
      destinationPending = undefined;
    }
  }

  async function sharepointDestinationToken(
    siteUrl: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const current = active();
    if (!current.graphDestination || !current.sharepointCertificateRef)
      throw new ProviderFault(
        "sharepoint_membership_credentials_required",
        "Named library members require the optional SharePoint certificate setup in CREDENTIALS.md.",
      );
    const origin = sharepointOrigin(siteUrl);
    const cached = sharepointCache.get(origin);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const pending = sharepointPending.get(origin);
    if (pending) return pending;
    const request = (async () => {
      // Graph-only, inherited-access libraries never open or authenticate this key.
      certificatePending ??= (async () => {
        const pem = await readCredentialFile(current.sharepointCertificateRef!, input.jobDirectory);
        try {
          return loadSharePointCertificate(pem.bytes);
        } finally {
          pem.bytes.fill(0);
        }
      })();
      const certificate = await certificatePending;
      const token = await requestSharePointToken(
        current.graphDestination!,
        certificate,
        origin,
        signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      );
      active();
      sharepointCache.set(origin, token);
      return token.value;
    })();
    sharepointPending.set(origin, request);
    try {
      return await request;
    } catch (error) {
      certificatePending = undefined;
      throw error;
    } finally {
      sharepointPending.delete(origin);
    }
  }

  async function googleToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const credential = active().google;
    if (!credential) throw refused("credential_google_unavailable");
    if (googleCache && googleCache.expiresAt > Date.now() + 60_000) return googleCache.value;
    if (googlePending) return googlePending;
    googleCache = undefined;
    googlePending = (async () => {
      const token = await requestGoogleToken(
        credential,
        signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      );
      active();
      googleCache = token;
      return token.value;
    })();
    try {
      return await googlePending;
    } finally {
      googlePending = undefined;
    }
  }

  async function dropboxToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const credential = active().dropbox;
    if (!credential) throw refused("credential_dropbox_unavailable");
    if (dropboxCache && dropboxCache.expiresAt > Date.now() + 60_000) return dropboxCache.value;
    if (dropboxPending) return dropboxPending;
    dropboxCache = undefined;
    dropboxPending = (async () => {
      const token = await requestDropboxToken(
        credential,
        signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      );
      active();
      dropboxCache = token;
      return token.value;
    })();
    try {
      return await dropboxPending;
    } finally {
      dropboxPending = undefined;
    }
  }

  async function authenticate(signal?: AbortSignal): Promise<CredentialState> {
    const current = active();
    await Promise.all([
      ...(current.graph ? [graphToken(signal)] : []),
      ...(current.graphDestination ? [graphDestinationToken(signal)] : []),
      ...(current.google ? [googleToken(signal)] : []),
      ...(current.dropbox ? [dropboxToken(signal)] : []),
    ]);
    return active();
  }

  return {
    graphToken,
    graphDestinationToken,
    sharepointDestinationToken,
    get delegatedSubject() {
      return active().google?.delegatedSubject;
    },
    googleToken,
    dropboxToken,
    get dropboxAdminId() {
      return active().dropbox?.adminId;
    },
    get dropboxRemote() {
      return active().dropboxRemote ?? null;
    },
    async identity(signal) {
      if (input.mode === "archive_verification") await googleToken(signal);
      else await authenticate(signal);
      const current = active();
      // Key/secret rotation changes no identity. SA principal/client drift does.
      const identity = {
        ...(current.dropbox
          ? {
              dropbox: {
                clientId: current.dropbox.clientId,
                teamId: current.dropbox.teamId,
                adminId: current.dropbox.adminId,
              },
            }
          : {}),
        graph: current.graph
          ? { tenantId: current.graph.tenantId, clientId: current.graph.clientId }
          : null,
        ...(current.graphDestination
          ? {
              graphDestination: {
                tenantId: current.graphDestination.tenantId,
                clientId: current.graphDestination.clientId,
              },
            }
          : {}),
        google: current.google
          ? {
              clientId: current.google.clientId,
              subject: current.google.subject,
              ...(current.google.delegatedSubject
                ? { delegatedSubject: current.google.delegatedSubject }
                : {}),
            }
          : null,
      };
      return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
    },
    async evidence(signal) {
      const current = await authenticate(signal);
      return {
        ...(current.dropbox
          ? {
              dropbox: {
                clientId: current.dropbox.clientId,
                teamId: current.dropbox.teamId,
                adminId: current.dropbox.adminId,
                grantedScopes: [...current.dropbox.grantedScopes],
                scopeEvidence: "authorization_code",
                authorizedAt: current.dropbox.authorizedAt,
                authenticatedAt: dropboxCache!.authenticatedAt,
              },
            }
          : {}),
        ...(current.graph
          ? {
              graph: {
                tenantId: current.graph.tenantId,
                clientId: current.graph.clientId,
                grantedPermissions: [...graphCache!.permissions],
                permissionEvidence: "token_roles",
                authenticatedAt: graphCache!.authenticatedAt,
              },
            }
          : {}),
        ...(current.graphDestination
          ? {
              graphDestination: {
                tenantId: current.graphDestination.tenantId,
                clientId: current.graphDestination.clientId,
                grantedPermissions: [...destinationCache!.permissions],
                permissionEvidence: "token_roles",
                authenticatedAt: destinationCache!.authenticatedAt,
              },
            }
          : {}),
        ...(sharepointCache.size > 0
          ? {
              sharepointDestination: {
                tenantId: current.graphDestination!.tenantId,
                clientId: current.graphDestination!.clientId,
                authentication: "certificate",
                resources: [...sharepointCache].map(([origin, token]) => ({
                  origin,
                  grantedPermissions: [...token.permissions],
                  permissionEvidence: "token_roles",
                  authenticatedAt: token.authenticatedAt,
                })),
              },
            }
          : {}),
        ...(current.google
          ? {
              google: {
                clientId: current.google.clientId,
                subject: current.google.subject,
                ...(current.google.delegatedSubject
                  ? { delegatedSubject: current.google.delegatedSubject }
                  : {}),
                grantedScopes: [...googleCache!.permissions],
                scopeEvidence: "oauth_token_exchange",
                authenticatedAt: googleCache!.authenticatedAt,
              },
            }
          : {}),
        mappings: current.mappings.map((mapping) => ({ ...mapping })),
        credentialFiles: {
          resolver: "file",
          ownershipVerified: true,
          permissionsVerified: true,
          outsideJob: true,
        },
      };
    },
    get rcloneConfigPath() {
      return active().configPath;
    },
    get sourceRemote() {
      return active().sourceRemote;
    },
    get destinationRemote() {
      return active().destinationRemote;
    },
    get sharepointDestinationRemote() {
      return active().sharepointDestinationRemote ?? null;
    },
    dispose() {
      controller.abort();
      state?.graph?.secret?.fill(0);
      state?.graphDestination?.secret?.fill(0);
      state?.dropbox?.refreshToken.fill(0);
      dropboxCache = undefined;
      dropboxPending = undefined;
      destinationCache = undefined;
      destinationPending = undefined;
      sharepointCache.clear();
      sharepointPending.clear();
      certificatePending = undefined;
      state = undefined;
      graphCache = undefined;
      googleCache = undefined;
      graphPending = undefined;
      googlePending = undefined;
    },
  };
}
