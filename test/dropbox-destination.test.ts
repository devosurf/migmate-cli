import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import { fileProviderPair } from "../src/engine/providers/adapters/capabilities.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import { ProviderFault } from "../src/engine/providers/fault.ts";
import { HttpProviderFault } from "../src/engine/providers/http.ts";
import { markCreationRejected } from "../src/engine/providers/port.ts";
import { parseManifest } from "../src/engine/manifest.ts";
import { approve, closeDecision, fileFixture, value } from "./engine-fixture.ts";

const now = "2026-11-14T12:00:00.000Z";
const group = { groupId: "g:1a2b3c", type: "group", role: "writer" };
const sources = {
  google_shared_drive: {
    type: "google_shared_drive",
    driveId: "source-drive",
    folderId: "source-root",
  },
  sharepoint: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
} as const;
type Source = keyof typeof sources;

function manifest(source: Source, members: unknown[] = [], name = "Finance") {
  return {
    version: 1,
    mappings: [
      {
        id: "team",
        source: sources[source],
        destination: { type: "dropbox", create: name },
        members,
      },
    ],
  };
}

async function harness(
  t: TestContext,
  source: Source,
  input: {
    members?: unknown[];
    sourceItems?: FakeFileMigrationFixture["sourceItems"];
    fixture?: Partial<FakeFileMigrationFixture>;
    approve?: false;
    load?: false;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "migmate-dropbox-destination-"));
  const port = new FakeFileMigrationPort({
    ...fileFixture(
      input.sourceItems ?? [
        { id: "file", parentId: "source-root", name: "file.txt", kind: "file", content: "bytes" },
      ],
    ),
    destinationProvider: "dropbox",
    now: () => new Date(now),
    ...input.fixture,
  });
  const engine = openEngine({ home, provider: port, now: () => new Date(now) });
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      config: {
        sourceProvider: source,
        destinationProvider: "dropbox",
        options: { memberGrants: "after_verification", consistencyIntervalMs: 0 },
      },
    }),
  );
  const h = { home, port, engine, ref };
  t.after(async () => {
    h.engine.close();
    await rm(home, { recursive: true, force: true });
  });
  if (input.load === false) return h;
  value(
    await engine.withWriterResult(ref, (writer) =>
      writer.loadManifest({
        format: "json",
        content: JSON.stringify(manifest(source, input.members)),
      }),
    ),
  );
  if (input.approve !== false) await approve(h);
  return h;
}

test("Google and SharePoint copy into Dropbox; Dropbox never copies into itself", () => {
  for (const source of ["google_shared_drive", "sharepoint"] as const) {
    const pair = fileProviderPair({ sourceProvider: source, destinationProvider: "dropbox" });
    assert.equal(pair.destination.id, "dropbox");
    assert.equal(pair.destination.idempotentCreation, false);
  }
  assert.throws(
    () => fileProviderPair({ sourceProvider: "dropbox", destinationProvider: "dropbox" }),
    (error: unknown) => error instanceof ProviderFault && error.code === "unsupported_route",
  );
});

