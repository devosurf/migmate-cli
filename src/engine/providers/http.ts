import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { ReadableStreamReadResult } from "node:stream/web";
import { ProviderFault, type CredentialSession } from "./credentials.ts";

/** Provider responses never become diagnostic text: URLs and bodies may contain credentials. */
export class HttpProviderFault extends ProviderFault {
  readonly status: number;
  readonly transient: boolean;
  readonly retryAfterMs?: number;
  constructor(status: number, retryAfter: string | null = null, providerCode?: string) {
    super(
      status === 412 ? "prior_copy_drift" : "provider_request_failed",
      "The provider request did not succeed.",
      {
        status,
        ...(providerCode ? { providerCode } : {}),
      },
    );
    this.status = status;
    this.transient = status === 0 || status === 408 || status === 429 || status >= 500;
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(delay) && delay >= 0) this.retryAfterMs = delay;
    }
  }
}

export interface GraphTransport {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  stream(path: string): AsyncIterable<Uint8Array>;
  evidence(): Promise<Record<string, unknown>>;
}

const SAFE_CODES: Record<string, true> = {
  accessDenied: true,
  AccessDenied: true,
  Authorization_RequestDenied: true,
  Forbidden: true,
  ErrorAccessDenied: true,
  itemNotFound: true,
  ItemNotFound: true,
  NotFound: true,
  Request_ResourceNotFound: true,
  ResourceNotFound: true,
  TooManyRequests: true,
  activityLimitReached: true,
  throttledRequest: true,
  serviceNotAvailable: true,
  quotaLimitReached: true,
  notSupported: true,
  NotSupported: true,
  InvalidRequest: true,
  badRequest: true,
  rateLimitExceeded: true,
  userRateLimitExceeded: true,
  storageQuotaExceeded: true,
  downloadQuotaExceeded: true,
  insufficientFilePermissions: true,
  fileNotDownloadable: true,
  notFound: true,
  cannotDownloadAbusiveFile: true,
};

export function graphUrl(path: string): URL {
  let url: URL;
  try {
    url = new URL(path, "https://graph.microsoft.com");
  } catch {
    throw new ProviderFault("preflight_failed", "The Graph route is invalid.");
  }
  if (
    url.origin !== "https://graph.microsoft.com" ||
    !url.pathname.startsWith("/v1.0/") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new ProviderFault(
      "preflight_failed",
      "Only Microsoft Graph Global v1.0 routes are permitted.",
    );
  }
  return url;
}

export function googleUrl(path: string): URL {
  let url: URL;
  try {
    url = new URL(path, "https://www.googleapis.com");
  } catch {
    throw new ProviderFault("preflight_failed", "The Drive route is invalid.");
  }
  if (
    url.origin !== "https://www.googleapis.com" ||
    !/^\/(upload\/)?drive\/v3\//.test(url.pathname) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new ProviderFault("preflight_failed", "Only Google Drive v3 routes are permitted.");
  }
  return url;
}

/** Never forward an OAuth header to a preauthenticated CDN redirect. */
function contentUrl(path: string): URL {
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    throw new ProviderFault(
      "provider_request_failed",
      "The provider returned an invalid content location.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    isIP(url.hostname) ||
    !(
      url.hostname.endsWith(".sharepoint.com") ||
      url.hostname.endsWith(".sharepointonline.com") ||
      url.hostname.endsWith(".1drv.com") ||
      url.hostname.endsWith(".googleusercontent.com") ||
      url.hostname.endsWith(".microsoft.com") ||
      url.hostname.endsWith(".azureedge.net")
    )
  ) {
    throw new ProviderFault(
      "provider_request_failed",
      "The provider returned an untrusted content location.",
    );
  }
  return url;
}

