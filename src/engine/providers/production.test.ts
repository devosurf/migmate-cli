import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProductionProvider } from "./production.ts";
import { ProviderFault } from "./credentials.ts";
import { digestJson } from "../store/digest.ts";
import type { ProvenanceRecord } from "./port.ts";

test("production never manufactures route qualification when captured evidence is absent", async (t) => {
  const jobDirectory = await mkdtemp(join(tmpdir(), "migmate-unqualified-"));
  t.after(() => rm(jobDirectory, { recursive: true, force: true }));
  const provider = createProductionProvider({
    jobType: "file_migration",
    jobDirectory,
    config: {
      mappings: [
        {
          id: "mapping",
          sourceDriveId: "library",
          sourceItemId: "root",
          destDriveId: "shared-drive",
          destFolderId: "folder",
        },
      ],
    },
  });
  t.after(() => provider.close?.());
  await assert.rejects(
    provider.qualificationEvidence!(),
    (error: unknown) => error instanceof ProviderFault && error.code === "unqualified_route",
  );
});

test("an operator-supplied successful-looking route claim is not an immutable evidence bundle", async (t) => {
  const jobDirectory = await mkdtemp(join(tmpdir(), "migmate-forged-route-"));
  t.after(() => rm(jobDirectory, { recursive: true, force: true }));
  const provider = createProductionProvider({
    jobType: "file_migration",
    jobDirectory,
    config: {
      qualification: {
        bundle: "../../operator-claim.json",
        digest: "a".repeat(64),
        passed: true,
        probes: { collision_matrix: "pass" },
      },
    },
  });
  t.after(() => provider.close?.());
  await assert.rejects(
    provider.qualificationEvidence!(),
    (error: unknown) => error instanceof ProviderFault && error.code === "unqualified_route",
  );
});

test(
  "the published local archive bundle still validates but cannot qualify a Shared Drive destination",
  { skip: process.platform !== "darwin" || process.arch !== "arm64" },
  async (t) => {
    const jobDirectory = await mkdtemp(join(tmpdir(), "migmate-archive-route-"));
    t.after(() => rm(jobDirectory, { recursive: true, force: true }));
    const tupleDigest = "6aa55648a2a150d62bd7f7abbf1d2599c93b5c069d905b1df82ab14a95e1f103";
    const digest = "e6a5d2d8fa14fc6e5c65b119105fa27555594831abf3c97476c553f3508e71a9";
    const config = {
      scopes: [
        { kind: "team", teamId: "team-id" },
        { kind: "user-chats", userId: "user-id" },
      ],
      qualification: { bundle: `qualification/${tupleDigest}/${digest}`, digest },
    };
    const local = createProductionProvider({ jobType: "teams_archive", jobDirectory, config });
    t.after(() => local.close?.());
    const evidence = await local.qualificationEvidence!();
    assert.equal(digestJson(evidence.tuple), tupleDigest);
    assert.equal(evidence.digest, digest);
    const remote = createProductionProvider({
      jobType: "teams_archive",
      jobDirectory,
      config: {
        ...config,
        destination: { destDriveId: "0ABCsharedDrive", destFolderId: "1XYZarchiveFolder" },
      },
    });
    t.after(() => remote.close?.());
    await assert.rejects(remote.qualificationEvidence!(), {
      code: "unqualified_route",
    });
  },
);

