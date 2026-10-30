import { isAbsolute } from "node:path";
import { ProviderFault } from "../../fault.ts";
import type { FileProviderId } from "../capabilities.ts";
import type { GoogleCredential } from "./google.ts";
import type { GraphCredential } from "./sharepoint.ts";
import type { DropboxCredential } from "./dropbox.ts";

export interface CredentialMaterial {
  graph?: GraphCredential;
  graphDestination?: GraphCredential;
  google?: GoogleCredential;
  dropbox?: DropboxCredential;
}

export interface CredentialLoadContext {
  input: Record<string, unknown>;
  jobDirectory: string;
  readCredentialFile: CredentialFileReader;
}

export interface FileCredentialAdapter {
  /** Preserve the provider marker in credential mapping evidence when needed. */
  mappingSourceType?: FileProviderId;
  remoteKey: { source: string; destination: string };
  bindings: readonly {
    key: string;
    allowUnused: boolean;
    load(section: Map<string, string>, context: CredentialLoadContext): Promise<CredentialMaterial>;
  }[];
}

export interface FileCredentialReference {
  resolver: "file";
  path: string;
  mode?: "0600";
}

export interface CredentialFileReader {
  (ref: FileCredentialReference, jobDirectory: string): Promise<{ path: string; bytes: Buffer }>;
}

export interface Token {
  value: string;
  expiresAt: number;
  authenticatedAt: string;
  permissions: string[];
}

const MAX_TOKEN_BYTES = 128 * 1024;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STABLE_ID = /^[A-Za-z0-9_!.,@-]{1,512}$/;

export function refused(code: string, evidence: Record<string, unknown> = {}): ProviderFault {
  return new ProviderFault(code, "Credential requirements were not satisfied.", evidence);
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw refused("credential_config_invalid");
  }
  return value as Record<string, unknown>;
}

export function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw refused("credential_config_unsupported");
  }
}

export function text(value: unknown): string {
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

export function guid(value: unknown): string {
  const result = text(value);
  if (!GUID.test(result)) throw refused("credential_config_invalid");
  return result.toLowerCase();
}

export function stableId(value: unknown): string {
  const result = text(value);
  if (!STABLE_ID.test(result) || result === "." || result === ".." || result === "root") {
    throw refused("credential_config_invalid");
  }
  return result;
}

export function fileReference(value: unknown): FileCredentialReference {
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

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw refused("credential_file_invalid");
  }
}

export function iniKeys(section: Map<string, string>, keys: readonly string[]): void {
  if ([...section.keys()].some((key) => !keys.includes(key)))
    throw refused("credential_backend_unsupported");
}

export function seedRoots(section: Map<string, string>, keys: readonly string[]): void {
  for (const key of keys) if (section.has(key)) stableId(section.get(key));
}

export function setting(
  section: Map<string, string>,
  key: string,
  expected: string,
  required = false,
): void {
  const value = section.get(key);
  if ((required || value !== undefined) && value !== expected)
    throw refused("credential_backend_unsupported");
}

export async function tokenResponse(
  url: string,
  body: URLSearchParams,
  signal: AbortSignal,
  provider: string,
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
    body.delete("code");
    body.delete("code_verifier");
    body.delete("refresh_token");
  }
}

export function parseToken(value: Record<string, unknown>, requestedAt: number): Token {
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
