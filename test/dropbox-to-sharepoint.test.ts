import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import { fileProviderPair } from "../src/engine/providers/adapters/capabilities.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import { parseManifest } from "../src/engine/manifest.ts";
import { approve, closeDecision, fileFixture, value } from "./engine-fixture.ts";

const now = "2026-11-01T12:00:00.000Z";
const namespaceId = "123456";
const siteId = "tenant.sharepoint.com,site-collection,web";

function manifest(members: unknown[] = []) {
  return {
    version: 1,
    mappings: [
      {
        id: "team",
        source: { type: "dropbox", namespaceId, folderPath: "" },
        destination: { type: "sharepoint", siteId, create: "Finance" },
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
    options?: Record<string, unknown>;
    approve?: false;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "migmate-dropbox-sharepoint-"));
  const fixture = fileFixture(
    input.sourceItems ?? [
      { id: "file", parentId: "source-root", name: "file.txt", kind: "file", content: "bytes" },
    ],
  );
  fixture.sourceDriveId = namespaceId;
  const port = new FakeFileMigrationPort({
    ...fixture,
    destinationProvider: "sharepoint",
    sharepointMembershipAvailable: Boolean(input.members?.length),
    now: () => new Date(now),
  });
  const engine = openEngine({ home, provider: port, now: () => new Date(now) });
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      config: {
        sourceProvider: "dropbox",
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
  if (input.approve !== false) await approve(h);
  return h;
}

async function reportJson(h: Awaited<ReturnType<typeof harness>>) {
  const report = value(await h.engine.withWriterResult(h.ref, (w) => w.report()));
  return JSON.parse(
    await readFile(
      report.artifacts.find((artifact) => artifact.name === "report.json")!.path,
      "utf8",
    ),
  );
}

test("Dropbox → SharePoint is a supported pair and its manifest names a namespace and a site", () => {
  const pair = fileProviderPair({ sourceProvider: "dropbox", destinationProvider: "sharepoint" });
  assert.equal(pair.source.id, "dropbox");
  assert.equal(pair.destination.id, "sharepoint");
  const parsed = parseManifest(JSON.stringify(manifest()), "json");
  assert.deepEqual(parsed.mappings[0]?.source, {
    type: "dropbox",
    driveId: namespaceId,
    folderPath: "",
  });
  assert.deepEqual(parsed.mappings[0]?.destination, manifest().mappings[0]!.destination);
});

test("Dropbox → SharePoint creates a library, encodes names with disclosure and verifies clean", async (t) => {
  const h = await harness(t, {
    sourceItems: [
      { id: "folder", parentId: "source-root", name: "bad:folder", kind: "folder" },
      { id: "nested", parentId: "folder", name: "normal.txt", kind: "file", content: "nested" },
      { id: "question", parentId: "source-root", name: "report?.txt", kind: "file", content: "q" },
      { id: "literal", parentId: "source-root", name: "report？.txt", kind: "file", content: "l" },
      {
        id: "paper",
        parentId: "source-root",
        name: "Notes.html",
        kind: "file",
        content: "<p>notes</p>",
        metadata: { contentDisposition: "paper_html", originalName: "Notes.paper" },
      },
    ],
  });
  const planned = value(await h.engine.reader(h.ref).rows({ phase: "plan", limit: 100 })).rows;
  const notices = planned.filter((row) => row.code === "destination_name_encoded");
  // bad:folder, bad:folder/normal.txt and report?.txt change; report？.txt is quoted.
  assert.equal(notices.length, 4);
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
  assert.equal(created.siteId, siteId);
  assert.deepEqual(
    (await h.port.listDestinationChildren(created.rootFolderId!)).map((item) => item.name).sort(),
    ["Notes.html", "bad：folder", "report？.txt", "report‛？.txt"].sort(),
  );
  assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
  const document = await reportJson(h);
  assert.equal(
    document.findings.filter(
      (finding: { code: string }) => finding.code === "destination_name_encoded",
    ).length,
    4,
  );
  assert.ok(
    document.findings.some((finding: { code: string }) => finding.code === "source_paper_html"),
  );
  value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
});

test("Dropbox → SharePoint blocks reserved and case-colliding names until the source is fixed", async (t) => {
  const h = await harness(t, {
    approve: false,
    sourceItems: [
      { id: "file", parentId: "source-root", name: "CON", kind: "file", content: "r" },
      {
        id: "paper",
        parentId: "source-root",
        name: "Plan.html",
        kind: "file",
        content: "<p>plan</p>",
        metadata: { contentDisposition: "paper_html", originalName: "Plan.paper" },
      },
      { id: "upper", parentId: "source-root", name: "PLAN.html", kind: "file", content: "p" },
    ],
  });
  const plan = value(await h.engine.withWriterResult(h.ref, (w) => w.plan()));
  const rows = value(await h.engine.reader(h.ref).rows({ phase: "plan", limit: 100 })).rows;
  const codes = rows.map((row) => row.code);
  assert.ok(codes.includes("destination_invalid_name"));
  assert.equal(codes.filter((code) => code === "destination_duplicate_name").length, 2);
  const approval = await h.engine.withWriterResult(h.ref, (w) =>
    w.approve({ planDigest: plan.planDigest, approver: "test", mode: "unattended" }),
  );
  assert.equal(approval.ok, false);
  h.port.renameSourceItem("file", "contract.txt");
  h.port.renameSourceItem("upper", "Plan summary.html");
  await approve(h);
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
});

test("Dropbox → SharePoint named members wait for the go-live fence", async (t) => {
  const member = { email: "readers@example.com", type: "group", role: "reader" };
  const h = await harness(t, { members: [member] });
  value(await h.engine.withWriterResult(h.ref, (w) => w.execute()));
  const created = value(await h.engine.reader(h.ref).status()).createdDrives[0]!;
  assert.equal(h.port.destinationInheritsPermissions(created.driveId!), false);
  assert.deepEqual(value(await h.engine.reader(h.ref).status()).memberGrants, []);
  assert.equal(value(await h.engine.withWriterResult(h.ref, (w) => w.verify())).clean, true);
  value(await h.engine.withWriterResult(h.ref, async (w) => w.close(await closeDecision(h))));
  const closed = value(await h.engine.reader(h.ref).status());
  assert.equal(closed.state, "closed");
  assert.equal(closed.createdDrives[0]?.goLive?.check?.status, "passed");
  assert.deepEqual(await h.port.listDriveMembers(created.driveId!), [{ ...member, role: "read" }]);
});
