import { execFile } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { JobType } from "../types.ts";

/** Only static, secret-free messages and explicitly selected evidence belong here. */
export class ProviderFault extends Error {
  readonly code: string;
  readonly evidence: Record<string, unknown>;

  constructor(code: string, message: string, evidence: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProviderFault";
    this.code = code;
    this.evidence = evidence;
  }
}

export interface FileCredentialReference {
  resolver: "file";
  path: string;
  mode?: "0600";
}

export interface CredentialSession {
  graphToken(): Promise<string>;
  googleToken(): Promise<string>;
  identity(): Promise<string>;
  evidence(): Promise<Record<string, unknown>>;
  readonly rcloneConfigPath: string | null;
  readonly sourceRemote: string | null;
  readonly destinationRemote: string | null;
  readonly delegatedSubject?: string | undefined;
  dispose(): void;
}

interface MappingIdentity {
  sourceDriveId: string;
  sourceItemId?: string;
  sourceFolderPath?: string;
  destDriveId?: string;
  destFolderId?: string;
  sourceSiteId?: string;
}

interface GraphCredential {
  tenantId: string;
  clientId: string;
  secret: Buffer | null;
}

interface GoogleCredential {
  clientId: string;
  subject: string;
  keyId: string;
  delegatedSubject?: string;
  privateKey: KeyObject;
}

interface Token {
  value: string;
  expiresAt: number;
  authenticatedAt: string;
  permissions: string[];
}

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 128 * 1024;
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// ADR-0003: the file route is site-scoped. A granted site's drive answers every
// call the route makes, so tenant-wide Files.Read.All is refused, not required.
// https://learn.microsoft.com/en-us/graph/permissions-selected-overview
const FILE_ROLES: Record<string, true> = {
  "Sites.Selected": true,
};
const ARCHIVE_ROLES: Record<string, true> = {
  // Metadata lookup grants; the archive provider enforces scope/option requirements.
  // https://learn.microsoft.com/en-us/graph/api/channel-get?view=graph-rest-1.0
  "Channel.ReadBasic.All": true,
  "ChannelMessage.Read.All": true,
  "Chat.Read.All": true,
  // https://learn.microsoft.com/en-us/graph/api/onlinemeeting-get?view=graph-rest-1.0
  "OnlineMeetings.Read.All": true,
  "OnlineMeetingTranscript.Read.All": true,
  "Files.Read.All": true,
};
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STABLE_ID = /^[A-Za-z0-9_!.,@-]{1,512}$/;

function refused(code: string, evidence: Record<string, unknown> = {}): ProviderFault {
  return new ProviderFault(code, "Credential requirements were not satisfied.", evidence);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw refused("credential_config_invalid");
  }
  return value as Record<string, unknown>;
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw refused("credential_config_unsupported");
  }
}

function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw refused("credential_config_invalid");
  }
  return value;
}

function guid(value: unknown): string {
  const result = text(value);
  if (!GUID.test(result)) throw refused("credential_config_invalid");
  return result.toLowerCase();
}

function stableId(value: unknown): string {
  const result = text(value);
  if (!STABLE_ID.test(result) || result === "." || result === ".." || result === "root") {
    throw refused("credential_config_invalid");
  }
  return result;
}

function fileReference(value: unknown): FileCredentialReference {
  const ref = record(value);
  allowedKeys(ref, ["resolver", "path", "mode"]);
  if (ref.resolver !== "file" || (ref.mode !== undefined && ref.mode !== "0600")) {
    throw refused("credential_reference_unsupported");
  }
  const path = text(ref.path);
  // No shell expansion: rclone must open precisely the file inspected here.
  if (!isAbsolute(path) || /[$%~]/.test(path)) throw refused("credential_reference_invalid");
  return { resolver: "file", path };
}

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

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw refused("credential_file_invalid");
  }
}

