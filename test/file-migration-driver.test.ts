import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { parse } from "csv-parse/sync";
import { openEngine, type Engine, type JobRef } from "../src/engine/index.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import {
  fileMigrationDriver,
  type FileMigrationConfig,
} from "../src/engine/drivers/file-migration.ts";
import type { DriverContext, CommitUnit } from "../src/engine/drivers/types.ts";
import { ProviderFault } from "../src/engine/providers/fault.ts";
import { fileConfig, fileFixture, value, approve, closeDecision } from "./engine-fixture.ts";

const now = "2026-09-01T00:00:00.000Z";
const config = fileConfig();

function fixture(): FakeFileMigrationFixture {
  return fileFixture([
    { id: "folder", parentId: "source-root", name: "nested", kind: "folder" },
    { id: "empty", parentId: "folder", name: "empty", kind: "folder" },
    {
      id: "zero",
      parentId: "folder",
      name: "zero.bin",
      kind: "file",
      content: "",
      mimeType: "application/octet-stream",
    },
    {
      id: "binary",
      parentId: "source-root",
      name: "report.docx",
      kind: "file",
      content: new Uint8Array([0, 255, 5, 0]),
      createdAt: "2020-01-01T01:02:03.000Z",
      modifiedAt: "2024-05-06T07:08:09.000Z",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ]);
}

async function harness(
  t: TestContext,
  input: FakeFileMigrationFixture = fixture(),
  selected: FileMigrationConfig = config,
  port: FakeFileMigrationPort = new FakeFileMigrationPort(input),
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "migmate-file-contract-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const engine = openEngine({ home, now: () => new Date(now), provider: port });
  const ref = value(await engine.initJob({ type: "file_migration", config: selected }));
  return { home, engine, ref, port };
}

interface Harness {
  home: string;
  engine: Engine;
  ref: JobRef;
  port: FakeFileMigrationPort;
}

async function execute(h: Harness): Promise<void> {
  value(value(await h.engine.withWriter(h.ref, (writer) => writer.execute())));
}

async function codes(
  h: Harness,
  phase: "plan" | "execute" | "verify",
): Promise<Map<string, string>> {
  const page = value(await h.engine.reader(h.ref).rows({ phase, limit: 1000 }));
  return new Map(
    page.rows
      .filter((item) => item.jobType === "file_migration")
      .map((item) => [item.sourceItemId, item.code]),
  );
}

function hash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("staged cutover lifecycle", () => {
  it("copies current source content without an inventory freshness gate", async (t) => {
    const h = await harness(t, fixture(), { ...config, options: { staged: true } });
    await approve(h);
    h.port.mutateSourceItem("binary", { content: "a newer version" });
    await execute(h);
    assert.equal(
      h.port.snapshotDestination().find((item) => item.path === "report.docx")?.checksum,
      hash("a newer version"),
    );
  });
  it("keeps prestage open and binds final intent and freeze to the latest approval", async (t) => {
    const h = await harness(t, fixture(), {
      ...config,
      options: { staged: true, consistencyIntervalMs: 0 },
    });
    await approve(h);
    await execute(h);
    assert.equal(value(await h.engine.reader(h.ref).status()).currentPlan?.stage, "prestage");
    const early = await h.engine.withWriterResult(h.ref, async (writer) =>
      writer.close(await closeDecision(h)),
    );
    assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.refusal.code, "cutover_incomplete");
    const final = value(
      await h.engine.withWriterResult(h.ref, (writer) => writer.plan({ final: true })),
    );
    assert.equal(final.stage, "final");
    const freeze = { by: "operator@example.com", at: now, how: "Editors locked out at source" };
    const approval = value(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.approve({
          approver: "operator@example.com",
          mode: "unattended",
          planDigest: final.planDigest,
          freeze,
        }),
      ),
    );
    assert.deepEqual(approval.freeze, freeze);
    await execute(h);
    const next = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    assert.equal(next.stage, "delta");
    const stale = await h.engine.withWriterResult(h.ref, async (writer) =>
      writer.close(await closeDecision(h)),
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.refusal.code, "cutover_incomplete");
  });
  it("labels ordinary revisions prestage until an execution completes", async (t) => {
    const h = await harness(t, fixture(), {
      ...config,
      options: { staged: true, consistencyIntervalMs: 0 },
    });
    const plan = async () =>
      value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan())).stage;
    assert.equal(await plan(), "prestage");
    assert.equal(await plan(), "prestage");
    await approve(h);
    const interrupted = await h.engine.withWriterResult(h.ref, (writer) =>
      writer.execute({ signal: AbortSignal.abort() }),
    );
    assert.equal(value(interrupted).outcome, "interrupted");
    assert.equal(await plan(), "prestage");
    await approve(h);
    await execute(h);
    assert.equal(await plan(), "delta");
  });
});

describe("map-only listing migration", () => {
  const rclone = { consistencyIntervalMs: 0 };

  it("copies, verifies and closes from a map-only plan without a per-file source inventory", async (t) => {
    const h = await harness(t, fixture(), { ...config, options: rclone });
    await approve(h);
    assert.deepEqual([...(await codes(h, "plan")).keys()], ["source-root"]);
    await execute(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.state, "verified");
    assert.deepEqual(status.outstandingFindings, []);
    const verified = await codes(h, "verify");
    assert.equal(verified.get("binary"), "unchanged");
    assert.equal(verified.get("zero"), "unchanged");
    assert.deepEqual(
      h.port
        .snapshotDestination()
        .map((item) => item.path)
        .sort(),
      [".", "nested", "nested/empty", "nested/zero.bin", "report.docx"],
    );
    assert.deepEqual(
      h.port.calls.filter((call) => /^(listSourceChildren|openSourceContent):/u.test(call)),
      [],
    );
    assert.equal(
      value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))))
        .outcome,
      "completed",
    );
  });

  it("finds missing and resized destination files and folders from listings", async (t) => {
    const h = await harness(t, fixture(), { ...config, options: rclone });
    await approve(h);
    await execute(h);
    const copied = new Map(h.port.snapshotDestination().map((item) => [item.path, item.id]));
    h.port.mutateDestinationContent(copied.get("report.docx")!, "a longer replacement");
    h.port.removeDestinationItem(copied.get("nested/zero.bin")!);
    h.port.removeDestinationItem(copied.get("nested/empty")!);
    const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verified.clean, false);
    const page = value(await h.engine.reader(h.ref).rows({ phase: "verify", limit: 100 }));
    assert.deepEqual(
      page.rows
        .filter((item) => item.jobType === "file_migration" && item.kind === "finding")
        .map((item) => (item.jobType === "file_migration" ? [item.relativePath, item.code] : []))
        .sort(),
      [
        ["nested/empty", "destination_missing"],
        ["nested/zero.bin", "destination_missing"],
        ["report.docx", "size_mismatch"],
      ],
    );
    const refused = await h.engine.withWriterResult(h.ref, async (w) =>
      w.close(await closeDecision(h)),
    );
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.refusal.code, "verification_unaccepted");
  });

  it("records mirror deletions before each pass and refuses more than deleteLimit", async (t) => {
    const h = await provisioningHarness(
      t,
      fileFixture(
        ["a", "b", "c"].map((id) => ({
          id,
          parentId: "source-root",
          name: `${id}.txt`,
          kind: "file" as const,
          content: id,
        })),
      ),
      { ...rclone, mirror: true, deleteLimit: 1 },
    );
    await execute(h);
    const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
    const names = async () =>
      (await h.port.listDestinationChildren(driveId)).map((item) => item.name).sort();
    assert.deepEqual(await names(), ["a.txt", "b.txt", "c.txt"]);
    await approve(h);
    h.port.deleteSourceItem("a");
    const planned = value(await h.engine.reader(h.ref).rows({ phase: "plan" })).rows;
    assert.equal(planned.length, 1);
    assert.ok(planned[0]?.jobType === "file_migration");
    await execute(h);
    const deletions = value(await h.engine.reader(h.ref).rows({ phase: "execute", limit: 100 }));
    assert.deepEqual(
      deletions.rows.map((item) =>
        item.jobType === "file_migration" ? [item.relativePath, item.code] : [],
      ),
      [["a.txt", "to_be_deleted"]],
    );
    assert.deepEqual(await names(), ["b.txt", "c.txt"]);
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).outstandingFindings, []);
    h.port.deleteSourceItem("b");
    h.port.deleteSourceItem("c");
    await approve(h);
    const refused = await h.engine.withWriterResult(h.ref, (w) => w.execute());
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.refusal.code, "plan_revision_required");
    assert.deepEqual(await names(), ["b.txt", "c.txt"]);
  });

  it("settles a staged final pass by listing and goes live at close", async (t) => {
    const h = await provisioningHarness(t, fixture(), { ...rclone, staged: true });
    await execute(h);
    h.port.mutateSourceItem("binary", { content: "edited before the freeze" });
    const final = value(await h.engine.withWriterResult(h.ref, (w) => w.plan({ final: true })));
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.approve({
          approver: "operator@example.com",
          mode: "unattended",
          planDigest: final.planDigest,
          freeze: { by: "operator@example.com", at: now, how: "Editors locked out at source" },
        }),
      ),
    );
    await execute(h);
    const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
    const settled = JSON.parse(
      await readFile(report.artifacts.find((item) => item.name === "report.json")!.path, "utf8"),
    ).sections.find((section: { title: string }) => section.title === "Settled confirmation");
    assert.equal(JSON.parse(settled.body)[0].outcome, "settled");
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    const closed = value(await h.engine.reader(h.ref).status());
    assert.equal(closed.state, "closed");
    assert.equal(closed.memberGrants[0]?.member.email, "finance@example.com");
  });

  it("catches up a source folder that appears while the final pass settles", async (t) => {
    const input = fixture();
    input.sourceItems.push({ id: "late", parentId: "source-root", name: "late", kind: "folder" });
    const h = await provisioningHarness(t, input, { ...rclone, staged: true });
    const visible = h.port
      .snapshotSource()
      .filter((item) => item.parentId === "source-root")
      .map((item) => item.id);
    h.port.overrideSourceChildren(
      "source-root",
      visible.filter((id) => id !== "late"),
    );
    await execute(h);
    const final = value(await h.engine.withWriterResult(h.ref, (w) => w.plan({ final: true })));
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.approve({
          approver: "operator@example.com",
          mode: "unattended",
          planDigest: final.planDigest,
          freeze: { by: "operator@example.com", at: now, how: "Editors locked out at source" },
        }),
      ),
    );
    h.engine.close();
    h.engine = openEngine({
      home: h.home,
      now: () => new Date(now),
      provider: h.port,
      // An empty folder becomes visible only after the first final pass.
      waitForConsistency: async () => h.port.overrideSourceChildren("source-root", visible),
    });
    await execute(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.state, "verified");
    assert.deepEqual(status.outstandingFindings, []);
    const driveId = status.createdDrives[0]!.driveId!;
    assert.ok((await h.port.listDestinationChildren(driveId)).some((item) => item.name === "late"));
  });

  for (const reverse of [false, true]) {
    async function routeHarness(
      t: TestContext,
      input = fixture(),
      options?: FileMigrationConfig["options"],
    ) {
      const h = await harness(t, input, {
        ...(reverse
          ? {
              sourceProvider: "google_shared_drive",
              destinationProvider: "sharepoint",
              mappings: [],
            }
          : config),
        ...(options ? { options } : {}),
      });
      if (reverse) {
        value(
          await h.engine.withWriterResult(h.ref, (w) =>
            w.loadManifest({
              format: "json",
              content: JSON.stringify({
                version: 1,
                mappings: [
                  {
                    id: "mapping",
                    source: {
                      type: "google_shared_drive",
                      driveId: "source-drive",
                      folderId: "source-root",
                    },
                    destination: {
                      type: "sharepoint",
                      driveId: "destination-drive",
                      folderPath: "",
                    },
                  },
                ],
              }),
            }),
          ),
        );
      }
      return h;
    }

    it(`approves only roots and verifies whole listings without downloads (${reverse ? "reverse" : "forward"})`, async (t) => {
      const h = await routeHarness(t);
      const inventory = t.mock.method(h.port, "listSourceChildren", async () => {
        throw new Error("Map-only migration must not inventory source children");
      });
      const hashes = t.mock.method(h.port, "listFileHashes");
      await approve(h);
      assert.equal(hashes.mock.callCount(), 0);
      const planned = value(await h.engine.reader(h.ref).rows({ phase: "plan" })).rows;
      assert.equal(planned.length, 1);
      assert.ok(planned[0]?.jobType === "file_migration");
      h.port.mutateSourceItem("binary", { name: "plain.bin" });
      await execute(h);
      const copied = h.port.snapshotDestination().find((item) => item.path === "plain.bin")!;
      // Same-size corruption is deliberately outside listing verification.
      h.port.mutateDestinationContent(copied.id, new Uint8Array([1, 1, 1, 1]));
      const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
      assert.equal(verified.clean, true);
      assert.deepEqual(verified.findings, []);
      assert.equal(inventory.mock.callCount(), 0);
      assert.ok(hashes.mock.calls.every((call) => !call.arguments[0].download));
    });

    it(`finds listing size differences and missing files and folders (${reverse ? "reverse" : "forward"})`, async (t) => {
      const h = await routeHarness(t);
      await approve(h);
      await execute(h);
      const copied = new Map(h.port.snapshotDestination().map((item) => [item.path, item.id]));
      h.port.mutateDestinationContent(copied.get("report.docx")!, "longer Office content");
      h.port.removeDestinationItem(copied.get("nested/empty")!);
      h.port.removeDestinationItem(copied.get("nested/zero.bin")!);
      const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
      assert.deepEqual(
        verified.findings.map(({ code, count }) => ({ code, count })),
        [
          { code: "destination_missing", count: 2 },
          { code: reverse ? "destination_rewrote_file" : "size_mismatch", count: 1 },
        ],
      );
    });

    it(`keeps hash corruption and unavailable stored hashes blocking (${reverse ? "reverse" : "forward"})`, async (t) => {
      const input = fixture();
      input.sourceItems.find((item) => item.id === "binary")!.name = "plain.bin";
      const h = await routeHarness(t, input, { verificationMode: "hash" });
      await approve(h);
      await execute(h);
      const copied = h.port.snapshotDestination().find((item) => item.path === "plain.bin")!;
      h.port.mutateDestinationContent(copied.id, new Uint8Array([1, 1, 1, 1]));
      let verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
      assert.deepEqual(
        verified.findings.map((finding) => finding.code),
        ["content_mismatch"],
      );
      const list = h.port.listFileHashes.bind(h.port);
      t.mock.method(
        h.port,
        "listFileHashes",
        async (input: Parameters<FakeFileMigrationPort["listFileHashes"]>[0]) => {
          const entries = await list(input);
          return input.root.fs === "destination-root"
            ? entries.map((entry) =>
                entry.path === "plain.bin" ? { ...entry, hash: null } : entry,
              )
            : entries;
        },
      );
      verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
      assert.deepEqual(
        verified.findings.map((finding) => finding.code),
        ["destination_read_failed"],
      );
    });

    it(`settles newly visible folders by listing without changing approval (${reverse ? "reverse" : "forward"})`, async (t) => {
      const input = fixture();
      input.sourceItems.push({ id: "late", parentId: "source-root", name: "late", kind: "folder" });
      const h = await routeHarness(t, input, { staged: true, consistencyIntervalMs: 0 });
      const visible = ["folder", "binary", "late"];
      h.port.overrideSourceChildren("source-root", ["folder", "binary"]);
      await approve(h);
      await execute(h);
      const final = value(await h.engine.withWriterResult(h.ref, (w) => w.plan({ final: true })));
      value(
        await h.engine.withWriterResult(h.ref, (w) =>
          w.approve({
            approver: "operator",
            mode: "unattended",
            planDigest: final.planDigest,
            freeze: { by: "operator", at: now, how: "writers stopped" },
          }),
        ),
      );
      h.engine.close();
      h.engine = openEngine({
        home: h.home,
        now: () => new Date(now),
        provider: h.port,
        waitForConsistency: async () => h.port.overrideSourceChildren("source-root", visible),
      });
      await execute(h);
      const status = value(await h.engine.reader(h.ref).status());
      assert.equal(status.state, "verified");
      assert.equal(status.planDigest, final.planDigest);
      assert.ok(h.port.snapshotDestination().some((item) => item.path === "late"));
      assert.deepEqual(status.outstandingFindings, []);
    });

    it(`verifies unchanged paths again on every delta (${reverse ? "reverse" : "forward"})`, async (t) => {
      const h = await routeHarness(t, fixture(), { staged: true, consistencyIntervalMs: 0 });
      await approve(h);
      await execute(h);
      h.port.mutateSourceItem("binary", { content: "new delta bytes" });
      await approve(h);
      await execute(h);
      const unchanged = h.port
        .snapshotDestination()
        .find((item) => item.path === "nested/zero.bin")!;
      h.port.mutateDestinationContent(unchanged.id, "independent damage");
      const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
      assert.deepEqual(
        verified.findings.map((finding) => finding.code),
        ["size_mismatch"],
      );
      assert.equal((await codes(h, "verify")).get("zero"), "size_mismatch");
    });
  }
});

