import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCredentialSession, ProviderFault, type CredentialSession } from "./credentials.ts";
import { createGraphTransport, HttpProviderFault, type GraphTransport } from "./http.ts";
import { FileEffects } from "./file-effects.ts";
import type { ProvenanceRecord } from "./port.ts";

const mapping = {
  id: "mapping",
  sourceDriveId: "source-drive",
  sourceItemId: "source-root",
  destDriveId: "shared-drive",
  destFolderId: "destination-root",
};
const session: CredentialSession = {
  async graphToken() {
    return "secret-bearer-canary";
  },
  async googleToken() {
    return "secret-google-canary";
  },
  async identity() {
    return "stable-application";
  },
  async evidence() {
    return {
      graph: {
        tenantId: "tenant",
        clientId: "app",
        grantedPermissions: ["Sites.Selected"],
      },
    };
  },
  rcloneConfigPath: null,
  sourceRemote: "source",
  destinationRemote: "destination",
  dispose() {},
};
const graph: GraphTransport = {
  async request<T>(): Promise<T> {
    throw new Error("This scenario must not query Graph.");
  },
  async *stream() {
    throw new Error("This scenario must not download Graph content.");
  },
  evidence: session.evidence,
};
const marker: ProvenanceRecord = {
  mappingId: "mapping",
  sourceDriveId: "source-drive",
  sourceItemId: "stable-source",
  sourceIdentity: "source-drive:stable-source",
  sourceKind: "file",
  sourceRelativePath: "nested/日本語.txt",
  sourceFingerprint: "a".repeat(64),
  verifiedFingerprint: null,
  createdAt: "2001-02-03T04:05:06.000Z",
  modifiedAt: "2002-03-04T05:06:07.000Z",
  mimeType: "application/octet-stream",
  stateRevision: "b".repeat(64),
};

function effects(): FileEffects {
  return new FileEffects({
    config: { mappings: [mapping] },
    session,
    graph,
    worker: {
      async *read() {
        throw new Error("This scenario must not read source bytes.");
      },
    },
  });
}

async function bytes(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const result: Uint8Array[] = [];
  for await (const chunk of content) result.push(chunk);
  return Buffer.concat(result);
}

test("a lost create response can be reconciled by the reserved ID and atomic private marker", async (t) => {
  const source = Buffer.from([0, 1, 0, 255, 128]);
  let persisted: Record<string, unknown> | undefined;
  let destination = Buffer.alloc(0);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/destination-root"))
      return Response.json(
        {
          id: "destination-root",
          driveId: "shared-drive",
          mimeType: "application/vnd.google-apps.folder",
          name: "root",
          createdTime: marker.createdAt,
          modifiedTime: marker.modifiedAt,
          parents: [],
        },
        { headers: { ETag: '"root"' } },
      );
    if (url.pathname.endsWith("/generateIds")) return Response.json({ ids: ["reserved-object"] });
    if (url.pathname === "/upload/drive/v3/files" && init?.method === "POST") {
      assert.equal(typeof init.body, "string");
      persisted = JSON.parse(String(init.body));
      return new Response(null, {
        status: 200,
        headers: {
          Location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=transient-canary",
        },
      });
    }
    if (url.searchParams.has("upload_id")) {
      destination = Buffer.from(await new Response(init?.body).arrayBuffer());
      throw new TypeError("secret transient upload URL must not escape");
    }
    if (url.pathname.endsWith("/reserved-object")) {
      if (!persisted) return new Response(null, { status: 404 });
      if (url.searchParams.get("alt") === "media") return new Response(destination);
      return Response.json(
        {
          ...persisted,
          id: "reserved-object",
          driveId: "shared-drive",
          size: String(destination.length),
        },
        { headers: { ETag: '"created"' } },
      );
    }
    throw new Error("Unexpected request");
  });
  const provider = effects();
  const id = await provider.reserveDestinationId();
  await assert.rejects(
    provider.uploadDestinationContent({
      destinationId: id,
      create: true,
      parentFolderId: "destination-root",
      name: "日本語.txt",
      content: source,
      createdAt: marker.createdAt,
      modifiedAt: marker.modifiedAt,
      mimeType: marker.mimeType,
      marker,
    }),
    (error: unknown) =>
      error instanceof HttpProviderFault &&
      error.transient &&
      !JSON.stringify(error).includes("canary"),
  );
  const recovered = await provider.readDestinationObject({ driveId: "shared-drive", objectId: id });
  assert.equal(recovered?.id, id);
  assert.deepEqual(recovered?.provenance, marker);
  assert.deepEqual(await bytes(provider.streamDestinationContent(id)), source);
});

