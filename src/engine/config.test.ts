import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseToml } from "smol-toml";
import { openEngine } from "./index.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "migmate-config-bindings-"));
  const home = join(root, "store");
  const engine = openEngine({ home });
  t.after(async () => {
    engine.close();
    await rm(root, { recursive: true, force: true });
  });
  const reference = { resolver: "file", path: join(root, "rclone.conf"), mode: "0600" };
  return { engine, home, reference };
}

for (const pair of [
  {
    sourceProvider: "dropbox",
    destinationProvider: "google_shared_drive",
    remotes: { dropboxRemote: "dropbox", destinationRemote: "google" },
  },
  {
    sourceProvider: "sharepoint",
    destinationProvider: "google_shared_drive",
    remotes: { sourceRemote: "sharepoint", destinationRemote: "google" },
  },
  {
    sourceProvider: "google_shared_drive",
    destinationProvider: "sharepoint",
    remotes: { destinationRemote: "google", sharepointDestinationRemote: "sharepoint" },
  },
]) {
  test(`engine persists only required bindings for ${pair.sourceProvider} to ${pair.destinationProvider}`, async (t) => {
    const { engine, home, reference } = await fixture(t);
    const { remotes, ...providers } = pair;
    const rclone = { config: reference, ...remotes };
    const initialized = await engine.initJob({
      type: "file_migration",
      config: { ...providers, rclone },
    });
    assert.ok(initialized.ok);
    const persisted = parseToml(
      await readFile(join(home, "jobs", initialized.value.id, "job.toml"), "utf8"),
    );
    assert.deepEqual(persisted.rclone, rclone);
    for (const key of Object.keys(remotes)) {
      const missing: Record<string, unknown> = { ...rclone };
      delete missing[key];
      const result = await engine.initJob({
        type: "file_migration",
        config: { ...providers, rclone: missing },
      });
      assert.ok(!result.ok);
      assert.equal(result.refusal.code, "configuration_invalid");
      assert.deepEqual(result.refusal.detail, { field: `rclone.${key}` });
    }
  });
}

test("Dropbox engine config refuses unknown, wrong, duplicate and unsafe credential bindings", async (t) => {
  const { engine, reference } = await fixture(t);
  const remotes = { config: reference, dropboxRemote: "dropbox", destinationRemote: "google" };
  for (const rclone of [
    { ...remotes, unknownRemote: "other" },
    { ...remotes, sharepointDestinationRemote: "sharepoint" },
    { config: reference, sourceRemote: "sharepoint", destinationRemote: "google" },
    { ...remotes, destinationRemote: "DROPBOX" },
    { ...remotes, dropboxRemote: "dropbox:root" },
    { ...remotes, config: { ...reference, value: "secret-canary" } },
    { ...remotes, config: { ...reference, resolver: "env" } },
    { ...remotes, config: { ...reference, mode: "0644" } },
    { ...remotes, config: { ...reference, path: "relative.conf" } },
  ]) {
    const result = await engine.initJob({
      type: "file_migration",
      config: {
        sourceProvider: "dropbox",
        destinationProvider: "google_shared_drive",
        rclone,
      },
    });
    assert.ok(!result.ok);
    assert.equal(result.refusal.code, "configuration_invalid");
  }
});

test("engine refuses unsupported provider pairs even with valid remote names", async (t) => {
  const { engine, reference } = await fixture(t);
  for (const [sourceProvider, destinationProvider] of [
    ["dropbox", "sharepoint"],
    ["google_shared_drive", "dropbox"],
    ["dropbox", "dropbox"],
    ["unknown", "google_shared_drive"],
  ]) {
    const result = await engine.initJob({
      type: "file_migration",
      config: {
        sourceProvider,
        destinationProvider,
        rclone: { config: reference, dropboxRemote: "dropbox", destinationRemote: "google" },
      },
    });
    assert.ok(!result.ok);
    assert.equal(result.refusal.code, "unsupported_route");
  }
});