describe("destination folder verification", () => {
  for (const reverse of [false, true]) {
    for (const conflict of [false, true]) {
      it(`blocks ${conflict ? "a file at" : "a missing"} empty folder (${reverse ? "SharePoint" : "Shared Drive"})`, async (t) => {
        const h = await harness(
          t,
          fixture(),
          reverse
            ? {
                sourceProvider: "google_shared_drive",
                destinationProvider: "sharepoint",
                mappings: [],
              }
            : config,
        );
        if (reverse)
          value(
            await h.engine.withWriterResult(h.ref, (writer) =>
              writer.loadManifest({
                format: "json",
                content: JSON.stringify({
                  version: 1,
                  mappings: [
                    {
                      id: "mapping",
                      source: {
                        type: "google_shared_drive",
                        driveId: "source-drive",
                        folderId: "source-root",
                      },
                      destination: {
                        type: "sharepoint",
                        driveId: "destination-drive",
                        folderPath: "",
                      },
                    },
                  ],
                }),
              }),
            ),
          );
        await approve(h);
        await execute(h);
        const empty = h.port.snapshotDestination().find((entry) => entry.path === "nested/empty")!;
        h.port.removeDestinationItem(empty.id);
        if (conflict)
          await h.port.uploadDestinationContent({
            parentFolderId: empty.parentId!,
            name: empty.name,
            content: new Uint8Array(),
            createdAt: now,
            modifiedAt: now,
            mimeType: "inode/directory",
          });
        const verified = value(await h.engine.withWriterResult(h.ref, (writer) => writer.verify()));
        assert.equal(verified.clean, false);
        const code = conflict ? "destination_type_conflict" : "destination_missing";
        assert.deepEqual(
          verified.findings.map((entry) => entry.code),
          [code],
        );
        assert.deepEqual(
          value(
            await h.engine.reader(h.ref).rows({
              phase: "verify",
              codes: ["destination_only_retained"],
            }),
          ).rows,
          [],
        );
        const report = value(await h.engine.withWriterResult(h.ref, (writer) => writer.report()));
        const json = JSON.parse(
          await readFile(
            report.artifacts.find((artifact) => artifact.name === "report.json")!.path,
            "utf8",
          ),
        );
        const evidence = json.findings.find(
          (entry: { code: string }) => entry.code === code,
        ).evidence;
        assert.deepEqual(
          evidence,
          conflict
            ? {
                path: "nested/empty",
                // rclone lists SharePoint objects as `driveId#itemId`.
                destinationId: `${reverse ? "destination-drive#" : ""}${
                  h.port.snapshotDestination().find((entry) => entry.path === "nested/empty")!.id
                }`,
                destinationSize: 0,
                destinationHash: reverse ? "0000000000000000000000000000000000000000" : hash(""),
              }
            : { path: "nested/empty", itemType: "folder" },
        );
        const closed = await h.engine.withWriterResult(h.ref, async (writer) =>
          writer.close(await closeDecision(h)),
        );
        assert.equal(closed.ok, false);
        if (!closed.ok) assert.equal(closed.refusal.code, "verification_unaccepted");
      });
    }
  }
});

describe("Google Shared Drives to SharePoint", () => {
  const reverse: FileMigrationConfig = {
    mappings: [],
    sourceProvider: "google_shared_drive",
    destinationProvider: "sharepoint",
  };
  function reverseMapping(id: string, sourceDrive: string, sourceRoot: string, library: string) {
    return {
      id,
      source: { type: "google_shared_drive", driveId: sourceDrive, folderId: sourceRoot },
      destination: { type: "sharepoint", driveId: library, folderPath: "" },
    };
  }
  async function load(h: Harness, mappings: unknown[]) {
    return value(
      await h.engine.withWriter(h.ref, (writer) =>
        writer.loadManifest({ format: "json", content: JSON.stringify({ version: 1, mappings }) }),
      ),
    );
  }
  function withSecondDrive(): FakeFileMigrationFixture {
    const input = fixture();
    input.sourceItems.push({
      id: "second-root",
      driveId: "second-drive",
      parentId: null,
      name: "second",
      kind: "folder",
    });
    input.destinationItems.push({
      id: "second-destination",
      driveId: "second-library",
      parentId: null,
      name: "second",
      kind: "folder",
    });
    return input;
  }
  const both = [
    reverseMapping("first", "source-drive", "source-root", "destination-drive"),
    reverseMapping("second", "second-drive", "second-root", "second-library"),
  ];

  it("copies into SharePoint, verifies quickXorHash and names rewritten Office files", async (t) => {
    const h = await harness(t, fixture(), { ...reverse, options: { verificationMode: "hash" } });
    value(await load(h, [both[0]]));
    const plan = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    assert.ok(
      plan.sections
        .find((section) => section.title === "Acting Google account")
        ?.body.includes("service-account@example.com"),
    );
    await approve(h);
    await execute(h);
    assert.equal(
      value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify()))).clean,
      true,
    );
    // SharePoint's rewrite of an Office file changes its length as well as its bytes.
    const office = h.port.snapshotDestination().find((entry) => entry.path === "report.docx")!;
    h.port.mutateDestinationContent(office.id, new Uint8Array([1, 1, 1, 1, 1, 1]));
    await h.port.uploadDestinationContent({
      parentFolderId: "destination-root",
      name: "leftover.bin",
      content: new Uint8Array([1]),
      createdAt: now,
      modifiedAt: now,
      mimeType: null,
    });
    const verified = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.deepEqual(
      verified.findings.map((entry) => entry.code),
      ["destination_rewrote_file"],
    );
    const report = value(value(await h.engine.withWriter(h.ref, (writer) => writer.report())));
    const json = JSON.parse(
      await readFile(report.artifacts.find((a) => a.name === "report.json")!.path, "utf8"),
    );
    const evidence = (code: string) =>
      json.findings.find((finding: { code: string }) => finding.code === code).evidence;
    assert.deepEqual(evidence("destination_rewrote_file"), {
      path: "report.docx",
      sourceSize: 4,
      destinationSize: 6,
      hashType: "quickxor",
      sourceHash: "00f8470100000000000000000400000000000000",
      destinationHash: "0108400002108000000000000600000000000000",
    });
    assert.equal(evidence("destination_only_retained").hashType, "quickxor");
    assert.deepEqual(
      JSON.parse(
        json.sections.find((section: { title: string }) => section.title === "Provider pair").body,
      ),
      { sourceProvider: "google_shared_drive", destinationProvider: "sharepoint" },
    );
    assert.ok(
      json.sections
        .find((section: { title: string }) => section.title === "Acting Google account")
        ?.body.includes("service-account@example.com"),
    );
  });

  it("does not classify Google source errors as upload quota on the reverse route", async (t) => {
    const input = withSecondDrive();
    input.copyPasses = [
      {
        sourceRootId: "source-root",
        error: "googleapi: Error 403: User rate limit exceeded., userRateLimitExceeded",
      },
    ];
    const h = await harness(t, input, reverse);
    value(await load(h, both));
    await approve(h);
    const result = value(await h.engine.withWriterResult(h.ref, (writer) => writer.execute()));
    assert.equal(result.outcome, "blocked");
    assert.equal(result.uploadQuota, undefined);
    assert.equal(result.budget?.failedAttempts, 1);
    assert.deepEqual(
      value(await h.engine.reader(h.ref).status()).mappingPasses.map((pass) => [
        pass.mappingId,
        pass.status,
      ]),
      [
        ["first", "failed"],
        ["second", "completed"],
      ],
    );
  });

  it("keeps corrupted plain files as content_mismatch", async (t) => {
    const input = fixture();
    input.sourceItems.push({
      id: "plain",
      parentId: "source-root",
      name: "plain.txt",
      kind: "file",
      content: "original",
    });
    const h = await harness(t, input, { ...reverse, options: { verificationMode: "hash" } });
    value(await load(h, [both[0]]));
    await approve(h);
    await execute(h);
    const plain = h.port.snapshotDestination().find((entry) => entry.path === "plain.txt")!;
    h.port.mutateDestinationContent(plain.id, "corrupt!");
    h.port.blockDestinationStream(plain.id);
    const verified = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.deepEqual(
      verified.findings.map((entry) => entry.code),
      ["content_mismatch"],
    );
    const closed = value(
      await h.engine.withWriter(h.ref, async (writer) => writer.close(await closeDecision(h))),
    );
    assert.equal(closed.ok, false);
    if (closed.ok) throw new Error("Corruption must block close");
    assert.equal(closed.refusal.code, "verification_unaccepted");
  });

  it("manifest load names every source Shared Drive the acting account cannot read", async (t) => {
    const input = withSecondDrive();
    input.unreadableSourceDrives = ["source-drive", "second-drive"];
    const h = await harness(t, input, reverse);
    const loaded = await load(h, both);
    assert.equal(loaded.ok, false);
    if (loaded.ok) throw new Error("Unreadable source drives must refuse");
    assert.equal(loaded.refusal.code, "preflight_failed");
    assert.deepEqual(loaded.refusal.detail, {
      unreadableSourceDrives: ["source-drive", "second-drive"],
    });
  });

  it("preflight names source Shared Drives whose membership was revoked after load", async (t) => {
    const h = await harness(t, withSecondDrive(), reverse);
    value(await load(h, both));
    h.port.revokeSourceDriveAccess("second-drive");
    const result = value(await h.engine.withWriter(h.ref, (writer) => writer.plan()));
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Unreadable source drives must refuse");
    assert.equal(result.refusal.code, "preflight_failed");
    assert.match(
      JSON.stringify(result.refusal.detail),
      /"unreadableSourceDrives":\["second-drive"\]/,
    );
  });

  it("refuses mappings whose direction differs from the job route", async (t) => {
    const h = await harness(t, fixture(), reverse);
    const forward = {
      id: "forward",
      source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
      destination: {
        type: "google_shared_drive",
        driveId: "destination-drive",
        folderId: "destination-root",
      },
    };
    const mixed = await load(h, [both[0], forward]);
    assert.equal(mixed.ok, false);
    if (mixed.ok) throw new Error("A mixed manifest must refuse");
    assert.equal(mixed.refusal.code, "configuration_invalid");
    assert.deepEqual(mixed.refusal.detail, { row: 2, field: "source.type" });
    const forwardJob = await harness(t, fixture(), { mappings: [] });
    const backwards = await load(forwardJob, [both[0]]);
    assert.equal(backwards.ok, false);
    if (backwards.ok) throw new Error("A reverse mapping must refuse in a forward job");
    assert.deepEqual(backwards.refusal.detail, { row: 1, field: "source.type" });
  });
});

function multiMapping(ids = ["a", "b"]) {
  const input = fileFixture(
    ids.flatMap((id, index) => [
      { id, parentId: "source-root", name: id, kind: "folder" as const },
      {
        id: `${id}-file`,
        parentId: id,
        name: index === 0 ? "one.txt" : "two.txt",
        kind: "file" as const,
        content: index === 0 ? "one" : "two",
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
  return {
    input,
    selected: {
      mappings: ids.map((id) => ({
        id,
        sourceDriveId: "source-drive",
        sourceItemId: id,
        destDriveId: "destination-drive",
        destFolderId: `dest-${id}`,
      })),
    },
  };
}

async function provisioningHarness(
  t: TestContext,
  input = fixture(),
  options?: FileMigrationConfig["options"],
  mappingIds = ["finance"],
): Promise<Harness> {
  input.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
  input.now ??= () => new Date(now);
  const h = await harness(t, input, options ? { mappings: [], options } : config);
  value(
    await h.engine.withWriterResult(h.ref, (w) =>
      w.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: mappingIds.map((id) => ({
            id,
            source: {
              type: "sharepoint",
              driveId: "source-drive",
              folderPath: id === "finance" ? "" : id,
            },
            destination: { type: "google_shared_drive", create: id === "finance" ? "Finance" : id },
            members: [{ email: `${id}@example.com`, type: "group", role: "writer" }],
          })),
        }),
      }),
    ),
  );
  await approve(h);
  return h;
}

async function acknowledgeChecks(h: Harness, mappingIds?: string[]) {
  const review = value(await h.engine.reader(h.ref).status()).goLiveReview;
  assert.ok(review);
  return value(
    await h.engine.withWriterResult(h.ref, (writer) =>
      writer.acknowledgeGoLive({
        evidenceDigest: review.evidenceDigest,
        mappingIds: mappingIds ?? review.checks.map((check) => check.mappingId),
        rationale: "Reviewed the specific unresolved evidence and accept its consequences",
        approver: "recovery-operator@example.com",
        mode: "unattended",
      }),
    ),
  );
}

function editRecoveryState(h: Harness, sql: string): void {
  const database = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

function notebookFixture(): FakeFileMigrationFixture {
  return fileFixture([
    {
      id: "notebook",
      parentId: "source-root",
      name: "Notes",
      kind: "package",
      webUrl: "https://example.sharepoint.com/Notes",
      packageSections: 1,
    },
    {
      id: "section",
      parentId: "notebook",
      name: "Section.one",
      kind: "file",
      content: "section bytes",
    },
    {
      id: "toc",
      parentId: "notebook",
      name: "Open Notebook.onetoc2",
      kind: "file",
      content: "table of contents",
    },
  ]);
}

describe("OneNote section files", () => {
  it("copies notebook files, verifies their bytes, skips unchanged deltas and mirrors deleted sections", async (t) => {
    const h = await provisioningHarness(t, notebookFixture(), {
      verificationMode: "hash",
      mirror: true,
      deleteLimit: 1,
    });
    assert.deepEqual([...(await codes(h, "plan")).keys()], ["source-root"]);
    await execute(h);
    const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
    const notebook = (await h.port.listDestinationChildren(driveId)).find(
      (e) => e.name === "Notes",
    )!;
    assert.equal(notebook.kind, "folder");
    assert.deepEqual(
      (await h.port.listDestinationChildren(notebook.id)).map((e) => [e.name, e.kind]).sort(),
      [
        ["Open Notebook.onetoc2", "file"],
        ["Section.one", "file"],
      ],
    );
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal((await codes(h, "verify")).get("section"), "unchanged");
    const section = (await h.port.listDestinationChildren(notebook.id)).find(
      (e) => e.name === "Section.one",
    )!;
    h.port.mutateDestinationContent(section.id, "corrupt bytes");
    const corrupt = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.ok(corrupt.findings.some((f) => f.code === "content_mismatch"));
    h.port.mutateDestinationContent(section.id, "section bytes");
    await approve(h);
    await execute(h);
    assert.equal(
      value(await h.engine.reader(h.ref).status()).mappingPasses[0]?.lastStats?.files,
      0,
    );
    h.port.deleteSourceItem("section");
    await approve(h);
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.deepEqual(
      (await h.port.listDestinationChildren(notebook.id)).map((e) => e.name),
      ["Open Notebook.onetoc2"],
    );
  });

  it("reports a file where a copied notebook's folder belongs", async (t) => {
    const h = await provisioningHarness(t, notebookFixture());
    await execute(h);
    const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
    const notebook = (await h.port.listDestinationChildren(driveId)).find(
      (e) => e.name === "Notes",
    )!;
    // The 0.2.2 failure shape: a 0-byte `inode/directory` file instead of the folder.
    h.port.removeDestinationItem(notebook.id);
    await h.port.uploadDestinationContent({
      parentFolderId: driveId,
      name: "Notes",
      content: new Uint8Array(),
      createdAt: now,
      modifiedAt: now,
      mimeType: "inode/directory",
    });
    const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verified.clean, false);
    const conflicts = value(
      await h.engine.reader(h.ref).rows({ phase: "verify", codes: ["destination_type_conflict"] }),
    ).rows;
    assert.deepEqual(
      conflicts.map((row) => ("relativePath" in row ? row.relativePath : null)),
      ["Notes"],
    );
  });
});

describe("staged migration options (ADR-0012)", () => {
  it("strictly validates staged intent and member grant timing", async (t) => {
    const h = await harness(t);
    for (const [field, invalid] of [
      ["staged", ["yes", 1, null]],
      ["memberGrants", ["later", "after_copy", true, null]],
    ] as const)
      for (const value of invalid) {
        const result = await h.engine.initJob({
          type: "file_migration",
          config: { ...config, options: { [field]: value } },
        });
        assert.equal(result.ok, false);
        if (result.ok) throw new Error(`Invalid ${field} must refuse`);
        assert.equal(result.refusal.code, "configuration_invalid");
        assert.deepEqual(result.refusal.detail, { field: `options.${field}` });
      }
  });
});

