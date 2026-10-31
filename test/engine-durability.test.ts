import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  EngineRefusalError,
  openEngine,
  type Engine,
  type JobEvent,
  type JobRef,
  type Outcome,
  type RefusalCode,
  type Row,
} from "../src/engine/index.ts";
import {
  FakeFileMigrationPort,
  type FakeArchiveFixture,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import {
  fileConfig as config,
  fileFixture,
  value,
  approve,
  closeDecision,
} from "./engine-fixture.ts";
import type { ConversationManifest, PackageManifest } from "../src/engine/archive/package.ts";
import { canonicalJson, digestJson } from "../src/engine/store/digest.ts";

const NOW = "2026-09-01T00:00:00.000Z";

function refused<T>(outcome: Outcome<T>, code: RefusalCode): void {
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error(`Expected ${code}`);
  assert.equal(outcome.refusal.code, code);
}

function hash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(): FakeFileMigrationFixture {
  return fileFixture([
    {
      id: "document",
      parentId: "source-root",
      name: "document.bin",
      kind: "file",
      content: "original",
      etag: "source-v1",
      createdAt: NOW,
      modifiedAt: NOW,
      mimeType: "application/octet-stream",
    },
  ]);
}

interface Harness {
  home: string;
  engine: Engine;
  port: FakeFileMigrationPort;
  ref: JobRef;
  now: string;
}

async function harness(
  t: TestContext,
  input = fixture(),
  selected: unknown = config(),
  type: "file_migration" | "teams_archive" = "file_migration",
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "migmate-durability-"));
  const port = new FakeFileMigrationPort(input);
  const clock = { now: NOW };
  const engine = openEngine({ home, provider: port, now: () => new Date(clock.now) });
  const ref = value(await engine.initJob({ type, config: selected }));
  const h: Harness = {
    home,
    engine,
    port,
    ref,
    get now() {
      return clock.now;
    },
    set now(next) {
      clock.now = next;
    },
  };
  t.after(async () => {
    h.engine.close();
    await rm(home, { recursive: true, force: true });
  });
  return h;
}

function reopen(h: Harness): void {
  h.engine.close();
  h.engine = openEngine({ home: h.home, provider: h.port, now: () => new Date(h.now) });
}

async function execute(h: Harness) {
  return value(await h.engine.withWriterResult(h.ref, (writer) => writer.execute()));
}

async function verify(h: Harness) {
  return value(await h.engine.withWriterResult(h.ref, (writer) => writer.verify()));
}
function corruptDestination(h: Harness): void {
  const document = h.port.snapshotDestination().find((item) => item.name === "document.bin");
  assert.ok(document);
  h.port.mutateDestinationContent(document.id, Buffer.from("different destination length"));
}

async function events(engine: Engine, ref: JobRef, from?: number): Promise<JobEvent[]> {
  const result: JobEvent[] = [];
  for await (const event of engine.reader(ref).events(from === undefined ? {} : { from }))
    result.push(event);
  return result;
}

// Filesystem evidence is the public contract for read-only access and secret non-persistence.
// SQLite is used only to prepare a future-version fixture, never to assert engine internals.
async function diskSnapshot(
  root: string,
): Promise<Array<{ path: string; mode: number; modified: number; bytes: Buffer | null }>> {
  const result: Array<{ path: string; mode: number; modified: number; bytes: Buffer | null }> = [];
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative);
    const stat = await lstat(path);
    result.push({
      path: relative,
      mode: stat.mode,
      modified: stat.mtimeMs,
      bytes: stat.isFile() ? await readFile(path) : null,
    });
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(relative, child));
    }
  }
  await visit("");
  return result;
}

async function readerRefusals(engine: Engine, ref: JobRef, code: RefusalCode): Promise<void> {
  const reader = engine.reader(ref);
  refused(await reader.status(), code);
  refused(await reader.rows({ phase: "plan" }), code);
  refused(await reader.artifacts(), code);
  await assert.rejects(
    async () => {
      for await (const event of reader.events({})) void event;
    },
    (error: unknown) => {
      assert.ok(error instanceof EngineRefusalError);
      assert.equal(error.refusal.code, code);
      return true;
    },
  );
}

