import assert from "node:assert/strict";
import {
  constants,
  createPrivateKey,
  generateKeyPairSync,
  verify,
  X509Certificate,
} from "node:crypto";
import { test } from "node:test";
import { createCredentialSession, type CredentialSession } from "./credentials.ts";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharePointAdapter } from "./adapters/sharepoint.ts";
import {
  loadSharePointCertificate,
  requestSharePointToken,
} from "./adapters/credentials/sharepoint.ts";
import { FakeFileMigrationPort, type FakeFileMigrationFixture } from "./fake.ts";
import type { GraphTransport } from "./http.ts";
import type { DriveMember } from "./port.ts";

const siteId = "tenant.sharepoint.com,site,web";
const listId = "11111111-1111-1111-1111-111111111111";
const siteUrl = "https://tenant.sharepoint.com/sites/finance";
const createdTime = "2026-09-01T00:00:00.000Z";
const session: CredentialSession = {
  async graphToken() {
    throw new Error("Source credentials must not be used");
  },
  async graphDestinationToken() {
    return "destination-graph";
  },
  async sharepointDestinationToken(resource) {
    assert.equal(resource, siteUrl);
    return "destination-sharepoint";
  },
  async googleToken() {
    throw new Error("Google credentials must not be used");
  },
  async dropboxToken() {
    throw new Error("Dropbox credentials must not be used");
  },
  async identity() {
    return "destination-app";
  },
  async evidence() {
    return { graphDestination: { tenantId: "tenant", clientId: "destination-app" } };
  },
  rcloneConfigPath: null,
  sourceRemote: null,
  destinationRemote: null,
  dispose() {},
};
const graph: GraphTransport = {
  async request<T>(): Promise<T> {
    throw new Error("Source Graph must not be used");
  },
  async *stream() {
    throw new Error("Source Graph must not be used");
  },
  evidence: session.evidence,
};
function adapter(credentials = session): SharePointAdapter {
  return new SharePointAdapter({
    mappings: [],
    destinationRoots: [],
    session: credentials,
    graph,
    worker: {
      read() {
        return null;
      },
    },
  });
}

function fake(overrides: Partial<FakeFileMigrationFixture> = {}): FakeFileMigrationPort {
  return new FakeFileMigrationPort({
    sourceDriveId: "source",
    sourceRootId: "source-root",
    destinationDriveId: "existing",
    destinationRootId: "existing-root",
    sourceItems: [],
    destinationItems: [],
    destinationProvider: "sharepoint",
    inheritedSiteMembers: {
      [siteId]: [{ email: "site-reader@example.com", type: "user", role: "read" }],
    },
    now: () => new Date(createdTime),
    ...overrides,
  });
}

