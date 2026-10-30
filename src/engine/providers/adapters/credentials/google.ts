import { createPrivateKey, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { ProviderFault } from "../../fault.ts";
import {
  allowedKeys,
  decodeUtf8,
  fileReference,
  iniKeys,
  parseToken,
  record,
  refused,
  seedRoots,
  setting,
  text,
  tokenResponse,
} from "./shared.ts";
import type { CredentialFileReader, FileCredentialAdapter, Token } from "./shared.ts";

export interface GoogleCredential {
  clientId: string;
  subject: string;
  keyId: string;
  delegatedSubject?: string;
  privateKey: KeyObject;
}

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

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

async function loadGoogleRemote(
  destination: Map<string, string>,
  input: Record<string, unknown>,
  jobDirectory: string,
  readCredentialFile: CredentialFileReader,
): Promise<GoogleCredential> {
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
  seedRoots(destination, ["team_drive", "root_folder_id"]);
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
  return google;
}

export async function loadArchiveGoogle(
  input: Record<string, unknown>,
  jobDirectory: string,
  readCredentialFile: CredentialFileReader,
): Promise<GoogleCredential | undefined> {
  if (input.destination === undefined) return;
  const secrets = record(input.secrets);
  const serviceAccount = await readCredentialFile(
    fileReference(secrets.google_service_account),
    jobDirectory,
  );
  try {
    return googleCredential(serviceAccount.bytes);
  } finally {
    serviceAccount.bytes.fill(0);
  }
}

export async function requestGoogleToken(
  credential: GoogleCredential,
  signal: AbortSignal,
): Promise<Token> {
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
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), credential.privateKey).toString(
      "base64url",
    );
    const response = await tokenResponse(
      GOOGLE_TOKEN_ENDPOINT,
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${signingInput}.${signature}`,
      }),
      signal,
      "google",
    );
    const token = parseToken(response, requestedAt);
    // RFC 6749 §5.1: absent scope means the granted scope equals the request.
    if (response.scope !== undefined && response.scope !== GOOGLE_SCOPE)
      throw refused("credential_permissions_invalid");
    token.permissions = [GOOGLE_SCOPE];
    return token;
  } catch (error) {
    if (error instanceof ProviderFault) throw error;
    throw refused("credential_authentication_failed", { provider: "google" });
  }
}

export const googleCredentialAdapter: FileCredentialAdapter = {
  mappingSourceType: "google_shared_drive",
  // This existing credential key names the Google remote in either direction.
  remoteKey: { source: "destinationRemote", destination: "destinationRemote" },
  bindings: [
    {
      key: "destinationRemote",
      allowUnused: false,
      async load(section, context) {
        return {
          google: await loadGoogleRemote(
            section,
            context.input,
            context.jobDirectory,
            context.readCredentialFile,
          ),
        };
      },
    },
  ],
};
