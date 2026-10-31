import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { appendFile, mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createCredentialSession } from "./credentials.ts";
import { ProviderFault } from "./fault.ts";
import { createProductionProvider } from "./production.ts";
import {
  beginDropboxAuthorization,
  DROPBOX_READ_SCOPES,
  dropboxRemoteSettings,
  loadDropboxCredential,
  requestDropboxToken,
} from "./adapters/credentials/dropbox.ts";

const tenantId = "11111111-1111-1111-1111-111111111111";
const clientId = "22222222-2222-2222-2222-222222222222";
// An Entra client secret is not base64url: it carries `~`, `.`, and `-`.
const entraSecret = "Abc8Q~tE1.vN-jK_pLq7zXyW4rS2mD6bH0uT9cVe";
const forwardProviders = {
  sourceProvider: "sharepoint",
  destinationProvider: "google_shared_drive",
};
const reverseProviders = {
  sourceProvider: "google_shared_drive",
  destinationProvider: "sharepoint",
};
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
  destinationRoots = `team_drive = ${mapping.destDriveId}\nroot_folder_id = ${mapping.destFolderId}\n`,
) {
  const directory = await mkdtemp(join(tmpdir(), "migmate-credentials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "service-account.json");
  await writeFile(keyPath, serviceAccount(), { mode: 0o600 });
  const configPath = join(directory, "rclone.conf");
  await writeFile(
    configPath,
    `[sharepoint-source]\n${sourceSection}\n\n[google-destination]\ntype = drive\nscope = drive\nservice_account_file = ${keyPath}\n${destinationRoots}`,
    { mode: 0o600 },
  );
  const jobDirectory = await mkdtemp(join(tmpdir(), "migmate-job-"));
  t.after(() => rm(jobDirectory, { recursive: true, force: true }));
  return {
    jobDirectory,
    config: {
      ...forwardProviders,
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

for (const provider of ["microsoft", "google"] as const) {
  test(
    `plan preflight can interrupt ${provider} authentication without disposing credentials`,
    { timeout: 5000 },
    async (t) => {
      const { jobDirectory, config } = await operatorFiles(t, source.join("\n"));
      const session = await createCredentialSession({
        jobType: "file_migration",
        config,
        jobDirectory,
      });
      t.after(() => session.dispose());
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      t.after(() => response.reject(new Error("Test ended")));
      let blocked = true;
      t.mock.method(globalThis, "fetch", async (target: unknown, init?: RequestInit) => {
        const microsoft = String(target).startsWith("https://login.microsoftonline.com/");
        if (blocked && microsoft === (provider === "microsoft")) {
          const abort = () => response.reject(init?.signal?.reason);
          init?.signal?.addEventListener("abort", abort, { once: true });
          entered.resolve();
          try {
            init?.signal?.throwIfAborted();
            return await response.promise;
          } finally {
            init?.signal?.removeEventListener("abort", abort);
          }
        }
        return Response.json(
          microsoft
            ? graphToken(["Sites.Selected"])
            : {
                access_token: "google-token",
                token_type: "Bearer",
                expires_in: 3600,
              },
        );
      });
      const stopped = assert.rejects(session.evidence(controller.signal), ProviderFault);
      await entered.promise;
      controller.abort();
      await stopped;
      blocked = false;
      const evidence = await session.evidence();
      assert.ok(evidence.graph);
      assert.ok(evidence.google);
    },
  );
}

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

// Every pass overrides remote roots with the approved mapping's, so a seed root
// is optional; when present it still has to be a stable ID.
test("onboards rclone remotes that name no seed root", async (t) => {
  const unrooted = source.filter((line) => !/^(drive_id|root_folder_id) /u.test(line)).join("\n");
  const { jobDirectory, config } = await operatorFiles(t, unrooted, "");
  const forward = await createCredentialSession({
    jobType: "file_migration",
    config,
    jobDirectory,
  });
  await forward.dispose();
  const reverse = await createCredentialSession({
    jobType: "file_migration",
    config: {
      ...reverseProviders,
      mappings: [{ ...mapping, sourceType: "google_shared_drive" }],
      rclone: {
        config: config.rclone.config,
        destinationRemote: "google-destination",
        sharepointDestinationRemote: "sharepoint-source",
      },
    },
    jobDirectory,
  });
  await reverse.dispose();
  for (const [sourceRoot, destinationRoot] of [
    ["drive_id = root", ""],
    ["root_folder_id = ..", ""],
    ["", "team_drive = root\n"],
    ["", "root_folder_id = .\n"],
  ] as const) {
    const malformed = await operatorFiles(t, [unrooted, sourceRoot].join("\n"), destinationRoot);
    await assert.rejects(
      createCredentialSession({
        jobType: "file_migration",
        config: malformed.config,
        jobDirectory: malformed.jobDirectory,
      }),
      { code: "credential_config_invalid" },
      `${sourceRoot || destinationRoot.trim()} must still be a stable ID`,
    );
  }
});

test("loads file credentials before mappings are supplied by a manifest", async (t) => {
  const { jobDirectory, config } = await operatorFiles(t, source.join("\n"));
  t.mock.method(globalThis, "fetch", async (target: unknown) => {
    if (String(target).startsWith("https://login.microsoftonline.com/"))
      return Response.json(graphToken(["Sites.Read.All"]));
    assert.equal(String(target), "https://oauth2.googleapis.com/token");
    return Response.json({ access_token: "google-token", token_type: "Bearer", expires_in: 3600 });
  });
  for (const mappings of [undefined, []]) {
    const session = await createCredentialSession({
      jobType: "file_migration",
      config: { ...config, mappings },
      jobDirectory,
    });
    t.after(() => session.dispose());
    const evidence = await session.evidence();
    assert.deepEqual(evidence.mappings, []);
    assert.equal(await session.googleToken(), "google-token");
    assert.deepEqual(Reflect.get(evidence.graph!, "grantedPermissions"), ["Sites.Read.All"]);
  }
});

test("uses the configured providers for credential privileges before mappings exist", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { config, jobDirectory } = await operatorFiles(
    t,
    source.filter((line) => !line.startsWith("root_folder_id")).join("\n"),
  );
  const rclone = {
    config: config.rclone.config,
    destinationRemote: config.rclone.destinationRemote,
    sharepointDestinationRemote: config.rclone.sourceRemote,
  };
  const token = graphToken(["Sites.ReadWrite.All"]);
  t.mock.method(globalThis, "fetch", async () => {
    // Force the assertion into the next JWT expiry second without sleeping.
    now += 1000;
    return Response.json(token);
  });
  const session = await createCredentialSession({
    jobType: "file_migration",
    config: { ...reverseProviders, rclone },
    jobDirectory,
  });
  t.after(() => session.dispose());
  assert.equal(await session.graphDestinationToken(), token.access_token);
  await assert.rejects(session.graphToken(), { code: "credential_graph_unavailable" });
  for (const remotes of [rclone, { ...config.rclone, sourceRemote: undefined }]) {
    await assert.rejects(
      createCredentialSession({
        jobType: "file_migration",
        config: { ...forwardProviders, mappings: [], rclone: remotes },
        jobDirectory,
      }),
      { code: "credential_config_invalid" },
    );
  }
  await assert.rejects(
    createCredentialSession({
      jobType: "file_migration",
      config: { ...reverseProviders, rclone: config.rclone },
      jobDirectory,
    }),
    { code: "credential_config_invalid" },
  );
});

test("refuses malformed mappings even beside a valid credential mapping", async (t) => {
  const { config, jobDirectory } = await operatorFiles(t, source.join("\n"));
  for (const mappings of [
    [mapping, { ...mapping, sourceDriveId: "" }],
    [mapping, { ...mapping, sourceItemId: undefined }],
    [mapping, null],
    null,
    {},
  ]) {
    await assert.rejects(
      createCredentialSession({
        jobType: "file_migration",
        config: { ...config, mappings },
        jobDirectory,
      }),
      { code: "credential_mapping_invalid" },
    );
  }
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

test("accepts exactly one SharePoint read grant and refuses broader source permissions", async (t) => {
  for (const [roles, expected] of [
    [["Sites.Selected"], "accepted"],
    [["Sites.Read.All"], "accepted"],
    [["Sites.Selected", "Sites.Read.All"], "credential_permissions_invalid"],
    [["Sites.ReadWrite.All"], "credential_permissions_invalid"],
    [["Sites.Read.All", "Sites.ReadWrite.All"], "credential_permissions_invalid"],
    [["Sites.Read.All", "Files.Read.All"], "credential_permissions_invalid"],
    [["Sites.Selected", "Files.Read.All"], "credential_permissions_invalid"],
    [["Files.Read.All"], "credential_permissions_invalid"],
  ] as const) {
    const { jobDirectory, config } = await operatorFiles(
      t,
      [
        ...source,
        `access_scopes = ${roles.some((role) => role === "Sites.Read.All") ? "Sites.Read.All" : "Sites.Selected"}`,
      ].join("\n"),
    );
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

test("SharePoint destination credentials accept only Sites.ReadWrite.All, never as a source", async (t) => {
  for (const roles of [
    ["Sites.ReadWrite.All"],
    ["Sites.Selected"],
    ["Sites.ReadWrite.All", "Sites.Read.All"],
    ["Files.ReadWrite.All"],
  ]) {
    const { config, jobDirectory } = await operatorFiles(
      t,
      source.filter((line) => !line.startsWith("root_folder_id")).join("\n"),
    );
    const reverse = {
      ...config,
      ...reverseProviders,
      mappings: [{ ...mapping, sourceType: "google_shared_drive" }],
      rclone: {
        config: config.rclone.config,
        destinationRemote: "google-destination",
        sharepointDestinationRemote: "sharepoint-source",
      },
    };
    const token = graphToken(roles);
    t.mock.method(globalThis, "fetch", async () => Response.json(token));
    const session = await createCredentialSession({
      jobType: "file_migration",
      config: reverse,
      jobDirectory,
    });
    t.after(() => session.dispose());
    if (roles.length === 1 && roles[0] === "Sites.ReadWrite.All") {
      assert.equal(await session.graphDestinationToken(), token.access_token);
      await assert.rejects(session.graphToken(), { code: "credential_graph_unavailable" });
    } else
      await assert.rejects(session.graphDestinationToken(), {
        code: "credential_permissions_invalid",
      });
  }
});

test("only jobs targeting SharePoint may hold its separate write credential", async (t) => {
  const { config, jobDirectory } = await operatorFiles(t, source.join("\n"));
  await appendFile(
    config.rclone.config.path,
    `\n[sharepoint-destination]\ntype = onedrive\nclient_id = 33333333-3333-3333-3333-333333333333\nclient_secret = ${entraSecret}\nclient_credentials = true\ntenant = ${tenantId}\ndrive_type = documentLibrary\ndrive_id = b!destination-library\n`,
  );
  const rclone = { ...config.rclone, sharepointDestinationRemote: "sharepoint-destination" };
  t.mock.method(globalThis, "fetch", async () => Response.json(graphToken(["Sites.Selected"])));
  await assert.rejects(
    createCredentialSession({
      jobType: "file_migration",
      config: { ...config, rclone },
      jobDirectory,
    }),
    { code: "credential_config_invalid" },
  );
  const reverse = await createCredentialSession({
    jobType: "file_migration",
    config: {
      ...config,
      ...reverseProviders,
      rclone,
      mappings: [
        { ...mapping, id: "reverse", sourceType: "google_shared_drive", sourceDriveId: "0Asource" },
      ],
    },
    jobDirectory,
  });
  t.after(() => reverse.dispose());
  assert.equal(reverse.sharepointDestinationRemote, "sharepoint-destination");
});

test("Sites.Read.All alone passes the production credential preflight", async (t) => {
  const input = await operatorFiles(t, [...source, "access_scopes = Sites.Read.All"].join("\n"));
  t.mock.method(globalThis, "fetch", async (target: unknown) => {
    if (String(target).startsWith("https://login.microsoftonline.com/"))
      return Response.json(graphToken(["Sites.Read.All"]));
    assert.equal(String(target), "https://oauth2.googleapis.com/token");
    return Response.json({ access_token: "google-token", token_type: "Bearer", expires_in: 3600 });
  });
  const provider = createProductionProvider({ ...input, jobType: "file_migration" });
  t.after(() => provider.close?.());
  for await (const check of provider.preflight!({ ...input, jobType: "file_migration" })) {
    assert.equal(check.id, "provider.credentials");
    assert.equal(check.status, "pass");
    assert.deepEqual(
      check.evidence?.graph && Reflect.get(check.evidence.graph, "grantedPermissions"),
      ["Sites.Read.All"],
    );
    return;
  }
  assert.fail("Credential preflight did not report an outcome");
});

test("file impersonation requests a delegated subject with only the Drive scope", async (t) => {
  const { jobDirectory, config } = await operatorFiles(t, source.join("\n"));
  t.mock.method(globalThis, "fetch", async (_target: unknown, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    const claims = JSON.parse(
      Buffer.from(body.get("assertion")!.split(".")[1]!, "base64url").toString(),
    );
    assert.equal(claims.iss, "migmate@migmate-test.iam.gserviceaccount.com");
    assert.equal(claims.sub, "files@example.com");
    assert.equal(claims.scope, "https://www.googleapis.com/auth/drive");
    return Response.json({
      access_token: "delegated-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  const session = await createCredentialSession({
    jobType: "file_migration",
    config: { ...config, impersonate: true, subject: "files@example.com" },
    jobDirectory,
  });
  t.after(() => session.dispose());
  assert.equal(await session.googleToken(), "delegated-token");
});

test("file tokens omit the subject when impersonation is off", async (t) => {
  const { jobDirectory, config } = await operatorFiles(t, source.join("\n"));
  t.mock.method(globalThis, "fetch", async (_target: unknown, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    const claims = JSON.parse(
      Buffer.from(body.get("assertion")!.split(".")[1]!, "base64url").toString(),
    );
    assert.equal(claims.sub, undefined);
    assert.equal(claims.scope, "https://www.googleapis.com/auth/drive");
    return Response.json({ access_token: "self-token", token_type: "Bearer", expires_in: 3600 });
  });
  const session = await createCredentialSession({
    jobType: "file_migration",
    config: { ...config, impersonate: false, subject: "ignored@example.com" },
    jobDirectory,
  });
  t.after(() => session.dispose());
  assert.equal(await session.googleToken(), "self-token");
});

test("operator rclone impersonation refuses even when job delegation is enabled", async (t) => {
  const { jobDirectory, config } = await operatorFiles(t, source.join("\n"));
  await appendFile(config.rclone.config.path, "impersonate = other@example.com\n");
  await assert.rejects(
    createCredentialSession({
      jobType: "file_migration",
      config: { ...config, impersonate: true, subject: "files@example.com" },
      jobDirectory,
    }),
    { code: "credential_backend_unsupported" },
  );
});

async function archiveFiles(t: { after: (fn: () => Promise<unknown>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "migmate-archive-credentials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const graphPath = join(directory, "graph-secret");
  const googlePath = join(directory, "service-account.json");
  const googleSecret = serviceAccount();
  await writeFile(graphPath, entraSecret, { mode: 0o600 });
  await writeFile(googlePath, googleSecret, { mode: 0o600 });
  const jobDirectory = await mkdtemp(join(directory, "job-"));
  return {
    jobDirectory,
    googleSecret,
    config: {
      destination: { destDriveId: mapping.destDriveId, destFolderId: mapping.destFolderId },
      graph: { tenantId, clientId },
      secrets: {
        teams_graph_client_secret: { resolver: "file", path: graphPath },
        google_service_account: { resolver: "file", path: googlePath },
      },
    },
  };
}

test("an archive authenticates its separate Google service account without exposing secret bytes", async (t) => {
  const { config, jobDirectory, googleSecret } = await archiveFiles(t);
  const googleToken = "google-access-token-canary";
  const graphResponse = graphToken(["Chat.Read.All"]);
  t.mock.method(globalThis, "fetch", async (target: string | URL | Request, init?: RequestInit) => {
    if (String(target) === `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`)
      return Response.json(graphResponse);
    assert.equal(String(target), "https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init?.body));
    const assertion = body.get("assertion")!;
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString());
    assert.equal(claims.iss, "migmate@migmate-test.iam.gserviceaccount.com");
    assert.equal(claims.scope, "https://www.googleapis.com/auth/drive");
    assert.equal(claims.sub, undefined);
    return Response.json({ access_token: googleToken, token_type: "Bearer", expires_in: 3600 });
  });
  const session = await createCredentialSession({ jobType: "teams_archive", config, jobDirectory });
  t.after(() => session.dispose());
  assert.equal(await session.googleToken(), googleToken);
  const evidence = await session.evidence();
  const google = evidence.google as Record<string, unknown>;
  assert.equal(google.subject, "migmate@migmate-test.iam.gserviceaccount.com");
  assert.deepEqual(google.grantedScopes, ["https://www.googleapis.com/auth/drive"]);
  const localSession = await createCredentialSession({
    jobType: "teams_archive",
    jobDirectory,
    config: {
      graph: config.graph,
      secrets: { teams_graph_client_secret: config.secrets.teams_graph_client_secret },
    },
  });
  t.after(() => localSession.dispose());
  await assert.rejects(localSession.googleToken(), { code: "credential_google_unavailable" });
  assert.notEqual(await session.identity(), await localSession.identity());
  const visible = JSON.stringify({ session, evidence, identity: await session.identity() });
  for (const secret of [
    entraSecret,
    googleToken,
    graphResponse.access_token,
    JSON.parse(googleSecret).private_key.split("\n")[1],
  ]) {
    assert.equal(visible.includes(secret), false);
  }
});

test("archive Graph roles remain an exclusive six-role allowlist with or without a destination", async (t) => {
  const { config, jobDirectory } = await archiveFiles(t);
  const permitted = [
    "Channel.ReadBasic.All",
    "ChannelMessage.Read.All",
    "Chat.Read.All",
    "OnlineMeetings.Read.All",
    "OnlineMeetingTranscript.Read.All",
    "Files.Read.All",
  ];
  for (const destination of [false, true]) {
    for (const extraRole of [false, true]) {
      const token = graphToken(extraRole ? [...permitted, "Sites.Read.All"] : permitted);
      t.mock.method(globalThis, "fetch", async () => Response.json(token));
      const session = await createCredentialSession({
        jobType: "teams_archive",
        jobDirectory,
        config: destination
          ? config
          : {
              graph: config.graph,
              secrets: { teams_graph_client_secret: config.secrets.teams_graph_client_secret },
            },
      });
      try {
        if (extraRole)
          await assert.rejects(session.graphToken(), { code: "credential_permissions_invalid" });
        else assert.equal(await session.graphToken(), token.access_token);
      } finally {
        session.dispose();
      }
    }
  }
});

test("archive destination credentials must be external file references, not inline secrets", async (t) => {
  const { config, jobDirectory, googleSecret } = await archiveFiles(t);
  const insidePath = join(jobDirectory, "service-account.json");
  await writeFile(insidePath, googleSecret, { mode: 0o600 });
  for (const [reference, code] of [
    [undefined, "credential_config_invalid"],
    [JSON.parse(googleSecret), "credential_config_unsupported"],
    [{ resolver: "file", path: insidePath }, "credential_inside_job"],
  ] as const) {
    await assert.rejects(
      createCredentialSession({
        jobType: "teams_archive",
        jobDirectory,
        config: {
          ...config,
          secrets: { ...config.secrets, google_service_account: reference },
        },
      }),
      (error: unknown) =>
        error instanceof ProviderFault &&
        error.code === code &&
        !JSON.stringify(error).includes(entraSecret) &&
        !JSON.stringify(error).includes("PRIVATE KEY"),
    );
  }
});

const dropboxSource = [
  ["type", "dropbox"],
  ["client_id", "dropbox-app"],
  ["impersonate_admin", "dbmid:admin"],
] satisfies [string, string][];

test("Dropbox offline authorization uses single-use S256 PKCE and records only the initial grant", async (t) => {
  const authorization = beginDropboxAuthorization("dropbox-app");
  const url = new URL(authorization.url);
  assert.equal(url.origin, "https://www.dropbox.com");
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("token_access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), DROPBOX_READ_SCOPES.join(" "));
  assert.equal(url.searchParams.has("redirect_uri"), false);
  assert.equal(url.searchParams.has("include_granted_scopes"), false);
  const other = beginDropboxAuthorization("dropbox-app");
  assert.notEqual(
    new URL(other.url).searchParams.get("code_challenge"),
    url.searchParams.get("code_challenge"),
  );
  let requests = 0;
  let sentBody: URLSearchParams | undefined;
  t.mock.method(globalThis, "fetch", async (target: unknown, init?: RequestInit) => {
    requests++;
    assert.equal(String(target), "https://api.dropboxapi.com/oauth2/token");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    assert.ok(init.body instanceof URLSearchParams);
    sentBody = init.body;
    assert.equal(sentBody.get("grant_type"), "authorization_code");
    assert.equal(sentBody.get("code"), "pasted-code-canary");
    assert.equal(sentBody.get("client_id"), "dropbox-app");
    assert.equal(sentBody.has("client_secret"), false);
    const verifier = sentBody.get("code_verifier");
    assert.ok(verifier);
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(
      createHash("sha256").update(verifier).digest("base64url"),
      url.searchParams.get("code_challenge"),
    );
    return Response.json({
      access_token: "dropbox-access-canary",
      token_type: "bearer",
      expires_in: 14400,
      refresh_token: "dropbox-refresh-canary",
      team_id: "dbtid:team",
      scope: [...DROPBOX_READ_SCOPES].reverse().join(" "),
    });
  });
  const fields = await authorization.exchange("pasted-code-canary", new AbortController().signal);
  assert.equal(sentBody?.has("code"), false);
  assert.equal(sentBody?.has("code_verifier"), false);
  const credential = loadDropboxCredential(new Map([...dropboxSource, ...fields]));
  t.after(() => credential.refreshToken.fill(0));
  assert.equal(credential.teamId, "dbtid:team");
  assert.equal(credential.adminId, "dbmid:admin");
  assert.equal(credential.refreshToken.toString(), "dropbox-refresh-canary");
  assert.deepEqual(credential.grantedScopes, [...DROPBOX_READ_SCOPES].sort());
  await assert.rejects(authorization.exchange("another-code", new AbortController().signal), {
    code: "credential_authentication_failed",
  });
  assert.equal(requests, 1);
});

for (const grant of [
  undefined,
  "",
  "files.content.read",
  `${DROPBOX_READ_SCOPES.join(" ")} files.content.write`,
  `${DROPBOX_READ_SCOPES.join(" ")} sharing.write`,
  `${DROPBOX_READ_SCOPES.join(" ")} team_data.content.write`,
  `${DROPBOX_READ_SCOPES.join(" ")} members.write`,
  `${DROPBOX_READ_SCOPES.join(" ")} team_data.governance.write`,
  `${DROPBOX_READ_SCOPES.join(" ")} unknown.permission`,
]) {
  test(`Dropbox refuses absent, incomplete or wider initial scope proof: ${grant ?? "absent"}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        access_token: "access-canary",
        token_type: "bearer",
        expires_in: 14400,
        refresh_token: "refresh-canary",
        team_id: "dbtid:team",
        scope: grant,
      }),
    );
    await assert.rejects(
      beginDropboxAuthorization("dropbox-app").exchange(
        "code-canary",
        new AbortController().signal,
      ),
      { code: "credential_permissions_invalid" },
    );
  });
}

test("Dropbox refresh uses retained issuance proof without requiring repeated scopes", async (t) => {
  let request = 0;
  t.mock.method(globalThis, "fetch", async (_target: unknown, init?: RequestInit) => {
    request++;
    assert.ok(init?.body instanceof URLSearchParams);
    if (request === 1)
      return Response.json({
        access_token: "initial-token",
        token_type: "Bearer",
        expires_in: 14400,
        refresh_token: "refresh-canary",
        team_id: "dbtid:team",
        scope: DROPBOX_READ_SCOPES.join(" "),
      });
    assert.equal(init.body.get("grant_type"), "refresh_token");
    assert.equal(init.body.get("refresh_token"), "refresh-canary");
    assert.equal(init.body.get("client_id"), "dropbox-app");
    assert.equal(init.body.has("scope"), false);
    return Response.json({
      access_token: "refreshed-token",
      token_type: "Bearer",
      expires_in: 14400,
    });
  });
  const fields = await beginDropboxAuthorization("dropbox-app").exchange(
    "code",
    new AbortController().signal,
  );
  const section = new Map([...dropboxSource, ...fields]);
  const credential = loadDropboxCredential(section);
  t.after(() => credential.refreshToken.fill(0));
  const token = await requestDropboxToken(credential, new AbortController().signal);
  assert.equal(token.value, "refreshed-token");
  assert.deepEqual(token.permissions, [...DROPBOX_READ_SCOPES].sort());
  const unproven = new Map(section);
  unproven.delete("migmate_scope_proof");
  assert.throws(() => loadDropboxCredential(unproven), { code: "credential_permissions_invalid" });
  const swappedApp = new Map(section);
  swappedApp.set("client_id", "other-app");
  assert.throws(() => loadDropboxCredential(swappedApp), {
    code: "credential_permissions_invalid",
  });
  const swappedToken = new Map(section);
  swappedToken.set("token", JSON.stringify({ refresh_token: "different-refresh" }));
  assert.throws(() => loadDropboxCredential(swappedToken), {
    code: "credential_permissions_invalid",
  });
  const corruptedProof = new Map(section);
  corruptedProof.set("migmate_scope_proof", "{}");
  assert.throws(() => loadDropboxCredential(corruptedProof), {
    code: "credential_permissions_invalid",
  });
});

for (const [key, value] of [
  ["shared_folders", "true"],
  ["shared_folders", "false"],
  ["impersonate", "admin@example.test"],
  ["client_secret", "secret"],
  ["auth_url", "https://attacker.invalid"],
  ["skip_exports", "true"],
] satisfies [string, string][]) {
  test(`Dropbox source refuses ${key}=${value}`, () => {
    assert.throws(() => dropboxRemoteSettings(new Map([...dropboxSource, [key, value]])), {
      code: "credential_backend_unsupported",
    });
  });
}

test("Dropbox credential session authenticates once, retains grant evidence and disposes", async (t) => {
  let refreshes = 0;
  t.mock.method(globalThis, "fetch", async (target: unknown, init?: RequestInit) => {
    if (String(target) === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "google-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    assert.equal(String(target), "https://api.dropboxapi.com/oauth2/token");
    assert.ok(init?.body instanceof URLSearchParams);
    if (init.body.get("grant_type") === "authorization_code")
      return Response.json({
        access_token: "initial-token",
        token_type: "Bearer",
        expires_in: 14400,
        refresh_token: "refresh-canary",
        team_id: "dbtid:team",
        scope: DROPBOX_READ_SCOPES.join(" "),
      });
    refreshes++;
    return Response.json({
      access_token: "session-token",
      token_type: "Bearer",
      expires_in: 14400,
    });
  });
  const fields = await beginDropboxAuthorization("dropbox-app").exchange(
    "code",
    new AbortController().signal,
  );
  const files = await operatorFiles(
    t,
    [...dropboxSource, ...fields].map(([key, value]) => `${key} = ${value}`).join("\n"),
  );
  const session = await createCredentialSession({
    jobType: "file_migration",
    jobDirectory: files.jobDirectory,
    config: {
      sourceProvider: "dropbox",
      destinationProvider: "google_shared_drive",
      rclone: {
        config: files.config.rclone.config,
        dropboxRemote: "sharepoint-source",
        destinationRemote: "google-destination",
      },
    },
  });
  t.after(() => session.dispose());
  assert.equal(session.dropboxAdminId, "dbmid:admin");
  assert.equal(session.dropboxRemote, "sharepoint-source");
  assert.deepEqual(await Promise.all([session.dropboxToken(), session.dropboxToken()]), [
    "session-token",
    "session-token",
  ]);
  const evidence = await session.evidence();
  assert.equal(refreshes, 1);
  assert.ok(
    evidence.dropbox && typeof evidence.dropbox === "object" && "scopeEvidence" in evidence.dropbox,
  );
  assert.equal(evidence.dropbox.scopeEvidence, "authorization_code");
  assert.doesNotMatch(JSON.stringify(evidence), /session-token|refresh-canary|initial-token/u);
  assert.match(await session.identity(), /^sha256:[a-f0-9]{64}$/u);
  session.dispose();
  await assert.rejects(session.dropboxToken(), { code: "credential_session_disposed" });
});

async function persistedDropboxCredentials(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (target: unknown, init?: RequestInit) => {
    if (String(target) === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "google-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    assert.equal(String(target), "https://api.dropboxapi.com/oauth2/token");
    assert.ok(init?.body instanceof URLSearchParams);
    return Response.json({
      access_token: "dropbox-token",
      token_type: "Bearer",
      expires_in: 14400,
      ...(init.body.get("grant_type") === "authorization_code"
        ? {
            refresh_token: "refresh-canary",
            team_id: "dbtid:team",
            scope: DROPBOX_READ_SCOPES.join(" "),
          }
        : {}),
    });
  });
  const fields = await beginDropboxAuthorization("dropbox-app").exchange(
    "code",
    new AbortController().signal,
  );
  const files = await operatorFiles(
    t,
    [...dropboxSource, ...fields].map(([key, value]) => `${key} = ${value}`).join("\n"),
  );
  return {
    jobDirectory: files.jobDirectory,
    config: {
      sourceProvider: "dropbox",
      destinationProvider: "google_shared_drive",
      rclone: {
        config: files.config.rclone.config,
        dropboxRemote: "sharepoint-source",
        destinationRemote: "google-destination",
      },
    },
  };
}

for (const sourceItemId of ["/", "id:a4ayc_80_OEAAAAAAAAAXw"]) {
  test(`persisted source item identity reconstructs Dropbox credentials: ${sourceItemId}`, async (t) => {
    const files = await persistedDropboxCredentials(t);
    for (const sourceType of ["dropbox", undefined]) {
      const persistedMapping = {
        ...mapping,
        ...(sourceType ? { sourceType } : {}),
        sourceDriveId: "123456789",
        sourceItemId,
        sourceFolderPath: sourceItemId === "/" ? "/" : "/Department",
      };
      const session = await createCredentialSession({
        jobType: "file_migration",
        jobDirectory: files.jobDirectory,
        config: { ...files.config, mappings: [persistedMapping] },
      });
      t.after(() => session.dispose());
      assert.equal(session.rcloneConfigPath, await realpath(files.config.rclone.config.path));
      assert.equal(await session.dropboxToken(), "dropbox-token");
      const evidence = await session.evidence();
      assert.deepEqual(evidence.mappings, [
        {
          ...(sourceType ? { sourceType } : {}),
          sourceDriveId: "123456789",
          sourceItemId,
          destDriveId: mapping.destDriveId,
          destFolderId: mapping.destFolderId,
        },
      ]);
      assert.ok(evidence.dropbox && typeof evidence.dropbox === "object");
      assert.equal(Reflect.get(evidence.dropbox, "scopeEvidence"), "authorization_code");
    }
  });
}

test("persisted source item identity rejects Dropbox paths and malformed immutable IDs", async (t) => {
  const files = await persistedDropboxCredentials(t);
  for (const sourceItemId of [
    "folder",
    "root",
    ".",
    "..",
    "/Department",
    "//",
    "id:",
    "id:folder/child",
    "id:folder:child",
    "id:folder child",
    "id:folder\n",
    "id:folder.",
    "ns:123456789",
    "",
  ]) {
    await assert.rejects(
      createCredentialSession({
        jobType: "file_migration",
        jobDirectory: files.jobDirectory,
        config: {
          ...files.config,
          mappings: [
            { ...mapping, sourceType: "dropbox", sourceDriveId: "123456789", sourceItemId },
          ],
        },
      }),
      { code: "credential_mapping_invalid" },
      JSON.stringify(sourceItemId),
    );
  }
});

test("persisted source item identity keeps SharePoint and Google slash and colon refusals", async (t) => {
  const files = await operatorFiles(t, source.join("\n"));
  for (const providers of [forwardProviders, reverseProviders]) {
    for (const sourceItemId of ["/", "folder/child", "id:a4ayc_80_OEAAAAAAAAAXw", "folder:child"]) {
      for (const sourceType of [providers.sourceProvider, undefined]) {
        await assert.rejects(
          createCredentialSession({
            jobType: "file_migration",
            jobDirectory: files.jobDirectory,
            config: {
              ...files.config,
              ...providers,
              mappings: [{ ...mapping, ...(sourceType ? { sourceType } : {}), sourceItemId }],
            },
          }),
          { code: "credential_mapping_invalid" },
          `${providers.sourceProvider}: ${sourceItemId}`,
        );
      }
    }
  }
});

test("Dropbox OAuth HTTP refusals suppress provider response secrets", async (t) => {
  let body: URLSearchParams | undefined;
  t.mock.method(globalThis, "fetch", async (_target: unknown, init?: RequestInit) => {
    assert.ok(init?.body instanceof URLSearchParams);
    body = init.body;
    return Response.json({ error_description: "provider-secret-canary" }, { status: 400 });
  });
  await assert.rejects(
    beginDropboxAuthorization("dropbox-app").exchange(
      "code-secret-canary",
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderFault);
      assert.equal(error.code, "credential_authentication_failed");
      assert.doesNotMatch(JSON.stringify(error), /provider-secret-canary|code-secret-canary/u);
      return true;
    },
  );
  assert.equal(body?.has("code"), false);
  assert.equal(body?.has("code_verifier"), false);
});

test("Dropbox refresh cannot replace the initial proof with a wider grant", async (t) => {
  let refreshing = false;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      refreshing
        ? {
            access_token: "refreshed",
            token_type: "Bearer",
            expires_in: 14400,
            scope: `${DROPBOX_READ_SCOPES.join(" ")} files.content.write`,
          }
        : {
            access_token: "initial",
            token_type: "Bearer",
            expires_in: 14400,
            refresh_token: "refresh",
            team_id: "dbtid:team",
            scope: DROPBOX_READ_SCOPES.join(" "),
          },
    ),
  );
  const fields = await beginDropboxAuthorization("dropbox-app").exchange(
    "code",
    new AbortController().signal,
  );
  const credential = loadDropboxCredential(new Map([...dropboxSource, ...fields]));
  t.after(() => credential.refreshToken.fill(0));
  refreshing = true;
  await assert.rejects(requestDropboxToken(credential, new AbortController().signal), {
    code: "credential_permissions_invalid",
  });
  assert.deepEqual(credential.grantedScopes, [...DROPBOX_READ_SCOPES].sort());
});
