import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { CredentialSession } from "./credentials.ts";
import type { GraphTransport } from "./http.ts";
import { GoogleAdapter } from "./adapters/google.ts";
import { subtreeItems } from "../partition.ts";

const FOLDER = "application/vnd.google-apps.folder";
const session = {
  async googleToken() {
    return "secret-google-canary";
  },
} as unknown as CredentialSession;

function adapter(): GoogleAdapter {
  return new GoogleAdapter({
    mappings: [],
    destinationRoots: [],
    session,
    graph: {} as GraphTransport,
    worker: {
      async *read() {
        throw new Error("Discovery must not read source bytes.");
      },
    },
  });
}

interface Drive {
  id: string;
  name: string;
  permissions: Record<string, unknown>[] | number;
  files: Record<string, unknown>[];
  trash?: number;
}

/** Drive v3 as discovery uses it, paging every list `per` items at a time. */
function fakeDrive(t: TestContext, drives: Drive[], per = 2) {
  const requests: URL[] = [];
  function paged(items: unknown[], url: URL, key: string) {
    const start = Number(url.searchParams.get("pageToken") ?? 0);
    const next = start + per < items.length ? String(start + per) : undefined;
    return Response.json({
      [key]: items.slice(start, start + per),
      ...(next ? { nextPageToken: next } : {}),
    });
  }
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret-google-canary");
    if (url.pathname === "/drive/v3/drives") {
      assert.equal(url.searchParams.has("useDomainAdminAccess"), false);
      assert.equal(url.searchParams.get("pageSize"), "100");
      return paged(
        drives.map(({ id, name }) => ({ id, name })),
        url,
        "drives",
      );
    }
    const permissions = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(url.pathname);
    if (permissions) {
      const drive = drives.find((d) => d.id === decodeURIComponent(permissions[1]!))!;
      assert.equal(url.searchParams.get("supportsAllDrives"), "true");
      if (typeof drive.permissions === "number")
        return Response.json({ error: { code: drive.permissions } }, { status: drive.permissions });
      return paged(drive.permissions, url, "permissions");
    }
    assert.equal(url.pathname, "/drive/v3/files");
    assert.equal(url.searchParams.get("corpora"), "drive");
    assert.equal(url.searchParams.get("supportsAllDrives"), "true");
    assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
    assert.equal(url.searchParams.get("pageSize"), "1000");
    const drive = drives.find((d) => d.id === url.searchParams.get("driveId"))!;
    if (url.searchParams.get("q") === "trashed = true")
      return paged(
        Array.from({ length: drive.trash ?? 0 }, (_, i) => ({ id: `trash-${i}` })),
        url,
        "files",
      );
    assert.equal(url.searchParams.get("q"), "trashed = false");
    assert.equal(
      url.searchParams.get("fields"),
      "nextPageToken,incompleteSearch,files(id,name,mimeType,parents)",
    );
    return paged(drive.files, url, "files");
  });
  return requests;
}

const folder = (id: string, name: string, parent: string) => ({
  id,
  name,
  mimeType: FOLDER,
  parents: [parent],
});
const file = (id: string, parent: string, mimeType = "text/plain") => ({
  id,
  name: `${id}.txt`,
  mimeType,
  parents: [parent],
});

test("discovers each Shared Drive as a boundary with its folder tree and counts", async (t) => {
  const requests = fakeDrive(t, [
    {
      id: "drive-b",
      name: "Finance",
      permissions: [
        { emailAddress: "Bob@Example.com", type: "user", role: "organizer" },
        { emailAddress: "Team@Example.com", type: "group", role: "writer" },
        { domain: "Example.com", type: "domain", role: "reader" },
        { type: "anyone", role: "reader" },
        { emailAddress: "alice@example.com", type: "user", role: "fileOrganizer" },
      ],
      // Children arrive before their parents, as files.list gives no order guarantee.
      files: [
        file("f1", "sub"),
        folder("sub", "Sub", "top-z"),
        file("f2", "drive-b"),
        file("short", "drive-b", "application/vnd.google-apps.shortcut"),
        file("doc", "top-a", "application/vnd.google-apps.document"),
        folder("top-z", "Zeta", "drive-b"),
        folder("top-a", "Alpha", "drive-b"),
        folder("empty", "Alpha", "top-z"),
      ],
      trash: 3,
    },
    { id: "drive-a", name: "Empty", permissions: [], files: [] },
  ]);
  const discovery = await adapter().discoverSource();
  assert.equal(discovery.sourceProvider, "google_shared_drive");
  assert.ok(!Number.isNaN(Date.parse(discovery.observedAt)));
  assert.deepEqual(
    discovery.boundaries.map((b) => b.id),
    ["drive-a", "drive-b"],
  );
  const [empty, finance] = discovery.boundaries;
  assert.deepEqual(empty, {
    id: "drive-a",
    kind: "google_shared_drive",
    name: "Empty",
    root: { type: "google_shared_drive", driveId: "drive-a", folderId: "drive-a" },
    members: [],
    tree: { name: "", id: "drive-a", files: 0, folders: [] },
  });
  assert.deepEqual(finance!.root, {
    type: "google_shared_drive",
    driveId: "drive-b",
    folderId: "drive-b",
  });
  assert.deepEqual(finance!.members, [
    { id: "alice@example.com", type: "user", role: "fileOrganizer" },
    { id: "anyone", type: "group", role: "reader" },
    { id: "bob@example.com", type: "user", role: "organizer" },
    { id: "domain:example.com", type: "group", role: "reader" },
    { id: "team@example.com", type: "group", role: "writer" },
  ]);
  assert.deepEqual(finance!.tree, {
    name: "",
    id: "drive-b",
    files: 2,
    folders: [
      { name: "Alpha", id: "top-a", files: 1, folders: [] },
      {
        name: "Zeta",
        id: "top-z",
        files: 0,
        folders: [
          { name: "Alpha", id: "empty", files: 0, folders: [] },
          { name: "Sub", id: "sub", files: 1, folders: [] },
        ],
      },
    ],
  });
  assert.equal(subtreeItems(finance!.tree), 8);
  assert.deepEqual(discovery.notices, [
    "Shared Drive drive-b (Finance): 3 trashed item(s) count toward its 500,000-item limit but are not migrated or counted here.",
  ]);
  // Every list was paged through to its end.
  assert.ok(
    requests.some(
      (u) => u.pathname.endsWith("/permissions") && u.searchParams.get("pageToken") === "4",
    ),
  );
  assert.ok(
    requests.some(
      (u) =>
        u.searchParams.get("q") === "trashed = false" && u.searchParams.get("pageToken") === "6",
    ),
  );
});