test("creates only a document library in the specified existing site and recovers exact names across pages", async (t) => {
  let creates = 0;
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer destination-graph");
    if (url.pathname.endsWith("/lists") && init?.method === "POST") {
      assert.equal(decodeURIComponent(url.pathname), `/v1.0/sites/${siteId}/lists`);
      assert.deepEqual(JSON.parse(String(init.body)), {
        displayName: "Finance's library",
        description: "migmate:creation-request:intent",
        list: { template: "documentLibrary" },
      });
      if (++creates > 1) return new Response(null, { status: 409 });
      return Response.json({
        id: listId,
        displayName: "Finance's library",
        description: "migmate:creation-request:intent",
        createdDateTime: createdTime,
      });
    }
    if (url.pathname.endsWith("/lists")) {
      assert.equal(decodeURIComponent(url.pathname), `/v1.0/sites/${siteId}/lists`);
      if (!url.searchParams.has("page"))
        assert.ok(url.searchParams.get("$select")?.split(",").includes("description"));
      if (url.searchParams.has("page"))
        return Response.json({
          value: [
            {
              id: listId,
              displayName: "Finance's library",
              description: "migmate:creation-request:intent",
              createdDateTime: createdTime,
              list: { template: "documentLibrary" },
            },
          ],
        });
      return Response.json({
        value: [
          {
            id: "wrong-case",
            displayName: "finance's library",
            list: { template: "documentLibrary" },
          },
          {
            id: "not-library",
            displayName: "Finance's library",
            list: { template: "genericList" },
          },
        ],
        "@odata.nextLink": `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/lists?page=2`,
      });
    }
    if (url.pathname.endsWith(`/lists/${listId}/drive`))
      return Response.json({ id: "library-drive" });
    assert.equal(url.pathname, "/v1.0/drives/library-drive/root");
    return Response.json({ id: "library-root" });
  });
  const files = adapter();
  assert.equal(await files.destinationCreator(), "");
  const expected = {
    id: "library-drive",
    name: "Finance's library",
    createdTime,
    rootFolderId: "library-root",
    creationRequestId: "intent",
  };
  assert.deepEqual(
    await files.createDestinationContainer({ name: expected.name, siteId, requestId: "intent" }),
    expected,
  );
  assert.equal(
    await files.createDestinationContainer({ name: expected.name, siteId, requestId: "intent" }),
    null,
  );
  assert.deepEqual(await files.findDestinationContainers({ name: expected.name, siteId }), [
    expected,
  ]);
  assert.equal(
    calls.some((call) => call.includes("permissions") || call.includes("_api")),
    false,
  );
  await assert.rejects(
    files.createDestinationContainer({ name: "Missing site", requestId: "intent" }),
    { code: "destination_site_required" },
  );
  await assert.rejects(files.findDestinationContainers({ name: expected.name }), {
    code: "destination_site_required",
  });
});

test("recovery preserves foreign same-title and same-time libraries without inventing creation proof", async (t) => {
  const libraries = [
    { id: "owned", description: "migmate:creation-request:this-job" },
    { id: "foreign", description: "migmate:creation-request:other-job" },
    { id: "unmarked" },
    { id: "mentioned", description: "Notes: migmate:creation-request:this-job" },
    { id: "suffixed", description: "migmate:creation-request:this-job\n" },
    { id: "empty-marker", description: "migmate:creation-request:" },
  ];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/lists")) {
      assert.equal(decodeURIComponent(url.pathname), `/v1.0/sites/${siteId}/lists`);
      assert.ok(url.searchParams.get("$select")?.split(",").includes("description"));
      return Response.json({
        value: libraries.map((library) => ({
          ...library,
          displayName: "Finance",
          createdDateTime: createdTime,
          list: { template: "documentLibrary" },
        })),
      });
    }
    const list = /\/lists\/([^/]+)\/drive$/.exec(url.pathname);
    if (list) return Response.json({ id: `drive-${list[1]}` });
    const root = /\/drives\/([^/]+)\/root$/.exec(url.pathname);
    assert.ok(root);
    return Response.json({ id: `${root[1]}-root` });
  });
  const found = await adapter().findDestinationContainers({ name: "Finance", siteId });
  assert.deepEqual(found, [
    {
      id: "drive-owned",
      name: "Finance",
      createdTime,
      rootFolderId: "drive-owned-root",
      creationRequestId: "this-job",
    },
    {
      id: "drive-foreign",
      name: "Finance",
      createdTime,
      rootFolderId: "drive-foreign-root",
      creationRequestId: "other-job",
    },
    { id: "drive-unmarked", name: "Finance", createdTime, rootFolderId: "drive-unmarked-root" },
    { id: "drive-mentioned", name: "Finance", createdTime, rootFolderId: "drive-mentioned-root" },
    { id: "drive-suffixed", name: "Finance", createdTime, rootFolderId: "drive-suffixed-root" },
    {
      id: "drive-empty-marker",
      name: "Finance",
      createdTime,
      rootFolderId: "drive-empty-marker-root",
    },
  ]);
});

