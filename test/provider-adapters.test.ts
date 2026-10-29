import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { parse, stringify } from "smol-toml";
import { openEngine, type JobStatus } from "../src/engine/index.ts";
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

const manifestFormats: Array<"json" | "csv"> = ["json", "csv"];
for (const format of manifestFormats) {
  test(`unsupported manifest provider pairs retain their refusal in ${format}`, async (t) => {
    const h = await harness(t);
    for (const [source, destination] of [
      ["dropbox", "google_shared_drive"],
      ["google_shared_drive", "dropbox"],
      ["sharepoint", "sharepoint"],
      ["google_shared_drive", "google_shared_drive"],
    ]) {
      const content =
        format === "json"
          ? JSON.stringify({
              version: 1,
              mappings: [
                {
                  id: "mapping",
                  source: { type: source, driveId: "source-drive", folderId: "source-root" },
                  destination: {
                    type: destination,
                    driveId: "destination-drive",
                    folderId: "destination-root",
                  },
                },
              ],
            })
          : [
              "id,source.type,source.driveId,source.folderPath,destination.type,destination.driveId,destination.folderId,destination.create,members,source.folderId,destination.folderPath",
              [
                "mapping",
                source,
                "source-drive",
                "",
                destination,
                "destination-drive",
                "destination-root",
                "",
                "",
                "source-root",
                "",
              ].join(","),
            ].join("\n");
      const result = await h.engine.withWriterResult(h.ref, (writer) =>
        writer.loadManifest({ format, content }),
      );
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("Unsupported pair accepted");
      assert.equal(result.refusal.code, "unsupported_route", `${source} → ${destination}`);
    }
  });
}

async function historicalGoLiveHarness(t: TestContext) {
  // Captured by running a315893's real lifecycle through authorization and acknowledgment.
  // Restore evidence, not recomputed expected digests from the current implementation.
  const legacy: {
    config: string;
    status: Pick<
      JobStatus,
      | "jobId"
      | "planDigest"
      | "verificationDigest"
      | "currentApproval"
      | "closeAuthorization"
      | "goLiveAcknowledgments"
      | "closeReview"
      | "goLiveReview"
      | "createdDrives"
      | "incompleteClose"
    >;
    tables: Record<string, Array<Record<string, string | number | null>>>;
  } = JSON.parse(
    await readFile(new URL("./fixtures/route-named-go-live.json", import.meta.url), "utf8"),
  );
  const h = await harness(t);
  const initialDirectory = join(h.home, "jobs", h.ref.id);
  const database = new DatabaseSync(join(initialDirectory, "state.db"));
  try {
    const host = database.prepare("SELECT host_id FROM job").get()!.host_id;
    assert.ok(typeof host === "string");
    database.exec("PRAGMA foreign_keys=OFF; BEGIN");
    for (const table of database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all())
      database.exec(`DELETE FROM "${String(table.name)}"`);
    for (const [table, rows] of Object.entries(legacy.tables))
      for (const row of rows) {
        const columns = Object.keys(row);
        database
          .prepare(
            `INSERT INTO "${table}" (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(row));
      }
    database.prepare("UPDATE job SET host_id=?").run(host);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  const directory = join(h.home, "jobs", legacy.status.jobId);
  await rename(initialDirectory, directory);
  h.ref.id = legacy.status.jobId;
  await writeFile(join(directory, "job.toml"), legacy.config, { mode: 0o600 });
  return { ...h, directory, legacy };
}

test("historical close authorization and acknowledged go-live failures retain their interpretation", async (t) => {
  const h = await historicalGoLiveHarness(t);
  const status = value(await h.engine.reader(h.ref).status());
  assert.deepEqual(status.closeReview, h.legacy.status.closeReview);
  assert.deepEqual(status.closeAuthorization, h.legacy.status.closeAuthorization);
  assert.deepEqual(status.goLiveAcknowledgments, h.legacy.status.goLiveAcknowledgments);
  assert.deepEqual(status.goLiveReview, h.legacy.status.goLiveReview);
  assert.equal(status.planDigest, h.legacy.status.planDigest);
  assert.equal(status.verificationDigest, h.legacy.status.verificationDigest);
  assert.deepEqual(status.currentApproval, h.legacy.status.currentApproval);
  const report = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
  const reportJson = report.artifacts.find((artifact) => artifact.name === "report.json")!;
  const json = JSON.parse(await readFile(reportJson.path, "utf8"));
  const goLive = JSON.parse(
    json.sections.find((section: { title: string }) => section.title === "Go-live").body,
  );
  assert.equal(goLive.checksSettled, true);
  assert.equal(goLive.checksPassed, false);
  assert.deepEqual(goLive.acknowledgments, h.legacy.status.goLiveAcknowledgments);
  const exceptions = report.artifacts.find((artifact) => artifact.name === "exceptions.csv")!;
  assert.match(await readFile(exceptions.path, "utf8"), /acknowledged \(failed\)/);
  assert.equal(await readFile(join(h.directory, "job.toml"), "utf8"), h.legacy.config);
});

test("historical authorization survives equivalent provider-pair config and closes without another decision", async (t) => {
  const h = await historicalGoLiveHarness(t);
  const configuration = parse(h.legacy.config);
  delete configuration.route;
  configuration.sourceProvider = "sharepoint";
  configuration.destinationProvider = "google_shared_drive";
  await writeFile(join(h.directory, "job.toml"), stringify(configuration), { mode: 0o600 });
  const before = value(await h.engine.reader(h.ref).status());
  assert.equal(before.closeReview?.evidenceDigest, h.legacy.status.closeReview?.evidenceDigest);
  assert.equal(before.closeReview?.authorized, true);
  const closed = value(await h.engine.withWriterResult(h.ref, (writer) => writer.close()));
  assert.equal(closed.outcome, "completed_with_accepted_exceptions");
  const after = value(await h.engine.reader(h.ref).status());
  assert.equal(after.state, "closed");
  assert.equal(after.planDigest, h.legacy.status.planDigest);
  assert.equal(after.verificationDigest, h.legacy.status.verificationDigest);
  assert.deepEqual(after.currentApproval, h.legacy.status.currentApproval);
  assert.deepEqual(after.closeAuthorization, h.legacy.status.closeAuthorization);
  assert.deepEqual(after.goLiveAcknowledgments, h.legacy.status.goLiveAcknowledgments);
});

test("historical authorization does not ignore current option changes", async (t) => {
  const h = await historicalGoLiveHarness(t);
  const configuration = parse(h.legacy.config);
  assert.ok(configuration.options && typeof configuration.options === "object");
  Object.assign(configuration.options, { verificationMode: "hash" });
  await writeFile(join(h.directory, "job.toml"), stringify(configuration), { mode: 0o600 });
  const status = value(await h.engine.reader(h.ref).status());
  assert.equal(status.closeReview?.authorized, false);
  assert.notEqual(status.closeReview?.evidenceDigest, h.legacy.status.closeReview?.evidenceDigest);
  assert.deepEqual(status.closeAuthorization, h.legacy.status.closeAuthorization);
  assert.deepEqual(status.goLiveAcknowledgments, h.legacy.status.goLiveAcknowledgments);
  const result = await h.engine.withWriterResult(h.ref, (writer) => writer.close());
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Changed historical configuration accepted");
  assert.equal(result.refusal.code, "plan_revision_required");
});
