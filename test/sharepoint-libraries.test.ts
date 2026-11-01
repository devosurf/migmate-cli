import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import {
  fileMigrationDriver,
  type FileMigrationConfig,
} from "../src/engine/drivers/file-migration.ts";
import { parseManifest } from "../src/engine/manifest.ts";
import { approve, closeDecision, fileFixture, value } from "./engine-fixture.ts";

const now = "2026-10-30T12:00:00.000Z";
const siteId = "tenant.sharepoint.com,site-collection,web";
const member = { email: "readers@example.com", type: "group", role: "reader" };
function manifest(members: unknown[] = [], site = siteId) {
  return {
    version: 1,
    mappings: [
      {
        id: "library",
        source: { type: "google_shared_drive", driveId: "source-drive", folderId: "source-root" },
        destination: { type: "sharepoint", siteId: site, create: "Finance" },
        members,
      },
    ],
  };
}
async function harness(
  t: TestContext,
  input: {
    members?: unknown[];
    sourceItems?: FakeFileMigrationFixture["sourceItems"];
    options?: FileMigrationConfig["options"];
    inherited?: FakeFileMigrationFixture["inheritedSiteMembers"];
    implicit?: FakeFileMigrationFixture["implicitLibraryMembers"];
    waitForConsistency?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "migmate-sharepoint-library-"));
  const port = new FakeFileMigrationPort({
    ...fileFixture(
      input.sourceItems ?? [
        {
          id: "file",
          parentId: "source-root",
          name: "file.txt",
          kind: "file",
          content: "library bytes",
        },
      ],
    ),
    destinationProvider: "sharepoint",
    sharepointMembershipAvailable: Boolean(input.members?.length),
    googleAbout: { user: { emailAddress: "source-reader@example.com" }, canCreateDrives: false },
    now: () => new Date(now),
    ...(input.inherited ? { inheritedSiteMembers: input.inherited } : {}),
    ...(input.implicit ? { implicitLibraryMembers: input.implicit } : {}),
  });
  const engine = openEngine({
    home,
    provider: port,
    now: () => new Date(now),
    ...(input.waitForConsistency ? { waitForConsistency: input.waitForConsistency } : {}),
  });
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      config: {
        sourceProvider: "google_shared_drive",
        destinationProvider: "sharepoint",
        options: { memberGrants: "after_verification", consistencyIntervalMs: 0, ...input.options },
      },
    }),
  );
  const h = { home, port, engine, ref };
  t.after(async () => {
    h.engine.close();
    await rm(home, { recursive: true, force: true });
  });
  value(
    await engine.withWriterResult(ref, (writer) =>
      writer.loadManifest({ format: "json", content: JSON.stringify(manifest(input.members)) }),
    ),
  );
  await approve(h);
  return h;
}

test("SharePoint creation requires an existing site identity, and CSV carries it", () => {
  const input = manifest();
  const parsed = parseManifest(JSON.stringify(input), "json");
  assert.deepEqual(parsed.mappings[0]?.destination, input.mappings[0]?.destination);
  assert.throws(
    () => parseManifest(JSON.stringify(manifest([], "")), "json"),
    /destination.siteId/,
  );
  const csv =
    'id,source.type,source.driveId,source.folderPath,destination.type,destination.driveId,destination.folderId,destination.create,members,source.folderId,destination.folderPath,destination.siteId\nlibrary,google_shared_drive,source-drive,,sharepoint,,,Finance,[],source-root,,"tenant.sharepoint.com,site-collection,web"\n';
  assert.deepEqual(parseManifest(csv, "csv").mappings, parsed.mappings);
});