test("unresolvable parents are counted at the top folder with a notice", async (t) => {
  fakeDrive(t, [
    {
      id: "drive",
      name: "Drive",
      permissions: [{ emailAddress: "a@example.com", type: "user", role: "organizer" }],
      files: [
        folder("kept", "Kept", "drive"),
        file("in-kept", "kept"),
        // An unknown parent, no parent, and a two-folder cycle with a file inside.
        file("lost", "missing-parent"),
        { id: "bare", name: "bare", mimeType: "text/plain" },
        folder("loop-a", "A", "loop-b"),
        folder("loop-b", "B", "loop-a"),
        file("in-loop", "loop-a"),
        folder("under-loop", "C", "loop-b"),
      ],
    },
  ]);
  const discovery = await adapter().discoverSource();
  const tree = discovery.boundaries[0]!.tree;
  assert.deepEqual(tree, {
    name: "",
    id: "drive",
    files: 6,
    folders: [{ name: "Kept", id: "kept", files: 1, folders: [] }],
  });
  // Nothing went missing from the total.
  assert.equal(subtreeItems(tree), 8);
  assert.deepEqual(discovery.notices, [
    "Shared Drive drive (Drive): 6 item(s) whose parent folder could not be resolved are counted at its top folder.",
  ]);
});

test("unreadable or unmappable membership is null, deleted accounts are left out", async (t) => {
  const requests = fakeDrive(t, [
    { id: "denied", name: "Denied", permissions: 403, files: [] },
    {
      id: "odd",
      name: "Odd",
      permissions: [{ type: "user", role: "reader" }],
      files: [],
    },
    {
      id: "with-deleted",
      name: "With deleted",
      permissions: [
        { emailAddress: "a@example.com", type: "user", role: "organizer" },
        { type: "user", role: "writer", deleted: true },
      ],
      files: [],
    },
  ]);
  const discovery = await adapter().discoverSource();
  assert.deepEqual(
    discovery.boundaries.map((b) => [b.id, b.members]),
    [
      ["denied", null],
      ["odd", null],
      ["with-deleted", [{ id: "a@example.com", type: "user", role: "organizer" }]],
    ],
  );
  assert.deepEqual(discovery.notices, [
    "Shared Drive denied (Denied): its members could not be read, so it never shares a container.",
    "Shared Drive odd (Odd): its members could not be read, so it never shares a container.",
    "Shared Drive with-deleted (With deleted): 1 deleted account(s) among its members were left out.",
  ]);
  assert.ok(
    requests.some((u) => u.pathname === "/drive/v3/drives" && u.searchParams.has("pageToken")),
  );
});

test("a refused or incomplete listing ends discovery with a named refusal", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { code: 429 } }, { status: 429 }),
  );
  await assert.rejects(adapter().discoverSource(), (error: any) => {
    assert.equal(error.code, "preflight_failed");
    assert.equal(error.message, "Google did not complete a discovery request.");
    assert.equal(error.evidence.check, "discovery_request_failed");
    assert.equal(error.evidence.object, "drives");
    return true;
  });
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/drive/v3/drives")
      return Response.json({ drives: [{ id: "d", name: "D" }] });
    if (url.pathname.endsWith("/permissions")) return Response.json({ permissions: [] });
    return Response.json({ files: [], incompleteSearch: true });
  });
  await assert.rejects(adapter().discoverSource(), (error: any) => {
    assert.equal(error.code, "preflight_failed");
    assert.equal(error.evidence.check, "discovery_response_invalid");
    assert.equal(error.evidence.field, "incompleteSearch");
    assert.equal(error.evidence.driveId, "d");
    return true;
  });
});

test("discovery honours its abort signal", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/drive/v3/drives")
      return Response.json({ drives: [{ id: "d", name: "D" }] });
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  });
  await assert.rejects(adapter().discoverSource(controller.signal), { name: "AbortError" });
});
