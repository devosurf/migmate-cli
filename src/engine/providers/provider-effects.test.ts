import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { openEngine } from "../index.ts";
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

test("delegated Google copies carry a per-mapping impersonation override", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "graph.microsoft.com");
    return Response.json({ id: "source-root", name: "root", folder: {} });
  });
  const files = new FileEffects({
    config: { mappings: [mapping] },
    session: { ...session, delegatedSubject: "files@example.com" },
    graph: createGraphTransport(session),
    worker: {
      async *read() {
        throw new Error("No bytes expected");
      },
    },
  });
  const pass = await files.resolveFilePass(mapping);
  assert.equal(
    pass.destination.fs,
    'destination,team_drive="shared-drive",root_folder_id="destination-root",impersonate="files@example.com":',
  );
  assert.equal(pass.source.fs, 'source,drive_id="source-drive",root_folder_id=,encoding=Slash:');
});

test("Google about proves the acting email and exposes drive creation capability", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/drive/v3/about");
    assert.equal(url.searchParams.get("fields"), "user(emailAddress),canCreateDrives");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret-google-canary");
    return Response.json({ user: { emailAddress: "files@example.com" }, canCreateDrives: false });
  });
  assert.deepEqual(await effects().googleAbout(), {
    user: { emailAddress: "files@example.com" },
    canCreateDrives: false,
  });
});

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