for (const timing of ["before", "after"] as const) {
  test(`SharePoint creation recovery ${timing === "after" ? "adopts a visible library" : "refuses an unknown attempted outcome"} after a ${timing}-call crash`, async (t) => {
    const h = await harness(t);
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
    assert.equal(intent.siteId, siteId);
    assert.equal(intent.intentAt, now);
    assert.equal(intent.creationAttemptedAt, now);
    h.engine.close();
    h.engine = openEngine({ home: h.home, provider: h.port, now: () => new Date(now) });
    if (timing === "before") {
      const recovered = await h.engine.withWriterResult(h.ref, (w) => w.execute());
      assert.equal(recovered.ok, false);
      if (!recovered.ok) {
        assert.equal(recovered.refusal.code, "drive_creation_ambiguous");
        assert.equal(recovered.refusal.detail?.reason, "creation_outcome_unknown");
      }
      assert.equal((await h.port.findDestinationContainers({ name: "Finance", siteId })).length, 0);
      return;
    }
    value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    const recovered = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
    assert.equal(recovered.requestId, intent.requestId);
    assert.notEqual(recovered.rootFolderId, recovered.driveId);
    assert.deepEqual(recovered.provenance, { kind: "request_marker", requestId: intent.requestId });
    assert.equal((await h.port.findDestinationContainers({ name: "Finance", siteId })).length, 1);
    assert.equal(
      (await h.port.findDestinationContainers({ name: "Finance", siteId: "other-site" })).length,
      0,
    );
    assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
  });
}

test("an intent-only crash recovers before any non-idempotent creation attempt", async (t) => {
  const h = await harness(t);
  const execute = fileMigrationDriver.execute;
  const injected = t.mock.method(
    fileMigrationDriver,
    "execute",
    async function* (ctx: Parameters<typeof execute>[0]) {
      for await (const unit of execute(ctx)) {
        yield unit;
        if (unit.createdDrive && !unit.createdDrive.creationAttemptedAt)
          throw new Error("intent checkpoint crash");
      }
    },
  );
  await assert.rejects(
    h.engine.withWriterResult(h.ref, (w) => w.execute()),
    /intent checkpoint crash/,
  );
  const intent = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  assert.equal(intent.driveId, null);
  assert.equal(intent.creationAttemptedAt, undefined);
  injected.mock.restore();
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const created = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  assert.equal(created.provenance?.kind, "create_response");
  assert.equal((await h.port.findDestinationContainers({ name: "Finance", siteId })).length, 1);
});

test("SharePoint created libraries mirror only with durable creation provenance", async (t) => {
  const h = await harness(t, { options: { mirror: true, deleteLimit: 1 } });
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  h.port.deleteSourceItem("file");
  await approve(h);
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const created = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  assert.deepEqual(await h.port.listDestinationChildren(created.rootFolderId!), []);
  const db = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
  try {
    db.exec("UPDATE created_drive SET payload=json_remove(payload,'$.provenance')");
  } finally {
    db.close();
  }
  await approve(h);
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const status = value(await h.engine.reader(h.ref).status());
  assert.equal(status.mappingPasses.at(-1)?.status, "failed");
  assert.match(status.mappingPasses.at(-1)?.error ?? "", /provenance/);
});

test("libraries without manifest members need no certificate, membership reads or fence", async (t) => {
  const inherited = [{ email: "site-members@example.com", type: "group", role: "write" }];
  const h = await harness(t, { inherited: { [siteId]: inherited } });
  const membership = t.mock.method(h.port, "listDriveMembers");
  const plan = value(await h.engine.reader(h.ref).status()).currentPlan!;
  const disclosure = JSON.parse(
    plan.sections.find((section) => section.title === "Inherited site access")!.body,
  );
  assert.equal(disclosure[0].mappingId, "library");
  assert.equal(disclosure[0].membershipManaged, false);
  assert.equal(disclosure[0].membershipProven, false);
  assert.equal(disclosure[0].visibleToSiteMembersBeforeGoLive, true);
  assert.equal(disclosure[0].transfersFenced, false);
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const created = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  assert.equal(h.port.destinationInheritsPermissions(created.driveId!), true);
  assert.equal(created.initialMembers, undefined);
  assert.equal(created.managedAccess, false);
  assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
  value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
  const closed = value(await h.engine.reader(h.ref).status());
  assert.equal(closed.state, "closed");
  assert.equal(closed.createdDrives[0]?.goLive, undefined);
  assert.deepEqual(closed.memberGrants, []);
  assert.equal(h.port.destinationInheritsPermissions(created.driveId!), true);
  assert.ok(!h.port.calls.some((call) => call.startsWith("prepareDestinationMembers:")));
  assert.equal(membership.mock.callCount(), 0);
  const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
  const document = JSON.parse(
    await readFile(
      report.artifacts.find((artifact) => artifact.name === "report.json")!.path,
      "utf8",
    ),
  );
  const access = JSON.parse(
    document.sections.find(
      (section: { title: string }) => section.title === "Inherited site access",
    ).body,
  );
  assert.deepEqual(access, disclosure);
});

