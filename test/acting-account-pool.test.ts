import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { parse, stringify } from "smol-toml";
import { openEngine, type Engine, type JobRef } from "../src/engine/index.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import { approve, closeDecision, fileFixture, value } from "./engine-fixture.ts";

// ADR-0019: acting-account pools for Google and Dropbox writes, against the fake provider.
const now = "2026-09-01T00:00:00.000Z";
const QUOTA = "googleapi: Error 403: Quota exceeded., quotaExceeded";
const ONE = "one@example.test";
const TWO = "two@example.test";
const THREE = "three@example.test";

interface Harness {
  home: string;
  engine: Engine;
  ref: JobRef;
  port: FakeFileMigrationPort;
}

function mappings(ids: string[]) {
  const input = fileFixture(
    ids.flatMap((id) => [
      { id, parentId: "source-root", name: id, kind: "folder" as const },
      {
        id: `${id}-file`,
        parentId: id,
        name: `${id}.txt`,
        kind: "file" as const,
        content: id,
      },
    ]),
  );
  input.destinationItems.push(
    ...ids.map((id) => ({
      id: `dest-${id}`,
      parentId: "destination-root",
      name: id,
      kind: "folder" as const,
    })),
  );
  input.googleAbout = { user: { emailAddress: "files@example.test" }, canCreateDrives: true };
  return input;
}

async function harness(
  t: TestContext,
  ids: string[],
  accounts: string[],
  tweak?: (input: FakeFileMigrationFixture) => void,
  options: Record<string, unknown> = {},
): Promise<Harness> {
  const input = mappings(ids);
  tweak?.(input);
  const port = new FakeFileMigrationPort(input);
  const home = await mkdtemp(join(tmpdir(), "migmate-pool-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const engine = openEngine({ home, now: () => new Date(now), provider: port });
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      config: {
        impersonate: true,
        subject: "files@example.test",
        actingAccounts: accounts,
        options,
        mappings: ids.map((id) => ({
          id,
          sourceDriveId: "source-drive",
          sourceItemId: id,
          destDriveId: "destination-drive",
          destFolderId: `dest-${id}`,
        })),
      },
    }),
  );
  return { home, engine, ref, port };
}

async function edit(h: Harness, change: (config: Record<string, unknown>) => void) {
  const path = join(h.home, "jobs", h.ref.id, "job.toml");
  const config = parse(await readFile(path, "utf8")) as Record<string, unknown>;
  change(config);
  await writeFile(path, stringify(config));
}

const status = async (h: Harness) => value(await h.engine.reader(h.ref).status());

