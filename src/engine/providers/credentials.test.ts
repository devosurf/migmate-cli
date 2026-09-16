import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCredentialSession, ProviderFault } from "./credentials.ts";

const tenantId = "11111111-1111-1111-1111-111111111111";
const clientId = "22222222-2222-2222-2222-222222222222";
// An Entra client secret is not base64url: it carries `~`, `.`, and `-`.
const entraSecret = "Abc8Q~tE1.vN-jK_pLq7zXyW4rS2mD6bH0uT9cVe";
const mapping = {
  id: "general",
  sourceDriveId: "b!source-drive",
  sourceItemId: "01SOURCEROOT",
  destDriveId: "0ABCsharedDrive",
  destFolderId: "1XYZdestinationFolder",
};

function serviceAccount(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    type: "service_account",
    project_id: "migmate-test",
    private_key_id: "a".repeat(40),
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    client_email: "migmate@migmate-test.iam.gserviceaccount.com",
    client_id: "123456789012345678901",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

async function operatorFiles(
  t: { after: (fn: () => Promise<unknown>) => void },
  sourceSection: string,
): Promise<{ jobDirectory: string; config: unknown }> {
  const directory = await mkdtemp(join(tmpdir(), "migmate-credentials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "service-account.json");
  await writeFile(keyPath, serviceAccount(), { mode: 0o600 });
  const configPath = join(directory, "rclone.conf");
  await writeFile(
    configPath,
    `[sharepoint-source]\n${sourceSection}\n\n[google-destination]\ntype = drive\nscope = drive\nservice_account_file = ${keyPath}\nteam_drive = ${mapping.destDriveId}\nroot_folder_id = ${mapping.destFolderId}\n`,
    { mode: 0o600 },
  );
  const jobDirectory = await mkdtemp(join(tmpdir(), "migmate-job-"));
  t.after(() => rm(jobDirectory, { recursive: true, force: true }));
  return {
    jobDirectory,
    config: {
      mappings: [mapping],
      rclone: {
        config: { resolver: "file", path: configPath, mode: "0600" },
        sourceRemote: "sharepoint-source",
        destinationRemote: "google-destination",
      },
    },
  };
}

const source = [
  "type = onedrive",
  `client_id = ${clientId}`,
  `client_secret = ${entraSecret}`,
  "client_credentials = true",
  `tenant = ${tenantId}`,
  "drive_type = documentLibrary",
  `drive_id = ${mapping.sourceDriveId}`,
  `root_folder_id = ${mapping.sourceItemId}`,
];

test("onboards the operator config rclone itself runs with", async (t) => {
  // rclone sends client_secret verbatim and writes its own token cache back into
  // the config the managed worker passed to --config, so a config that has ever
  // transferred looks exactly like this.
  const { jobDirectory, config } = await operatorFiles(
    t,
    [
      ...source,
      `token = {"access_token":"${"e".repeat(64)}","token_type":"Bearer","expiry":"2026-09-15T10:00:00.000000000+02:00"}`,
    ].join("\n"),
  );
  let contactedProvider = false;
  t.mock.method(globalThis, "fetch", async () => {
    contactedProvider = true;
    throw new Error("Onboarding must not authenticate");
  });
  const session = await createCredentialSession({
    jobType: "file_migration",
    config,
    jobDirectory,
  });
  await session.dispose();
  assert.equal(contactedProvider, false);
});

test("refuses an uninspected backend option beside the supported settings", async (t) => {
  const { jobDirectory, config } = await operatorFiles(
    t,
    [...source, "auth_url = https://login.example.invalid/authorize"].join("\n"),
  );
  await assert.rejects(
    createCredentialSession({ jobType: "file_migration", config, jobDirectory }),
    (error: unknown) =>
      error instanceof ProviderFault && error.code === "credential_backend_unsupported",
  );
});

test("refuses a client secret that cannot be what rclone sent", async (t) => {
  const { jobDirectory, config } = await operatorFiles(
    t,
    source.map((line) => (line.startsWith("client_secret") ? "client_secret = " : line)).join("\n"),
  );
  await assert.rejects(
    createCredentialSession({ jobType: "file_migration", config, jobDirectory }),
    (error: unknown) =>
      error instanceof ProviderFault &&
      error.code === "credential_config_invalid" &&
      !JSON.stringify(error).includes(entraSecret),
  );
});

function graphToken(roles: string[]): Record<string, unknown> {
  const segment = (claims: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(claims)).toString("base64url");
  const payload = segment({
    aud: "https://graph.microsoft.com",
    tid: tenantId,
    appid: clientId,
    idtyp: "app",
    roles,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return {
    access_token: `${segment({ alg: "RS256", typ: "JWT" })}.${payload}.signature`,
    token_type: "Bearer",
    expires_in: 3600,
  };
}

test("accepts the site-scoped grant and refuses a tenant-wide one", async (t) => {
  // ADR-0003: Sites.Selected answers every call this route makes, so a token
  // carrying tenant-wide Files.Read.All is more access than the route may hold.
  for (const [roles, expected] of [
    [["Sites.Selected"], "accepted"],
    [["Sites.Selected", "Files.Read.All"], "credential_permissions_invalid"],
    [["Files.Read.All"], "credential_permissions_invalid"],
  ] as const) {
    const { jobDirectory, config } = await operatorFiles(t, source.join("\n"));
    const targets: string[] = [];
    t.mock.method(globalThis, "fetch", async (target: unknown) => {
      targets.push(String(target));
      return new Response(JSON.stringify(graphToken([...roles])), {
        headers: { "content-type": "application/json" },
      });
    });
    const session = await createCredentialSession({
      jobType: "file_migration",
      config,
      jobDirectory,
    });
    try {
      await session.graphToken();
      assert.equal(expected, "accepted", `roles ${roles.join("+")} must be refused`);
      assert.deepEqual(targets, [
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      ]);
    } catch (error) {
      assert.ok(error instanceof ProviderFault, `unexpected error for ${roles.join("+")}`);
      assert.equal(error.code, expected);
    } finally {
      await session.dispose();
    }
  }
});
