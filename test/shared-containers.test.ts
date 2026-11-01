import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { parse } from "csv-parse/sync";
import { openEngine, type Engine, type JobRef } from "../src/engine/index.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import type { FileMigrationConfig } from "../src/engine/drivers/file-migration.ts";
import type { FileProviderId } from "../src/engine/providers/adapters/capabilities.ts";
import { fileFixture, value, approve, closeDecision } from "./engine-fixture.ts";

// ADR-0020 D5: mappings naming one creation share one container, each in its own folder.

const now = "2026-09-01T00:00:00.000Z";
const members = [{ email: "team@example.com", type: "group", role: "writer" }];

function fixture(): FakeFileMigrationFixture {
  return fileFixture([
    { id: "alpha", parentId: "source-root", name: "alpha", kind: "folder" },
    { id: "alpha-file", parentId: "alpha", name: "a.txt", kind: "file", content: "alpha" },
    { id: "beta", parentId: "source-root", name: "beta", kind: "folder" },
    { id: "beta-file", parentId: "beta", name: "b.txt", kind: "file", content: "beta" },
    { id: "gamma", parentId: "source-root", name: "gamma", kind: "folder" },
    { id: "gamma-file", parentId: "gamma", name: "c.txt", kind: "file", content: "gamma" },
  ]);
}

interface Harness {
  destination: Destination;
  home: string;
  engine: Engine;
  ref: JobRef;
  port: FakeFileMigrationPort;
}

interface Row {
  id: string;
  source: string;
  folderPath?: string;
  members?: typeof members;
  filesOnly?: true;
}

type Destination = Extract<FileProviderId, "google_shared_drive" | "sharepoint" | "dropbox">;

function manifest(rows: Row[], destination: Destination = "google_shared_drive") {
  return JSON.stringify({
    version: 1,
    mappings: rows.map((row) => ({
      id: row.id,
      // Each source folder's id is its name; SharePoint destinations read from Google.
      source:
        destination === "sharepoint"
          ? { type: "google_shared_drive", driveId: "source-drive", folderId: row.source }
          : { type: "sharepoint", driveId: "source-drive", folderPath: row.source },
      destination: {
        type: destination,
        create: "Team",
        ...(destination === "sharepoint" ? { siteId: "site-1" } : {}),
        ...(row.folderPath ? { folderPath: row.folderPath } : {}),
      },
      // Dropbox names its groups by ID, never by address.
      members:
        row.members ??
        (destination === "dropbox"
          ? [{ groupId: "g:1a2b3c", type: "group", role: "editor" }]
          : members),
      ...(row.filesOnly ? { filesOnly: true } : {}),
    })),
  });
}

async function harness(
  t: TestContext,
  rows: Row[],
  destination: Destination = "google_shared_drive",
  options: FileMigrationConfig["options"] = {
    memberGrants: "after_verification",
    consistencyIntervalMs: 0,
  },
): Promise<Harness> {
  const input = fixture();
  input.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
  input.now = () => new Date(now);
  if (destination !== "google_shared_drive") input.destinationProvider = destination;
  if (destination === "sharepoint") input.sharepointMembershipAvailable = true;
  const home = await mkdtemp(join(tmpdir(), "migmate-shared-357-"));
  const port = new FakeFileMigrationPort(input);
  const engine = openEngine({ home, now: () => new Date(now), provider: port });
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      config:
        destination === "google_shared_drive"
          ? { mappings: [], options }
          : {
              sourceProvider: destination === "sharepoint" ? "google_shared_drive" : "sharepoint",
              destinationProvider: destination,
              options,
            },
    }),
  );
  const h = { destination, home, engine, ref, port };
  t.after(async () => {
    h.engine.close();
    await rm(home, { recursive: true, force: true });
  });
  value(await load(h, rows));
  return h;
}

async function load(h: Harness, rows: Row[]) {
  return h.engine.withWriterResult(h.ref, (w) =>
    w.loadManifest({ format: "json", content: manifest(rows, h.destination) }),
  );
}

async function execute(h: Harness) {
  value(value(await h.engine.withWriter(h.ref, (w) => w.execute())));
}

