import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderFault } from "./credentials.ts";
import { discoverSharePoint } from "./discovery.ts";
import { HttpProviderFault, type GraphTransport } from "./http.ts";

test("discovery follows site, subsite and library pages and drafts every library once", async () => {
  const pages: Record<string, unknown> = {
    "/v1.0/sites/getAllSites": {
      value: [
        {
          id: "site-a",
          displayName: "Research",
          webUrl: "https://tenant.sharepoint.com/sites/research",
        },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/getAllSites?$skiptoken=sites-2",
    },
    "https://graph.microsoft.com/v1.0/sites/getAllSites?$skiptoken=sites-2": {
      value: [
        {
          id: "site-b",
          displayName: "Operations",
          webUrl: "https://tenant.sharepoint.com/sites/F%C3%B6rs%C3%A4ljning/Team%20A",
        },
        {
          id: "site-d",
          displayName: "Research",
          webUrl: "https://tenant.sharepoint.com/sites/research/labs",
        },
      ],
    },
    "/v1.0/sites/site-a/drives": {
      value: [{ id: "drive-a", name: "Documents", driveType: "documentLibrary" }],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/sites/site-a/drives?$skiptoken=libraries-2",
    },
    "https://graph.microsoft.com/v1.0/sites/site-a/drives?$skiptoken=libraries-2": {
      value: [
        { id: "drive-b", name: "Evidence", driveType: "documentLibrary" },
        { id: "personal", name: "Personal", driveType: "personal" },
      ],
    },
    "/v1.0/sites/site-b/drives": {
      value: [{ id: "drive-c", name: "Documents", driveType: "documentLibrary" }],
    },
    "/v1.0/sites/site-a/sites": {
      value: [
        {
          id: "site-d",
          displayName: "Research",
          webUrl: "https://tenant.sharepoint.com/sites/research/labs",
        },
      ],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/sites/site-a/sites?$skiptoken=subsites-2",
    },
    "https://graph.microsoft.com/v1.0/sites/site-a/sites?$skiptoken=subsites-2": {
      value: [
        {
          id: "site-e",
          displayName: "Research",
          webUrl: "https://tenant.sharepoint.com/sites/research/team",
        },
      ],
    },
    "/v1.0/sites/site-d/sites": {
      value: [
        {
          id: "site-f",
          displayName: "Archive",
          webUrl: "https://tenant.sharepoint.com/sites/research/labs/archive",
        },
        {
          id: "site-a",
          displayName: "Research",
          webUrl: "https://tenant.sharepoint.com/sites/research",
        },
      ],
    },
    "/v1.0/sites/site-b/sites": { value: [] },
    "/v1.0/sites/site-e/sites": { value: [] },
    "/v1.0/sites/site-f/sites": { value: [] },
    "/v1.0/sites/site-d/drives": {
      value: [{ id: "drive-d", name: "Documents", driveType: "documentLibrary" }],
    },
    "/v1.0/sites/site-e/drives": {
      value: [{ id: "drive-e", name: "Documents", driveType: "documentLibrary" }],
    },
    "/v1.0/sites/site-f/drives": {
      value: [{ id: "drive-f", name: "Documents", driveType: "documentLibrary" }],
    },
  };
  const graph: GraphTransport = {
    async request<T>(path: string): Promise<T> {
      assert.ok(Object.hasOwn(pages, path), `Unexpected Graph request: ${path}`);
      return JSON.parse(JSON.stringify(pages[path]));
    },
    async *stream() {
      throw new Error("Discovery must not read file bytes");
    },
    async evidence() {
      return { grantedPermissions: ["Sites.Read.All"] };
    },
  };
  const result = await discoverSharePoint(graph);
  assert.deepEqual(result.sites, [
    {
      id: "site-a",
      name: "Research",
      libraries: [
        { id: "drive-a", name: "Documents" },
        { id: "drive-b", name: "Evidence" },
      ],
    },
    { id: "site-d", name: "Research", libraries: [{ id: "drive-d", name: "Documents" }] },
    { id: "site-f", name: "Archive", libraries: [{ id: "drive-f", name: "Documents" }] },
    { id: "site-e", name: "Research", libraries: [{ id: "drive-e", name: "Documents" }] },
    { id: "site-b", name: "Operations", libraries: [{ id: "drive-c", name: "Documents" }] },
  ]);
  assert.deepEqual(result.manifest, {
    version: 1,
    mappings: [
      {
        id: "drive-a",
        source: { type: "sharepoint", driveId: "drive-a", folderPath: "" },
        destination: {
          type: "google_shared_drive",
          create: "Research (tenant.sharepoint.com/sites/research) - Documents",
        },
        members: [],
      },
      {
        id: "drive-b",
        source: { type: "sharepoint", driveId: "drive-b", folderPath: "" },
        destination: {
          type: "google_shared_drive",
          create: "Research (tenant.sharepoint.com/sites/research) - Evidence",
        },
        members: [],
      },
      {
        id: "drive-d",
        source: { type: "sharepoint", driveId: "drive-d", folderPath: "" },
        destination: {
          type: "google_shared_drive",
          create: "Research (tenant.sharepoint.com/sites/research/labs) - Documents",
        },
        members: [],
      },
      {
        id: "drive-f",
        source: { type: "sharepoint", driveId: "drive-f", folderPath: "" },
        destination: {
          type: "google_shared_drive",
          create: "Archive (tenant.sharepoint.com/sites/research/labs/archive) - Documents",
        },
        members: [],
      },
      {
        id: "drive-e",
        source: { type: "sharepoint", driveId: "drive-e", folderPath: "" },
        destination: {
          type: "google_shared_drive",
          create: "Research (tenant.sharepoint.com/sites/research/team) - Documents",
        },
        members: [],
      },
      {
        id: "drive-c",
        source: { type: "sharepoint", driveId: "drive-c", folderPath: "" },
        destination: {
          type: "google_shared_drive",
          create: "Operations (tenant.sharepoint.com/sites/Försäljning/Team A) - Documents",
        },
        members: [],
      },
    ],
  });
});

function fakeGraph(pages: Record<string, unknown>): GraphTransport {
  return {
    async request<T>(path: string): Promise<T> {
      assert.ok(Object.hasOwn(pages, path), `Unexpected Graph request: ${path}`);
      if (pages[path] instanceof Error) throw pages[path];
      return JSON.parse(JSON.stringify(pages[path]));
    },
    async *stream() {
      throw new Error("Discovery must not read bytes");
    },
    async evidence() {
      return { grantedPermissions: ["Sites.Read.All"] };
    },
  };
}

test("discovery labels sites and libraries Graph returns without a usable name", async () => {
  const result = await discoverSharePoint(
    fakeGraph({
      "/v1.0/sites/getAllSites": {
        value: [
          // The classic Search Center: Graph omits both displayName and name.
          { id: "site-search", webUrl: "https://contoso.sharepoint.com/search" },
          {
            id: "site-hr",
            displayName: "",
            name: "Human Resources",
            webUrl: "https://contoso.sharepoint.com/sites/hr",
          },
          { id: "site-root", displayName: " ", webUrl: "https://contoso.sharepoint.com/" },
          {
            id: "site-marketing",
            displayName: "Marketing",
            webUrl: "https://contoso.sharepoint.com/sites/Marketing",
          },
        ],
      },
      "/v1.0/sites/site-search/drives": {
        value: [{ id: "drive-search", name: "Documents", driveType: "documentLibrary" }],
      },
      "/v1.0/sites/site-hr/drives": {
        value: [{ id: "drive-hr", name: "Policies\n", driveType: "documentLibrary" }],
      },
      "/v1.0/sites/site-root/drives": {
        value: [{ id: "drive-root", name: "Documents", driveType: "documentLibrary" }],
      },
      "/v1.0/sites/site-marketing/drives": {
        value: [{ id: "drive-marketing", name: "Documents", driveType: "documentLibrary" }],
      },
      "/v1.0/sites/site-search/sites": { value: [] },
      "/v1.0/sites/site-hr/sites": { value: [] },
      "/v1.0/sites/site-root/sites": { value: [] },
      "/v1.0/sites/site-marketing/sites": { value: [] },
    }),
  );
  assert.deepEqual(result.sites, [
    { id: "site-search", name: "search", libraries: [{ id: "drive-search", name: "Documents" }] },
    { id: "site-hr", name: "Human Resources", libraries: [{ id: "drive-hr", name: "drive-hr" }] },
    {
      id: "site-root",
      name: "contoso.sharepoint.com",
      libraries: [{ id: "drive-root", name: "Documents" }],
    },
    {
      id: "site-marketing",
      name: "Marketing",
      libraries: [{ id: "drive-marketing", name: "Documents" }],
    },
  ]);
  assert.deepEqual(
    result.manifest.mappings.map((mapping) => mapping.destination),
    [
      {
        type: "google_shared_drive",
        create: "search (contoso.sharepoint.com/search) - Documents",
      },
      {
        type: "google_shared_drive",
        create: "Human Resources (contoso.sharepoint.com/sites/hr) - drive-hr",
      },
      {
        type: "google_shared_drive",
        create: "contoso.sharepoint.com (contoso.sharepoint.com/) - Documents",
      },
      {
        type: "google_shared_drive",
        create: "Marketing (contoso.sharepoint.com/sites/Marketing) - Documents",
      },
    ],
  );
});

test("discovery refuses a site Graph returns without a URL, naming the site and field", async () => {
  await assert.rejects(
    discoverSharePoint(
      fakeGraph({
        "/v1.0/sites/getAllSites": { value: [{ id: "site-a", displayName: "Research" }] },
      }),
    ),
    {
      code: "preflight_failed",
      evidence: {
        check: "discovery_response_invalid",
        object: "site",
        field: "webUrl",
        siteId: "site-a",
      },
    },
  );
});

test("discovery refuses identifiers and pages it cannot trust, naming the object and field", async () => {
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      {
        "/v1.0/sites/getAllSites": {
          value: [{ displayName: "Research", webUrl: "https://contoso.sharepoint.com/sites/r" }],
        },
      },
      {
        check: "discovery_response_invalid",
        object: "site",
        field: "id",
        webUrl: "https://contoso.sharepoint.com/sites/r",
      },
    ],
    [
      {
        "/v1.0/sites/getAllSites": {
          value: [{ id: "site-a", webUrl: "https://contoso.sharepoint.com/sites/a" }],
        },
        "/v1.0/sites/site-a/drives": {
          value: [{ id: "", name: "Documents", driveType: "documentLibrary" }],
        },
      },
      { check: "discovery_response_invalid", object: "drive", field: "id", siteId: "site-a" },
    ],
    [
      { "/v1.0/sites/getAllSites": { value: {} } },
      {
        check: "discovery_response_invalid",
        object: "page",
        field: "value",
        route: "/v1.0/sites/getAllSites",
      },
    ],
    [
      {
        "/v1.0/sites/getAllSites": {
          value: [],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/getAllSites?$skiptoken=1",
        },
        "https://graph.microsoft.com/v1.0/sites/getAllSites?$skiptoken=1": {
          value: [],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/getAllSites?$skiptoken=1",
        },
      },
      {
        check: "discovery_response_invalid",
        object: "page",
        field: "@odata.nextLink",
        route: "/v1.0/sites/getAllSites",
      },
    ],
    [
      {
        "/v1.0/sites/getAllSites": {
          value: [{ id: "site-a", webUrl: "https://contoso.sharepoint.com/sites/a" }],
        },
        // A link off Graph would carry the bearer token elsewhere; it is never followed.
        "/v1.0/sites/site-a/drives": {
          value: [],
          "@odata.nextLink": "https://example.com/v1.0/sites/site-a/drives?$skiptoken=1",
        },
      },
      {
        check: "discovery_response_invalid",
        object: "page",
        field: "@odata.nextLink",
        route: "/v1.0/sites/site-a/drives",
        siteId: "site-a",
      },
    ],
  ];
  for (const [pages, evidence] of cases)
    await assert.rejects(discoverSharePoint(fakeGraph(pages)), {
      code: "preflight_failed",
      evidence,
    });
});