test("fake recovers a lost library create response by exact site and preserves inheritance without members", async () => {
  const files = fake();
  files.loseResponseOnce("createDestinationContainer", "Finance");
  await assert.rejects(
    files.createDestinationContainer({ name: "Finance", siteId, requestId: "intent" }),
    { name: "AbortError" },
  );
  const [created] = await files.findDestinationContainers({ name: "Finance", siteId });
  assert.ok(created);
  assert.equal(created.rootFolderId, "drive-1-root");
  assert.equal(created.createdTime, createdTime);
  assert.equal(await files.destinationCreator(), "");
  assert.equal(files.destinationInheritsPermissions(created.id), true);
  assert.deepEqual(files.snapshotDestinationContainers()[0]?.members, [
    { email: "site-reader@example.com", type: "user", role: "read" },
  ]);
  await files.validateDestinationCreation({ siteId, members: [] });
  await assert.rejects(files.listDriveMembers(created.id), {
    code: "sharepoint_membership_credentials_required",
  });
  assert.deepEqual(
    await files.findDestinationContainers({ name: "Finance", siteId: "another-site" }),
    [],
  );
  assert.deepEqual(await files.findDestinationContainers({ name: "finance", siteId }), []);
  assert.equal(
    await files.createDestinationContainer({
      name: "Finance",
      siteId,
      requestId: "another-intent",
    }),
    null,
  );
  assert.ok(
    await files.createDestinationContainer({
      name: "Finance",
      siteId: "another-site",
      requestId: "intent",
    }),
  );
});

test("fake breaks inheritance before named grants and a lost break response does not erase later grants", async () => {
  const files = fake({ sharepointMembershipAvailable: true });
  const created = await files.createDestinationContainer({
    name: "Finance",
    siteId,
    requestId: "intent",
  });
  assert.ok(created);
  files.loseResponseOnce("prepareDestinationMembers", created.id);
  await assert.rejects(files.prepareDestinationMembers(created.id), { name: "AbortError" });
  assert.equal(files.destinationInheritsPermissions(created.id), false);
  assert.deepEqual(await files.listDriveMembers(created.id), []);
  const member: DriveMember = { email: "named@example.com", type: "user", role: "owner" };
  await files.addDriveMember(created.id, member);
  await files.prepareDestinationMembers(created.id);
  assert.deepEqual(await files.listDriveMembers(created.id), [member]);
  assert.equal(
    files.calls.filter((call) => call.startsWith("breakPermissionInheritance:")).length,
    1,
  );
  assert.ok(
    files.calls.indexOf(`breakPermissionInheritance:${created.id}`) <
      files.calls.indexOf(`addDriveMember:${created.id}:${member.email}`),
  );
});