test("named libraries get unique permissions before copying but member grants wait for the go-live fence", async (t) => {
  const h = await harness(t, {
    members: [member],
    inherited: { [siteId]: [{ email: "site-members@example.com", type: "group", role: "write" }] },
  });
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const created = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  assert.equal(h.port.destinationInheritsPermissions(created.driveId!), false);
  assert.deepEqual(value(await h.engine.reader(h.ref).status()).memberGrants, []);
  assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
  h.port.scriptEffect({
    method: "prepareDestinationMembers",
    timing: "after",
    count: 1,
    error: new Error("permission crash"),
  });
  await assert.rejects(
    h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))),
    /permission crash/,
  );
  const fenced = value(await h.engine.reader(h.ref).status());
  assert.ok(fenced.createdDrives[0]?.goLive);
  assert.equal(h.port.destinationInheritsPermissions(created.driveId!), false);
  const execute = await h.engine.withWriterResult(h.ref, (w) => w.execute());
  assert.equal(execute.ok, false);
  if (!execute.ok) assert.equal(execute.refusal.code, "go_live_started");
  value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
  const closed = value(await h.engine.reader(h.ref).status());
  assert.equal(closed.state, "closed");
  assert.equal(closed.createdDrives[0]?.goLive?.check?.status, "passed");
  assert.deepEqual(await h.port.listDriveMembers(created.driveId!), [{ ...member, role: "read" }]);
});

for (const [code, names] of [
  ["destination_duplicate_name", ["same.txt", "same.txt"]],
  ["destination_invalid_name", ["CON", "~$Office.docx"]],
  ["destination_path_too_long", ["x".repeat(401)]],
] as const) {
  test(`${code} lists each source identity and stops the mapping before copy`, async (t) => {
    const h = await harness(t, {
      sourceItems: names.map((_, index) => ({
        id: `conflict-${index}`,
        parentId: "source-root",
        name: `initial-${index}.txt`,
        kind: "file",
        content: "must not rename",
      })),
    });
    names.forEach((name, index) => h.port.renameSourceItem(`conflict-${index}`, name));
    const copy = t.mock.method(h.port, "startCopyPass");
    assert.equal(
      value(await h.engine.withWriterResult(h.ref, (w) => w.execute())).outcome,
      "blocked",
    );
    assert.equal(copy.mock.callCount(), 0);
    const verification = await h.engine.withWriterResult(h.ref, (w) => w.verify());
    assert.equal(verification.ok, false);
    const page = value(await h.engine.reader(h.ref).rows({ phase: "execute", limit: 100 }));
    const conflicts = page.rows.filter((row) => row.code === code);
    assert.equal(conflicts.length, names.length);
    assert.deepEqual(
      conflicts.map((row) => (row.jobType === "file_migration" ? row.sourceItemId : "")).sort(),
      names.map((_, i) => `conflict-${i}`).sort(),
    );
    const acceptance = await h.engine.withWriterResult(h.ref, (w) =>
      w.accept({
        verificationDigest: "unverified",
        codes: [code],
        rationale: "must not bypass",
        approver: "test",
        mode: "unattended",
      }),
    );
    assert.equal(acceptance.ok, false);
    for (let i = 0; i < names.length; i++)
      h.port.renameSourceItem(`conflict-${i}`, `fixed-${i}.txt`);
    await approve(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
  });
}

test("a conflicting name introduced during final settling prevents the catch-up copy", async (t) => {
  let mutate = () => {};
  const h = await harness(t, {
    options: { staged: true, settleMaxPasses: 2 },
    waitForConsistency: async () => mutate(),
  });
  const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan({ final: true })));
  value(
    await h.engine.withWriterResult(h.ref, (w) =>
      w.approve({
        planDigest: plan.planDigest,
        approver: "test",
        mode: "unattended",
        freeze: { by: "test", at: now, how: "source editors removed" },
      }),
    ),
  );
  mutate = () => h.port.renameSourceItem("file", "CON");
  const execution = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  assert.equal(execution.outcome, "blocked");
  const status = value(await h.engine.reader(h.ref).status());
  assert.equal(status.mappingPasses.filter((pass) => pass.status === "completed").length, 1);
  assert.equal(status.mappingPasses.at(-1)?.status, "failed");
  const rows = value(await h.engine.reader(h.ref).rows({ phase: "execute", limit: 100 })).rows;
  assert.ok(rows.some((row) => row.code === "destination_invalid_name"));
  const created = status.createdDrives[0]!;
  assert.deepEqual(
    (await h.port.listDestinationChildren(created.rootFolderId!)).map((item) => item.name),
    ["file.txt"],
  );
});

