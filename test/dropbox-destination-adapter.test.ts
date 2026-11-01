import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DropboxAdapter } from "../src/engine/providers/adapters/dropbox.ts";
import { fileProviderPair } from "../src/engine/providers/adapters/capabilities.ts";
import type { CredentialSession } from "../src/engine/providers/credentials.ts";
import { ProviderFault } from "../src/engine/providers/fault.ts";
import type { FileContext } from "../src/engine/drivers/file-state.ts";

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
    throw new Error("The read-only source app must never write");
  },
  async dropboxDestinationToken() {
    return "dropbox-write-canary";
  },
  async identity() {
    return "dropbox-write-app";
  },
  async evidence() {
    return {};
  },
  rcloneConfigPath: null,
  sourceRemote: null,
  destinationRemote: null,
  dropboxDestinationRemote: "dropboxDestination",
  dropboxDestinationAdminId: "dbmid:writer",
  dispose() {},
};

function adapter() {
  return new DropboxAdapter({
    session,
    mappings: [{ sourceDriveId: "google-drive", destDriveId: "555", destFolderId: "ns:555" }],
    destinationRoots: [{ destDriveId: "555", destFolderId: "ns:555" }],
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
  body: unknown;
  headers: Headers;
}

function serve(
  t: TestContext,
  routes: Record<string, (body: Record<string, unknown>) => Response>,
): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const endpoint = new URL(String(input)).pathname.replace(/^\/2\//, "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ endpoint, body, headers: new Headers(init?.headers) });
    const route = routes[endpoint];
    if (!route) throw new Error(`unexpected ${endpoint}`);
    return route(body);
  });
  return calls;
}

const error = (status: number, summary: string) =>
  Response.json({ error_summary: summary, error: {} }, { status });
const teamFolders = {
  namespaces: [{ namespace_id: "555", name: "Finance", namespace_type: { ".tag": "team_folder" } }],
  has_more: false,
  cursor: "c",
};

test("Dropbox team-folder creation uses only the write app and returns the namespace root", async (t) => {
  const calls = serve(t, {
    "team/team_folder/create": () =>
      Response.json({ team_folder_id: "555", name: "Finance", status: { ".tag": "active" } }),
  });
  const created = await adapter().createDestinationContainer({ name: "Finance", requestId: "r" });
  assert.deepEqual(created, { id: "555", name: "Finance", rootFolderId: "ns:555" });
  assert.deepEqual(calls[0]?.body, { name: "Finance" });
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer dropbox-write-canary");
  // Team endpoints take the team token itself, never an admin selection.
  assert.equal(calls[0]?.headers.get("dropbox-api-select-admin"), null);
  assert.equal(await adapter().destinationCreator(), "");
});

test("Dropbox name conflicts return no container; team-space refusals stay visible", async (t) => {
  let summary = "folder_name_already_used/..";
  serve(t, { "team/team_folder/create": () => error(409, summary) });
  assert.equal(
    await adapter().createDestinationContainer({ name: "Finance", requestId: "r" }),
    null,
  );
  summary = "team_shared_dropbox_error/disallowed/";
  await assert.rejects(
    adapter().createDestinationContainer({ name: "Finance", requestId: "r" }),
    (fault: unknown) =>
      fault instanceof ProviderFault && fault.evidence.check === "dropbox_team_space_unfenced",
  );
});

test("Dropbox creation refuses team-space teams and unknown team models", async (t) => {
  let shared: boolean | undefined = true;
  const calls = serve(t, {
    "team/features/get_values": () =>
      Response.json({
        values: [
          {
            ".tag": "has_team_shared_dropbox",
            has_team_shared_dropbox:
              shared === undefined
                ? { ".tag": "other" }
                : { ".tag": "has_team_shared_dropbox", has_team_shared_dropbox: shared },
          },
          { ".tag": "upload_api_rate_limit", upload_api_rate_limit: { ".tag": "unlimited" } },
        ],
      }),
  });
  for (const value of [true, undefined]) {
    shared = value;
    await assert.rejects(
      adapter().validateDestinationCreation({ members: [] }),
      (fault: unknown) =>
        fault instanceof ProviderFault && fault.evidence.check === "dropbox_team_space_unfenced",
    );
  }
  shared = false;
  await adapter().validateDestinationCreation({ members: [] });
  assert.deepEqual(calls[0]?.body, {
    features: [{ ".tag": "has_team_shared_dropbox" }, { ".tag": "upload_api_rate_limit" }],
  });
});

test("Dropbox recovery lists team folders by case-insensitive name across pages", async (t) => {
  serve(t, {
    "team/team_folder/list": () =>
      Response.json({
        team_folders: [{ team_folder_id: "1", name: "Other" }],
        has_more: true,
        cursor: "next",
      }),
    "team/team_folder/list/continue": (body) => {
      assert.deepEqual(body, { cursor: "next" });
      return Response.json({
        team_folders: [{ team_folder_id: "555", name: "FINANCE", status: { ".tag": "archived" } }],
        has_more: false,
        cursor: "done",
      });
    },
  });
  assert.deepEqual(await adapter().findDestinationContainers({ name: "Finance" }), [
    { id: "555", name: "FINANCE", rootFolderId: "ns:555" },
  ]);
});

