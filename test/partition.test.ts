import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest } from "../src/engine/manifest.ts";
import {
  defaultCapacityTarget,
  partition,
  subtreeItems,
  type DiscoveredBoundary,
  type DiscoveredFolder,
  type PartitionInput,
} from "../src/engine/partition.ts";

const team = [{ id: "dbg:finance", type: "group" as const, role: "editor" }];
const other = [{ id: "dbg:legal", type: "group" as const, role: "editor" }];

function folder(name: string, files: number, folders: DiscoveredFolder[] = []): DiscoveredFolder {
  return { name, files, folders };
}
function boundary(
  id: string,
  name: string,
  tree: DiscoveredFolder,
  members: DiscoveredBoundary["members"] = team,
): DiscoveredBoundary {
  return {
    id,
    kind: "dropbox_team_folder",
    name,
    root: { type: "dropbox", driveId: id, folderPath: "" },
    members,
    tree,
  };
}
function run(boundaries: DiscoveredBoundary[], options: Partial<PartitionInput> = {}) {
  return partition({
    discovery: {
      sourceProvider: "dropbox",
      observedAt: "2026-11-01T12:00:00.000Z",
      boundaries,
      notices: [],
    },
    destinationProvider: "google_shared_drive",
    hardLimit: 500_000,
    defaultTarget: 400_000,
    ...options,
  });
}
/** The draft must load as a manifest exactly as written. */
function loads(result: ReturnType<typeof run>) {
  return parseManifest(JSON.stringify(result.manifest), "json").mappings;
}
function rows(result: ReturnType<typeof run>) {
  return result.manifest.mappings.map((m) => {
    const destination = m.destination as { create: string; folderPath?: string };
    const source = m.source as { folderPath: string };
    return [
      source.folderPath,
      destination.create,
      destination.folderPath ?? "",
      m.filesOnly ? "files" : "tree",
    ];
  });
}

test("the default capacity target is 80% of the hard limit", () => {
  assert.equal(defaultCapacityTarget(500_000), 400_000);
  assert.equal(defaultCapacityTarget(null), null);
  assert.equal(subtreeItems(folder("", 3, [folder("a", 2), folder("b", 0, [folder("c", 1)])])), 9);
});

test("a boundary that fits maps whole to a container of its own at the root", () => {
  const result = run([boundary("ns1", "Finance", folder("", 10, [folder("Q1", 5)]))]);
  assert.deepEqual(rows(result), [["", "Finance", "", "tree"]]);
  assert.deepEqual(result.manifest.mappings[0]!.source, {
    type: "dropbox",
    folderPath: "",
    namespaceId: "ns1",
  });
  assert.deepEqual(result.containers, [
    {
      name: "Finance",
      items: 16,
      target: 400_000,
      boundaries: ["ns1"],
      mappings: [result.manifest.mappings[0]!.id],
      sourceMembers: team,
      overTarget: false,
    },
  ]);
  loads(result);
});

test("an oversize boundary splits by subfolder and a files-only mapping carries its loose files", () => {
  const tree = folder("", 7, [
    folder("2019", 200_000),
    folder("2020", 150_000),
    folder("Archive", 0, [folder("Old", 250_000), folder("Older", 200_000)]),
  ]);
  const result = run([boundary("ns1", "Engineering", tree)]);
  assert.deepEqual(rows(result), [
    ["", "Engineering (part 1 of 3)", "", "files"],
    ["2019", "Engineering (part 1 of 3)", "2019", "tree"],
    ["2020", "Engineering (part 1 of 3)", "2020", "tree"],
    ["Archive/Old", "Engineering (part 2 of 3)", "Archive/Old", "tree"],
    ["Archive/Older", "Engineering (part 3 of 3)", "Archive/Older", "tree"],
  ]);
  // Loose files, each mapping's folder and the intermediate Archive folder all count.
  assert.deepEqual(
    result.containers.map((c) => [c.items, c.overTarget]),
    [
      [350_009, false],
      [250_002, false],
      [200_002, false],
    ],
  );
  const loaded = loads(result);
  assert.equal(loaded.filter((m) => m.filesOnly).length, 1);
});

test("a folder over the target on its own files stays whole and is flagged", () => {
  const result = run([boundary("ns1", "Scans", folder("", 0, [folder("Inbox", 450_000)]))]);
  assert.deepEqual(rows(result), [["Inbox", "Scans", "Inbox", "tree"]]);
  assert.equal(result.containers[0]!.overTarget, true);
  assert.match(result.notices.join("\n"), /over its target of 400000/u);
});

test("boundaries with identical membership share a container, each in its own folder", () => {
  const result = run([
    boundary("ns3", "Budgets", folder("", 100)),
    boundary("ns1", "Payroll", folder("", 100)),
    boundary("ns2", "Contracts", folder("", 100), other),
    boundary("ns4", "Payroll", folder("", 50)),
  ]);
  assert.deepEqual(rows(result), [
    ["", "Payroll and 2 more", "Payroll", "tree"],
    ["", "Payroll and 2 more", "Budgets", "tree"],
    ["", "Payroll and 2 more", "Payroll (2)", "tree"],
    ["", "Contracts", "", "tree"],
  ]);
  assert.deepEqual(
    result.containers.map((c) => [c.name, c.boundaries, c.items]),
    [
      ["Payroll and 2 more", ["ns1", "ns3", "ns4"], 253],
      ["Contracts", ["ns2"], 100],
    ],
  );
  loads(result);
});

