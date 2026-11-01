import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { openEngine, type Engine, type JobRef } from "../src/engine/index.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import type { FileMigrationConfig } from "../src/engine/drivers/file-migration.ts";
import { approve, fileFixture, value } from "./engine-fixture.ts";

// ADR-0020 D4: a files-only mapping covers only the files directly inside its root.
const now = "2026-11-01T00:00:00.000Z";
const options = { consistencyIntervalMs: 0 };

interface Harness {
  engine: Engine;
  ref: JobRef;
  port: FakeFileMigrationPort;
}

async function harness(
  t: TestContext,
  input: FakeFileMigrationFixture,
  mappings: unknown[],
  config: Partial<FileMigrationConfig> = {},
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "migmate-files-only-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  input.googleAbout ??= { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
  input.now ??= () => new Date(now);
  const port = new FakeFileMigrationPort(input);
  const engine = openEngine({ home, now: () => new Date(now), provider: port });
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      config: { options, ...config, mappings: [] },
    }),
  );
  value(await load({ engine, ref, port }, mappings));
  return { engine, ref, port };
}

function load(h: Harness, mappings: unknown[]) {
  return h.engine.withWriterResult(h.ref, (writer) =>
    writer.loadManifest({ format: "json", content: JSON.stringify({ version: 1, mappings }) }),
  );
}

async function execute(h: Harness): Promise<void> {
  value(value(await h.engine.withWriter(h.ref, (writer) => writer.execute())));
}

function source(folderPath: string) {
  return { type: "sharepoint", driveId: "source-drive", folderPath };
}
function existing(folderId: string) {
  return { type: "google_shared_drive", driveId: "destination-drive", folderId };
}

/** A root whose subfolder `sub` is split into its own mapping, beside folders the job never maps. */
function split(): FakeFileMigrationFixture {
  const input = fileFixture([
    { id: "a", parentId: "source-root", name: "a.txt", kind: "file", content: "a" },
    { id: "b", parentId: "source-root", name: "b.txt", kind: "file", content: "b" },
    { id: "sub", parentId: "source-root", name: "sub", kind: "folder" },
    { id: "s", parentId: "sub", name: "s.txt", kind: "file", content: "s" },
    { id: "deep", parentId: "sub", name: "deep", kind: "folder" },
    { id: "d", parentId: "deep", name: "d.txt", kind: "file", content: "d" },
    { id: "empty", parentId: "source-root", name: "empty", kind: "folder" },
  ]);
  input.destinationItems.push(
    { id: "dest-sub", parentId: "destination-root", name: "Sub", kind: "folder" },
    { id: "other", parentId: "destination-root", name: "other", kind: "folder" },
    { id: "other-file", parentId: "other", name: "o.txt", kind: "file", content: "o" },
  );
  return input;
}
const splitMappings = [
  { id: "top", filesOnly: true, source: source(""), destination: existing("destination-root") },
  { id: "sub", source: source("sub"), destination: existing("dest-sub") },
];

function paths(h: Harness, root?: string): string[] {
  return h.port
    .snapshotDestination(root)
    .map((item) => item.path)
    .sort();
}

async function findings(h: Harness, phase: "execute" | "verify") {
  const page = value(await h.engine.reader(h.ref).rows({ phase, limit: 1000 }));
  return page.rows
    .filter((row) => row.jobType === "file_migration" && row.kind !== "policy_outcome")
    .map((row) => (row.jobType === "file_migration" ? [row.mappingId, row.relativePath] : []))
    .sort();
}

