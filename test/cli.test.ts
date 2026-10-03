import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir, userInfo, hostname } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { run, type Io } from "../src/cli/main.ts";
import { defaultHome, parseInvocation } from "../src/cli/arguments.ts";
import { knownContract } from "../src/cli/envelope.ts";
import {
  openEngine,
  type Engine,
  type JobStatus,
  type Outcome,
  type PlanRevision,
  type RowPage,
  type ApprovalRecord,
  type ExecuteResult,
  type ArtifactSet,
} from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import { cliFixture, CLI_JOB_CONFIG } from "./cli-fixture.ts";
import { discoverSharePoint, type SharePointDiscovery } from "../src/engine/providers/discovery.ts";
import type { GraphTransport } from "../src/engine/providers/http.ts";
import { createProductionProvider } from "../src/engine/providers/production.ts";

interface Capture {
  code: number;
  stdout: string;
  stderr: string;
  prompts: number;
}
interface Document<T> {
  schemaVersion: number;
  command: string;
  commandId: string;
  job: { id: string; type: string | null } | null;
  ok: boolean;
  value: T;
  refusal: { code: string; detail?: Record<string, unknown>; recovery?: Record<string, unknown> };
}
function document<T>(capture: Capture): Document<T> {
  assert.equal(capture.stderr, "");
  const parsed: Document<T> = JSON.parse(capture.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.match(parsed.commandId, /^[\da-f-]{36}$/u);
  assert.notEqual("value" in parsed, "refusal" in parsed);
  return parsed;
}
async function invoke(
  argv: string[],
  engine?: Engine,
  options: {
    tty?: boolean[];
    answer?: string;
    write?: Io["stdout"]["write"];
    signal?: AbortSignal;
  } = {},
): Promise<Capture> {
  let stdout = "",
    stderr = "",
    prompts = 0;
  const io: Io = {
    stdout: {
      isTTY: options.tty?.[1] ?? false,
      async write(chunk) {
        if (options.write) await options.write(chunk);
        stdout += chunk;
      },
    },
    stderr: {
      isTTY: options.tty?.[2] ?? false,
      write(chunk) {
        stderr += chunk;
      },
    },
    stdin: {
      isTTY: options.tty?.[0] ?? false,
      async readLine() {
        prompts++;
        return options.answer ?? null;
      },
    },
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const code = await run(argv, io, engine);
  return { code, stdout, stderr, prompts };
}
function invokeProcess(argv: string[], cwd: string, environment: NodeJS.ProcessEnv = {}): Capture {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)), ...argv, "--output", "json"],
    {
      cwd,
      env: { ...process.env, ...environment, MIGMATE_HOME: environment.MIGMATE_HOME },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, null);
  return { code: result.status!, stdout: result.stdout, stderr: result.stderr, prompts: 0 };
}

it("binds final planning and complete freeze attestations to their commands", () => {
  assert.equal(parseInvocation(["plan", "--job", "staged", "--final"]).final, true);
  const freeze = [
    "--freeze-by",
    "Morgan",
    "--freeze-at",
    "2026-10-04T12:00:00Z",
    "--freeze-how",
    "Source made read-only",
  ];
  assert.deepEqual(parseInvocation(["approve", "--job", "staged", ...freeze]).freeze, {
    by: "Morgan",
    at: "2026-10-04T12:00:00Z",
    how: "Source made read-only",
  });
  assert.throws(() => parseInvocation(["execute", "--job", "staged", "--final"]));
  assert.throws(() => parseInvocation(["plan", "--job", "staged", "--final", "--review"]));
  assert.throws(() => parseInvocation(["approve", "--job", "staged", "--freeze-by", "Morgan"]));
  assert.throws(() => parseInvocation(["plan", "--job", "staged", ...freeze]));
  assert.throws(() =>
    parseInvocation([
      "approve",
      "--job",
      "staged",
      ...freeze.slice(0, 3),
      "yesterday",
      ...freeze.slice(4),
    ]),
  );
});

it("fails closed on unknown cutover stages without rejecting unstaged plans", () => {
  assert.equal(knownContract({ value: { currentPlan: { stage: "future_stage" } } }), false);
  for (const stage of ["prestage", "delta", "final"])
    assert.equal(knownContract({ value: { currentPlan: { stage } } }), true);
  assert.equal(knownContract({ value: { currentPlan: { revision: 1 } } }), true);
});
function harness(t: TestContext, fixture = cliFixture()) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "migmate-cli-contract-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const provider = new FakeFileMigrationPort(fixture);
  const engine = () => openEngine({ home, provider, adapter: "cli" });
  return { home, provider, engine };
}
async function planned(t: TestContext) {
  const h = harness(t);
  const config = join(h.home, "input.toml");
  writeFileSync(config, stringifyToml(CLI_JOB_CONFIG));
  const init = document<{ id: string }>(
    await invoke(
      ["init", "--type", "file_migration", "--config", config, "--output", "json"],
      h.engine(),
    ),
  );
  assert.equal(init.ok, true);
  const id = init.value.id;
  const plan = document<PlanRevision & { review: RowPage }>(
    await invoke(["plan", "--job", id, "--limit", "2", "--output", "json"], h.engine()),
  );
  assert.equal(plan.ok, true);
  return { ...h, id, plan: plan.value };
}

it("refuses a plan without mappings with manifest-load guidance, not a credential error", async (t) => {
  const h = harness(t);
  const initialized = await h.engine().initJob({ type: "file_migration", config: {} });
  assert.ok(initialized.ok);
  const id = initialized.value.id;
  const plan = await invoke(["plan", "--job", id, "--output", "json"], h.engine());
  assert.equal(plan.code, 2);
  const refusal = document<never>(plan).refusal;
  assert.equal(refusal.code, "configuration_invalid");
  assert.deepEqual(refusal.detail, { field: "mappings" });
  assert.match(Reflect.get(refusal, "message"), /manifest load/u);
  for (const [command, code] of [
    ["execute", "approval_required"],
    ["verify", "verification_unaccepted"],
  ]) {
    const result = await invoke([command!, "--job", id, "--output", "json"], h.engine());
    assert.equal(result.code, 4);
    assert.equal(document<never>(result).refusal.code, code);
  }
});