test("production uses SharePoint REST for unique permissions and actual role assignments, never Graph permission grants", async (t) => {
  let unique = false;
  let breaks = 0;
  const roles = new Map<number, number>();
  const operations: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "graph.microsoft.com") {
      assert.equal(url.pathname, "/v1.0/drives/library-drive");
      return Response.json({ sharepointIds: { siteUrl, listId } });
    }
    assert.equal(url.origin, "https://tenant.sharepoint.com");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer destination-sharepoint");
    operations.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/effectiveBasePermissions"))
      return Response.json({ High: "1073741824", Low: "33556480" });
    if (url.searchParams.get("$select") === "HasUniqueRoleAssignments")
      return Response.json({ HasUniqueRoleAssignments: unique });
    if (url.pathname.includes("breakroleinheritance")) {
      assert.ok(url.pathname.includes("copyRoleAssignments=false,clearSubscopes=false"));
      unique = true;
      breaks++;
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/ensureuser")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { logonName: "named@example.com" });
      return Response.json({ Id: 7, Email: "named@example.com", PrincipalType: 1 });
    }
    if (url.pathname.endsWith("/siteusers"))
      return Response.json({ value: [{ Id: 8, Email: "team@example.com", PrincipalType: 4 }] });
    const roleType = /getbytype\((\d+)\)/.exec(url.pathname);
    if (roleType) return Response.json({ Id: Number(roleType[1]) + 100 });
    const assignment = /getbyprincipalid\((\d+)\)/.exec(url.pathname);
    if (assignment) {
      const id = Number(assignment[1]);
      if (init?.method === "DELETE") {
        roles.delete(id);
        return new Response(null, { status: 204 });
      }
      if (!roles.has(id)) return new Response(null, { status: 404 });
      return Response.json({ RoleDefinitionBindings: [{ RoleTypeKind: roles.get(id) }] });
    }
    const grant = /addroleassignment\(principalid=(\d+),roledefid=(\d+)\)/.exec(url.pathname);
    if (grant) {
      assert.equal(unique, true);
      roles.set(Number(grant[1]), Number(grant[2]) - 100);
      return new Response(null, { status: 204 });
    }
    assert.ok(url.pathname.endsWith("/roleassignments"));
    return Response.json({
      value: unique
        ? [
            {
              Member: { Id: 90, LoginName: "app:destination-app", PrincipalType: 0 },
              RoleDefinitionBindings: [{ RoleTypeKind: 5, Name: "Full Control" }],
            },
            ...[...roles].map(([id, role]) => ({
              Member: {
                Id: id,
                Email: id === 7 ? "named@example.com" : "team@example.com",
                PrincipalType: id === 7 ? 1 : 4,
              },
              RoleDefinitionBindings: [{ RoleTypeKind: role, Name: "Native role" }],
            })),
          ]
        : [
            {
              Member: { Id: 99, LoginName: "site-owners", PrincipalType: 8 },
              RoleDefinitionBindings: [{ RoleTypeKind: 5, Name: "Full Control" }],
            },
          ],
    });
  });
  const files = adapter();
  assert.deepEqual(await files.listDriveMembers("library-drive"), [
    { email: "site-owners", type: "group", role: "owner" },
  ]);
  assert.equal(breaks, 0);
  await files.prepareDestinationMembers("library-drive");
  await files.addDriveMember("library-drive", {
    email: "named@example.com",
    type: "user",
    role: "read",
  });
  await files.addDriveMember("library-drive", {
    email: "named@example.com",
    type: "user",
    role: "owner",
  });
  await files.addDriveMember("library-drive", {
    email: "team@example.com",
    type: "group",
    role: "write",
  });
  await files.prepareDestinationMembers("library-drive");
  assert.equal(breaks, 1);
  assert.deepEqual(await files.listDriveMembers("library-drive"), [
    { email: "app:destination-app", type: "principal:0", role: "owner" },
    { email: "named@example.com", type: "user", role: "owner" },
    { email: "team@example.com", type: "group", role: "write" },
  ]);
  assert.ok(operations.some((call) => call.startsWith("DELETE ")));
});

test("missing SharePoint certificate refuses ACL mutation and membership claims without sending a Graph token to REST", async (t) => {
  const { sharepointDestinationToken: _token, ...secretOnly } = session;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.hostname, "graph.microsoft.com");
    requests++;
    return Response.json({ sharepointIds: { siteUrl, listId } });
  });
  const files = adapter(secretOnly);
  await assert.rejects(files.prepareDestinationMembers("library-drive"), {
    code: "sharepoint_membership_credentials_required",
  });
  await assert.rejects(files.listDriveMembers("library-drive"), {
    code: "sharepoint_membership_credentials_required",
  });
  assert.equal(requests, 1);
});