/** A deliberately narrow common subset of rclone's INI parser; no interpolation. */
function parseIni(bytes: Buffer): Map<string, Map<string, string>> {
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

function iniKeys(section: Map<string, string>, keys: readonly string[]): void {
  if ([...section.keys()].some((key) => !keys.includes(key)))
    throw refused("credential_backend_unsupported");
}

function setting(
  section: Map<string, string>,
  key: string,
  expected: string,
  required = false,
): void {
  const value = section.get(key);
  if ((required || value !== undefined) && value !== expected)
    throw refused("credential_backend_unsupported");
}

function parseMappings(value: unknown): MappingIdentity[] {
  if (!Array.isArray(value) || value.length === 0) throw refused("credential_mapping_invalid");
  return value.map((item: unknown) => {
    const mapping = record(item);
    const result: MappingIdentity = {
      sourceDriveId: stableId(mapping.sourceDriveId),
      ...(mapping.createDrive === undefined || mapping.destDriveId !== undefined
        ? {
            destDriveId: stableId(mapping.destDriveId),
            destFolderId: stableId(mapping.destFolderId),
          }
        : {}),
    };
    if (mapping.sourceItemId !== undefined) result.sourceItemId = stableId(mapping.sourceItemId);
    else if (typeof mapping.sourceFolderPath === "string")
      result.sourceFolderPath = mapping.sourceFolderPath;
    else throw refused("credential_mapping_invalid");
    if (mapping.sourceSiteId !== undefined) result.sourceSiteId = stableId(mapping.sourceSiteId);
    return result;
  });
}

// rclone's onedrive backend is a plain OAuth client: `client_secret` is not one
// of its password-typed options, so rclone sends the configured bytes verbatim
// and an obscured value authenticates as invalid_client. The engine therefore
// reads exactly what rclone reads — the same string, never a decoded one.
// https://rclone.org/onedrive/#standard-options
function clientSecret(value: unknown): Buffer {
  const secret = text(value);
  if (secret.length > 4096 || /[\x00-\x20\x7f]/.test(secret))
    throw refused("credential_secret_invalid");
  return Buffer.from(secret, "utf8");
}

function googleCredential(bytes: Buffer): GoogleCredential {
  try {
    const value = record(JSON.parse(decodeUtf8(bytes)));
    allowedKeys(value, [
      "type",
      "project_id",
      "private_key_id",
      "private_key",
      "client_email",
      "client_id",
      "auth_uri",
      "token_uri",
      "auth_provider_x509_cert_url",
      "client_x509_cert_url",
      "universe_domain",
    ]);
    if (
      value.type !== "service_account" ||
      value.token_uri !== GOOGLE_TOKEN_ENDPOINT ||
      (value.universe_domain !== undefined && value.universe_domain !== "googleapis.com")
    ) {
      throw refused("credential_backend_unsupported");
    }
    const subject = text(value.client_email);
    const clientId = text(value.client_id);
    const keyId = text(value.private_key_id);
    if (
      !/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9.-]*\.gserviceaccount\.com$/.test(subject) ||
      !/^[0-9]{1,32}$/.test(clientId) ||
      !/^[a-f0-9]{40}$/.test(keyId) ||
      typeof value.private_key !== "string"
    )
      throw refused("credential_secret_invalid");
    const privateKey = createPrivateKey(value.private_key);
    if (
      privateKey.asymmetricKeyType !== "rsa" ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw refused("credential_secret_invalid");
    }
    return { subject, clientId, keyId, privateKey };
  } catch (error) {
    if (error instanceof ProviderFault) throw error;
    throw refused("credential_secret_invalid");
  }
}