test("created-library parent cannot change after intent is submitted", async (t) => {
  const h = await harness(t);
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const changed = await h.engine.withWriterResult(h.ref, (w) =>
    w.loadManifest({
      format: "json",
      content: JSON.stringify(manifest([], "other-site")),
    }),
  );
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.refusal.code, "configuration_invalid");
});

test("verification reports newly reserved names without accepting per-path exclusions", async (t) => {
  const h = await harness(t);
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  h.port.renameSourceItem("file", "CON");
  const verification = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
  assert.equal(verification.clean, false);
  assert.ok(verification.findings.some((finding) => finding.code === "destination_invalid_name"));
  const acceptance = await h.engine.withWriterResult(h.ref, (w) =>
    w.accept({
      verificationDigest: verification.verificationDigest,
      codes: ["destination_invalid_name"],
      rationale: "No path exclusions are authorized",
      approver: "test",
      mode: "unattended",
    }),
  );
  assert.equal(acceptance.ok, false);
  h.port.renameSourceItem("file", "file.txt");
  assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
});

test("SharePoint post-grant membership differences retain the fence and require recovery", async (t) => {
  const h = await harness(t, { members: [member] });
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const add = h.port.addDriveMember.bind(h.port);
  t.mock.method(
    h.port,
    "addDriveMember",
    async (...[driveId, selected]: Parameters<typeof add>) => {
      await add(driveId, selected);
      await add(driveId, { email: "outside@example.com", type: "user", role: "write" });
    },
  );
  const closing = await h.engine.withWriterResult(h.ref, async (w) =>
    w.close(await closeDecision(h)),
  );
  assert.equal(closing.ok, false);
  const status = value(await h.engine.reader(h.ref).status());
  assert.equal(status.createdDrives[0]?.goLive?.check?.check, "drive_membership_mismatch");
  assert.equal(status.createdDrives[0]?.goLive?.check?.status, "failed");
  assert.ok(status.createdDrives[0]?.goLive);
  assert.equal(status.memberGrants.length, 1);
  const execute = await h.engine.withWriterResult(h.ref, (w) => w.execute());
  assert.equal(execute.ok, false);
  if (!execute.ok) assert.equal(execute.refusal.code, "go_live_started");
});

test("an ambiguous library response with no visible candidate never replays the POST", async (t) => {
  const h = await harness(t);
  h.port.scriptEffect({
    method: "createDestinationContainer",
    timing: "before",
    count: 1,
    error: new TypeError("connection outcome unknown"),
  });
  const create = t.mock.method(h.port, "createDestinationContainer");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await h.engine.withWriterResult(h.ref, (w) => w.execute());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, "drive_creation_ambiguous");
  }
  assert.equal(create.mock.callCount(), 1);
});

