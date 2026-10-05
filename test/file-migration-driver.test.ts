import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
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
import { ProviderFault } from "../src/engine/providers/credentials.ts";
import { fileConfig, fileFixture, value, approve } from "./engine-fixture.ts";

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
  it("refuses a complete stale inventory before any transfer", async (t) => {
    const h = await harness(t, fixture(), { ...config, options: { staged: true } });
    await approve(h);
    h.port.mutateSourceItem("binary", { content: "a newer version" });
    const result = await h.engine.withWriterResult(h.ref, (writer) => writer.execute());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, "plan_revision_required");
    assert.deepEqual(
      h.port.snapshotDestination().map((item) => item.path),
      ["."],
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
    const early = await h.engine.withWriterResult(h.ref, (writer) => writer.close());
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
    const stale = await h.engine.withWriterResult(h.ref, (writer) => writer.close());
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

describe("rclone proof", () => {
  const rclone = { proof: "rclone" as const, consistencyIntervalMs: 0 };

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
      value(await h.engine.withWriterResult(h.ref, (w) => w.close())).outcome,
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
    const refused = await h.engine.withWriterResult(h.ref, (w) => w.close());
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
    h.port.deleteSourceItem("a");
    await approve(h);
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
    value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
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

  it("verifies only at the proof level the plan approved", async (t) => {
    const h = await harness(t, fixture(), config);
    await approve(h);
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.onboard({ ...config, options: rclone })));
    const refused = await h.engine.withWriterResult(h.ref, (w) => w.verify());
    assert.equal(refused.ok, false);
    if (!refused.ok)
      assert.deepEqual(
        [refused.refusal.code, refused.refusal.detail?.field],
        ["plan_revision_required", "options.proof"],
      );
  });

  it("refuses options that need the per-file inventory", async (t) => {
    for (const [options, field] of [
      [{ verificationMode: "size_only" }, "options.verificationMode"],
      [{ deltaVerification: "changed" }, "options.deltaVerification"],
      [{ oneNoteNotebooks: "omit" }, "options.oneNoteNotebooks"],
    ] as const) {
      const home = await mkdtemp(join(tmpdir(), "migmate-rclone-proof-"));
      t.after(() => rm(home, { recursive: true, force: true }));
      const engine = openEngine({ home, provider: new FakeFileMigrationPort(fixture()) });
      const init = await engine.initJob({
        type: "file_migration",
        config: { ...config, options: { ...options, proof: "rclone" } },
      });
      assert.equal(init.ok, false);
      if (!init.ok) assert.equal(init.refusal.detail?.field, field);
    }
    const h = await harness(t, fixture(), {
      mappings: config.mappings.map((mapping) => ({
        ...mapping,
        exclusions: [{ sourceItemId: "binary", reason: "Not migrated" }],
      })),
      options: rclone,
    });
    const plan = await h.engine.withWriterResult(h.ref, (w) => w.plan());
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.equal(plan.refusal.detail?.field, "exclusions");
  });
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
                route: "shared_drive_to_sharepoint_library",
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
        const closed = await h.engine.withWriterResult(h.ref, (writer) => writer.close());
        assert.equal(closed.ok, false);
        if (!closed.ok) assert.equal(closed.refusal.code, "verification_unaccepted");
      });
    }
  }
});

describe("Google Shared Drives to SharePoint", () => {
  const reverse = { mappings: [], route: "shared_drive_to_sharepoint_library" };
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
    const h = await harness(t, fixture(), reverse);
    value(await load(h, [both[0]]));
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
    assert.match(JSON.stringify(json), /shared_drive_to_sharepoint_library/);
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
    const h = await harness(t, input, reverse);
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
    const closed = value(await h.engine.withWriter(h.ref, (writer) => writer.close()));
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
          mappings: [
            {
              id: "finance",
              source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
              destination: { type: "google_shared_drive", create: "Finance" },
              members: [{ email: "finance@example.com", type: "group", role: "writer" }],
            },
          ],
        }),
      }),
    ),
  );
  await approve(h);
  return h;
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
    { id: "other-package", parentId: "source-root", name: "Other", kind: "package" },
  ]);
}