test("discovery requests nothing from personal OneDrive sites", async () => {
  // fakeGraph rejects any request outside these pages, so a visited personal site fails.
  const result = await discoverSharePoint(
    fakeGraph({
      "/v1.0/sites/getAllSites": {
        value: [
          {
            id: "personal-flagged",
            isPersonalSite: true,
            webUrl: "https://contoso-my.sharepoint.com/personal/ada_contoso_com",
          },
          // Without the flag, the OneDrive host still identifies a personal site.
          {
            id: "personal-host",
            webUrl: "https://contoso-my.sharepoint.com/personal/grace_contoso_com",
          },
          { id: "personal-no-url", isPersonalSite: true },
          {
            id: "site-a",
            displayName: "Research",
            isPersonalSite: false,
            webUrl: "https://contoso.sharepoint.com/sites/research",
          },
        ],
      },
      "/v1.0/sites/site-a/drives": {
        value: [{ id: "drive-a", name: "Documents", driveType: "documentLibrary" }],
      },
      "/v1.0/sites/site-a/sites": { value: [] },
    }),
  );
  assert.deepEqual(result.sites, [
    { id: "site-a", name: "Research", libraries: [{ id: "drive-a", name: "Documents" }] },
  ]);
  assert.deepEqual(
    result.manifest.mappings.map((mapping) => mapping.id),
    ["drive-a"],
  );
});