describe("files-only mappings", () => {
  it("copies and verifies only the root's direct files beside a mapping of its subfolder", async (t) => {
    const h = await harness(t, split(), splitMappings);
    const digest = await approve(h);
    const planned = value(await h.engine.reader(h.ref).rows({ phase: "plan" })).rows;
    assert.deepEqual(
      planned.map((row) =>
        row.jobType === "file_migration" ? [row.mappingId, row.filesOnly ?? false] : [],
      ),
      [
        ["sub", false],
        ["top", true],
      ],
    );
    assert.ok(digest);
    await execute(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.state, "verified");
    assert.deepEqual(status.outstandingFindings, []);
    // No `sub` or `empty` beside the direct files: the source's folders are not top's.
    assert.deepEqual(paths(h), [
      ".",
      "Sub",
      "Sub/deep",
      "Sub/deep/d.txt",
      "Sub/s.txt",
      "a.txt",
      "b.txt",
      "other",
      "other/o.txt",
    ]);
    const rows = value(await h.engine.reader(h.ref).rows({ phase: "verify", limit: 1000 })).rows;
    const top = rows
      .filter((row) => row.jobType === "file_migration" && row.mappingId === "top")
      .map((row) => (row.jobType === "file_migration" ? [row.relativePath, row.code] : []))
      .sort();
    // Destination folders belong to other mappings: none is retained, compared or missing.
    assert.deepEqual(top, [
      [".", "unchanged"],
      ["a.txt", "unchanged"],
      ["b.txt", "unchanged"],
    ]);
    const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
    const json = JSON.parse(
      await readFile(report.artifacts.find((a) => a.name === "report.json")!.path, "utf8"),
    );
    const section = (title: string) =>
      json.sections.find((item: { title: string }) => item.title === title).body;
    assert.equal(JSON.parse(section("Mapping top")).scope, "files_only");
    assert.equal(JSON.parse(section("Mapping sub")).scope, "recursive");
    assert.match(section("Approval and verification"), /Files-only mappings \(top\)/);
  });

  it("flags only its own missing or extra direct files", async (t) => {
    const input = split();
    input.destinationItems.push({
      id: "extra",
      parentId: "destination-root",
      name: "extra.txt",
      kind: "file",
      content: "x",
    });
    const h = await harness(t, input, splitMappings);
    await approve(h);
    await execute(h);
    const copied = new Map(h.port.snapshotDestination().map((item) => [item.path, item.id]));
    h.port.removeDestinationItem(copied.get("a.txt")!);
    h.port.removeDestinationItem(copied.get("other/o.txt")!);
    const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verified.clean, false);
    const rows = value(await h.engine.reader(h.ref).rows({ phase: "verify", limit: 1000 })).rows;
    assert.deepEqual(
      rows
        .filter((row) => row.jobType === "file_migration" && row.code !== "unchanged")
        .map((row) => (row.jobType === "file_migration" ? [row.relativePath, row.code] : []))
        .sort(),
      [
        ["a.txt", "destination_missing"],
        ["extra.txt", "destination_only_retained"],
      ],
    );
  });

  it("repeats a pass with only the root's current direct files", async (t) => {
    const h = await harness(t, split(), splitMappings);
    await approve(h);
    await execute(h);
    h.port.mutateSourceItem("a", { content: "a newer a" });
    h.port.deleteSourceItem("b");
    // A file moved up from the split folder becomes top's, and leaves sub's scope.
    h.port.mutateSourceItem("s", { parentId: "source-root" });
    h.port.mutateSourceItem("d", { content: "a newer d" });
    await approve(h);
    await execute(h);
    const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verified.clean, true);
    assert.deepEqual(paths(h), [
      ".",
      "Sub",
      "Sub/deep",
      "Sub/deep/d.txt",
      "Sub/s.txt",
      "a.txt",
      "b.txt",
      "other",
      "other/o.txt",
      "s.txt",
    ]);
    const content = async (path: string) => {
      const item = h.port.snapshotDestination().find((entry) => entry.path === path)!;
      const chunks: Uint8Array[] = [];
      for await (const chunk of h.port.streamDestinationContent(item.id)) chunks.push(chunk);
      return Buffer.concat(chunks).toString();
    };
    assert.equal(await content("a.txt"), "a newer a");
    assert.equal(await content("Sub/deep/d.txt"), "a newer d");
    const retained = value(
      await h.engine.reader(h.ref).rows({ phase: "verify", codes: ["destination_only_retained"] }),
    ).rows;
    assert.deepEqual(
      retained
        .map((row) => (row.jobType === "file_migration" ? [row.mappingId, row.relativePath] : []))
        .sort(),
      [
        ["sub", "s.txt"],
        ["top", "b.txt"],
      ],
    );
  });

  it("mirrors only extra direct files, never the folders of a created container", async (t) => {
    const input = fileFixture([
      { id: "a", parentId: "source-root", name: "a.txt", kind: "file", content: "a" },
      { id: "b", parentId: "source-root", name: "b.txt", kind: "file", content: "b" },
      { id: "sub", parentId: "source-root", name: "sub", kind: "folder" },
      { id: "s", parentId: "sub", name: "s.txt", kind: "file", content: "s" },
    ]);
    const h = await harness(
      t,
      input,
      [
        {
          id: "finance",
          filesOnly: true,
          source: source(""),
          destination: { type: "google_shared_drive", create: "Finance" },
          members: [{ email: "finance@example.com", type: "group", role: "writer" }],
        },
      ],
      { options: { ...options, mirror: true, deleteLimit: 5 } },
    );
    await approve(h);
    await execute(h);
    const drive = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
    const root = drive.rootFolderId ?? drive.driveId!;
    assert.deepEqual(paths(h, root), [".", "a.txt", "b.txt"]);
    // Folders another mapping or person put in the container, and one empty one.
    const team = await h.port.createDestinationFolder({
      parentFolderId: root,
      name: "Team A",
      createdAt: now,
      modifiedAt: now,
    });
    for (const [parentFolderId, name] of [
      [team.id, "kept.txt"],
      [root, "stale.txt"],
    ] as const)
      await h.port.uploadDestinationContent({
        parentFolderId,
        name,
        content: new Uint8Array([1]),
        createdAt: now,
        modifiedAt: now,
        mimeType: null,
      });
    await h.port.createDestinationFolder({
      parentFolderId: root,
      name: "Empty",
      createdAt: now,
      modifiedAt: now,
    });
    h.port.deleteSourceItem("b");
    await approve(h);
    await execute(h);
    const deletions = value(await h.engine.reader(h.ref).rows({ phase: "execute", limit: 100 }));
    assert.deepEqual(
      deletions.rows.map((row) =>
        row.jobType === "file_migration" ? [row.relativePath, row.code] : [],
      ),
      [
        ["b.txt", "to_be_deleted"],
        ["stale.txt", "to_be_deleted"],
      ],
    );
    assert.deepEqual(paths(h, root), [".", "Empty", "Team A", "Team A/kept.txt", "a.txt"]);
    const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verified.clean, true);
    assert.deepEqual(verified.findings, []);
    assert.deepEqual(await findings(h, "verify"), []);
  });

  it("raises nothing for content inside a files-only root's folders", async (t) => {
    const input = fileFixture([
      { id: "a", parentId: "source-root", name: "a.txt", kind: "file", content: "a" },
      { id: "folder", parentId: "source-root", name: "documents", kind: "folder" },
      {
        id: "unsupported",
        parentId: "folder",
        name: "unavailable.paper",
        kind: "undownloadable",
        metadata: { contentDisposition: "unsupported_export" },
      },
    ]);
    const h = await harness(
      t,
      input,
      [
        {
          id: "top",
          filesOnly: true,
          source: { type: "dropbox", namespaceId: "source-drive", folderPath: "" },
          destination: existing("destination-root"),
        },
      ],
      { sourceProvider: "dropbox", destinationProvider: "google_shared_drive" },
    );
    await approve(h);
    await execute(h);
    const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verified.clean, true);
    assert.deepEqual(await findings(h, "verify"), []);
    assert.deepEqual(paths(h), [".", "a.txt"]);
  });

  it("ignores duplicate destination names inside its folders", async (t) => {
    const input = fileFixture([
      { id: "a", parentId: "source-root", name: "a.txt", kind: "file", content: "a" },
      { id: "folder", parentId: "source-root", name: "split", kind: "folder" },
      { id: "upper", parentId: "folder", name: "X.txt", kind: "file", content: "1" },
      { id: "lower", parentId: "folder", name: "x.txt", kind: "file", content: "2" },
    ]);
    input.destinationItems[0]!.webUrl = "https://fake.sharepoint.com/sites/Existing/Documents";
    const mapping = (filesOnly: boolean) => ({
      id: "top",
      ...(filesOnly ? { filesOnly: true } : {}),
      source: { type: "google_shared_drive", driveId: "source-drive", folderId: "source-root" },
      destination: { type: "sharepoint", driveId: "destination-drive", folderPath: "" },
    });
    const route = {
      sourceProvider: "google_shared_drive",
      destinationProvider: "sharepoint",
    } as const;
    // The same tree blocks as a recursive mapping: SharePoint names are case-insensitive.
    const recursive = await harness(t, structuredClone(input), [mapping(false)], route);
    value(await recursive.engine.withWriterResult(recursive.ref, (w) => w.plan()));
    const plan = value(await recursive.engine.reader(recursive.ref).rows({ phase: "plan" }));
    assert.ok(plan.rows.some((row) => row.code === "destination_duplicate_name"));
    const h = await harness(t, input, [mapping(true)], route);
    await approve(h);
    const planned = value(await h.engine.reader(h.ref).rows({ phase: "plan" })).rows;
    assert.deepEqual(
      planned.map((row) => row.code),
      ["unchanged"],
    );
    await execute(h);
    assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
    assert.deepEqual(paths(h), [".", "a.txt"]);
  });
});