it("onboards a fresh job, discovers an unloaded draft, and plans its reviewed manifest", async (t) => {
  const h = harness(t, {
    ...cliFixture(),
    googleAbout: { user: { emailAddress: "files@example.com" }, canCreateDrives: true },
  });
  const graph: GraphTransport = {
    async evidence() {
      return { grantedPermissions: ["Sites.Read.All"] };
    },
    async request<T>(path: string): Promise<T> {
      if (path === "/v1.0/sites/getAllSites")
        return JSON.parse(
          JSON.stringify({
            value: [
              {
                id: "site",
                displayName: "Operations",
                webUrl: "https://tenant.sharepoint.com/sites/operations",
              },
            ],
          }),
        );
      if (path === "/v1.0/sites/site/drives" || path === "/v1.0/sites/team/sites")
        return JSON.parse('{"value":[]}');
      if (path === "/v1.0/sites/site/sites")
        return JSON.parse(
          JSON.stringify({
            value: [
              {
                id: "team",
                displayName: "Team",
                webUrl: "https://tenant.sharepoint.com/sites/operations/team",
              },
            ],
          }),
        );
      assert.equal(path, "/v1.0/sites/team/drives");
      return JSON.parse(
        JSON.stringify({
          value: [{ id: "src-drive", name: "Documents", driveType: "documentLibrary" }],
        }),
      );
    },
    async *stream() {
      throw new Error("Discovery cannot read bytes");
    },
  };
  const keyPath = join(h.home, "google.json");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(
    keyPath,
    JSON.stringify({
      type: "service_account",
      project_id: "migmate-test",
      private_key_id: "a".repeat(40),
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      client_email: "migmate@migmate-test.iam.gserviceaccount.com",
      client_id: "123456789012345678901",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    { mode: 0o600 },
  );
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const clientId = "22222222-2222-2222-2222-222222222222";
  const rclonePath = join(h.home, "rclone.conf");
  writeFileSync(
    rclonePath,
    `[sharepoint]\ntype = onedrive\nclient_id = ${clientId}\nclient_secret = test-secret\nclient_credentials = true\ntenant = ${tenantId}\ndrive_type = documentLibrary\ndrive_id = src-drive\n\n[google]\ntype = drive\nscope = drive\nservice_account_file = ${keyPath}\nteam_drive = dst-drive\nroot_folder_id = dst-root\n`,
    { mode: 0o600 },
  );
  const config = {
    route: "sharepoint_library_to_shared_drive",
    options: { verificationMode: "hash" },
    rclone: {
      config: { resolver: "file", path: rclonePath, mode: "0600" },
      sourceRemote: "sharepoint",
      destinationRemote: "google",
    },
  };
  const configPath = join(h.home, "operator.toml");
  writeFileSync(configPath, stringifyToml(config));
  t.mock.method(globalThis, "fetch", async (target: string | URL | Request) => {
    const url = new URL(typeof target === "string" || target instanceof URL ? target : target.url);
    if (url.hostname === "login.microsoftonline.com") {
      const claims = {
        tid: tenantId,
        appid: clientId,
        aud: "https://graph.microsoft.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        roles: ["Sites.Read.All"],
      };
      return Response.json({
        access_token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({
        access_token: "google-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    assert.equal(url.hostname, "graph.microsoft.com");
    return Response.json(await graph.request(url.pathname));
  });
  const initialized = document<{ id: string }>(
    await invoke(["init", "--type", "file_migration", "--output", "json"], h.engine()),
  );
  assert.equal(initialized.ok, true);
  const id = initialized.value.id;
  // Exercise real credential/preflight and discovery effects, keeping transfer
  // workers and mapping trees at the existing fake-provider seam.
  h.provider.preflight = async function* (input) {
    const production = createProductionProvider(input);
    try {
      for await (const check of production.preflight!(input)) {
        assert.equal(check.id, "provider.credentials");
        yield check;
        break;
      }
    } finally {
      await production.close?.();
    }
  };
  const discovery = createProductionProvider({
    jobType: "file_migration",
    config,
    jobDirectory: join(h.home, "jobs", id),
  });
  t.after(() => discovery.close?.());
  Object.assign(h.provider, { discoverSharePoint: () => discovery.discoverSharePoint!() });
  const onboard = await invoke(
    ["creds", "init", "--job", id, "--config", configPath, "--output", "json"],
    h.engine(),
  );
  assert.equal(onboard.code, 0, onboard.stdout);
  assert.equal(document<{ passed: boolean }>(onboard).value.passed, true);
  const doctor = await invoke(["doctor", "--job", id, "--output", "json"], h.engine());
  assert.equal(doctor.code, 0, doctor.stdout);
  assert.equal(document<{ passed: boolean }>(doctor).value.passed, true);
  const before = await h.engine().reader({ id }).status();
  const file = join(h.home, "draft.json");
  const capture = await invoke(
    ["discover", "--job", id, "--file", file, "--output", "json"],
    h.engine(),
  );
  assert.equal(capture.code, 0);
  const result = document<SharePointDiscovery>(capture);
  assert.equal(result.command, "discover");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.manifest, {
    version: 1,
    mappings: [
      {
        id: "src-drive",
        source: { type: "sharepoint", driveId: "src-drive", folderPath: "" },
        destination: {
          type: "google_shared_drive",
          create: "Team (tenant.sharepoint.com/sites/operations/team) - Documents",
        },
        members: [],
      },
    ],
  });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), result.value.manifest);
  const envelopeOnly = await invoke(["discover", "--job", id, "--output", "json"], h.engine());
  assert.equal(envelopeOnly.code, 0);
  assert.deepEqual(document<SharePointDiscovery>(envelopeOnly).value, result.value);
  assert.deepEqual(
    await h.engine().reader({ id }).status(),
    before,
    "discovery never loads its draft",
  );
  const reviewed = {
    ...result.value.manifest,
    mappings: result.value.manifest.mappings.map((mapping) => ({
      ...mapping,
      members: [{ email: "owners@example.com", type: "group", role: "organizer" }],
    })),
  };
  writeFileSync(file, JSON.stringify(reviewed));
  const loaded = await invoke(
    ["manifest", "load", "--job", id, "--file", file, "--output", "json"],
    h.engine(),
  );
  assert.equal(loaded.code, 0);
  assert.equal(document<{ mappingCount: number }>(loaded).value.mappingCount, 1);
  const plan = await invoke(["plan", "--job", id, "--output", "json"], h.engine());
  assert.equal(plan.code, 0, plan.stdout);
  const proposal = document<PlanRevision>(plan);
  assert.equal(proposal.ok, true);
  assert.match(proposal.value.planDigest, /^[a-f0-9]{64}$/u);
});

it("discover refuses site-scoped access in the JSON envelope without writing a draft", async (t) => {
  const h = harness(t);
  const graph: GraphTransport = {
    async evidence() {
      return { grantedPermissions: ["Sites.Selected"] };
    },
    async request() {
      throw new Error("Site-scoped access cannot enumerate");
    },
    async *stream() {
      throw new Error("Discovery cannot read bytes");
    },
  };
  Object.assign(h.provider, { discoverSharePoint: () => discoverSharePoint(graph) });
  const initialized = await h.engine().initJob({ type: "file_migration", config: CLI_JOB_CONFIG });
  assert.ok(initialized.ok);
  const file = join(h.home, "refused-draft.json");
  const capture = await invoke(
    ["discover", "--job", initialized.value.id, "--file", file, "--output", "json"],
    h.engine(),
  );
  assert.equal(capture.code, 4);
  const result = document<never>(capture);
  assert.equal(result.ok, false);
  assert.equal(result.refusal.code, "preflight_failed");
  assert.deepEqual(result.refusal.detail, {
    check: "discovery_requires_sites_read_all",
    requiredGrant: "Sites.Read.All",
  });
  assert.equal(existsSync(file), false);
});

it("refuses unsupported manifest extensions and malformed CSV without replacing stored mappings", async (t) => {
  const h = harness(t);
  const initialized = await h.engine().initJob({ type: "file_migration", config: CLI_JOB_CONFIG });
  assert.equal(initialized.ok, true);
  const mapping = {
    id: "library",
    source: { type: "sharepoint", driveId: "src-drive", folderPath: "" },
    destination: { type: "google_shared_drive", driveId: "dst-drive", folderId: "dst-root" },
  };
  const path = join(h.home, "invalid.json");
  for (const [invalid, row, field] of [
    [{ version: 1, mappings: [mapping], mirror: true }, 0, "mirror"],
    [{ version: 1, mappings: [{ ...mapping, members: [] }] }, 1, "members"],
    ...["anyone", "domain"].map((type) => [
      {
        version: 1,
        mappings: [
          {
            ...mapping,
            destination: { type: "google_shared_drive", create: "New drive" },
            members: [{ email: "team@example.com", type, role: "reader" }],
          },
        ],
      },
      1,
      "members.0.type",
    ]),
    [
      {
        version: 1,
        mappings: [{ ...mapping, destination: { ...mapping.destination, create: "New drive" } }],
      },
      1,
      "destination.create",
    ],
    [{ version: 1, mappings: [mapping, mapping] }, 2, "id"],
    [
      {
        version: 1,
        mappings: [{ ...mapping, source: { ...mapping.source, folderPath: "../outside" } }],
      },
      1,
      "source.folderPath",
    ],
    [
      { version: 1, mappings: [{ ...mapping, source: { ...mapping.source, driveId: "root" } }] },
      1,
      "source.driveId",
    ],
  ]) {
    writeFileSync(path, JSON.stringify(invalid));
    const result = await invoke(
      ["manifest", "load", "--job", initialized.value.id, "--file", path, "--output", "json"],
      h.engine(),
    );
    assert.equal(result.code, 2);
    assert.deepEqual(document(result).refusal.detail, { row, field });
  }
  const csv = join(h.home, "invalid.csv");
  writeFileSync(csv, "id,source.driveId,unexpected\nlibrary,src-drive,ignored\n");
  const result = await invoke(
    ["manifest", "load", "--job", initialized.value.id, "--file", csv, "--output", "json"],
    h.engine(),
  );
  assert.equal(result.code, 2);
  assert.deepEqual(document(result).refusal.detail, { row: 0, field: "header" });
  const status = document<{ review: RowPage }>(
    await invoke(
      [
        "status",
        "--job",
        initialized.value.id,
        "--view",
        "mappings",
        "--mapping",
        "map-1",
        "--output",
        "json",
      ],
      h.engine(),
    ),
  );
  assert.equal(status.value.review.totalRows, 1);
});

it("loads CSV drives-to-create and refuses public member types in the members cell", async (t) => {
  const h = harness(t);
  const init = document<{ id: string }>(
    await invoke(["init", "--type", "file_migration", "--output", "json"], h.engine()),
  );
  const path = join(h.home, "provision.csv");
  const args = ["manifest", "load", "--job", init.value.id, "--file", path, "--output", "json"];
  for (const type of ["group", "anyone", "domain"]) {
    const members = JSON.stringify([
      { email: "team@example.com", type, role: "organizer" },
    ]).replaceAll('"', '""');
    writeFileSync(
      path,
      `id,source.type,source.driveId,source.folderPath,destination.type,destination.driveId,destination.folderId,destination.create,members\nlibrary,sharepoint,src-drive,,google_shared_drive,,,"Finance, records","${members}"\n`,
    );
    const loaded = await invoke(args, h.engine());
    assert.equal(loaded.code, type === "group" ? 0 : 2, loaded.stdout);
    if (type !== "group")
      assert.deepEqual(document(loaded).refusal.detail, { row: 1, field: "members.0.type" });
  }
  const rows = await h
    .engine()
    .reader({ id: init.value.id })
    .rows({ phase: "plan", view: "mappings" });
  assert.equal(rows.ok, true);
  if (!rows.ok) throw new Error("Stored mapping missing");
  const row = rows.value.rows[0]!;
  assert.equal(row.jobType, "file_migration");
  if (row.jobType === "file_migration")
    assert.deepEqual(row.mapping?.createDrive, {
      name: "Finance, records",
      members: [{ email: "team@example.com", type: "group", role: "organizer" }],
    });
});

it("loads JSON and CSV mapping manifests into the job and names invalid rows and fields", async (t) => {
  const h = harness(t);
  const init = document<{ id: string }>(
    await invoke(["init", "--type", "file_migration", "--output", "json"], h.engine()),
  );
  const path = join(h.home, "manifest.json");
  assert.equal(init.ok, true, JSON.stringify(init));
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      mappings: [
        {
          id: "library",
          source: { type: "sharepoint", driveId: "src-drive", folderPath: "" },
          destination: { type: "google_shared_drive", driveId: "dst-drive", folderId: "dst-root" },
        },
      ],
    }),
  );
  const args = ["manifest", "load", "--job", init.value.id, "--file", path, "--output", "json"];
  const loaded = await invoke(args, h.engine());
  assert.equal(loaded.code, 0);
  const result = document<{ mappingCount: number; manifestDigest: string }>(loaded);
  assert.equal(result.command, "manifest load");
  assert.equal(result.value.mappingCount, 1);
  assert.match(result.value.manifestDigest, /^[a-f0-9]{64}$/u);
  const pending = document<{ review: RowPage }>(
    await invoke(
      [
        "status",
        "--job",
        init.value.id,
        "--view",
        "mappings",
        "--search",
        "library",
        "--limit",
        "1",
        "--output",
        "json",
      ],
      h.engine(),
    ),
  );
  assert.equal(pending.value.review.totalRows, 1);
  assert.equal(pending.value.review.rows[0]?.jobType, "file_migration");
  const csv = join(h.home, "manifest.csv");
  writeFileSync(
    csv,
    "id,source.type,source.driveId,source.folderPath,destination.type,destination.driveId,destination.folderId\r\nlibrary,sharepoint,src-drive,,google_shared_drive,dst-drive,dst-root\r\n",
  );
  const csvResult = document<{ manifestDigest: string }>(
    await invoke(
      ["manifest", "load", "--job", init.value.id, "--file", csv, "--output", "json"],
      h.engine(),
    ),
  );
  assert.equal(csvResult.value.manifestDigest, result.value.manifestDigest);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      mappings: [
        {
          id: "bad",
          source: { type: "sharepoint", driveId: "", folderPath: "" },
          destination: { type: "google_shared_drive", driveId: "dst-drive", folderId: "dst-root" },
        },
      ],
    }),
  );
  const invalid = await invoke(args, h.engine());
  assert.equal(invalid.code, 2);
  assert.deepEqual(document(invalid).refusal.detail, { row: 1, field: "source.driveId" });
});