interface CredentialState {
  jobType: JobType;
  graph: GraphCredential;
  google: GoogleCredential | undefined;
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
  let graph: GraphCredential | undefined;
  try {
    if (jobType === "teams_archive") {
      const fields = record(input.graph);
      allowedKeys(fields, ["tenantId", "clientId"]);
      const secrets = record(input.secrets);
      allowedKeys(
        secrets,
        input.destination === undefined
          ? ["teams_graph_client_secret"]
          : ["teams_graph_client_secret", "google_service_account"],
      );
      if (input.destination !== undefined) {
        const destination = record(input.destination);
        allowedKeys(destination, ["destDriveId", "destFolderId"]);
        stableId(destination.destDriveId);
        stableId(destination.destFolderId);
      }
      const tenantId = guid(fields.tenantId);
      const clientId = guid(fields.clientId);
      if (mode === "archive_verification") {
        // Retention outlives the source tenant. Bind its configured identity,
        // but neither open its secret nor authenticate it to read Drive copies.
        graph = { tenantId, clientId, secret: null };
      } else {
        const loaded = await readCredentialFile(
          fileReference(secrets.teams_graph_client_secret),
          jobDirectory,
        );
        try {
          // A single conventional trailing newline is not part of an Entra secret.
          const secret = decodeUtf8(loaded.bytes).replace(/\r?\n$/, "");
          if (!secret || secret.length > 4096 || /[\x00-\x20\x7f]/.test(secret))
            throw refused("credential_secret_invalid");
          graph = { tenantId, clientId, secret: Buffer.from(secret, "utf8") };
        } finally {
          loaded.bytes.fill(0);
        }
      }
      let google: GoogleCredential | undefined;
      if (input.destination !== undefined) {
        const serviceAccount = await readCredentialFile(
          fileReference(secrets.google_service_account),
          jobDirectory,
        );
        try {
          google = googleCredential(serviceAccount.bytes);
        } finally {
          serviceAccount.bytes.fill(0);
        }
      }
      return {
        jobType,
        graph,
        google,
        mappings: [],
        configPath: null,
        sourceRemote: null,
        destinationRemote: null,
      };
    }
    if (jobType !== "file_migration") throw refused("credential_config_unsupported");
    // File jobs must authenticate Graph with the same source app as the worker.
    if (input.graph !== undefined) throw refused("credential_config_unsupported");
    const mappings = parseMappings(input.mappings);
    const rclone = record(input.rclone);
    allowedKeys(rclone, ["config", "sourceRemote", "destinationRemote"]);
    const sourceRemote = text(rclone.sourceRemote);
    const destinationRemote = text(rclone.destinationRemote);
    if (
      !REMOTE_NAME.test(sourceRemote) ||
      !REMOTE_NAME.test(destinationRemote) ||
      sourceRemote.toLowerCase() === destinationRemote.toLowerCase()
    ) {
      throw refused("credential_config_invalid");
    }
    const loaded = await readCredentialFile(fileReference(rclone.config), jobDirectory);
    const sections = (() => {
      try {
        return parseIni(loaded.bytes);
      } finally {
        loaded.bytes.fill(0);
      }
    })();
    try {
      const source = sections.get(sourceRemote);
      const destination = sections.get(destinationRemote);
      // A dedicated operator config avoids global sections and uninspected remotes.
      if (!source || !destination || sections.size !== 2)
        throw refused("credential_backend_unsupported");
      iniKeys(source, [
        "type",
        "client_id",
        "client_secret",
        "tenant",
        "client_credentials",
        "drive_id",
        "drive_type",
        "root_folder_id",
        "access_scopes",
        "region",
        "disable_site_permission",
        "expose_onenote_files",
        // rclone writes its own client-credentials token cache back into the
        // operator config the managed worker runs with, so a config that has
        // ever executed a transfer contains this key. The engine never reads
        // it: onboarding derives every credential from the explicit settings.
        "token",
      ]);
      setting(source, "type", "onedrive", true);
      setting(source, "client_credentials", "true", true);
      setting(source, "drive_type", "documentLibrary", true);
      setting(source, "region", "global");
      setting(source, "disable_site_permission", "true");
      setting(source, "expose_onenote_files", "true");
      if (source.has("access_scopes")) {
        const scopes = text(source.get("access_scopes")).split(/ +/).sort();
        if (scopes.join(" ") !== Object.keys(FILE_ROLES).sort().join(" "))
          throw refused("credential_permissions_invalid");
      }
      // Remote roots are seed settings. Every pass overrides them with approved mapping roots.
      stableId(source.get("drive_id"));
      if (source.has("root_folder_id")) stableId(source.get("root_folder_id"));
      iniKeys(destination, [
        "type",
        "service_account_file",
        "team_drive",
        "root_folder_id",
        "scope",
        "skip_gdocs",
        "skip_shortcuts",
        "import_formats",
        "metadata_owner",
        "metadata_permissions",
        "metadata_labels",
      ]);
      setting(destination, "type", "drive", true);
      setting(destination, "scope", "drive");
      setting(destination, "skip_gdocs", "true");
      setting(destination, "skip_shortcuts", "true");
      setting(destination, "import_formats", "");
      setting(destination, "metadata_owner", "off");
      setting(destination, "metadata_permissions", "off");
      setting(destination, "metadata_labels", "off");
      stableId(destination.get("team_drive"));
      stableId(destination.get("root_folder_id"));
      const tenantId = guid(source.get("tenant"));
      const clientId = guid(source.get("client_id"));
      graph = { tenantId, clientId, secret: clientSecret(source.get("client_secret")) };
      const serviceAccount = await readCredentialFile(
        fileReference({ resolver: "file", path: destination.get("service_account_file") }),
        jobDirectory,
      );
      let google: GoogleCredential;
      try {
        google = googleCredential(serviceAccount.bytes);
        if (input.impersonate === true) {
          if (typeof input.subject !== "string" || !/^[^\s@]+@[^\s@]+$/u.test(input.subject))
            throw refused("credential_config_invalid");
          google.delegatedSubject = input.subject;
        }
      } finally {
        serviceAccount.bytes.fill(0);
      }
      return {
        jobType,
        graph,
        google,
        mappings,
        configPath: loaded.path,
        sourceRemote,
        destinationRemote,
      };
    } finally {
      for (const section of sections.values()) section.clear();
      sections.clear();
    }
  } catch (error) {
    graph?.secret?.fill(0);
    if (error instanceof ProviderFault) throw error;
    throw refused("credential_config_invalid");
  }
}

