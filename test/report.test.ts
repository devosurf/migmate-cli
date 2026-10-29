import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const engine = openEngine({
    home,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    provider: new FakeFileMigrationPort(input),
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
  return { home, engine, ref };
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

for (const approved of [false, true])
  it(`keeps advance acceptance ${approved ? "granted" : "absent"} when job.toml changes after approval`, async (t) => {
    const config = {
      ...fileConfig(),
      options: { acceptedOmissions: approved ? ["source_package_omitted"] : [] },
    };
    const h = await fixture(
      t,
      fileFixture([{ id: "notes", parentId: "source-root", name: "Notes", kind: "package" }]),
      config,
    );
    await approve(h);
    await writeFile(
      join(h.home, "jobs", h.ref.id, "job.toml"),
      stringifyToml({
        ...config,
        options: { acceptedOmissions: approved ? [] : ["source_package_omitted"] },
      }),
    );
    const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
    const csv = async (name: string): Promise<Record<string, string>[]> =>
      parse(await readFile(report.artifacts.find((a) => a.name === name)!.path, "utf8"), {
        columns: true,
      });
    const exceptions = await csv("exceptions.csv");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]!.code, "source_package_omitted");
    assert.equal(exceptions[0]!.status, approved ? "accepted in advance" : "outstanding");
    assert.equal(exceptions[0]!.approver, approved ? "engine-contract-test" : "");
    const mappings = await csv("mappings.csv");
    assert.equal(mappings[0]!.accepted_exceptions, approved ? "1" : "0");
    assert.equal(mappings[0]!.outstanding_exceptions, approved ? "0" : "1");
  });

for (const accepted of [false, true])
  it(`retains ${accepted ? "accepted" : "outstanding"} planned omissions across plan, execute and verify without duplicates`, async (t) => {
    const input = fileFixture([
      { id: "notes", parentId: "source-root", name: "Notes", kind: "package" },
      { id: "file", parentId: "source-root", name: "file.txt", kind: "file", content: "hello" },
    ]);
    input.copyPasses = [{ pause: true, afterFiles: 1 }];
    const h = await fixture(t, input, {
      ...fileConfig(),
      options: { acceptedOmissions: accepted ? ["source_package_omitted"] : [] },
    });
    await approve(h);
    for (const phase of ["plan", "execute", "verify"] as const) {
      if (phase === "execute") {
        // Execute normally verifies automatically. Stop a real copy pass so the
        // intermediate report has execution evidence but no verification yet.
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
        const executing = h.engine.withWriterResult(h.ref, (w) => w.execute({ signal }));
        try {
          for await (const event of h.engine.reader(h.ref).events({ follow: true, signal })) {
            if (event.kind === "mapping_progress") break;
          }
        } finally {
          controller.abort();
          assert.equal(value(await executing).outcome, "interrupted");
        }
        assert.equal(value(await h.engine.reader(h.ref).status()).verificationDigest, null);
      } else if (phase === "verify") {
        value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
        value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
      }
      const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
      const csv = async (name: string): Promise<Record<string, string>[]> =>
        parse(await readFile(report.artifacts.find((a) => a.name === name)!.path, "utf8"), {
          columns: true,
        });
      const omissions = (await csv("exceptions.csv")).filter(
        (row) => row.code === "source_package_omitted",
      );
      assert.equal(omissions.length, 1, phase);
      assert.equal(omissions[0]!.mapping_id, "mapping", phase);
      assert.equal(omissions[0]!.path, "Notes", phase);
      assert.equal(omissions[0]!.status, accepted ? "accepted in advance" : "outstanding", phase);
      const mappings = await csv("mappings.csv");
      assert.equal(mappings[0]!.accepted_exceptions, accepted ? "1" : "0", phase);
      assert.equal(mappings[0]!.outstanding_exceptions, accepted ? "0" : "1", phase);
    }
  });

it("exports mapping totals and accepted omissions and findings without inventing missing metadata", async (t) => {
  const input = fileFixture([
    { id: "one", parentId: "source-root", name: "one", kind: "folder" },
    { id: "two", parentId: "source-root", name: "two", kind: "folder" },
    { id: "file", parentId: "one", name: "file.txt", kind: "file", content: "hello" },
    { id: "notes", parentId: "one", name: '=Notes,"quoted"', kind: "package" },
  ]);
  input.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
  const h = await fixture(t, input, {
    mappings: [],
    options: { verificationMode: "size_only", acceptedOmissions: ["source_package_omitted"] },
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
  assert.equal(
    plannedExceptions.find((row) => row.code === "source_package_omitted")!.status,
    "accepted in advance",
  );
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const verification = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
  const outstandingReport = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
  const outstanding: Record<string, string>[] = parse(
    await readFile(
      outstandingReport.artifacts.find((a) => a.name === "exceptions.csv")!.path,
      "utf8",
    ),
    { columns: true },
  );
  assert.equal(outstanding.filter((row) => row.status === "outstanding").length, 2);
  value(
    await h.engine.withWriterResult(h.ref, (w) =>
      w.accept({
        verificationDigest: verification.verificationDigest,
        approver: "@operator",
        codes: ["content_verification_degraded"],
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
  assert.equal(mappings[0]!.accepted_exceptions, "2");
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
  assert.equal(exceptions.length, 3);
  const omission = exceptions.find((row) => row.code === "source_package_omitted")!;
  assert.equal(omission.mapping_id, "one");
  assert.equal(omission.path, '=Notes,"quoted"');
  assert.equal(omission.status, "accepted in advance");
  assert.equal(omission.approver, "engine-contract-test");
  assert.ok(omission.reason);
  for (const finding of exceptions.filter((row) => row.code === "content_verification_degraded")) {
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

it("discloses rclone's missing per-file omission evidence without changing report evidence", async (t) => {
  const h = await fixture(t, fileFixture(), { ...fileConfig(), options: { proof: "rclone" } });
  await approve(h);
  const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
  const rows: string[][] = parse(
    await readFile(report.artifacts.find((a) => a.name === "exceptions.csv")!.path, "utf8"),
    { relax_column_count: true },
  );
  assert.deepEqual(rows[0], [
    "rclone proof: per-file omission findings are not collected at this proof level.",
  ]);
  assert.deepEqual(rows[1], ["mapping_id", "path", "code", "status", "approver", "note", "reason"]);
  assert.equal(rows.length, 2);
});
