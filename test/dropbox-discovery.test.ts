import assert from "node:assert/strict";
import { test } from "node:test";
import { DropboxAdapter } from "../src/engine/providers/adapters/dropbox.ts";
import type { CredentialSession } from "../src/engine/providers/credentials.ts";
import { ProviderFault } from "../src/engine/providers/fault.ts";

const SCOPES = [
  "account_info.read",
  "files.content.read",
  "files.metadata.read",
  "sharing.read",
  "team_data.member",
];

function adapter(grantedScopes: string[] = SCOPES) {
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
      return { dropbox: { adminId: "dbmid:admin", grantedScopes } };
    },
    rcloneConfigPath: null,
    sourceRemote: null,
    destinationRemote: null,
    dropboxRemote: "dropboxSource",
    dropboxAdminId: "dbmid:admin",
    dispose() {},
  };
  // Discovery runs before any mapping exists.
  return new DropboxAdapter({
    session,
    mappings: [],
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

interface Call {
  endpoint: string;
  body: Record<string, unknown>;
  headers: Headers;
}
type Route = (call: Call) => Response | undefined;

/** Routes by endpoint and the namespace path root, recording every call. */
function serve(t: { mock: { method: Function } }, route: Route): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.host, "api.dropboxapi.com");
    assert.equal(init?.method, "POST");
    const call = {
      endpoint: url.pathname.replace(/^\/2\//u, ""),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const response = route(call);
    if (!response) throw new Error(`Unexpected call ${call.endpoint}`);
    return response;
  });
  return calls;
}

function pathRoot(call: Call): string | undefined {
  const header = call.headers.get("Dropbox-API-Path-Root");
  return header ? (JSON.parse(header) as { namespace_id: string }).namespace_id : undefined;
}

const folder = (path: string, shared?: string) => ({
  ".tag": "folder",
  id: `id:${path}`,
  name: path.slice(path.lastIndexOf("/") + 1),
  path_lower: path.toLowerCase(),
  path_display: path,
  ...(shared ? { sharing_info: { read_only: false, shared_folder_id: shared } } : {}),
});
const file = (path: string) => ({
  ".tag": "file",
  id: `id:${path}`,
  name: path.slice(path.lastIndexOf("/") + 1),
  path_lower: path.toLowerCase(),
  path_display: path,
  size: 1,
});
const conflict = (summary: string) =>
  Response.json({ error_summary: summary, error: {} }, { status: 409 });

