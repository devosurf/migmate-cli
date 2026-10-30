import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import { parse } from "csv-parse/sync";
import { stringify as stringifyToml } from "smol-toml";
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

for (const decision of ["approved", "absent", "unapproved", "mismatched"] as const)
  it(`preserves ${decision} historical omission acceptance in report CSV before verification`, async (t) => {
    const legacy: {
      plan: Record<string, string | number>;
      inputs: Array<{ key: string; value: string }>;
      approval: Record<string, string | number>;
    } = JSON.parse(
      await readFile(new URL("./fixtures/pre-manifest-approved.json", import.meta.url), "utf8"),
    );
    const h = await fixture(t);
    value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    const directory = join(h.home, "jobs", h.ref.id);
    const database = new DatabaseSync(join(directory, "state.db"));
    try {
      database.exec("UPDATE item SET payload=json_remove(payload,'$.fileScope')");
      database.exec("DELETE FROM plan_input; DELETE FROM plan_revision");
      for (const [table, row] of [
        ["plan_revision", legacy.plan],
        ...(decision === "unapproved" ? [] : [["approval", legacy.approval] as const]),
      ] as const) {
        const keys = Object.keys(row);
        database
          .prepare(
            `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
          )
          .run(...Object.values(row));
      }
      for (const input of legacy.inputs) {
        const frozen = input.key === "configuration" ? JSON.parse(input.value) : undefined;
        if (frozen && decision !== "absent")
          frozen.options.acceptedOmissions = ["version_history_omitted"];
        database
          .prepare("INSERT INTO plan_input (rev,key,value) VALUES (1,?,?)")
          .run(input.key, frozen ? JSON.stringify(frozen) : input.value);
      }
      if (decision === "mismatched")
        database.exec(
          "UPDATE approval SET plan_digest='different-plan', payload=json_set(payload,'$.planDigest','different-plan')",
        );
      database
        .prepare("UPDATE job SET state=?")
        .run(decision === "unapproved" ? "planned" : "approved");
      const finding = database.prepare(
        "INSERT INTO finding (rev,phase,code,kind,subject_kind,subject_id,evidence,at) VALUES (1,'plan',?,?,'mapping','mapping','{}',?)",
      );
      for (const [code, kind] of [
        ["version_history_omitted", "planned_omission"],
        ["permissions_not_migrated", "planned_omission"],
      ] as const)
        finding.run(code, kind, "2026-09-01T00:00:00.000Z");
      // An interrupted verification has findings but no successful verification revision.
      database.exec(
        `INSERT INTO finding (rev,phase,code,kind,subject_kind,subject_id,evidence,at)
         VALUES (1,'verify','version_history_omitted','planned_omission','file','unverified',
           '{"mappingId":"mapping","path":"unverified.txt"}','2026-09-01T00:00:00.000Z');
         UPDATE projection_verb_state SET state='done' WHERE state='current';
         INSERT INTO projection_verb_state (verb,state,updated_at)
         VALUES ('verify','current','2026-09-01T00:00:00.000Z')
         ON CONFLICT(verb) DO UPDATE SET state='current'`,
      );
    } finally {
      database.close();
    }
    // Live config deliberately disagrees with the frozen decision in both directions.
    await writeFile(
      join(directory, "job.toml"),
      stringifyToml({
        ...fileConfig(),
        options: {
          acceptedOmissions: decision === "approved" ? [] : ["version_history_omitted"],
        },
      }),
    );
    for (const mutate of [
      () => h.engine.withWriterResult(h.ref, (writer) => writer.plan()),
      () => h.engine.withWriterResult(h.ref, (writer) => writer.execute()),
      () => h.engine.withWriterResult(h.ref, (writer) => writer.cancel("retire")),
    ]) {
      const result = await mutate();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.refusal.code, "state_version_unsupported");
    }
    const report = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
    const csv = async (name: string): Promise<Record<string, string>[]> =>
      parse(
        await readFile(report.artifacts.find((artifact) => artifact.name === name)!.path, "utf8"),
        {
          columns: true,
        },
      );
    const exceptions = await csv("exceptions.csv");
    assert.equal(exceptions.length, 3);
    const omission = exceptions.find(
      (row) => row.code === "version_history_omitted" && row.path !== "unverified.txt",
    )!;
    const unverified = exceptions.find((row) => row.path === "unverified.txt")!;
    assert.equal(unverified.status, "outstanding");
    assert.equal(unverified.approver, "");
    const accepted = decision === "approved";
    assert.equal(omission.status, accepted ? "accepted in advance" : "outstanding");
    assert.equal(omission.approver, accepted ? "engine-contract-test" : "");
    assert.equal(
      exceptions.find((row) => row.code === "permissions_not_migrated")!.status,
      "outstanding",
    );
    const mappings = await csv("mappings.csv");
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0]!.accepted_exceptions, accepted ? "1" : "0");
    assert.equal(mappings[0]!.outstanding_exceptions, accepted ? "2" : "3");
    assert.equal(mappings[0]!.verification_outcome, "");
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