async function tokenResponse(
  url: string,
  body: URLSearchParams,
  signal: AbortSignal,
  provider: "microsoft" | "google",
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw refused("credential_authentication_failed", { provider, status: response.status });
    }
    const reader = response.body?.getReader();
    if (!reader) throw refused("credential_token_invalid", { provider });
    const bytes = Buffer.alloc(MAX_TOKEN_BYTES);
    let offset = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.length > bytes.length - offset) {
          chunk.value.fill(0);
          throw refused("credential_token_invalid", { provider });
        }
        bytes.set(chunk.value, offset);
        offset += chunk.value.length;
        chunk.value.fill(0);
      }
      return record(JSON.parse(decodeUtf8(bytes.subarray(0, offset))));
    } finally {
      bytes.fill(0);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof ProviderFault) throw error;
    throw refused("credential_authentication_failed", { provider });
  } finally {
    body.delete("client_secret");
    body.delete("assertion");
  }
}

function parseToken(value: Record<string, unknown>, requestedAt: number): Token {
  const token = value.access_token;
  const expiresIn = value.expires_in;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_BYTES ||
    /\s|[\x00-\x1f\x7f]/.test(token) ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 60 ||
    expiresIn > 86400 ||
    requestedAt + expiresIn * 1000 <= Date.now() + 60_000 ||
    value.refresh_token !== undefined
  )
    throw refused("credential_token_invalid");
  return {
    value: token,
    expiresAt: requestedAt + expiresIn * 1000,
    authenticatedAt: new Date().toISOString(),
    permissions: [],
  };
}

