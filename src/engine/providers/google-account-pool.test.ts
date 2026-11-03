import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { CredentialSession } from "./credentials.ts";
import type { GraphTransport } from "./http.ts";
import { GoogleAdapter } from "./adapters/google.ts";

const mapping = {
  id: "mapping",
  sourceDriveId: "source-drive",
  sourceItemId: "source-root",
  destDriveId: "shared-drive",
  destFolderId: "destination-root",
};
const session: CredentialSession = {
  async graphToken() {
    throw new Error("Pool scenarios must not use Graph.");
  },
  async graphDestinationToken() {
    throw new Error("Pool scenarios must not use Graph.");
  },
  async googleToken() {
    return "secret-job-canary";
  },
  async googleAccountToken(account: string) {
    return `secret-account-canary-${account}`;
  },
  async dropboxToken() {
    throw new Error("Pool scenarios must not use Dropbox.");
  },
  async identity() {
    return "stable-application";
  },
  async evidence() {
    return {};
  },
  rcloneConfigPath: null,
  sourceRemote: "source",
  destinationRemote: "google-write",
  delegatedSubject: "job@example.com",
  dispose() {},
};

function adapter(options: { serverSideCopy?: boolean; session?: CredentialSession } = {}) {
  return new GoogleAdapter({
    role: "destination",
    ...(options.serverSideCopy ? { serverSideCopy: true } : {}),
    mappings: [mapping],
    destinationRoots: [{ destDriveId: mapping.destDriveId, destFolderId: mapping.destFolderId }],
    session: options.session ?? session,
    graph: {} as GraphTransport,
    worker: {
      async *read() {
        throw new Error("Pool scenarios must not read source bytes.");
      },
    },
  });
}

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | null;
  body: unknown;
}

function fakeDrive(t: TestContext, respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "www.googleapis.com");
    const call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      auth: new Headers(init?.headers).get("Authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

const permissionsPath = "/drive/v3/files/shared-drive/permissions";

test("a pool pass impersonates its own account; no account keeps today's remote", async () => {
  const google = adapter();
  const pass = { ...mapping, sourceItemId: "source-root" };
  assert.equal(
    (await google.resolveDestinationPass(pass)).fs,
    'google-write,team_drive="shared-drive",root_folder_id="destination-root",impersonate="job@example.com":',
  );
  // A distinct connection string is a distinct rclone backend and token source.
  assert.equal(
    (await google.resolveDestinationPass({ ...pass, account: 'pool"1@example.com' })).fs,
    'google-write,team_drive="shared-drive",root_folder_id="destination-root",impersonate="pool""1@example.com":',
  );
  // Even a job that acts as the service account itself impersonates its pool members.
  const { delegatedSubject: _, ...selfSession } = session;
  assert.equal(
    (
      await adapter({ session: selfSession }).resolveDestinationPass({
        ...pass,
        account: "pool2@example.com",
      })
    ).fs,
    'google-write,team_drive="shared-drive",root_folder_id="destination-root",impersonate="pool2@example.com":',
  );
});

test("a pool account is refused with server-side copy", async () => {
  const google = adapter({ serverSideCopy: true });
  await assert.rejects(google.resolveDestinationPass({ ...mapping, account: "pool@example.com" }), {
    code: "unsupported_route",
  });
  assert.equal((await google.resolveDestinationPass(mapping)).serverSideCopy, true);
});

test("uploader membership adds a content manager as the job identity, once", async (t) => {
  let permissions: Record<string, unknown>[] = [
    { id: "p-owner", emailAddress: "job@example.com", type: "user", role: "organizer" },
  ];
  const calls = fakeDrive(t, (call) => {
    assert.equal(call.auth, "Bearer secret-job-canary");
    assert.equal(call.path, permissionsPath);
    assert.equal(call.query.get("supportsAllDrives"), "true");
    if (call.method === "GET") return Response.json({ permissions });
    assert.equal(call.method, "POST");
    assert.equal(call.query.get("sendNotificationEmail"), "false");
    permissions = [...permissions, { id: "p-pool", ...(call.body as object) }];
    return Response.json({ id: "p-pool" });
  });
  const google = adapter();
  await google.addUploaderMember("shared-drive", "pool@example.com");
  assert.deepEqual(calls[1]!.body, {
    emailAddress: "pool@example.com",
    type: "user",
    role: "fileOrganizer",
  });
  // Already a content manager, or a manager, is success without another grant.
  await google.addUploaderMember("shared-drive", "POOL@example.com");
  await google.addUploaderMember("shared-drive", "job@example.com");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "POST", "GET", "GET"],
  );
});

