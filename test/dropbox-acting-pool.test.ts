import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DropboxAdapter } from "../src/engine/providers/adapters/dropbox.ts";
import type { CredentialSession } from "../src/engine/providers/credentials.ts";
import { ProviderFault } from "../src/engine/providers/fault.ts";

function session(scopes = ["members.read", "sharing.write"]): CredentialSession {
  return {
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
      return { dropboxDestination: { grantedScopes: scopes } };
    },
    rcloneConfigPath: null,
    sourceRemote: null,
    destinationRemote: null,
    dropboxDestinationRemote: "dropboxDestination",
    dropboxDestinationAdminId: "dbmid:writer",
    dispose() {},
  };
}

function adapter(scopes?: string[]) {
  const credentials = session(scopes);
  return new DropboxAdapter({
    session: credentials,
    mappings: [{ sourceDriveId: "google-drive", destDriveId: "555", destFolderId: "ns:555" }],
    destinationRoots: [{ destDriveId: "555", destFolderId: "ns:555" }],
    graph: {
      async request<T>(): Promise<T> {
        throw new Error("Graph must not be called");
      },
      async *stream() {
        throw new Error("Graph must not be called");
      },
      evidence: credentials.evidence,
    },
    worker: { read: () => null },
  });
}

interface Call {
  endpoint: string;
  body: Record<string, unknown>;
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
const teamFolders = () =>
  Response.json({
    namespaces: [
      { namespace_id: "555", name: "Finance", namespace_type: { ".tag": "team_folder" } },
    ],
    has_more: false,
    cursor: "c",
  });
const member =
  (status = "active", id = "dbmid:pool1") =>
  () =>
    Response.json({
      members_info: [
        {
          ".tag": "member_info",
          profile: { team_member_id: id, email: "pool1@x.test", status: { ".tag": status } },
        },
      ],
    });
const notFound = () =>
  Response.json({ members_info: [{ ".tag": "id_not_found", id_not_found: "gone@x.test" }] });
const members = (users: { email: string; role: string }[]) => () =>
  Response.json({
    users: users.map((user) => ({
      access_type: { ".tag": user.role },
      user: { account_id: `dbid:${user.email}`, email: user.email },
    })),
    groups: [{ access_type: { ".tag": "editor" }, group: { group_id: "g:abc" } }],
  });
const pass = { sourceDriveId: "google-drive", sourceItemId: "root", destDriveId: "555" } as const;

test("a Dropbox pool pass impersonates its member and keeps namespace, batching and encoding", async (t) => {
  const calls = serve(t, {
    "team/namespaces/list": teamFolders,
    "team/members/get_info_v2": member(),
  });
  const dropbox = adapter();
  const own = await dropbox.resolveDestinationPass({ ...pass, destFolderId: "ns:555" });
  assert.equal(
    own.fs,
    "dropboxDestination,root_namespace='555',impersonate_admin='dbmid:writer',batch_mode=sync,encoding='Slash,BackSlash,Del,Ctl,RightSpace,InvalidUtf8,Dot':",
  );
  assert.equal(
    calls.some((call) => call.endpoint === "team/members/get_info_v2"),
    false,
  );
  for (let index = 0; index < 2; index += 1) {
    const pooled = await dropbox.resolveDestinationPass({
      ...pass,
      destFolderId: "ns:555",
      account: "Pool1@x.test",
    });
    assert.deepEqual(pooled, {
      fs: "dropboxDestination,root_namespace='555',impersonate='Pool1@x.test',batch_mode=sync,encoding='Slash,BackSlash,Del,Ctl,RightSpace,InvalidUtf8,Dot':",
      kind: "dropbox",
    });
  }
  // One lookup per account, on the team token itself.
  const lookups = calls.filter((call) => call.endpoint === "team/members/get_info_v2");
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0]?.body, { members: [{ ".tag": "email", email: "Pool1@x.test" }] });
  assert.equal(lookups[0]?.headers.get("dropbox-api-select-admin"), null);
  assert.equal(lookups[0]?.headers.get("dropbox-api-select-user"), null);
});

test("a Dropbox pool refuses a write app without members.read and unknown members", async (t) => {
  serve(t, {
    "team/namespaces/list": teamFolders,
    "team/members/get_info_v2": notFound,
  });
  await assert.rejects(
    adapter(["sharing.write"]).resolveDestinationPass({
      ...pass,
      destFolderId: "ns:555",
      account: "pool1@x.test",
    }),
    (fault: unknown) =>
      fault instanceof ProviderFault &&
      fault.code === "preflight_failed" &&
      fault.evidence.check === "dropbox_pool_requires_members_read",
  );
  await assert.rejects(
    adapter().resolveDestinationPass({ ...pass, destFolderId: "ns:555", account: "gone@x.test" }),
    (fault: unknown) =>
      fault instanceof ProviderFault &&
      fault.code === "member_identity_unresolved" &&
      fault.evidence.memberStatus === "not_found",
  );
  await assert.rejects(
    adapter(["sharing.write"]).proveAccountWrite({
      account: "pool1@x.test",
      destDriveId: "555",
      destFolderId: "ns:555",
    }),
    (fault: unknown) =>
      fault instanceof ProviderFault &&
      fault.evidence.check === "dropbox_pool_requires_members_read",
  );
});