test("archive destination uses real Drive effects without SharePoint mappings or access", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "migmate-archive-drive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobDirectory = await mkdtemp(join(directory, "job-"));
  const graphPath = join(directory, "graph-secret");
  const googlePath = join(directory, "google.json");
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const clientId = "22222222-2222-2222-2222-222222222222";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(graphPath, "Abc8Q~tE1.vN-jK_pLq7zXyW4rS2mD6bH0uT9cVe", { mode: 0o600 });
  await writeFile(
    googlePath,
    JSON.stringify({
      type: "service_account",
      project_id: "migmate-test",
      private_key_id: "a".repeat(40),
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      client_email: "migmate@migmate-test.iam.gserviceaccount.com",
      client_id: "123456789012345678901",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    { mode: 0o600 },
  );
  const destination = { destDriveId: "shared-drive", destFolderId: "archive-root" };
  const timestamp = "2001-02-03T04:05:06.000Z";
  interface StoredFile {
    id: string;
    name: string;
    driveId: string;
    mimeType: string;
    parents: string[];
    createdTime: string;
    modifiedTime: string;
    appProperties?: Record<string, string>;
    headRevisionId?: string;
    size?: string;
    sha256Checksum?: string;
    capabilities?: { canAddChildren: boolean };
  }
  const objects = new Map<string, StoredFile>([
    [
      destination.destFolderId,
      {
        id: destination.destFolderId,
        name: "Archives",
        driveId: destination.destDriveId,
        mimeType: "application/vnd.google-apps.folder",
        parents: [],
        createdTime: timestamp,
        modifiedTime: timestamp,
        capabilities: { canAddChildren: true },
      },
    ],
  ]);
  const contents = new Map<string, Buffer>();
  const uploads = new Map<string, StoredFile>();
  let nextId = 0;
  function store(
    metadata: Partial<StoredFile> & Pick<StoredFile, "id" | "name" | "mimeType" | "parents">,
    content?: Buffer,
  ): StoredFile {
    const file = {
      driveId: destination.destDriveId,
      createdTime: timestamp,
      modifiedTime: timestamp,
      ...metadata,
    };
    if (content !== undefined) {
      file.size = String(content.length);
      file.sha256Checksum = createHash("sha256").update(content).digest("hex");
      file.headRevisionId = `revision-${file.id}`;
      contents.set(file.id, content);
    }
    objects.set(file.id, file);
    return file;
  }
  let sourceAvailable = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "login.microsoftonline.com") {
      assert.ok(sourceAvailable, "archive verification must not authenticate the retired source");
      const claims = {
        tid: tenantId,
        appid: clientId,
        aud: "https://graph.microsoft.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        roles: ["Chat.Read.All"],
      };
      return Response.json({
        access_token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({
        access_token: "archive-google-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    // No Graph API request, including SharePoint drive discovery, is permitted.
    assert.equal(url.hostname, "www.googleapis.com");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer archive-google-token");
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/generateIds"))
      return Response.json({ ids: [`reserved-${++nextId}`] });
    if (url.pathname === "/upload/drive/v3/files") {
      if (url.searchParams.get("uploadType") === "multipart") {
        const body = Buffer.from(await new Response(init?.body).arrayBuffer());
        const boundary = new Headers(init?.headers).get("content-type")!.split("boundary=")[1]!;
        const metadataStart = body.indexOf("\r\n\r\n") + 4;
        const metadataEnd = body.indexOf(`\r\n--${boundary}`, metadataStart);
        const metadata = JSON.parse(body.subarray(metadataStart, metadataEnd).toString());
        const contentStart = body.indexOf("\r\n\r\n", metadataEnd) + 4;
        const contentEnd = body.indexOf(`\r\n--${boundary}--`, contentStart);
        return Response.json(store(metadata, body.subarray(contentStart, contentEnd)));
      }
      const uploadId = url.searchParams.get("upload_id");
      if (uploadId) {
        assert.equal(method, "PUT");
        const metadata = uploads.get(uploadId)!;
        return Response.json(
          store(metadata, Buffer.from(await new Response(init?.body).arrayBuffer())),
        );
      }
      assert.equal(method, "POST");
      assert.equal(url.searchParams.get("uploadType"), "resumable");
      const metadata = JSON.parse(String(init?.body));
      uploads.set(metadata.id, metadata);
      return new Response(null, {
        headers: {
          location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${metadata.id}`,
        },
      });
    }
    if (url.pathname === "/drive/v3/files") {
      if (method === "POST") return Response.json(store(JSON.parse(String(init?.body))));
      assert.equal(url.searchParams.get("driveId"), destination.destDriveId);
      const parent = /^'([^']+)' in parents/.exec(url.searchParams.get("q")!)![1]!;
      return Response.json({
        files: [...objects.values()].filter((file) => file.parents.includes(parent)),
      });
    }
    const id = url.pathname.split("/").at(-1)!;
    const file = objects.get(id);
    if (!file) return new Response(null, { status: 404 });
    if (method === "DELETE") {
      objects.delete(id);
      contents.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH") {
      Object.assign(file, JSON.parse(String(init?.body)));
      return Response.json(file);
    }
    if (url.searchParams.get("alt") === "media") return new Response(contents.get(id)!);
    return Response.json(file);
  });
  const providerInput: Parameters<typeof createProductionProvider>[0] = {
    jobType: "teams_archive",
    jobDirectory,
    config: {
      scopes: [{ kind: "user-chats", userId: "user" }],
      destination,
      graph: { tenantId, clientId },
      secrets: {
        teams_graph_client_secret: { resolver: "file", path: graphPath },
        google_service_account: { resolver: "file", path: googlePath },
      },
      // Prove that remote archives require binary evidence, without launching a fixture worker.
      transferBinary: {
        path: join(directory, "missing-transfer-binary"),
        sha256: "a".repeat(64),
        provenance: "test",
      },
    },
  };
  const provider = createProductionProvider(providerInput);
  t.after(() => provider.close?.());
  const checks = [];
  for await (const check of provider.preflight!(providerInput)) checks.push(check);
  assert.equal(checks.find((check) => check.id === "provider.credentials")?.status, "pass");
  assert.equal(checks.find((check) => check.id === "provider.transfer_binary")?.status, "fail");
  assert.equal(
    checks.find((check) => check.id === "provider.roots.shared-drive.archive-root")?.status,
    "pass",
  );
  assert.equal(checks.find((check) => check.id === "provider.probe.archive-root")?.status, "pass");
  assert.equal(checks.find((check) => check.id === "provider.qualified_route")?.status, "fail");
  assert.deepEqual([...objects.keys()], [destination.destFolderId], "probe objects are cleaned up");
  assert.equal((await provider.resolveDestinationFolder(destination))?.kind, "folder");
  assert.deepEqual(await provider.listDestinationChildren(destination.destFolderId), []);
  await assert.rejects(
    provider.readDestinationObject!({ driveId: "other-drive", objectId: destination.destFolderId }),
    { code: "preflight_failed" },
  );
  const folderId = await provider.reserveDestinationId!();
  await provider.createDestinationFolder({
    destinationId: folderId,
    parentFolderId: destination.destFolderId,
    name: "Teams archive",
    createdAt: timestamp,
    modifiedAt: timestamp,
  });
  const id = await provider.reserveDestinationId!();
  const content = Buffer.from([0, 255, 42, 0, 128]);
  const fingerprint = createHash("sha256").update(content).digest("hex");
  const marker: ProvenanceRecord = {
    mappingId: "archive",
    sourceDriveId: "teams",
    sourceItemId: "chat",
    sourceIdentity: "teams:chat",
    sourceKind: "file",
    sourceRelativePath: "archive.zip",
    sourceFingerprint: fingerprint,
    verifiedFingerprint: null,
    createdAt: timestamp,
    modifiedAt: timestamp,
    mimeType: "application/zip",
  };
  const upload = {
    destinationId: id,
    create: true,
    parentFolderId: folderId,
    name: "archive.zip",
    content,
    createdAt: timestamp,
    modifiedAt: timestamp,
    mimeType: "application/zip",
    marker,
  };
  const uploaded = await provider.uploadDestinationContent(upload);
  assert.equal(uploaded.revision, `revision-${id}:${timestamp}`);
  assert.equal(uploaded.reportedChecksum, fingerprint);
  assert.deepEqual(uploaded.provenance, marker);
  assert.deepEqual(
    (await provider.listDestinationChildren(folderId)).map((file) => file.id),
    [id],
  );
  const verifiedMarker = { ...marker, verifiedFingerprint: fingerprint };
  await provider.writeDestinationMarker({
    objectId: id,
    marker: verifiedMarker,
    expectedRevision: uploaded.revision!,
  });
  assert.deepEqual(await provider.readDestinationMarker(id), verifiedMarker);
  const chunks = [];
  for await (const chunk of provider.streamDestinationContent(id)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), content);
  objects.get(id)!.headRevisionId = "external-edit";
  await assert.rejects(
    provider.uploadDestinationContent({
      ...upload,
      create: false,
      expectedRevision: uploaded.revision!,
    }),
    { code: "prior_copy_drift" },
  );
  assert.equal(
    (await provider.readDestinationObject!({ driveId: destination.destDriveId, objectId: id }))
      ?.revision,
    `external-edit:${timestamp}`,
  );
  assert.deepEqual(contents.get(id), content);
  const identity = await provider.applicationIdentity!();
  sourceAvailable = false;
  await rm(graphPath);
  const retained = createProductionProvider({ ...providerInput, mode: "archive_verification" });
  t.after(() => retained.close?.());
  assert.equal(await retained.applicationIdentity!(), identity);
  assert.deepEqual(await retained.readDestinationMarker(id), verifiedMarker);
  const retainedChunks = [];
  for await (const chunk of retained.streamDestinationContent(id)) retainedChunks.push(chunk);
  assert.deepEqual(Buffer.concat(retainedChunks), content);
});