describe("files-only mapping trees", () => {
  async function refusal(t: TestContext, mappings: unknown[]) {
    const h = await harness(t, split(), splitMappings);
    const result = await load(h, mappings);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Overlapping manifest loaded");
    assert.equal(result.refusal.code, "configuration_invalid");
    assert.match(result.refusal.message, /overlap/i);
    return result.refusal.detail?.field;
  }

  it("lets a root sit beneath a files-only root on both sides", async (t) => {
    const h = await harness(t, split(), [
      { id: "top", filesOnly: true, source: source(""), destination: existing("destination-root") },
      { id: "sub", filesOnly: true, source: source("sub"), destination: existing("dest-sub") },
      { id: "deep", source: source("sub/deep"), destination: existing("other") },
    ]);
    await approve(h);
  });

  it("refuses equal roots and roots beneath a recursive root", async (t) => {
    // Equal roots overlap whatever their scope.
    assert.equal(
      await refusal(t, [
        {
          id: "top",
          filesOnly: true,
          source: source(""),
          destination: existing("destination-root"),
        },
        { id: "same", source: source(""), destination: existing("dest-sub") },
      ]),
      "source",
    );
    assert.equal(
      await refusal(t, [
        {
          id: "top",
          filesOnly: true,
          source: source(""),
          destination: existing("destination-root"),
        },
        { id: "same", source: source("sub"), destination: existing("destination-root") },
      ]),
      "destination",
    );
    // A files-only root beneath a recursive root is still inside it.
    assert.equal(
      await refusal(t, [
        { id: "top", source: source(""), destination: existing("destination-root") },
        { id: "sub", filesOnly: true, source: source("sub"), destination: existing("other") },
      ]),
      "source",
    );
    // Passing a files-only root does not excuse a recursive ancestor above it.
    assert.equal(
      await refusal(t, [
        { id: "top", source: source("sub/deep"), destination: existing("destination-root") },
        { id: "mid", filesOnly: true, source: source("sub"), destination: existing("dest-sub") },
      ]),
      "destination",
    );
  });
});