test("Dropbox destinations name team folders by namespace and members by group ID", () => {
  const parsed = parseManifest(JSON.stringify(manifest("google_shared_drive", [group])), "json");
  assert.deepEqual(parsed.mappings[0]?.destination, { type: "dropbox", create: "Finance" });
  assert.deepEqual(parsed.mappings[0]?.members, [
    { email: "g:1a2b3c", type: "group", role: "editor" },
  ]);
  const existing = {
    version: 1,
    mappings: [
      {
        id: "team",
        source: sources.sharepoint,
        destination: { type: "dropbox", namespaceId: "987654", folderPath: "Archive" },
      },
    ],
  };
  assert.deepEqual(parseManifest(JSON.stringify(existing), "json").mappings[0]?.destination, {
    type: "dropbox",
    driveId: "987654",
    folderPath: "Archive",
  });
  for (const [member, field] of [
    [{ email: "readers@example.com", type: "group", role: "reader" }, /members\.0\.email/],
    [{ groupId: "g:1a2b3c", type: "user", role: "reader" }, /members\.0\.type/],
    [{ groupId: "g:1a2b3c", type: "group", role: "manager" }, /members\.0\.role/],
    [{ groupId: "readers", type: "group", role: "reader" }, /members\.0\.groupId/],
  ] as const)
    assert.throws(
      () => parseManifest(JSON.stringify(manifest("google_shared_drive", [member])), "json"),
      field,
    );
  assert.throws(
    () =>
      parseManifest(
        JSON.stringify({
          version: 1,
          mappings: [
            {
              ...existing.mappings[0],
              destination: { type: "dropbox", driveId: "987654", folderPath: "" },
            },
          ],
        }),
        "json",
      ),
    /destination\.namespaceId/,
  );
});

for (const source of ["google_shared_drive", "sharepoint"] as const) {
  test(`${source} → Dropbox fences a created team folder until go-live grants its group`, async (t) => {
    const h = await harness(t, source, { members: [group] });
    value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    const created = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
    assert.equal(created.creatorEmail, "");
    assert.ok(created.creationAttemptedAt);
    assert.deepEqual(created.provenance, { kind: "create_response" });
    assert.deepEqual(created.initialMembers, []);
    // The fence: an API-created team folder gives access to no one before go-live.
    assert.deepEqual(await h.port.listDriveMembers(created.driveId!), []);
    assert.deepEqual(
      (await h.port.listDestinationChildren(created.rootFolderId!)).map((item) => item.name),
      ["file.txt"],
    );
    assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).memberGrants, []);
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    const closed = value(await h.engine.reader(h.ref).status());
    assert.equal(closed.state, "closed");
    assert.equal(closed.createdDrives[0]?.goLive?.check?.status, "passed");
    assert.deepEqual(await h.port.listDriveMembers(created.driveId!), [
      { email: "g:1a2b3c", type: "group", role: "editor" },
    ]);
  });

  test(`${source} → Dropbox blocks case collisions and reserved names, listing each path`, async (t) => {
    const h = await harness(t, source, {
      approve: false,
      sourceItems: [
        { id: "upper", parentId: "source-root", name: "Report.txt", kind: "file", content: "a" },
        { id: "lower", parentId: "source-root", name: "report.TXT", kind: "file", content: "b" },
        { id: "folder", parentId: "source-root", name: "Plans", kind: "folder" },
        { id: "ini", parentId: "folder", name: "desktop.ini", kind: "file", content: "c" },
        { id: "spaced", parentId: "source-root", name: "notes ", kind: "file", content: "d" },
      ],
    });
    const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
    const rows = value(await h.engine.reader(h.ref).rows({ phase: "plan", limit: 100 })).rows;
    const blocking = (code: string) =>
      rows
        .filter((row) => row.code === code)
        .map((row) => (row.jobType === "file_migration" ? row.relativePath : null))
        .sort();
    assert.deepEqual(blocking("destination_duplicate_name"), ["Report.txt", "report.TXT"]);
    assert.deepEqual(blocking("destination_invalid_name"), ["Plans/desktop.ini"]);
    // A trailing space is encoded, with disclosure, rather than refused.
    assert.deepEqual(blocking("destination_name_encoded"), ["notes "]);
    const approval = await h.engine.withWriterResult(h.ref, (w) =>
      w.approve({ planDigest: plan.planDigest, approver: "test", mode: "unattended" }),
    );
    assert.equal(approval.ok, false);
    h.port.renameSourceItem("lower", "report-2.txt");
    h.port.renameSourceItem("ini", "settings.ini");
    await approve(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    const created = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
    assert.deepEqual(
      (await h.port.listDestinationChildren(created.rootFolderId!)).map((item) => item.name).sort(),
      ["Plans", "Report.txt", "notes␠", "report-2.txt"].sort(),
    );
    assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
  });

  test(`${source} → Dropbox stops on the monthly upload-call limit with a first-of-month estimate`, async (t) => {
    const h = await harness(t, source, {
      fixture: {
        copyPasses: [
          {
            retryingError:
              "upload failed: invalid_account_type/feature/: Your team has used all of its data transport API calls for the month.",
          },
        ],
      },
    });
    const result = value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.execute({ signal: AbortSignal.timeout(5000) }),
      ),
    );
    assert.equal(result.outcome, "blocked");
    const quota = {
      code: "upload_quota_exceeded",
      hitAt: now,
      actingGoogleAccount: null,
      limit: "dropbox_team_monthly_upload_calls",
      earliestResumeAt: "2026-12-01T08:00:00.000Z",
      resumeTimeIsEstimate: true,
    };
    assert.deepEqual(result.uploadQuota, quota);
    assert.equal(result.budget?.failedAttempts, 0);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.state, "blocked");
    assert.equal(status.mappingPasses[0]?.status, "failed");
    assert.deepEqual(status.mappingPasses[0]?.uploadQuota, quota);
  });
}

