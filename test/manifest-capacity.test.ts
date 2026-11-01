import assert from "node:assert/strict";
import { test } from "node:test";
import { ManifestError, parseManifest, type ManifestMapping } from "../src/engine/manifest.ts";

const source = (folderId: string) => ({
  type: "google_shared_drive",
  driveId: "src-drive",
  folderId,
});
function manifest(mappings: unknown[]): string {
  return JSON.stringify({ version: 1, mappings });
}
function refusal(content: string, format: "json" | "csv" = "json"): ManifestError {
  try {
    parseManifest(content, format);
  } catch (error) {
    assert.ok(error instanceof ManifestError);
    return error;
  }
  assert.fail("expected a manifest refusal");
}
const reader = [{ email: "team@example.com", type: "group", role: "reader" }];
function sharing(folderPath: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    source: source(`f-${(folderPath ?? "root").replace(/[^A-Za-z0-9]/gu, "_")}`),
    destination: {
      type: "sharepoint",
      create: "Finance",
      siteId: "site-1",
      ...(folderPath !== undefined ? { folderPath } : {}),
    },
    members: reader,
    ...extra,
  };
}

test("several mappings share one created container, each in its own folder", () => {
  const { mappings } = parseManifest(
    manifest([
      { id: "a", ...sharing("Team A") },
      { id: "b", ...sharing("Team B") },
    ]),
    "json",
  );
  assert.deepEqual(
    mappings.map((m) => m.destination),
    [
      { type: "sharepoint", create: "Finance", siteId: "site-1", folderPath: "Team A" },
      { type: "sharepoint", create: "Finance", siteId: "site-1", folderPath: "Team B" },
    ],
  );
});

test("a shared created container refuses differing members and overlapping folders", () => {
  assert.deepEqual(
    refusal(
      manifest([
        { id: "a", ...sharing("Team A") },
        { id: "b", ...sharing("Team B"), members: [] },
      ]),
    ).detail,
    { row: 2, field: "members" },
  );
  for (const [first, second] of [
    ["Team A", "Team A"],
    ["Team A", "team a"],
    ["Team A", "Team A/Sub"],
    [undefined, "Team B"],
  ] as const)
    assert.deepEqual(
      refusal(
        manifest([
          { id: "a", ...sharing(first) },
          { id: "b", ...sharing(second) },
        ]),
      ).detail,
      { row: 2, field: "destination.folderPath" },
      `${first} / ${second}`,
    );
  assert.deepEqual(refusal(manifest([{ id: "a", ...sharing("") }])).detail, {
    row: 1,
    field: "destination.folderPath",
  });
});

test("a files-only mapping's folder may hold other mappings' folders, never repeat them", () => {
  const { mappings } = parseManifest(
    manifest([
      { id: "loose", ...sharing(undefined, { filesOnly: true }) },
      { id: "a", ...sharing("Team A") },
    ]),
    "json",
  );
  assert.equal(mappings[0]!.filesOnly, true);
  assert.equal(mappings[1]!.filesOnly, undefined);
  assert.deepEqual(
    refusal(
      manifest([
        { id: "loose", ...sharing("Team A", { filesOnly: true }) },
        { id: "a", ...sharing("Team A") },
      ]),
    ).detail,
    { row: 2, field: "destination.folderPath" },
  );
  assert.deepEqual(refusal(manifest([{ id: "a", ...sharing("A", { filesOnly: "yes" }) }])).detail, {
    row: 1,
    field: "filesOnly",
  });
});

test("files-only mappings and container folders round-trip through CSV", () => {
  const header =
    "id,source.type,source.driveId,source.folderPath,destination.type,destination.driveId,destination.folderId,destination.create,members,source.folderId,destination.folderPath,destination.siteId,filesOnly";
  const csv = [
    header,
    `loose,google_shared_drive,src-drive,,sharepoint,,,Finance,"[{""email"":""team@example.com"",""type"":""group"",""role"":""reader""}]",f-root,,site-1,true`,
    `a,google_shared_drive,src-drive,,sharepoint,,,Finance,"[{""email"":""team@example.com"",""type"":""group"",""role"":""reader""}]",f-a,Team A,site-1,`,
  ].join("\n");
  const parsed = parseManifest(csv, "csv");
  const json = parseManifest(
    manifest([
      { id: "loose", ...sharing(undefined, { filesOnly: true }), source: source("f-root") },
      { id: "a", ...sharing("Team A"), source: source("f-a") },
    ]),
    "json",
  );
  assert.deepEqual(parsed.mappings, json.mappings satisfies ManifestMapping[]);
  assert.equal(parsed.digest, json.digest);
  assert.deepEqual(refusal(csv.replace(/,true$/mu, ",yes"), "csv").detail, {
    row: 1,
    field: "filesOnly",
  });
});

test("Dropbox CSV headers load with or without the filesOnly column", () => {
  const header =
    "id,source.type,source.namespaceId,source.folderPath,destination.type,destination.driveId,destination.folderId,destination.create,members,source.folderId,destination.folderPath,destination.siteId";
  const row = "m1,dropbox,123,Team,google_shared_drive,,,Team,[],,,";
  const twelve = parseManifest(`${header}\n${row}\n`, "csv");
  const thirteen = parseManifest(`${header},filesOnly\n${row},\n`, "csv");
  assert.deepEqual(twelve.mappings, thirteen.mappings);
});