test("certificate assertions enforce SharePoint Sites.Selected and reject broader permissions and another audience", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credential = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "22222222-2222-2222-2222-222222222222",
    secret: null,
  };
  const certificate = { privateKey, thumbprint: "certificate-thumbprint" };
  let permissions = ["Sites.Selected"];
  let audience = "00000003-0000-0ff1-ce00-000000000000";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(
      String(input),
      `https://login.microsoftonline.com/${credential.tenantId}/oauth2/v2.0/token`,
    );
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("scope"), "https://tenant.sharepoint.com/.default");
    assert.equal(form.has("client_secret"), false);
    const assertion = form.get("client_assertion")!;
    const [header, claims, signature] = assertion.split(".");
    assert.ok(header && claims && signature);
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
      alg: "PS256",
      typ: "JWT",
      "x5t#S256": certificate.thumbprint,
    });
    assert.equal(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        {
          key: publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        },
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
    assert.equal(JSON.parse(Buffer.from(claims, "base64url").toString()).iss, credential.clientId);
    const tokenClaims = Buffer.from(
      JSON.stringify({
        tid: credential.tenantId,
        appid: credential.clientId,
        aud: audience,
        roles: permissions,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    return Response.json({
      access_token: `header.${tokenClaims}.signature`,
      expires_in: 3600,
      token_type: "Bearer",
    });
  });
  const token = await requestSharePointToken(
    credential,
    certificate,
    siteUrl,
    new AbortController().signal,
  );
  assert.deepEqual(token.permissions, ["Sites.Selected"]);
  for (const forbidden of [
    ["Sites.FullControl.All"],
    ["Sites.ReadWrite.All"],
    ["Sites.Selected", "Sites.FullControl.All"],
  ]) {
    permissions = forbidden;
    await assert.rejects(
      requestSharePointToken(credential, certificate, siteUrl, new AbortController().signal),
      { code: "credential_permissions_invalid" },
    );
  }
  permissions = ["Sites.Selected"];
  audience = "https://graph.microsoft.com";
  await assert.rejects(
    requestSharePointToken(credential, certificate, siteUrl, new AbortController().signal),
    { code: "credential_application_identity_invalid" },
  );
  await assert.rejects(
    requestSharePointToken(
      credential,
      certificate,
      "https://attacker.example/sites/finance",
      new AbortController().signal,
    ),
    { code: "credential_sharepoint_resource_invalid" },
  );
  assert.throws(() => loadSharePointCertificate(Buffer.from("not a certificate")), {
    code: "credential_certificate_invalid",
  });
});

test("named-member creation prerequisites are read-only and require observed site capabilities", async (t) => {
  let observed: unknown = { High: "1073741824", Low: "33556480" };
  let status = 200;
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(init?.method ?? "GET", "GET");
    calls.push(url.pathname);
    if (url.hostname === "graph.microsoft.com") {
      assert.equal(decodeURIComponent(url.pathname), `/v1.0/sites/${siteId}`);
      return Response.json({ webUrl: siteUrl });
    }
    assert.equal(url.href, `${siteUrl}/_api/web/effectiveBasePermissions`);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer destination-sharepoint");
    return Response.json(observed, { status });
  });
  const files = adapter();
  await files.validateDestinationCreation({ siteId, members: [] });
  assert.deepEqual(calls, []);
  const members: DriveMember[] = [{ email: "named@example.com", type: "user", role: "read" }];
  await files.validateDestinationCreation({ siteId, members });
  assert.equal(calls.length, 2);
  for (const insufficient of [
    { High: "0", Low: "33556480" },
    { High: "1073741824", Low: "2048" },
    { High: "1073741824", Low: "33554432" },
    { High: "not-permissions", Low: "33556480" },
    {},
  ]) {
    observed = insufficient;
    await assert.rejects(files.validateDestinationCreation({ siteId, members }), {
      code: "preflight_failed",
      evidence: { check: "sharepoint_membership_permissions_unproven", siteId },
    });
  }
  status = 403;
  await assert.rejects(files.validateDestinationCreation({ siteId, members }), {
    code: "preflight_failed",
    evidence: { check: "sharepoint_membership_permissions_unproven", siteId },
  });
  const { sharepointDestinationToken: _token, ...secretOnly } = session;
  await assert.rejects(adapter(secretOnly).validateDestinationCreation({ siteId, members }), {
    code: "preflight_failed",
    evidence: { check: "sharepoint_membership_credentials_required", siteId },
    message: /CREDENTIALS\.md/,
  });
});