test("Dropbox discovery counts each shared namespace once, splits nested mounts and reads membership", async (t) => {
  const calls = serve(t, (call) => {
    switch (call.endpoint) {
      case "team/namespaces/list":
        return Response.json({
          namespaces: [
            { namespace_id: "200", name: "Sales", namespace_type: { ".tag": "team_folder" } },
            { namespace_id: "300", name: "Deals", namespace_type: { ".tag": "shared_folder" } },
            { namespace_id: "900", name: "Ann", namespace_type: { ".tag": "team_member_folder" } },
          ],
          has_more: true,
          cursor: "ns-1",
        });
      case "team/namespaces/list/continue":
        assert.deepEqual(call.body, { cursor: "ns-1" });
        return Response.json({
          // A namespace listed again (another mount) counts once.
          namespaces: [
            {
              namespace_id: "300",
              name: "Deals alias",
              namespace_type: { ".tag": "shared_folder" },
            },
            { namespace_id: "901", name: "App", namespace_type: { ".tag": "app_folder" } },
            { namespace_id: "902", name: "Bo", namespace_type: { ".tag": "team_member_root" } },
            { namespace_id: "100", name: "Board", namespace_type: { ".tag": "shared_folder" } },
          ],
          has_more: false,
          cursor: "ns-2",
        });
      case "files/list_folder": {
        assert.equal(call.headers.get("Dropbox-API-Select-Admin"), "dbmid:admin");
        assert.equal(call.body.recursive, true);
        assert.equal(call.body.path, "");
        assert.equal(call.body.include_mounted_folders, false);
        assert.equal(call.body.include_non_downloadable_files, true);
        const namespace = pathRoot(call);
        if (namespace === "200")
          return Response.json({
            entries: [
              file("/Readme.txt"),
              folder("/Plans"),
              file("/Plans/q1.paper"),
              folder("/Plans/Deals", "300"),
              folder("/Plans/Old"),
            ],
            has_more: true,
            cursor: "tree-200",
          });
        if (namespace === "300")
          return Response.json({
            entries: [file("/a.pdf"), file("/b.pdf"), { ".tag": "deleted", name: "gone" }],
            has_more: false,
            cursor: "tree-300",
          });
        if (namespace === "100")
          return Response.json({ entries: [], has_more: false, cursor: "x" });
        return undefined;
      }
      case "files/list_folder/continue":
        assert.equal(pathRoot(call), "200");
        assert.deepEqual(call.body, { cursor: "tree-200" });
        return Response.json({
          entries: [
            // Content below a mount is the nested namespace's, even when it is listed.
            file("/Plans/Deals/a.pdf"),
            folder("/Plans/Deals/Inner"),
            // A child before its parent folder's own entry.
            file("/Archive/2019/x.csv"),
            file("/Archive/2019/y.csv"),
            folder("/Archive/2019"),
            folder("/Archive"),
            file("/Plans/q2.paper"),
          ],
          has_more: false,
          cursor: "tree-200b",
        });
      case "sharing/list_folder_members":
        assert.equal(call.headers.get("Dropbox-API-Select-Admin"), "dbmid:admin");
        assert.equal(call.headers.get("Dropbox-API-Path-Root"), null);
        if (call.body.shared_folder_id === "200")
          return Response.json({
            users: [
              {
                access_type: { ".tag": "owner" },
                user: { account_id: "dbid:z", email: "Zed@Example.com", team_member_id: "dbmid:z" },
              },
            ],
            groups: [{ access_type: { ".tag": "editor" }, group: { group_id: "g:sales" } }],
            invitees: [],
            cursor: "members-200",
          });
        if (call.body.shared_folder_id === "300")
          return Response.json({
            users: [
              {
                access_type: { ".tag": "editor" },
                user: { account_id: "dbid:a", email: "amy@example.com" },
              },
            ],
            groups: [],
            invitees: [],
          });
        if (call.body.shared_folder_id === "100") return conflict("not_a_member/..");
        return undefined;
      case "sharing/list_folder_members/continue":
        assert.deepEqual(call.body, { cursor: "members-200" });
        return Response.json({
          users: [
            {
              access_type: { ".tag": "viewer" },
              user: { account_id: "dbid:b", email: "bea@example.com" },
            },
          ],
          groups: [],
          invitees: [
            {
              access_type: { ".tag": "viewer" },
              invitee: { ".tag": "email", email: "New@Example.com" },
            },
          ],
        });
    }
    return undefined;
  });

  const discovery = await adapter().discoverSource();
  assert.equal(discovery.sourceProvider, "dropbox");
  assert.ok(!Number.isNaN(Date.parse(discovery.observedAt)));
  assert.deepEqual(discovery.boundaries, [
    {
      id: "100",
      kind: "dropbox_shared_folder",
      name: "Board",
      root: { type: "dropbox", driveId: "100", folderPath: "" },
      members: null,
      tree: { name: "", files: 0, folders: [] },
    },
    {
      id: "200",
      kind: "dropbox_team_folder",
      name: "Sales",
      root: { type: "dropbox", driveId: "200", folderPath: "" },
      members: [
        { id: "g:sales", type: "group", role: "editor" },
        { id: "bea@example.com", type: "user", role: "viewer" },
        { id: "new@example.com", type: "user", role: "viewer" },
        { id: "zed@example.com", type: "user", role: "owner" },
      ],
      tree: {
        name: "",
        files: 1,
        folders: [
          {
            name: "Archive",
            files: 0,
            folders: [{ name: "2019", files: 2, folders: [] }],
          },
          {
            name: "Plans",
            files: 2,
            folders: [{ name: "Old", files: 0, folders: [] }],
            nested: ["300"],
          },
        ],
      },
    },
    {
      id: "300",
      kind: "dropbox_shared_folder",
      name: "Deals",
      root: { type: "dropbox", driveId: "300", folderPath: "" },
      parent: "200",
      members: [{ id: "amy@example.com", type: "user", role: "editor" }],
      tree: { name: "", files: 2, folders: [] },
    },
  ]);
  assert.deepEqual(discovery.notices, [
    "3 personal Dropbox namespaces were skipped (member folders and app folders); personal storage is out of scope.",
    "Membership of 1 Dropbox namespace could not be read; it shares no container: 100.",
  ]);
  // Strictly read-only: listing and membership routes only, no personal namespace read.
  assert.deepEqual([...new Set(calls.map((call) => call.endpoint))].sort(), [
    "files/list_folder",
    "files/list_folder/continue",
    "sharing/list_folder_members",
    "sharing/list_folder_members/continue",
    "team/namespaces/list",
    "team/namespaces/list/continue",
  ]);
  assert.ok(calls.every((call) => !["900", "901", "902"].includes(pathRoot(call) ?? "")));
  assert.ok(
    calls
      .filter((call) => call.endpoint.startsWith("team/"))
      .every((call) => call.headers.get("Dropbox-API-Select-Admin") === null),
  );
});

