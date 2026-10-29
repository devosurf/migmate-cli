import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { parse, stringify } from "smol-toml";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import { fileConfig, fileFixture, value, approve } from "./engine-fixture.ts";

async function harness(t: TestContext, config: unknown = {}) {
  const home = await mkdtemp(join(tmpdir(), "migmate-adapters-"));
  const port = new FakeFileMigrationPort({
    ...fileFixture([
      {
        id: "file",
        parentId: "source-root",
        name: "file.txt",
        kind: "file",
        content: "provider pair",
      },
    ]),
    googleAbout: { user: { emailAddress: "operator@example.com" }, canCreateDrives: true },
  });
  const engine = openEngine({ home, provider: port });
  t.after(async () => {
    engine.close();
    await rm(home, { recursive: true, force: true });
  });
  const ref = value(await engine.initJob({ type: "file_migration", config }));
  return { home, port, engine, ref };
}

test("new file configurations refuse route and point to provider-pair fields", async (t) => {
  const h = await harness(t);
  for (const route of [
    "sharepoint_library_to_shared_drive",
    "shared_drive_to_sharepoint_library",
    "other",
  ]) {
    const result = await h.engine.initJob({ type: "file_migration", config: { route } });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("route accepted");
    assert.equal(result.refusal.code, "configuration_invalid");
    assert.equal(result.refusal.detail?.field, "route");
    assert.deepEqual(result.refusal.detail?.replacement, {
      sourceProvider: "sharepoint",
      destinationProvider: "google_shared_drive",
    });
  }
});

test("unshipped and same-provider pairs refuse before creating a job", async (t) => {
  const h = await harness(t);
  for (const [sourceProvider, destinationProvider] of [
    ["dropbox", "google_shared_drive"],
    ["google_shared_drive", "dropbox"],
    ["sharepoint", "sharepoint"],
    ["google_shared_drive", "google_shared_drive"],
  ]) {
    const result = await h.engine.initJob({
      type: "file_migration",
      config: { sourceProvider, destinationProvider },
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unsupported pair accepted");
    assert.equal(result.refusal.code, "unsupported_route");
  }
});

test("shared roles become native Google grants while supported native roles retain meaning", async (t) => {
  const h = await harness(t, {
    sourceProvider: "sharepoint",
    destinationProvider: "google_shared_drive",
  });
  const roles = ["reader", "writer", "manager", "commenter", "fileOrganizer", "organizer"];
  value(
    await h.engine.withWriterResult(h.ref, (writer) =>
      writer.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [
            {
              id: "mapping",
              source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
              destination: { type: "google_shared_drive", create: "Adapter roles" },
              members: roles.map((role) => ({
                email: `${role.toLowerCase()}@example.com`,
                type: "user",
                role,
              })),
            },
          ],
        }),
      }),
    ),
  );
  await approve(h);
  value(await h.engine.withWriterResult(h.ref, (writer) => writer.execute()));
  const drives = await h.port.findSharedDrives("Adapter roles");
  assert.equal(drives.length, 1);
  const members = await h.port.listDriveMembers(drives[0]!.id);
  for (const role of roles)
    assert.equal(
      members.find((member) => member.email === `${role.toLowerCase()}@example.com`)?.role,
      role === "manager" ? "organizer" : role,
    );
});

test("a destination-unrepresentable role refuses at manifest load", async (t) => {
  const h = await harness(t, {
    sourceProvider: "google_shared_drive",
    destinationProvider: "sharepoint",
  });
  const result = await h.engine.withWriterResult(h.ref, (writer) =>
    writer.loadManifest({
      format: "json",
      content: JSON.stringify({
        version: 1,
        mappings: [
          {
            id: "mapping",
            source: {
              type: "google_shared_drive",
              driveId: "source-drive",
              folderId: "source-root",
            },
            destination: { type: "sharepoint", driveId: "destination-drive", folderPath: "" },
            members: [{ email: "reviewer@example.com", type: "user", role: "commenter" }],
          },
        ],
      }),
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unrepresentable role accepted");
  assert.equal(result.refusal.code, "configuration_invalid");
  assert.equal(result.refusal.detail?.field, "members.0.role");
  assert.equal(value(await h.engine.reader(h.ref).status()).planRevision, null);
});

test("route-named stored configuration and frozen plan remain readable without rewriting evidence", async (t) => {
  const h = await harness(t, fileConfig());
  await approve(h);
  value(await h.engine.withWriterResult(h.ref, (writer) => writer.execute()));
  value(await h.engine.withWriterResult(h.ref, (writer) => writer.verify()));
  const before = value(await h.engine.reader(h.ref).status());
  const directory = join(h.home, "jobs", h.ref.id);
  const configPath = join(directory, "job.toml");
  const configuration = parse(await readFile(configPath, "utf8"));
  delete configuration.sourceProvider;
  delete configuration.destinationProvider;
  configuration.route = "sharepoint_library_to_shared_drive";
  const legacyToml = stringify(configuration);
  await writeFile(configPath, legacyToml, { mode: 0o600 });
  // Restore the authority encoding used before #110, not a new operator configuration.
  const db = new DatabaseSync(join(directory, "state.db"));
  try {
    const input = db
      .prepare("SELECT value FROM plan_input WHERE rev=1 AND key='configuration'")
      .get();
    assert.ok(input);
    const frozen = JSON.parse(String(input.value));
    delete frozen.sourceProvider;
    delete frozen.destinationProvider;
    frozen.route = configuration.route;
    db.prepare("UPDATE plan_input SET value=? WHERE rev=1 AND key='configuration'").run(
      JSON.stringify(frozen),
    );
  } finally {
    db.close();
  }
  const status = value(await h.engine.reader(h.ref).status());
  assert.equal(status.planDigest, before.planDigest);
  assert.equal(status.verificationDigest, before.verificationDigest);
  const report = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
  const json = report.artifacts.find((artifact) => artifact.name === "report.json");
  assert.ok(json);
  assert.match(await readFile(json.path, "utf8"), /sharepoint_library_to_shared_drive/);
  assert.equal(await readFile(configPath, "utf8"), legacyToml);
});