it("loads reverse JSON and eleven-column CSV manifests with row-specific path errors", async (t) => {
  const h = harness(t);
  const route = join(h.home, "reverse.toml");
  writeFileSync(route, stringifyToml({ route: "shared_drive_to_sharepoint_library" }));
  const init = document<{ id: string }>(
    await invoke(
      ["init", "--type", "file_migration", "--config", route, "--output", "json"],
      h.engine(),
    ),
  );
  const path = join(h.home, "reverse.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      mappings: [
        {
          id: "reverse",
          source: { type: "google_shared_drive", driveId: "src-drive", folderId: "src-root" },
          destination: { type: "sharepoint", driveId: "dst-drive", folderPath: "" },
        },
      ],
    }),
  );
  const json = await invoke(
    ["manifest", "load", "--job", init.value.id, "--file", path, "--output", "json"],
    h.engine(),
  );
  assert.equal(json.code, 0, json.stdout);
  const csv = join(h.home, "reverse.csv");
  const header =
    "id,source.type,source.driveId,source.folderPath,destination.type,destination.driveId,destination.folderId,destination.create,members,source.folderId,destination.folderPath\n";
  writeFileSync(
    csv,
    header + "reverse,google_shared_drive,src-drive,,sharepoint,dst-drive,,,,src-root,\n",
  );
  const args = ["manifest", "load", "--job", init.value.id, "--file", csv, "--output", "json"];
  const loaded = await invoke(args, h.engine());
  assert.equal(loaded.code, 0, loaded.stdout);
  assert.equal(
    document<{ manifestDigest: string }>(loaded).value.manifestDigest,
    document<{ manifestDigest: string }>(json).value.manifestDigest,
  );
  writeFileSync(
    csv,
    header + "reverse,google_shared_drive,src-drive,,sharepoint,dst-drive,,,,src-root,../outside\n",
  );
  const invalid = await invoke(args, h.engine());
  assert.equal(invalid.code, 2);
  assert.deepEqual(document(invalid).refusal.detail, { row: 1, field: "destination.folderPath" });
  writeFileSync(
    csv,
    header + "reverse,google_shared_drive,src-drive,ignored,sharepoint,dst-drive,,,,src-root,\n",
  );
  assert.deepEqual(document(await invoke(args, h.engine())).refusal.detail, {
    row: 1,
    field: "source.folderPath",
  });
  writeFileSync(
    csv,
    header +
      "reverse,google_shared_drive,src-drive,,sharepoint,dst-drive,,,,src-root,\n" +
      "forward,sharepoint,src-drive,,google_shared_drive,dst-drive,dst-root,,,,\n",
  );
  const mixed = await invoke(args, h.engine());
  assert.equal(mixed.code, 2);
  assert.deepEqual(document(mixed).refusal.detail, { row: 2, field: "source.type" });
});

