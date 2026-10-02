import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSharePoint } from "./discovery.ts";
import type { GraphTransport } from "./http.ts";

test("discovery follows site and library pages and drafts one drive per document library", async () => {
  const pages: Record<string, unknown> = {
    "/v1.0/sites/getAllSites": {
      value: [{ id: "site-a", displayName: "Research" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/getAllSites?$skiptoken=sites-2",
    },
    "https://graph.microsoft.com/v1.0/sites/getAllSites?$skiptoken=sites-2": {
      value: [{ id: "site-b", displayName: "Operations" }],
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
    { id: "site-b", name: "Operations", libraries: [{ id: "drive-c", name: "Documents" }] },
  ]);
  assert.deepEqual(result.manifest, {
    version: 1,
    mappings: [
      {
        id: "drive-a",
        source: { type: "sharepoint", driveId: "drive-a", folderPath: "" },
        destination: { type: "google_shared_drive", create: "Research - Documents" },
        members: [],
      },
      {
        id: "drive-b",
        source: { type: "sharepoint", driveId: "drive-b", folderPath: "" },
        destination: { type: "google_shared_drive", create: "Research - Evidence" },
        members: [],
      },
      {
        id: "drive-c",
        source: { type: "sharepoint", driveId: "drive-c", folderPath: "" },
        destination: { type: "google_shared_drive", create: "Operations - Documents" },
        members: [],
      },
    ],
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