test("fake refuses named-member prerequisites before creation and preserves implicit grants after hydration", async () => {
  const missing = fake();
  const members: DriveMember[] = [{ email: "named@example.com", type: "user", role: "read" }];
  await assert.rejects(missing.validateDestinationCreation({ siteId, members }), {
    code: "preflight_failed",
    evidence: { check: "sharepoint_membership_credentials_required", siteId },
  });
  assert.deepEqual(missing.snapshotDestinationContainers(), []);
  const implicit = { email: "app:destination-app", type: "principal:0", role: "owner" };
  const files = fake({ sharepointMembershipAvailable: true, implicitLibraryMembers: [implicit] });
  await files.validateDestinationCreation({ siteId, members });
  const created = await files.createDestinationContainer({
    name: "Finance",
    siteId,
    requestId: "intent",
  });
  assert.ok(created?.rootFolderId);
  await files.prepareDestinationMembers(created.id);
  assert.deepEqual(await files.listDriveMembers(created.id), [implicit]);
  await files.addDriveMember(created.id, members[0]!);
  const root = await files.resolveDestinationFolder({
    destDriveId: created.id,
    destFolderId: created.rootFolderId,
  });
  assert.ok(root);
  const reopened = fake({
    sharepointMembershipAvailable: true,
    destinationContainers: files.snapshotDestinationContainers(),
    destinationItems: [
      {
        id: root.id,
        driveId: root.driveId,
        parentId: null,
        name: root.name,
        kind: root.kind,
        ...(root.webUrl ? { webUrl: root.webUrl } : {}),
      },
    ],
  });
  await reopened.prepareDestinationMembers(created.id);
  assert.equal(reopened.destinationInheritsPermissions(created.id), false);
  assert.deepEqual(await reopened.listDriveMembers(created.id), [implicit, members[0]]);
  assert.equal(
    (
      await reopened.resolveDestinationFolder({
        destDriveId: created.id,
        destFolderId: created.rootFolderId,
      })
    )?.webUrl,
    root.webUrl,
  );
  assert.equal(reopened.snapshotDestination(created.rootFolderId).length, 1);
  assert.equal(
    reopened.calls.some((call) => call.startsWith("breakPermissionInheritance:")),
    false,
  );
});

test("certificate loader requires a live certificate and its matching RSA private key", async (t) => {
  // Public test-only key, never a tenant credential.
  const pem = await readFile(new URL("./sharepoint-test-certificate.pem", import.meta.url));
  const certificate = new X509Certificate(pem);
  let now = Date.parse(certificate.validFrom) + 60_000;
  t.mock.method(Date, "now", () => now);
  const loaded = loadSharePointCertificate(pem);
  assert.equal(certificate.checkPrivateKey(loaded.privateKey), true);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.throws(
    () =>
      loadSharePointCertificate(
        Buffer.from(
          certificate.toString() + other.export({ type: "pkcs8", format: "pem" }).toString(),
        ),
      ),
    { code: "credential_certificate_invalid" },
  );
  now = Date.parse(certificate.validTo) + 1;
  assert.throws(() => loadSharePointCertificate(pem), { code: "credential_certificate_invalid" });
});