it("emits one versioned stdout document for handled usage/configuration failures and help", async (t) => {
  const h = harness(t);
  const cases = [
    ["execute"],
    ["not-a-command"],
    ["init"],
    ["status", "--job", "../escape"],
    ["status", "--job", "missing", "--limit", "0"],
    ["status", "--job", "missing", "--from", "9007199254740992"],
    ["status", "--job", "missing", "--schema-version", "2"],
    ["execute", "--job", "missing", "--yes"],
    ["creds", "init", "--job", "missing"],
    ["reclaim", "--job", "missing"],
  ];
  for (const argv of cases)
    for (const mode of ["json", "jsonl"]) {
      const result = await invoke([...argv, "--output", mode], h.engine());
      assert.equal(result.code, 2);
      assert.equal(document(result).ok, false);
      assert.equal(result.prompts, 0);
    }
  const help = await invoke(["--help", "--output", "json"], h.engine());
  assert.equal(help.code, 0);
  assert.equal(document(help).ok, true);
  assert.equal(existsSync(join(h.home, "jobs", "escape")), false);
});

it("reports the installed release from package.json in text and JSON, and only without a command", async () => {
  const { version } = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  assert.deepEqual(await invoke(["--version"]), {
    code: 0,
    stdout: `${version}\n`,
    stderr: "",
    prompts: 0,
  });
  const json = document<{ version: string }>(await invoke(["--version", "--output", "json"]));
  assert.equal(json.command, "version");
  assert.deepEqual(json.value, { version });
  for (const argv of [
    ["status", "--job", "missing", "--version"],
    ["--version", "--version"],
  ]) {
    const refused = await invoke([...argv, "--output", "json"]);
    assert.equal(refused.code, 2);
    assert.equal(document(refused).refusal.code, "usage");
  }
  assert.equal(document(await invoke(["--help", "--version", "--output", "json"])).command, "help");
});