async function status(h: Harness) {
  return value(await h.engine.reader(h.ref).status());
}

function count(h: Harness, prefix: string): number {
  return h.port.calls.filter((entry) => entry.startsWith(prefix)).length;
}

/** Names of the container root's children, then each child's. */
async function tree(h: Harness, rootId: string): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const child of await h.port.listDestinationChildren(rootId))
    result[child.name] = (await h.port.listDestinationChildren(child.id)).map((c) => c.name);
  return result;
}

const shared: Row[] = [
  { id: "alpha", source: "alpha", folderPath: "Alpha" },
  { id: "beta", source: "beta", folderPath: "Nested/Beta" },
];

async function sharedLifecycle(t: TestContext, destination: Destination) {
  const h = await harness(t, shared, destination);
  await approve(h);
  await execute(h);
  const executed = await status(h);
  assert.equal(count(h, "createDestinationContainer:"), 1);
  assert.equal(executed.createdDrives.length, 1);
  const drive = executed.createdDrives[0]!;
  assert.equal(drive.mappingId, "alpha");
  const root = drive.rootFolderId ?? drive.driveId!;
  assert.deepEqual(await tree(h, root), { Alpha: ["a.txt"], Nested: ["Beta"] });
  const nested = (await h.port.listDestinationChildren(root)).find((c) => c.name === "Nested")!;
  const beta = (await h.port.listDestinationChildren(nested.id))[0]!;
  assert.deepEqual(
    (await h.port.listDestinationChildren(beta.id)).map((c) => c.name),
    ["b.txt"],
  );
  assert.deepEqual(executed.memberGrants, []);
  const isolated = (await h.port.listDriveMembers(drive.driveId!)).length;
  assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
  value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
  const closed = await status(h);
  assert.equal(closed.state, "closed");
  // One grant, one fence, one go-live check for the shared container.
  assert.deepEqual(
    closed.memberGrants.map((grant) => [grant.mappingId, grant.member.email]),
    [["alpha", destination === "dropbox" ? "g:1a2b3c" : "team@example.com"]],
  );
  assert.equal(count(h, "addDriveMember:"), 1);
  assert.equal(closed.createdDrives.length, 1);
  assert.ok(closed.createdDrives[0]!.goLive);
  assert.equal((await h.port.listDriveMembers(drive.driveId!)).length, isolated + 1);
  const artifacts = value(await h.engine.reader(h.ref).artifacts());
  const rows: Record<string, string>[] = parse(
    await readFile(artifacts.artifacts.find((a) => a.name === "mappings.csv")!.path, "utf8"),
    { columns: true },
  );
  assert.deepEqual(
    rows.map((row) => [row.mapping_id, row.destination_folder_path]),
    [
      ["alpha", "Alpha"],
      ["beta", "Nested/Beta"],
    ],
  );
  for (const row of rows) assert.equal(JSON.parse(row.go_live_member_grants!).length, 1);
}

for (const destination of ["google_shared_drive", "sharepoint", "dropbox"] as const)
  it(`two mappings share one created ${destination} container through copy, verify and close`, (t) =>
    sharedLifecycle(t, destination));

// The draft discover proposes for a split boundary: its loose files at the container root,
// files-only, beside a subfolder mapping. Go-live proof must still cover the whole container.
for (const order of ["first", "last"] as const)
  it(`staged close proves the whole container when its ${order} mapping is files-only`, async (t) => {
    const rows: Row[] = [
      { id: order === "first" ? "a-loose" : "z-loose", source: "", filesOnly: true },
      { id: "m-alpha", source: "alpha", folderPath: "alpha" },
    ];
    const h = await harness(t, rows);
    await approve(h);
    await execute(h);
    assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    assert.equal((await status(h)).state, "closed");
  });

