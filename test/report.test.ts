import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import { fileMigrationDriver } from "../src/engine/drivers/file-migration.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import { ReportText } from "../src/engine/report.ts";
import { fileConfig, fileFixture, value, approve } from "./engine-fixture.ts";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "migmate-report-contract-"));
  const engine = openEngine({
    home,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    provider: new FakeFileMigrationPort(fileFixture()),
  });
  t.after(async () => {
    engine.close();
    await rm(home, { recursive: true, force: true });
  });
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      label: '<small & "safe">',
      config: fileConfig(),
    }),
  );
  return { home, engine, ref };
}

it("retains the small-job JSON, JSONL, HTML byte contract and immutable digest", async (t) => {
  const h = await fixture(t);
  const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
  const job = { id: h.ref.id, type: "file_migration", label: '<small & "safe">', state: "new" };
  const canonicalJob = `{"id":${JSON.stringify(h.ref.id)},"label":"<small & \\\"safe\\\">","state":"new","type":"file_migration"}`;
  const disclosures = [
    "Permissions and ownership were neither assessed nor migrated.",
    "Same-user processes are not isolated; local state has no application-level at-rest encryption.",
  ];
  const json = `{"acceptedExceptions":[],"approval":null,"archive":null,"checks":[],"disclosures":${JSON.stringify(disclosures)},"findings":[],"job":${canonicalJob},"plan":null,"rows":[],"schemaVersion":1,"sections":[],"verification":null}\n`;
  const jsonl = `{"acceptedExceptions":[],"approval":null,"archive":null,"checks":[],"disclosures":${JSON.stringify(disclosures)},"job":${canonicalJob},"kind":"report","plan":null,"schemaVersion":1,"sections":[],"verification":null}\n`;
  const escape = (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const section = (title: string, text: string) =>
    `<section><h2>${title}</h2><pre>${escape(text)}</pre></section>`;
  const html =
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Migmate evidence report</title></head><body><h1>Migmate evidence report</h1>' +
    section("Job", JSON.stringify(job, null, 2)) +
    section("Standing disclosures", disclosures.join("\n")) +
    section("Plan and approval", '{\n  "plan": null,\n  "approval": null\n}') +
    section("Preflight evidence", "[]") +
    section("Verification", "null") +
    section("All item and conversation rows", "[]") +
    section("Complete findings", "[]") +
    section("Accepted exceptions, affected items and consequences", "[]") +
    "</body></html>\n";
  const expected = [json, jsonl, html];
  for (const [index, artifact] of report.artifacts.entries()) {
    assert.equal(await readFile(artifact.path, "utf8"), expected[index]);
    assert.equal(artifact.digest, createHash("sha256").update(expected[index]!).digest("hex"));
  }
  const manifest = report.artifacts.map(({ name, format, digest }) => ({ digest, format, name }));
  assert.equal(
    report.reportDigest,
    createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  );
  assert.deepEqual(value(await h.engine.withWriterResult(h.ref, (w) => w.report())), report);
});

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