test("naming library members without the optional credential refuses before creation", async (t) => {
  const h = await harness(t);
  const result = await h.engine.withWriterResult(h.ref, (w) =>
    w.loadManifest({
      format: "json",
      content: JSON.stringify(manifest([member])),
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal.code, "preflight_failed");
  assert.deepEqual(value(await h.engine.reader(h.ref).status()).createdDrives, []);
  assert.equal((await h.port.findDestinationContainers({ name: "Finance", siteId })).length, 0);
});

test("removing named members never restores inherited access or drops managed checks", async (t) => {
  const h = await harness(t, { members: [member] });
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  value(
    await h.engine.withWriterResult(h.ref, (w) =>
      w.loadManifest({
        format: "json",
        content: JSON.stringify(manifest([])),
      }),
    ),
  );
  await approve(h);
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const status = value(await h.engine.reader(h.ref).status());
  assert.equal(
    status.currentPlan?.sections.some((section) => section.title === "Inherited site access"),
    false,
  );
  assert.equal(h.port.destinationInheritsPermissions(status.createdDrives[0]!.driveId!), false);
  value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
  assert.equal(
    value(await h.engine.reader(h.ref).status()).createdDrives[0]?.goLive?.check?.status,
    "passed",
  );
});

for (const principal of [
  { email: "app:destination-app", type: "principal:0", role: "owner" },
  { email: "unexpected@example.com", type: "user", role: "read" },
]) {
  test(`unproven initial ${principal.type} access refuses before any copy or grant`, async (t) => {
    const h = await harness(t, { members: [member], implicit: [principal] });
    const copy = t.mock.method(h.port, "startCopyPass");
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await h.engine.withWriterResult(h.ref, (w) => w.execute());
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.refusal.code, "preflight_failed");
        assert.equal(result.refusal.detail?.check, "destination_initial_access_unproven");
        assert.deepEqual(result.refusal.detail?.actual, [principal]);
      }
    }
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(copy.mock.callCount(), 0);
    assert.deepEqual(status.memberGrants, []);
    assert.equal(status.createdDrives[0]?.initialMembers, undefined);
    assert.equal(h.port.destinationInheritsPermissions(status.createdDrives[0]!.driveId!), false);
  });
}

for (const crashBeforeRequest of [false, true]) {
  test(`a foreign same-title library after intent is never adopted${crashBeforeRequest ? " after a pre-request crash" : " on a create conflict"}`, async (t) => {
    const h = await harness(t, { members: [member], options: { mirror: true, deleteLimit: 1 } });
    const create = h.port.createDestinationContainer.bind(h.port);
    const foreign = () => create({ name: "Finance", siteId, requestId: "another-job" });
    if (crashBeforeRequest) {
      const execute = fileMigrationDriver.execute;
      const injected = t.mock.method(
        fileMigrationDriver,
        "execute",
        async function* (ctx: Parameters<typeof execute>[0]) {
          for await (const unit of execute(ctx)) {
            yield unit;
            if (unit.createdDrive && !unit.createdDrive.creationAttemptedAt) {
              await foreign();
              throw new Error("crash before HTTP request");
            }
          }
        },
      );
      await assert.rejects(
        h.engine.withWriterResult(h.ref, (w) => w.execute()),
        /crash before HTTP request/,
      );
      injected.mock.restore();
    } else {
      t.mock.method(
        h.port,
        "createDestinationContainer",
        async (input: Parameters<typeof create>[0]) => {
          await foreign();
          return create(input);
        },
      );
    }
    const copy = t.mock.method(h.port, "startCopyPass");
    const permissions = t.mock.method(h.port, "prepareDestinationMembers");
    const result = await h.engine.withWriterResult(h.ref, (w) => w.execute());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, "drive_creation_ambiguous");
    assert.equal(copy.mock.callCount(), 0);
    assert.equal(permissions.mock.callCount(), 0);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.createdDrives[0]?.driveId, null);
    assert.deepEqual(status.memberGrants, []);
  });
}

