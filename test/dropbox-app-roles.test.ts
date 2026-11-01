import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimDropboxApp } from "../src/cli/credentials.ts";

test("one Dropbox app key is either the read-only source or the write destination", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "migmate-dropbox-apps-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await claimDropboxApp(home, "reader-app", "source");
  await claimDropboxApp(home, "reader-app", "source");
  await claimDropboxApp(home, "writer-app", "destination");
  await assert.rejects(claimDropboxApp(home, "reader-app", "destination"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "credential_permissions_invalid");
    assert.equal(
      (error as { evidence?: { reason?: string } }).evidence?.reason,
      "destination_reuses_source_app",
    );
    return true;
  });
  await assert.rejects(claimDropboxApp(home, "writer-app", "source"), {
    code: "credential_permissions_invalid",
  });
  const path = join(home, "dropbox-app-roles.json");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    "reader-app": "source",
    "writer-app": "destination",
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