it("parses TOML and JSON inputs but persists only typed TOML references through onboarding", async (t) => {
  const h = harness(t);
  const secret = join(h.home, "operator-secret");
  const sentinel = "CLI-SECRET-CANARY-do-not-copy";
  writeFileSync(secret, sentinel, { mode: 0o600 });
  const config = {
    ...CLI_JOB_CONFIG,
    rclone: {
      config: { resolver: "file", path: secret, mode: "0600" },
      sourceRemote: "sharepoint",
      destinationRemote: "google",
    },
  };
  const input = join(h.home, "operator.json");
  writeFileSync(input, JSON.stringify(config));
  const init = document<{ id: string }>(
    await invoke(
      ["init", "--type", "file_migration", "--config", input, "--output", "json"],
      h.engine(),
    ),
  );
  assert.equal(init.ok, true);
  const path = join(h.home, "jobs", init.value.id, "job.toml");
  const persisted = readFileSync(path, "utf8");
  assert.deepEqual(parseToml(persisted).rclone, config.rclone);
  assert.equal(persisted.includes(sentinel), false);
  const tomlInput = join(h.home, "operator.toml");
  writeFileSync(tomlInput, stringifyToml(config));
  const onboard = await invoke(
    ["creds", "init", "--job", init.value.id, "--config", tomlInput, "--output", "json"],
    h.engine(),
  );
  const report = document<{ checks: unknown[]; passed: boolean }>(onboard);
  assert.equal(report.command, "creds init");
  assert.equal(report.ok, true);
  assert.equal(report.value.passed, true);
  assert.equal(onboard.stdout.includes(sentinel), false);
  assert.equal(readFileSync(secret, "utf8"), sentinel);
  assert.equal(existsSync(join(h.home, "jobs", init.value.id, "job.config.json")), false);
  writeFileSync(input, '{"secret":"CLI-SECRET-CANARY-do-not-copy"');
  const malformed = await invoke(
    ["creds", "init", "--job", init.value.id, "--config", input, "--output", "json"],
    h.engine(),
  );
  assert.equal(malformed.code, 2);
  assert.equal(document(malformed).refusal.code, "configuration_invalid");
  assert.equal(malformed.stdout.includes(sentinel), false);
  assert.equal(readFileSync(path, "utf8").includes(sentinel), false);
});

it("refuses missing jobs and malformed config rather than creating state", async (t) => {
  const h = harness(t);
  const status = await invoke(["status", "--job", "missing", "--output", "json"], h.engine());
  assert.equal(status.code, 2);
  assert.equal(document(status).refusal.code, "job_not_found");
  assert.equal(existsSync(join(h.home, "jobs", "missing")), false);
  const config = await invoke(
    [
      "init",
      "--type",
      "teams_archive",
      "--config",
      join(h.home, "absent.toml"),
      "--output",
      "json",
    ],
    h.engine(),
  );
  assert.equal(config.code, 2);
  assert.equal(document(config).refusal.code, "configuration_invalid");
});

