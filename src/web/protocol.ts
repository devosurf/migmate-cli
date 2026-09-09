import { VERBS, type Verb } from "../engine/index.ts";
import { CODE_BY_NAME } from "../engine/codes.ts";
import { CSS, CLIENT, HTML } from "./assets.ts";
import { renderView } from "./render.ts";
import { WebSession, type ViewQuery, type WebCommand } from "./session.ts";

const CSP =
  "default-src 'none'; script-src 'self' migmate://localhost; style-src 'self' migmate://localhost; connect-src 'self' migmate://localhost; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const MAX_BODY_BYTES = 1024 * 1024;

/** Windows' Wry URL is intercepted natively. It is not an HTTP listener. */
function localUrl(raw: string, platform: NodeJS.Platform): URL | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.port || url.hash) return null;
    if (url.protocol === "migmate:" && url.hostname === "localhost") return url;
    if (platform === "win32" && url.protocol === "http:" && url.hostname === "migmate.localhost")
      return url;
  } catch {
    /* Malformed URLs never reach an engine call. */
  }
  return null;
}

export function allowedNavigation(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const url = localUrl(raw, platform);
  return url !== null && url.pathname === "/" && url.search === "";
}

function viewQuery(url: URL): ViewQuery | null {
  const params = url.searchParams;
  const keys = ["stage", "search", "codes", "cursor", "limit", "sort"];
  if (
    [...params.keys()].some(
      (key) => !keys.includes(key) || (key !== "codes" && params.getAll(key).length !== 1),
    )
  )
    return null;
  const stage = params.get("stage") ?? "status";
  const limit = params.get("limit") ?? "50";
  const sort = params.get("sort") ?? "natural";
  const search = params.get("search") ?? undefined;
  const cursor = params.get("cursor") ?? undefined;
  const codes = params.getAll("codes");
  if (
    !VERBS.includes(stage as Verb) ||
    !["25", "50", "100"].includes(limit) ||
    (sort !== "natural" && sort !== "path" && sort !== "size") ||
    (search?.length ?? 0) > 512 ||
    (cursor?.length ?? 0) > 2048 ||
    codes.length > 128 ||
    codes.some((code) => !Object.hasOwn(CODE_BY_NAME, code))
  )
    return null;
  return {
    stage: stage as Verb,
    phase: stage === "verify" ? "verify" : stage === "execute" ? "execute" : "plan",
    limit: Number(limit),
    sort,
    ...(search === undefined ? {} : { search }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(codes.length ? { codes } : {}),
  };
}

async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw new Error("body_limit");
  if (!request.body) throw new Error("body_required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("body_limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
}

export function createProtocolHandler(options: {
  session: WebSession;
  platform?: NodeJS.Platform;
  onQuit?: () => void;
}): (request: Request) => Promise<Response> {
  const platform = options.platform ?? process.platform;
  return async (request) => {
    const url = localUrl(request.url, platform);
    const origin = request.headers.get("origin");
    const localOrigin =
      origin === null ||
      origin === "null" ||
      origin === "migmate://localhost" ||
      (platform === "win32" && origin === "http://migmate.localhost");
    const headers: Record<string, string> = {
      "Content-Security-Policy": CSP,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
    };
    if (origin && localOrigin) headers["Access-Control-Allow-Origin"] = origin;
    const response = (body: string, status = 200, contentType = "text/html; charset=utf-8") =>
      new Response(body, { status, headers: { ...headers, "Content-Type": contentType } });
    if (!url || !localOrigin || request.headers.get("sec-fetch-site") === "cross-site")
      return response("Forbidden", 403, "text/plain; charset=utf-8");
    // No filesystem resolution: every served resource is an exact package-owned path.
    if (["/", "/style.css", "/client.js"].includes(url.pathname)) {
      if (url.search) return response("Not found", 404, "text/plain; charset=utf-8");
      if (request.method !== "GET")
        return response("Method not allowed", 405, "text/plain; charset=utf-8");
      if (url.pathname === "/") return response(HTML);
      return url.pathname === "/style.css"
        ? response(CSS, 200, "text/css; charset=utf-8")
        : response(CLIENT, 200, "application/javascript; charset=utf-8");
    }
    if (!["/view", "/command", "/quit"].includes(url.pathname))
      return response("Not found", 404, "text/plain; charset=utf-8");
    if (request.method === "OPTIONS" && ["/command", "/quit"].includes(url.pathname)) {
      const requested = (request.headers.get("access-control-request-headers") ?? "")
        .toLowerCase()
        .split(",")
        .map((header) => header.trim())
        .filter(Boolean);
      if (
        request.headers.get("access-control-request-method") !== "POST" ||
        requested.some((header) => !["content-type", "x-migmate-action"].includes(header))
      )
        return response("Forbidden", 403, "text/plain; charset=utf-8");
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type, X-Migmate-Action",
        },
      });
    }
    const query = viewQuery(url);
    if (!query || (url.pathname === "/quit" && url.search))
      return response("Invalid view query", 400, "text/plain; charset=utf-8");
    try {
      if (url.pathname === "/view") {
        if (request.method !== "GET")
          return response("Method not allowed", 405, "text/plain; charset=utf-8");
        return response(renderView(await options.session.snapshot(query), query));
      }
      if (request.method !== "POST")
        return response("Method not allowed", 405, "text/plain; charset=utf-8");
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json" ||
        request.headers.get("x-migmate-action") !== "1"
      )
        return response("JSON action required", 415, "text/plain; charset=utf-8");
      let body: unknown;
      try {
        body = await readBody(request);
      } catch {
        return response("Invalid or oversized JSON action", 400, "text/plain; charset=utf-8");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return response("Invalid action", 400, "text/plain; charset=utf-8");
      if (url.pathname === "/quit") {
        if (Object.keys(body).length !== 0 || !options.onQuit)
          return response("Quit unavailable", 400, "text/plain; charset=utf-8");
        // Let this protocol response finish before native resources are disposed.
        setImmediate(options.onQuit);
        return response("Quitting at a safe checkpoint", 200, "text/plain; charset=utf-8");
      }
      const command = body as Partial<WebCommand>;
      if (
        Object.keys(body).some((key) => !["action", "input"].includes(key)) ||
        typeof command.action !== "string" ||
        !command.input ||
        typeof command.input !== "object" ||
        Array.isArray(command.input)
      )
        return response("Invalid action", 400, "text/plain; charset=utf-8");
      const result = options.session.command({ action: command.action, input: command.input });
      const snapshot = await options.session.snapshot(query);
      return response(
        renderView(
          result.ok ? snapshot : { ...snapshot, readonly: true, refusal: result.refusal },
          query,
        ),
        result.ok ? 202 : 409,
      );
    } catch {
      // Defects stay defects and are rethrown when the session closes. Never emit raw errors.
      return response(
        "The job could not be read. This window cannot claim writer access.",
        500,
        "text/plain; charset=utf-8",
      );
    }
  };
}