describe("engine durability seam", () => {
  it("discloses route limits once without per-file metadata omissions", async (t) => {
    const h = await harness(
      t,
      fileFixture([
        {
          id: "metadata-file",
          parentId: "source-root",
          name: "metadata-file",
          kind: "file",
          content: "bytes",
          metadata: { versionCount: 3, listItemFields: { Title: "retained evidence" } },
        },
      ]),
    );
    await approve(h);
    await execute(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(status.outstandingFindings, []);
    assert.equal(status.currentPlan?.rowCount, 1);
    const revision = value(await h.engine.withWriterResult(h.ref, (writer) => writer.verify()));
    assert.deepEqual(revision.findings, []);
    assert.deepEqual(revision.acceptedCodes, []);
  });

  it("refuses every removed file option by its explicit name", async (t) => {
    const h = await harness(t);
    for (const [field, options] of [
      ["options.proof", { proof: "full" }],
      ["options.proof", { proof: "rclone" }],
      ["options.acceptedOmissions", { acceptedOmissions: [] }],
      ["options.oneNoteNotebooks", { oneNoteNotebooks: "copy" }],
      ["options.deltaVerification", { deltaVerification: "full" }],
      ['options.verificationMode = "size_only"', { verificationMode: "size_only" }],
    ] as const) {
      const init = await h.engine.initJob({
        type: "file_migration",
        config: { ...config(), options },
      });
      refused(init, "configuration_invalid");
      if (!init.ok) assert.equal(init.refusal.detail?.field, field);
    }
    for (const exclusions of [[], [{ sourceItemId: "document", reason: "Excluded" }]]) {
      const init = await h.engine.initJob({
        type: "file_migration",
        config: {
          ...config(),
          mappings: config().mappings.map((mapping) => ({ ...mapping, exclusions })),
        },
      });
      refused(init, "configuration_invalid");
      if (!init.ok) assert.equal(init.refusal.detail?.field, "mappings[0].exclusions");
    }
  });

  it("accepts listing and opt-in hash configuration on both file routes", async (t) => {
    const h = await harness(t);
    for (const [sourceProvider, destinationProvider] of [
      ["sharepoint", "google_shared_drive"],
      ["google_shared_drive", "sharepoint"],
    ])
      for (const verificationMode of [undefined, "hash"]) {
        const initialized = await h.engine.initJob({
          type: "file_migration",
          config: {
            ...config(),
            sourceProvider,
            destinationProvider,
            options: verificationMode === undefined ? {} : { verificationMode },
          },
        });
        assert.equal(initialized.ok, true);
      }
  });

  it("copies current source files after approval without an inventory freshness fence", async (t) => {
    const h = await harness(t);
    await approve(h);
    h.port.mutateSourceItem("document", { content: "changed after approval", etag: "v2" });
    h.now = "2026-10-01T00:00:00.000Z";
    assert.equal((await execute(h)).outcome, "completed");
    assert.equal((await verify(h)).clean, true);
  });

  it("refuses changing the approved verification mode without a new plan", async (t) => {
    const h = await harness(t, fixture(), { ...config(), options: { verificationMode: "hash" } });
    await approve(h);
    await execute(h);
    const before = value(await h.engine.reader(h.ref).status()).verificationDigest;
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const settings = parseToml(await readFile(path, "utf8"));
    await writeFile(path, stringifyToml({ ...settings, options: {} }));
    refused(
      await h.engine.withWriterResult(h.ref, (writer) => writer.verify()),
      "plan_revision_required",
    );
    assert.equal(value(await h.engine.reader(h.ref).status()).verificationDigest, before);
  });

  it("exposes one verification gate with execution already complete to a live reader", async (t) => {
    const h = await harness(t, fixture(), { ...config(), options: { verificationMode: "hash" } });
    await approve(h);
    const original = h.port.listFileHashes.bind(h.port);
    let observedVerification = false;
    t.mock.method(h.port, "listFileHashes", async (input: Parameters<typeof original>[0]) => {
      const rail = value(await h.engine.reader(h.ref).status()).rail;
      if (rail.some((entry) => entry.verb === "verify" && entry.state === "current")) {
        observedVerification = true;
        assert.deepEqual(
          rail.filter((entry) => entry.state === "current").map((entry) => entry.verb),
          ["verify"],
        );
        for (const verb of ["plan", "approve", "execute"])
          assert.equal(rail.find((entry) => entry.verb === verb)?.state, "done");
      }
      return original(input);
    });
    await execute(h);
    assert.equal(observedVerification, true);
  });

  it("binds every plan revision even when unchanged evidence retains the same inputs digest", async (t) => {
    const h = await harness(t);
    const first = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    h.now = "2026-09-02T00:00:00.000Z";
    reopen(h);
    const unchanged = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    assert.ok(unchanged.revision > first.revision);
    assert.notEqual(unchanged.planDigest, first.planDigest);
    assert.equal(unchanged.inputsDigest, first.inputsDigest);
    refused(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.approve({
          approver: "stale-reviewer",
          mode: "interactive",
          planDigest: first.planDigest,
        }),
      ),
      "approval_digest_stale",
    );
    assert.equal(value(await h.engine.reader(h.ref).status()).currentApproval, null);
    h.port.mutateSourceItem("document", { content: "modified", etag: "source-v2" });
    const changed = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    assert.equal(changed.rowCount, first.rowCount);
    assert.notEqual(changed.planDigest, first.planDigest);
    refused(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.approve({
          approver: "durability-test",
          mode: "unattended",
          planDigest: first.planDigest,
        }),
      ),
      "approval_digest_stale",
    );
  });

  it("binds final intent and preserves freeze evidence without inventory age across reopen", async (t) => {
    const h = await harness(t, fixture(), {
      ...config(),
      options: { staged: true, consistencyIntervalMs: 0 },
    });
    const prestage = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    const final = value(
      await h.engine.withWriterResult(h.ref, (writer) => writer.plan({ final: true })),
    );
    assert.notEqual(final.planDigest, prestage.planDigest);
    h.now = "2026-09-01T00:05:00.000Z";
    const freeze = { by: "freeze-owner", at: NOW, how: "Removed editor access" };
    const approval = value(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.approve({
          approver: "cutover-owner",
          mode: "unattended",
          planDigest: final.planDigest,
          freeze,
        }),
      ),
    );
    assert.equal("sourceInventoryAgeMs" in approval, false);
    assert.equal("sourceInventoryAt" in approval, false);
    assert.equal("sourceInventoryAt" in final, false);
    reopen(h);
    assert.equal(value(await h.engine.reader(h.ref).status()).currentPlan?.stage, "final");
    const report = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
    const evidence = JSON.parse(
      await readFile(report.artifacts.find((item) => item.name === "report.json")!.path, "utf8"),
    );
    assert.deepEqual(evidence.approval.freeze, freeze);
    assert.equal(evidence.approval.approvalDigest, approval.approvalDigest);
    assert.equal(evidence.plan.stage, "final");
  });

  it("cannot downgrade an approved prestage to unstaged closure by editing configuration", async (t) => {
    const h = await harness(t, fixture(), { ...config(), options: { staged: true } });
    await approve(h);
    await execute(h);
    value(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.onboard({
          ...config(),
          options: { staged: false },
        }),
      ),
    );
    refused(
      await h.engine.withWriterResult(h.ref, async (writer) =>
        writer.close(await closeDecision(h)),
      ),
      "cutover_incomplete",
    );
    refused(
      await h.engine.withWriterResult(h.ref, (writer) => writer.plan()),
      "configuration_invalid",
    );
  });

  it("retains approved staged intent when manifest reload clears the current plan", async (t) => {
    const h = await harness(t, fixture(), { ...config(), options: { staged: true } });
    await approve(h);
    await execute(h);
    await writeFile(
      join(h.home, "jobs", h.ref.id, "job.toml"),
      stringifyToml({ ...config(), options: { staged: false } }),
    );
    const loaded = await h.engine.withWriterResult(h.ref, (writer) =>
      writer.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [
            {
              id: "mapping",
              source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
              destination: {
                type: "google_shared_drive",
                driveId: "destination-drive",
                folderId: "destination-root",
              },
            },
          ],
        }),
      }),
    );
    if (loaded.ok) {
      const plan = value(await h.engine.reader(h.ref).status()).currentPlan!;
      value(
        await h.engine.withWriterResult(h.ref, (writer) =>
          writer.approve({
            approver: "operator",
            mode: "unattended",
            planDigest: plan.planDigest,
          }),
        ),
      );
      await execute(h);
    } else {
      assert.equal(loaded.refusal.code, "configuration_invalid");
    }
    reopen(h);
    refused(
      await h.engine.withWriterResult(h.ref, async (writer) =>
        writer.close(await closeDecision(h)),
      ),
      "cutover_incomplete",
    );
  });

  it("fully verifies a repointed destination with the approved hash mode", async (t) => {
    const input = fixture();
    input.destinationItems.push({
      id: "other-root",
      parentId: null,
      name: "other",
      kind: "folder",
    });
    const h = await harness(t, input, {
      ...config(),
      options: { staged: true, verificationMode: "hash" },
    });
    await approve(h);
    await execute(h);
    value(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: [
              {
                id: "mapping",
                source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
                destination: {
                  type: "google_shared_drive",
                  driveId: "destination-drive",
                  folderId: "other-root",
                },
              },
            ],
          }),
        }),
      ),
    );
    const plan = value(await h.engine.reader(h.ref).status()).currentPlan!;
    value(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.approve({
          approver: "operator",
          mode: "unattended",
          planDigest: plan.planDigest,
        }),
      ),
    );
    const original = h.port.copyPassStatus.bind(h.port);
    let corrupted = false;
    t.mock.method(h.port, "copyPassStatus", async (input: Parameters<typeof original>[0]) => {
      const status = await original(input);
      if (!corrupted && status.state === "completed") {
        const destination = (await h.port.listDestinationChildren("other-root"))[0]!;
        h.port.mutateDestinationContent(destination.id, Buffer.from("corrupted"));
        corrupted = true;
      }
      return status;
    });
    await execute(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.ok(status.outstandingFindings.some((finding) => finding.code === "content_mismatch"));
    const artifacts = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
    const report = JSON.parse(
      await readFile(artifacts.artifacts.find((item) => item.name === "report.json")!.path, "utf8"),
    );
    const coverage = JSON.parse(
      report.sections.find((section: { title: string }) => section.title === "Verification scope")
        .body,
    );
    assert.equal(coverage.scope, "full");
    assert.equal(coverage.mappings[0].scope, "full");
  });

  it("binds a fresh map revision while source file changes leave authority unchanged", async (t) => {
    const h = await harness(t);
    const first = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    h.now = "2026-09-02T00:00:00.000Z";
    h.port.mutateSourceItem("document", { content: "new source bytes", etag: "v2" });
    reopen(h);
    const next = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    assert.ok(next.revision > first.revision);
    assert.notEqual(next.planDigest, first.planDigest);
    assert.equal(next.inputsDigest, first.inputsDigest);
  });

  it("requires fresh acceptance after every verification, even for unchanged exception evidence", async (t) => {
    const h = await harness(t);
    await approve(h);
    await execute(h);
    corruptDestination(h);
    const first = await verify(h);
    assert.deepEqual(first.findings, [{ code: "size_mismatch", kind: "finding", count: 1 }]);
    const accepted = value(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.accept({
          verificationDigest: first.verificationDigest,
          codes: ["size_mismatch"],
          rationale: "Keep this source outside the destination",
          mode: "unattended",
          approver: "operator",
        }),
      ),
    );
    assert.deepEqual(accepted.acceptedCodes, ["size_mismatch"]);
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).outstandingFindings, []);
    reopen(h);
    const fresh = await verify(h);
    assert.notEqual(fresh.verificationDigest, first.verificationDigest);
    assert.ok(fresh.revision > first.revision);
    assert.deepEqual(fresh.acceptedCodes, []);
    assert.deepEqual(fresh.findings, first.findings);
    assert.deepEqual(
      value(await h.engine.reader(h.ref).rows({ phase: "verify", codes: ["size_mismatch"] }))
        .facets,
      fresh.findings,
    );
    assert.ok(
      value(await h.engine.reader(h.ref).status()).outstandingFindings.some(
        (finding) => finding.code === "size_mismatch",
      ),
    );
    refused(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.accept({
          verificationDigest: first.verificationDigest,
          codes: ["size_mismatch"],
          rationale: "Out of scope",
          mode: "unattended",
          approver: "operator",
        }),
      ),
      "verification_unaccepted",
    );
    refused(
      await h.engine.withWriterResult(h.ref, async (writer) =>
        writer.close(await closeDecision(h)),
      ),
      "verification_unaccepted",
    );
    value(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.accept({
          verificationDigest: fresh.verificationDigest,
          codes: ["size_mismatch"],
          rationale: "Out of scope",
          mode: "unattended",
          approver: "operator",
        }),
      ),
    );
    assert.deepEqual(
      value(
        await h.engine.withWriterResult(h.ref, async (writer) =>
          writer.close(await closeDecision(h)),
        ),
      ).acceptedExceptions,
      ["size_mismatch"],
    );
  });

  it("exports immutable byte-addressed evidence after closure with named accepted exceptions", async (t) => {
    const h = await harness(t);
    await approve(h);
    await execute(h);
    corruptDestination(h);
    const verification = await verify(h),
      note = "<script>operator-note()</script>";
    value(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.accept({
          verificationDigest: verification.verificationDigest,
          codes: ["size_mismatch"],
          rationale: note,
          mode: "unattended",
          approver: "archive-owner",
        }),
      ),
    );
    value(
      await h.engine.withWriterResult(h.ref, async (writer) =>
        writer.close(await closeDecision(h)),
      ),
    );
    const first = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
    const json = first.artifacts.find((artifact) => artifact.name === "report.json");
    const html = first.artifacts.find((artifact) => artifact.name === "report.html");
    assert.ok(json && html);
    for (const artifact of first.artifacts)
      assert.equal(artifact.digest, hash(await readFile(artifact.path)));
    const report = JSON.parse(await readFile(json.path, "utf8"));
    assert.equal(report.job.state, "closed");
    assert.equal(report.acceptedExceptions[0].approver, "archive-owner");
    assert.equal(report.acceptedExceptions[0].note, note);
    assert.deepEqual(
      report.acceptedExceptions[0].items.map((item: { phase: string }) => item.phase),
      ["verify"],
    );
    assert.equal(report.findings.length, 1);
    const rendered = await readFile(html.path, "utf8");
    assert.equal(rendered.includes(note), false);
    assert.ok(rendered.includes("&lt;script&gt;operator-note()&lt;/script&gt;"));
    reopen(h);
    const rail = value(await h.engine.reader(h.ref).status()).rail;
    assert.equal(
      rail.some(({ state }) => state === "current"),
      false,
    );
    for (const verb of ["plan", "execute", "verify", "close"])
      assert.equal(rail.find((entry) => entry.verb === verb)?.state, "done");
    assert.equal(rail.find((entry) => entry.verb === "cancel")?.state, "pending");
    const repeated = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
    assert.deepEqual(repeated, first);
    refused(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()), "job_closed");
  });

  it("refuses the whole named acceptance set when a later code is not in the current verification", async (t) => {
    const h = await harness(t);
    await approve(h);
    await execute(h);
    corruptDestination(h);
    const verification = await verify(h);
    const outstanding = value(await h.engine.reader(h.ref).status()).outstandingFindings;
    refused(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.accept({
          verificationDigest: verification.verificationDigest,
          codes: ["size_mismatch", "content_mismatch"],
          rationale: "Reviewed exception set",
          mode: "unattended",
          approver: "operator",
        }),
      ),
      "verification_unaccepted",
    );
    reopen(h);
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).outstandingFindings, outstanding);
    const omissions = value(
      await h.engine.reader(h.ref).rows({ phase: "verify", codes: ["size_mismatch"] }),
    );
    assert.equal(omissions.totalRows, 1);
    assert.equal(omissions.rows[0]?.accepted, false);
    refused(
      await h.engine.withWriterResult(h.ref, async (writer) =>
        writer.close(await closeDecision(h)),
      ),
      "verification_unaccepted",
    );
  });

  it("requires a rationale and records a repeated selected group only once", async (t) => {
    const h = await harness(t);
    await approve(h);
    await execute(h);
    corruptDestination(h);
    const verification = await verify(h);
    refused(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.accept({
          verificationDigest: verification.verificationDigest,
          codes: ["size_mismatch", "size_mismatch"],
          rationale: "   ",
          mode: "unattended",
          approver: "operator",
        }),
      ),
      "verification_unaccepted",
    );
    const accepted = value(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.accept({
          verificationDigest: verification.verificationDigest,
          codes: ["size_mismatch", "size_mismatch"],
          rationale: "Out of scope",
          mode: "unattended",
          approver: "operator",
        }),
      ),
    );
    assert.deepEqual(accepted.acceptedCodes, ["size_mismatch"]);
    assert.equal(accepted.clean, true);
    value(
      await h.engine.withWriterResult(h.ref, async (writer) =>
        writer.close(await closeDecision(h)),
      ),
    );
    const report = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
    const json = report.artifacts.find((artifact) => artifact.name === "report.json");
    assert.ok(json);
    const exceptions = JSON.parse(await readFile(json.path, "utf8")).acceptedExceptions;
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0].note, "Out of scope");
  });

  it("keeps full-set facets and stable row pages and event cursors across engine reopening", async (t) => {
    const input = fixture();
    input.sourceItems.push(
      { id: "excluded-folder", parentId: "source-root", name: "excluded", kind: "folder" },
      {
        id: "excluded-child",
        parentId: "excluded-folder",
        name: "child.bin",
        kind: "file",
        content: "omit",
      },
      {
        id: "another",
        parentId: "source-root",
        name: "another.bin",
        kind: "file",
        content: "retain",
      },
    );
    const h = await harness(t, input);
    await approve(h);
    await execute(h);
    for (const item of h.port.snapshotDestination())
      if (item.kind === "file" && item.name !== "document.bin")
        h.port.mutateDestinationContent(item.id, Buffer.from("changed destination bytes"));
    await verify(h);
    const full = value(
      await h.engine.reader(h.ref).rows({ phase: "verify", sort: "path", limit: 1000 }),
    );
    assert.equal(full.facets.find((facet) => facet.code === "size_mismatch")?.count, 2);
    const beforeEvents = await events(h.engine, h.ref);
    const middle = beforeEvents[Math.floor(beforeEvents.length / 2)];
    assert.ok(middle);
    const gathered: Row[] = [];
    let cursor: string | undefined;
    do {
      const page = value(
        await h.engine.reader(h.ref).rows({
          phase: "verify",
          sort: "path",
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      assert.equal(page.totalRows, full.totalRows);
      assert.equal(page.rows.length, 1);
      assert.deepEqual(page.facets, full.facets);
      gathered.push(...page.rows);
      assert.ok(gathered.length <= full.totalRows, "A continuation must not repeat earlier rows");
      cursor = page.nextCursor ?? undefined;
      reopen(h);
    } while (cursor !== undefined);
    assert.deepEqual(gathered, full.rows);
    assert.equal(new Set(gathered.map((row) => row.id)).size, full.totalRows);
    assert.deepEqual(await events(h.engine, h.ref), beforeEvents);
    assert.deepEqual(
      await events(h.engine, h.ref, middle.cursor),
      beforeEvents.filter((event) => event.cursor > middle.cursor),
    );
  });

  it("persists credential references without supplied secret text", async (t) => {
    const selected = {
      ...config(),
      rclone: {
        config: {
          resolver: "file",
          path: join(await realpath(tmpdir()), "operator-owned", "rclone.conf"),
          mode: "0600",
        },
        sourceRemote: "sp-source",
        destinationRemote: "gdrive-dest",
      },
    };
    const h = await harness(t, fixture(), selected);
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const original = await readFile(path, "utf8");
    const parsed = parseToml(original);
    assert.deepEqual(parsed.rclone, selected.rclone);
    reopen(h);
    value(await h.engine.withWriterResult(h.ref, (writer) => writer.doctor()));
    const secret = "MIGMATE-SECRET-MUST-NOT-PERSIST-0a163d";
    const invalid = {
      ...selected,
      rclone: { ...selected.rclone, config: { ...selected.rclone.config, value: secret } },
    };
    refused(
      await h.engine.initJob({ type: "file_migration", config: invalid }),
      "configuration_invalid",
    );
    refused(
      await h.engine.withWriterResult(h.ref, (writer) => writer.onboard(invalid)),
      "configuration_invalid",
    );
    assert.equal(await readFile(path, "utf8"), original);
    for (const file of await diskSnapshot(h.home)) {
      assert.equal(
        file.bytes?.includes(Buffer.from(secret)) ?? false,
        false,
        `Secret persisted in ${file.path}`,
      );
    }
    assert.equal(JSON.stringify(await events(h.engine, h.ref)).includes(secret), false);
  });

  it("reads job folders written by earlier builds but refuses their retired keys as new input", async (t) => {
    const h = await harness(t);
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const digest = "b".repeat(64);
    const retired = {
      guarantees: "default",
      qualification: { bundle: `qualification/${"a".repeat(64)}/${digest}`, digest },
    };
    await writeFile(
      path,
      stringifyToml({ ...parseToml(await readFile(path, "utf8")), ...retired }),
    );
    reopen(h);
    value(await h.engine.withWriterResult(h.ref, (writer) => writer.doctor()));
    for (const [key, legacy] of Object.entries(retired))
      refused(
        await h.engine.withWriterResult(h.ref, (writer) =>
          writer.onboard({ ...config(), [key]: legacy }),
        ),
        "configuration_invalid",
      );
  });

  it("round-trips an archive destination and separate credential references without persisting secrets", async (t) => {
    const directory = join(await realpath(tmpdir()), "operator-owned");
    const selected = {
      scopes: [{ kind: "user-chats", userId: "user-one" }],
      destination: { destDriveId: "0ABCsharedDrive", destFolderId: "1XYZarchiveFolder" },
      graph: {
        tenantId: "11111111-1111-1111-1111-111111111111",
        clientId: "22222222-2222-2222-2222-222222222222",
      },
      secrets: {
        teams_graph_client_secret: {
          resolver: "file",
          path: join(directory, "graph-secret"),
          mode: "0600",
        },
        google_service_account: {
          resolver: "file",
          path: join(directory, "service-account.json"),
          mode: "0600",
        },
      },
    };
    const h = await harness(
      t,
      { ...fileFixture(), archive: archiveFixture().fixture },
      selected,
      "teams_archive",
    );
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const original = await readFile(path, "utf8");
    const parsed = parseToml(original);
    assert.deepEqual(parsed.destination, selected.destination);
    assert.deepEqual(parsed.secrets, selected.secrets);
    reopen(h);
    value(await h.engine.withWriterResult(h.ref, (writer) => writer.onboard(parsed)));
    const secret = "ARCHIVE-GOOGLE-SECRET-MUST-NOT-PERSIST-9c5b";
    for (const invalid of [
      { ...selected, destination: { destDriveId: "0ABCsharedDrive" } },
      { ...selected, destination: { ...selected.destination, destFolderId: "root" } },
      { ...selected, destination: { ...selected.destination, destDriveId: "Shared Drive name" } },
      { ...selected, destination: { ...selected.destination, private_key: secret } },
      {
        ...selected,
        secrets: {
          ...selected.secrets,
          google_service_account: { ...selected.secrets.google_service_account, value: secret },
        },
      },
      {
        ...selected,
        secrets: {
          ...selected.secrets,
          google_service_account: {
            resolver: "file",
            path: join(h.home, "jobs", h.ref.id, "service-account.json"),
          },
        },
      },
    ]) {
      refused(
        await h.engine.withWriterResult(h.ref, (writer) => writer.onboard(invalid)),
        "configuration_invalid",
      );
      assert.equal(await readFile(path, "utf8"), original);
    }
    for (const file of await diskSnapshot(h.home)) {
      assert.equal(file.bytes?.includes(Buffer.from(secret)) ?? false, false, file.path);
    }
  });

  it("does not silently discard malformed mappings or string exclusions with an injected provider", async (t) => {
    const h = await harness(t);
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const before = await readFile(path, "utf8");
    for (const invalid of [
      {
        mappings: [
          {
            sourceDriveId: "source-drive",
            sourceItemId: "source-root",
            destDriveId: "destination-drive",
            destFolderId: "destination-root",
          },
        ],
      },
      { mappings: [{ ...config().mappings[0], exclusions: ["*.bin"] }] },
    ]) {
      refused(
        await h.engine.withWriterResult(h.ref, (writer) => writer.onboard(invalid)),
        "configuration_invalid",
      );
      assert.equal(await readFile(path, "utf8"), before);
    }
  });

  it("does not turn an unregistered provider defect into a handled collection finding", async (t) => {
    const h = await harness(t);
    await approve(h);
    const defect = Object.assign(new Error("Unexpected provider defect"), { code: "constructor" });
    h.port.scriptEffect({
      method: "listFileHashes",
      objectId: "source-root",
      count: 1,
      error: defect,
    });
    await assert.rejects(
      () => h.engine.withWriterResult(h.ref, (writer) => writer.execute()),
      (error) => error === defect,
    );
    assert.equal(value(await h.engine.reader(h.ref).status()).state, "interrupted");
  });

  it("refuses changed application identity before making any approved destination mutation", async (t) => {
    const h = await harness(t);
    await approve(h);
    const before = h.port.snapshotDestination();
    h.port.setApplicationIdentity("another-authenticated-application");
    refused(
      await h.engine.withWriterResult(h.ref, (writer) => writer.execute()),
      "plan_revision_required",
    );
    assert.deepEqual(h.port.snapshotDestination(), before);
  });

  it("refuses standalone file verification under a changed identity before reading either provider", async (t) => {
    const h = await harness(t);
    await approve(h);
    await execute(h);
    const original = value(await h.engine.reader(h.ref).status());
    const reads = [...h.port.calls];
    h.port.setApplicationIdentity("unapproved-application");
    reopen(h);
    refused(
      await h.engine.withWriterResult(h.ref, (writer) => writer.verify()),
      "plan_revision_required",
    );
    assert.deepEqual(h.port.calls, reads);
    assert.equal(
      value(await h.engine.reader(h.ref).status()).verificationDigest,
      original.verificationDigest,
    );
  });

  it("refuses a changed binary proof without replacing approved verification evidence", async (t) => {
    const h = await harness(t);
    let binary = "b".repeat(64);
    Object.assign(h.port, {
      async binaryEvidence() {
        return { sha256: binary, version: "fake-worker-1.0.0", path: "" };
      },
    });
    await approve(h);
    await execute(h);
    const digest = value(await h.engine.reader(h.ref).status()).verificationDigest;
    const reads = [...h.port.calls];
    binary = "d".repeat(64);
    refused(
      await h.engine.withWriterResult(h.ref, (writer) => writer.verify()),
      "plan_revision_required",
    );
    assert.deepEqual(h.port.calls, reads);
    assert.equal(value(await h.engine.reader(h.ref).status()).verificationDigest, digest);
  });

  it("opens a literal engine home containing shell metacharacters and a trailing path separator", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "migmate-literal-path-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "Engine [literal] & 'quoted'");
    const engine = openEngine({ home: `${home}/` });
    t.after(() => engine.close());
    const ref = value(await engine.initJob({ type: "file_migration" }));
    assert.equal(value(await engine.reader(ref).status()).jobId, ref.id);
    assert.equal(
      value(await engine.withWriterResult(ref, (writer) => writer.cancel("path proof"))).state,
      "cancelled",
    );
  });

  it(
    "waits for a contending SQLite owner when opening a lease-free reader",
    { timeout: 20_000 },
    async (t) => {
      const h = await harness(t);
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
    // SQLite's native busy handler blocks this thread; another real process must release the lock.
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.env.READER_LOCK_DB);
      db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE job SET label='committed by owner'");
      process.stdout.write("locked");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 500);
    `,
        ],
        {
          env: { ...process.env, READER_LOCK_DB: join(h.home, "jobs", h.ref.id, "state.db") },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const closed = once(child, "close");
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      await Promise.race([
        once(child.stdout, "data"),
        closed.then(() => {
          throw new Error("The contending process exited before acquiring its lock");
        }),
      ]);
      const status = value(await h.engine.reader(h.ref).status());
      assert.equal(status.jobId, h.ref.id);
      assert.equal(status.ownership.held, false);
      assert.equal((await closed)[0], 0);
    },
  );

  it("refuses missing reader state without creating an engine home or a missing job folder", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "migmate-reader-missing-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "not-created");
    const engine = openEngine({ home, provider: new FakeFileMigrationPort(fixture()) });
    const before = await diskSnapshot(root);
    await readerRefusals(engine, { id: "missing-job" }, "job_not_found");
    engine.close();
    assert.deepEqual(await diskSnapshot(root), before);
    const h = await harness(t);
    const existing = await diskSnapshot(h.home);
    await readerRefusals(h.engine, { id: "missing-job" }, "job_not_found");
    assert.deepEqual(await diskSnapshot(h.home), existing);
  });

  it("refuses newer read-only state without changing database bytes, metadata, or sidecar files", async (t) => {
    const h = await harness(t);
    const database = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
    try {
      database.exec("UPDATE job SET schema_version = 2147483647");
    } finally {
      database.close();
    }
    const before = await diskSnapshot(h.home);
    await readerRefusals(h.engine, h.ref, "state_version_unsupported");
    assert.deepEqual(await diskSnapshot(h.home), before);
  });

  it("upgrades state written by schema version 1 when a reader opens it", async (t) => {
    const h = await harness(t);
    const path = join(h.home, "jobs", h.ref.id, "state.db");
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
    const database = new DatabaseSync(path);
    try {
      database.exec(await readFile(new URL("./fixtures/schema-v1.sql", import.meta.url), "utf8"));
      database
        .prepare(
          "INSERT INTO job (id,type,state,schema_version,migmate_version,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(h.ref.id, "file_migration", "new", 1, "0.1.0-dev", new Date(0).toISOString());
    } finally {
      database.close();
    }
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.state, "new");
  });

  it("opens an approved schema version 2 job and executes mapping passes without losing its approval", async (t) => {
    const h = await harness(t);
    const digest = await approve(h);
    const database = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
    try {
      database.exec(
        "DROP TABLE mapping_pass; DROP TABLE mapping; DROP TABLE mapping_manifest; DROP TABLE member_grant; DROP TABLE created_drive; UPDATE job SET schema_version = 2",
      );
    } finally {
      database.close();
    }
    await writeFile(join(h.home, "jobs", h.ref.id, "job.toml"), stringifyToml(config()));
    reopen(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.planDigest, digest);
    assert.deepEqual(status.mappingPasses, []);
    assert.equal((await execute(h)).outcome, "completed");
    assert.equal((await verify(h)).clean, true);
    assert.equal(
      value(await h.engine.reader(h.ref).status()).mappingPasses[0]?.status,
      "completed",
    );
  });

  it("upgrades an approved schema version 4 job without changing its manifest or approval", async (t) => {
    const h = await harness(t);
    const digest = await approve(h);
    const database = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
    try {
      database.exec(
        "DROP TABLE member_grant; DROP TABLE created_drive; UPDATE job SET schema_version=4",
      );
    } finally {
      database.close();
    }
    reopen(h);
    assert.equal((await execute(h)).outcome, "completed");
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.planDigest, digest);
    assert.equal(status.mappingPasses[0]?.status, "completed");
    assert.equal((await verify(h)).clean, true);
  });

  it("upgrades schema 6 ownership without losing approval or inventing detached metadata", async (t) => {
    const h = await harness(t);
    const digest = await approve(h);
    const database = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
    try {
      database.exec(
        "DROP TABLE control_request; ALTER TABLE lease DROP COLUMN detached; ALTER TABLE lease DROP COLUMN log_path; UPDATE job SET schema_version=6",
      );
    } finally {
      database.close();
    }
    reopen(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.schemaVersion, 7);
    assert.equal(status.planDigest, digest);
    assert.equal(status.ownership.detached, false);
    assert.equal(status.ownership.logPath, null);
    assert.equal((await execute(h)).outcome, "completed");
  });

  it("closes an already-verified legacy plan whose approved inputs retain retired fields", async (t) => {
    const h = await harness(t);
    await approve(h);
    await execute(h);
    assert.equal((await verify(h)).clean, true);
    const before = value(await h.engine.reader(h.ref).status());
    // Restore the configuration/identity encoding persisted before ADR-0009.
    // This is a verified historical job, not a request to replay its transfers.
    const database = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
    try {
      const inputs = Object.fromEntries(
        database
          .prepare("SELECT key,value FROM plan_input WHERE rev=1")
          .all()
          .map((row) => [String(row.key), String(row.value)]),
      );
      inputs.configuration = canonicalJson({
        ...JSON.parse(inputs.configuration!),
        guarantees: "default",
      });
      inputs.identity = canonicalJson({
        ...JSON.parse(inputs.identity!),
        qualificationDigest: "a".repeat(64),
        qualificationTuple: { route: "sharepoint_library_to_shared_drive" },
      });
      for (const [key, value] of Object.entries(inputs))
        database.prepare("UPDATE plan_input SET value=? WHERE rev=1 AND key=?").run(value, key);
      database
        .prepare("UPDATE plan_revision SET inputs_digest=? WHERE rev=1")
        .run(digestJson(inputs));
    } finally {
      database.close();
    }
    reopen(h);
    const closed = value(
      await h.engine.withWriterResult(h.ref, async (writer) =>
        writer.close(await closeDecision(h)),
      ),
    );
    assert.equal(closed.state, "closed");
    const after = value(await h.engine.reader(h.ref).status());
    assert.equal(after.planDigest, before.planDigest);
    assert.equal(after.verificationDigest, before.verificationDigest);
    assert.deepEqual(after.mappingPasses, before.mappingPasses);
  });

  it("keeps pre-map approvals readable but refuses lifecycle mutation", async (t) => {
    // The immutable plan and approval were written by cbaa5a3, before manifest support.
    const legacy: {
      plan: Record<string, string | number>;
      inputs: Array<{ key: string; value: string }>;
      approval: Record<string, string | number>;
    } = JSON.parse(
      await readFile(new URL("./fixtures/pre-manifest-approved.json", import.meta.url), "utf8"),
    );
    for (const state of ["approved", "interrupted"]) {
      const h = await harness(t);
      // Collect matching source evidence, but never approve with the current engine.
      value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
      const database = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
      try {
        // Reconstruct the old row shape as well as the old immutable approval.
        database.exec("UPDATE item SET payload=json_remove(payload,'$.fileScope')");
        database.exec(
          "DELETE FROM plan_input; DELETE FROM plan_revision; DROP TABLE mapping; DROP TABLE mapping_manifest; DROP TABLE member_grant; DROP TABLE created_drive",
        );
        for (const [table, row] of [
          ["plan_revision", legacy.plan],
          ["approval", legacy.approval],
        ] as const) {
          const keys = Object.keys(row);
          database
            .prepare(
              `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
            )
            .run(...Object.values(row));
        }
        for (const input of legacy.inputs)
          database
            .prepare("INSERT INTO plan_input (rev,key,value) VALUES (1,?,?)")
            .run(input.key, input.value);
        database.prepare("UPDATE job SET schema_version=3,state=?").run(state);
      } finally {
        database.close();
      }
      await writeFile(join(h.home, "jobs", h.ref.id, "job.toml"), stringifyToml(config()));
      reopen(h);
      const configPath = join(h.home, "jobs", h.ref.id, "job.toml");
      await writeFile(
        configPath,
        stringifyToml({ ...config(), options: { verificationMode: "size_only" } }),
      );
      refused(
        await h.engine.withWriterResult(h.ref, (writer) => writer.execute()),
        "state_version_unsupported",
      );
      const completed = value(await h.engine.reader(h.ref).status());
      assert.equal(completed.planDigest, legacy.plan.plan_digest);
      refused(
        await h.engine.withWriterResult(h.ref, (writer) => writer.plan()),
        "state_version_unsupported",
      );
      refused(
        await h.engine.withWriterResult(h.ref, (writer) => writer.cancel("retire")),
        "state_version_unsupported",
      );
      const report = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
      const evidence = JSON.parse(
        await readFile(report.artifacts.find((item) => item.name === "report.json")!.path, "utf8"),
      );
      assert.equal(evidence.plan.planDigest, legacy.plan.plan_digest);
    }
  });

  it("moves legacy config mapping roots into the store on writer open", async (t) => {
    const selected = config();
    const h = await harness(t, fixture(), selected);
    const directory = join(h.home, "jobs", h.ref.id);
    const database = new DatabaseSync(join(directory, "state.db"));
    try {
      database.exec(
        "DROP TABLE mapping; DROP TABLE mapping_manifest; DROP TABLE member_grant; DROP TABLE created_drive; UPDATE job SET schema_version=3",
      );
    } finally {
      database.close();
    }
    await writeFile(join(directory, "job.toml"), stringifyToml(selected));
    reopen(h);
    await approve(h);
    const plan = value(await h.engine.reader(h.ref).rows({ phase: "plan", view: "mappings" }));
    const row = plan.rows[0];
    assert.equal(row?.jobType, "file_migration");
    if (row?.jobType !== "file_migration") throw new Error("Expected migrated mapping");
    assert.equal(row.mapping?.sourceItemId, selected.mappings[0]!.sourceItemId);
    assert.equal(
      "mappings" in parseToml(await readFile(join(directory, "job.toml"), "utf8")),
      false,
    );
    reopen(h);
    await execute(h);
    assert.equal(
      h.port.snapshotDestination().some((item) => item.name === "document.bin"),
      true,
    );
  });
});