it("pages and filters durable plan evidence without revising the approved digest", async (t) => {
  const h = await planned(t);
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await invoke(
      [
        "plan",
        "--review",
        "--job",
        h.id,
        "--limit",
        "2",
        "--code",
        "created",
        ...(cursor ? ["--cursor", cursor] : []),
        "--output",
        "json",
      ],
      h.engine(),
    );
    const doc = document<{ planDigest: string; review: RowPage }>(result);
    assert.equal(result.code, 0);
    assert.equal(doc.value.planDigest, h.plan.planDigest);
    assert.equal(doc.value.review.totalRows, 8);
    assert.equal(doc.value.review.facets.find((facet) => facet.code === "created")?.count, 8);
    for (const row of doc.value.review.rows) {
      assert.equal(ids.has(row.id), false);
      ids.add(row.id);
    }
    cursor = doc.value.review.nextCursor;
  } while (cursor);
  assert.equal(ids.size, 8);
  const search = document<{ review: RowPage }>(
    await invoke(
      [
        "plan",
        "--review",
        "--job",
        h.id,
        "--search",
        "3.txt",
        "--code",
        "created",
        "--output",
        "json",
      ],
      h.engine(),
    ),
  );
  assert.equal(search.value.review.totalRows, 1);
  assert.equal(search.value.review.rows[0]?.code, "created");
});

it("machine approval requires both identity and read-back digest, regardless of TTYs", async (t) => {
  const h = await planned(t);
  for (let mask = 0; mask < 8; mask++) {
    const tty = [Boolean(mask & 1), Boolean(mask & 2), Boolean(mask & 4)];
    for (const mode of ["json", "jsonl"]) {
      const result = await invoke(
        ["approve", "--job", h.id, "--approver", "ci:review", "--output", mode],
        h.engine(),
        { tty },
      );
      assert.equal(result.code, 4);
      assert.equal(result.prompts, 0);
      assert.equal(document(result).refusal.code, "approval_required");
    }
  }
  const accepted = await invoke(
    [
      "approve",
      "--job",
      h.id,
      "--approver",
      "ci:review",
      "--plan-digest",
      h.plan.planDigest,
      "--output",
      "json",
    ],
    h.engine(),
  );
  const approval = document<ApprovalRecord>(accepted);
  assert.equal(accepted.code, 0);
  assert.equal(approval.value.planDigest, h.plan.planDigest);
  assert.match(approval.value.approvalDigest, /^[a-f0-9]{64}$/u);
});

it("human approval prompts on stdin and stderr TTYs, honors explicit flags, and requires yes", async (t) => {
  const h = await planned(t);
  for (let mask = 0; mask < 8; mask++) {
    const tty = [Boolean(mask & 1), Boolean(mask & 2), Boolean(mask & 4)];
    if (tty[0] && tty[2]) continue;
    const result = await invoke(["approve", "--job", h.id], h.engine(), { tty, answer: "yes" });
    assert.equal(result.code, 4);
    assert.equal(result.prompts, 0);
  }
  for (const answer of ["", "y", "no", "yes please"]) {
    const result = await invoke(["approve", "--job", h.id], h.engine(), {
      tty: [true, false, true],
      answer,
    });
    assert.equal(result.code, 4);
    assert.equal(result.prompts, 1);
  }
  const accepted = await invoke(["approve", "--job", h.id], h.engine(), {
    tty: [true, false, true],
    answer: " YES ",
  });
  assert.equal(accepted.code, 0);
  const approval: Document<ApprovalRecord> = JSON.parse(accepted.stdout);
  assert.equal(approval.value.mode, "interactive");
  assert.equal(approval.value.approver, `${userInfo().username}@${hostname()}`);
  for (const disclosure of h.plan.disclosures) assert.ok(accepted.stderr.includes(disclosure));

  const named = await planned(t);
  const claimed = await invoke(
    ["approve", "--job", named.id, "--approver", "alice@example"],
    named.engine(),
    { tty: [true, true, true], answer: "yes" },
  );
  assert.equal(claimed.code, 0);
  assert.equal(claimed.prompts, 1);
  const claim: Document<ApprovalRecord> = JSON.parse(claimed.stdout);
  assert.equal(claim.value.approver, "alice@example");

  const explicit = await planned(t);
  const flagged = await invoke(
    [
      "approve",
      "--job",
      explicit.id,
      "--approver",
      "alice@example",
      "--plan-digest",
      explicit.plan.planDigest,
    ],
    explicit.engine(),
    { tty: [true, true, true] },
  );
  assert.equal(flagged.code, 0);
  assert.equal(flagged.prompts, 0);
  assert.equal(document<ApprovalRecord>(flagged).value.mode, "unattended");
});

it("maps stable refusal codes exactly and preserves unknown values fail-closed", async (t) => {
  const h = harness(t);
  const cases: Array<[string, number]> = [
    ["configuration_invalid", 2],
    ["job_not_found", 2],
    ["lease_held", 3],
    ["foreign_host", 3],
    ["lease_stale_worker_alive", 3],
    ["preflight_failed", 4],
    ["approval_required", 4],
    ["approval_digest_stale", 4],
    ["plan_revision_required", 4],
    ["cutover_incomplete", 4],
    ["delete_limit_exceeded", 4],
    ["unsupported_route", 4],
    ["verification_unaccepted", 4],
    ["local_filesystem_required", 4],
    ["retry_budget_exhausted", 5],
    ["job_closed", 6],
    ["job_cancelled", 7],
    ["state_version_unsupported", 8],
    ["future_code", 1],
    ["toString", 1],
  ];
  for (const [code, expected] of cases) {
    const engine = h.engine();
    const reader = engine.reader({ id: "absent" });
    engine.reader = () => ({
      ...reader,
      status: async () =>
        ({ ok: false, refusal: { code, message: "opaque" } }) as Outcome<JobStatus>,
    });
    const result = await invoke(["status", "--job", "absent", "--output", "json"], engine);
    assert.equal(result.code, expected);
    assert.equal(document(result).refusal.code, code);
  }
  const engine = h.engine();
  const reader = engine.reader({ id: "absent" });
  engine.reader = () => ({
    ...reader,
    status: async () =>
      ({
        ok: true,
        value: { jobType: "file_migration", state: "future_state" },
      }) as unknown as Outcome<JobStatus>,
  });
  const future = await invoke(["status", "--job", "absent", "--output", "json"], engine);
  assert.equal(future.code, 1);
  assert.equal(document<{ state: string }>(future).value.state, "future_state");
});

