import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { parse } from "csv-parse/sync";
import type { FileMigrationConfig } from "../src/engine/drivers/file-migration.ts";
import { openEngine } from "../src/engine/index.ts";
import { fileMigrationDriver } from "../src/engine/drivers/file-migration.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import { ReportText } from "../src/engine/report.ts";
import { fileConfig, fileFixture, value, approve } from "./engine-fixture.ts";

async function fixture(
  t: TestContext,
  input = fileFixture(),
  config: FileMigrationConfig = fileConfig(),
) {
  const home = await mkdtemp(join(tmpdir(), "migmate-report-contract-"));
  const port = new FakeFileMigrationPort(input);
  const engine = openEngine({
    home,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    provider: port,
  });
  t.after(async () => {
    engine.close();
    await rm(home, { recursive: true, force: true });
  });
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      label: '<small & "safe">',
      config,
    }),
  );
  return { home, engine, ref, port };
}

for (const failure of ["serialization", "write"] as const)
  it(`publishes no partial artifact set after a late ${failure} failure and preserves immutable reports`, async (t) => {
    const h = await fixture(t);
    await approve(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    const first = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
    const before = await Promise.all(first.artifacts.map((artifact) => readFile(artifact.path)));
    const directory = join(h.home, "jobs", h.ref.id, "artifacts");
    const published = await readdir(directory);
    if (failure === "serialization") {
      let traversals = 0;
      t.mock.method(fileMigrationDriver, "reportSections", async function* () {
        yield {
          title: "Injected evidence",
          format: "text" as const,
          body: new ReportText(function* () {
            if (++traversals === 2) throw new Error("injected late serialization failure");
            yield "complete first artifact";
          }),
        };
      });
    } else {
      const original = fs.writeSync;
      let writes = 0;
      t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
        if (++writes === 2) throw new Error("injected artifact write failure");
        return Reflect.apply(original, fs, args);
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
    }
    await assert.rejects(
      h.engine.withWriterResult(h.ref, (w) => w.report()),
      /injected/,
    );
    assert.deepEqual(value(await h.engine.reader(h.ref).artifacts()), first);
    assert.deepEqual(await readdir(directory), published);
    assert.notEqual(value(await h.engine.reader(h.ref).status()).state, "closed");
    for (const [index, artifact] of first.artifacts.entries())
      assert.deepEqual(await readFile(artifact.path), before[index]);
  });

it("exports mapping totals and accepted findings without inventing missing metadata", async (t) => {
  const input = fileFixture([
    { id: "one", parentId: "source-root", name: "one", kind: "folder" },
    { id: "two", parentId: "source-root", name: "two", kind: "folder" },
    { id: "file", parentId: "one", name: "file.txt", kind: "file", content: "hello" },
  ]);
  input.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
  const h = await fixture(t, input, {
    mappings: [],
    options: { verificationMode: "hash" },
  });
  value(
    await h.engine.withWriterResult(h.ref, (w) =>
      w.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [
            {
              id: "one",
              source: { type: "sharepoint", driveId: "source-drive", folderPath: "one" },
              destination: { type: "google_shared_drive", create: '+Drive,"quoted"' },
              members: [{ email: "team@example.com", type: "group", role: "writer" }],
            },
            {
              id: "two",
              source: { type: "sharepoint", driveId: "source-drive", folderPath: "two" },
              destination: {
                type: "google_shared_drive",
                driveId: "destination-drive",
                folderId: "destination-root",
              },
            },
          ],
        }),
      }),
    ),
  );
  await approve(h);
  const approvedReport = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
  const plannedMappings: Record<string, string>[] = parse(
    await readFile(approvedReport.artifacts.find((a) => a.name === "mappings.csv")!.path, "utf8"),
    { columns: true },
  );
  assert.equal(plannedMappings[0]!.destination_name, '+Drive,"quoted"');
  assert.equal(plannedMappings[0]!.destination_drive_id, "");
  assert.equal(plannedMappings[0]!.created_by_job, "false");
  const plannedExceptions: Record<string, string>[] = parse(
    await readFile(approvedReport.artifacts.find((a) => a.name === "exceptions.csv")!.path, "utf8"),
    { columns: true },
  );
  assert.deepEqual(plannedExceptions, []);
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
  const copied = (await h.port.listDestinationChildren(driveId)).find(
    (item) => item.name === "file.txt",
  )!;
  h.port.mutateDestinationContent(copied.id, "other");
  const verification = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
  const outstandingReport = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
  const outstanding: Record<string, string>[] = parse(
    await readFile(
      outstandingReport.artifacts.find((a) => a.name === "exceptions.csv")!.path,
      "utf8",
    ),
    { columns: true },
  );
  assert.equal(outstanding.filter((row) => row.status === "outstanding").length, 1);
  value(
    await h.engine.withWriterResult(h.ref, (w) =>
      w.accept({
        verificationDigest: verification.verificationDigest,
        approver: "@operator",
        codes: ["content_mismatch"],
        rationale: '-Approved,\n"as observed"',
        mode: "unattended",
      }),
    ),
  );
  const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
  const csv = async (name: string): Promise<Record<string, string>[]> =>
    parse(await readFile(report.artifacts.find((a) => a.name === name)!.path, "utf8"), {
      columns: true,
    });
  const mappings = await csv("mappings.csv");
  assert.equal(mappings.length, 2);
  assert.equal(mappings[0]!.destination_name, '+Drive,"quoted"');
  assert.equal(mappings[0]!.created_by_job, "true");
  assert.equal(mappings[0]!.files, "1");
  assert.equal(mappings[0]!.bytes, "5");
  assert.equal(mappings[0]!.accepted_exceptions, "1");
  assert.equal(mappings[0]!.outstanding_exceptions, "0");
  assert.equal(mappings[1]!.created_by_job, "false");
  for (const mapping of mappings)
    for (const column of [
      "source_site_name",
      "source_library_name",
      "destination_web_link",
      "freeze_by",
      "freeze_at",
      "freeze_how",
      "go_live_member_grants",
    ])
      assert.equal(mapping[column], "");
  assert.equal(mappings[1]!.destination_name, "");
  const exceptions = await csv("exceptions.csv");
  assert.equal(exceptions.length, 1);
  for (const finding of exceptions) {
    assert.equal(finding.status, "accepted");
    assert.equal(finding.approver, "@operator");
    assert.equal(finding.note, '-Approved,\n"as observed"');
  }
  for (const artifact of report.artifacts.filter((a) => a.format === "csv")) {
    const text = await readFile(artifact.path, "utf8");
    assert.match(text, /^(?:"(?:[^"]|"")*"(?:,|\n))+$/u);
    assert.equal(artifact.digest, createHash("sha256").update(text).digest("hex"));
  }
  assert.deepEqual(value(await h.engine.reader(h.ref).artifacts()), report);
  assert.deepEqual(value(await h.engine.withWriterResult(h.ref, (w) => w.report())), report);
});

it("discloses map-only scope once without per-file omission exceptions", async (t) => {
  const h = await fixture(t, fileFixture(), fileConfig());
  const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
  await approve(h);
  const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
  const rows: string[][] = parse(
    await readFile(report.artifacts.find((a) => a.name === "exceptions.csv")!.path, "utf8"),
    { relax_column_count: true },
  );
  assert.deepEqual(rows[0], ["mapping_id", "path", "code", "status", "approver", "note", "reason"]);
  assert.equal(rows.length, 1);
  const text = plan.sections.map((section) => section.body).join("\n");
  assert.equal(
    text.split(
      "Version history, list-item fields, retention labels and permissions are not copied.",
    ).length,
    2,
  );
  assert.match(text, /compares no content/);
});
