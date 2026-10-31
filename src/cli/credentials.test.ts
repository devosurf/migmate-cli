import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseToml } from "smol-toml";
import { FakeFileMigrationPort } from "../engine/providers/fake.ts";
import { onboardDropboxCredentials } from "./credentials.ts";
import { run } from "./main.ts";
import type { Io } from "./io.ts";
import { openEngine } from "../engine/index.ts";
import { parseCredentialIni } from "../engine/providers/credentials.ts";
import {
  DROPBOX_READ_SCOPES,
  loadDropboxCredential,
} from "../engine/providers/adapters/credentials/dropbox.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "migmate-dropbox-onboarding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeDirectory = join(root, "store");
  await mkdir(storeDirectory, { mode: 0o700 });
  const path = join(root, "rclone.conf");
  const original =
    "# Operator comments survive consent\n[dropbox-source]\ntype = dropbox\nclient_id = app-key\nimpersonate_admin = dbmid:admin\n\n[google-destination]\ntype = drive\nservice_account_file = /operator/service-account.json\n";
  await writeFile(path, original, { mode: 0o600 });
  const config = {
    sourceProvider: "dropbox",
    destinationProvider: "google_shared_drive",
    rclone: {
      config: { resolver: "file", path, mode: "0600" },
      dropboxRemote: "dropbox-source",
      destinationRemote: "google-destination",
    },
  };
  let stdout = "";
  let stderr = "";
  let prompts = 0;
  const io: Io = {
    stdout: {
      isTTY: true,
      write(chunk) {
        stdout += chunk;
      },
    },
    stderr: {
      isTTY: true,
      write(chunk) {
        stderr += chunk;
      },
    },
    stdin: {
      isTTY: true,
      async readLine() {
        prompts++;
        return "code-canary";
      },
    },
  };
  return {
    path,
    original,
    config,
    storeDirectory,
    io,
    signal: new AbortController().signal,
    output: () => ({ stdout, stderr, prompts }),
  };
}

function issuance(scope: unknown = DROPBOX_READ_SCOPES.join(" ")): Response {
  return Response.json({
    access_token: "access-canary",
    refresh_token: "refresh-canary",
    token_type: "bearer",
    expires_in: 14400,
    team_id: "dbtid:team",
    scope,
  });
}

test("Dropbox onboarding stores offline credentials only behind the file reference and reuses initial proof", async (t) => {
  const input = await fixture(t);
  const beforeConfig = JSON.stringify(input.config);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (target: unknown, init?: RequestInit) => {
    requests++;
    assert.equal(String(target), "https://api.dropboxapi.com/oauth2/token");
    assert.ok(init?.body instanceof URLSearchParams);
    assert.equal(init.body.get("code"), "code-canary");
    return issuance();
  });
  await onboardDropboxCredentials(input);
  assert.equal(input.output().prompts, 1);
  assert.match(input.output().stderr, /https:\/\/www.dropbox.com\/oauth2\/authorize\?/u);
  assert.doesNotMatch(
    input.output().stderr + input.output().stdout,
    /code-canary|access-canary|refresh-canary/u,
  );
  assert.equal(JSON.stringify(input.config), beforeConfig);
  const bytes = await readFile(input.path);
  const contents = bytes.toString();
  assert.match(contents, /^# Operator comments survive consent\n/u);
  assert.ok(
    contents.endsWith(
      "[google-destination]\ntype = drive\nservice_account_file = /operator/service-account.json\n",
    ),
  );
  assert.equal((await stat(input.path)).mode & 0o777, 0o600);
  const section = parseCredentialIni(bytes).get("dropbox-source");
  assert.ok(section);
  const credential = loadDropboxCredential(section);
  assert.equal(credential.refreshToken.toString(), "refresh-canary");
  credential.refreshToken.fill(0);
  bytes.fill(0);
  input.io.stdin.isTTY = false;
  input.io.stderr.isTTY = false;
  await onboardDropboxCredentials(input);
  assert.equal(requests, 1);
  assert.equal(input.output().prompts, 1);
});

for (const scope of [null, `${DROPBOX_READ_SCOPES.join(" ")} files.content.write`]) {
  test(`Dropbox onboarding leaves the credential file unchanged for invalid grant ${scope}`, async (t) => {
    const input = await fixture(t);
    t.mock.method(globalThis, "fetch", async () => issuance(scope));
    await assert.rejects(onboardDropboxCredentials(input), {
      code: "credential_permissions_invalid",
    });
    assert.equal(await readFile(input.path, "utf8"), input.original);
  });
}

test("Dropbox onboarding fails closed without interactive consent, and on cancellation", async (t) => {
  const input = await fixture(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Must not contact Dropbox");
  });
  input.io.stdin.isTTY = false;
  await assert.rejects(onboardDropboxCredentials(input), {
    code: "credential_interaction_required",
  });
  assert.equal(input.output().prompts, 0);
  input.io.stdin.isTTY = true;
  input.io.stdin.readLine = async () => null;
  await assert.rejects(onboardDropboxCredentials(input), {
    code: "credential_authentication_failed",
  });
  assert.equal(await readFile(input.path, "utf8"), input.original);
});