describe("OneNote notebook policy", () => {
  it("makes default omissions actionable in plan, verification and report", async (t) => {
    const h = await harness(t, notebookFixture());
    await approve(h);
    assert.equal((await codes(h, "plan")).get("notebook"), "source_package_omitted");
    assert.equal((await codes(h, "plan")).has("section"), false);
    for (const phase of ["plan", "verify"]) {
      if (phase === "verify") {
        await execute(h);
        value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
      }
      const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
      const json = JSON.parse(
        await readFile(report.artifacts.find((a) => a.name === "report.json")!.path, "utf8"),
      );
      const evidence = json.findings.find(
        (f: { phase: string; subjectId: string; code: string }) =>
          f.phase === phase && f.subjectId === "notebook" && f.code === "source_package_omitted",
      ).evidence;
      assert.equal(evidence.webUrl, "https://example.sharepoint.com/Notes");
      assert.equal(evidence.sectionCount, 1);
      assert.equal(typeof evidence.reason, "string");
      assert.equal(typeof evidence.nextStep, "string");
      const other = json.findings.find(
        (f: { phase: string; subjectId: string }) =>
          f.phase === phase && f.subjectId === "other-package",
      );
      assert.equal(other.evidence.nextStep, null);
    }
    assert.deepEqual(
      h.port.snapshotDestination().filter((entry) => entry.kind === "file"),
      [],
    );
  });
  it("copies notebook files, verifies their bytes, skips unchanged deltas and mirrors deleted sections", async (t) => {
    const h = await provisioningHarness(t, notebookFixture(), {
      oneNoteNotebooks: "copy",
      mirror: true,
      deleteLimit: 1,
    });
    assert.equal((await codes(h, "plan")).get("notebook"), "source_package_copied_as_files");
    assert.equal((await codes(h, "plan")).get("other-package"), "source_package_omitted");
    assert.equal((await codes(h, "plan")).get("section"), "created");
    const plan = value(await h.engine.reader(h.ref).status()).currentPlan!;
    assert.ok(plan.sections.some((section) => section.title === "OneNote notebooks"));
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
    assert.notEqual((await codes(h, "verify")).get("notebook"), "source_package_omitted");
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
    const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
    const json = JSON.parse(
      await readFile(report.artifacts.find((a) => a.name === "report.json")!.path, "utf8"),
    );
    for (const sections of [plan.sections, json.sections]) {
      const disclosure = sections.find((s: { title: string }) => s.title === "OneNote notebooks");
      assert.ok(disclosure);
    }
  });

  it("reports a file where a copied notebook's folder belongs", async (t) => {
    const h = await provisioningHarness(t, notebookFixture(), { oneNoteNotebooks: "copy" });
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

  it("strictly validates notebook policy and refuses copy on the reverse route", async (t) => {
    const h = await harness(t);
    for (const oneNoteNotebooks of ["zip", true, null, "COPY", 1, "copy"]) {
      const result = await h.engine.initJob({
        type: "file_migration",
        config: {
          mappings: [],
          route: "shared_drive_to_sharepoint_library",
          options: { oneNoteNotebooks },
        },
      });
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("Invalid notebook policy must refuse");
      assert.equal(result.refusal.code, "configuration_invalid");
      assert.deepEqual(result.refusal.detail, { field: "options.oneNoteNotebooks" });
    }
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
    value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
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
    const early = await h.engine.withWriterResult(h.ref, (w) => w.close());
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
    value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
    const closed = value(await h.engine.reader(h.ref).status());
    assert.equal(closed.state, "closed");
    assert.equal(closed.memberGrants[0]?.member.email, "finance@example.com");
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
        h.engine.withWriterResult(h.ref, (w) => w.close()),
        /grant crash/,
      );
      h.engine.close();
      h.engine = openEngine({ home: h.home, now: () => new Date(now), provider: h.port });
      const refused = await h.engine.withWriterResult(h.ref, (w) => w.execute());
      assert.equal(refused.ok, false);
      if (!refused.ok) assert.equal(refused.refusal.code, "go_live_started");
      const before = value(await h.engine.reader(h.ref).status()).mappingPasses;
      value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
      const closed = value(await h.engine.reader(h.ref).status());
      assert.equal(closed.state, "closed");
      assert.equal(closed.memberGrants.length, 1);
      assert.deepEqual(closed.mappingPasses, before);
    });
  for (const drift of ["membership", "content"] as const)
    it(`blocks go-live on ${drift} drift and never reopens transfers`, async (t) => {
      const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
      await execute(h);
      value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
      const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
      if (drift === "membership")
        await h.port.addDriveMember(driveId, {
          email: "outside@example.com",
          type: "user",
          role: "writer",
        });
      else {
        const file = (await h.port.listDestinationChildren(driveId)).find(
          (item) => item.name === "report.docx",
        )!;
        h.port.mutateDestinationContent(file.id, new Uint8Array([9, 9, 9, 9]));
      }
      const closing = await h.engine.withWriterResult(h.ref, (w) => w.close());
      assert.equal(closing.ok, false);
      if (!closing.ok) {
        assert.equal(closing.refusal.code, "verification_unaccepted");
        assert.equal(closing.refusal.detail?.accessMayExist, true);
        assert.equal(
          closing.refusal.detail?.check,
          drift === "membership" ? "drive_membership_mismatch" : "destination_drift",
        );
      }
      const status = value(await h.engine.reader(h.ref).status());
      assert.notEqual(status.state, "closed");
      assert.equal(status.memberGrants[0]?.member.email, "finance@example.com");
      const executeResult = await h.engine.withWriterResult(h.ref, (w) => w.execute());
      assert.equal(executeResult.ok, false);
      if (!executeResult.ok) assert.equal(executeResult.refusal.code, "go_live_started");
      const retry = await h.engine.withWriterResult(h.ref, (w) => w.close());
      assert.equal(retry.ok, false);
    });
  it("writes the final grant and check evidence before closing", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
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
      verificationMode: "size_only",
    });
    await execute(h);
    const verification = value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    assert.equal(verification.clean, false);
    const refused = await h.engine.withWriterResult(h.ref, (w) => w.close());
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
          codes: [{ code: "content_verification_degraded" }],
        }),
      ),
    );
    value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
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
      h.engine.withWriterResult(h.ref, (w) => w.close()),
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
    const mismatch = await h.engine.withWriterResult(h.ref, (w) => w.close());
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
    value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
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
    const closing = await h.engine.withWriterResult(h.ref, (w) => w.close());
    assert.equal(closing.ok, false);
    if (!closing.ok) assert.equal(closing.refusal.code, "plan_revision_required");
    assert.deepEqual(value(await h.engine.reader(h.ref).status()).memberGrants, []);
    await writeFile(path, original);
    value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
  });
  it("discloses unavailable post-grant checks and resumes close without transfers", async (t) => {
    const h = await provisioningHarness(t, fixture(), { memberGrants: "after_verification" });
    await execute(h);
    value(await h.engine.withWriterResult(h.ref, (w) => w.verify()));
    h.port.scriptEffect({
      method: "listFileHashes",
      count: 1,
      error: new TypeError("listing unavailable"),
    });
    const closing = await h.engine.withWriterResult(h.ref, (w) => w.close());
    assert.equal(closing.ok, false);
    if (!closing.ok) {
      assert.equal(closing.refusal.code, "verification_unaccepted");
      assert.equal(closing.refusal.detail?.accessMayExist, true);
      assert.equal(closing.refusal.detail?.check, "go_live_check_unavailable");
    }
    const partial = value(await h.engine.reader(h.ref).status());
    assert.equal(partial.memberGrants.length, 1);
    assert.equal(partial.createdDrives[0]!.goLive!.check!.status, "failed");
    value(await h.engine.withWriterResult(h.ref, (w) => w.close()));
    assert.deepEqual(
      value(await h.engine.reader(h.ref).status()).mappingPasses,
      partial.mappingPasses,
    );
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
  it("refuses an over-limit mirror plan before any mapping can execute", async (t) => {
    const input = multiMapping().input;
    input.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
    const h = await harness(t, input, { mappings: [], options: { mirror: true, deleteLimit: 0 } });
    value(
      await h.engine.withWriterResult(h.ref, (w) =>
        w.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: ["a", "b"].map((id) => ({
              id,
              source: { type: "sharepoint", driveId: "source-drive", folderPath: id },
              destination: { type: "google_shared_drive", create: id },
            })),
          }),
        }),
      ),
    );
    await approve(h);
    await execute(h);
    h.port.deleteSourceItem("a-file");
    h.port.mutateSourceItem("b-file", { content: "changed" });
    const plan = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
    const approval = await h.engine.withWriterResult(h.ref, (writer) =>
      writer.approve({
        approver: "operator",
        mode: "unattended",
        planDigest: plan.planDigest,
      }),
    );
    assert.equal(approval.ok, false);
    if (!approval.ok) assert.equal(approval.refusal.code, "delete_limit_exceeded");
    const status = value(await h.engine.reader(h.ref).status());
    assert.ok(status.mappingPasses.every((pass) => pass.status === "pending"));
    const driveId = status.createdDrives.find((d) => d.mappingId === "a")!.driveId!;
    assert.deepEqual(
      (await h.port.listDestinationChildren(driveId)).map((f) => f.name),
      ["one.txt"],
    );
    const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
    const json = await readFile(
      report.artifacts.find((a) => a.name === "report.json")!.path,
      "utf8",
    );
    assert.equal(
      JSON.parse(json).findings.some(
        (finding: { code: string }) => finding.code === "delete_limit_exceeded",
      ),
      true,
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
      config: {
        ...config,
        options: { mirror: true, deleteLimit: 1 },
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Legacy existing destination accepted");
    assert.deepEqual(result.refusal.detail, { row: 1, field: "destination" });
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
    const closing = await h.engine.withWriterResult(h.ref, (w) => w.close());
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
    value(value(await h.engine.withWriter(h.ref, (w) => w.close())));
    const report = value(value(await h.engine.withWriter(h.ref, (w) => w.report())));
    const json = report.artifacts.find((a) => a.name === "report.json")!;
    const contents = await readFile(json.path, "utf8");
    assert.match(contents, /files@example.com/);
    assert.match(contents, /Delete the service-account key/);
    assert.match(contents, /Delete the domain-wide delegation entry/);
  });
  it("refuses delegation failures before planning and leaves impersonation off unchanged", async (t) => {
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
    input.googleAbout = new Error("Impersonation off must not query about");
    const h = await harness(t, input, {
      ...config,
      impersonate: false,
      subject: "ignored@example.com",
    });
    const plan = value(value(await h.engine.withWriter(h.ref, (w) => w.plan())));
    assert.match(JSON.stringify(plan), /service account acts as itself/);
    assert.doesNotMatch(JSON.stringify(plan.sections), /delegation entry|ignored@example.com/);
    await approve(h);
    await execute(h);
    value(value(await h.engine.withWriter(h.ref, (w) => w.verify())));
    value(value(await h.engine.withWriter(h.ref, (w) => w.close())));
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
      const engine = openEngine({
        home: process.env.COPY_HOME,
        now: () => new Date(${JSON.stringify(now)}),
        provider: new FakeFileMigrationPort(JSON.parse(process.env.COPY_FIXTURE)),
      });
      const ref = { id: process.env.COPY_JOB };
      const executing = engine.withWriterResult(ref, (writer) => writer.execute());
      const active = new Set();
      for await (const event of engine.reader(ref).events({ follow: true })) {
        if (event.kind === "mapping_progress" && event.payload.status === "running") {
          active.add(event.payload.mappingId);
          if (active.size === 3) {
            process.stdout.write("ready");
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
      const closed = once(child, "close");
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      });
      await Promise.race([
        once(child.stdout, "data"),
        closed.then(() => {
          throw new Error(`Writer exited before concurrent passes: ${stderr}`);
        }),
      ]);
      const running = value(await h.engine.reader(h.ref).status()).mappingPasses;
      assert.deepEqual(
        running.map((pass) => pass.status),
        ["running", "running", "running", "pending"],
      );
      assert.equal(
        new Set(running.filter((pass) => pass.status === "running").map((pass) => pass.executeId))
          .size,
        1,
      );
      child.kill("SIGKILL");
      assert.equal((await closed)[1], "SIGKILL");
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
      await approve(h);
      const controller = new AbortController();
      const executing = h.engine.withWriterResult(h.ref, (writer) =>
        writer.execute({ signal: controller.signal }),
      );
      for await (const event of h.engine
        .reader(h.ref)
        .events({ follow: true, signal: AbortSignal.timeout(5000) })) {
        if (event.kind === "mapping_progress" && event.payload.files === 1) {
          controller.abort();
          break;
        }
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
    const h = await harness(t, input);
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
    value(value(await h.engine.withWriter(h.ref, (writer) => writer.close())));
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
    const h = await harness(t);
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
      verification.findings.some((entry) => entry.code === "content_verification_degraded"),
      false,
    );
    assert.equal(
      h.port.snapshotDestination().find((entry) => entry.id === item.id)?.checksum,
      hash(new Uint8Array([1, 1, 1, 1])),
    );
  });

  it("expands subtree exclusions to exact source identities and never creates their descendants", async (t) => {
    const selected: FileMigrationConfig = {
      mappings: [
        {
          ...config.mappings[0]!,
          exclusions: [{ sourceItemId: "folder", reason: "Outside approved migration scope" }],
        },
      ],
    };
    const h = await harness(t, fixture(), selected);
    await approve(h);
    const planned = await codes(h, "plan");
    assert.equal(planned.get("folder"), "omitted_by_rule");
    assert.equal(planned.get("empty"), "omitted_by_rule");
    assert.equal(planned.get("zero"), "omitted_by_rule");
    await execute(h);
    assert.deepEqual(
      h.port
        .snapshotDestination()
        .map((entry) => entry.path)
        .sort(),
      [".", "report.docx"],
    );
    assert.equal((await codes(h, "verify")).get("zero"), "omitted_by_rule");
  });

  it("requires a new plan when an excluded subtree gains a new stable member", async (t) => {
    const input = fixture();
    input.sourceItems.push({
      id: "later",
      parentId: "folder",
      name: "later.bin",
      kind: "file",
      content: "later",
    });
    const selected: FileMigrationConfig = {
      mappings: [
        {
          ...config.mappings[0]!,
          exclusions: [{ sourceItemId: "folder", reason: "Explicitly excluded" }],
        },
      ],
    };
    const h = await harness(t, input, selected);
    h.port.overrideSourceChildren("folder", ["empty", "zero"]);
    await approve(h);
    await execute(h);
    value(
      await h.engine.withWriter(h.ref, async (writer) => {
        const verified = value(await writer.verify());
        value(
          await writer.accept({
            verificationDigest: verified.verificationDigest,
            codes: verified.findings.map((entry) => ({ code: entry.code })),
            approver: "file-contract-test",
          }),
        );
      }),
    );
    h.port.overrideSourceChildren("folder", ["empty", "zero", "later"]);
    const refused = value(await h.engine.withWriter(h.ref, (writer) => writer.execute()));
    assert.equal(refused.ok, false);
    if (refused.ok) throw new Error("Expanded exclusions were silently admitted");
    assert.equal(refused.refusal.code, "plan_revision_required");
    assert.equal(
      h.port.snapshotDestination().some((entry) => entry.path.includes("later")),
      false,
    );
  });

  it("requires a new plan before an approved excluded file moved outside its subtree can be copied", async (t) => {
    const h = await harness(
      t,
      fixture(),
      fileConfig([{ sourceItemId: "folder", reason: "Outside approved migration scope" }]),
    );
    await approve(h);
    const before = h.port.snapshotDestination();
    h.port.mutateSourceItem("zero", { parentId: "source-root" });
    const result = value(await h.engine.withWriter(h.ref, (writer) => writer.execute()));
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("A previously excluded file was admitted without approval");
    assert.equal(result.refusal.code, "plan_revision_required");
    assert.deepEqual(h.port.snapshotDestination(), before);
    assert.equal(value(await h.engine.reader(h.ref).status()).mappingPasses[0]?.status, "pending");
  });

  it("blocks nested mappings and unrepresentable ancestor paths before descendant writes", async (t) => {
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
    await h.engine.withWriter(h.ref, (writer) => writer.plan());
    const overlap = value(
      await h.engine.reader(h.ref).rows({ phase: "plan", codes: ["mapping_overlap"] }),
    );
    assert.equal(overlap.totalRows, 2);
    const other = await harness(t);
    other.port.renameSourceItem("folder", "bad/name");
    await other.engine.withWriter(other.ref, (writer) => writer.plan());
    const planned = await codes(other, "plan");
    assert.equal(planned.get("folder"), "path_unrepresentable");
    assert.equal(planned.get("zero"), "path_unrepresentable");
    assert.equal(planned.get("empty"), "path_unrepresentable");
  });

  it("verifies matching paths and hashes without per-item provenance markers", async (t) => {
    const h = await harness(t);
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
    value(value(await h.engine.withWriter(h.ref, (writer) => writer.close())));
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
    const h = await harness(t);
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

  it("requires acceptance of size-only verification and states the mode in the plan", async (t) => {
    const h = await harness(t, fixture(), {
      ...config,
      options: { verificationMode: "size_only" },
    });
    await approve(h);
    const plan = value(await h.engine.reader(h.ref).status()).currentPlan!;
    assert.ok(
      plan.sections
        .filter((section) => section.body.startsWith("{"))
        .some((section) => JSON.parse(section.body).verificationMode === "size_only"),
    );
    await execute(h);
    const item = h.port.snapshotDestination().find((entry) => entry.path === "report.docx")!;
    h.port.mutateDestinationContent(item.id, new Uint8Array([1, 1, 1, 1]));
    h.port.mutateSourceItem("binary", { downloadable: false });
    const verified = value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
    assert.deepEqual(
      verified.findings.map((entry) => entry.code),
      ["content_verification_degraded"],
    );
    const closed = value(await h.engine.withWriter(h.ref, (writer) => writer.close()));
    assert.equal(closed.ok, false);
    if (closed.ok) throw new Error("Size-only verification closed without acceptance");
    assert.equal(closed.refusal.code, "verification_unaccepted");
    value(
      value(
        await h.engine.withWriter(h.ref, (writer) =>
          writer.accept({
            verificationDigest: verified.verificationDigest,
            approver: "operator",
            codes: [{ code: "content_verification_degraded" }],
          }),
        ),
      ),
    );
    value(value(await h.engine.withWriter(h.ref, (writer) => writer.close())));
  });

  it("names an unreadable source without losing verification of readable files", async (t) => {
    const h = await harness(t);
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
    const h = await harness(t);
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
    const closed = value(await h.engine.withWriter(h.ref, (writer) => writer.close()));
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
    const h = await harness(t, input);
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
              codes: [{ code: "source_size_inconsistent" }],
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
    value(value(await h.engine.withWriter(h.ref, (writer) => writer.close())));
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

describe("settled and partial file-driver proof", () => {
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
      port.mutateSourceItem("binary", { content: `changed-${++observations}` });
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

  it("requires new approval rather than catching up a new source path", async (t) => {
    const { ctx, port } = await stagedContext(t);
    ctx.waitForConsistency = async () => {
      port.mutateSourceItem("binary", { name: "unapproved.docx" });
    };
    await consume(ctx, fileMigrationDriver.collect(ctx));
    await assert.rejects(consume(ctx, fileMigrationDriver.execute(ctx)), {
      code: "plan_revision_required",
    });
    assert.equal(
      port.snapshotDestination().some((item) => item.path === "unapproved.docx"),
      false,
    );
  });

  it("labels partial proof against the verified baseline and checks renamed/deleted paths, while final stays full", async (t) => {
    const { ctx, port } = await stagedContext(t, { deltaVerification: "changed" });
    ctx.stage = "prestage";
    await consume(ctx, fileMigrationDriver.collect(ctx));
    await consume(ctx, fileMigrationDriver.execute(ctx));
    const initial = await consume(ctx, fileMigrationDriver.verify(ctx));
    const baseline = {
      revision: 1,
      rows: [...ctx.resume.rows!],
      findings: initial.flatMap((unit) => unit.findings),
      acceptedCodes: [],
    };
    port.mutateSourceItem("binary", { name: "renamed.docx", content: "delta content" });
    ctx.revision = 2;
    ctx.stage = "delta";
    ctx.verificationBaseline = baseline;
    ctx.resume = { checkpoint: null, watermarks: {}, rows: [], mappingPasses: [] };
    await consume(ctx, fileMigrationDriver.collect(ctx));
    await consume(ctx, fileMigrationDriver.execute(ctx));
    const unchanged = port.snapshotDestination().find((item) => item.path === "nested/zero.bin")!;
    port.mutateDestinationContent(unchanged.id, "independent destination damage");
    const partial = await consume(ctx, fileMigrationDriver.verify(ctx));
    const evidence = partial
      .flatMap((unit) => unit.rows)
      .find((item) => item.jobType === "file_migration" && item.fileScope?.verification);
    assert.ok(evidence?.jobType === "file_migration");
    assert.equal(evidence.fileScope!.verification!.scope, "partial");
    assert.equal(evidence.fileScope!.verification!.baselineRevision, 1);
    assert.deepEqual(evidence.fileScope!.verification!.coveredPaths, [
      "renamed.docx",
      "report.docx",
    ]);
    assert.deepEqual(evidence.fileScope!.verification!.deletedPaths, ["report.docx"]);
    assert.equal(
      partial.flatMap((unit) => unit.findings).some((item) => item.subjectId === "zero"),
      false,
    );
    assert.ok(
      partial
        .flatMap((unit) => unit.findings)
        .some((item) => item.code === "destination_only_retained"),
    );

    ctx.stage = "final";
    await consume(ctx, fileMigrationDriver.execute(ctx));
    // Copy may repair independent damage; damage it again after settled confirmation.
    port.mutateDestinationContent(unchanged.id, "still damaged at final verification");
    const full = await consume(ctx, fileMigrationDriver.verify(ctx));
    assert.ok(
      full
        .flatMap((unit) => unit.findings)
        .some((item) => item.subjectId === "zero" && item.code === "content_mismatch"),
    );
    const finalEvidence = full
      .flatMap((unit) => unit.rows)
      .find((item) => item.jobType === "file_migration" && item.fileScope?.verification);
    assert.ok(finalEvidence?.jobType === "file_migration");
    assert.equal(finalEvidence.fileScope!.verification!.scope, "full");
  });

  it("previews the rehearsal's five copies and four deletions before approving its cumulative limit", async (t) => {
    for (const deleteLimit of [4, 3]) {
      const input = fileFixture(
        Array.from({ length: 9 }, (_, index) => ({
          id: `item-${index}`,
          parentId: "source-root",
          name: `file-${index}.bin`,
          kind: "file",
          content: "old",
        })),
      );
      const h = await provisioningHarness(t, input, { mirror: true, deleteLimit });
      await execute(h);
      await approve(h);
      await execute(h);
      for (let index = 0; index < 5; index++)
        h.port.mutateSourceItem(`item-${index}`, { content: "fresh" });
      for (let index = 5; index < 9; index++) h.port.deleteSourceItem(`item-${index}`);
      const plan = value(await h.engine.withWriterResult(h.ref, (writer) => writer.plan()));
      const rows = value(await h.engine.reader(h.ref).rows({ phase: "plan", limit: 100 })).rows;
      assert.equal(rows.filter((item) => item.code === "updated").length, 5);
      assert.deepEqual(
        rows
          .filter((item) => item.jobType === "file_migration" && item.code === "to_be_deleted")
          .map((item) => (item.jobType === "file_migration" ? item.relativePath : ""))
          .sort(),
        ["file-5.bin", "file-6.bin", "file-7.bin", "file-8.bin"],
      );
      const section = JSON.parse(
        plan.sections.find((item) => item.title === "Mapping finance")!.body,
      );
      assert.equal(section.byteTotals.changed, 25);
      assert.equal(section.byteTotals.deleted, 12);
      const approval = await h.engine.withWriterResult(h.ref, (writer) =>
        writer.approve({
          approver: "operator",
          mode: "unattended",
          planDigest: plan.planDigest,
        }),
      );
      assert.equal(approval.ok, deleteLimit === 4);
      if (!approval.ok) assert.equal(approval.refusal.code, "delete_limit_exceeded");
      const driveId = value(await h.engine.reader(h.ref).status()).createdDrives[0]!.driveId!;
      assert.equal(
        (await h.port.listDestinationChildren(driveId)).filter((item) => item.kind === "file")
          .length,
        9,
      );
    }
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

  it("blocks a source deletion discovered during full final verification", async (t) => {
    const { ctx, port } = await stagedContext(t);
    await consume(ctx, fileMigrationDriver.collect(ctx));
    await consume(ctx, fileMigrationDriver.execute(ctx));
    const verification = fileMigrationDriver.verify(ctx)[Symbol.asyncIterator]();
    await verification.next();
    port.deleteSourceItem("binary");
    await assert.rejects(
      async () => {
        while (!(await verification.next()).done) {}
      },
      { code: "plan_revision_required" },
    );
  });

  it("uses full proof without a baseline and retains earlier exceptions in partial proof", async (t) => {
    const { ctx, port } = await stagedContext(t, { deltaVerification: "changed" });
    ctx.stage = "delta";
    await consume(ctx, fileMigrationDriver.collect(ctx));
    await consume(ctx, fileMigrationDriver.execute(ctx));
    port.mutateDestinationContent(
      port.snapshotDestination().find((item) => item.path === "report.docx")!.id,
      "damage",
    );
    const first = await consume(ctx, fileMigrationDriver.verify(ctx));
    const findings = first.flatMap((unit) => unit.findings);
    assert.ok(findings.some((item) => item.code === "content_mismatch"));
    ctx.verificationBaseline = {
      revision: 1,
      rows: [...ctx.resume.rows!],
      findings,
      acceptedCodes: ["content_mismatch", "size_mismatch"],
    };
    ctx.revision = 2;
    ctx.resume = { checkpoint: null, watermarks: {}, rows: [], mappingPasses: [] };
    await consume(ctx, fileMigrationDriver.collect(ctx));
    const partial = await consume(ctx, fileMigrationDriver.verify(ctx));
    const inherited = partial
      .flatMap((unit) => unit.findings)
      .find((item) => item.code === "content_mismatch");
    assert.equal(inherited?.evidence.inheritedFromRevision, 1);
    const coverage = partial
      .flatMap((unit) => unit.rows)
      .find((item) => item.jobType === "file_migration" && item.fileScope?.verification);
    assert.ok(coverage?.jobType === "file_migration");
    assert.deepEqual(coverage.fileScope!.verification!.coveredPaths, []);
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