for (const timing of ["before", "after"] as const) {
  test(`Dropbox creation recovery refuses to adopt a team folder after a ${timing}-call crash`, async (t) => {
    const h = await harness(t, "google_shared_drive");
    h.port.scriptEffect({
      method: "createDestinationContainer",
      timing,
      count: 1,
      error: new Error("creation crash"),
    });
    await assert.rejects(
      h.engine.withWriterResult(h.ref, (w) => w.execute()),
      /creation crash/,
    );
    const intent = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
    assert.equal(intent.driveId, null);
    assert.equal(intent.intentAt, now);
    assert.equal(intent.creationAttemptedAt, now);
    h.engine.close();
    h.engine = openEngine({ home: h.home, provider: h.port, now: () => new Date(now) });
    const recovered = await h.engine.withWriterResult(h.ref, (w) => w.execute());
    assert.equal(recovered.ok, false);
    // Team folders carry no request marker: a visible same-name folder is not proof.
    if (!recovered.ok) assert.equal(recovered.refusal.code, "drive_creation_ambiguous");
    if (!recovered.ok && timing === "before")
      assert.equal(recovered.refusal.detail?.reason, "creation_outcome_unknown");
    assert.equal(
      (await h.port.findDestinationContainers({ name: "Finance" })).length,
      timing === "after" ? 1 : 0,
    );
    assert.equal(
      h.port.calls.filter((call) => call.startsWith("createDestinationContainer:")).length,
      1,
    );
  });
}

test("an intent-only Dropbox crash creates the team folder exactly once", async (t) => {
  const h = await harness(t, "sharepoint");
  h.port.scriptEffect({
    method: "validateDestinationCreation",
    count: 1,
    error: new Error("validation crash"),
  });
  await assert.rejects(
    h.engine.withWriterResult(h.ref, (w) => w.execute()),
    /validation crash/,
  );
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  assert.equal((await h.port.findDestinationContainers({ name: "Finance" })).length, 1);
  assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
});

test("an existing same-name Dropbox team folder blocks creation, case-insensitively", async (t) => {
  const h = await harness(t, "google_shared_drive", {
    fixture: {
      destinationContainers: [{ container: { id: "drive-9", name: "FINANCE" }, members: [] }],
    },
  });
  const result = await h.engine.withWriterResult(h.ref, (w) => w.execute());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal.code, "drive_creation_ambiguous");
  const refused = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  assert.equal(refused.driveId, null);
  // The conflict proves nothing was created, so the attempt does not linger.
  assert.equal(refused.creationAttemptedAt, undefined);
  assert.deepEqual(refused.rejectedCreationAttempts, [now]);
  h.port.renameDestinationContainer("drive-9", "Finance (old)");
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const created = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  assert.notEqual(created.driveId, null);
  assert.notEqual(created.driveId, "drive-9");
  assert.deepEqual(created.provenance, { kind: "create_response" });
});

