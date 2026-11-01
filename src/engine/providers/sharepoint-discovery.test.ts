import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourceDiscovery } from "../partition.ts";
import { SharePointAdapter } from "./adapters/sharepoint.ts";
import type { AdapterInput } from "./adapters/effects.ts";
import { discoverSharePointSource } from "./discovery.ts";
import { HttpProviderFault, type GraphTransport } from "./http.ts";

const SITE = "contoso.sharepoint.com,collection-1,web-1";
const DELTA =
  "/v1.0/drives/drive-a/root/delta?$select=id,name,root,folder,file,package,remoteItem,deleted,parentReference,shared";
const next = (token: string) => `https://graph.microsoft.com/v1.0/${token}`;
const file = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `${id}.docx`,
  file: {},
  parentReference: { id: parent },
  ...extra,
});
const folder = (id: string, name: string, parent: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  folder: { childCount: 0 },
  parentReference: { id: parent },
  ...extra,
});

function tenant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/v1.0/sites/getAllSites": {
      value: [
        {
          id: SITE,
          displayName: "Research",
          webUrl: "https://contoso.sharepoint.com/sites/research",
        },
        {
          id: "personal-1",
          isPersonalSite: true,
          webUrl: "https://contoso-my.sharepoint.com/personal/ann",
        },
      ],
    },
    [`/v1.0/sites/${encodeURIComponent(SITE)}/drives`]: {
      value: [{ id: "drive-a", name: "Documents", driveType: "documentLibrary" }],
    },
    [`/v1.0/sites/${encodeURIComponent(SITE)}/sites`]: { value: [] },
    "/v1.0/drives/drive-a/root?$select=id": { id: "root-a" },
    [DELTA]: {
      value: [
        { id: "root-a", name: "root", root: {}, folder: {}, shared: {} },
        folder("projects", "Projects", "root-a"),
        file("a1", "root-a"),
        file("a2", "root-a"),
        file("p1", "projects"),
        // Unique access, without links: Graph marks it with an empty shared facet.
        folder("secret", "Secret Plans", "projects", { shared: {} }),
        folder("alpha", "Alpha", "projects"),
        file("s1", "secret"),
        file("gone", "secret"),
      ],
      "@odata.nextLink": next("drives/drive-a/root/delta?token=2"),
    },
    [next("drives/drive-a/root/delta?token=2")]: {
      value: [
        // Children may arrive before their parent folder.
        file("d1", "deep"),
        folder("deep", "Deep", "secret"),
        file("s2", "secret"),
        // A notebook is copied as items, never mapped as a folder.
        {
          id: "notes",
          name: "Notes",
          package: { type: "oneNote" },
          parentReference: { id: "alpha" },
        },
        file("section-1", "notes"),
        folder("group", "Group", "notes"),
        file("section-2", "group"),
        folder("archive", "Archive", "root-a"),
        file("u1", "archive", { shared: { scope: "users" } }),
        file("orphan", "missing-folder"),
        // Delta may repeat an item; the last occurrence counts once.
        file("a2", "root-a"),
        { id: "gone", deleted: {} },
      ],
      "@odata.deltaLink": next("drives/drive-a/root/delta?token=3"),
    },
    "/v1.0/drives/drive-a/root/permissions": {
      value: [
        {
          id: "owners",
          roles: ["owner"],
          grantedToV2: { siteGroup: { id: "3", displayName: "Research Owners" } },
        },
        {
          id: "members",
          roles: ["write"],
          grantedToV2: { siteGroup: { id: "5", displayName: "Research Members" } },
        },
      ],
      "@odata.nextLink": next("drives/drive-a/root/permissions?$skiptoken=2"),
    },
    [next("drives/drive-a/root/permissions?$skiptoken=2")]: {
      value: [
        {
          id: "ann",
          roles: ["read"],
          grantedToV2: {
            user: { id: "user-ann", email: "Ann@Contoso.com" },
            siteUser: { id: "9", loginName: "i:0#.f|membership|ann@contoso.com" },
          },
        },
        { id: "app", roles: ["write"], grantedToV2: { application: { id: "app-1" } } },
      ],
    },
    "/v1.0/drives/drive-a/items/secret/permissions": {
      value: [
        { id: "bob", roles: ["write"], grantedToV2: { user: { id: "user-bob" } } },
        { id: "team", roles: ["read"], grantedToV2: { group: { id: "group-1" } } },
        {
          id: "link",
          roles: ["read"],
          link: { scope: "organization", type: "view" },
          grantedToIdentitiesV2: [{ user: { id: "user-bob" } }],
        },
        {
          id: "spg",
          roles: ["sp.full control"],
          grantedToV2: { sharePointGroup: { id: "spg-guid", principalId: "7" } },
        },
      ],
    },
    ...overrides,
  };
}