it("redacts sensitive recovery data but keeps actionable owner and checkpoint facts", async (t) => {
  const h = harness(t);
  const engine = h.engine();
  const reader = engine.reader({ id: "absent" });
  engine.reader = () => ({
    ...reader,
    status: async () =>
      ({
        ok: false,
        refusal: {
          code: "lease_stale_worker_alive",
          message: "Bearer SECRET-CANARY https://example.invalid/download?sig=SECRET-CANARY",
          detail: {
            RCLONE_RC_USER: "SECRET-CANARY",
            RCLONE_RC_PASS: "SECRET-CANARY",
            workerPid: 424242,
            authorization: "SECRET-CANARY",
          },
          recovery: {
            workerAlive: true,
            recordedHostId: "host-one",
            thisHostId: "host-one",
            holder: { pid: 31337, heartbeatAt: "2026-09-01T00:00:00Z", token: "SECRET-CANARY" },
            workerGroup: "run-group",
            workerPid: 424242,
            socketPath: "/private/run/worker.sock",
            rawFutureField: "SECRET-CANARY",
            lastCheckpoint: "unit-7",
          },
        },
      }) as unknown as Outcome<JobStatus>,
  });
  const result = await invoke(["status", "--job", "absent", "--output", "json"], engine);
  const doc = document(result);
  assert.equal(result.code, 3);
  assert.equal(result.stdout.includes("SECRET-CANARY"), false);
  assert.equal(result.stdout.includes("424242"), false);
  assert.equal(result.stdout.includes("/private/run/worker.sock"), false);
  assert.equal(doc.refusal.recovery?.recordedHostId, "host-one");
  assert.equal(doc.refusal.recovery?.lastCheckpoint, "unit-7");
  const holder = doc.refusal.recovery?.holder;
  assert.ok(holder && typeof holder === "object" && "pid" in holder);
  assert.equal(holder.pid, 31337);
});

it("executes a real engine lifecycle with digest-bound reports and successful terminal cancel", async (t) => {
  const h = await planned(t);
  const approve = await invoke(
    [
      "approve",
      "--job",
      h.id,
      "--approver",
      "ci",
      "--plan-digest",
      h.plan.planDigest,
      "--output",
      "json",
    ],
    h.engine(),
  );
  assert.equal(approve.code, 0);
  const execute = await invoke(["execute", "--job", h.id, "--output", "json"], h.engine());
  assert.equal(execute.code, 0);
  const done = document<ExecuteResult & { state: string }>(execute);
  assert.equal(done.value.state, "completed");
  assert.equal(done.value.resumable, false);
  const verify = await invoke(["verify", "--job", h.id, "--output", "json"], h.engine());
  assert.equal(verify.code, 0);
  const report = document<ArtifactSet>(
    await invoke(["report", "--job", h.id, "--output", "json"], h.engine()),
  );
  assert.match(report.value.reportDigest!, /^[a-f0-9]{64}$/u);
  for (const format of ["jsonl", "html"])
    assert.ok(
      report.value.artifacts.some(
        (artifact) => artifact.format === format && existsSync(artifact.path),
      ),
    );
  const cancel = await invoke(
    ["cancel", "--job", h.id, "--reason", "No rollback requested", "--output", "json"],
    h.engine(),
  );
  assert.equal(cancel.code, 0);
  assert.equal(document<{ state: string }>(cancel).value.state, "cancelled");
  assert.equal(h.provider.snapshotDestination().filter((row) => row.kind === "file").length, 8);
});

it("waits for asynchronous stdout completion and never emits a second error after EPIPE", async (t) => {
  const h = harness(t);
  const { promise, resolve } = Promise.withResolvers<void>();
  let pending = true;
  const result = invoke(["--help", "--output", "json"], h.engine(), {
    write: () => promise,
  }).finally(() => {
    pending = false;
  });
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(pending, true);
  resolve();
  assert.equal((await result).code, 0);
  const broken = await invoke(["--help", "--output", "json"], h.engine(), {
    async write() {
      await Promise.resolve();
      throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
    },
  });
  assert.equal(broken.code, 141);
  assert.equal(broken.stdout, "");
  assert.equal(broken.stderr, "");
});

it("keeps jobs across fresh processes and isolates nested workspaces unless overridden", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "migmate-workspace-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, "nested");
  const child = join(nested, "inputs");
  mkdirSync(child, { recursive: true });
  const parent = document<{ id: string }>(
    invokeProcess(["init", "--type", "file_migration", "--home", ".migmate"], root),
  );
  assert.equal(parent.ok, true);
  assert.equal(
    document<{ state: string }>(
      invokeProcess(["cancel", "--job", parent.value.id, "--reason", "Workspace check"], child),
    ).value.state,
    "cancelled",
  );
  assert.equal(
    document<JobStatus>(invokeProcess(["status", "--job", parent.value.id], root)).value.state,
    "cancelled",
  );
  const inner = document<{ id: string }>(
    invokeProcess(["init", "--type", "teams_archive", "--home", ".migmate"], nested),
  );
  assert.equal(inner.ok, true);
  assert.equal(
    document<JobStatus>(invokeProcess(["status", "--job", inner.value.id], child)).value.jobId,
    inner.value.id,
  );
  const isolated = invokeProcess(["status", "--job", parent.value.id], child);
  assert.equal(isolated.code, 2);
  assert.equal(document(isolated).refusal.code, "job_not_found");
  const environment = { MIGMATE_HOME: join(root, ".migmate") };
  assert.equal(
    document<JobStatus>(invokeProcess(["status", "--job", parent.value.id], child, environment))
      .value.state,
    "cancelled",
  );
  assert.equal(
    document<JobStatus>(
      invokeProcess(
        ["status", "--job", inner.value.id, "--home", join(nested, ".migmate")],
        child,
        environment,
      ),
    ).value.jobId,
    inner.value.id,
  );
});