test("a rate-limited Dropbox creation clears its attempt and creates on retry", async (t) => {
  const h = await harness(t, "sharepoint");
  h.port.scriptEffect({
    method: "createDestinationContainer",
    count: 1,
    error: markCreationRejected(new HttpProviderFault(429, "1", "too_many_requests")),
  });
  // The transient refusal is retried within execute: a lingering attempt would refuse it.
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const drive = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  assert.deepEqual(drive.rejectedCreationAttempts, [now]);
  assert.deepEqual(drive.provenance, { kind: "create_response" });
  assert.equal((await h.port.findDestinationContainers({ name: "Finance" })).length, 1);
  assert.equal(
    h.port.calls.filter((call) => call.startsWith("createDestinationContainer:")).length,
    2,
  );
});

test("a Dropbox monthly-limit pass that fails outright also blocks with quota evidence", async (t) => {
  const h = await harness(t, "google_shared_drive", {
    fixture: {
      copyPasses: [{ error: "upload failed: invalid_account_type/feature/..." }],
    },
  });
  const result = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  assert.equal(result.outcome, "blocked");
  assert.equal(result.uploadQuota?.limit, "dropbox_team_monthly_upload_calls");
  assert.equal(result.budget?.failedAttempts, 0);
});

test("a failed stop keeps the Dropbox monthly-limit evidence", async (t) => {
  const h = await harness(t, "sharepoint", {
    fixture: { copyPasses: [{ retryingError: "upload failed: invalid_account_type/feature/" }] },
  });
  const stop = h.port.stopCopyPass.bind(h.port);
  h.port.stopCopyPass = async (reference) => {
    await stop(reference);
    throw new Error("stop acknowledgement lost");
  };
  const result = value(
    await h.engine.withWriterResult(h.ref, (w) => w.execute({ signal: AbortSignal.timeout(5000) })),
  );
  assert.equal(result.outcome, "blocked");
  assert.equal(result.uploadQuota?.limit, "dropbox_team_monthly_upload_calls");
  const pass = value(await h.engine.reader(h.ref).status()).mappingPasses[0]!;
  assert.equal(pass.status, "failed");
  assert.equal("lastError" in (pass.lastStats ?? {}), false);
});

test("only Dropbox destinations stop a pass on its running error text", () => {
  for (const [sourceProvider, destinationProvider] of [
    ["sharepoint", "google_shared_drive"],
    ["google_shared_drive", "sharepoint"],
    ["dropbox", "sharepoint"],
  ])
    assert.ok(
      !fileProviderPair({ sourceProvider, destinationProvider }).destination.quotaWhileRunning,
    );
});

test("Dropbox team-space teams refuse creation before any team folder exists", async (t) => {
  const h = await harness(t, "sharepoint", { fixture: { dropboxTeamSpace: true }, load: false });
  // The read-only creation check runs as the manifest loads, long before execute.
  const result = await h.engine.withWriterResult(h.ref, (w) =>
    w.loadManifest({ format: "json", content: JSON.stringify(manifest("sharepoint")) }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal.detail?.check, "dropbox_team_space_unfenced");
  assert.equal(
    h.port.calls.some((call) => call.startsWith("createDestinationContainer:")),
    false,
  );
});

test("a group added to a fenced Dropbox team folder fails the pre-grant check", async (t) => {
  const h = await harness(t, "google_shared_drive", { members: [group] });
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const created = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  await h.port.addDriveMember(created.driveId!, {
    email: "g:outsider",
    type: "group",
    role: "viewer",
  });
  const verification = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
  assert.equal(verification.clean, false);
  assert.ok(verification.findings.some((f) => f.code === "drive_membership_mismatch"));
  assert.deepEqual(value(await h.engine.reader(h.ref).status()).memberGrants, []);
});