test("loads manifest paths and names destination identity failures without relabeling transport errors", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "migmate-manifest-provider-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "google.json"),
    configPath = join(directory, "rclone.conf");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(
    keyPath,
    JSON.stringify({
      type: "service_account",
      project_id: "test",
      private_key_id: "a".repeat(40),
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      client_email: "migration@test.iam.gserviceaccount.com",
      client_id: "123456789",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    { mode: 0o600 },
  );
  const tenant = "11111111-1111-1111-1111-111111111111",
    app = "22222222-2222-2222-2222-222222222222";
  await writeFile(
    configPath,
    `[source]\ntype = onedrive\nclient_id = ${app}\nclient_secret = Abc8Q~tE1.vN-jK_pLq7zXyW4rS2mD6bH0uT9cVe\nclient_credentials = true\ntenant = ${tenant}\ndrive_type = documentLibrary\ndrive_id = seed-source\nroot_folder_id = seed-root\n[destination]\ntype = drive\nservice_account_file = ${keyPath}\nteam_drive = seed-drive\nroot_folder_id = seed-folder\n`,
    { mode: 0o600 },
  );
  let observedDriveId = "shared-drive";
  let destinationStatus = 200;
  t.mock.method(globalThis, "fetch", async (target: string | URL | Request) => {
    const url = new URL(String(target));
    if (url.hostname === "login.microsoftonline.com") {
      const claims = Buffer.from(
        JSON.stringify({
          aud: "https://graph.microsoft.com",
          tid: tenant,
          appid: app,
          idtyp: "app",
          roles: ["Sites.Selected"],
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url");
      return Response.json({
        access_token: `e30.${claims}.signature`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "google", token_type: "Bearer", expires_in: 3600 });
    if (url.hostname === "graph.microsoft.com") {
      if (url.pathname === "/v1.0/drives/source-drive/root:/Reports%20%23%25")
        return Response.json({
          id: "reports",
          name: "Reports #%",
          folder: {},
          parentReference: { id: "root", driveId: "source-drive" },
        });
      if (url.pathname === "/v1.0/drives/source-drive/items/reports")
        return Response.json({
          id: "reports",
          name: "Reports #%",
          folder: {},
          parentReference: { id: "root", driveId: "source-drive" },
        });
      if (url.pathname === "/v1.0/drives/source-drive/items/root")
        return Response.json({ id: "root", name: "Documents", folder: {} });
    }
    if (url.pathname === "/drive/v3/files/destination-root") {
      if (destinationStatus !== 200)
        return Response.json({ error: { code: "forbidden" } }, { status: destinationStatus });
      return Response.json({
        id: "destination-root",
        driveId: observedDriveId,
        name: "Archive",
        mimeType: "application/vnd.google-apps.folder",
        parents: [],
      });
    }
    throw new Error(`Unexpected request ${url.origin}${url.pathname}`);
  });
  const engine = openEngine({ home: join(directory, "home") });
  t.after(() => engine.close());
  const initialized = await engine.initJob({
    type: "file_migration",
    config: {
      rclone: {
        config: { resolver: "file", path: configPath, mode: "0600" },
        sourceRemote: "source",
        destinationRemote: "destination",
      },
    },
  });
  assert.equal(initialized.ok, true);
  const content = JSON.stringify({
    version: 1,
    mappings: [
      {
        id: "reports",
        source: { type: "sharepoint", driveId: "source-drive", folderPath: "Reports #%" },
        destination: {
          type: "google_shared_drive",
          driveId: "shared-drive",
          folderId: "destination-root",
        },
      },
    ],
  });
  const loaded = await engine.withWriterResult(initialized.value, (w) =>
    w.loadManifest({ format: "json", content }),
  );
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const page = await engine.reader(initialized.value).rows({ phase: "plan", view: "mappings" });
  assert.equal(page.ok, true);
  assert.deepEqual(
    page.value.rows.map((row) => (row.jobType === "file_migration" ? row.sourceItemId : null)),
    ["reports"],
  );
  observedDriveId = "another-shared-drive";
  const mismatch = await engine.withWriterResult(initialized.value, (w) =>
    w.loadManifest({ format: "json", content }),
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.refusal.code, "configuration_invalid");
  assert.deepEqual(mismatch.refusal.detail, { row: 1, field: "destination.driveId" });
  destinationStatus = 403;
  await assert.rejects(
    engine.withWriterResult(initialized.value, (w) => w.loadManifest({ format: "json", content })),
    (error) => error instanceof HttpProviderFault && error.status === 403,
  );
});

/** A nested source item, as every real library has and no fake provider models. */
function nestedSource(pathFromRoot: string, boundId: string) {
  const name = pathFromRoot.slice(pathFromRoot.lastIndexOf("/") + 1);
  const parent = pathFromRoot.slice(0, pathFromRoot.lastIndexOf("/"));
  const item = {
    id: "stable-source",
    name,
    size: 5,
    eTag: '"source-etag"',
    createdDateTime: marker.createdAt,
    lastModifiedDateTime: marker.modifiedAt,
    file: { mimeType: "application/octet-stream" },
    parentReference: {
      id: "source-parent",
      driveId: "source-drive",
      path: `/drives/source-drive/root:/${parent
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`,
    },
  };
  return {
    item,
    transport: {
      async request<T>(path: string): Promise<T> {
        if (path.includes("/versions")) return { value: [] } as T;
        if (path.includes("/retentionLabel")) return {} as T;
        // Path-addressed lookup: what the drive-root path actually resolves to.
        if (path.includes("/root:/")) return { ...item, id: boundId } as T;
        return item as T;
      },
      async *stream(): AsyncIterable<Uint8Array> {
        throw new Error("This scenario must not download Graph content.");
      },
      evidence: session.evidence,
    } satisfies GraphTransport,
  };
}

test("source bytes are read by the drive-root path that is bound to the item", async () => {
  const nested = nestedSource("reports/Q4 2026/summary.txt", "stable-source");
  const requested: Array<{ driveId: string; path: string }> = [];
  const effects = new FileEffects({
    config: { mappings: [mapping] },
    session,
    graph: nested.transport,
    worker: {
      async *read(input) {
        requested.push({ driveId: input.driveId, path: input.path });
        yield Buffer.from("bytes");
      },
    },
  });
  await effects.listSourceChildren("source-root").catch(() => undefined);
  await effects.readSourceItem({ driveId: "source-drive", itemId: "stable-source" });
  assert.equal((await bytes(effects.openSourceContent("stable-source"))).toString(), "bytes");
  assert.deepEqual(requested, [{ driveId: "source-drive", path: "reports/Q4 2026/summary.txt" }]);
});

test("a source path that resolves to another item refuses instead of serving its bytes", async () => {
  // rclone resolves object paths from the drive root, so an unbound path can
  // name a different object entirely. Reading it would migrate wrong content.
  const nested = nestedSource("reports/Q4 2026/summary.txt", "some-other-item");
  let read = false;
  const effects = new FileEffects({
    config: { mappings: [mapping] },
    session,
    graph: nested.transport,
    worker: {
      async *read() {
        read = true;
        yield Buffer.from("wrong object");
      },
    },
  });
  await effects.readSourceItem({ driveId: "source-drive", itemId: "stable-source" });
  await assert.rejects(
    bytes(effects.openSourceContent("stable-source")),
    (error: unknown) => error instanceof ProviderFault && error.code === "source_read_failed",
  );
  assert.equal(read, false);
});
