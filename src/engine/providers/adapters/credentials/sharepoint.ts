import type { JobType } from "../../../types.ts";
import {
  allowedKeys,
  decodeUtf8,
  fileReference,
  guid,
  iniKeys,
  parseToken,
  record,
  refused,
  seedRoots,
  setting,
  stableId,
  text,
  tokenResponse,
} from "./shared.ts";
import type { CredentialFileReader, FileCredentialAdapter, Token } from "./shared.ts";

export interface GraphCredential {
  tenantId: string;
  clientId: string;
  secret: Buffer | null;
}

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
// ADR-0003 amendment: source apps choose one read grant, never both or a write role.
const FILE_ROLES: Record<string, true> = {
  "Sites.Selected": true,
  "Sites.Read.All": true,
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
// ADR-0003 amendment: SharePoint destinations are written by a separate app with its
// own exclusive allowlist, so the read-only source app never gains a write role.
const SHAREPOINT_DESTINATION_ROLES: Record<string, true> = {
  "Sites.ReadWrite.All": true,
};

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

function loadSharePointRemote(
  section: Map<string, string>,
  role: "source" | "destination",
): GraphCredential {
  const destination = role === "destination";
  iniKeys(section, [
    "type",
    "client_id",
    "client_secret",
    "tenant",
    "client_credentials",
    "drive_id",
    "drive_type",
    "access_scopes",
    "region",
    "disable_site_permission",
    "expose_onenote_files",
    // rclone persists its own token cache; credentials always come from explicit settings.
    "token",
    ...(destination ? [] : ["root_folder_id"]),
  ]);
  setting(section, "type", "onedrive", true);
  setting(section, "client_credentials", "true", true);
  setting(section, "drive_type", "documentLibrary", true);
  setting(section, "region", "global");
  setting(section, "disable_site_permission", "true");
  setting(section, "expose_onenote_files", "true");
  if (section.has("access_scopes")) {
    const scopes = text(section.get("access_scopes")).split(/ +/).sort();
    const permitted = destination ? SHAREPOINT_DESTINATION_ROLES : FILE_ROLES;
    if (scopes.length !== 1 || !Object.hasOwn(permitted, scopes[0]!))
      throw refused("credential_permissions_invalid");
  }
  // Remote roots are optional seeds; each pass uses the approved mapping roots.
  seedRoots(section, destination ? ["drive_id"] : ["drive_id", "root_folder_id"]);
  return {
    tenantId: guid(section.get("tenant")),
    clientId: guid(section.get("client_id")),
    secret: clientSecret(section.get("client_secret")),
  };
}

export function assertSeparateSharePointApplications(
  source: GraphCredential | undefined,
  destination: GraphCredential | undefined,
): void {
  if (
    source &&
    destination &&
    source.clientId === destination.clientId &&
    source.tenantId === destination.tenantId
  )
    throw refused("credential_permissions_invalid");
}

export async function loadArchiveGraph(
  input: Record<string, unknown>,
  jobDirectory: string,
  readCredentialFile: CredentialFileReader,
  mode?: "archive_verification",
): Promise<GraphCredential> {
  let graph: GraphCredential;
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
  return graph;
}

function graphPermissions(
  token: Token,
  credential: GraphCredential,
  jobType: JobType,
  destination = false,
): void {
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
  const permitted = destination
    ? SHAREPOINT_DESTINATION_ROLES
    : jobType === "file_migration"
      ? FILE_ROLES
      : ARCHIVE_ROLES;
  if (
    roles.some((role) => !Object.hasOwn(permitted, role)) ||
    (jobType === "file_migration" && !destination && roles.length !== 1) ||
    (jobType === "teams_archive" &&
      !roles.includes("ChannelMessage.Read.All") &&
      !roles.includes("Chat.Read.All"))
  ) {
    throw refused("credential_permissions_invalid");
  }
  token.permissions = roles;
  token.expiresAt = Math.min(token.expiresAt, claims.exp * 1000);
}

export async function requestGraphToken(
  credential: GraphCredential,
  jobType: JobType,
  destination: boolean,
  signal: AbortSignal,
): Promise<Token> {
  if (!credential.secret) throw refused("credential_graph_unavailable");
  const requestedAt = Date.now();
  const response = await tokenResponse(
    `https://login.microsoftonline.com/${credential.tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credential.clientId,
      client_secret: credential.secret.toString("utf8"),
      scope: GRAPH_SCOPE,
    }),
    signal,
    "microsoft",
  );
  const token = parseToken(response, requestedAt);
  graphPermissions(token, credential, jobType, destination);
  return token;
}

export const sharepointCredentialAdapter: FileCredentialAdapter = {
  sourceItemId: stableId,
  remoteKey: { source: "sourceRemote", destination: "sharepointDestinationRemote" },
  bindings: [
    {
      key: "sourceRemote",
      allowUnused: true,
      async load(section) {
        return { graph: loadSharePointRemote(section, "source") };
      },
    },
    {
      key: "sharepointDestinationRemote",
      allowUnused: false,
      async load(section) {
        return { graphDestination: loadSharePointRemote(section, "destination") };
      },
    },
  ],
};