test("a duplicate empty sibling folder appearing during consistency wait prevents settling", async (t) => {
  let mutate = () => {};
  const h = await harness(t, {
    sourceItems: [
      { id: "one", parentId: "source-root", name: "one", kind: "folder" },
      { id: "two", parentId: "source-root", name: "two", kind: "folder" },
    ],
    options: { staged: true, settleMaxPasses: 2 },
    waitForConsistency: async () => mutate(),
  });
  const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan({ final: true })));
  value(
    await h.engine.withWriterResult(h.ref, (w) =>
      w.approve({
        planDigest: plan.planDigest,
        approver: "test",
        mode: "unattended",
        freeze: { by: "test", at: now, how: "source editors removed" },
      }),
    ),
  );
  mutate = () => h.port.renameSourceItem("two", "one");
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const status = value(await h.engine.reader(h.ref).status());
  assert.equal(status.mappingPasses.at(-1)?.status, "failed");
  const rows = value(await h.engine.reader(h.ref).rows({ phase: "execute", limit: 100 })).rows;
  assert.deepEqual(
    rows
      .filter((row) => row.code === "destination_duplicate_name")
      .map((row) => (row.jobType === "file_migration" ? row.sourceItemId : ""))
      .sort(),
    ["one", "two"],
  );
});

test("encoded names are disclosed per path in the plan and report and verify clean without source changes", async (t) => {
  const h = await harness(t, {
    sourceItems: [
      { id: "folder", parentId: "source-root", name: "bad:folder", kind: "folder" },
      { id: "nested", parentId: "folder", name: "normal.txt", kind: "file", content: "nested" },
      {
        id: "question",
        parentId: "source-root",
        name: "report?.txt",
        kind: "file",
        content: "question",
      },
      {
        id: "literal",
        parentId: "source-root",
        name: "report？.txt",
        kind: "file",
        content: "literal",
      },
      {
        id: "slash",
        parentId: "source-root",
        name: "literal/slash.txt",
        kind: "file",
        content: "slash",
      },
    ],
  });
  const planned = value(await h.engine.reader(h.ref).rows({ phase: "plan", limit: 100 })).rows;
  const notices = planned.filter((row) => row.code === "destination_name_encoded");
  assert.equal(notices.length, 5);
  assert.ok(notices.every((row) => row.kind === "policy_outcome"));
  const question = notices.find(
    (row) => row.jobType === "file_migration" && row.sourceItemId === "question",
  );
  assert.ok(question?.jobType === "file_migration");
  assert.deepEqual(question.destinationConstraint, {
    blocking: false,
    originalPath: "report?.txt",
    encodedPath: "report？.txt",
    originalName: "report?.txt",
    encodedName: "report？.txt",
  });
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const created = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  assert.deepEqual(
    (await h.port.listDestinationChildren(created.rootFolderId!)).map((item) => item.name).sort(),
    ["bad：folder", "literal／slash.txt", "report？.txt", "report‛？.txt"].sort(),
  );
  assert.equal(
    (await h.port.readSourceItem({ driveId: "source-drive", itemId: "question" }))?.name,
    "report?.txt",
  );
  const verification = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
  assert.equal(verification.clean, true);
  const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
  const document = JSON.parse(
    await readFile(
      report.artifacts.find((artifact) => artifact.name === "report.json")!.path,
      "utf8",
    ),
  );
  const encoded = document.findings.filter(
    (finding: { code: string }) => finding.code === "destination_name_encoded",
  );
  assert.equal(encoded.length, 5);
  assert.ok(
    encoded.some(
      (finding: { evidence: { originalPath: string; encodedPath: string } }) =>
        finding.evidence.originalPath === "bad:folder/normal.txt" &&
        finding.evidence.encodedPath === "bad：folder/normal.txt",
    ),
  );
  value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
});

test("planning blocks reserved names until source repair without freezing per-file scope", async (t) => {
  const h = await harness(t);
  h.port.renameSourceItem("file", "CON");
  const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
  const rows = value(await h.engine.reader(h.ref).rows({ phase: "plan", limit: 100 })).rows;
  assert.ok(rows.some((row) => row.code === "destination_invalid_name"));
  const approval = await h.engine.withWriterResult(h.ref, (w) =>
    w.approve({
      planDigest: plan.planDigest,
      approver: "test",
      mode: "unattended",
    }),
  );
  assert.equal(approval.ok, false);
  h.port.renameSourceItem("file", "fixed.txt");
  await approve(h);
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
});