test("Dropbox onboarding refuses source-mutating remotes before browser consent", async (t) => {
  const input = await fixture(t);
  await writeFile(
    input.path,
    input.original.replace("type = dropbox", "type = dropbox\nshared_folders = true"),
  );
  await assert.rejects(onboardDropboxCredentials(input), {
    code: "credential_backend_unsupported",
  });
  assert.equal(input.output().prompts, 0);
});

test("Dropbox onboarding does not overwrite credentials changed during consent", async (t) => {
  const input = await fixture(t);
  const changed = `${input.original}# Changed by the operator\n`;
  input.io.stdin.readLine = async () => {
    await writeFile(input.path, changed);
    return "code-canary";
  };
  t.mock.method(globalThis, "fetch", async () => issuance());
  await assert.rejects(onboardDropboxCredentials(input), { code: "credential_file_changed" });
  assert.equal(await readFile(input.path, "utf8"), changed);
});

test("Dropbox creds init exposes permission refusal without persisting codes or tokens", async (t) => {
  const input = await fixture(t);
  const engine = openEngine({ home: input.storeDirectory });
  t.after(() => engine.close());
  const initialized = await engine.initJob({ type: "file_migration" });
  assert.ok(initialized.ok);
  const configPath = join(input.storeDirectory, "operator.json");
  await writeFile(configPath, JSON.stringify(input.config));
  t.mock.method(globalThis, "fetch", async () =>
    issuance(`${DROPBOX_READ_SCOPES.join(" ")} sharing.write`),
  );
  const code = await run(
    [
      "creds",
      "init",
      "--home",
      input.storeDirectory,
      "--job",
      initialized.value.id,
      "--config",
      configPath,
      "--output",
      "json",
    ],
    input.io,
    engine,
  );
  assert.notEqual(code, 0);
  const envelope: { ok: boolean; refusal: { code: string; detail: { check: string } } } =
    JSON.parse(input.output().stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.refusal.code, "preflight_failed");
  assert.equal(envelope.refusal.detail.check, "credential_permissions_invalid");
  assert.doesNotMatch(
    input.output().stdout + input.output().stderr,
    /code-canary|access-canary|refresh-canary/u,
  );
  assert.equal(await readFile(input.path, "utf8"), input.original);
});

test("Dropbox creds init persists both provider bindings and rereads them through the engine", async (t) => {
  const input = await fixture(t);
  const provider = new FakeFileMigrationPort({
    sourceDriveId: "namespace",
    sourceRootId: "/",
    destinationDriveId: "drive",
    destinationRootId: "root",
    sourceItems: [],
    destinationItems: [],
    checks: [{ id: "fixture.credentials", title: "Provider seam", status: "pass", evidence: {} }],
  });
  const observed: unknown[] = [];
  const preflight = provider.preflight.bind(provider);
  t.mock.method(
    provider,
    "preflight",
    async function* (request: Parameters<FakeFileMigrationPort["preflight"]>[0]) {
      observed.push(request.config);
      yield* preflight(request);
    },
  );
  const engine = openEngine({ home: input.storeDirectory, provider });
  t.after(() => engine.close());
  const initialized = await engine.initJob({ type: "file_migration" });
  assert.ok(initialized.ok);
  const configPath = join(input.storeDirectory, "operator.json");
  await writeFile(configPath, JSON.stringify(input.config));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (target: unknown, init?: RequestInit) => {
    requests++;
    assert.equal(String(target), "https://api.dropboxapi.com/oauth2/token");
    assert.ok(init?.body instanceof URLSearchParams);
    assert.equal(init.body.get("code"), "code-canary");
    return issuance();
  });
  const code = await run(
    [
      "creds",
      "init",
      "--home",
      input.storeDirectory,
      "--job",
      initialized.value.id,
      "--config",
      configPath,
      "--output",
      "json",
    ],
    input.io,
    engine,
  );
  assert.equal(code, 0, input.output().stdout);
  assert.equal(requests, 1);
  assert.equal(input.output().prompts, 1);
  const persisted = await readFile(
    join(input.storeDirectory, "jobs", initialized.value.id, "job.toml"),
    "utf8",
  );
  assert.deepEqual(parseToml(persisted).rclone, input.config.rclone);
  engine.close();
  const reopened = openEngine({ home: input.storeDirectory, provider });
  t.after(() => reopened.close());
  const doctor = await reopened.withWriterResult(initialized.value, (writer) => writer.doctor());
  assert.ok(doctor.ok);
  assert.equal(observed.length, 2);
  for (const config of observed) {
    assert.ok(config && typeof config === "object" && "rclone" in config);
    assert.deepEqual(config.rclone, input.config.rclone);
  }
  assert.doesNotMatch(
    persisted + input.output().stdout + input.output().stderr,
    /code-canary|access-canary|refresh-canary/u,
  );
});