test("uploader membership never upgrades a weaker existing role", async (t) => {
  const calls = fakeDrive(t, (call) => {
    assert.equal(call.method, "GET");
    return Response.json({
      permissions: [{ id: "p", emailAddress: "Pool@example.com", type: "user", role: "writer" }],
    });
  });
  await assert.rejects(adapter().addUploaderMember("shared-drive", "pool@example.com"), {
    code: "unsupported_member_role",
    evidence: {
      provider: "google",
      driveId: "shared-drive",
      account: "pool@example.com",
      role: "writer",
    },
  });
  assert.equal(calls.length, 1);
});

test("removing uploader membership deletes only the content manager permission", async (t) => {
  let permissions: Record<string, unknown>[] = [
    { id: "p-pool", emailAddress: "Pool@Example.com", type: "user", role: "fileOrganizer" },
    { id: "p-group", emailAddress: "pool@example.com", type: "group", role: "fileOrganizer" },
    { id: "p-reader", emailAddress: "reader@example.com", type: "user", role: "reader" },
  ];
  const calls = fakeDrive(t, (call) => {
    assert.equal(call.auth, "Bearer secret-job-canary");
    assert.equal(call.query.get("supportsAllDrives"), "true");
    if (call.method === "GET") return Response.json({ permissions });
    assert.equal(call.method, "DELETE");
    assert.equal(call.path, `${permissionsPath}/p-pool`);
    permissions = permissions.filter((permission) => permission.id !== "p-pool");
    return new Response(null, { status: 204 });
  });
  const google = adapter();
  await google.removeUploaderMember("shared-drive", "pool@example.com");
  // Already absent, and a different role, are left alone as success.
  await google.removeUploaderMember("shared-drive", "pool@example.com");
  await google.removeUploaderMember("shared-drive", "reader@example.com");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "DELETE", "GET", "GET"],
  );
});

test("a permission already gone when deleted is success", async (t) => {
  fakeDrive(t, (call) =>
    call.method === "GET"
      ? Response.json({
          permissions: [
            { id: "p", emailAddress: "pool@example.com", type: "user", role: "fileOrganizer" },
          ],
        })
      : Response.json({ error: { code: 404 } }, { status: 404 }),
  );
  await adapter().removeUploaderMember("shared-drive", "pool@example.com");
});

test("write proof reads the destination root as the pool account", async (t) => {
  const answers: Record<string, () => Response> = {
    "writer@example.com": () =>
      Response.json({
        id: "destination-root",
        driveId: "shared-drive",
        capabilities: { canAddChildren: true },
      }),
    "reader@example.com": () =>
      Response.json({
        id: "destination-root",
        driveId: "shared-drive",
        capabilities: { canAddChildren: false },
      }),
    "elsewhere@example.com": () =>
      Response.json({
        id: "destination-root",
        driveId: "other-drive",
        capabilities: { canAddChildren: true },
      }),
    "outsider@example.com": () => Response.json({ error: { code: 404 } }, { status: 404 }),
    "forbidden@example.com": () => Response.json({ error: { code: 403 } }, { status: 403 }),
  };
  const calls = fakeDrive(t, (call) => {
    assert.equal(call.method, "GET");
    assert.equal(call.path, "/drive/v3/files/destination-root");
    assert.equal(call.query.get("supportsAllDrives"), "true");
    assert.equal(call.query.get("fields"), "id,driveId,capabilities(canAddChildren)");
    const account = call.auth!.replace("Bearer secret-account-canary-", "");
    return answers[account]!();
  });
  const google = adapter();
  const prove = (account: string) =>
    google.proveAccountWrite({
      account,
      destDriveId: "shared-drive",
      destFolderId: "destination-root",
    });
  const writer = await prove("writer@example.com");
  assert.equal(writer.writable, true);
  assert.deepEqual(writer.evidence, {
    provider: "google",
    account: "writer@example.com",
    destDriveId: "shared-drive",
    destFolderId: "destination-root",
    observedDriveId: "shared-drive",
    canAddChildren: true,
  });
  assert.equal((await prove("reader@example.com")).writable, false);
  assert.equal((await prove("elsewhere@example.com")).writable, false);
  const outsider = await prove("outsider@example.com");
  assert.equal(outsider.writable, false);
  assert.equal(outsider.evidence.status, 404);
  assert.equal((await prove("forbidden@example.com")).writable, false);
  // Never the job's token, and no token in evidence.
  assert.ok(calls.every((call) => call.auth?.startsWith("Bearer secret-account-canary-")));
  assert.doesNotMatch(JSON.stringify(writer.evidence), /canary/);
});

test("write proof surfaces transport failures instead of reporting unwritable", async (t) => {
  fakeDrive(t, () => Response.json({ error: { code: 500 } }, { status: 500 }));
  await assert.rejects(
    adapter().proveAccountWrite({
      account: "pool@example.com",
      destDriveId: "shared-drive",
      destFolderId: "destination-root",
    }),
    { code: "provider_request_failed" },
  );
});