test("unreadable membership never shares a container", () => {
  const result = run([
    boundary("ns1", "A", folder("", 1), null),
    boundary("ns2", "B", folder("", 1), null),
  ]);
  assert.deepEqual(
    result.containers.map((c) => c.boundaries),
    [["ns1"], ["ns2"]],
  );
  assert.match(result.notices.join("\n"), /2 boundaries could not be read/u);
});

test("a capacity override applies per boundary and separates otherwise shared containers", () => {
  const boundaries = [
    boundary("ns1", "Design", folder("", 100, [folder("Sync", 200), folder("Assets", 250)])),
    boundary("ns2", "Marketing", folder("", 100)),
  ];
  const shared = run(boundaries);
  assert.equal(shared.containers.length, 1);
  const overridden = run(boundaries, { targets: { ns1: 360 } });
  assert.deepEqual(rows(overridden), [
    ["", "Design (part 1 of 2)", "", "files"],
    ["Assets", "Design (part 1 of 2)", "Assets", "tree"],
    ["Sync", "Design (part 2 of 2)", "Sync", "tree"],
    ["", "Marketing", "", "tree"],
  ]);
  assert.deepEqual(
    overridden.containers.map((c) => c.target),
    [360, 360, 400_000],
  );
  const lowered = run(boundaries, { defaultTarget: 300 });
  assert.equal(
    lowered.containers.every((c) => c.target === 300),
    true,
  );
  loads(overridden);
});

test("a nested boundary is carved out of its parent, which splits around it", () => {
  const parent = boundary("ns1", "Clients", {
    ...folder("", 2, [folder("Acme", 5), folder("Globex", 0, [folder("Docs", 3)])]),
    nested: [],
  });
  parent.tree.folders[1]!.nested = ["ns9"];
  const child = { ...boundary("ns9", "Globex Private", folder("", 4), other), parent: "ns1" };
  const result = run([child, parent]);
  assert.deepEqual(rows(result), [
    ["", "Clients", "", "files"],
    ["Acme", "Clients", "Acme", "tree"],
    ["Globex/Docs", "Clients", "Globex/Docs", "tree"],
    ["", "Globex Private", "", "tree"],
  ]);
  loads(result);
});

test("the draft is deterministic: input order never changes it, and mapping ids are stable", () => {
  const boundaries = [
    boundary("ns2", "Beta", folder("", 1, [folder("b", 300_000), folder("a", 300_000)])),
    boundary("ns1", "Alpha", folder("", 5)),
  ];
  const first = run(boundaries);
  const second = run([...boundaries].reverse().map((b) => structuredClone(b)));
  assert.deepEqual(second, first);
  assert.match(first.manifest.mappings[0]!.id, /^alpha-[0-9a-f]{10}$/u);
  assert.match(first.manifest.mappings.find((m) => m.filesOnly)!.id, /^beta-[0-9a-f]{10}-files$/u);
});

test("without an established hard limit the draft splits only by boundary and says so", () => {
  const result = run([boundary("ns1", "Huge", folder("", 2_000_000))], {
    destinationProvider: "sharepoint",
    hardLimit: null,
    defaultTarget: null,
  });
  assert.deepEqual(rows(result), [["", "Huge", "", "tree"]]);
  assert.equal(result.containers[0]!.target, null);
  assert.match(result.notices.join("\n"), /No hard item limit is established for sharepoint/u);
  assert.match(result.notices.join("\n"), /destination\.siteId/u);
});

test("Google sources map split folders by id", () => {
  const tree: DiscoveredFolder = {
    name: "",
    id: "drive-1",
    files: 1,
    folders: [{ name: "Big", id: "folder-big", files: 450_000, folders: [] }],
  };
  const result = partition({
    discovery: {
      sourceProvider: "google_shared_drive",
      observedAt: "2026-11-01T12:00:00.000Z",
      boundaries: [
        {
          id: "drive-1",
          kind: "google_shared_drive",
          name: "Media",
          root: { type: "google_shared_drive", driveId: "drive-1", folderId: "drive-1" },
          members: team,
          tree,
        },
      ],
      notices: [],
    },
    destinationProvider: "dropbox",
    hardLimit: null,
    defaultTarget: 400_000,
  });
  assert.deepEqual(
    result.manifest.mappings.map((m) => [m.source, m.filesOnly ?? false]),
    [
      [{ type: "google_shared_drive", folderId: "drive-1", driveId: "drive-1" }, true],
      [{ type: "google_shared_drive", folderId: "folder-big", driveId: "drive-1" }, false],
    ],
  );
});
