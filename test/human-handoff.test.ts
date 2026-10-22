import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import { approve, fileConfig, fileFixture, value } from "./engine-fixture.ts";

it("a completed copy is not authority for an initial go-live close", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "migmate-human-handoff-"));
  const engine = openEngine({ home, provider: new FakeFileMigrationPort(fileFixture()) });
  t.after(async () => {
    await engine.close();
    rmSync(home, { recursive: true, force: true });
  });
  const ref = value(await engine.initJob({ type: "file_migration", config: fileConfig() }));
  await approve({ engine, ref });
  value(await engine.withWriterResult(ref, (writer) => writer.execute()));
  assert.equal(value(await engine.reader(ref).status()).state, "verified");
  const close = await engine.withWriterResult(ref, (writer) => writer.close());
  assert.equal(
    close.ok,
    false,
    "close needs a reviewed go-live decision, not just a successful copy",
  );
  if (close.ok) return;
  assert.equal(close.refusal.code, "approval_required");
  assert.equal(value(await engine.reader(ref).status()).state, "verified");
});
