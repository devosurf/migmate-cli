import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { digestJson, digestVerificationEvidence } from "../src/engine/store/digest.ts";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import { cliArchiveFixture, CLI_ARCHIVE_CONFIG } from "./cli-fixture.ts";
import { approve, fileConfig, fileFixture, value } from "./engine-fixture.ts";

it("preserves canonical verification evidence bytes for nested and non-JSON values", () => {
  const shared = { text: '共享 😀 \ud800 \udfff \n\t"\\' };
  const rows = [
    { z: shared, a: shared, nested: { missing: undefined, fn() {}, symbol: Symbol("omitted") } },
    [undefined, () => {}, Symbol("null"), , null, false, -0, NaN, Infinity, -Infinity],
    { date: new Date("2026-10-27T00:00:00Z"), bigint: 12345678901234567890n },
    { "10": "ten", "2": "two", a: [1, { z: false, a: true }] },
    undefined,
    () => {},
    Symbol("null"),
  ];
  const findings = [{ code: "content_mismatch", evidence: { z: 2, a: "é" } }];
  for (const archive of [null, "a".repeat(64)]) {
    assert.equal(
      digestVerificationEvidence({ rows: rows.values(), findings: findings.values(), archive }),
      digestJson({ rows, findings, archive }),
    );
  }
  assert.equal(
    digestVerificationEvidence({ rows: [], findings: [], archive: null }),
    digestJson({ rows: [], findings: [], archive: null }),
  );
});

it("rejects circular evidence and invalid dates rather than changing their digest", () => {
  const circular: unknown[] = [];
  circular.push(circular);
  for (const value of [circular, new Date(NaN)]) {
    const input = { rows: [value], findings: [], archive: null };
    assert.throws(() => digestJson(input));
    assert.throws(() => digestVerificationEvidence(input));
  }
});

it("hashes verification evidence larger than V8's maximum string using a single-pass iterator", () => {
  const count = 8193;
  const path = "x".repeat(65536);
  assert.ok(count * path.length > constants.MAX_STRING_LENGTH);
  const rows = (function* () {
    for (let i = 0; i < count; i++) yield { path };
  })();
  // Independently computed with Python hashlib over the literal JSON byte sequence.
  assert.equal(
    digestVerificationEvidence({ rows, findings: [], archive: null }),
    "a6854a0593ccb0dcf9a0aed6f90b0a6753ec180c983d3e4a95fb47e425e58362",
  );
});

for (const type of ["file_migration", "teams_archive"] as const)
  it(`keeps ${type} verification digests bound to the current persisted evidence`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "migmate-verification-digest-"));
    const port = new FakeFileMigrationPort({
      ...fileFixture([
        { id: "z", parentId: "source-root", name: "z.txt", kind: "file", content: "original" },
        { id: "a", parentId: "source-root", name: "a.txt", kind: "file", content: "first" },
      ]),
      archive: cliArchiveFixture(),
    });
    const engine = openEngine({ home, provider: port });
    t.after(async () => {
      engine.close();
      await rm(home, { recursive: true, force: true });
    });
    const ref = value(
      await engine.initJob({
        type,
        config:
          type === "teams_archive"
            ? CLI_ARCHIVE_CONFIG
            : { ...fileConfig(), options: { verificationMode: "hash" } },
      }),
    );
    await approve({ engine, ref });
    value(await engine.withWriterResult(ref, (w) => w.execute()));
    const file = port.snapshotDestination().find((entry) => entry.path === "z.txt");
    const digests: string[] = [];
    for (const content of ["corrupt", "original"]) {
      if (type === "file_migration") {
        assert.ok(file);
        port.mutateDestinationContent(file.id, content);
      }
      const verification = value(await engine.withWriterResult(ref, (w) => w.verify()));
      if (type === "file_migration") assert.equal(verification.clean, content === "original");
      const report = value(await engine.withWriterResult(ref, (w) => w.report()));
      const json = report.artifacts.find((artifact) => artifact.name === "report.json");
      assert.ok(json);
      const evidence: { rows: Record<string, unknown>[]; findings: unknown[] } = JSON.parse(
        await readFile(json.path, "utf8"),
      );
      const archive =
        type === "teams_archive"
          ? createHash("sha256")
              .update(await readFile(join(home, "jobs", ref.id, "archive", "manifest.json")))
              .digest("hex")
          : null;
      assert.equal(
        verification.evidenceDigest,
        digestJson({
          rows: evidence.rows
            .filter((row) => row.phase === "verify")
            .map(({ accepted: _reportAcceptance, ...row }) => row),
          findings: evidence.findings,
          archive,
        }),
      );
      digests.push(verification.evidenceDigest);
    }
    if (type === "file_migration") assert.notEqual(digests[0], digests[1]);
  });