test("Dropbox discovery splits around mounts of namespaces it cannot name", async (t) => {
  serve(t, (call) => {
    if (call.endpoint === "team/namespaces/list")
      return Response.json({
        namespaces: [
          { namespace_id: "200", name: "Sales", namespace_type: { ".tag": "team_folder" } },
        ],
        has_more: false,
      });
    if (call.endpoint === "files/list_folder")
      return Response.json({
        entries: [folder("/Partner", "777"), file("/Partner/p.txt"), file("/top.txt")],
        has_more: false,
      });
    if (call.endpoint === "sharing/list_folder_members")
      return Response.json({ users: [], groups: [], invitees: [] });
    return undefined;
  });
  const discovery = await adapter().discoverSource();
  // Still nested, so the parent never maps whole over the mount.
  assert.deepEqual(discovery.boundaries[0]?.tree, {
    name: "",
    files: 1,
    folders: [],
    nested: ["777"],
  });
  assert.equal(discovery.boundaries[0]?.parent, undefined);
  assert.deepEqual(discovery.notices, [
    "1 mounted folder belongs to namespaces outside this discovery and is left out of the counts and the draft; map them by hand if they belong in this migration: 777.",
  ]);
});

test("Dropbox discovery refuses a grant without sharing.read before any request", async (t) => {
  const calls = serve(t, () => undefined);
  await assert.rejects(
    adapter(SCOPES.filter((scope) => scope !== "sharing.read")).discoverSource(),
    (error: unknown) =>
      error instanceof ProviderFault &&
      error.code === "preflight_failed" &&
      error.evidence.check === "discovery_requires_sharing_read",
  );
  assert.equal(calls.length, 0);
});

test("Dropbox discovery names a refused request instead of skipping it", async (t) => {
  serve(t, (call) => {
    if (call.endpoint === "team/namespaces/list")
      return Response.json({
        namespaces: [
          { namespace_id: "200", name: "Sales", namespace_type: { ".tag": "team_folder" } },
        ],
        has_more: false,
      });
    if (call.endpoint === "files/list_folder")
      return Response.json(
        { error_summary: "missing_scope/..", error: { ".tag": "missing_scope" } },
        { status: 401 },
      );
    return undefined;
  });
  await assert.rejects(adapter().discoverSource(), (error: unknown) => {
    assert.ok(error instanceof ProviderFault);
    assert.equal(error.code, "preflight_failed");
    assert.deepEqual(error.evidence, {
      status: 401,
      providerCode: "missing_scope",
      host: "api.dropboxapi.com",
      namespaceId: "200",
      route: "files/list_folder",
      check: "discovery_request_failed",
    });
    return true;
  });
});

test("Dropbox discovery reports a namespace the administrator cannot list", async (t) => {
  serve(t, (call) => {
    if (call.endpoint === "team/namespaces/list")
      return Response.json({
        namespaces: [
          { namespace_id: "200", name: "Ext", namespace_type: { ".tag": "shared_folder" } },
        ],
        has_more: false,
      });
    if (call.endpoint === "files/list_folder") return conflict("path/restricted_content/..");
    return undefined;
  });
  const discovery = await adapter().discoverSource();
  assert.deepEqual(discovery.boundaries, []);
  assert.deepEqual(discovery.notices, [
    "The selected administrator could not list 1 Dropbox namespace, left out of discovery: 200.",
  ]);
});

test("Dropbox discovery retries throttled pages and refuses a repeated cursor", async (t) => {
  let throttled = 0;
  serve(t, (call) => {
    if (call.endpoint === "team/namespaces/list") {
      if (throttled++ < 2)
        return Response.json(
          { error_summary: "too_many_requests/.." },
          { status: 429, headers: { "retry-after": "0" } },
        );
      return Response.json({ namespaces: [], has_more: true, cursor: "same" });
    }
    if (call.endpoint === "team/namespaces/list/continue")
      return Response.json({ namespaces: [], has_more: true, cursor: "same" });
    return undefined;
  });
  await assert.rejects(
    adapter().discoverSource(),
    (error: unknown) =>
      error instanceof ProviderFault &&
      error.evidence.check === "discovery_response_invalid" &&
      error.evidence.route === "team/namespaces/list/continue",
  );
  assert.equal(throttled, 3);
});

test("Dropbox discovery stops when aborted", async (t) => {
  const controller = new AbortController();
  serve(t, (call) => {
    if (call.endpoint === "team/namespaces/list") {
      controller.abort();
      return Response.json({
        namespaces: [
          { namespace_id: "200", name: "Sales", namespace_type: { ".tag": "team_folder" } },
        ],
        has_more: false,
      });
    }
    return undefined;
  });
  await assert.rejects(adapter().discoverSource(controller.signal), { name: "AbortError" });
});