test("Dropbox uploader membership adds an editor by email once, as the admin", async (t) => {
  let users: { email: string; role: string }[] = [];
  const calls = serve(t, {
    "team/namespaces/list": teamFolders,
    "team/members/get_info_v2": member(),
    "sharing/list_folder_members": () => members(users)(),
    "sharing/add_folder_member": () => Response.json(null),
  });
  const dropbox = adapter();
  await dropbox.addUploaderMember("555", "Pool1@x.test");
  const adds = () => calls.filter((call) => call.endpoint === "sharing/add_folder_member");
  assert.deepEqual(adds()[0]?.body, {
    shared_folder_id: "555",
    members: [
      { member: { ".tag": "email", email: "Pool1@x.test" }, access_level: { ".tag": "editor" } },
    ],
    quiet: true,
  });
  assert.equal(adds()[0]?.headers.get("dropbox-api-select-admin"), "dbmid:writer");
  for (const role of ["editor", "owner"]) {
    users = [{ email: "pool1@x.test", role }];
    await dropbox.addUploaderMember("555", "pool1@x.test");
  }
  assert.equal(adds().length, 1);
  users = [{ email: "pool1@x.test", role: "viewer" }];
  await assert.rejects(
    dropbox.addUploaderMember("555", "pool1@x.test"),
    (fault: unknown) => fault instanceof ProviderFault && fault.code === "unsupported_member_role",
  );
  assert.equal(adds().length, 1);
});

test("Dropbox uploader removal waits for the job and leaves other roles alone", async (t) => {
  let users = [{ email: "pool1@x.test", role: "editor" }];
  let polls = 0;
  let outcome: Record<string, unknown> = { ".tag": "complete" };
  const calls = serve(t, {
    "team/namespaces/list": teamFolders,
    "sharing/list_folder_members": () => members(users)(),
    "sharing/remove_folder_member": () =>
      Response.json({ ".tag": "async_job_id", async_job_id: "job-1" }),
    "sharing/check_remove_member_job_status": (body) => {
      assert.deepEqual(body, { async_job_id: "job-1" });
      polls += 1;
      return Response.json(polls === 1 ? { ".tag": "in_progress" } : outcome);
    },
  });
  const dropbox = adapter();
  await dropbox.removeUploaderMember("555", "Pool1@x.test");
  const removes = () => calls.filter((call) => call.endpoint === "sharing/remove_folder_member");
  assert.deepEqual(removes()[0]?.body, {
    shared_folder_id: "555",
    member: { ".tag": "email", email: "Pool1@x.test" },
    leave_a_copy: false,
  });
  assert.equal(polls, 2);

  polls = 0;
  outcome = { ".tag": "failed", failed: { ".tag": "no_permission" } };
  await assert.rejects(
    dropbox.removeUploaderMember("555", "pool1@x.test"),
    (fault: unknown) => fault instanceof ProviderFault && fault.evidence.reason === "no_permission",
  );

  polls = 0;
  const controller = new AbortController();
  const removal = dropbox.removeUploaderMember("555", "pool1@x.test", controller.signal);
  setImmediate(() => controller.abort(new Error("stopped")));
  await assert.rejects(removal, /stopped/u);

  const before = removes().length;
  for (const present of [[], [{ email: "pool1@x.test", role: "owner" }]]) {
    users = present;
    await dropbox.removeUploaderMember("555", "pool1@x.test");
  }
  assert.equal(removes().length, before);
});

test("Dropbox write proof reads folder access as the member, never writing", async (t) => {
  let reply: () => Response = () => Response.json({ access_type: { ".tag": "editor" } });
  let lookup = member();
  const calls = serve(t, {
    "team/namespaces/list": teamFolders,
    "team/members/get_info_v2": () => lookup(),
    "sharing/get_folder_metadata": () => reply(),
  });
  const prove = (account = "pool1@x.test") =>
    adapter().proveAccountWrite({ account, destDriveId: "555", destFolderId: "ns:555" });
  assert.deepEqual(await prove(), {
    writable: true,
    evidence: {
      account: "pool1@x.test",
      namespaceId: "555",
      destFolderId: "ns:555",
      teamMemberId: "dbmid:pool1",
      accessType: "editor",
    },
  });
  const metadata = calls.find((call) => call.endpoint === "sharing/get_folder_metadata")!;
  assert.deepEqual(metadata.body, { shared_folder_id: "555" });
  assert.equal(metadata.headers.get("dropbox-api-select-user"), "dbmid:pool1");
  assert.equal(metadata.headers.get("dropbox-api-select-admin"), null);
  assert.equal(metadata.headers.get("authorization"), "Bearer dropbox-write-canary");

  reply = () => Response.json({ access_type: { ".tag": "viewer" } });
  assert.equal((await prove()).writable, false);
  reply = () => error(409, "access_error/not_a_member/..");
  const denied = await prove();
  assert.equal(denied.writable, false);
  assert.equal(denied.evidence.status, 409);
  assert.equal(denied.evidence.providerCode, "access_error/not_a_member");
  reply = () => error(500, "");
  await assert.rejects(prove(), (fault: unknown) => fault instanceof ProviderFault);

  for (const absent of [notFound, member("suspended")]) {
    lookup = absent;
    const result = await prove();
    assert.equal(result.writable, false);
    assert.match(String(result.evidence.memberStatus), /^(not_found|suspended)$/u);
  }
  assert.equal(
    calls.some((call) => /add_folder_member|upload|create/u.test(call.endpoint)),
    false,
  );
});
