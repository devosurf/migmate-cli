import assert from "node:assert/strict";
import { test } from "node:test";
import { DropboxAdapter } from "../src/engine/providers/adapters/dropbox.ts";
import { fileProviderPair } from "../src/engine/providers/adapters/capabilities.ts";
import type { CredentialSession } from "../src/engine/providers/credentials.ts";
import { parseManifest } from "../src/engine/manifest.ts";
import { ProviderFault } from "../src/engine/providers/fault.ts";

const session: CredentialSession = {
  async graphToken() {
    throw new Error("Graph must not authenticate");
  },
  async graphDestinationToken() {
    throw new Error("Graph must not authenticate");
  },
  async googleToken() {
    throw new Error("Google must not authenticate");
  },
  async dropboxToken() {
    return "dropbox-access-canary";
  },
  async identity() {
    return "dropbox-app";
  },
  async evidence() {
    return {};
  },
  rcloneConfigPath: null,
  sourceRemote: null,
  destinationRemote: null,
  dropboxRemote: "dropboxSource",
  dropboxAdminId: "dbmid:admin",
  dispose() {},
};
function adapter() {
  return new DropboxAdapter({
    session,
    mappings: [{ sourceDriveId: "123", sourceItemId: "/" }],
    destinationRoots: [],
    graph: {
      async request<T>(): Promise<T> {
        throw new Error("Graph must not be called");
      },
      async *stream() {
        throw new Error("Graph must not be called");
      },
      evidence: session.evidence,
    },
    worker: { read: () => null },
  });
}

const namespace = {
  namespace_id: "123",
  name: "Team folder",
  namespace_type: { ".tag": "team_folder" },
};
const manifest = {
  version: 1,
  mappings: [
    {
      id: "team",
      source: { type: "dropbox", namespaceId: "123", folderPath: "" },
      destination: { type: "google_shared_drive", create: "Migrated team" },
    },
  ],
};

test("Dropbox manifest uses namespace identity and only the shipped destination", () => {
  const parsed = parseManifest(JSON.stringify(manifest), "json");
  assert.deepEqual(parsed.mappings[0]?.source, { type: "dropbox", driveId: "123", folderPath: "" });
  for (const destinationProvider of ["dropbox", "sharepoint"]) {
    assert.throws(
      () => fileProviderPair({ sourceProvider: "dropbox", destinationProvider }),
      (error: unknown) => error instanceof ProviderFault && error.code === "unsupported_route",
    );
  }
  assert.throws(() =>
    parseManifest(
      JSON.stringify({
        ...manifest,
        mappings: [
          { ...manifest.mappings[0], source: { type: "dropbox", driveId: "123", folderPath: "" } },
        ],
      }),
      "json",
    ),
  );
});

test("Dropbox namespace pagination deduplicates IDs and never visits member mounts", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("team/namespaces/list"))
      return Response.json({ namespaces: [namespace], has_more: true, cursor: "next" });
    if (url.endsWith("team/namespaces/list/continue")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { cursor: "next" });
      return Response.json({
        namespaces: [{ ...namespace, name: "Mounted alias" }],
        has_more: false,
        cursor: "done",
      });
    }
    throw new Error(`Unexpected endpoint ${url}`);
  });
  const source = adapter();
  const root = await source.resolveSourceFolder({ driveId: "123", folderPath: "" });
  assert.equal(root?.id, "/");
  assert.equal(root?.identity, "123:/");
  const pass = await source.resolveSourcePass({
    sourceDriveId: "123",
    sourceItemId: "/",
    destDriveId: "drive",
    destFolderId: "drive",
  });
  assert.match(pass.fs, /root_namespace='123'/);
  assert.match(pass.fs, /impersonate_admin='dbmid:admin'/);
  assert.match(pass.fs, /export_formats=html/);
  assert.doesNotMatch(pass.fs, /shared_folders/);
  assert.equal(calls.length, 2);
});

test("Dropbox rejects personal namespaces even with a readable team grant", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      namespaces: [{ ...namespace, namespace_type: { ".tag": "team_member_folder" } }],
      has_more: false,
    }),
  );
  await assert.rejects(
    adapter().resolveSourceFolder({ driveId: "123", folderPath: "" }),
    (error: unknown) => error instanceof ProviderFault && error.code === "unsupported_route",
  );
});

