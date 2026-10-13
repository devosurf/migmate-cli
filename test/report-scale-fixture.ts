import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import { fileFixture, value, approve } from "./engine-fixture.ts";

const home = await mkdtemp(join(tmpdir(), "migmate-report-scale-"));
const now = () => new Date("2026-09-01T00:00:00.000Z");
const files = Number(process.argv[2] ?? 250_000);
const fixture = fileFixture(
  [0, 1, 2].flatMap((i) => [
    { id: `root-${i}`, parentId: "source-root", name: `root-${i}`, kind: "folder" as const },
    {
      id: `file-${i}`,
      parentId: `root-${i}`,
      name: "file.txt",
      kind: "file" as const,
      content: "data",
    },
  ]),
);
fixture.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
fixture.now = now;
const port = new FakeFileMigrationPort(fixture);
const engine = openEngine({ home, now, provider: port });
try {
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      config: {
        mappings: [],
        options: { proof: "rclone", staged: true, consistencyIntervalMs: 0 },
      },
    }),
  );
  value(
    await engine.withWriterResult(ref, (w) =>
      w.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [0, 1, 2].map((i) => ({
            id: `mapping-${i}`,
            source: { type: "sharepoint", driveId: "source-drive", folderPath: `root-${i}` },
            destination: { type: "google_shared_drive", create: `Drive ${i}` },
            members: [{ email: "reader@example.com", type: "user", role: "reader" }],
          })),
        }),
      }),
    ),
  );
  await approve({ engine, ref });
  value(await engine.withWriterResult(ref, (w) => w.execute()));
  await approve({ engine, ref });
  value(await engine.withWriterResult(ref, (w) => w.execute()));
  const plan = value(await engine.withWriterResult(ref, (w) => w.plan({ final: true })));
  value(
    await engine.withWriterResult(ref, (w) =>
      w.approve({
        approver: "operator",
        mode: "unattended",
        planDigest: plan.planDigest,
        freeze: { by: "operator", at: now().toISOString(), how: "Editors locked out" },
      }),
    ),
  );
  value(await engine.withWriterResult(ref, (w) => w.execute()));
  const db = new DatabaseSync(join(home, "jobs", ref.id, "state.db"));
  const template = db
    .prepare("SELECT * FROM item WHERE rev=? AND phase='verify' AND item_type='file' LIMIT 1")
    .get(plan.revision)!;
  const columns = Object.keys(template);
  const insert = db.prepare(
    `INSERT INTO item (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  const row = JSON.parse(String(template.payload));
  db.exec("BEGIN");
  for (let i = 0; i < files; i++) {
    const id = `synthetic-${String(i).padStart(6, "0")}`;
    const mappingId = `mapping-${i % 3}`;
    const payload = {
      ...row,
      id,
      sourceItemId: id,
      mappingId,
      relativePath: `${id}.txt`,
      sourceEvidence: { description: '<&>"'.repeat(256) },
    };
    insert.run(
      ...columns.map((column) =>
        column === "id" || column === "source_item_id"
          ? id
          : column === "mapping_id"
            ? mappingId
            : column === "relative_path"
              ? payload.relativePath
              : column === "payload"
                ? JSON.stringify(payload)
                : template[column]!,
      ),
    );
  }
  db.exec("COMMIT");
  db.prepare(
    `UPDATE watermark SET value=json_set(value, '$.copiedInventory', json((
    SELECT json_group_array(json_object('id',source_item_id,'path',relative_path,'evidence',json_object('description',json_extract(payload,'$.sourceEvidence.description'))))
    FROM item WHERE rev=? AND phase='verify' AND mapping_id=json_extract(watermark.value,'$.mappingId')
  ))) WHERE rev=? AND unit_key LIKE 'file-settle:%'`,
  ).run(plan.revision, plan.revision);
  db.prepare(
    `INSERT INTO finding (rev,phase,code,kind,subject_kind,subject_id,evidence,at)
    SELECT rev,'verify','omitted_by_rule','omission','file',id,json_object('path',relative_path,'reason','reviewed omission'),?
    FROM item WHERE rev=? AND id LIKE 'synthetic-%' ORDER BY id LIMIT 1000`,
  ).run(now().toISOString(), plan.revision);
  db.prepare("UPDATE verification_revision SET findings=? WHERE plan_rev=?").run(
    JSON.stringify([{ code: "omitted_by_rule", kind: "omission", count: 1000 }]),
    plan.revision,
  );
  const expectedRows = Number(
    db.prepare("SELECT COUNT(*) AS count FROM item WHERE rev=?").get(plan.revision)!.count,
  );
  db.close();
  const verification = value(await engine.reader(ref).status()).verificationDigest!;
  value(
    await engine.withWriterResult(ref, (w) =>
      w.accept({
        verificationDigest: verification,
        codes: [{ code: "omitted_by_rule", note: "Scale fixture accepted exception" }],
        approver: "scale-operator",
      }),
    ),
  );
  let peakHeap = process.memoryUsage().heapUsed;
  const sample = setInterval(() => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 10);
  sample.unref();
  const report = value(await engine.withWriterResult(ref, (w) => w.report()));
  assert.equal(report.artifacts.length, 3);
  let bytes = 0;
  for (const artifact of report.artifacts) {
    bytes += (await stat(artifact.path)).size;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(artifact.path)) hash.update(chunk);
    assert.equal(hash.digest("hex"), artifact.digest);
  }
  if (files >= 250_000) assert.ok(bytes > 536_870_888, `aggregate artifact bytes: ${bytes}`);
  let firstLine = true,
    pending = "",
    rows = 0,
    findings = 0,
    acceptedItems = 0,
    headerBytes = 0;
  const needle = '"subjectId":"synthetic-';
  let suffix = "";
  for await (const chunk of createReadStream(
    report.artifacts.find((artifact) => artifact.name === "report.jsonl")!.path,
    { encoding: "utf8" },
  )) {
    let text = String(chunk);
    if (firstLine) {
      const newline = text.indexOf("\n");
      const header = newline === -1 ? text : text.slice(0, newline);
      headerBytes += Buffer.byteLength(header);
      const search = suffix + header;
      let at = 0;
      while ((at = search.indexOf(needle, at)) !== -1) {
        acceptedItems++;
        at += needle.length;
      }
      suffix = search.slice(-(needle.length - 1));
      if (newline === -1) continue;
      firstLine = false;
      text = text.slice(newline + 1);
    }
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const entry = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (entry.kind === "row") rows++;
      else if (entry.kind === "finding") {
        findings++;
        assert.equal(entry.finding.code, "omitted_by_rule");
      }
    }
  }
  assert.equal(rows, expectedRows);
  assert.equal(findings, 1000);
  assert.equal(acceptedItems, 1000);
  assert.equal(pending, "");
  value(await engine.withWriterResult(ref, (w) => w.close()));
  assert.equal(value(await engine.reader(ref).status()).state, "closed");
  clearInterval(sample);
  console.log(
    JSON.stringify({ files, bytes, headerBytes, peakHeap, maxRSS: process.resourceUsage().maxRSS }),
  );
} finally {
  engine.close();
  await rm(home, { recursive: true, force: true });
}
