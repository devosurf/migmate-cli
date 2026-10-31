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
          id: "id:ordinary",
          name: "Notes.html",
          path_display: "/Notes.html",
          is_downloadable: true,
          size: 12,
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
      ["Notes.html", "file", undefined],
      ["Drawing.cloud", "undownloadable", "unsupported_export"],
      ["Unavailable.paper", "undownloadable", "unsupported_export"],
      ["Budget.web", "file", "web_pointer"],
    ],
  );
  assert.deepEqual(
    entries.slice(0, 2).map((entry) => entry.id),
    ["id:paper", "id:ordinary"],
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

test("Dropbox pinned export fallback downloads Markdown by immutable item identity", async (t) => {
  const calls: { url: string; argument: unknown }[] = [];
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
        export_info: { export_as: "markdown" },
      });
    calls.push({
      url,
      argument: JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg")!),
    });
    return new Response("# Notes");
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of adapter().openSourceContent({ driveId: "123", itemId: "id:paper" }))
    chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "# Notes");
  assert.deepEqual(calls, [
    {
      url: "https://content.dropboxapi.com/2/files/export",
      argument: { path: "id:paper", export_format: "markdown" },
    },
  ]);
});

// rclone v1.75.0 backend/dropbox: chooseExportFormat and setMetadataForExport.
const exportCases: {
  label: string;
  name: string;
  info?: { export_as?: string; export_options?: string[] };
  format: "html" | "markdown" | null;
  exportedName: string;
  downloadable?: boolean;
}[] = [
  {
    label: "Markdown-only Paper",
    name: "Notes.paper",
    info: { export_as: "markdown" },
    format: "markdown",
    exportedName: "Notes.md",
  },
  {
    label: "HTML preference overrides the Dropbox preferred Markdown format",
    name: "Notes.paper",
    info: { export_as: "markdown", export_options: ["html"] },
    format: "html",
    exportedName: "Notes.html",
  },
  {
    label: "HTML in export_as need not be repeated in export_options",
    name: "Notes.paper",
    info: { export_as: "html", export_options: ["markdown"] },
    format: "html",
    exportedName: "Notes.html",
  },
  {
    label: "unknown preferred format falls back to a recognized option",
    name: "Notes.paper",
    info: { export_as: "pdf", export_options: ["docx", "markdown"] },
    format: "markdown",
    exportedName: "Notes.md",
  },
  {
    label: "missing preferred format uses export_options",
    name: "Notes.paper",
    info: { export_options: ["markdown"] },
    format: "markdown",
    exportedName: "Notes.md",
  },
  {
    label: "format recognition is case-sensitive",
    name: "Notes.paper",
    info: { export_as: "HTML", export_options: ["Markdown", "markdown"] },
    format: "markdown",
    exportedName: "Notes.md",
  },
  {
    label: "only one terminal Paper suffix is removed",
    name: "Notes.paper.paper",
    info: { export_as: "markdown" },
    format: "markdown",
    exportedName: "Notes.paper.md",
  },
  {
    label: "uppercase Paper suffix is preserved",
    name: "Notes.PAPER",
    info: { export_as: "html" },
    format: "html",
    exportedName: "Notes.PAPER.html",
  },
  {
    label: "Paper template suffix is preserved",
    name: "Notes.papert",
    info: { export_as: "markdown" },
    format: "markdown",
    exportedName: "Notes.papert.md",
  },
  {
    label: "existing export extension is not stripped",
    name: "Notes.md",
    info: { export_as: "markdown" },
    format: "markdown",
    exportedName: "Notes.md.md",
  },
  {
    label: "extensionless name receives an export suffix",
    name: "Notes",
    info: { export_as: "markdown" },
    format: "markdown",
    exportedName: "Notes.md",
  },
  {
    label: "unknown-only export formats are unsupported",
    name: "Drawing.cloud",
    info: { export_as: "pdf", export_options: ["docx", "unknown"] },
    format: null,
    exportedName: "Drawing.cloud",
  },
  {
    label: "uppercase-only export formats are unsupported",
    name: "Notes.paper",
    info: { export_as: "HTML", export_options: ["MARKDOWN"] },
    format: null,
    exportedName: "Notes.paper",
  },
  {
    label: "empty export info is unsupported",
    name: "Notes.paper",
    info: {},
    format: null,
    exportedName: "Notes.paper",
  },
  {
    label: "absent export info is unsupported",
    name: "Notes.paper",
    format: null,
    exportedName: "Notes.paper",
  },
  {
    label: "downloadable file ignores advertised export formats",
    name: "Notes.paper",
    info: { export_as: "markdown", export_options: ["html"] },
    format: null,
    exportedName: "Notes.paper",
    downloadable: true,
  },
];

for (const fixture of exportCases) {
  test(`Dropbox pinned export inventory and content: ${fixture.label}`, async (t) => {
    const raw = {
      ".tag": "file",
      id: "id:export",
      name: fixture.name,
      path_display: `/${fixture.name}`,
      is_downloadable: fixture.downloadable ?? false,
      size: 100,
      ...(fixture.info ? { export_info: fixture.info } : {}),
    };
    const contentCalls: { url: string; argument: unknown }[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("team/namespaces/list"))
          return Response.json({ namespaces: [namespace], has_more: false });
        if (url.endsWith("files/list_folder"))
          return Response.json({ entries: [raw], has_more: false });
        if (url.endsWith("files/get_metadata")) return Response.json(raw);
        contentCalls.push({
          url,
          argument: JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg")!),
        });
        return new Response("exported bytes");
      },
    );
    const source = adapter();
    const entries = await source.listSourceChildren({ driveId: "123", itemId: "/" });
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.name, fixture.exportedName);
    assert.equal(entry.id, "id:export");
    assert.equal(entry.metadata?.originalName, fixture.name);
    assert.equal(entry.metadata?.path, `/${fixture.name}`);
    assert.equal(entry.metadata?.exportFormat, fixture.format ?? undefined);
    assert.equal(
      entry.metadata?.contentDisposition,
      fixture.format === "html"
        ? "paper_html"
        : fixture.format === "markdown"
          ? "document_export"
          : fixture.downloadable
            ? undefined
            : "unsupported_export",
    );
    assert.equal(entry.kind, fixture.format || fixture.downloadable ? "file" : "undownloadable");
    assert.equal(entry.downloadable, !!(fixture.format || fixture.downloadable));
    assert.equal(entry.size, fixture.downloadable ? 100 : null);
    assert.equal(
      entry.mimeType,
      fixture.format === "html"
        ? "text/html"
        : fixture.format === "markdown"
          ? "text/markdown"
          : null,
    );
    assert.deepEqual(await source.readSourceItem({ driveId: "123", itemId: "id:export" }), entry);
    const download = async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of source.openSourceContent({ driveId: "123", itemId: "id:export" }))
        chunks.push(chunk);
      return Buffer.concat(chunks).toString();
    };
    if (!fixture.format && !fixture.downloadable) {
      await assert.rejects(
        download(),
        (error: unknown) => error instanceof ProviderFault && error.code === "source_read_failed",
      );
      assert.deepEqual(contentCalls, []);
    } else {
      assert.equal(await download(), "exported bytes");
      assert.deepEqual(contentCalls, [
        {
          url: `https://content.dropboxapi.com/2/files/${fixture.format ? "export" : "download"}`,
          argument: {
            path: "id:export",
            ...(fixture.format ? { export_format: fixture.format } : {}),
          },
        },
      ]);
    }
  });
}

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