test("Dropbox listing keeps unsupported exports visible and labels exported HTML and web pointers", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("team/namespaces/list"))
      return Response.json({ namespaces: [namespace], has_more: false });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Dropbox-API-Select-Admin"), "dbmid:admin");
    assert.deepEqual(JSON.parse(headers.get("Dropbox-API-Path-Root")!), {
      ".tag": "namespace_id",
      namespace_id: "123",
    });
    assert.deepEqual(JSON.parse(String(init?.body)), {
      path: "",
      recursive: false,
      include_deleted: false,
      include_non_downloadable_files: true,
      include_mounted_folders: false,
      limit: 1000,
    });
    return Response.json({
      entries: [
        {
          ".tag": "file",
          id: "id:paper",
          name: "Notes.paper",
          path_display: "/Notes.paper",
          is_downloadable: false,
          export_info: { export_as: "html" },
        },
        {
          ".tag": "file",
          id: "id:unsupported",
          name: "Drawing.cloud",
          path_display: "/Drawing.cloud",
          is_downloadable: false,
          export_info: { export_as: "pdf" },
        },
        {
          ".tag": "file",
          id: "id:noexport",
          name: "Unavailable.paper",
          path_display: "/Unavailable.paper",
          is_downloadable: false,
        },
        {
          ".tag": "file",
          id: "id:web",
          name: "Budget.web",
          path_display: "/Budget.web",
          is_downloadable: true,
          size: 12,
        },
      ],
      has_more: false,
    });
  });
  const entries = await adapter().listSourceChildren({ driveId: "123", itemId: "/" });
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.kind, entry.metadata?.contentDisposition]),
    [
      ["Notes.html", "file", "paper_html"],
      ["Drawing.cloud", "undownloadable", "unsupported_export"],
      ["Unavailable.paper", "undownloadable", "unsupported_export"],
      ["Budget.web", "file", "web_pointer"],
    ],
  );
});

test("Dropbox exports HTML bytes by immutable item identity", async (t) => {
  const html = "<html>Notes</html>";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("team/namespaces/list"))
      return Response.json({ namespaces: [namespace], has_more: false });
    if (url.endsWith("files/get_metadata"))
      return Response.json({
        ".tag": "file",
        id: "id:paper",
        name: "Notes.paper",
        path_display: "/Notes.paper",
        is_downloadable: false,
        export_info: { export_as: "html" },
      });
    assert.equal(url, "https://content.dropboxapi.com/2/files/export");
    assert.deepEqual(JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg")!), {
      path: "id:paper",
      export_format: "html",
    });
    return new Response(html);
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of adapter().openSourceContent({ driveId: "123", itemId: "id:paper" }))
    chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), html);
});

for (const enabled of [true, false, null]) {
  test(`Paper creation-model evidence ${enabled} becomes a nonblocking planning observation`, async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(String(input), "https://api.dropboxapi.com/2/users/features/get_values");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("Dropbox-API-Select-User"), "dbmid:admin");
        assert.equal(headers.has("Dropbox-API-Select-Admin"), false);
        assert.deepEqual(JSON.parse(String(init?.body)), {
          features: [{ ".tag": "paper_as_files" }],
        });
        return enabled === null
          ? new Response("", { status: 403 })
          : Response.json({
              values: [
                { ".tag": "paper_as_files", paper_as_files: { ".tag": "enabled", enabled } },
              ],
            });
      },
    );
    const observation = await adapter().sourcePlanningEvidence();
    assert.deepEqual(observation.evidence, {
      paperAsFiles: enabled,
      selectedAdminId: "dbmid:admin",
    });
    assert.equal(observation.notices.length, enabled === true ? 0 : 1);
    if (enabled === false) {
      assert.match(observation.notices[0]!, /legacy Paper/i);
      assert.match(observation.notices[0]!, /outside.*namespaces/i);
      assert.match(observation.notices[0]!, /not.*migrat/i);
    } else if (enabled === null) {
      assert.match(observation.notices[0]!, /could not.*check/i);
    }
  });
}