test("an intervening destination edit refuses a conditional update without replacing its bytes", async (t) => {
  const original = Buffer.from("outside editor's bytes");
  const destination = {
    id: "owned-object",
    driveId: "shared-drive",
    name: "existing.bin",
    mimeType: "application/octet-stream",
    size: String(original.length),
    parents: ["destination-root"],
    createdTime: marker.createdAt,
    modifiedTime: marker.modifiedAt,
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/destination-root"))
      return Response.json({
        ...destination,
        id: "destination-root",
        mimeType: "application/vnd.google-apps.folder",
      });
    if (url.pathname.startsWith("/upload/") && init?.method === "PATCH")
      return Response.json(
        { error: { code: 412, message: "secret-provider-body-canary" } },
        { status: 412 },
      );
    if (url.searchParams.get("alt") === "media") return new Response(original);
    return Response.json(destination, { headers: { ETag: '"verified-before-edit"' } });
  });
  const provider = effects();
  await assert.rejects(
    provider.uploadDestinationContent({
      destinationId: "owned-object",
      create: false,
      expectedEtag: '"verified-before-edit"',
      parentFolderId: "destination-root",
      name: "existing.bin",
      content: Buffer.from("migration bytes"),
      createdAt: marker.createdAt,
      modifiedAt: marker.modifiedAt,
      mimeType: marker.mimeType,
      marker,
    }),
    (error: unknown) =>
      error instanceof HttpProviderFault &&
      error.code === "prior_copy_drift" &&
      error.status === 412 &&
      !JSON.stringify(error).includes("canary"),
  );
  assert.deepEqual(await bytes(provider.streamDestinationContent("owned-object")), original);
});

test("Graph content redirects never forward the app bearer to a preauthenticated URL", async (t) => {
  let authorizationLeaked = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "graph.microsoft.com")
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://tenant.sharepoint.com/content?token=transient-download-canary",
        },
      });
    authorizationLeaked = new Headers(init?.headers).has("Authorization");
    return new Response(Buffer.from([0, 255, 0, 42]));
  });
  const transport = createGraphTransport(session);
  assert.deepEqual(
    await bytes(transport.stream("/v1.0/drives/drive/items/item/content")),
    Buffer.from([0, 255, 0, 42]),
  );
  assert.equal(authorizationLeaked, false);
});

test("Graph throttling preserves Retry-After without retaining the response's secret diagnostics", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { code: "TooManyRequests", message: "secret-token-canary" } },
      { status: 429, headers: { "Retry-After": "7" } },
    ),
  );
  await assert.rejects(
    createGraphTransport(session).request("/v1.0/drives/drive"),
    (error: unknown) =>
      error instanceof HttpProviderFault &&
      error.status === 429 &&
      error.transient &&
      error.retryAfterMs === 7000 &&
      !JSON.stringify(error).includes("canary"),
  );
});

test("a job-contained credential is refused before a token request or secret disclosure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "migmate-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "job"), { mode: 0o700 });
  const secret = join(await realpath(directory), "job", "secret");
  await writeFile(secret, "credential-file-sentinel", { mode: 0o600 });
  let contactedProvider = false;
  t.mock.method(globalThis, "fetch", async () => {
    contactedProvider = true;
    throw new Error("Authentication must not run");
  });
  await assert.rejects(
    createCredentialSession({
      jobType: "teams_archive",
      jobDirectory: join(directory, "job"),
      config: {
        graph: {
          tenantId: "11111111-1111-1111-1111-111111111111",
          clientId: "22222222-2222-2222-2222-222222222222",
        },
        secrets: { teams_graph_client_secret: { resolver: "file", path: secret, mode: "0600" } },
      },
    }),
    (error: unknown) =>
      error instanceof ProviderFault &&
      error.code === "credential_inside_job" &&
      !JSON.stringify(error).includes("credential-file-sentinel"),
  );
  assert.equal(contactedProvider, false);
});