test("Dropbox membership reads groups, users and invitees, and grants groups only", async (t) => {
  const calls = serve(t, {
    "team/namespaces/list": () => Response.json(teamFolders),
    "sharing/list_folder_members": () =>
      Response.json({
        groups: [{ access_type: { ".tag": "editor" }, group: { group_id: "g:ABC" } }],
        users: [
          { access_type: { ".tag": "owner" }, user: { account_id: "dbid:1", email: "A@x.test" } },
        ],
        invitees: [
          { access_type: { ".tag": "viewer" }, invitee: { ".tag": "email", email: "b@x.test" } },
        ],
        cursor: "more",
      }),
    "sharing/list_folder_members/continue": () => Response.json({ groups: [] }),
    "sharing/add_folder_member": () => Response.json(null),
  });
  const dropbox = adapter();
  assert.deepEqual(await dropbox.listDriveMembers("555"), [
    { email: "g:abc", type: "group", role: "editor" },
    { email: "a@x.test", type: "user", role: "owner" },
    { email: "b@x.test", type: "invitee", role: "viewer" },
  ]);
  await dropbox.addDriveMember("555", { email: "g:abc", type: "group", role: "viewer" });
  const add = calls.find((call) => call.endpoint === "sharing/add_folder_member")!;
  assert.deepEqual(add.body, {
    shared_folder_id: "555",
    members: [
      { member: { ".tag": "dropbox_id", dropbox_id: "g:abc" }, access_level: { ".tag": "viewer" } },
    ],
    quiet: true,
  });
  assert.equal(add.headers.get("dropbox-api-select-admin"), "dbmid:writer");
  for (const member of [
    { email: "a@x.test", type: "user", role: "editor" },
    { email: "g:abc", type: "group", role: "owner" },
  ] as const)
    await assert.rejects(
      dropbox.addDriveMember("555", member),
      (fault: unknown) =>
        fault instanceof ProviderFault && fault.code === "unsupported_member_role",
    );
});

test("Dropbox destinations refuse member homes and shared folders", async (t) => {
  serve(t, {
    "team/namespaces/list": () =>
      Response.json({
        namespaces: [
          { namespace_id: "555", name: "Home", namespace_type: { ".tag": "team_member_folder" } },
        ],
        has_more: false,
        cursor: "c",
      }),
  });
  await assert.rejects(
    adapter().resolveDestinationPath({ driveId: "555", folderPath: "" }),
    (fault: unknown) => fault instanceof ProviderFault && fault.code === "unsupported_route",
  );
});

test("Dropbox destination passes pin namespace, admin, sync batching and encoding", async (t) => {
  const calls = serve(t, {
    "team/namespaces/list": () => Response.json(teamFolders),
    "files/get_metadata": () =>
      Response.json({
        ".tag": "folder",
        id: "id:abc",
        name: "Q1␠",
        path_display: "/Reports/Q1␠",
      }),
  });
  const dropbox = adapter();
  const root = await dropbox.resolveDestinationPass({
    sourceDriveId: "google-drive",
    sourceItemId: "root",
    destDriveId: "555",
    destFolderId: "ns:555",
  });
  assert.deepEqual(root, {
    fs: "dropboxDestination,root_namespace='555',impersonate_admin='dbmid:writer',batch_mode=sync,encoding='Slash,BackSlash,Del,Ctl,RightSpace,InvalidUtf8,Dot':",
    kind: "dropbox",
  });
  const nested = await dropbox.resolveDestinationPass({
    sourceDriveId: "google-drive",
    sourceItemId: "root",
    destDriveId: "555",
    destFolderId: "id:abc",
  });
  // rclone's native ␠ for a trailing space reads back as its standard name.
  assert.match(nested.fs, /:Reports\/Q1 $/u);
  const metadata = calls.find((call) => call.endpoint === "files/get_metadata")!;
  assert.equal(
    metadata.headers.get("dropbox-api-path-root"),
    JSON.stringify({ ".tag": "namespace_id", namespace_id: "555" }),
  );
  assert.equal(metadata.headers.get("dropbox-api-select-admin"), "dbmid:writer");
});

test("Dropbox's monthly limit is recognised only by its error tag and resumes on the 1st", () => {
  const destination = fileProviderPair({
    sourceProvider: "google_shared_drive",
    destinationProvider: "dropbox",
  }).destination;
  const ctx = { now: () => new Date("2026-12-31T23:30:00.000Z") } as unknown as FileContext;
  assert.equal(destination.quotaWhileRunning, true);
  assert.deepEqual(destination.quotaStop?.(ctx, "upload failed: invalid_account_type/feature/.."), {
    code: "upload_quota_exceeded",
    hitAt: "2026-12-31T23:30:00.000Z",
    actingGoogleAccount: null,
    limit: "dropbox_team_monthly_upload_calls",
    earliestResumeAt: "2027-01-01T00:00:00.000Z",
    resumeTimeIsEstimate: true,
  });
  for (const other of [null, "too_many_write_operations", "path/insufficient_space/"])
    assert.equal(destination.quotaStop?.(ctx, other), undefined);
});

test("Dropbox destination names block reserved names and long components", () => {
  const destination = fileProviderPair({
    sourceProvider: "sharepoint",
    destinationProvider: "dropbox",
  }).destination;
  for (const name of [
    "desktop.ini",
    "Thumbs.db",
    ".DS_Store",
    "Icon\r",
    ".dropbox",
    ".dropbox.attr",
  ])
    assert.equal(
      destination.destinationNameFindings?.(name, "file")[0]?.code,
      "destination_invalid_name",
    );
  assert.equal(
    destination.destinationNameFindings?.("x".repeat(256), "folder")[0]?.code,
    "destination_path_too_long",
  );
  assert.deepEqual(destination.destinationNameFindings?.("x".repeat(255), "folder"), []);
  assert.equal(destination.destinationSiblingKey?.("Report.TXT"), "report.txt");
});