function fakeGraph(
  pages: Record<string, unknown>,
  requests: { path: string; init?: RequestInit }[] = [],
): GraphTransport {
  return {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      requests.push({ path, ...(init ? { init } : {}) });
      assert.ok(Object.hasOwn(pages, path), `Unexpected Graph request: ${path}`);
      let page = pages[path];
      if (Array.isArray(page)) page = page.length > 1 ? page.shift() : page[0];
      if (page instanceof Error) throw page;
      return JSON.parse(JSON.stringify(page));
    },
    async *stream() {
      throw new Error("Discovery must not read bytes");
    },
    async evidence() {
      return { grantedPermissions: ["Sites.Read.All"] };
    },
  };
}

const LIBRARY = "Research (contoso.sharepoint.com/sites/research) - Documents";

test("discovery counts a library in one delta walk and splits it at unique access", async () => {
  const requests: { path: string; init?: RequestInit }[] = [];
  const signal = new AbortController().signal;
  const result = await discoverSharePointSource(fakeGraph(tenant(), requests), signal);
  assert.ok(!Number.isNaN(Date.parse(result.observedAt)));
  assert.deepEqual({ ...result, observedAt: "" } satisfies SourceDiscovery, {
    sourceProvider: "sharepoint",
    observedAt: "",
    boundaries: [
      {
        id: "drive-a",
        kind: "sharepoint_library",
        name: LIBRARY,
        root: { type: "sharepoint", driveId: "drive-a", folderPath: "" },
        members: [
          {
            id: "sitegroup:contoso.sharepoint.com,collection-1:3",
            type: "group",
            role: "owner",
          },
          {
            id: "sitegroup:contoso.sharepoint.com,collection-1:5",
            type: "group",
            role: "write",
          },
          { id: "ann@contoso.com", type: "user", role: "read" },
        ],
        tree: {
          name: "",
          files: 2,
          folders: [
            { name: "Archive", files: 1, folders: [] },
            {
              name: "Projects",
              files: 1,
              folders: [{ name: "Alpha", files: 4, folders: [] }],
              nested: ["drive-a/secret"],
            },
          ],
        },
      },
      {
        id: "drive-a/secret",
        kind: "sharepoint_folder",
        name: `${LIBRARY}/Projects/Secret Plans`,
        root: { type: "sharepoint", driveId: "drive-a", folderPath: "Projects/Secret Plans" },
        parent: "drive-a",
        members: [
          { id: "group-1", type: "group", role: "read" },
          { id: "link:organization", type: "group", role: "read" },
          { id: "spg-guid", type: "group", role: "sp.full control" },
          { id: "user-bob", type: "user", role: "write" },
        ],
        tree: {
          name: "",
          files: 2,
          folders: [{ name: "Deep", files: 1, folders: [] }],
        },
      },
    ],
    notices: [
      "1 personal OneDrive sites were skipped; discovery covers SharePoint document libraries only.",
      `${LIBRARY}: 1 files have unique permissions; a container grants one membership, so review their access.`,
      `${LIBRARY}: 1 items had no folder path to the library root and were not counted.`,
    ],
  });
  const delta = requests.filter(({ path }) => path.includes("/delta"));
  assert.equal(delta.length, 2);
  for (const { init } of delta) {
    assert.equal(new Headers(init?.headers).get("Prefer"), "hierarchicalsharing");
    assert.equal(init?.signal, signal);
  }
});

