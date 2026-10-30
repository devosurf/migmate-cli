import { createHash, randomBytes } from "node:crypto";
import {
  allowedKeys,
  iniKeys,
  parseToken,
  record,
  refused,
  setting,
  text,
  tokenResponse,
} from "./shared.ts";
import type { FileCredentialAdapter, Token } from "./shared.ts";

export interface DropboxCredential {
  clientId: string;
  teamId: string;
  adminId: string;
  refreshToken: Buffer;
  grantedScopes: string[];
  authorizedAt: string;
}

export const DROPBOX_READ_SCOPES = [
  "account_info.read",
  "files.metadata.read",
  "files.content.read",
  "team_data.member",
] as const;
const ALLOWED_READ_SCOPES: Record<string, true> = {
  "account_info.read": true,
  "files.metadata.read": true,
  "files.content.read": true,
  "team_data.member": true,
  "sharing.read": true,
  "team_info.read": true,
  "team_data.content.read": true,
  "members.read": true,
};
const TOKEN_ENDPOINT = "https://api.dropboxapi.com/oauth2/token";
const PROOF_KEY = "migmate_scope_proof";

function scopes(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim())
    throw refused("credential_permissions_invalid", { provider: "dropbox" });
  const granted = [...new Set(value.trim().split(/\s+/u))].sort();
  // Unknown permissions fail closed, including administrative scopes without a .write suffix.
  if (
    granted.some((scope) => !Object.hasOwn(ALLOWED_READ_SCOPES, scope)) ||
    DROPBOX_READ_SCOPES.some((required) => !granted.includes(required))
  )
    throw refused("credential_permissions_invalid", { provider: "dropbox" });
  return granted;
}

function clientId(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(result)) throw refused("credential_config_invalid");
  return result;
}

function refreshToken(value: unknown): string {
  const result = text(value);
  if (/\s/u.test(result)) throw refused("credential_token_invalid");
  return result;
}

/** Valid even before authorization; no source-mutating backend options are accepted. */
export function dropboxRemoteSettings(section: Map<string, string>): {
  clientId: string;
  adminId: string;
} {
  iniKeys(section, [
    "type",
    "client_id",
    "impersonate_admin",
    "root_namespace",
    "token",
    "export_formats",
    "skip_exports",
    "show_all_exports",
    PROOF_KEY,
  ]);
  setting(section, "type", "dropbox", true);
  setting(section, "export_formats", "html");
  setting(section, "skip_exports", "false");
  setting(section, "show_all_exports", "false");
  if (section.has("root_namespace") && !/^\d+$/u.test(section.get("root_namespace")!))
    throw refused("credential_config_invalid");
  const adminId = text(section.get("impersonate_admin"));
  if (!/^dbmid:[A-Za-z0-9_-]+$/u.test(adminId)) throw refused("credential_config_invalid");
  return { clientId: clientId(section.get("client_id")), adminId };
}

export function loadDropboxCredential(section: Map<string, string>): DropboxCredential {
  const settings = dropboxRemoteSettings(section);
  // rclone-created tokens have no observable initial grant and cannot be imported.
  if (!section.has(PROOF_KEY))
    throw refused("credential_permissions_invalid", { provider: "dropbox" });
  let proof: Record<string, unknown>;
  let token: Record<string, unknown>;
  try {
    proof = record(JSON.parse(section.get(PROOF_KEY)!));
    token = record(JSON.parse(section.get("token") ?? "null"));
  } catch {
    throw refused("credential_permissions_invalid", { provider: "dropbox" });
  }
  allowedKeys(proof, [
    "source",
    "clientId",
    "teamId",
    "grantedScopes",
    "authorizedAt",
    "refreshTokenSha256",
  ]);
  const refresh = refreshToken(token.refresh_token);
  if (
    proof.source !== "authorization_code" ||
    proof.clientId !== settings.clientId ||
    proof.refreshTokenSha256 !== createHash("sha256").update(refresh).digest("hex") ||
    !Array.isArray(proof.grantedScopes) ||
    proof.grantedScopes.some((scope: unknown) => typeof scope !== "string" || /\s/u.test(scope)) ||
    typeof proof.authorizedAt !== "string" ||
    !Number.isFinite(Date.parse(proof.authorizedAt)) ||
    typeof proof.teamId !== "string" ||
    !/^dbtid:[A-Za-z0-9_-]+$/u.test(proof.teamId)
  )
    throw refused("credential_permissions_invalid", { provider: "dropbox" });
  const grantedScopes = scopes(proof.grantedScopes.join(" "));
  return {
    ...settings,
    teamId: proof.teamId,
    refreshToken: Buffer.from(refresh),
    grantedScopes,
    authorizedAt: proof.authorizedAt,
  };
}

/** The verifier stays in the closure and is consumed once; the code never enters job config. */
export function beginDropboxAuthorization(appKey: string): {
  url: string;
  exchange(code: string, signal: AbortSignal): Promise<Map<string, string>>;
} {
  const app = clientId(appKey);
  let verifier: string | undefined = randomBytes(32).toString("base64url");
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: app,
    response_type: "code",
    token_access_type: "offline",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    scope: DROPBOX_READ_SCOPES.join(" "),
  }).toString();
  return {
    url: url.href,
    async exchange(code, signal) {
      if (!verifier) throw refused("credential_authentication_failed", { provider: "dropbox" });
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: app,
        code: text(code),
        code_verifier: verifier,
      });
      verifier = undefined;
      const requestedAt = Date.now();
      const response = await tokenResponse(TOKEN_ENDPOINT, body, signal, "dropbox");
      const grantedScopes = scopes(response.scope);
      const refresh = refreshToken(response.refresh_token);
      const teamId = text(response.team_id);
      if (!/^dbtid:[A-Za-z0-9_-]+$/u.test(teamId))
        throw refused("credential_permissions_invalid", { provider: "dropbox" });
      delete response.refresh_token;
      const token = parseToken(response, requestedAt);
      return new Map([
        [
          "token",
          JSON.stringify({
            access_token: token.value,
            token_type: "Bearer",
            refresh_token: refresh,
            expiry: new Date(token.expiresAt).toISOString(),
          }),
        ],
        [
          PROOF_KEY,
          JSON.stringify({
            source: "authorization_code",
            clientId: app,
            teamId,
            grantedScopes,
            authorizedAt: token.authenticatedAt,
            refreshTokenSha256: createHash("sha256").update(refresh).digest("hex"),
          }),
        ],
      ]);
    },
  };
}

export async function requestDropboxToken(
  credential: DropboxCredential,
  signal: AbortSignal,
): Promise<Token> {
  const permissions = scopes(credential.grantedScopes.join(" "));
  const requestedAt = Date.now();
  const response = await tokenResponse(
    TOKEN_ENDPOINT,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refreshToken.toString("utf8"),
    }),
    signal,
    "dropbox",
  );
  // A refresh need not repeat scopes. It never establishes or replaces initial grant proof.
  if (response.scope !== undefined) scopes(response.scope);
  const token = parseToken(response, requestedAt);
  token.permissions = permissions;
  return token;
}

export const dropboxCredentialAdapter: FileCredentialAdapter = {
  mappingSourceType: "dropbox",
  remoteKey: { source: "dropboxRemote", destination: "dropboxRemote" },
  bindings: [
    {
      key: "dropboxRemote",
      allowUnused: false,
      async load(section) {
        return { dropbox: loadDropboxCredential(section) };
      },
    },
  ],
};