describe("deferred member go-live", () => {
  it("keeps members isolated until close and records grants after verification", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    const executed = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(executed.memberGrants, []);
    const driveId = executed.createdDrives[0]!.driveId!;
    assert.equal((await h.port.listDriveMembers(driveId)).length, 1);
    const verification = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verification.clean, true);
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).memberGrants, []);
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    const closed = value(await h.engine.reader(h.ref).status());
    assert.equal(closed.state, "closed");
    assert.equal(closed.memberGrants[0]?.member.email, "finance@example.com");
    assert.ok(Date.parse(closed.memberGrants[0]!.at!) > Date.parse(verification.at));
    assert.equal((await h.port.listDriveMembers(driveId)).length, 2);
  });
  it("lets a staged job's early close neither fence nor grant, and goes live only after the final revision", async (t) => {
    // ADR-0012: the A1 finality gate runs before A6 go-live. A habitual close after
    // prestage must leave the drive unfenced and its members without access.
    const h = await provisioningHarness(t, fixture(), { staged: true, consistencyIntervalMs: 0 });
    await execute(h);
    const prestaged = value(await h.engine.reader(h.ref).status());
    assert.equal(prestaged.currentPlan?.stage, "prestage");
    const driveId = prestaged.createdDrives[0]!.driveId!;
    const early = await h.engine.withWriterResult(h.ref, async (w) =>
      w.close(await closeDecision(h)),
    );
    assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.refusal.code, "cutover_incomplete");
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).memberGrants, []);
    assert.equal((await h.port.listDriveMembers(driveId)).length, 1);
    // Not fenced: a delta still runs against the drive.
    await approve(h);
    await execute(h);
    const final = value(await h.engine.withWriterResult(h.ref, (w) => w.plan({ final: true })));
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.approve({
          approver: "operator@example.com",
          mode: "unattended",
          planDigest: final.planDigest,
          freeze: { by: "operator@example.com", at: now, how: "Editors locked out at source" },
        }),
      ),
    );
    await execute(h);
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).memberGrants, []);
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    const closed = value(await h.engine.reader(h.ref).status());
    assert.equal(closed.state, "closed");
    assert.equal(closed.memberGrants[0]?.member.email, "finance@example.com");
    const artifacts = value(await h.engine.reader(h.ref).artifacts());
    const mappings: Record<string, string>[] = parse(
      await readFile(
        artifacts.artifacts.find((artifact) => artifact.name === "mappings.csv")!.path,
        "utf8",
      ),
      { columns: true },
    );
    assert.equal(mappings[0]!.freeze_by, "operator@example.com");
    assert.equal(mappings[0]!.freeze_at, now);
    assert.equal(mappings[0]!.freeze_how, "Editors locked out at source");
    assert.deepEqual(JSON.parse(mappings[0]!.go_live_member_grants!), closed.memberGrants);
    assert.equal((await h.port.listDriveMembers(driveId)).length, 2);
  });
  for (const timing of ["before", "after"] as const)
    it(`fences copy before grants and resumes close after a ${timing}-grant crash`, async (t) => {
      const h = await provisioningHarness(t, fixture(), {
        memberGrants: "after_verification",
        mirror: true,
        deleteLimit: 3,
      });
      await execute(h);
      value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
      h.port.scriptEffect({
        method: "addDriveMember",
        timing,
        count: 1,
        error: new Error("grant crash"),
      });
      await assert.rejects(
        h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))),
        /grant crash/,
      );
      h.engine.close();
      h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
      const refused = await h.engine.withWriterResult(h.ref, (w) => w.execute());
      assert.equal(refused.ok, false);
      if (!refused.ok) assert.equal(refused.refusal.code, "go_live_started");
      const before = value(await h.engine.reader(h.ref).status()).mappingPasses;
      value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
      const closed = value(await h.engine.reader(h.ref).status());
      assert.equal(closed.state, "closed");
      assert.equal(closed.memberGrants.length, 1);
      assert.deepEqual(closed.mappingPasses, before);
    });
  it("discloses unfinished reporting after go-live across reopen and retries close without copying", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    const reviewed = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
    const originalSections = fileMigrationDriver.reportSections;
    t.mock.method(
      fileMigrationDriver,
      "reportSections",
      async function* (ctx: DriverContext<FileMigrationConfig>) {
        if (ctx.resume.createdDrives?.some((drive) => drive.goLive?.check?.status === "passed"))
          throw new Error("injected report serialization failure");
        yield* originalSections(ctx);
      },
    );
    await assert.rejects(
      h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))),
      /injected report serialization failure/,
    );
    h.engine.close();
    h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.state, "verified");
    assert.deepEqual(status.incompleteClose, {
      accessMayExist: true,
      transfersFenced: true,
      checksPassed: true,
      checksSettled: true,
      reporting: "unfinished",
      nextAction: "close",
    });
    assert.equal(status.memberGrants.length, 1);
    assert.ok(status.createdDrives.every((drive) => drive.goLive?.check?.status === "passed"));
    assert.deepEqual(value(await h.engine.reader(h.ref).artifacts()), reviewed);
    const refused = await h.engine.withWriterResult(h.ref, (w) => w.execute());
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.refusal.code, "go_live_started");
    const cancelled = await h.engine.withWriterResult(h.ref, (w) => w.cancel("report failed"));
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.refusal.code, "go_live_started");
    t.mock.restoreAll();
    const driveId = status.createdDrives[0]!.driveId!;
    await h.port.addDriveMember(driveId, {
      email: "new-editor@example.com",
      type: "user",
      role: "writer",
    });
    const edited = (await h.port.listDestinationChildren(driveId)).find(
      (item) => item.name === "report.docx",
    )!;
    h.port.mutateDestinationContent(edited.id, new Uint8Array([8, 8, 8, 8]));
    t.mock.method(h.port, "startTransferWorker", async () => {
      throw new Error("report-only recovery must not start a worker");
    });
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    const closed = value(await h.engine.reader(h.ref).status());
    assert.equal(closed.state, "closed");
    assert.equal(closed.incompleteClose, undefined);
    assert.deepEqual(closed.mappingPasses, status.mappingPasses);
    assert.deepEqual(
      closed.createdDrives.map((drive) => drive.goLive?.check),
      status.createdDrives.map((drive) => drive.goLive?.check),
    );
    assert.deepEqual(closed.closeAuthorization, status.closeAuthorization);
  });
  it("blocks post-grant membership drift without silently repairing access", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
    await h.port.addDriveMember(driveId, {
      email: "outside@example.com",
      type: "user",
      role: "writer",
    });
    const closing = await h.engine.withWriterResult(h.ref, async (w) =>
      w.close(await closeDecision(h)),
    );
    assert.equal(closing.ok, false);
    if (!closing.ok) {
      assert.equal(closing.refusal.code, "verification_unaccepted");
      assert.equal(closing.refusal.detail?.accessMayExist, true);
      assert.equal(closing.refusal.detail?.check, "drive_membership_mismatch");
    }
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.memberGrants[0]?.member.email, "finance@example.com");
    assert.equal(status.createdDrives[0]?.preGrantCheck?.check.status, "passed");
    const executeResult = await h.engine.withWriterResult(h.ref, (w) => w.execute());
    assert.equal(executeResult.ok, false);
    if (!executeResult.ok) assert.equal(executeResult.refusal.code, "go_live_started");
    const retry = await h.engine.withWriterResult(h.ref, (w) => w.close());
    assert.equal(retry.ok, false);
    assert.equal((await h.port.listDriveMembers(driveId)).length, 3);
    await acknowledgeChecks(h);
    const closure = value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
    assert.equal(closure.outcome, "completed_with_accepted_exceptions");
    assert.equal(
      value(await h.engine.reader(h.ref).status()).createdDrives[0]?.goLive?.check?.status,
      "failed",
    );
  });
  it("writes the final grant and check evidence before closing", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    const artifacts = value(await h.engine.reader(h.ref).artifacts());
    assert.ok(artifacts);
    const report = JSON.parse(
      await readFile(artifacts.artifacts.find((item) => item.name === "report.json")!.path, "utf8"),
    );
    const access = JSON.parse(
      report.sections.find(
        (section: { title: string }) => section.title === "Created Shared Drives and members",
      ).body,
    );
    assert.equal(access.grants[0].member.email, "finance@example.com");
    assert.equal(access.drives[0].goLive.check.status, "passed");
  });
  it("withholds access for blocking findings and grants only after explicit acceptance", async (t) => {
    const h = await provisioningHarness(t, fixture(), {
      memberGrants: "after_verification",
    });
    await execute(h);
    const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
    const damaged = (await h.port.listDestinationChildren(driveId)).find(
      (item) => item.name === "report.docx",
    )!;
    h.port.mutateDestinationContent(damaged.id, "explicitly accepted damaged file");
    const verification = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verification.clean, false);
    const refused = await h.engine.withWriterResult(h.ref, async (w) =>
      w.close(await closeDecision(h)),
    );
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.refusal.code, "verification_unaccepted");
    const before = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(before.memberGrants, []);
    assert.equal(before.createdDrives[0]!.goLive, undefined);
    assert.deepEqual(await h.port.listDriveMembers(before.createdDrives[0]!.driveId!), [
      { email: "files@example.com", type: "user", role: "organizer" },
    ]);
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.accept({
          verificationDigest: verification.verificationDigest,
          approver: "operator",
          codes: ["size_mismatch"],
          rationale: "Reviewed the damaged fixture file",
          mode: "unattended",
        }),
      ),
    );
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    assert.equal(
      value(await h.engine.reader(h.ref).status()).memberGrants[0]?.member.role,
      "writer",
    );
  });

  it("fences the whole drive batch before a partial grant and reconciles access without recopying", async (t) => {
    const input = fileFixture([
      { id: "one", parentId: "source-root", name: "one", kind: "folder" },
      { id: "two", parentId: "source-root", name: "two", kind: "folder" },
      { id: "first", parentId: "one", name: "first.txt", kind: "file", content: "first" },
      { id: "second", parentId: "two", name: "second.txt", kind: "file", content: "second" },
    ]);
    input.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
    const h = await harness(t, input, {
      mappings: [],
      options: { memberGrants: "after_verification" },
    });
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: ["one", "two"].map((id) => ({
              id,
              source: { type: "sharepoint", driveId: "source-drive", folderPath: id },
              destination: { type: "google_shared_drive", create: id },
              members: [{ email: `${id}@example.com`, type: "group", role: "writer" }],
            })),
          }),
        }),
      ),
    );
    await approve(h);
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    h.port.scriptEffect({
      method: "addDriveMember",
      objectId: "two@example.com",
      timing: "after",
      count: 1,
      error: new TypeError("ambiguous second grant"),
    });
    await assert.rejects(
      h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))),
      /ambiguous second grant/,
    );
    const partial = value(await h.engine.reader(h.ref).status());
    assert.equal(partial.memberGrants.length, 1);
    assert.ok(partial.createdDrives.every((drive) => drive.goLive));
    const firstDrive = partial.createdDrives.find((drive) => drive.mappingId === "one")!.driveId!;
    await h.port.addDriveMember(firstDrive, {
      email: "one@example.com",
      type: "group",
      role: "reader",
    });
    h.engine.close();
    h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
    const mismatch = await h.engine.withWriterResult(h.ref, async (w) =>
      w.close(await closeDecision(h)),
    );
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.refusal.detail?.check, "drive_membership_mismatch");
    assert.equal(
      (await h.port.listDriveMembers(firstDrive)).find(
        (member) => member.email === "one@example.com",
      )?.role,
      "reader",
    );
    await h.port.addDriveMember(firstDrive, {
      email: "one@example.com",
      type: "group",
      role: "writer",
    });
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    const closed = value(await h.engine.reader(h.ref).status());
    assert.equal(closed.memberGrants.length, 2);
    assert.deepEqual(closed.mappingPasses, partial.mappingPasses);
  });
  it("cannot bypass approved deferred access by editing timing after verification", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace("after_verification", "before_copy"));
    const closing = await h.engine.withWriterResult(h.ref, async (w) =>
      w.close(await closeDecision(h)),
    );
    assert.equal(closing.ok, false);
    if (!closing.ok) assert.equal(closing.refusal.code, "plan_revision_required");
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).memberGrants, []);
    await writeFile(path, original);
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
  });
  it("keeps unavailable pregrant proof unwaivable but allows explicit postgrant unverified closure", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    h.port.scriptEffect({
      method: "listFileHashes",
      count: 1,
      error: new TypeError("listing unavailable"),
    });
    const refused = await h.engine.withWriterResult(h.ref, async (w) =>
      w.close(await closeDecision(h)),
    );
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.refusal.code, "verification_unaccepted");
      assert.equal(refused.refusal.detail?.accessMayExist, false);
      assert.equal(refused.refusal.detail?.check, "go_live_check_unavailable");
    }
    const before = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(before.memberGrants, []);
    assert.equal(before.createdDrives[0]?.goLive, undefined);
    assert.equal(before.createdDrives[0]?.preGrantCheck?.check.check, "go_live_check_unavailable");
    assert.equal(before.goLiveReview, null);
    const waiver = await h.engine.withWriterResult(h.ref, (w) =>
      w.acknowledgeGoLive({
        evidenceDigest: "not-postgrant-evidence",
        mappingIds: ["finance"],
        rationale: "Cannot waive pregrant checks",
        approver: "operator",
        mode: "unattended",
      }),
    );
    assert.equal(waiver.ok, false);
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).goLiveAcknowledgments, []);

    const listMembers = h.port.listDriveMembers.bind(h.port);
    const unavailable = t.mock.method(h.port, "listDriveMembers", async (driveId: string) => {
      const members = await listMembers(driveId);
      if (members.some((member) => member.email === "finance@example.com"))
        throw new TypeError("membership evidence unavailable after grant");
      return members;
    });
    const closing = await h.engine.withWriterResult(h.ref, (w) => w.close());
    assert.equal(closing.ok, false);
    const partial = value(await h.engine.reader(h.ref).status());
    assert.equal(partial.memberGrants.length, 1);
    assert.equal(partial.createdDrives[0]?.goLive?.check?.check, "go_live_check_unavailable");
    assert.equal(partial.createdDrives[0]?.goLive?.check?.status, "failed");
    const acknowledgment = await acknowledgeChecks(h);
    const closure = value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
    assert.equal(closure.outcome, "completed_with_accepted_exceptions");
    const closed = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(closed.mappingPasses, partial.mappingPasses);
    assert.deepEqual(closed.createdDrives[0]?.goLive, partial.createdDrives[0]?.goLive);
    assert.deepEqual(closed.goLiveAcknowledgments, [acknowledgment]);
    unavailable.mock.restore();
    const artifacts = value(await h.engine.reader(h.ref).artifacts());
    const report = JSON.parse(
      await readFile(artifacts.artifacts.find((item) => item.name === "report.json")!.path, "utf8"),
    );
    const section = JSON.parse(
      report.sections.find((item: { title: string }) => item.title === "Go-live").body,
    );
    assert.equal(section.checksPassed, false);
    assert.equal(section.checksSettled, true);
    assert.equal(section.drives[0].proof, "unverified");
    assert.equal(section.drives[0].check.status, "failed");
    assert.equal(section.preGrantChecks[0].check.status, "passed");
    assert.deepEqual(section.acknowledgments, [acknowledgment]);
    const exceptions: Record<string, string>[] = parse(
      await readFile(
        artifacts.artifacts.find((item) => item.name === "exceptions.csv")!.path,
        "utf8",
      ),
      { columns: true },
    );
    const unverified = exceptions.find((item) => item.code === "go_live_check_unavailable")!;
    assert.equal(unverified.status, "acknowledged (unverified)");
    assert.equal(unverified.note, acknowledgment.rationale);
    assert.equal(unverified.approver, acknowledgment.approver);
    assert.deepEqual(JSON.parse(unverified.reason!), acknowledgment.checks[0]!.check.evidence);
  });
  it("checks every unfenced drive before any grants, reruns prior passes, and permits repair and reverification", async (t) => {
    const h = await provisioningHarness(
      t,
      multiMapping().input,
      { memberGrants: "after_verification" },
      ["a", "b"],
    );
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    const initial = value(await h.engine.reader(h.ref).status());
    const a = initial.createdDrives.find((drive) => drive.mappingId === "a")!;
    const b = initial.createdDrives.find((drive) => drive.mappingId === "b")!;
    const first = (await h.port.listDestinationChildren(a.driveId!))[0]!;
    const second = (await h.port.listDestinationChildren(b.driveId!))[0]!;
    h.port.mutateDestinationContent(second.id, "bad");
    const addMember = t.mock.method(h.port, "addDriveMember");
    const failed = await h.engine.withWriterResult(h.ref, async (w) =>
      w.close(await closeDecision(h)),
    );
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.refusal.detail?.accessMayExist, false);
    const blocked = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(
      blocked.createdDrives.map((drive) => drive.preGrantCheck?.check.status),
      ["passed", "failed"],
    );
    assert.ok(blocked.createdDrives.every((drive) => !drive.goLive));
    assert.deepEqual(blocked.memberGrants, []);
    assert.equal(addMember.mock.callCount(), 0);
    assert.equal(blocked.goLiveReview, null);

    h.port.mutateDestinationContent(first.id, "new");
    h.port.mutateDestinationContent(second.id, "two");
    const retry = await h.engine.withWriterResult(h.ref, (w) => w.close());
    assert.equal(retry.ok, false);
    const rechecked = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(
      rechecked.createdDrives.map((drive) => drive.preGrantCheck?.check.status),
      ["failed", "passed"],
    );
    assert.ok(rechecked.createdDrives.every((drive) => !drive.goLive));
    assert.equal(addMember.mock.callCount(), 0);

    h.port.mutateDestinationContent(first.id, "one");
    await approve(h);
    await execute(h);
    const verification = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verification.clean, true);
    const originalGrant = h.port.addDriveMember.bind(h.port);
    addMember.mock.restore();
    t.mock.method(
      h.port,
      "addDriveMember",
      async (...[driveId, member]: Parameters<FakeFileMigrationPort["addDriveMember"]>) => {
        const fenced = value(await h.engine.reader(h.ref).status());
        assert.ok(
          fenced.createdDrives.every(
            (drive) => drive.goLive && drive.preGrantCheck?.check.status === "passed",
          ),
        );
        await originalGrant(driveId, member);
        // Intended users may immediately edit content; fresh close must not recheck it.
        if (driveId === a.driveId)
          h.port.mutateDestinationContent(first.id, "legitimate new content");
      },
    );
    value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
    const closed = value(await h.engine.reader(h.ref).status());
    assert.equal(closed.state, "closed");
    assert.equal(closed.memberGrants.length, 2);
    assert.ok(closed.createdDrives.every((drive) => drive.goLive?.check?.check === "membership"));
  });

  it("retains the original content baseline for an already-live legacy drive and acknowledges real drift", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    h.port.scriptEffect({
      method: "addDriveMember",
      timing: "after",
      count: 1,
      error: new Error("legacy interrupted grant"),
    });
    await assert.rejects(
      h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))),
      /legacy interrupted grant/,
    );
    // Model a job fenced by the pre-ADR-0017 driver: no pregrant observation exists.
    editRecoveryState(
      h,
      "UPDATE created_drive SET payload = json_remove(payload, '$.preGrantCheck')",
    );
    const legacy = value(await h.engine.reader(h.ref).status());
    const drive = legacy.createdDrives[0]!;
    const file = (await h.port.listDestinationChildren(drive.driveId!)).find(
      (item) => item.name === "report.docx",
    )!;
    h.port.mutateDestinationContent(file.id, new Uint8Array([9, 9, 9, 9]));
    const refusal = await h.engine.withWriterResult(h.ref, (w) => w.close());
    assert.equal(refusal.ok, false);
    const failed = value(await h.engine.reader(h.ref).status());
    assert.equal(failed.createdDrives[0]?.preGrantCheck, undefined);
    assert.deepEqual(failed.createdDrives[0]?.verifiedDestination, drive.verifiedDestination);
    const check = failed.createdDrives[0]?.goLive?.check;
    assert.equal(check?.check, "destination_drift");
    assert.equal(check?.evidence.expectedDestinationDigest, drive.verifiedDestination?.digest);
    assert.notEqual(check?.evidence.observedDestinationDigest, drive.verifiedDestination?.digest);
    await acknowledgeChecks(h);
    t.mock.method(h.port, "listFileHashes", async () => {
      throw new Error("settled legacy evidence must not be relisted");
    });
    const closure = value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
    assert.equal(closure.outcome, "completed_with_accepted_exceptions");
    const closed = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(closed.createdDrives[0]?.goLive?.check, check);
    assert.deepEqual(closed.createdDrives[0]?.verifiedDestination, drive.verifiedDestination);
    assert.equal(closed.createdDrives[0]?.preGrantCheck, undefined);
  });

  it("finishes missing legacy destination proof after an acknowledged membership difference", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    h.port.scriptEffect({
      method: "addDriveMember",
      timing: "after",
      count: 1,
      error: new Error("legacy interrupted grant"),
    });
    await assert.rejects(
      h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))),
      /legacy interrupted grant/,
    );
    // Model a job fenced by the pre-ADR-0017 driver: no pregrant observation exists.
    editRecoveryState(
      h,
      "UPDATE created_drive SET payload = json_remove(payload, '$.preGrantCheck')",
    );
    const drive = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
    await h.port.addDriveMember(drive.driveId!, {
      email: "outside@example.com",
      type: "user",
      role: "writer",
    });
    const file = (await h.port.listDestinationChildren(drive.driveId!)).find(
      (item) => item.name === "report.docx",
    )!;
    h.port.mutateDestinationContent(file.id, new Uint8Array([9, 9, 9, 9]));
    assert.equal((await h.engine.withWriterResult(h.ref, (w) => w.close())).ok, false);
    const membership = value(await h.engine.reader(h.ref).status()).createdDrives[0]?.goLive?.check;
    assert.equal(membership?.check, "drive_membership_mismatch");
    const membershipAcknowledgment = await acknowledgeChecks(h);

    // Accepting the access difference does not accept content the legacy check never observed.
    const unfinished = await h.engine.withWriterResult(h.ref, (w) => w.close());
    assert.equal(unfinished.ok, false);
    if (!unfinished.ok) assert.equal(unfinished.refusal.code, "verification_unaccepted");
    const drifted = value(await h.engine.reader(h.ref).status());
    assert.notEqual(drifted.state, "closed");
    assert.equal(drifted.incompleteClose?.checksSettled, false);
    assert.deepEqual(drifted.createdDrives[0]?.goLive?.check, membership);
    const destination = drifted.createdDrives[0]?.goLive?.destinationCheck;
    assert.equal(destination?.check, "destination_drift");
    assert.equal(
      destination?.evidence.expectedDestinationDigest,
      drive.verifiedDestination?.digest,
    );
    assert.notEqual(
      destination?.evidence.observedDestinationDigest,
      drive.verifiedDestination?.digest,
    );
    assert.deepEqual(
      drifted.goLiveReview?.checks.map((check) => check.check),
      [destination],
    );
    const destinationAcknowledgment = await acknowledgeChecks(h);

    const originalSections = fileMigrationDriver.reportSections;
    const failingReport = t.mock.method(
      fileMigrationDriver,
      "reportSections",
      async function* (ctx: DriverContext<FileMigrationConfig>) {
        if (ctx.resume.goLiveAcknowledgments?.length) throw new Error("final report unavailable");
        yield* originalSections(ctx);
      },
    );
    await assert.rejects(
      h.engine.withWriterResult(h.ref, (w) => w.close()),
      /final report unavailable/,
    );
    failingReport.mock.restore();
    t.mock.method(h.port, "listDriveMembers", async () => {
      throw new Error("acknowledged membership must not be rechecked");
    });
    t.mock.method(h.port, "listFileHashes", async () => {
      throw new Error("acknowledged destination drift must not be relisted");
    });
    const closure = value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
    assert.equal(closure.outcome, "completed_with_accepted_exceptions");
    const closed = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(closed.createdDrives[0]?.goLive, drifted.createdDrives[0]?.goLive);
    assert.deepEqual(closed.goLiveAcknowledgments, [
      membershipAcknowledgment,
      destinationAcknowledgment,
    ]);
    const artifacts = value(await h.engine.reader(h.ref).artifacts());
    const exceptions: Record<string, string>[] = parse(
      await readFile(
        artifacts.artifacts.find((item) => item.name === "exceptions.csv")!.path,
        "utf8",
      ),
      { columns: true },
    );
    for (const [check, acknowledgment] of [
      [membership!, membershipAcknowledgment],
      [destination!, destinationAcknowledgment],
    ] as const) {
      const row = exceptions.find((item) => item.code === check.check)!;
      assert.equal(row.status, "acknowledged (failed)");
      assert.equal(row.approver, acknowledgment.approver);
      assert.deepEqual(JSON.parse(row.reason!), check.evidence);
    }
  });

  it("binds acknowledgment to selected evidence and authority, never to other or future failures", async (t) => {
    const h = await provisioningHarness(
      t,
      multiMapping().input,
      { memberGrants: "after_verification" },
      ["a", "b"],
    );
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    const initial = value(await h.engine.reader(h.ref).status());
    for (const drive of initial.createdDrives)
      await h.port.addDriveMember(drive.driveId!, {
        email: "outside@example.com",
        type: "user",
        role: "writer",
      });
    assert.equal(
      (await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h)))).ok,
      false,
    );
    const review = value(await h.engine.reader(h.ref).status()).goLiveReview!;
    assert.deepEqual(
      review.checks.map((check) => check.mappingId),
      ["a", "b"],
    );
    const submit = (
      evidenceDigest: string,
      mappingIds: string[],
      rationale = "Reviewed this discrepancy",
      approver = "operator",
    ) =>
      h.engine.withWriterResult(h.ref, (w) =>
        w.acknowledgeGoLive({
          evidenceDigest,
          mappingIds,
          rationale,
          approver,
          mode: "unattended",
        }),
      );
    for (const mappingIds of [[], ["unknown"]]) {
      const refused = await submit(review.evidenceDigest, mappingIds);
      assert.equal(refused.ok, false);
    }
    assert.equal((await submit(review.evidenceDigest, ["a"], " ")).ok, false);
    assert.equal((await submit(review.evidenceDigest, ["a"], "Reviewed", " ")).ok, false);
    const acknowledgment = value(await submit(review.evidenceDigest, ["a"]));
    assert.deepEqual(
      acknowledgment.checks.map((check) => check.mappingId),
      ["a"],
    );
    assert.equal(acknowledgment.identityAssurance, "declared_unverified");
    assert.equal(acknowledgment.mode, "unattended");
    const selected = value(await h.engine.reader(h.ref).status());
    assert.equal(selected.incompleteClose?.checksPassed, false);
    assert.equal(selected.incompleteClose?.checksSettled, false);
    assert.deepEqual(
      selected.goLiveReview?.checks.map((check) => check.mappingId),
      ["b"],
    );
    const stale = await submit(review.evidenceDigest, ["b"]);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.refusal.code, "approval_digest_stale");
    assert.equal((await submit(selected.goLiveReview!.evidenceDigest, ["a"])).ok, false);
    assert.equal((await h.engine.withWriterResult(h.ref, (w) => w.close())).ok, false);

    const b = initial.createdDrives.find((drive) => drive.mappingId === "b")!;
    await h.port.addDriveMember(b.driveId!, {
      email: "outside@example.com",
      type: "user",
      role: "reader",
    });
    assert.equal((await h.engine.withWriterResult(h.ref, (w) => w.close())).ok, false);
    const changed = value(await h.engine.reader(h.ref).status());
    assert.notEqual(changed.goLiveReview?.evidenceDigest, selected.goLiveReview?.evidenceDigest);
    const changedEvidence = await submit(selected.goLiveReview!.evidenceDigest, ["b"]);
    assert.equal(changedEvidence.ok, false);
    if (!changedEvidence.ok) assert.equal(changedEvidence.refusal.code, "approval_digest_stale");
    assert.deepEqual(
      changed.createdDrives.find((drive) => drive.mappingId === "a")?.goLive,
      selected.createdDrives.find((drive) => drive.mappingId === "a")?.goLive,
    );
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const original = await readFile(path, "utf8");
    const changedAuthority = original.replace(
      'memberGrants = "after_verification"',
      'memberGrants = "before_copy"',
    );
    assert.notEqual(changedAuthority, original);
    await writeFile(path, changedAuthority);
    const authority = await submit(changed.goLiveReview!.evidenceDigest, ["b"]);
    assert.equal(authority.ok, false);
    assert.equal(value(await h.engine.reader(h.ref).status()).goLiveReview, null);
    await writeFile(path, original);
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).goLiveAcknowledgments, [
      acknowledgment,
    ]);
    await acknowledgeChecks(h, ["b"]);
    assert.equal(
      value(await h.engine.withWriterResult(h.ref, (w) => w.close())).outcome,
      "completed_with_accepted_exceptions",
    );
  });

  for (const settlement of ["passed", "acknowledged"] as const)
    it(`recovers ambiguous grants with a ${settlement} check and never treats a missing check as settled`, async (t) => {
      const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
      await execute(h);
      value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
      h.port.scriptEffect({
        method: "addDriveMember",
        timing: "after",
        count: 1,
        error: new Error("ambiguous grant"),
      });
      await assert.rejects(
        h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))),
        /ambiguous grant/,
      );
      const missing = value(await h.engine.reader(h.ref).status());
      assert.deepEqual(missing.memberGrants, []);
      assert.equal(missing.createdDrives[0]?.goLive?.check, undefined);
      assert.equal(missing.incompleteClose?.checksSettled, false);
      assert.equal(missing.goLiveReview, null);
      const invalid = await h.engine.withWriterResult(h.ref, (w) =>
        w.acknowledgeGoLive({
          evidenceDigest: "missing-check",
          mappingIds: ["finance"],
          rationale: "Cannot settle a missing check",
          approver: "operator",
          mode: "unattended",
        }),
      );
      assert.equal(invalid.ok, false);
      // A recovered legacy check cannot stand in for the missing durable grant receipt.
      const recoveredCheck =
        settlement === "passed"
          ? { at: now, status: "passed", check: "membership", evidence: {} }
          : {
              at: now,
              status: "failed",
              check: "go_live_check_unavailable",
              evidence: { scope: "membership" },
            };
      editRecoveryState(
        h,
        `UPDATE created_drive SET payload = json_set(payload, '$.goLive.check', json('${JSON.stringify(recoveredCheck)}'))`,
      );
      if (settlement === "acknowledged") await acknowledgeChecks(h);
      const settled = value(await h.engine.reader(h.ref).status()).createdDrives[0]?.goLive?.check;
      t.mock.method(h.port, "addDriveMember", async () => {
        throw new Error("ambiguous grant already exists; do not duplicate it");
      });
      const membership = t.mock.method(h.port, "listDriveMembers");
      const closure = value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
      assert.equal(
        closure.outcome,
        settlement === "passed" ? "completed" : "completed_with_accepted_exceptions",
      );
      const closed = value(await h.engine.reader(h.ref).status());
      assert.equal(closed.memberGrants.length, 1);
      assert.equal(membership.mock.callCount(), 1);
      assert.deepEqual(closed.createdDrives[0]?.goLive?.check, settled);
      assert.deepEqual(closed.mappingPasses, missing.mappingPasses);
    });

  it("preserves passed and acknowledged checks after final-report failure despite later content and membership edits", async (t) => {
    const h = await provisioningHarness(
      t,
      multiMapping().input,
      { memberGrants: "after_verification" },
      ["a", "b"],
    );
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    const initial = value(await h.engine.reader(h.ref).status());
    const b = initial.createdDrives.find((drive) => drive.mappingId === "b")!;
    await h.port.addDriveMember(b.driveId!, {
      email: "outside@example.com",
      type: "user",
      role: "writer",
    });
    assert.equal(
      (await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h)))).ok,
      false,
    );
    const acknowledgment = await acknowledgeChecks(h, ["b"]);
    const reviewed = value(await h.engine.reader(h.ref).status());
    assert.equal(reviewed.incompleteClose?.checksPassed, false);
    assert.equal(reviewed.incompleteClose?.checksSettled, true);
    const originalSections = fileMigrationDriver.reportSections;
    const failingReport = t.mock.method(
      fileMigrationDriver,
      "reportSections",
      async function* (ctx: DriverContext<FileMigrationConfig>) {
        if (ctx.resume.goLiveAcknowledgments?.length) throw new Error("final report unavailable");
        yield* originalSections(ctx);
      },
    );
    await assert.rejects(
      h.engine.withWriterResult(h.ref, (w) => w.close()),
      /final report unavailable/,
    );
    h.engine.close();
    h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
    const incomplete = value(await h.engine.reader(h.ref).status());
    assert.notEqual(incomplete.state, "closed");
    assert.equal(incomplete.incompleteClose?.reporting, "unfinished");
    assert.equal(incomplete.incompleteClose?.checksSettled, true);
    for (const drive of initial.createdDrives) {
      const file = (await h.port.listDestinationChildren(drive.driveId!))[0]!;
      h.port.mutateDestinationContent(file.id, "users edit after access is live");
      await h.port.addDriveMember(drive.driveId!, {
        email: "later@example.com",
        type: "user",
        role: "reader",
      });
    }
    failingReport.mock.restore();
    t.mock.method(h.port, "listDriveMembers", async () => {
      throw new Error("settled membership must not be rechecked");
    });
    t.mock.method(h.port, "listFileHashes", async () => {
      throw new Error("settled content must not be rechecked");
    });
    t.mock.method(h.port, "startTransferWorker", async () => {
      throw new Error("report-only retry must not start a worker");
    });
    const closure = value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
    assert.equal(closure.outcome, "completed_with_accepted_exceptions");
    const closed = value(await h.engine.reader(h.ref).status());
    assert.equal(closed.state, "closed");
    assert.deepEqual(closed.createdDrives, reviewed.createdDrives);
    assert.deepEqual(closed.goLiveAcknowledgments, [acknowledgment]);
    assert.deepEqual(closed.closeAuthorization, reviewed.closeAuthorization);
    assert.deepEqual(closed.mappingPasses, reviewed.mappingPasses);
    const artifacts = value(await h.engine.reader(h.ref).artifacts());
    const report = JSON.parse(
      await readFile(artifacts.artifacts.find((item) => item.name === "report.json")!.path, "utf8"),
    );
    const section = JSON.parse(
      report.sections.find((item: { title: string }) => item.title === "Go-live").body,
    );
    assert.equal(section.checksPassed, false);
    assert.equal(section.checksSettled, true);
    assert.deepEqual(section.acknowledgments, [acknowledgment]);
    assert.deepEqual(
      section.drives.map((drive: { check: unknown }) => drive.check),
      reviewed.createdDrives.map((drive) => drive.goLive?.check),
    );
    assert.deepEqual(report.goLiveAcknowledgments, [acknowledgment]);
    assert.equal(report.job.closureOutcome, "completed_with_accepted_exceptions");
    assert.equal(closed.closureOutcome, "completed_with_accepted_exceptions");
    assert.deepEqual(closure.goLiveAcknowledgments, [acknowledgment]);
    const html = await readFile(
      artifacts.artifacts.find((item) => item.name === "report.html")!.path,
      "utf8",
    );
    assert.ok(html.includes(acknowledgment.rationale));
    assert.ok(html.includes(acknowledgment.approver));
    assert.ok(html.includes(acknowledgment.evidenceDigest));
    const mappings: Record<string, string>[] = parse(
      await readFile(
        artifacts.artifacts.find((item) => item.name === "mappings.csv")!.path,
        "utf8",
      ),
      { columns: true },
    );
    const acceptedMapping = mappings.find((item) => item.mapping_id === "b")!;
    assert.deepEqual(
      JSON.parse(acceptedMapping.go_live_pre_grant_check!),
      b.preGrantCheck ??
        reviewed.createdDrives.find((drive) => drive.mappingId === "b")!.preGrantCheck,
    );
    assert.deepEqual(JSON.parse(acceptedMapping.go_live_check!), acknowledgment.checks[0]!.check);
    assert.deepEqual(JSON.parse(acceptedMapping.go_live_acknowledgments!), [acknowledgment]);
    const exceptions: Record<string, string>[] = parse(
      await readFile(
        artifacts.artifacts.find((item) => item.name === "exceptions.csv")!.path,
        "utf8",
      ),
      { columns: true },
    );
    const acceptedFailure = exceptions.find((item) => item.code === "drive_membership_mismatch")!;
    assert.equal(acceptedFailure.status, "acknowledged (failed)");
    assert.equal(acceptedFailure.note, acknowledgment.rationale);
    assert.equal(acceptedFailure.approver, acknowledgment.approver);
    assert.deepEqual(JSON.parse(acceptedFailure.reason!), acknowledgment.checks[0]!.check.evidence);
  });
});