describe("acting-account pools", () => {
  it("spreads passes across the approved pool and proves each account can write", async (t) => {
    const h = await harness(t, ["a", "b", "c", "d"], [ONE, TWO]);
    await approve(h);
    const result = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    assert.equal(result.outcome, "completed");
    assert.deepEqual(h.port.passAccounts.toSorted(), [ONE, ONE, TWO, TWO]);
    const passes = (await status(h)).mappingPasses;
    assert.deepEqual(
      passes.map((pass) => [pass.mappingId, pass.status]),
      [
        ["a", "completed"],
        ["b", "completed"],
        ["c", "completed"],
        ["d", "completed"],
      ],
    );
    assert.ok(passes.every((pass) => pass.account === ONE || pass.account === TWO));
    // Preflight proves the operator's pre-grant once per account and existing root (D4).
    assert.deepEqual(
      [...new Set(h.port.calls.filter((call) => call.startsWith("proveAccountWrite:")))].toSorted(),
      [`proveAccountWrite:destination-drive:${ONE}`, `proveAccountWrite:destination-drive:${TWO}`],
    );
    const pool = (await status(h)).actingAccounts;
    assert.deepEqual(pool?.active, [ONE, TWO]);
    assert.deepEqual(pool?.pending, []);
  });

  it("fails preflight when a pool account cannot write to an existing destination", async (t) => {
    const h = await harness(t, ["a"], [ONE, TWO], (input) => {
      input.unwritableAccounts = [TWO];
    });
    const plan = await h.engine.withWriterResult(h.ref, (w) => w.plan());
    assert.equal(plan.ok, false);
    if (!plan.ok) {
      assert.equal(plan.refusal.code, "preflight_failed");
      assert.match(JSON.stringify(plan.refusal), new RegExp(`actingAccount:${TWO}`));
    }
  });

  it("moves a daily-limited account's mapping to another account and finishes", async (t) => {
    const h = await harness(t, ["a", "b"], [ONE, TWO], (input) => {
      input.copyPasses = [{ sourceRootId: "a", account: ONE, error: QUOTA }];
    });
    await approve(h);
    const result = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    assert.equal(result.outcome, "completed");
    assert.equal(result.uploadQuota, undefined);
    assert.deepEqual(
      result.accountStops?.map((stop) => stop.actingGoogleAccount),
      [ONE],
    );
    const passes = (await status(h)).mappingPasses.filter((pass) => pass.mappingId === "a");
    assert.deepEqual(
      passes.map((pass) => [pass.account, pass.status, pass.uploadQuota?.code ?? null]),
      [
        [ONE, "failed", "upload_quota_exceeded"],
        [TWO, "completed", null],
      ],
    );
    // The exhausted account gets no more work in this run (D5).
    assert.equal(h.port.passAccounts.filter((account) => account === ONE).length, 1);
  });

  it("keeps a mirror deletion limit across reassignment", async (t) => {
    const h = await harness(
      t,
      [],
      [ONE, TWO],
      (input) => {
        input.sourceItems.push({
          id: "x",
          parentId: "source-root",
          name: "x.txt",
          kind: "file",
          content: "x",
        });
      },
      { staged: true, mirror: true, deleteLimit: 1, consistencyIntervalMs: 0 },
    );
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: [
              {
                id: "finance",
                source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
                destination: { type: "google_shared_drive", create: "Finance" },
                members: [{ email: "finance@example.test", type: "group", role: "writer" }],
              },
            ],
          }),
        }),
      ),
    );
    await approve(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    const first = h.port.passAccounts[0]!;
    const other = first === ONE ? TWO : ONE;
    h.port.deleteSourceItem("x");
    (h.port as unknown as { copyPassScenarios: object[] }).copyPassScenarios.push({
      account: first,
      error: QUOTA,
    });
    // A final staged pass keeps one deletion budget across its attempts.
    const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan({ final: true })));
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.approve({
          approver: "operator@example.test",
          mode: "unattended",
          planDigest: plan.planDigest,
          freeze: { by: "operator@example.test", at: now, how: "writers stopped" },
        }),
      ),
    );
    const result = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    // The moved attempt reuses the stopped one's authorization rather than counting it twice.
    assert.equal(result.outcome, "completed");
    assert.deepEqual(h.port.passAccounts.slice(1), [first, other]);
    assert.equal(
      h.port.snapshotDestination().some((item) => item.path === "x.txt"),
      false,
    );
  });

  it("blocks with every account's stop when the whole pool is daily-limited", async (t) => {
    const h = await harness(t, ["a", "b"], [ONE, TWO], (input) => {
      input.copyPasses = [
        { account: ONE, error: QUOTA },
        { account: TWO, error: QUOTA },
      ];
    });
    await approve(h);
    const result = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    assert.equal(result.outcome, "blocked");
    assert.ok(result.uploadQuota);
    assert.deepEqual(result.accountStops?.map((stop) => stop.actingGoogleAccount).toSorted(), [
      ONE,
      TWO,
    ]);
    assert.ok(result.accountStops?.every((stop) => stop.resumeTimeIsEstimate));
  });

  it("never moves work on ordinary throttling", async (t) => {
    const h = await harness(t, ["a"], [ONE, TWO], (input) => {
      input.copyPasses = [{ account: ONE, error: "googleapi: Error 500: backendError" }];
    });
    await approve(h);
    const result = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    assert.equal(result.outcome, "blocked");
    assert.equal(result.accountStops, undefined);
    assert.deepEqual(h.port.passAccounts, [ONE]);
  });

  it("gives added accounts work only after approval, with no re-plan", async (t) => {
    const h = await harness(t, ["a", "b"], [ONE]);
    const digest = await approve(h);
    await edit(h, (config) => {
      config.actingAccounts = [ONE, TWO];
      (config.options as Record<string, unknown>).mappingsInFlight = 1;
    });
    const pending = (await status(h)).actingAccounts!;
    assert.deepEqual(pending.active, [ONE]);
    assert.deepEqual(pending.pending, [TWO]);
    assert.equal(pending.mappingsInFlight, 1);
    // Concurrency is live operator config: the plan approval still holds (ADR-0019 D3).
    assert.equal((await status(h)).currentPlan?.planDigest, digest);
    const stale = await h.engine.approveAccounts(h.ref, {
      approver: "operator@example.test",
      mode: "unattended",
      poolDigest: "0".repeat(64),
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.refusal.code, "approval_digest_stale");
    const approval = value(
      await h.engine.approveAccounts(h.ref, {
        approver: "operator@example.test",
        mode: "unattended",
        poolDigest: pending.poolDigest!,
      }),
    );
    assert.deepEqual(approval.accounts, [TWO]);
    assert.equal(approval.identityAssurance, "declared_unverified");
    const approved = (await status(h)).actingAccounts!;
    assert.deepEqual(approved.active, [ONE, TWO]);
    assert.deepEqual(approved.pending, []);
    assert.equal(approved.poolDigest, null);
    const result = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    assert.equal(result.outcome, "completed");
    assert.deepEqual(h.port.passAccounts.toSorted(), [ONE, TWO]);
  });

  it("reads live concurrency and removals at the next pass admission of a running execute", async (t) => {
    const h = await harness(
      t,
      ["a", "b", "c"],
      [ONE, TWO],
      (input) => {
        input.copyPasses = [{ sourceRootId: "a", pause: true, afterFiles: 0 }];
      },
      { mappingsInFlight: 1, transfersPerMapping: 4 },
    );
    await approve(h);
    const paused = Promise.withResolvers<void>();
    const start = h.port.startCopyPass.bind(h.port);
    t.mock.method(h.port, "startCopyPass", async (input: Parameters<typeof start>[0]) => {
      const handle = await start(input);
      if (handle.jobid === 1) {
        await h.port.waitForCopyPassPaused(handle.jobid);
        paused.resolve();
      }
      return handle;
    });
    const running = h.engine.withWriterResult(h.ref, (w) => w.execute());
    await paused.promise;
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const config = parse(await readFile(path, "utf8")) as Record<string, unknown>;
    // Removing the running pass's account needs no approval; that pass still finishes.
    const changed = value(
      await h.engine.updateSettings(h.ref, {
        ...config,
        actingAccounts: [TWO],
        options: { ...(config.options as object), transfersPerMapping: 2 },
      }),
    );
    assert.deepEqual(changed.changed, ["actingAccounts", "transfersPerMapping"]);
    h.port.releaseCopyPasses();
    const result = value(await running);
    assert.equal(result.outcome, "completed");
    assert.deepEqual(h.port.passAccounts, [ONE, TWO, TWO]);
    assert.deepEqual(h.port.passTransfers, [4, 2, 2]);
    assert.equal((await status(h)).currentPlan?.revision, 1);
  });

  it("refuses execute when no approved account remains", async (t) => {
    const h = await harness(t, ["a"], [ONE]);
    await approve(h);
    await edit(h, (config) => {
      config.actingAccounts = [TWO];
    });
    const pool = (await status(h)).actingAccounts!;
    assert.deepEqual(pool.removed, [ONE]);
    assert.deepEqual(pool.pending, [TWO]);
    const refused = await h.engine.withWriterResult(h.ref, (w) => w.execute());
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.refusal.code, "approval_required");
    assert.deepEqual(h.port.passAccounts, []);
  });

  it("grants uploader membership on created containers and removes it at close", async (t) => {
    const h = await harness(t, [], [ONE, TWO], undefined, { memberGrants: "after_verification" });
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: [
              {
                id: "finance",
                source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
                destination: { type: "google_shared_drive", create: "Finance" },
                members: [{ email: "finance@example.test", type: "group", role: "writer" }],
              },
            ],
          }),
        }),
      ),
    );
    await approve(h);
    const result = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    assert.equal(result.outcome, "completed");
    const executed = await status(h);
    const driveId = executed.createdDrives[0]!.driveId!;
    const account = executed.mappingPasses[0]!.account!;
    assert.ok([ONE, TWO].includes(account));
    assert.ok(
      (await h.port.listDriveMembers(driveId)).some(
        (member) => member.email === account && member.role === "fileOrganizer",
      ),
    );
    assert.equal(
      h.port.calls.filter((call) => call.startsWith("proveAccountWrite:")).length,
      0,
      "created containers are granted, not proven",
    );
    assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    const closed = await status(h);
    assert.equal(closed.state, "closed");
    assert.ok(closed.createdDrives[0]!.uploaders?.every((uploader) => uploader.removedAt));
    assert.deepEqual(
      (await h.port.listDriveMembers(driveId)).map((member) => member.email).toSorted(),
      ["files@example.test", "finance@example.test"],
    );
  });
});