test("discovery nests unique folders inside unique folders under the nearest boundary", async () => {
  const result = await discoverSharePointSource(
    fakeGraph(
      tenant({
        [DELTA]: {
          value: [
            folder("outer", "Outer", "root-a", { shared: {} }),
            folder("inner", "Inner", "outer", { shared: {} }),
            file("i1", "inner"),
          ],
        },
        "/v1.0/drives/drive-a/items/outer/permissions": { value: [] },
        "/v1.0/drives/drive-a/items/inner/permissions": { value: [] },
      }),
    ),
  );
  assert.deepEqual(
    result.boundaries.map(({ id, parent, root, tree }) => ({ id, parent, root, tree })),
    [
      {
        id: "drive-a",
        parent: undefined,
        root: { type: "sharepoint", driveId: "drive-a", folderPath: "" },
        tree: { name: "", files: 0, folders: [], nested: ["drive-a/outer"] },
      },
      {
        id: "drive-a/inner",
        parent: "drive-a/outer",
        root: { type: "sharepoint", driveId: "drive-a", folderPath: "Outer/Inner" },
        tree: { name: "", files: 1, folders: [] },
      },
      {
        id: "drive-a/outer",
        parent: "drive-a",
        root: { type: "sharepoint", driveId: "drive-a", folderPath: "Outer" },
        tree: { name: "", files: 0, folders: [], nested: ["drive-a/inner"] },
      },
    ],
  );
});

test("discovery records an unreadable membership as null and keeps counting", async () => {
  const result = await discoverSharePointSource(
    fakeGraph(
      tenant({
        "/v1.0/drives/drive-a/items/secret/permissions": new HttpProviderFault(
          403,
          null,
          "accessDenied",
        ),
        // A permission naming nobody Graph identifies is unreadable too.
        "/v1.0/drives/drive-a/root/permissions": { value: [{ id: "x", roles: ["read"] }] },
      }),
    ),
  );
  assert.deepEqual(
    result.boundaries.map(({ id, members }) => ({ id, members })),
    [
      { id: "drive-a", members: null },
      { id: "drive-a/secret", members: null },
    ],
  );
  assert.ok(
    result.notices.includes(
      `${LIBRARY}: its permissions were unreadable, so it shares no container.`,
    ),
  );
});

test("discovery retries a throttled delta page instead of ending the walk", async () => {
  const pages = tenant();
  pages[DELTA] = [new HttpProviderFault(429, "0"), pages[DELTA]];
  const result = await discoverSharePointSource(fakeGraph(pages));
  assert.equal(result.boundaries[0]!.tree.files, 2);
});

test("discovery refuses delta items and requests it cannot trust", async () => {
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      { [DELTA]: { value: [{ id: "x", name: "x.docx", file: {} }] } },
      {
        check: "discovery_response_invalid",
        object: "item",
        field: "parentReference.id",
        driveId: "drive-a",
        itemId: "x",
      },
    ],
    [
      { [DELTA]: { value: [folder("x", "", "root-a")] } },
      {
        check: "discovery_response_invalid",
        object: "item",
        field: "name",
        driveId: "drive-a",
        itemId: "x",
      },
    ],
    [
      { [DELTA]: new HttpProviderFault(403, null, "accessDenied") },
      {
        check: "discovery_request_failed",
        status: 403,
        providerCode: "accessDenied",
        route: DELTA,
        driveId: "drive-a",
      },
    ],
    [
      {
        [DELTA]: {
          value: [],
          "@odata.nextLink": "https://example.com/v1.0/drives/drive-a/root/delta?token=2",
        },
      },
      {
        check: "discovery_response_invalid",
        object: "page",
        field: "@odata.nextLink",
        route: DELTA,
        driveId: "drive-a",
      },
    ],
  ];
  for (const [overrides, evidence] of cases)
    await assert.rejects(discoverSharePointSource(fakeGraph(tenant(overrides))), {
      code: "preflight_failed",
      evidence,
    });
});

test("discovery refuses without the tenant-wide grant and stops on abort", async () => {
  const graph = fakeGraph(tenant());
  await assert.rejects(
    discoverSharePointSource({ ...graph, evidence: async () => ({ grantedPermissions: [] }) }),
    {
      code: "preflight_failed",
      evidence: { check: "discovery_requires_sites_read_all", requiredGrant: "Sites.Read.All" },
    },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverSharePointSource(graph, controller.signal), { name: "AbortError" });
});

test("the SharePoint adapter discovers its source through its Graph transport", async () => {
  const adapter = new SharePointAdapter({
    mappings: [],
    destinationRoots: [],
    session: {} as AdapterInput["session"],
    graph: fakeGraph(tenant()),
    worker: {} as AdapterInput["worker"],
  } as unknown as AdapterInput);
  const result = await adapter.discoverSource();
  assert.deepEqual(
    result.boundaries.map(({ id }) => id),
    ["drive-a", "drive-a/secret"],
  );
});