function graphPermissions(token: Token, credential: GraphCredential, jobType: JobType): void {
  // These are evidence from a fresh HTTPS token response, NOT local authorization.
  // Microsoft Graph itself validates the token during the parent's real probes.
  // An opaque token cannot provide the required granted-role evidence: fail closed.
  const pieces = token.value.split(".");
  if (pieces.length !== 3 || !pieces.every((piece) => /^[A-Za-z0-9_-]+$/.test(piece))) {
    throw refused("credential_permission_evidence_unavailable");
  }
  let claims: Record<string, unknown>;
  const bytes = Buffer.from(pieces[1]!, "base64url");
  try {
    claims = record(JSON.parse(decodeUtf8(bytes)));
  } catch {
    throw refused("credential_token_invalid");
  } finally {
    bytes.fill(0);
  }
  if (
    claims.scp !== undefined ||
    (claims.idtyp !== undefined && claims.idtyp !== "app") ||
    typeof claims.tid !== "string" ||
    claims.tid.toLowerCase() !== credential.tenantId ||
    typeof (claims.appid ?? claims.azp) !== "string" ||
    String(claims.appid ?? claims.azp).toLowerCase() !== credential.clientId ||
    (claims.aud !== "https://graph.microsoft.com" &&
      claims.aud !== "https://graph.microsoft.com/" &&
      claims.aud !== "00000003-0000-0000-c000-000000000000") ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= Date.now() + 60_000 ||
    (claims.nbf !== undefined &&
      (typeof claims.nbf !== "number" || claims.nbf * 1000 > Date.now() + 60_000))
  ) {
    throw refused("credential_application_identity_invalid");
  }
  if (
    !Array.isArray(claims.roles) ||
    claims.roles.length === 0 ||
    !claims.roles.every((role: unknown) => typeof role === "string")
  ) {
    throw refused("credential_permission_evidence_unavailable");
  }
  const roles = [...new Set<string>(claims.roles)].sort();
  const permitted = jobType === "file_migration" ? FILE_ROLES : ARCHIVE_ROLES;
  if (
    roles.some((role) => !Object.hasOwn(permitted, role)) ||
    (jobType === "file_migration" &&
      Object.keys(FILE_ROLES).some((role) => !roles.includes(role))) ||
    (jobType === "teams_archive" &&
      !roles.includes("ChannelMessage.Read.All") &&
      !roles.includes("Chat.Read.All"))
  ) {
    throw refused("credential_permissions_invalid");
  }
  token.permissions = roles;
  token.expiresAt = Math.min(token.expiresAt, claims.exp * 1000);
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
  let graphPending: Promise<string> | undefined;
  let googlePending: Promise<string> | undefined;
  const controller = new AbortController();

  function active(): CredentialState {
    if (!state) throw refused("credential_session_disposed");
    return state;
  }

  async function graphToken(): Promise<string> {
    active();
    if (graphCache && graphCache.expiresAt > Date.now() + 60_000) return graphCache.value;
    if (graphPending) return graphPending;
    graphCache = undefined;
    graphPending = (async () => {
      const current = active();
      if (!current.graph.secret) throw refused("credential_graph_unavailable");
      const requestedAt = Date.now();
      const response = await tokenResponse(
        `https://login.microsoftonline.com/${current.graph.tenantId}/oauth2/v2.0/token`,
        new URLSearchParams({
          grant_type: "client_credentials",
          client_id: current.graph.clientId,
          client_secret: current.graph.secret.toString("utf8"),
          scope: GRAPH_SCOPE,
        }),
        controller.signal,
        "microsoft",
      );
      active();
      const token = parseToken(response, requestedAt);
      graphPermissions(token, current.graph, current.jobType);
      graphCache = token;
      return token.value;
    })();
    try {
      return await graphPending;
    } finally {
      graphPending = undefined;
    }
  }

  async function googleToken(): Promise<string> {
    const credential = active().google;
    if (!credential) throw refused("credential_google_unavailable");
    if (googleCache && googleCache.expiresAt > Date.now() + 60_000) return googleCache.value;
    if (googlePending) return googlePending;
    googleCache = undefined;
    googlePending = (async () => {
      try {
        const requestedAt = Date.now();
        const issuedAt = Math.floor(requestedAt / 1000);
        const header = Buffer.from(
          JSON.stringify({ alg: "RS256", typ: "JWT", kid: credential.keyId }),
        ).toString("base64url");
        const claims = Buffer.from(
          JSON.stringify({
            iss: credential.subject,
            ...(credential.delegatedSubject ? { sub: credential.delegatedSubject } : {}),
            scope: GOOGLE_SCOPE,
            aud: GOOGLE_TOKEN_ENDPOINT,
            iat: issuedAt,
            exp: issuedAt + 3600,
          }),
        ).toString("base64url");
        const signingInput = `${header}.${claims}`;
        const signature = sign(
          "RSA-SHA256",
          Buffer.from(signingInput),
          credential.privateKey,
        ).toString("base64url");
        const response = await tokenResponse(
          GOOGLE_TOKEN_ENDPOINT,
          new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: `${signingInput}.${signature}`,
          }),
          controller.signal,
          "google",
        );
        active();
        const token = parseToken(response, requestedAt);
        // RFC 6749 §5.1: absent scope means the granted scope equals the request.
        if (response.scope !== undefined && response.scope !== GOOGLE_SCOPE)
          throw refused("credential_permissions_invalid");
        token.permissions = [GOOGLE_SCOPE];
        googleCache = token;
        return token.value;
      } catch (error) {
        if (error instanceof ProviderFault) throw error;
        throw refused("credential_authentication_failed", { provider: "google" });
      }
    })();
    try {
      return await googlePending;
    } finally {
      googlePending = undefined;
    }
  }

  async function authenticate(): Promise<CredentialState> {
    const current = active();
    await Promise.all([graphToken(), ...(current.google ? [googleToken()] : [])]);
    return active();
  }

  return {
    graphToken,
    get delegatedSubject() {
      return active().google?.delegatedSubject;
    },
    googleToken,
    async identity() {
      if (input.mode === "archive_verification") await googleToken();
      else await authenticate();
      const current = active();
      // Key/secret rotation changes no identity. SA principal/client drift does.
      const identity = {
        graph: { tenantId: current.graph.tenantId, clientId: current.graph.clientId },
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
    async evidence() {
      const current = await authenticate();
      return {
        graph: {
          tenantId: current.graph.tenantId,
          clientId: current.graph.clientId,
          grantedPermissions: [...graphCache!.permissions],
          permissionEvidence: "token_roles",
          authenticatedAt: graphCache!.authenticatedAt,
        },
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
    dispose() {
      controller.abort();
      state?.graph.secret?.fill(0);
      state = undefined;
      graphCache = undefined;
      googleCache = undefined;
      graphPending = undefined;
      googlePending = undefined;
    },
  };
}