test("discovery refuses a failed Graph request with its status and the request it was reading", async () => {
  const sites = {
    value: [{ id: "site-a", webUrl: "https://contoso.sharepoint.com/sites/a" }],
  };
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      {
        "/v1.0/sites/getAllSites": sites,
        "/v1.0/sites/site-a/drives": new HttpProviderFault(
          403,
          null,
          "accessDenied",
          "graph.microsoft.com",
        ),
      },
      {
        check: "discovery_request_failed",
        status: 403,
        providerCode: "accessDenied",
        host: "graph.microsoft.com",
        route: "/v1.0/sites/site-a/drives",
        siteId: "site-a",
      },
    ],
    [
      {
        "/v1.0/sites/getAllSites": sites,
        "/v1.0/sites/site-a/drives": { value: [] },
        "/v1.0/sites/site-a/sites": new HttpProviderFault(429, "5"),
      },
      {
        check: "discovery_request_failed",
        status: 429,
        route: "/v1.0/sites/site-a/sites",
        siteId: "site-a",
      },
    ],
    [
      {
        "/v1.0/sites/getAllSites": new ProviderFault(
          "provider_request_failed",
          "Provider metadata was not valid JSON.",
        ),
      },
      { check: "discovery_request_failed", route: "/v1.0/sites/getAllSites" },
    ],
  ];
  for (const [pages, evidence] of cases)
    await assert.rejects(discoverSharePoint(fakeGraph(pages)), {
      code: "preflight_failed",
      evidence,
    });
});

test("site-scoped discovery refuses with the missing tenant-wide grant before enumeration", async () => {
  const graph: GraphTransport = {
    async request() {
      throw new Error("Site-scoped discovery must not enumerate");
    },
    async *stream() {
      throw new Error("Discovery must not read bytes");
    },
    async evidence() {
      return { grantedPermissions: ["Sites.Selected"] };
    },
  };
  await assert.rejects(discoverSharePoint(graph), {
    code: "preflight_failed",
    evidence: { check: "discovery_requires_sites_read_all", requiredGrant: "Sites.Read.All" },
  });
});