it("refuses invalid workspace markers without falling back, while explicit homes, help and version work", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "migmate-workspace-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = join(root, "inputs");
  mkdirSync(child);
  const parent = document<{ id: string }>(
    invokeProcess(["init", "--type", "file_migration", "--home", ".migmate"], root),
  );
  assert.equal(parent.ok, true);
  const marker = join(child, ".migmate");
  for (const kind of ["file", "symlink"]) {
    if (kind === "file") writeFileSync(marker, "");
    else symlinkSync(join(root, ".migmate"), marker);
    const refused = invokeProcess(["status", "--job", parent.value.id], child);
    assert.equal(refused.code, 2);
    assert.equal(document(refused).refusal.code, "usage");
    assert.equal(invokeProcess(["--help"], child).code, 0);
    assert.equal(invokeProcess(["--version"], child).code, 0);
    assert.equal(
      document<JobStatus>(
        invokeProcess(
          ["status", "--job", parent.value.id, "--home", join(root, ".migmate")],
          child,
        ),
      ).value.jobId,
      parent.value.id,
    );
    rmSync(marker);
  }
});

it("uses OS-specific persistent engine homes outside a workspace", (t) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "migmate-no-workspace-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(
    defaultHome("darwin", {}, "/Users/operator", cwd),
    "/Users/operator/Library/Application Support/Migmate",
  );
  assert.equal(
    defaultHome("linux", {}, "/home/operator", cwd),
    "/home/operator/.local/state/migmate",
  );
  assert.equal(
    defaultHome("linux", { XDG_STATE_HOME: "/local/state" }, "/home/operator", cwd),
    "/local/state/migmate",
  );
});

it("keeps acceptance bound to the verification digest and closes only after named gaps are accepted", async (t) => {
  const h = await planned(t);
  assert.equal((await invoke(["doctor", "--job", h.id, "--output", "json"], h.engine())).code, 0);
  assert.equal(
    (
      await invoke(
        [
          "approve",
          "--job",
          h.id,
          "--approver",
          "ci",
          "--plan-digest",
          h.plan.planDigest,
          "--output",
          "json",
        ],
        h.engine(),
      )
    ).code,
    0,
  );
  assert.equal((await invoke(["execute", "--job", h.id, "--output", "json"], h.engine())).code, 0);
  const verification = document<{ verificationDigest: string; findings: Array<{ code: string }> }>(
    await invoke(["verify", "--job", h.id, "--output", "json"], h.engine()),
  );
  const stale = await invoke(
    [
      "accept",
      "--job",
      h.id,
      "--approver",
      "ci",
      "--verification-digest",
      "stale",
      "--code",
      "version_history_omitted",
      "--output",
      "json",
    ],
    h.engine(),
  );
  assert.equal(stale.code, 4);
  assert.equal(document(stale).refusal.code, "verification_unaccepted");
  const codes = verification.value.findings.map((finding) => finding.code);
  if (codes.length) {
    const accepted = await invoke(
      [
        "accept",
        "--job",
        h.id,
        "--approver",
        "ci:review",
        "--verification-digest",
        verification.value.verificationDigest,
        ...codes.flatMap((code) => ["--code", code, "--note", "Reviewed retained evidence"]),
        "--output",
        "json",
      ],
      h.engine(),
    );
    const value = document<{ verificationDigest: string; acceptedCodes: string[] }>(accepted).value;
    assert.equal(accepted.code, 0);
    assert.equal(value.verificationDigest, verification.value.verificationDigest);
    assert.deepEqual([...value.acceptedCodes].sort(), [...codes].sort());
  }
  const closed = await invoke(["close", "--job", h.id, "--output", "json"], h.engine());
  assert.equal(closed.code, 0);
  assert.equal(document<{ state: string }>(closed).value.state, "closed");
  const again = await invoke(["execute", "--job", h.id, "--output", "json"], h.engine());
  assert.equal(again.code, 6);
  assert.equal(document(again).refusal.code, "job_closed");
});

it("does not translate reader event refusals into a successful empty stream", async (t) => {
  const h = await planned(t);
  const engine = h.engine();
  const reader = engine.reader({ id: h.id });
  engine.reader = () => ({
    ...reader,
    async *events() {
      throw Object.assign(new Error("opaque"), {
        refusal: { code: "state_version_unsupported", message: "opaque", detail: { found: 99 } },
      });
    },
  });
  const result = await invoke(["status", "--job", h.id, "--output", "jsonl"], engine);
  assert.equal(result.code, 8);
  assert.equal(document(result).refusal.code, "state_version_unsupported");
});

it("explicit reclaim refuses a live writer rather than treating confirmation as force", async (t) => {
  const h = await planned(t);
  const owner = h.engine();
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = owner.withWriter({ id: h.id }, async () => {
    acquired.resolve();
    await release.promise;
  });
  void holding.then((outcome) => {
    if (!outcome.ok) acquired.reject(new Error("Could not acquire test writer"));
  }, acquired.reject);
  try {
    await acquired.promise;
    const result = await invoke(
      ["reclaim", "--job", h.id, "--confirm", "--stop-worker", "--output", "json"],
      h.engine(),
    );
    assert.equal(result.code, 3);
    const doc = document(result);
    assert.equal(doc.refusal.code, "lease_held");
    assert.equal(doc.refusal.recovery?.recordedHostId, doc.refusal.recovery?.thisHostId);
    const reader = h.engine();
    try {
      const status = await reader.reader({ id: h.id }).status();
      assert.ok(status.ok);
      assert.equal(status.value.ownership.held, true);
      assert.equal(status.value.ownership.pid, process.pid);
    } finally {
      reader.close();
    }
  } finally {
    release.resolve();
    await holding;
    owner.close();
  }
});
