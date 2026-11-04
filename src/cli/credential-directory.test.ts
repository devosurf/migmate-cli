import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  credentialDirectory,
  ensureCredentialDirectory,
  expandCredentialNames,
} from "./credential-directory.ts";
import { run } from "./main.ts";
import type { Io } from "./io.ts";

async function root(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "migmate-credential-directory-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("the credential directory follows XDG_CONFIG_HOME, then ~/.config, on every platform", () => {
  assert.equal(credentialDirectory({}, "/home/op"), "/home/op/.config/migmate/credentials");
  assert.equal(
    credentialDirectory({ XDG_CONFIG_HOME: "/xdg" }, "/home/op"),
    "/xdg/migmate/credentials",
  );
  assert.equal(
    credentialDirectory({ XDG_CONFIG_HOME: "relative" }, "/home/op"),
    "/home/op/.config/migmate/credentials",
  );
  assert.equal(
    credentialDirectory({ MIGMATE_CREDENTIALS_DIR: "/secrets/", XDG_CONFIG_HOME: "/xdg" }),
    "/secrets",
  );
  assert.throws(() => credentialDirectory({ MIGMATE_CREDENTIALS_DIR: "secrets" }));
});

test("Migmate creates the credential directory owner-only and tightens a looser one", async (t) => {
  const base = await root(t);
  const created = join(base, "config", "migmate", "credentials");
  await ensureCredentialDirectory(created);
  assert.equal((await stat(created)).mode & 0o777, 0o700);
  const loose = join(base, "loose");
  await mkdir(loose, { mode: 0o755 });
  await ensureCredentialDirectory(loose);
  assert.equal((await stat(loose)).mode & 0o777, 0o700);
  const link = join(base, "link");
  await symlink(loose, link);
  await assert.rejects(ensureCredentialDirectory(link), /must be a directory you own/u);
  const file = join(base, "file");
  await writeFile(file, "");
  await assert.rejects(ensureCredentialDirectory(file));
});

test("short credential names expand into the credential directory; other paths are untouched", async (t) => {
  const directory = join(await root(t), "credentials");
  const config = {
    rclone: {
      config: { resolver: "file", path: "rclone.conf", mode: "0600" },
      sharepointDestinationCertificate: { resolver: "file", path: "entra/destination.pem" },
    },
    secrets: {
      absolute: { resolver: "file", path: "/operator/secret.txt" },
      escape: { resolver: "file", path: "../secret.txt" },
      home: { resolver: "file", path: "~/secret.txt" },
      hidden: { resolver: "file", path: ".secret" },
    },
    mappings: [{ path: "relative/but/not/a/reference" }],
  };
  assert.deepEqual(await expandCredentialNames(config, () => directory), {
    ...config,
    rclone: {
      config: { resolver: "file", path: join(directory, "rclone.conf"), mode: "0600" },
      sharepointDestinationCertificate: {
        resolver: "file",
        path: join(directory, "entra", "destination.pem"),
      },
    },
  });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("config without short names never touches the credential directory", async (t) => {
  const directory = join(await root(t), "credentials");
  const config = { rclone: { config: { resolver: "file", path: "/operator/rclone.conf" } } };
  assert.equal(await expandCredentialNames(config, () => directory), config);
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

function capture(): { io: Io; stdout: () => string } {
  let stdout = "";
  const stream = (write: (chunk: string) => void) => ({ isTTY: false, write });
  return {
    io: {
      stdout: stream((chunk) => (stdout += chunk)),
      stderr: stream(() => {}),
      stdin: { isTTY: false, readLine: async () => null },
    },
    stdout: () => stdout,
  };
}

test("creds dir prints and creates the credential directory without a job or store", async (t) => {
  const directory = join(await root(t), "credentials");
  const previous = process.env.MIGMATE_CREDENTIALS_DIR;
  process.env.MIGMATE_CREDENTIALS_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.MIGMATE_CREDENTIALS_DIR;
    else process.env.MIGMATE_CREDENTIALS_DIR = previous;
  });
  const text = capture();
  assert.equal(await run(["creds", "dir"], text.io), 0);
  assert.equal(text.stdout(), `${directory}\n`);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const json = capture();
  assert.equal(await run(["creds", "dir", "--output", "json"], json.io), 0);
  const envelope = JSON.parse(json.stdout());
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "creds dir");
  assert.equal(envelope.value.credentialDirectory, directory);
  assert.equal(await run(["creds", "dir", "--job", "job-1"], capture().io), 2);
});