function archiveFixture(): { fixture: FakeArchiveFixture; cursor: string } {
  const conversation = {
    id: "chat:chat-one",
    kind: "chat" as const,
    title: "Preserved conversation",
    scopeEntryId: "user-chats:user-one",
    participantScopeIds: ["user-chats:user-one"],
    ownerUserId: "user-one",
    raw: { id: "chat-one", chatType: "group" },
  };
  const empty = {
    ...conversation,
    id: "chat:empty",
    title: "Empty conversation",
    raw: { id: "empty", chatType: "group" },
  };
  const scope = {
    id: "user-chats:user-one",
    kind: "user-chats" as const,
    userId: "user-one",
    conversationIds: [conversation.id, empty.id],
  };
  const message = {
    id: "message-one",
    chatId: "chat-one",
    createdDateTime: "2026-02-01T00:00:00Z",
    lastModifiedDateTime: "2026-02-02T00:00:00Z",
    from: { user: { id: "user-one", displayName: "Original author" } },
    body: { contentType: "html", content: "<p>First preserved message</p>" },
    attachments: [],
    mentions: [],
  };
  const other = {
    ...message,
    id: "message-two",
    body: { contentType: "html", content: "<p>Second preserved message</p>" },
  };
  const transcript = {
    id: "transcript-one",
    createdDateTime: "2026-02-03T00:00:00Z",
    meetingId: "meeting-one",
    meetingOrganizer: { user: { id: "user-one", displayName: "Original organizer" } },
  };
  const cursor =
    "https://graph.microsoft.com/v1.0/users/user-one/chats/getAllMessages?$skiptoken=second";
  return {
    cursor,
    fixture: {
      scopes: [scope],
      conversations: [conversation, empty],
      checks: [
        { id: "scripted-archive", title: "Explicit archive fixture", status: "pass", evidence: {} },
      ],
      pages: [
        {
          scopeId: scope.id,
          route: "messages",
          cursor: null,
          page: { records: [message], nextLink: cursor },
        },
        {
          scopeId: scope.id,
          route: "messages",
          cursor,
          page: { records: [message, other], nextLink: null },
        },
        {
          scopeId: scope.id,
          route: "retained",
          cursor: null,
          page: { records: [message], nextLink: null },
        },
        {
          scopeId: scope.id,
          route: "transcripts",
          cursor: null,
          page: { records: [transcript], nextLink: null },
        },
      ],
      transcriptConversationIds: { "transcript-one": conversation.id },
      assets: [
        {
          conversationId: conversation.id,
          recordId: "message-one",
          route: "messages",
          kind: "hosted_content",
          id: "inline-one",
          name: "inline.png",
          content: new Uint8Array([1, 2, 3, 4]),
          chunkSize: 2,
        },
        {
          conversationId: conversation.id,
          recordId: "message-two",
          route: "messages",
          kind: "hosted_content",
          id: "inline-two",
          name: "same-inline.png",
          content: new Uint8Array([1, 2, 3, 4]),
        },
        {
          conversationId: conversation.id,
          recordId: "transcript-one",
          route: "transcripts",
          kind: "transcript",
          id: "transcript-one",
          name: "meeting.vtt",
          content: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nPreserved transcript\n",
        },
      ],
    },
  };
}