describe("file migration through the engine", () => {
  it("refuses mirror on legacy created-drive records lacking provenance", async (t) => {
    const h = await provisioningHarness(t, fixture(), { mirror: true, deleteLimit: 2 });
    await execute(h);
    h.port.deleteSourceItem("binary");
    const database = new DatabaseSync(join(h.home, "jobs", h.ref.id, "state.db"));
    try {
      database.exec(
        "UPDATE created_drive SET payload = json_remove(payload, '$.intentAt', '$.provenance')",
      );
    } finally {
      database.close();
    }
    await approve(h);
    await execute(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.mappingPasses[0]?.status, "failed");
    assert.match(status.mappingPasses[0]!.error!, /provenance/i);
    const driveId = status.createdDrives[0]!.driveId!;
    assert.ok(
      (await h.port.listDestinationChildren(driveId)).some((f) => f.name === "report.docx"),
    );
  });
  it("recovers a newly created drive after a lost response and mirrors later deletions", async (t) => {
    const input = fixture();
    input.now = () => new Date("2026-09-01T00:00:01.000Z");
    input.effects = [
      {
        method: "createSharedDrive",
        timing: "after",
        count: 1,
        error: new TypeError("Lost response"),
      },
    ];
    const h = await provisioningHarness(t, input, { mirror: true, deleteLimit: 1 });
    await execute(h);
    const first = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(first.createdDrives[0]?.provenance, {
      kind: "name_recovery",
      createdTime: "2026-09-01T00:00:01.000Z",
    });
    h.port.deleteSourceItem("binary");
    await approve(h);
    await execute(h);
    const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verified.clean, true);
    assert.deepEqual(verified.findings, []);
    assert.equal((await h.port.findSharedDrives("Finance")).length, 1);
  });
  it("refuses an older same-name drive after a lost creation response without deleting its files", async (t) => {
    const input = fixture();
    input.now = () => new Date("2020-01-01T00:00:00.000Z");
    input.destinationItems.push({
      id: "outside-file",
      driveId: "drive-1",
      parentId: "drive-1",
      name: "outside.txt",
      kind: "file",
      content: "outside",
    });
    const h = await provisioningHarness(t, input, { mirror: true, deleteLimit: 10 });
    const outside = (await h.port.createSharedDrive({ name: "Finance", requestId: "outside" }))!;
    h.port.scriptEffect({
      method: "createSharedDrive",
      timing: "before",
      count: 1,
      error: new TypeError("Creation response unavailable"),
    });
    const result = await h.engine.withWriterResult(h.ref, (w) => w.execute());
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("An older same-name drive must not be adopted");
    assert.equal(result.refusal.code, "drive_creation_ambiguous");
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.createdDrives[0]?.driveId, null);
    assert.equal(status.mappingPasses[0]?.status, "pending");
    assert.deepEqual(
      (await h.port.listDestinationChildren(outside.id)).map((f) => f.name),
      ["outside.txt"],
    );
  });
  it("repeat copy passes retain deleted and renamed source files", async (t) => {
    const h = await provisioningHarness(t);
    await execute(h);
    h.port.deleteSourceItem("binary");
    h.port.renameSourceItem("zero", "renamed.bin");
    await approve(h);
    await execute(h);
    const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verified.clean, true);
    const rows = value(
      await h.engine.reader(h.ref).rows({ phase: "verify", codes: ["destination_only_retained"] }),
    ).rows;
    assert.deepEqual(
      rows.map((r) => (r.jobType === "file_migration" ? r.relativePath : "")).sort(),
      ["nested/zero.bin", "report.docx"],
    );
  });
  it("requires a safe nonnegative delete limit and refuses legacy mirror destinations", async (t) => {
    const h = await harness(t);
    for (const deleteLimit of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
      const result = await h.engine.initJob({
        type: "file_migration",
        config: {
          mappings: [],
          options: { mirror: true, deleteLimit },
        },
      });
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("Unsafe delete limit accepted");
      assert.equal(result.refusal.code, "configuration_invalid");
    }
    const result = await h.engine.initJob({
      type: "file_migration",
      config: { ...config, options: { mirror: true, deleteLimit: 1 } },
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Existing destination accepted for mirror");
    assert.deepEqual(result.refusal.detail, { row: 1, field: "destination" });
    const reverse = await harness(t, fixture(), {
      sourceProvider: "google_shared_drive",
      destinationProvider: "sharepoint",
      mappings: [],
      options: { mirror: true, deleteLimit: 1 },
    });
    const loaded = await reverse.engine.withWriterResult(reverse.ref, (w) =>
      w.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [
            {
              id: "mapping",
              source: {
                type: "google_shared_drive",
                driveId: "source-drive",
                folderId: "source-root",
              },
              destination: { type: "sharepoint", driveId: "destination-drive", folderPath: "" },
            },
          ],
        }),
      }),
    );
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.deepEqual(loaded.refusal.detail, { row: 1, field: "destination" });
  });
  it("discloses mirror and the per-mapping delete limit in plan and report", async (t) => {
    for (const options of [undefined, { mirror: true, deleteLimit: 3 }]) {
      const h = await provisioningHarness(t, fixture(), options);
      const status = value(await h.engine.reader(h.ref).status());
      const section = status.currentPlan!.sections.find((s) => s.title === "Mirror");
      assert.ok(section);
      assert.deepEqual(JSON.parse(section.body), {
        mirror: options?.mirror ?? false,
        deleteLimit: options?.deleteLimit ?? null,
      });
      await execute(h);
      const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
      const json = JSON.parse(
        await readFile(report.artifacts.find((a) => a.name === "report.json")!.path, "utf8"),
      );
      assert.equal(
        json.sections.find((s: { title: string }) => s.title === "Mirror").body,
        section.body,
      );
    }
  });
  it("refuses mirror manifests naming existing destinations with row and field", async (t) => {
    const h = await harness(t, fixture(), {
      mappings: [],
      options: { mirror: true, deleteLimit: 0 },
    });
    const result = await h.engine.withWriterResult(h.ref, (w) =>
      w.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [
            {
              id: "existing",
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
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Mirror must refuse existing destinations");
    assert.equal(result.refusal.code, "configuration_invalid");
    assert.deepEqual(result.refusal.detail, { row: 1, field: "destination" });
  });
  it("mirrors deletions and renames on a repeat pass into a job-created drive", async (t) => {
    const h = await provisioningHarness(t, fixture(), { mirror: true, deleteLimit: 2 });
    await execute(h);
    h.port.deleteSourceItem("binary");
    h.port.renameSourceItem("zero", "renamed.bin");
    await approve(h);
    await execute(h);
    const verified = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verified.clean, true);
    assert.deepEqual(verified.findings, []);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.mappingPasses[0]?.mode, "mirror");
    assert.equal(status.mappingPasses[0]?.status, "completed");
  });
  it("recovers a lost drive creation response without duplicating a drive", async (t) => {
    const input = fixture();
    input.effects = [
      {
        method: "createSharedDrive",
        timing: "after",
        count: 1,
        error: new TypeError("Connection lost after creation"),
      },
    ];
    const h = await provisioningHarness(t, input);
    await execute(h);
    assert.equal((await h.port.findSharedDrives("Finance")).length, 1);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.mappingPasses[0]?.status, "completed");
    assert.equal(status.memberGrants[0]?.member.email, "finance@example.com");
    await execute(h);
    assert.equal((await h.port.findSharedDrives("Finance")).length, 1);
  });
  it("refuses ambiguous lost creation responses instead of guessing a same-named drive", async (t) => {
    const h = await provisioningHarness(t);
    await h.port.createSharedDrive({ name: "Finance", requestId: "operator-drive" });
    h.port.scriptEffect({
      method: "createSharedDrive",
      timing: "after",
      count: 1,
      error: new TypeError("Lost response"),
    });
    const result = await h.engine.withWriterResult(h.ref, (w) => w.execute());
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Ambiguous drives must refuse");
    assert.equal(result.refusal.code, "drive_creation_ambiguous");
    assert.equal((await h.port.findSharedDrives("Finance")).length, 2);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.createdDrives[0]?.driveId, null);
    assert.deepEqual(status.memberGrants, []);
    assert.equal(status.mappingPasses[0]?.status, "pending");
  });
  it("resumes after a crash between drive creation and member grant using the durable id", async (t) => {
    const h = await provisioningHarness(t);
    h.port.scriptEffect({
      method: "addDriveMember",
      count: 1,
      error: new Error("simulated process crash"),
    });
    await assert.rejects(
      h.engine.withWriterResult(h.ref, (w) => w.execute()),
      /simulated process crash/,
    );
    const crashed = value(await h.engine.reader(h.ref).status());
    const driveId = crashed.createdDrives[0]!.driveId!;
    assert.match(driveId, /^drive-/);
    assert.deepEqual(crashed.memberGrants, []);
    assert.equal(crashed.mappingPasses[0]?.status, "pending");
    await h.port.createSharedDrive({ name: "Finance", requestId: "unrelated-after-crash" });
    h.engine.close();
    h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
    await execute(h);
    const recovered = value(await h.engine.reader(h.ref).status());
    assert.equal(recovered.createdDrives[0]?.driveId, driveId);
    assert.equal(recovered.mappingPasses[0]?.status, "completed");
    assert.equal(recovered.memberGrants[0]?.driveId, driveId);
    assert.equal((await h.port.findSharedDrives("Finance")).length, 2);
  });
  it("reports membership drift as a blocking finding without repairing access during verification", async (t) => {
    const h = await provisioningHarness(t);
    await execute(h);
    const before = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(before.clean, true);
    const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
    await h.port.addDriveMember(driveId, {
      email: "finance@example.com",
      type: "group",
      role: "reader",
    });
    const verification = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verification.clean, false);
    assert.ok(verification.findings.some((f) => f.code === "drive_membership_mismatch"));
    const closing = await h.engine.withWriterResult(h.ref, async (w) =>
      w.close(await closeDecision(h)),
    );
    assert.equal(closing.ok, false);
    assert.equal(
      (await h.port.listDriveMembers(driveId)).find((m) => m.email === "finance@example.com")?.role,
      "reader",
    );
    const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
    const text = await readFile(
      report.artifacts.find((a) => a.name === "report.json")!.path,
      "utf8",
    );
    assert.match(text, /drive_membership_mismatch/);
    assert.match(text, /finance@example.com/);
  });
  it("keeps completed member grants unchanged on execute replay so drift stays visible", async (t) => {
    const h = await provisioningHarness(t);
    await execute(h);
    const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
    await h.port.addDriveMember(driveId, {
      email: "finance@example.com",
      type: "group",
      role: "reader",
    });
    await execute(h);
    assert.equal(
      (await h.port.listDriveMembers(driveId)).find((m) => m.email === "finance@example.com")?.role,
      "reader",
    );
    assert.ok(
      value(await h.engine.reader(h.ref).status()).outstandingFindings.some(
        (f) => f.code === "drive_membership_mismatch",
      ),
    );
  });
  it("reconciles a granted member whose response was lost before its checkpoint", async (t) => {
    const h = await provisioningHarness(t);
    h.port.scriptEffect({
      method: "addDriveMember",
      timing: "after",
      count: 1,
      error: new Error("crash after member grant"),
    });
    await assert.rejects(
      h.engine.withWriterResult(h.ref, (w) => w.execute()),
      /crash after member grant/,
    );
    h.port.scriptEffect({
      method: "addDriveMember",
      count: 1,
      error: new Error("Existing grants must not be submitted again"),
    });
    h.engine.close();
    h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
    await execute(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.memberGrants[0]?.member.role, "writer");
    assert.equal(status.mappingPasses[0]?.status, "completed");
  });
  it("plans a new revision against the already-created drive and refuses renaming its creation intent", async (t) => {
    const h = await provisioningHarness(t);
    await execute(h);
    const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
    const reload = (name: string) =>
      h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: [
              {
                id: "finance",
                source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
                destination: { type: "google_shared_drive", create: name },
                members: [{ email: "finance@example.com", type: "group", role: "writer" }],
              },
            ],
          }),
        }),
      );
    const changed = await reload("Different");
    assert.equal(changed.ok, false);
    if (changed.ok) throw new Error("A creation request cannot change its name");
    assert.deepEqual(changed.refusal.detail, { row: 1, field: "destination.create" });
    value(await reload("Finance"));
    await approve(h);
    await execute(h);
    assert.equal(value(await h.engine.reader(h.ref).status()).createdDrives[0]?.driveId, driveId);
    assert.equal((await h.port.findSharedDrives("Finance")).length, 1);
  });
  it("recovers creation intents with zero or one visible candidate after reopening", async (t) => {
    for (const timing of ["before", "after"] as const) {
      const h = await provisioningHarness(t);
      h.port.scriptEffect({
        method: "createSharedDrive",
        timing,
        count: 1,
        error: new Error("crash before durable response"),
      });
      await assert.rejects(
        h.engine.withWriterResult(h.ref, (w) => w.execute()),
        /crash before durable response/,
      );
      const intent = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
      assert.equal(intent.driveId, null);
      h.engine.close();
      h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
      await execute(h);
      const recovered = value(await h.engine.reader(h.ref).status());
      assert.equal(recovered.createdDrives[0]?.requestId, intent.requestId);
      assert.equal(recovered.mappingPasses[0]?.status, "completed");
      assert.equal((await h.port.findSharedDrives("Finance")).length, 1);
    }
  });
  it("copies into existing and created destinations in the same approved manifest", async (t) => {
    const { input, selected } = multiMapping();
    input.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
    const h = await harness(t, input, selected);
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: [
              {
                id: "a",
                source: { type: "sharepoint", driveId: "source-drive", folderPath: "a" },
                destination: { type: "google_shared_drive", create: "A" },
                members: [],
              },
              {
                id: "b",
                source: { type: "sharepoint", driveId: "source-drive", folderPath: "b" },
                destination: {
                  type: "google_shared_drive",
                  driveId: "destination-drive",
                  folderId: "dest-b",
                },
              },
            ],
          }),
        }),
      ),
    );
    await approve(h);
    await execute(h);
    const drive = (await h.port.findSharedDrives("A"))[0]!;
    assert.equal(
      (await h.port.listDestinationChildren(drive.id))[0]?.reportedChecksum,
      hash("one"),
    );
    assert.equal(
      (await h.port.listDestinationChildren("dest-b"))[0]?.reportedChecksum,
      hash("two"),
    );
    assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
  });
  it("plans Shared Drives with exact members and checks creation authority", async (t) => {
    const content = JSON.stringify({
      version: 1,
      mappings: [
        {
          id: "new-drive",
          source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
          destination: { type: "google_shared_drive", create: "Finance" },
          members: [{ email: "finance@example.com", type: "group", role: "fileOrganizer" }],
        },
      ],
    });
    for (const canCreateDrives of [false, true]) {
      const input = fixture();
      input.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives };
      const h = await harness(t, input);
      value(
        await h.engine.withWriterResult(h.ref, (w) => w.loadManifest({ content, format: "json" })),
      );
      const result = await h.engine.withWriterResult(h.ref, (w) => w.plan());
      assert.equal(result.ok, canCreateDrives, JSON.stringify(result));
      if (result.ok) {
        const section = result.value.sections.find((s) => s.title === "Shared Drives to create");
        assert.deepEqual(JSON.parse(section!.body), [
          {
            mappingId: "new-drive",
            name: "Finance",
            members: [{ email: "finance@example.com", type: "group", role: "fileOrganizer" }],
          },
        ]);
      } else {
        assert.equal(result.refusal.code, "preflight_failed");
        assert.match(JSON.stringify(result), /canCreateDrives/);
      }
    }
  });
  it("provisions members before copying and reports durable drive identities", async (t) => {
    const input = fixture();
    input.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
    const h = await harness(t, input);
    const members = [{ email: "finance@example.com", type: "group", role: "writer" }];
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
                members,
              },
            ],
          }),
        }),
      ),
    );
    await approve(h);
    await execute(h);
    const drives = await h.port.findSharedDrives("Finance");
    assert.equal(drives.length, 1);
    assert.deepEqual(await h.port.listDriveMembers(drives[0]!.id), [
      { email: "files@example.com", type: "user", role: "organizer" },
      ...members,
    ]);
    const children = await h.port.listDestinationChildren(drives[0]!.id);
    assert.equal(
      children.find((file) => file.name === "report.docx")?.reportedChecksum,
      hash(new Uint8Array([0, 255, 5, 0])),
    );
    const nested = children.find((file) => file.name === "nested")!;
    assert.equal(
      (await h.port.listDestinationChildren(nested.id)).find((file) => file.name === "zero.bin")
        ?.reportedChecksum,
      hash(""),
    );
    const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
    const json = JSON.parse(
      await readFile(report.artifacts.find((a) => a.name === "report.json")!.path, "utf8"),
    );
    assert.match(JSON.stringify(json), new RegExp(drives[0]!.id));
    assert.match(JSON.stringify(json), /finance@example.com/);
    assert.equal(
      value(await h.engine.reader(h.ref).status()).createdDrives[0]?.driveId,
      drives[0]!.id,
    );
  });
  it("binds the acting subject into the plan and closing cleanup report", async (t) => {
    const input = fixture();
    input.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: false };
    const h = await harness(t, input, {
      ...config,
      impersonate: true,
      subject: "files@example.com",
    });
    const plan = value(value(await h.engine.withWriter(h.ref, (w) => w.plan())));
    assert.ok(JSON.stringify(plan).includes("files@example.com"));
    await approve(h);
    await execute(h);
    value(value(await h.engine.withWriter(h.ref, (w) => w.verify())));
    value(value(await h.engine.withWriter(h.ref, async (w) => w.close(await closeDecision(h)))));
    const report = value(value(await h.engine.withWriter(h.ref, (w) => w.report())));
    const json = report.artifacts.find((a) => a.name === "report.json")!;
    const contents = await readFile(json.path, "utf8");
    assert.match(contents, /files@example.com/);
    assert.match(contents, /Delete the service-account key/);
    assert.match(contents, /Delete the domain-wide delegation entry/);
  });
  it("refuses planning when Google cannot identify the service account", async (t) => {
    const input = fixture();
    input.googleAbout = new Error("Google identity unavailable");
    const h = await harness(t, input);
    const result = value(await h.engine.withWriter(h.ref, (writer) => writer.plan()));
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("An unidentified acting account must refuse");
    assert.equal(result.refusal.code, "preflight_failed");
  });
  it("refuses delegation failures and names the acting service account without delegation", async (t) => {
    for (const googleAbout of [
      { user: { emailAddress: "other@example.com" }, canCreateDrives: true },
      new Error("Google refused the delegated token"),
    ]) {
      const input = fixture();
      input.googleAbout = googleAbout;
      const h = await harness(t, input, {
        ...config,
        impersonate: true,
        subject: "files@example.com",
      });
      const result = value(await h.engine.withWriter(h.ref, (w) => w.plan()));
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("Delegation must refuse");
      assert.equal(result.refusal.code, "preflight_failed");
      assert.match(JSON.stringify(result), /numeric client id/);
      assert.match(JSON.stringify(result), /https:\/\/www.googleapis.com\/auth\/drive/);
    }
    const input = fixture();
    const h = await harness(t, input, {
      ...config,
      impersonate: false,
      subject: "ignored@example.com",
    });
    const plan = value(value(await h.engine.withWriter(h.ref, (w) => w.plan())));
    const actingAccount = plan.sections.find(
      (section) => section.title === "Acting Google account",
    );
    assert.ok(actingAccount?.body.includes("service-account@example.com"));
    assert.doesNotMatch(
      JSON.stringify(plan.sections),
      /Delete the service-account key|delegation entry|ignored@example.com/,
    );
    await approve(h);
    await execute(h);
    value(value(await h.engine.withWriter(h.ref, (w) => w.verify())));
    value(value(await h.engine.withWriter(h.ref, async (w) => w.close(await closeDecision(h)))));
    t.mock.method(h.port, "googleAbout", async () => {
      throw new Error("Reports must retain the identity observed for the approved plan");
    });
    const report = value(value(await h.engine.withWriter(h.ref, (w) => w.report())));
    const contents = JSON.parse(
      await readFile(
        report.artifacts.find((artifact) => artifact.name === "report.json")!.path,
        "utf8",
      ),
    );
    assert.ok(
      contents.sections
        .find((section: { title: string }) => section.title === "Acting Google account")
        ?.body.includes("service-account@example.com"),
    );
  });
  it("loads and plans 1000 mappings with bounded resources and pages filtered mapping rows", async (t) => {
    const ids = Array.from({ length: 1000 }, (_, i) => `library-${String(i).padStart(4, "0")}`);
    const { input, selected } = multiMapping(ids);
    const h = await harness(t, input, selected);
    const start = performance.now(),
      memory = process.memoryUsage().rss;
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: ids.map((id) => ({
              id,
              source: { type: "sharepoint", driveId: "source-drive", folderPath: id },
              destination: {
                type: "google_shared_drive",
                driveId: "destination-drive",
                folderId: `dest-${id}`,
              },
            })),
          }),
        }),
      ),
    );
    value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = value(
        await h.engine
          .reader(h.ref)
          .rows({ phase: "plan", view: "mappings", limit: 37, ...(cursor ? { cursor } : {}) }),
      );
      assert.equal(page.totalRows, 1000);
      assert.ok(page.rows.length <= 37);
      for (const row of page.rows) {
        assert.equal(row.jobType, "file_migration");
        if (row.jobType === "file_migration") seen.push(row.mappingId);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, ids);
    const filtered = value(
      await h.engine
        .reader(h.ref)
        .rows({ phase: "plan", view: "mappings", search: "library-099", limit: 4 }),
    );
    assert.equal(filtered.totalRows, 10);
    assert.ok(filtered.nextCursor);
    assert.ok(performance.now() - start < 15000, "1000 mappings exceeded 15 seconds");
    assert.ok(
      process.memoryUsage().rss - memory < 256 * 1024 * 1024,
      "1000 mappings exceeded 256 MiB additional RSS",
    );
  });

  it("refuses equal or nested source and destination trees without replacing the approved mappings", async (t) => {
    const { input, selected } = multiMapping();
    const h = await harness(t, input, selected);
    const digest = await approve(h);
    for (const [side, root] of [
      ["source", ""],
      ["source", "b"],
      ["destination", "destination-root"],
      ["destination", "dest-b"],
    ]) {
      const mappings = ["a", "b"].map((id) => ({
        id,
        source: { type: "sharepoint", driveId: "source-drive", folderPath: id },
        destination: {
          type: "google_shared_drive",
          driveId: "destination-drive",
          folderId: `dest-${id}`,
        },
      }));
      if (side === "source") mappings[0]!.source.folderPath = root!;
      else mappings[0]!.destination.folderId = root!;
      const result = await h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({
          content: JSON.stringify({ version: 1, mappings }),
          format: "json",
        }),
      );
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("Overlapping manifest loaded");
      assert.equal(result.refusal.code, "configuration_invalid");
      assert.equal(result.refusal.detail?.field, side);
      assert.match(result.refusal.message, /overlap/i);
      assert.equal(value(await h.engine.reader(h.ref).status()).planDigest, digest);
    }
  });

  it("freezes loaded mappings and requires new approval when a manifest is reloaded", async (t) => {
    const { input, selected } = multiMapping();
    const h = await harness(t, input, selected);
    const manifest = (id: string) =>
      JSON.stringify({
        version: 1,
        mappings: [
          {
            id,
            source: { type: "sharepoint", driveId: "source-drive", folderPath: id },
            destination: {
              type: "google_shared_drive",
              driveId: "destination-drive",
              folderId: `dest-${id}`,
            },
          },
        ],
      });
    const first = value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({ content: manifest("a"), format: "json" }),
      ),
    );
    const digest = await approve(h);
    assert.equal(
      value(await h.engine.reader(h.ref).status()).currentPlan?.manifestDigest,
      first.manifestDigest,
    );
    const second = value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({ content: manifest("b"), format: "json" }),
      ),
    );
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.state, "planned");
    assert.equal(status.planRevision, 2);
    assert.equal(status.currentPlan?.manifestDigest, second.manifestDigest);
    assert.notEqual(status.planDigest, digest);
    const old = value(await h.engine.reader(h.ref).rows({ revision: 1, phase: "plan" }));
    assert.deepEqual(
      [...new Set(old.rows.filter((r) => r.jobType === "file_migration").map((r) => r.mappingId))],
      ["a"],
    );
    const execute = await h.engine.withWriterResult(h.ref, (w) => w.execute());
    assert.equal(execute.ok, false);
    const persisted = await readFile(join(h.home, "jobs", h.ref.id, "job.toml"), "utf8");
    assert.equal(persisted.includes("[[mappings]]"), false);
  });

  it("cannot execute or verify the old approval when manifest recollection fails", async (t) => {
    const { input, selected } = multiMapping();
    const h = await harness(t, input, selected);
    await approve(h);
    h.port.scriptEffect({
      method: "preflight",
      count: 1,
      error: Object.assign(new Error("Tenant permission removed"), { code: "preflight_failed" }),
    });
    const loaded = await h.engine.withWriterResult(h.ref, (w) =>
      w.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [
            {
              id: "b",
              source: { type: "sharepoint", driveId: "source-drive", folderPath: "b" },
              destination: {
                type: "google_shared_drive",
                driveId: "destination-drive",
                folderId: "dest-b",
              },
            },
          ],
        }),
      }),
    );
    assert.equal(loaded.ok, false);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.planDigest, null);
    assert.equal((await h.engine.withWriterResult(h.ref, (w) => w.execute())).ok, false);
    assert.equal((await h.engine.withWriterResult(h.ref, (w) => w.verify())).ok, false);
    const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
    assert.equal(plan.revision, 2);
    const page = value(await h.engine.reader(h.ref).rows({ phase: "plan", view: "mappings" }));
    assert.deepEqual(
      page.rows.map((row) => (row.jobType === "file_migration" ? row.mappingId : null)),
      ["b"],
    );
  });

  it("refuses a provider fault during manifest load with its static message and evidence", async (t) => {
    const { input, selected } = multiMapping();
    const h = await harness(t, input, selected);
    t.mock.method(h.port, "resolveSourceFolder", async () => {
      throw new ProviderFault("preflight_failed", "The source folder is inaccessible.", {
        sourceDriveId: "source-drive",
      });
    });
    const loaded = await h.engine.withWriterResult(h.ref, (w) =>
      w.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [
            {
              id: "b",
              source: { type: "sharepoint", driveId: "source-drive", folderPath: "b" },
              destination: {
                type: "google_shared_drive",
                driveId: "destination-drive",
                folderId: "dest-b",
              },
            },
          ],
        }),
      }),
    );
    if (loaded.ok) throw new Error("Manifest loaded despite the provider fault");
    assert.deepEqual(
      [loaded.refusal.code, loaded.refusal.message, loaded.refusal.detail],
      ["preflight_failed", "The source folder is inaccessible.", { sourceDriveId: "source-drive" }],
    );
  });

  it("refuses copy limits that are not positive safe integers before planning", async (t) => {
    const h = await harness(t);
    for (const name of ["mappingsInFlight", "transfersPerMapping"]) {
      for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
        const result = await h.engine.initJob({
          type: "file_migration",
          config: { ...config, options: { [name]: invalid } },
        });
        assert.equal(result.ok, false);
        if (result.ok) throw new Error("Expected invalid copy limit refusal");
        assert.equal(result.refusal.code, "configuration_invalid");
      }
    }
  });

  it("cooperatively interrupts all concurrent passes without starting queued mappings", async (t) => {
    const { input, selected } = multiMapping(["a", "b", "c"]);
    input.copyPasses = ["a", "b"].map((sourceRootId) => ({
      sourceRootId,
      pause: true,
      afterFiles: 0,
    }));
    const h = await harness(t, input, selected);
    await approve(h);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    const executing = h.engine.withWriterResult(h.ref, (writer) => writer.execute({ signal }));
    const running = new Set<string>();
    for await (const event of h.engine.reader(h.ref).events({ follow: true, signal })) {
      if (event.kind === "mapping_progress" && event.payload.status === "running") {
        running.add(String(event.payload.mappingId));
        if (running.size === 2) {
          controller.abort();
          break;
        }
      }
    }
    assert.equal(value(await executing).outcome, "interrupted");
    const status = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(
      status.mappingPasses.map((pass) => [pass.mappingId, pass.status]),
      [
        ["a", "interrupted"],
        ["b", "interrupted"],
        ["c", "pending"],
      ],
    );
    assert.equal(status.worker.active, false);
    await execute(h);
    assert.equal(value(await h.engine.reader(h.ref).status()).state, "verified");
  });

  it(
    "recovers every running mapping after a killed writer and resumes pending mappings",
    { timeout: 20000 },
    async (t) => {
      const ids = ["a", "b", "c", "d"];
      const { input, selected } = multiMapping(ids);
      input.copyPasses = ids.map((sourceRootId) => ({ sourceRootId, pause: true, afterFiles: 1 }));
      const h = await harness(t, input, {
        ...selected,
        options: { mappingsInFlight: 3 },
      });
      await approve(h);
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { openEngine } from ${JSON.stringify(new URL("../src/engine/index.ts", import.meta.url).href)};
      import { FakeFileMigrationPort } from ${JSON.stringify(new URL("../src/engine/providers/fake.ts", import.meta.url).href)};
      const provider = new FakeFileMigrationPort(JSON.parse(process.env.COPY_FIXTURE));
      const startCopyPass = provider.startCopyPass.bind(provider);
      provider.startCopyPass = async (input) => {
        const handle = await startCopyPass(input);
        await provider.waitForCopyPassPaused(handle.jobid);
        return handle;
      };
      const engine = openEngine({
        home: process.env.COPY_HOME,
        now: () => new Date(${JSON.stringify(now)}),
        provider,
      });
      const ref = { id: process.env.COPY_JOB };
      const executing = engine.withWriterResult(ref, (writer) => writer.execute());
      const active = new Set();
      for await (const event of engine.reader(ref).events({ follow: true })) {
        if (event.kind === "mapping_progress" && event.payload.status === "running" && event.payload.files === 1) {
          active.add(event.payload.mappingId);
          if (active.size === 3) {
            process.stdout.write("checkpoint:3\\n");
            break;
          }
        }
      }
      await executing;
    `,
        ],
        {
          env: {
            ...process.env,
            COPY_HOME: h.home,
            COPY_JOB: h.ref.id,
            COPY_FIXTURE: JSON.stringify(input),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once("error", (error) => {
            stderr += error.message;
          });
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      const abort = () => {
        child.kill("SIGKILL");
      };
      t.signal.addEventListener("abort", abort, { once: true });
      t.after(async () => {
        t.signal.removeEventListener("abort", abort);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      });
      await new Promise<void>((resolve, reject) => {
        const onData = (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("checkpoint:3\n")) {
            cleanup();
            resolve();
          }
        };
        const fail = async (reason: string) => {
          cleanup();
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          const result = await closed;
          reject(
            new Error(
              `${reason}: code=${result.code} signal=${result.signal} stdout=${stdout} stderr=${stderr}`,
            ),
          );
        };
        const onClose = () => {
          void fail("Writer exited before concurrent checkpoint");
        };
        const timer = setTimeout(() => {
          void fail("Timed out waiting for concurrent checkpoint");
        }, 10000);
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.off("close", onClose);
        };
        child.stdout.setEncoding("utf8").on("data", onData);
        child.once("close", onClose);
      });
      const checkpoint = value(await h.engine.reader(h.ref).status());
      assert.equal(checkpoint.state, "executing");
      assert.equal(checkpoint.ownership.held, true);
      assert.equal(checkpoint.ownership.pid, child.pid);
      assert.equal(checkpoint.ownership.heldByThisProcess, false);
      const running = checkpoint.mappingPasses;
      assert.deepEqual(
        running.map((pass) => pass.status),
        ["running", "running", "running", "pending"],
      );
      assert.deepEqual(
        running.map((pass) => pass.lastStats?.files ?? null),
        [1, 1, 1, null],
      );
      assert.equal(
        new Set(running.filter((pass) => pass.status === "running").map((pass) => pass.executeId))
          .size,
        1,
      );
      child.kill("SIGKILL");
      assert.equal((await closed).signal, "SIGKILL");
      h.engine.close();
      // Only the injected engine clock advances; the writer really is dead.
      const port = new FakeFileMigrationPort({ ...input, copyPasses: [] });
      h.engine = openEngine({
        home: h.home,
        now: () => new Date(Date.parse(now) + 30001),
        provider: port,
      });
      value(
        await h.engine.withWriterResult(h.ref, async (writer) => {
          const recovered = value(await h.engine.reader(h.ref).status());
          assert.deepEqual(
            recovered.mappingPasses.map((pass) => pass.status),
            ["interrupted", "interrupted", "interrupted", "pending"],
          );
          return writer.execute();
        }),
      );
      const status = value(await h.engine.reader(h.ref).status());
      assert.equal(status.state, "verified");
      assert.deepEqual(
        status.mappingPasses.map((pass) => [pass.mappingId, pass.passNumber, pass.status]),
        [
          ["a", 1, "interrupted"],
          ["a", 2, "completed"],
          ["b", 1, "interrupted"],
          ["b", 2, "completed"],
          ["c", 1, "interrupted"],
          ["c", 2, "completed"],
          ["d", 1, "completed"],
        ],
      );
      assert.deepEqual(
        port
          .snapshotDestination()
          .filter((item) => item.kind === "file")
          .map((item) => item.path)
          .sort(),
        ["a/one.txt", "b/two.txt", "c/two.txt", "d/two.txt"],
      );
    },
  );

  it("freezes effective copy limits in the plan, including conservative defaults", async (t) => {
    for (const options of [undefined, { mappingsInFlight: 1, transfersPerMapping: 7 }]) {
      const h = await harness(t, fixture(), options ? { ...config, options } : config);
      await approve(h);
      const plan = value(await h.engine.reader(h.ref).status()).currentPlan!;
      const section = plan.sections.find((section) => section.title === "Copy concurrency");
      assert.ok(section);
      assert.deepEqual(
        JSON.parse(section.body),
        options ?? {
          mappingsInFlight: 2,
          transfersPerMapping: 4,
        },
      );
    }
  });

  it("keeps the configured number of mappings in flight and fills freed slots before slower passes finish", async (t) => {
    const ids = ["a", "b", "c", "d", "e"];
    const { input, selected } = multiMapping(ids);
    input.copyPasses = ids.map((sourceRootId) => ({ sourceRootId, pause: true, afterFiles: 0 }));
    const port = new FakeFileMigrationPort(input);
    const h = await harness(
      t,
      input,
      {
        ...selected,
        options: { mappingsInFlight: 2, transfersPerMapping: 3 },
      },
      port,
    );
    await approve(h);
    const signal = AbortSignal.timeout(5000);
    const executing = h.engine.withWriterResult(h.ref, (writer) => writer.execute({ signal }));
    const active = new Set<string>();
    const completed = new Set<string>();
    let filledWhileFirstRunning = false;
    for await (const event of h.engine.reader(h.ref).events({ follow: true, signal })) {
      if (event.kind !== "mapping_progress") continue;
      const id = String(event.payload.mappingId);
      if (event.payload.status === "running") {
        if (active.has(id)) continue;
        active.add(id);
        assert.ok(active.size <= 2);
        if (id === "c") {
          assert.ok(active.has("a"));
          filledWhileFirstRunning = true;
        }
        if (active.size === 2 || completed.size === 4) {
          const status = value(await h.engine.reader(h.ref).status());
          const pass = status.mappingPasses.find((pass) => pass.mappingId === id)!;
          port.releaseCopyPasses(pass.jobid!);
        }
        if (id === "e") port.releaseCopyPasses();
      } else if (event.payload.status === "completed") {
        active.delete(id);
        completed.add(id);
        if (completed.size === ids.length) break;
      }
    }
    assert.equal(value(await executing).outcome, "completed");
    assert.equal(filledWhileFirstRunning, true);
    assert.deepEqual([...completed].sort(), ids);
    assert.equal(value(await h.engine.reader(h.ref).status()).state, "verified");
  });

  it("copies and verifies multiple mappings end to end and emits per-mapping progress", async (t) => {
    const { input, selected } = multiMapping();
    const h = await harness(t, input, selected);
    await approve(h);
    assert.deepEqual(
      value(await h.engine.reader(h.ref).status()).mappingPasses.map((pass) => [
        pass.mappingId,
        pass.status,
      ]),
      [
        ["a", "pending"],
        ["b", "pending"],
      ],
    );
    await execute(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.state, "verified");
    assert.deepEqual(
      status.mappingPasses.map((pass) => [pass.mappingId, pass.status]),
      [
        ["a", "completed"],
        ["b", "completed"],
      ],
    );
    assert.deepEqual(
      h.port
        .snapshotDestination()
        .filter((item) => item.kind === "file")
        .map((item) => [item.path, item.checksum]),
      [
        ["a/one.txt", hash("one")],
        ["b/two.txt", hash("two")],
      ],
    );
    const events = [];
    for await (const event of h.engine.reader(h.ref).events({})) events.push(event);
    const progress = events.filter(
      (event) => event.kind === "mapping_progress" && event.payload.status === "completed",
    );
    assert.deepEqual(
      progress.map((event) => [
        event.payload.mappingId,
        event.payload.bytes,
        event.payload.files,
        event.payload.errors,
      ]),
      [
        ["a", 3, 1, 0],
        ["b", 3, 1, 0],
      ],
    );
    assert.ok(progress.every((event) => typeof event.payload.speed === "number"));
  });

  for (const error of [
    "googleapi: Error 403: User rate limit exceeded., userRateLimitExceeded",
    "googleapi: Error 403: User rate limit exceeded., rateLimitExceeded",
    "googleapi: Error 403: Quota exceeded., quotaExceeded",
  ]) {
    it(`blocks all mappings on a Drive upload quota stop: ${error}`, async (t) => {
      const { input, selected } = multiMapping(["a", "b", "c"]);
      const recordedAccount = error.endsWith("quotaExceeded")
        ? "service@project.iam.gserviceaccount.com"
        : undefined;
      input.googleAbout = {
        user: { emailAddress: recordedAccount ?? "files@example.test" },
        canCreateDrives: false,
      };
      input.copyPasses = [
        { sourceRootId: "a", error },
        { sourceRootId: "b", pause: true, afterFiles: 0 },
      ];
      const h = await harness(t, input, {
        ...selected,
        ...(recordedAccount ? {} : { impersonate: true, subject: "files@example.test" }),
      });
      await approve(h);
      const result = value(
        await h.engine.withWriterResult(h.ref, (writer) =>
          writer.execute({ signal: AbortSignal.timeout(2000) }),
        ),
      );
      assert.equal(result.outcome, "blocked");
      const quota = {
        code: "upload_quota_exceeded",
        hitAt: now,
        actingGoogleAccount: recordedAccount ?? "files@example.test",
        earliestResumeAt: "2026-09-02T00:00:00.000Z",
        resumeTimeIsEstimate: true,
      };
      assert.deepEqual(result.uploadQuota, quota);
      assert.equal(result.budget?.failedAttempts, 0);
      const status = value(await h.engine.reader(h.ref).status());
      assert.equal(status.state, "blocked");
      assert.equal(status.worker.active, false);
      assert.deepEqual(
        status.mappingPasses.map((pass) => [pass.mappingId, pass.status]),
        [
          ["a", "failed"],
          ["b", "interrupted"],
          ["c", "pending"],
        ],
      );
      assert.deepEqual(status.mappingPasses[0]?.uploadQuota, quota);
      assert.equal(status.mappingPasses[0]?.lastStats?.errors, null);
      assert.equal(status.mappingPasses[0]?.lastStats?.rcloneErrors, 1);
      const events = [];
      for await (const event of h.engine.reader(h.ref).events({})) events.push(event);
      assert.ok(
        events.some(
          (event) =>
            event.kind === "mapping_progress" &&
            event.payload.mappingId === "a" &&
            event.payload.status === "failed" &&
            event.payload.errors === null,
        ),
      );
      // No enforced cooldown: even with the same clock, unfinished mappings can resume.
      await execute(h);
      const resumed = value(await h.engine.reader(h.ref).status());
      assert.equal(resumed.state, "verified");
      assert.deepEqual(
        resumed.mappingPasses.map((pass) => [pass.mappingId, pass.passNumber, pass.status]),
        [
          ["a", 1, "failed"],
          ["a", 2, "completed"],
          ["b", 1, "interrupted"],
          ["b", 2, "completed"],
          ["c", 1, "completed"],
        ],
      );
    });
  }

  for (const error of [
    "googleapi: Error 403: User Rate Limit Exceeded, userRateLimitExceeded",
    "googleapi: Error 403: Rate Limit Exceeded, rateLimitExceeded",
    "googleapi: Error 403: Storage quota exceeded, storageQuotaExceeded",
    "googleapi: Error 403: Shared Drive file limit exceeded, teamDriveFileLimitExceeded",
    "googleapi: Error 403: Download quota exceeded, downloadQuotaExceeded",
  ]) {
    it(`does not report other Drive limits as daily upload quota: ${error}`, async (t) => {
      const { input, selected } = multiMapping(["a", "b", "c"]);
      input.copyPasses = [{ sourceRootId: "a", error }];
      const h = await harness(t, input, selected);
      await approve(h);
      const result = value(await h.engine.withWriterResult(h.ref, (writer) => writer.execute()));
      assert.equal(result.outcome, "blocked");
      assert.equal(result.uploadQuota, undefined);
      assert.equal(result.budget?.failedAttempts, 1);
      const status = value(await h.engine.reader(h.ref).status());
      assert.deepEqual(
        status.mappingPasses.map((pass) => [pass.mappingId, pass.status]),
        [
          ["a", "failed"],
          ["b", "completed"],
          ["c", "completed"],
        ],
      );
      assert.equal(status.mappingPasses[0]?.lastStats?.errors, 1);
    });
  }

  it("records rclone's failed mapping, continues other mappings, and retries only unfinished mappings", async (t) => {
    const { input, selected } = multiMapping();
    input.copyPasses = [{ sourceRootId: "a", error: "rclone: access denied" }];
    const h = await harness(t, input, selected);
    await approve(h);
    const failed = value(value(await h.engine.withWriter(h.ref, (writer) => writer.execute())));
    assert.equal(failed.outcome, "blocked");
    assert.equal(failed.budget?.failedAttempts, 1);
    const status = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(
      status.mappingPasses.map((pass) => [pass.mappingId, pass.status, pass.error]),
      [
        ["a", "failed", "rclone: access denied"],
        ["b", "completed", null],
      ],
    );
    await execute(h);
    const resumed = value(await h.engine.reader(h.ref).status());
    assert.equal(resumed.state, "verified");
    assert.deepEqual(
      resumed.mappingPasses.map((pass) => [pass.mappingId, pass.passNumber, pass.status]),
      [
        ["a", 1, "failed"],
        ["a", 2, "completed"],
        ["b", 1, "completed"],
      ],
    );
  });

  it(
    "cooperatively interrupts a partial mapping and resumes without duplicate files",
    { timeout: 10000 },
    async (t) => {
      const input = fixture();
      input.copyPasses = [{ pause: true, afterFiles: 1 }];
      const h = await harness(t, input);
      const startCopyPass = h.port.startCopyPass.bind(h.port);
      const pausedStart = t.mock.method(
        h.port,
        "startCopyPass",
        async (input: Parameters<typeof startCopyPass>[0]) => {
          const handle = await startCopyPass(input);
          await h.port.waitForCopyPassPaused(handle.jobid);
          return handle;
        },
      );
      await approve(h);
      const controller = new AbortController();
      const executing = h.engine.withWriterResult(h.ref, (writer) =>
        writer.execute({ signal: AbortSignal.any([controller.signal, t.signal]) }),
      );
      try {
        for await (const event of h.engine.reader(h.ref).events({
          follow: true,
          signal: AbortSignal.any([t.signal, AbortSignal.timeout(5000)]),
        })) {
          if (event.kind === "mapping_progress") {
            assert.equal(event.payload.files, 1);
            break;
          }
        }
      } finally {
        controller.abort();
        await executing;
        pausedStart.mock.restore();
      }
      assert.equal(value(await executing).outcome, "interrupted");
      const partial = h.port.snapshotDestination().filter((item) => item.kind === "file");
      assert.equal(partial.length, 1);
      const interrupted = value(await h.engine.reader(h.ref).status());
      assert.equal(interrupted.mappingPasses[0]?.status, "interrupted");
      assert.equal(interrupted.worker.active, false);
      h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
      await execute(h);
      const completed = value(await h.engine.reader(h.ref).status());
      assert.equal(completed.state, "verified");
      assert.equal(completed.mappingPasses[1]?.lastStats?.files, 1);
      const copies = h.port.snapshotDestination().filter((item) => item.kind === "file");
      assert.equal(copies.length, 2);
      assert.equal(copies.find((item) => item.path === partial[0]!.path)?.id, partial[0]!.id);
    },
  );

  it("records a completed rclone mapping pass and preserves copied content", async (t) => {
    const h = await harness(t);
    await approve(h);
    await execute(h);
    const status = value(await h.engine.reader(h.ref).status());
    assert.deepEqual(
      status.mappingPasses.map((pass) => [pass.mappingId, pass.passNumber, pass.status]),
      [["mapping", 1, "completed"]],
    );
    assert.equal(status.mappingPasses[0]?.lastStats?.files, 2);
    assert.deepEqual(
      h.port
        .snapshotDestination()
        .map((item) => item.path)
        .sort(),
      [".", "nested", "nested/empty", "nested/zero.bin", "report.docx"],
    );
    assert.equal(
      value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify()))).clean,
      true,
    );
  });

  it("preserves binary content and dates and skips completed mappings after reopening", async (t) => {
    const h = await harness(t);
    const approvedDigest = await approve(h);
    await execute(h);
    const first = h.port.snapshotDestination();
    assert.deepEqual(first.map((item) => item.path).sort(), [
      ".",
      "nested",
      "nested/empty",
      "nested/zero.bin",
      "report.docx",
    ]);
    const original = first.find((item) => item.path === "report.docx")!;
    assert.equal(original.kind, "file");
    assert.equal(original.checksum, hash(new Uint8Array([0, 255, 5, 0])));
    assert.equal(first.find((item) => item.path === "nested/zero.bin")?.checksum, hash(""));
    const copied = await h.port.resolveDestinationFolder({
      destDriveId: "destination-drive",
      destFolderId: original.id,
    });
    assert.equal(copied?.createdAt, "2020-01-01T01:02:03.000Z");
    assert.equal(copied?.modifiedAt, "2024-05-06T07:08:09.000Z");

    h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
    await execute(h);
    const second = h.port.snapshotDestination();
    assert.deepEqual(second, first);
    assert.equal(value(await h.engine.reader(h.ref).status()).mappingPasses.length, 1);
    const verification = value(
      value(await h.engine.withWriter(h.ref, (writer) => writer.verify())),
    );
    assert.equal(verification.clean, true);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.planDigest, approvedDigest);
  });

  it("retains source-deleted and unrelated destination objects without introducing exceptions", async (t) => {
    const input = fixture();
    input.destinationItems.push({
      id: "operator-owned",
      parentId: "destination-root",
      name: "keep.txt",
      kind: "file",
      content: "external",
    });
    const h = await harness(t, input, { ...config, options: { verificationMode: "hash" } });
    await approve(h);
    await execute(h);
    const copied = h.port.snapshotDestination().find((item) => item.path === "report.docx")!;
    h.port.deleteSourceItem("binary");
    await approve(h);
    await execute(h);
    assert.equal(
      h.port.snapshotDestination().find((item) => item.id === copied.id)?.checksum,
      copied.checksum,
    );
    assert.equal(
      h.port.snapshotDestination().find((item) => item.id === "operator-owned")?.checksum,
      hash("external"),
    );
    assert.equal(
      value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify()))).clean,
      true,
    );
    const retained = value(
      await h.engine.reader(h.ref).rows({
        phase: "verify",
        codes: ["destination_only_retained"],
      }),
    ).rows;
    assert.deepEqual(
      retained.map((item) => item.jobType === "file_migration" && item.relativePath).sort(),
      ["keep.txt", "report.docx"],
    );
    value(
      value(
        await h.engine.withWriter(h.ref, async (writer) => writer.close(await closeDecision(h))),
      ),
    );
    const report = value(value(await h.engine.withWriter(h.ref, (writer) => writer.report())));
    const json = report.artifacts.find((artifact) => artifact.name === "report.json")!;
    const findings = JSON.parse(await readFile(json.path, "utf8")).findings;
    assert.deepEqual(
      findings.find((entry: { evidence: { path: string } }) => entry.evidence.path === "keep.txt")
        .evidence,
      {
        path: "keep.txt",
        sourceSize: null,
        destinationSize: 8,
        sourceHash: null,
        destinationHash: hash("external"),
        hashType: "sha256",
      },
    );
  });

  it("reports corrupt destination bytes rather than a degraded comparison", async (t) => {
    const h = await harness(t, fixture(), { ...config, options: { verificationMode: "hash" } });
    await approve(h);
    await execute(h);
    const item = h.port.snapshotDestination().find((entry) => entry.path === "report.docx")!;
    h.port.mutateDestinationContent(item.id, new Uint8Array([1, 1, 1, 1]));
    const verification = value(
      value(await h.engine.withWriter(h.ref, (writer) => writer.verify())),
    );
    assert.equal(verification.clean, false);
    assert.ok(verification.findings.some((entry) => entry.code === "content_mismatch"));
    assert.equal(
      h.port.snapshotDestination().find((entry) => entry.id === item.id)?.checksum,
      hash(new Uint8Array([1, 1, 1, 1])),
    );
  });

  it("blocks nested mappings", async (t) => {
    const input = fixture();
    input.destinationItems.push({
      id: "other-root",
      parentId: null,
      name: "other",
      kind: "folder",
    });
    const selected: FileMigrationConfig = {
      mappings: [
        config.mappings[0]!,
        {
          ...config.mappings[0]!,
          id: "nested-mapping",
          sourceItemId: "folder",
          destFolderId: "other-root",
        },
      ],
    };
    const h = await harness(t, input, selected);
    const overlap = await h.engine.withWriterResult(h.ref, (writer) => writer.plan());
    assert.equal(overlap.ok, false);
    if (!overlap.ok) assert.equal(overlap.refusal.code, "configuration_invalid");
  });

  it("verifies matching paths and hashes without per-item provenance markers", async (t) => {
    const h = await harness(t, fixture(), { ...config, options: { verificationMode: "hash" } });
    await approve(h);
    const plan = value(await h.engine.reader(h.ref).status()).currentPlan!;
    assert.ok(
      plan.sections
        .filter((section) => section.body.startsWith("{"))
        .some((section) => JSON.parse(section.body).verificationMode === "hash"),
    );
    await execute(h);
    assert.ok(h.port.snapshotDestination().every((item) => item.provenance === null));
    const verified = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.equal(verified.clean, true);
    assert.deepEqual(verified.findings, []);
    value(
      value(
        await h.engine.withWriter(h.ref, async (writer) => writer.close(await closeDecision(h))),
      ),
    );
  });

  it("retains observed destination ids for matching and destination-only files", async (t) => {
    const h = await harness(t);
    await approve(h);
    await execute(h);
    const original = h.port.snapshotDestination().find((entry) => entry.path === "report.docx")!;
    h.port.removeDestinationItem(original.id);
    const replacement = await h.port.uploadDestinationContent({
      parentFolderId: "destination-root",
      name: "report.docx",
      content: new Uint8Array([0, 255, 5, 0]),
      createdAt: now,
      modifiedAt: now,
      mimeType: original.mimeType,
    });
    assert.notEqual(replacement.id, original.id);
    h.port.withholdDestinationChecksum(replacement.id);
    const verified = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.equal(verified.clean, true);
    const matching = value(
      await h.engine.reader(h.ref).rows({ phase: "verify", search: "report.docx" }),
    ).rows[0];
    assert.equal(
      matching?.jobType === "file_migration" && matching.destinationFileId,
      replacement.id,
    );
    h.port.deleteSourceItem("binary");
    const retained = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.equal(retained.clean, true);
    const leftover = value(
      await h.engine.reader(h.ref).rows({ phase: "verify", codes: ["destination_only_retained"] }),
    ).rows[0];
    assert.equal(
      leftover?.jobType === "file_migration" && leftover.destinationFileId,
      replacement.id,
    );
  });

  it("falls back per file to stored MD5 without downloading the destination", async (t) => {
    const h = await harness(t, fixture(), { ...config, options: { verificationMode: "hash" } });
    await approve(h);
    await execute(h);
    const item = h.port.snapshotDestination().find((entry) => entry.path === "report.docx")!;
    h.port.withholdDestinationChecksum(item.id);
    h.port.blockDestinationStream(item.id);
    assert.equal(
      value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify()))).clean,
      true,
    );
    h.port.mutateDestinationContent(item.id, new Uint8Array([1, 1, 1, 1]));
    const verified = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.deepEqual(
      verified.findings.map((entry) => entry.code),
      ["content_mismatch"],
    );
    const report = value(value(await h.engine.withWriter(h.ref, (writer) => writer.report())));
    const json = report.artifacts.find((artifact) => artifact.name === "report.json")!;
    const mismatch = JSON.parse(await readFile(json.path, "utf8")).findings[0];
    assert.deepEqual(mismatch.evidence, {
      path: "report.docx",
      sourceSize: 4,
      destinationSize: 4,
      hashType: "md5",
      sourceHash: "c9c9788f6ba353546d6f3723ddd869b6",
      destinationHash: "3b5b9852567ef7618aac7f5f2d74ef74",
    });
  });

  it("names an unreadable source without losing verification of readable files", async (t) => {
    const h = await harness(t, fixture(), { ...config, options: { verificationMode: "hash" } });
    await approve(h);
    await execute(h);
    h.port.mutateSourceItem("binary", { downloadable: false });
    const verified = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.deepEqual(
      verified.findings.map((entry) => entry.code),
      ["source_read_failed"],
    );
    const rows = await codes(h, "verify");
    assert.equal(rows.get("binary"), "source_read_failed");
    assert.equal(rows.get("zero"), "unchanged");
    const report = value(value(await h.engine.withWriter(h.ref, (writer) => writer.report())));
    const json = report.artifacts.find((artifact) => artifact.name === "report.json")!;
    assert.deepEqual(JSON.parse(await readFile(json.path, "utf8")).findings[0].evidence, {
      path: "report.docx",
      sourceSize: 4,
      destinationSize: 4,
      hashType: "sha256",
      sourceHash: null,
      destinationHash: hash(new Uint8Array([0, 255, 5, 0])),
    });
  });

  it("reports deleted and size-differing destination files with path and both sides' evidence", async (t) => {
    const h = await harness(t, fixture(), { ...config, options: { verificationMode: "hash" } });
    await approve(h);
    await execute(h);
    const items = h.port.snapshotDestination();
    h.port.removeDestinationItem(items.find((entry) => entry.path === "nested/zero.bin")!.id);
    const item = items.find((entry) => entry.path === "report.docx")!;
    h.port.mutateDestinationContent(item.id, Buffer.from("truncated"));
    const verified = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.deepEqual(verified.findings.map((entry) => entry.code).sort(), [
      "content_mismatch",
      "destination_missing",
      "size_mismatch",
    ]);
    const report = value(value(await h.engine.withWriter(h.ref, (writer) => writer.report())));
    const json = report.artifacts.find((artifact) => artifact.name === "report.json")!;
    const findings = JSON.parse(await readFile(json.path, "utf8")).findings;
    assert.deepEqual(
      findings.find((entry: { code: string }) => entry.code === "destination_missing").evidence,
      {
        path: "nested/zero.bin",
        sourceSize: 0,
        destinationSize: null,
        sourceHash: hash(""),
        destinationHash: null,
        hashType: "sha256",
      },
    );
    assert.deepEqual(
      findings.find((entry: { code: string }) => entry.code === "size_mismatch").evidence,
      {
        path: "report.docx",
        sourceSize: 4,
        destinationSize: 9,
        sourceHash: hash(new Uint8Array([0, 255, 5, 0])),
        destinationHash: hash("truncated"),
        hashType: "sha256",
      },
    );
  });

  it("distinguishes served-size inconsistency and destination-size mismatch when listed sizes agree", async (t) => {
    const h = await harness(
      t,
      fileFixture([
        {
          id: "still",
          parentId: "source-root",
          name: "photo.heic",
          kind: "file",
          content: Buffer.alloc(100),
          size: 100,
          mimeType: "image/heic",
        },
      ]),
      { ...config, options: { verificationMode: "hash" } },
    );
    await approve(h);
    await execute(h);
    h.port.mutateSourceItem("still", { content: Buffer.alloc(120, 1), size: 100 });
    const verified = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.deepEqual(verified.findings.map((entry) => entry.code).sort(), [
      "content_mismatch",
      "size_mismatch",
      "source_size_inconsistent",
    ]);
    const report = value(value(await h.engine.withWriter(h.ref, (writer) => writer.report())));
    const json = report.artifacts.find((artifact) => artifact.name === "report.json")!;
    const findings = JSON.parse(await readFile(json.path, "utf8")).findings;
    assert.deepEqual(
      findings.find((entry: { code: string }) => entry.code === "source_size_inconsistent")
        .evidence,
      {
        path: "photo.heic",
        sourceSize: 120,
        destinationSize: 100,
        listedSize: 100,
        servedSize: 120,
        hashType: "sha256",
        sourceHash: hash(Buffer.alloc(120, 1)),
        destinationHash: hash(Buffer.alloc(100)),
      },
    );
    for (const code of ["size_mismatch", "content_mismatch"]) {
      assert.deepEqual(findings.find((entry: { code: string }) => entry.code === code).evidence, {
        path: "photo.heic",
        sourceSize: 120,
        destinationSize: 100,
        listedSize: 100,
        sourceHash: hash(Buffer.alloc(120, 1)),
        destinationHash: hash(Buffer.alloc(100)),
        hashType: "sha256",
        cause: "source_size_inconsistent",
      });
    }
    const closed = value(
      await h.engine.withWriter(h.ref, async (writer) => writer.close(await closeDecision(h))),
    );
    assert.equal(closed.ok, false);
    if (closed.ok) throw new Error("Source changes must block close");
    assert.equal(closed.refusal.code, "verification_unaccepted");
  });

  it("copies what the source serves when its listed size disagrees, and names that for acceptance", async (t) => {
    // SharePoint can list a size its download contradicts (rewritten Office files,
    // iOS Live Photos). The served bytes are what exists, so they are copied.
    const input = fileFixture([
      {
        id: "still",
        parentId: "source-root",
        name: "photo.heic",
        kind: "file",
        content: "still frame",
        size: 999,
        mimeType: "image/heic",
      },
    ]);
    const h = await harness(t, input, { ...config, options: { verificationMode: "hash" } });
    await approve(h);
    await execute(h);
    const copied = h.port.snapshotDestination().find((entry) => entry.path === "photo.heic");
    assert.equal(copied?.checksum, hash("still frame"));

    const first = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    const found = first.findings.map((entry) => entry.code);
    assert.ok(found.includes("source_size_inconsistent"));
    assert.equal(found.includes("size_mismatch"), false);
    assert.equal(found.includes("content_mismatch"), false);
    const [named] = value(
      await h.engine.reader(h.ref).rows({ phase: "verify", codes: ["source_size_inconsistent"] }),
    ).rows;
    assert.equal(named?.jobType === "file_migration" && named.provenanceState, "verified");
    const accept = async (verificationDigest: string) =>
      value(
        value(
          await h.engine.withWriter(h.ref, (writer) =>
            writer.accept({
              verificationDigest,
              approver: "operator",
              codes: ["source_size_inconsistent"],
              rationale: "Source-served bytes retained",
              mode: "unattended",
            }),
          ),
        ),
      );
    await accept(first.verificationDigest);

    // Completed mappings stay complete on an execute retry.
    await execute(h);
    assert.equal(value(await h.engine.reader(h.ref).status()).mappingPasses.length, 1);
    assert.equal(
      h.port.snapshotDestination().find((entry) => entry.path === "photo.heic")?.id,
      copied?.id,
    );

    await accept(
      value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())))
        .verificationDigest,
    );
    value(
      value(
        await h.engine.withWriter(h.ref, async (writer) => writer.close(await closeDecision(h))),
      ),
    );
    const report = value(value(await h.engine.withWriter(h.ref, (writer) => writer.report())));
    const json = report.artifacts.find((artifact) => artifact.name === "report.json");
    assert.ok(json);
    const [exception] = JSON.parse(await readFile(json.path, "utf8")).acceptedExceptions;
    assert.equal(exception.code, "source_size_inconsistent");
    assert.deepEqual(exception.items[0].evidence, {
      path: "photo.heic",
      listedSize: 999,
      servedSize: 11,
      sourceSize: 11,
      destinationSize: 11,
      sourceHash: hash("still frame"),
      destinationHash: hash("still frame"),
      hashType: "sha256",
    });
  });
});

describe("listing-settled final passes", () => {
  it("catches an approved file changing after copy before final verification", async () => {
    class MutatingPort extends FakeFileMigrationPort {
      changed = false;
      override async copyPassStatus(
        reference: Parameters<FakeFileMigrationPort["copyPassStatus"]>[0],
      ) {
        const status = await super.copyPassStatus(reference);
        if (status.state === "completed" && !this.changed) {
          this.changed = true;
          this.mutateSourceItem("binary", { content: "changed after the first copy" });
        }
        return status;
      }
    }
    const port = new MutatingPort(fixture());
    const worker = await port.startTransferWorker({ runDirectory: "/tmp/settled-driver-proof" });
    const ctx: DriverContext<FileMigrationConfig> = {
      jobDirectory: "/tmp/settled-driver-proof",
      config: { ...config, options: { staged: true, consistencyIntervalMs: 0 } },
      revision: 1,
      stage: "final",
      resume: { checkpoint: null, watermarks: {}, rows: [], mappingPasses: [] },
      provider: port,
      now: () => new Date(now),
    };
    try {
      for await (const unit of fileMigrationDriver.collect(ctx))
        ctx.resume.rows!.push(...unit.rows);
      assert.equal(ctx.resume.rows!.length, 1);
      const planned = ctx.resume.rows![0]!;
      assert.ok(planned.jobType === "file_migration");
      assert.deepEqual(planned.fileScope, { mapOnly: true });
      const completed = new Set<number>();
      for await (const unit of fileMigrationDriver.execute(ctx)) {
        if (unit.watermark) ctx.resume.watermarks[unit.watermark.unitKey] = unit.watermark.value;
        if (unit.mappingPass?.status === "completed") completed.add(unit.mappingPass.passNumber);
      }
      assert.equal(
        port.snapshotDestination().find((item) => item.path === "report.docx")?.checksum,
        hash("changed after the first copy"),
      );
      assert.equal(completed.size, 2);
      const settled = JSON.parse(ctx.resume.watermarks["file-settle:mapping"]!);
      assert.equal(settled.outcome, "settled");
      assert.equal(settled.passes, 1);
    } finally {
      await port.stopTransferWorker(worker);
    }
  });

  async function stagedContext(t: TestContext, options: FileMigrationConfig["options"] = {}) {
    const port = new FakeFileMigrationPort(fixture());
    const worker = await port.startTransferWorker({ runDirectory: "/tmp/staged-driver-proof" });
    t.after(() => port.stopTransferWorker(worker));
    const ctx: DriverContext<FileMigrationConfig> = {
      jobDirectory: "/tmp/staged-driver-proof",
      config: { ...config, options: { staged: true, consistencyIntervalMs: 0, ...options } },
      revision: 1,
      stage: "final",
      resume: { checkpoint: null, watermarks: {}, rows: [], mappingPasses: [] },
      provider: port,
      now: () => new Date(now),
    };
    return { ctx, port };
  }

  async function consume(
    ctx: DriverContext<FileMigrationConfig>,
    units: AsyncIterable<CommitUnit>,
  ) {
    const result: CommitUnit[] = [];
    for await (const unit of units) {
      result.push(unit);
      ctx.resume.rows!.push(...unit.rows);
      if (unit.watermark) ctx.resume.watermarks[unit.watermark.unitKey] = unit.watermark.value;
      if (unit.mappingPass) {
        const index = ctx.resume.mappingPasses!.findIndex(
          (pass) => pass.passNumber === unit.mappingPass!.passNumber,
        );
        if (index < 0) ctx.resume.mappingPasses!.push(unit.mappingPass);
        else ctx.resume.mappingPasses![index] = unit.mappingPass;
      }
    }
    return result;
  }

  it("persists exhaustion so resuming never starts a new final catch-up budget", async (t) => {
    const { ctx, port } = await stagedContext(t, { settleMaxPasses: 1, consistencyIntervalMs: 17 });
    let observations = 0;
    ctx.waitForConsistency = async (milliseconds) => {
      assert.equal(milliseconds, 17);
      port.mutateSourceItem("binary", { content: "changed".repeat(++observations) });
    };
    await consume(ctx, fileMigrationDriver.collect(ctx));
    await assert.rejects(consume(ctx, fileMigrationDriver.execute(ctx)), {
      code: "cutover_incomplete",
    });
    assert.equal(observations, 2);
    assert.equal(JSON.parse(ctx.resume.watermarks["file-settle:mapping"]!).outcome, "exhausted");
    await assert.rejects(consume(ctx, fileMigrationDriver.execute(ctx)), {
      code: "cutover_incomplete",
    });
    assert.equal(observations, 2);
    await assert.rejects(consume(ctx, fileMigrationDriver.verify(ctx)), {
      code: "cutover_incomplete",
    });
  });

  it("catches up new source paths within the approved mapping", async (t) => {
    const { ctx, port } = await stagedContext(t);
    ctx.waitForConsistency = async () => {
      port.mutateSourceItem("binary", { name: "unapproved.docx" });
    };
    await consume(ctx, fileMigrationDriver.collect(ctx));
    await consume(ctx, fileMigrationDriver.execute(ctx));
    assert.equal(
      port.snapshotDestination().some((item) => item.path === "unapproved.docx"),
      true,
    );
  });

  it("keeps a final mirror deletion budget cumulative across catch-up passes", async (t) => {
    const h = await provisioningHarness(t, fixture(), {
      staged: true,
      memberGrants: "before_copy",
      mirror: true,
      deleteLimit: 1,
      consistencyIntervalMs: 0,
    });
    await execute(h);
    const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
    h.port.deleteSourceItem("binary");
    const plan = value(
      await h.engine.withWriterResult(h.ref, (writer) => writer.plan({ final: true })),
    );
    value(
      await h.engine.withWriterResult(h.ref, (writer) =>
        writer.approve({
          approver: "operator",
          mode: "unattended",
          planDigest: plan.planDigest,
          freeze: { by: "operator", at: now, how: "writers stopped" },
        }),
      ),
    );
    h.engine = openEngine({
      home: h.home,
      now: () => new Date(now),
      provider: h.port,
      waitForConsistency: async () => {
        h.port.mutateSourceItem("zero", { content: "changed after first final pass" });
        await h.port.uploadDestinationContent({
          parentFolderId: driveId,
          name: "report.docx",
          content: new Uint8Array([7]),
          createdAt: now,
          modifiedAt: now,
          mimeType: null,
        });
      },
    });
    const result = await h.engine.withWriterResult(h.ref, (writer) => writer.execute());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, "plan_revision_required");
    const retained = (await h.port.listDestinationChildren(driveId)).find(
      (item) => item.name === "report.docx",
    );
    assert.ok(
      retained,
      "an already-consumed deletion authorization must not delete recreated content",
    );
  });

  it("charges an interrupted durable copy attempt to the original catch-up bound", async (t) => {
    const { ctx, port } = await stagedContext(t, { settleMaxPasses: 1 });
    await consume(ctx, fileMigrationDriver.collect(ctx));
    const interrupted = fileMigrationDriver.execute(ctx)[Symbol.asyncIterator]();
    const first = await interrupted.next();
    assert.ok(!first.done && first.value.watermark);
    ctx.resume.watermarks[first.value.watermark.unitKey] = first.value.watermark.value;
    await interrupted.return?.();
    const before = JSON.parse(ctx.resume.watermarks["file-settle:mapping"]!);
    assert.equal(before.copyPending, true);
    ctx.waitForConsistency = async () => {
      port.mutateSourceItem("binary", { content: "changes after resumed copy" });
    };
    await assert.rejects(consume(ctx, fileMigrationDriver.execute(ctx)), {
      code: "cutover_incomplete",
    });
    const after = JSON.parse(ctx.resume.watermarks["file-settle:mapping"]!);
    assert.equal(after.maxPasses, 1);
    assert.equal(after.passes, 1);
    assert.equal(after.outcome, "exhausted");
  });
});

describe("human decision authority", () => {
  it("preserves approved access when source scope changes but still requires mirror confirmation", async (t) => {
    const h = await provisioningHarness(t, fixture(), {
      mirror: true,
      deleteLimit: 3,
      memberGrants: "after_verification",
    });
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: [
              {
                id: "finance",
                source: { type: "sharepoint", driveId: "source-drive", folderPath: "nested" },
                destination: { type: "google_shared_drive", create: "Finance" },
                members: [{ email: "finance@example.com", type: "group", role: "writer" }],
              },
            ],
          }),
        }),
      ),
    );
    const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).approvalAuthority, {
      mirrorChanges: [
        {
          mappingId: "finance",
          source: "source-drive/nested",
          destination: "Finance",
          deleteLimit: 3,
          previousDeleteLimit: null,
        },
      ],
      accessChanges: [],
    });
    const missingMirror = await h.engine.withWriterResult(h.ref, (w) =>
      w.approve({
        planDigest: plan.planDigest,
        approver: "human@host",
        mode: "interactive",
      }),
    );
    assert.equal(missingMirror.ok, false);
    if (!missingMirror.ok) assert.equal(missingMirror.refusal.code, "approval_required");
    assert.equal(value(await h.engine.reader(h.ref).status()).currentApproval, null);
    const approved = value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.approve({
          planDigest: plan.planDigest,
          approver: "human@host",
          mode: "interactive",
          riskConfirmations: { mirror: true },
        }),
      ),
    );
    assert.deepEqual(approved.riskConfirmations, { mirror: true });
  });

  for (const change of [
    {
      name: "a new creation identity with the same drive name",
      id: "finance-new",
      destination: "Finance",
      email: "finance@example.com",
      role: "writer",
      previousRole: null,
    },
    {
      name: "a different destination name",
      id: "finance",
      destination: "New Finance",
      email: "finance@example.com",
      role: "writer",
      previousRole: null,
    },
    {
      name: "a new member grant",
      id: "finance",
      destination: "Finance",
      email: "new-member@example.com",
      role: "writer",
      previousRole: null,
    },
    {
      name: "a member role escalation",
      id: "finance",
      destination: "Finance",
      email: "finance@example.com",
      role: "organizer",
      previousRole: "writer",
    },
  ])
    it(`requires access confirmation for ${change.name} even when source scope changes`, async (t) => {
      const h = await provisioningHarness(t, fixture(), {
        mirror: true,
        deleteLimit: 3,
        memberGrants: "after_verification",
      });
      value(
        await h.engine.withWriterResult(h.ref, (w) =>
          w.loadManifest({
            format: "json",
            content: JSON.stringify({
              version: 1,
              mappings: [
                {
                  id: change.id,
                  source: { type: "sharepoint", driveId: "source-drive", folderPath: "nested" },
                  destination: { type: "google_shared_drive", create: change.destination },
                  members: [{ email: change.email, type: "group", role: change.role }],
                },
              ],
            }),
          }),
        ),
      );
      const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
      const authority = value(await h.engine.reader(h.ref).status()).approvalAuthority!;
      assert.equal(authority.mirrorChanges.length, 1);
      assert.equal(authority.mirrorChanges[0]!.mappingId, change.id);
      assert.deepEqual(authority.accessChanges, [
        {
          mappingId: change.id,
          email: change.email,
          type: "group",
          role: change.role,
          previousRole: change.previousRole,
          timing: "after_verification",
        },
      ]);
      const missingAccess = await h.engine.withWriterResult(h.ref, (w) =>
        w.approve({
          planDigest: plan.planDigest,
          approver: "human@host",
          mode: "interactive",
          riskConfirmations: { mirror: true },
        }),
      );
      assert.equal(missingAccess.ok, false);
      if (!missingAccess.ok) assert.equal(missingAccess.refusal.code, "approval_required");
      assert.equal(value(await h.engine.reader(h.ref).status()).currentApproval, null);
      const approved = value(
        await h.engine.withWriterResult(h.ref, (w) =>
          w.approve({
            planDigest: plan.planDigest,
            approver: "human@host",
            mode: "interactive",
            riskConfirmations: { mirror: true, access: true },
          }),
        ),
      );
      assert.deepEqual(approved.riskConfirmations, { mirror: true, access: true });
    });

  it("compares mirror limits and role escalation with the latest approved plan, not declined revisions", async (t) => {
    const h = await provisioningHarness(t, fixture(), {
      mirror: true,
      deleteLimit: 3,
      memberGrants: "after_verification",
    });
    const path = join(h.home, "jobs", h.ref.id, "job.toml");
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace("deleteLimit = 3", "deleteLimit = 8"));
    const declined = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
    assert.equal(
      value(await h.engine.reader(h.ref).status()).approvalAuthority?.mirrorChanges[0]
        ?.previousDeleteLimit,
      3,
    );
    const missingChallenge = await h.engine.withWriterResult(h.ref, (w) =>
      w.approve({
        planDigest: declined.planDigest,
        approver: "human@host",
        mode: "interactive",
      }),
    );
    assert.equal(missingChallenge.ok, false);
    assert.equal(value(await h.engine.reader(h.ref).status()).currentApproval, null);
    await writeFile(path, original.replace("deleteLimit = 3", "deleteLimit = 5"));
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
                members: [{ email: "finance@example.com", type: "group", role: "organizer" }],
              },
            ],
          }),
        }),
      ),
    );
    const proposed = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
    const review = value(await h.engine.reader(h.ref).status());
    assert.equal(review.approvalAuthority?.mirrorChanges[0]?.deleteLimit, 5);
    assert.equal(review.approvalAuthority?.mirrorChanges[0]?.previousDeleteLimit, 3);
    assert.equal(review.approvalAuthority?.accessChanges[0]?.previousRole, "writer");
    const stale = await h.engine.withWriterResult(h.ref, (w) =>
      w.approve({
        planDigest: declined.planDigest,
        approver: "stale@host",
        mode: "interactive",
        riskConfirmations: { mirror: true, access: true },
      }),
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.refusal.code, "approval_digest_stale");
    const approved = value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.approve({
          planDigest: proposed.planDigest,
          approver: "human@host",
          mode: "interactive",
          riskConfirmations: { mirror: true, access: true },
        }),
      ),
    );
    assert.equal(approved.identityAssurance, "declared_unverified");
    assert.deepEqual(approved.riskConfirmations, { mirror: true, access: true });
    const unchanged = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).approvalAuthority, {
      mirrorChanges: [],
      accessChanges: [],
    });
    const automated = value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.approve({
          planDigest: unchanged.planDigest,
          approver: "automation",
          mode: "unattended",
          riskConfirmations: { mirror: true, access: true },
        }),
      ),
    );
    assert.equal(automated.riskConfirmations, undefined);
    assert.equal(
      value(await h.engine.reader(h.ref).status()).lastInteractiveIdentity,
      "human@host",
    );
  });

  it("refuses stale close review and failed risk confirmation without new authority", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    const reviewed = value(await h.engine.reader(h.ref).status()).closeReview!;
    assert.ok(
      reviewed.consequences.some(
        (line) => line.includes("finance@example.com") && line.includes("writer"),
      ),
    );
    const declined = await h.engine.withWriterResult(h.ref, (w) =>
      w.close({
        evidenceDigest: reviewed.evidenceDigest,
        approver: "human@host",
        mode: "interactive",
      }),
    );
    assert.equal(declined.ok, false);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    const stale = await h.engine.withWriterResult(h.ref, (w) =>
      w.close({
        evidenceDigest: reviewed.evidenceDigest,
        approver: "human@host",
        mode: "interactive",
        confirmGoLive: true,
      }),
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.refusal.code, "approval_digest_stale");
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.closeAuthorization, null);
    assert.deepEqual(status.memberGrants, []);
    assert.ok(status.createdDrives.every((drive) => !drive.goLive));
  });

  for (const failure of ["render", "abort"] as const)
    it(`records no authority, fence or grant when readiness ${failure}s`, async (t) => {
      const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
      await execute(h);
      const decision = (await closeDecision(h))!;
      const controller = new AbortController();
      const originalSections = fileMigrationDriver.reportSections;
      t.mock.method(
        fileMigrationDriver,
        "reportSections",
        async function* (ctx: DriverContext<FileMigrationConfig>) {
          if (failure === "render") throw new Error("readiness unavailable");
          yield* originalSections(ctx);
          controller.abort(new Error("decision interrupted"));
        },
      );
      await assert.rejects(
        h.engine.withWriterResult(h.ref, (w) =>
          w.close({
            ...decision,
            signal: controller.signal,
          }),
        ),
        failure === "render" ? /readiness unavailable/ : /decision interrupted/,
      );
      const status = value(await h.engine.reader(h.ref).status());
      assert.equal(status.state, "verified");
      assert.equal(status.closeAuthorization, null);
      assert.deepEqual(status.memberGrants, []);
      assert.ok(status.createdDrives.every((drive) => !drive.goLive));
      const recovery = await h.engine.withWriterResult(h.ref, (w) => w.close());
      assert.equal(recovery.ok, false);
      if (!recovery.ok) assert.equal(recovery.refusal.code, "approval_required");
    });
});