it("staged close refuses drift in a subfolder of a container whose root mapping is files-only", async (t) => {
  const h = await harness(t, [{ id: "loose", source: "", filesOnly: true }]);
  await approve(h);
  await execute(h);
  assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
  // A folder outside every mapping, yet inside the container members are about to see.
  const drive = (await status(h)).createdDrives[0]!;
  const root = drive.rootFolderId ?? drive.driveId!;
  await h.port.createDestinationFolder({
    parentFolderId: root,
    name: "planted",
    createdAt: now,
    modifiedAt: now,
  });
  const closed = await h.engine.withWriterResult(h.ref, async (w) =>
    w.close(await closeDecision(h)),
  );
  assert.equal(closed.ok, false);
  assert.equal(!closed.ok && closed.refusal.detail?.check, "destination_drift");
  assert.notEqual((await status(h)).state, "closed");
});

it("a crash after creating a mapping folder resumes without a duplicate", async (t) => {
  const h = await harness(t, shared);
  await approve(h);
  h.port.scriptEffect({
    method: "createDestinationFolder",
    timing: "after",
    count: 1,
    error: new Error("folder crash"),
  });
  await assert.rejects(
    h.engine.withWriterResult(h.ref, (w) => w.execute()),
    /folder crash/,
  );
  h.engine.close();
  h.engine = openEngine({ home: h.home, provider: h.port, now: () => new Date(now) });
  await execute(h);
  const drive = (await status(h)).createdDrives[0]!;
  assert.equal(count(h, "createDestinationContainer:"), 1);
  assert.deepEqual(await tree(h, drive.rootFolderId ?? drive.driveId!), {
    Alpha: ["a.txt"],
    Nested: ["Beta"],
  });
  assert.deepEqual(Object.keys(drive.folders ?? {}).sort(), ["Alpha", "Nested", "Nested/Beta"]);
});

it("a later revision adds a mapping into the existing container", async (t) => {
  const h = await harness(t, [shared[0]!]);
  await approve(h);
  await execute(h);
  value(await load(h, [...shared, { id: "gamma", source: "gamma", folderPath: "Gamma" }]));
  await approve(h);
  await execute(h);
  const after = await status(h);
  assert.equal(count(h, "createDestinationContainer:"), 1);
  assert.equal(after.createdDrives.length, 1);
  const drive = after.createdDrives[0]!;
  assert.deepEqual(await tree(h, drive.rootFolderId ?? drive.driveId!), {
    Alpha: ["a.txt"],
    Gamma: ["c.txt"],
    Nested: ["Beta"],
  });
});

it("a mapping joining an existing container must name its members", async (t) => {
  const h = await harness(t, [shared[0]!]);
  await approve(h);
  await execute(h);
  const refused = await h.engine.withWriterResult(h.ref, (w) =>
    w.loadManifest({
      format: "json",
      // The existing row is dropped, so only the stored container can disagree.
      content: manifest([
        {
          id: "gamma",
          source: "gamma",
          folderPath: "Gamma",
          members: [{ email: "other@example.com", type: "group", role: "writer" }],
        },
      ]),
    }),
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.refusal.code, "configuration_invalid");
    assert.equal(refused.refusal.detail?.field, "members");
  }
});

it("a joining mapping never adopts a same-named folder holding content", async (t) => {
  const h = await harness(t, [shared[0]!], "google_shared_drive", { memberGrants: "before_copy" });
  await approve(h);
  await execute(h);
  const drive = (await status(h)).createdDrives[0]!;
  // A member of the live container made this folder; it is not the job's.
  const foreign = await h.port.createDestinationFolder({
    parentFolderId: drive.driveId!,
    name: "Gamma",
    createdAt: now,
    modifiedAt: now,
  });
  await h.port.uploadDestinationContent({
    parentFolderId: foreign.id,
    name: "notes.txt",
    content: new TextEncoder().encode("theirs"),
    createdAt: now,
    modifiedAt: now,
    mimeType: "text/plain",
  });
  value(await load(h, [shared[0]!, { id: "gamma", source: "gamma", folderPath: "Gamma" }]));
  await approve(h);
  const refused = await h.engine.withWriterResult(h.ref, (w) => w.execute());
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.refusal.code, "drive_creation_ambiguous");
    assert.equal(refused.refusal.detail?.reason, "mapping_folder_taken");
  }
  assert.deepEqual(
    (await h.port.listDestinationChildren(foreign.id)).map((c) => c.name),
    ["notes.txt"],
  );
});