describe("Dropbox acting-account pools", () => {
  const MONTHLY =
    "upload failed: invalid_account_type/feature/: Your team has used all of its data transport API calls for the month.";
  async function dropbox(t: TestContext, fixture: Partial<FakeFileMigrationFixture> = {}) {
    const input = {
      ...fileFixture(
        ["a", "b"].flatMap((id) => [
          { id, parentId: "source-root", name: id, kind: "folder" as const },
          { id: `${id}-file`, parentId: id, name: `${id}.txt`, kind: "file" as const, content: id },
        ]),
      ),
      destinationProvider: "dropbox" as const,
      now: () => new Date(now),
      ...fixture,
    };
    const port = new FakeFileMigrationPort(input);
    const home = await mkdtemp(join(tmpdir(), "migmate-dropbox-pool-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const engine = openEngine({ home, now: () => new Date(now), provider: port });
    const ref = value(
      await engine.initJob({
        type: "file_migration",
        config: {
          sourceProvider: "sharepoint",
          destinationProvider: "dropbox",
          actingAccounts: [ONE, TWO],
          options: { memberGrants: "after_verification", consistencyIntervalMs: 0 },
        },
      }),
    );
    value(
      await engine.withWriterResult(ref, (w) =>
        w.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: ["a", "b"].map((id) => ({
              id,
              source: { type: "sharepoint", driveId: "source-drive", folderPath: id },
              destination: { type: "dropbox", create: `Team ${id}` },
            })),
          }),
        }),
      ),
    );
    const h = { home, engine, ref, port };
    await approve(h);
    return h;
  }

  it("spreads passes across members with editor uploader membership", async (t) => {
    const h = await dropbox(t);
    const result = value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
    assert.equal(result.outcome, "completed");
    assert.deepEqual(h.port.passAccounts.toSorted(), [ONE, TWO]);
    for (const drive of (await status(h)).createdDrives)
      assert.ok(drive.uploaders?.some((uploader) => uploader.role === "editor"));
  });

  it("blocks the whole job on the team's monthly limit and never reassigns", async (t) => {
    const h = await dropbox(t, {
      copyPasses: [{ sourceRootId: "a", retryingError: MONTHLY }],
    });
    const result = value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.execute({ signal: AbortSignal.timeout(5000) }),
      ),
    );
    assert.equal(result.outcome, "blocked");
    assert.equal(result.uploadQuota?.limit, "dropbox_team_monthly_upload_calls");
    assert.equal(h.port.passAccounts.length, 2);
    const passes = (await status(h)).mappingPasses;
    assert.equal(passes.filter((pass) => pass.mappingId === "a").length, 1);
  });
});