export async function fetchProvider(url: URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const signal = init.signal
    ? AbortSignal.any([controller.signal, init.signal])
    : controller.signal;
  try {
    return await fetch(url, { ...init, redirect: "manual", signal });
  } catch {
    throw new HttpProviderFault(0);
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedText(response: Response): Promise<string> {
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of responseBytes(response)) {
    size += chunk.byteLength;
    if (size > 16 * 1024 * 1024)
      throw new ProviderFault(
        "provider_request_failed",
        "Provider metadata exceeded the response limit.",
      );
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function requireSuccess(response: Response): Promise<void> {
  if (response.ok) return;
  let providerCode: string | undefined;
  try {
    const error = JSON.parse(await boundedText(response)).error;
    const candidate = typeof error?.code === "string" ? error.code : error?.errors?.[0]?.reason;
    if (typeof candidate === "string" && Object.hasOwn(SAFE_CODES, candidate))
      providerCode = candidate;
  } catch {
    /* Raw response content is deliberately discarded. */
  }
  const status =
    providerCode === "rateLimitExceeded" || providerCode === "userRateLimitExceeded"
      ? 429
      : response.status;
  throw new HttpProviderFault(status, response.headers.get("retry-after"), providerCode);
}

export async function responseJson<T>(response: Response): Promise<T> {
  await requireSuccess(response);
  if (response.status === 204) return undefined as T;
  try {
    return JSON.parse(await boundedText(response)) as T;
  } catch (error) {
    if (error instanceof ProviderFault) throw error;
    throw new ProviderFault("provider_request_failed", "Provider metadata was not valid JSON.");
  }
}

export async function* responseBytes(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => {});
          reject(new HttpProviderFault(0));
        }, 60_000);
      });
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([reader.read(), expired]);
      } catch {
        throw new HttpProviderFault(0);
      } finally {
        clearTimeout(timer);
      }
      if (next.done) break;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* authenticatedStream(url: URL, token: string): AsyncIterable<Uint8Array> {
  let response = await fetchProvider(url, { headers: { Authorization: `Bearer ${token}` } });
  for (let redirects = 0; response.status >= 300 && response.status < 400; redirects++) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (redirects >= 5 || !location)
      throw new ProviderFault(
        "provider_request_failed",
        "The provider content redirect did not resolve.",
      );
    response = await fetchProvider(contentUrl(location));
  }
  await requireSuccess(response);
  yield* responseBytes(response);
}

interface GraphPacing {
  next: number;
  blockedUntil: number;
}
const graphPacing = new Map<string, GraphPacing>();

export function createGraphTransport(session: CredentialSession): GraphTransport {
  let clocks: { app: GraphPacing; tenant: GraphPacing } | undefined;
  async function pace(signal?: AbortSignal | null): Promise<void> {
    if (!clocks) {
      const evidence = await session.evidence();
      const graph = evidence.graph as { tenantId: string; clientId: string };
      const keys = [`app:${graph.clientId}`, `tenant:${graph.clientId}:${graph.tenantId}`];
      const entries = keys.map((key) => {
        let value = graphPacing.get(key);
        if (!value) {
          value = { next: 0, blockedUntil: 0 };
          graphPacing.set(key, value);
        }
        return value;
      });
      clocks = { app: entries[0]!, tenant: entries[1]! };
    }
    // Reserve slots before awaiting: aggregate ceilings hold across jobs in this process.
    const at = Math.max(
      Date.now(),
      clocks.app.next,
      clocks.tenant.next,
      clocks.app.blockedUntil,
      clocks.tenant.blockedUntil,
    );
    clocks.app.next = at + 2; // 500/app/sec, below Microsoft's 1000 ceiling.
    clocks.tenant.next = at + 10; // 100/app/tenant/sec, below Microsoft's 200 ceiling.
    if (at > Date.now()) await delay(at - Date.now(), undefined, signal ? { signal } : {});
  }
  function noteThrottle(error: unknown): never {
    if (error instanceof HttpProviderFault && error.status === 429 && clocks) {
      const until = Date.now() + (error.retryAfterMs ?? 1000);
      clocks.app.blockedUntil = Math.max(clocks.app.blockedUntil, until);
      clocks.tenant.blockedUntil = Math.max(clocks.tenant.blockedUntil, until);
    }
    throw error;
  }
  return {
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      await pace(init.signal);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${await session.graphToken()}`);
      if (init.body && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      try {
        return await responseJson<T>(await fetchProvider(graphUrl(path), { ...init, headers }));
      } catch (error) {
        return noteThrottle(error);
      }
    },
    async *stream(path: string) {
      await pace();
      try {
        yield* authenticatedStream(graphUrl(path), await session.graphToken());
      } catch (error) {
        noteThrottle(error);
      }
    },
    async evidence() {
      const evidence = await session.evidence();
      const graph = evidence.graph;
      return typeof graph === "object" && graph !== null ? { ...graph } : evidence;
    },
  };
}