it("keeps archive scope and modification window frozen across a same-revision planning retry", async (t) => {
  const archive = archiveFixture();
  const h = await harness(
    t,
    { ...fileFixture(), archive: archive.fixture },
    {
      scopes: [{ kind: "user-chats", userId: "user-one" }],
      window: { from: "2026-01-01T00:00:00Z" },
      timezone: "UTC",
    },
    "teams_archive",
  );
  const port = h.port.archive!;
  const page = port.page.bind(port);
  let retry = true;
  port.page = async (input) => {
    if (retry) {
      retry = false;
      h.now = "2026-09-02T00:00:00.000Z";
      const added = { ...archive.fixture.conversations[0]!, id: "chat:after-checkpoint" };
      port.setExpansion(
        archive.fixture.scopes.map((scope) => ({
          ...scope,
          conversationIds: [...scope.conversationIds, added.id],
        })),
        [...archive.fixture.conversations, added],
      );
      throw Object.assign(new Error("Transient page failure"), { status: 503, retryAfterMs: 0 });
    }
    return page(input);
  };
  const plan = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
  const review = value(
    await h.engine.reader(h.ref).rows({
      phase: "plan",
      codes: ["collected", "empty_conversation"],
    }),
  );
  assert.deepEqual(
    review.rows.map((row) => row.jobType === "teams_archive" && row.conversationId),
    ["chat:chat-one", "chat:empty"],
  );
  assert.ok(plan.disclosures.some((text) => text.includes(`, ${NOW})`)));
  value(
    await h.engine.withWriterResult(h.ref, (writer) =>
      writer.approve({
        planDigest: plan.planDigest,
        approver: "test",
        mode: "unattended",
      }),
    ),
  );
  await execute(h);
  const manifest: PackageManifest = JSON.parse(
    await readFile(join(h.home, "jobs", h.ref.id, "archive", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.plan.window.to, NOW);
  assert.deepEqual(
    manifest.conversations.map((entry) => entry.id),
    ["chat:chat-one", "chat:empty"],
  );
});

it("durably resumes archive pages and partial assets, deduplicates current/retained records, and verifies offline", async (t) => {
  const archive = archiveFixture();
  const input = fixture();
  input.archive = archive.fixture;
  input.effects = [
    {
      method: "startTransferWorker",
      count: 1,
      error: new Error("Archive must never start a transfer worker"),
    },
  ];
  const h = await harness(
    t,
    input,
    {
      scopes: [{ kind: "user-chats", userId: "user-one" }],
      cloud: "Global",
      retainedHistory: true,
      transcripts: true,
      attachmentBytes: true,
      timezone: "UTC",
      window: { from: "2026-01-01T00:00:00Z", to: NOW },
    },
    "teams_archive",
  );
  await approve(h);
  const effects = h.port.archive;
  assert.ok(effects);
  effects.scriptEffect({
    method: "openAsset",
    objectId: "inline-one",
    count: 1,
    afterChunks: 1,
    error: Object.assign(new Error("Transient asset stream failure"), {
      status: 503,
      transient: true,
      retryAfterMs: 0,
    }),
  });
  effects.failPageOnce(
    { scopeId: "user-chats:user-one", route: "messages", cursor: archive.cursor },
    Object.assign(new Error("Interrupted at the next page"), { name: "AbortError" }),
  );
  assert.equal((await execute(h)).outcome, "interrupted");
  const partial = value(await h.engine.reader(h.ref).rows({ phase: "execute" })).rows;
  const conversation = partial.find(
    (row) => row.jobType === "teams_archive" && row.conversationId === "chat:chat-one",
  );
  assert.ok(conversation?.jobType === "teams_archive");
  assert.equal(conversation.records, 1);
  assert.equal(conversation.assets, 1);
  reopen(h);
  assert.equal((await execute(h)).outcome, "completed");
  const root = join(h.home, "jobs", h.ref.id, "archive");
  const manifest: PackageManifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.recordCount, 3);
  assert.equal(manifest.assetCount, 2);
  assert.deepEqual(
    manifest.conversations
      .map((entry) => ({ id: entry.id, records: entry.recordCount }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "chat:chat-one", records: 3 },
      { id: "chat:empty", records: 0 },
    ],
  );
  const retained = manifest.collection.filter((page) => page.route === "retained");
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.complete, true);
  assert.deepEqual(retained[0]?.recordKeys, []);
  const descriptor = manifest.conversations.find((entry) => entry.id === "chat:chat-one");
  assert.ok(descriptor);
  const detail: ConversationManifest = JSON.parse(
    await readFile(join(root, descriptor.manifest.path), "utf8"),
  );
  const raw: Array<{ id: string }> = [];
  for (const part of detail.parts) {
    raw.push(
      ...(await readFile(join(root, part.jsonl.path), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  }
  assert.deepEqual(raw.map((record) => record.id).sort(), [
    "message-one",
    "message-two",
    "transcript-one",
  ]);
  const storedInline = detail.assets.find(
    (asset) => asset.sha256 === hash(new Uint8Array([1, 2, 3, 4])),
  );
  assert.ok(storedInline);
  assert.deepEqual(await readFile(join(root, storedInline.path)), Buffer.from([1, 2, 3, 4]));
  assert.equal(storedInline.references.length, 2);
  effects.setAvailable(false);
  h.port.setApplicationIdentity("credentials-no-longer-available");
  reopen(h);
  const verified = await verify(h);
  assert.equal(verified.clean, true);
  assert.deepEqual(verified.findings, []);
  assert.deepEqual(
    h.port.snapshotDestination().map((entry) => entry.path),
    ["."],
  );
});

describe("durable local decision attestations", () => {
  it("retains bounded exception groups and interactive identity without inheriting unattended declarations", async (t) => {
    const h = await harness(t);
    const firstPlan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.approve({
          planDigest: firstPlan.planDigest,
          approver: "reviewer@host",
          mode: "interactive",
        }),
      ),
    );
    await execute(h);
    corruptDestination(h);
    const first = await verify(h);
    const grouped = value(await h.engine.reader(h.ref).status()).exceptionGroups!;
    assert.deepEqual(
      grouped.map(({ code, count, acceptable, accepted }) => ({
        code,
        count,
        acceptable,
        accepted,
      })),
      [{ code: "size_mismatch", count: 1, acceptable: true, accepted: false }],
    );
    assert.ok(grouped[0]!.consequence.includes("sizes differ"));
    assert.equal(grouped[0]!.examples.length, 1);
    refused(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.accept({
          verificationDigest: first.verificationDigest,
          codes: ["size_mismatch"],
          rationale: "  ",
          approver: "unrecorded@host",
          mode: "interactive",
        }),
      ),
      "verification_unaccepted",
    );
    assert.equal(
      value(await h.engine.reader(h.ref).status()).lastInteractiveIdentity,
      "reviewer@host",
    );
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.accept({
          verificationDigest: first.verificationDigest,
          codes: ["size_mismatch"],
          rationale: "  Reviewed the destination size difference  ",
          approver: "exception-owner@host",
          mode: "interactive",
        }),
      ),
    );
    const accepted = value(await h.engine.reader(h.ref).status()).acceptedExceptions!;
    assert.equal(accepted[0]?.note, "Reviewed the destination size difference");
    assert.equal(accepted[0]?.mode, "interactive");
    assert.equal(accepted[0]?.identityAssurance, "declared_unverified");
    const next = await verify(h);
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.accept({
          verificationDigest: next.verificationDigest,
          codes: ["size_mismatch"],
          rationale: "Automated exception policy",
          approver: "automation",
          mode: "unattended",
        }),
      ),
    );
    reopen(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.lastInteractiveIdentity, "exception-owner@host");
    assert.equal(status.acceptedExceptions?.[0]?.mode, "unattended");
    assert.equal(status.exceptionGroups?.[0]?.accepted, true);
    const staleDigest = status.closeReview!.evidenceDigest;
    value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
    refused(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.accept({
          verificationDigest: next.verificationDigest,
          codes: ["size_mismatch"],
          rationale: "Old evidence",
          approver: "stale@host",
          mode: "interactive",
        }),
      ),
      "verification_unaccepted",
    );
    assert.equal(value(await h.engine.reader(h.ref).status()).closeReview, null);
    assert.notEqual(staleDigest, "");
    assert.equal(
      value(await h.engine.reader(h.ref).status()).lastInteractiveIdentity,
      "exception-owner@host",
    );
  });

  for (const historicalIdentity of [null, "historical-reviewer@host"]) {
    it(`migrates legacy acceptance while preserving ${historicalIdentity ?? "no interactive identity"}`, async (t) => {
      const h = await harness(t);
      if (historicalIdentity) {
        for (const approver of ["earlier-reviewer@host", historicalIdentity]) {
          const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
          value(
            await h.engine.withWriterResult(h.ref, (w) =>
              w.approve({ planDigest: plan.planDigest, approver, mode: "interactive" }),
            ),
          );
        }
      }
      await approve(h);
      await execute(h);
      corruptDestination(h);
      const verification = await verify(h);
      value(
        await h.engine.withWriterResult(h.ref, (w) =>
          w.accept({
            verificationDigest: verification.verificationDigest,
            codes: ["size_mismatch"],
            rationale: "Historical exception",
            approver: "historical-operator",
            mode: "unattended",
          }),
        ),
      );
      h.engine.close();
      const db = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
      try {
        db.exec(
          "ALTER TABLE acceptance DROP COLUMN mode; DROP TABLE decision_evidence; UPDATE job SET schema_version=5",
        );
      } finally {
        db.close();
      }
      reopen(h);
      const status = value(await h.engine.reader(h.ref).status());
      assert.equal(status.acceptedExceptions?.[0]?.mode, "legacy_unknown");
      assert.equal(status.acceptedExceptions?.[0]?.identityAssurance, "declared_unverified");
      assert.equal(status.lastInteractiveIdentity, historicalIdentity);
      assert.equal(status.closeAuthorization, null);
      refused(await h.engine.withWriterResult(h.ref, (w) => w.close()), "approval_required");
      const next = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
      value(
        await h.engine.withWriterResult(h.ref, (w) =>
          w.approve({
            planDigest: next.planDigest,
            approver: "current-reviewer@host",
            mode: "interactive",
          }),
        ),
      );
      await approve(h);
      reopen(h);
      assert.equal(
        value(await h.engine.reader(h.ref).status()).lastInteractiveIdentity,
        "current-reviewer@host",
      );
    });
  }
});