test("optional certificate credentials stay lazy and cache SharePoint tokens separately by host", async (t) => {
  const pem = await readFile(new URL("./sharepoint-test-certificate.pem", import.meta.url));
  const certificate = new X509Certificate(pem);
  const now = Date.parse(certificate.validFrom) + 120_000;
  t.mock.method(Date, "now", () => now);
  const directory = await mkdtemp(join(tmpdir(), "migmate-library-credentials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobDirectory = join(directory, "job");
  await mkdir(jobDirectory);
  const configPath = join(directory, "rclone.conf");
  const certificatePath = join(directory, "destination.pem");
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const sourcePath = join(directory, "source.json");
  await writeFile(
    sourcePath,
    JSON.stringify({
      type: "service_account",
      token_uri: "https://oauth2.googleapis.com/token",
      client_email: "source@example.iam.gserviceaccount.com",
      client_id: "123",
      private_key_id: "a".repeat(40),
      private_key: createPrivateKey(pem).export({ format: "pem", type: "pkcs8" }),
    }),
    { mode: 0o600 },
  );
  const destinationApp = "33333333-3333-3333-3333-333333333333";
  await writeFile(
    configPath,
    [
      "[source]",
      "type = drive",
      `service_account_file = ${sourcePath}`,
      "",
      "[destination]",
      "type = onedrive",
      `tenant = ${tenantId}`,
      `client_id = ${destinationApp}`,
      "client_secret = destination-secret",
      "client_credentials = true",
      "drive_type = documentLibrary",
    ].join("\n"),
    { mode: 0o600 },
  );
  const config = {
    sourceProvider: "google_shared_drive",
    destinationProvider: "sharepoint",
    rclone: {
      config: { resolver: "file", path: configPath },
      destinationRemote: "source",
      sharepointDestinationRemote: "destination",
    },
  };
  let certificateRequests = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`);
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("client_id"), destinationApp);
    const scope = body.get("scope");
    const graph = scope === "https://graph.microsoft.com/.default";
    if (graph) assert.equal(body.get("client_secret"), "destination-secret");
    else {
      assert.ok(
        scope === "https://tenant.sharepoint.com/.default" ||
          scope === "https://other.sharepoint.com/.default",
      );
      assert.equal(body.has("client_secret"), false);
      assert.ok(body.get("client_assertion"));
      certificateRequests++;
    }
    const claims = Buffer.from(
      JSON.stringify({
        tid: tenantId,
        appid: destinationApp,
        aud: graph ? "https://graph.microsoft.com" : "00000003-0000-0ff1-ce00-000000000000",
        roles: graph ? ["Sites.ReadWrite.All"] : ["Sites.Selected"],
        exp: Math.floor(now / 1000) + 3600,
      }),
    ).toString("base64url");
    return Response.json({
      access_token: `header.${claims}.signature`,
      expires_in: 3600,
      token_type: "Bearer",
    });
  });
  const secretOnly = await createCredentialSession({
    jobType: "file_migration",
    config,
    jobDirectory,
  });
  t.after(() => secretOnly.dispose());
  await secretOnly.graphDestinationToken();
  assert.ok(secretOnly.sharepointDestinationToken);
  await assert.rejects(secretOnly.sharepointDestinationToken(siteUrl), {
    code: "sharepoint_membership_credentials_required",
    message: /CREDENTIALS\.md/,
  });
  const scoped = await createCredentialSession({
    jobType: "file_migration",
    jobDirectory,
    config: {
      ...config,
      rclone: {
        ...config.rclone,
        sharepointDestinationCertificate: { resolver: "file", path: certificatePath },
      },
    },
  });
  t.after(() => scoped.dispose());
  // The optional certificate file does not exist yet: Graph-only work still works.
  await scoped.graphDestinationToken();
  assert.equal(certificateRequests, 0);
  await writeFile(certificatePath, pem, { mode: 0o600 });
  assert.ok(scoped.sharepointDestinationToken);
  await scoped.sharepointDestinationToken(siteUrl);
  await scoped.sharepointDestinationToken("https://tenant.sharepoint.com/sites/another");
  assert.equal(certificateRequests, 1);
  await scoped.sharepointDestinationToken("https://other.sharepoint.com/sites/finance");
  assert.equal(certificateRequests, 2);
  scoped.dispose();
  await assert.rejects(scoped.sharepointDestinationToken(siteUrl), {
    code: "credential_session_disposed",
  });
});
