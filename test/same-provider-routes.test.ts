import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import {
  fileProviderPair,
  sameProviderPair,
  type FileProviderId,
} from "../src/engine/providers/adapters/capabilities.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";
import { approve, fileFixture, value } from "./engine-fixture.ts";

const now = "2026-11-02T12:00:00.000Z";
const siteId = "tenant.sharepoint.com,site-collection,web";

function roots(provider: FileProviderId) {
  switch (provider) {
    case "google_shared_drive":
      return {
        source: { type: provider, driveId: "source-drive", folderId: "source-root" },
        destination: { type: provider, driveId: "destination-drive", folderId: "destination-root" },
      };
    case "dropbox":
      return {
        source: { type: provider, namespaceId: "source-drive", folderPath: "" },
        destination: { type: provider, namespaceId: "destination-drive", folderPath: "" },
      };
    case "sharepoint":
      return {
        source: { type: provider, driveId: "source-drive", folderPath: "" },
        destination: { type: provider, driveId: "destination-drive", folderPath: "" },
      };
  }
}

const delegation = {
  impersonate: true,
  subject: "writer@example.com",
  sourceImpersonate: true,
  sourceSubject: "reader@example.com",
};

async function harness(
  t: TestContext,
  provider: FileProviderId,
  input: {
    sourceItems?: FakeFileMigrationFixture["sourceItems"];
    fixture?: Partial<FakeFileMigrationFixture>;
    config?: Record<string, unknown>;
    approve?: false;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), `migmate-same-${provider}-`));
  const fixture = fileFixture(
    input.sourceItems ?? [
      { id: "file", parentId: "source-root", name: "file.txt", kind: "file", content: "bytes" },
    ],
  );
  const port = new FakeFileMigrationPort({
    ...fixture,
    destinationProvider: provider,
    ...(provider === "google_shared_drive"
      ? {
          googleAbout: {
            user: { emailAddress: "writer@example.com" },
            canCreateDrives: true,
          },
          googleSourceAbout: {
            user: { emailAddress: "reader@example.com" },
            canCreateDrives: false,
          },
        }
      : {}),
    now: () => new Date(now),
    ...input.fixture,
  });
  const engine = openEngine({ home, provider: port, now: () => new Date(now) });
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      config: {
        sourceProvider: provider,
        destinationProvider: provider,
        ...(provider === "google_shared_drive" ? delegation : {}),
        options: { consistencyIntervalMs: 0 },
        ...input.config,
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
      writer.loadManifest({
        format: "json",
        content: JSON.stringify({ version: 1, mappings: [{ id: "files", ...roots(provider) }] }),
      }),
    ),
  );
  if (input.approve !== false) await approve(h);
  return h;
}

async function execute(h: Awaited<ReturnType<typeof harness>>) {
  return value(value(await h.engine.withWriter(h.ref, (writer) => writer.execute())));
}

async function verify(h: Awaited<ReturnType<typeof harness>>) {
  return value(value(await h.engine.withWriter(h.ref, (writer) => writer.verify())));
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

/** Record whether each hash listing downloaded content, by side. */
function hashListings(t: TestContext, port: FakeFileMigrationPort) {
  const calls: { side: "source" | "destination"; download: boolean; hashType: string }[] = [];
  const original = port.listFileHashes.bind(port);
  t.mock.method(port, "listFileHashes", async (input: Parameters<typeof original>[0]) => {
    calls.push({
      side: input.root.fs === "source-root" ? "source" : "destination",
      download: input.download,
      hashType: input.hashType,
    });
    return original(input);
  });
  return calls;
}

for (const provider of ["google_shared_drive", "dropbox", "sharepoint"] as const) {
  test(`${provider} → ${provider} is a supported pair`, () => {
    const pair = fileProviderPair({ sourceProvider: provider, destinationProvider: provider });
    assert.equal(pair.source.id, provider);
    assert.equal(pair.destination.id, provider);
    assert.equal(sameProviderPair(pair), true);
  });

  test(`${provider} → ${provider} verifies the hashes both sides store, without downloading`, async (t) => {
    const h = await harness(t, provider);
    const status = value(await h.engine.reader(h.ref).status());
    assert.equal(status.jobType, "file_migration");
    const calls = hashListings(t, h.port);
    await execute(h);
    const clean = await verify(h);
    assert.equal(clean.clean, true, JSON.stringify(clean.findings));
    assert.ok(calls.length >= 2);
    assert.deepEqual(
      calls.filter((call) => call.download),
      [],
    );
    const hashType = fileProviderPair({
      sourceProvider: provider,
      destinationProvider: provider,
    }).destination.hashType;
    assert.ok(calls.every((call) => call.hashType === hashType));
    // Same size, different bytes: only a hash comparison can see it.
    const copied = h.port.snapshotDestination().find((entry) => entry.path === "file.txt")!;
    h.port.mutateDestinationContent(copied.id, "BYTES");
    const changed = await verify(h);
    assert.deepEqual(
      changed.findings.map((entry) => entry.code),
      ["content_mismatch"],
    );
    const report = await reportJson(h);
    const evidence = report.findings.find(
      (finding: { code: string }) => finding.code === "content_mismatch",
    ).evidence;
    assert.equal(evidence.hashType, hashType);
    assert.equal(evidence.sourceSize, evidence.destinationSize);
    const approval = report.sections.find(
      (section: { title: string }) => section.title === "Approval and verification",
    ).body;
    assert.match(approval, /compares the hashes both sides store/);
    assert.match(approval, /files only/i);
  });
}

async function plan(h: Awaited<ReturnType<typeof harness>>) {
  return value(await h.engine.withWriter(h.ref, (writer) => writer.plan()));
}

test("Google → Google reads as a separate read-only source account and writes as the destination's", async (t) => {
  const h = await harness(t, "google_shared_drive", { approve: false });
  const planned = value(await plan(h));
  const section = (title: string) =>
    planned.sections.find((entry) => entry.title === title)?.body ?? "";
  assert.match(section("Acting Google account"), /writer@example\.com/);
  assert.match(section("Read-only Google source account"), /reader@example\.com.*drive\.readonly/);
  assert.deepEqual(JSON.parse(section("Copy method")), { copyMethod: "streamed" });
  await approve(h);
  const report = await reportJson(h);
  const checks = new Map<string, { status: string; evidence: Record<string, unknown> }>(
    report.checks.map((check: { id: string }) => [check.id, check]),
  );
  assert.equal(
    checks.get("google.source.delegation")?.evidence.actualSubject,
    "reader@example.com",
  );
  assert.equal(checks.get("google.delegation")?.evidence.actualSubject, "writer@example.com");
  // The writing account is the plan's acting account; it need not read the source.
  assert.equal(report.plan.evidence.actingGoogleAccount, "writer@example.com");
  assert.equal(checks.has("google.server_side_copy"), false);
});

test("Google → Google refuses a source account that is not the configured source subject", async (t) => {
  const h = await harness(t, "google_shared_drive", {
    approve: false,
    fixture: {
      googleSourceAbout: { user: { emailAddress: "writer@example.com" }, canCreateDrives: true },
    },
  });
  const refused = await plan(h);
  assert.equal(refused.ok, false);
  if (refused.ok) throw new Error("A mismatched source account must refuse");
  assert.equal(refused.refusal.code, "preflight_failed");
  assert.match(JSON.stringify(refused.refusal.detail), /drive\.readonly/);
});

test("server-side copy is selected only for Google → Google inside one Workspace", async (t) => {
  const h = await harness(t, "google_shared_drive", {
    approve: false,
    config: { options: { consistencyIntervalMs: 0, serverSideCopy: true } },
  });
  const planned = value(await plan(h));
  assert.deepEqual(
    JSON.parse(planned.sections.find((entry) => entry.title === "Copy method")!.body),
    { copyMethod: "server_side" },
  );
  assert.match(
    planned.sections.find((entry) => entry.title === "Approval and verification")!.body,
    /copy server side inside one Workspace/,
  );
  await approve(h);
  const check = (await reportJson(h)).checks.find(
    (entry: { id: string }) => entry.id === "google.server_side_copy",
  );
  assert.equal(check.status, "pass");
  assert.equal(check.evidence.oneWorkspace, true);

  // Another Workspace's subject never copies server side, even when it can read the source.
  const other = await harness(t, "google_shared_drive", {
    approve: false,
    config: {
      subject: "writer@other.example",
      options: { consistencyIntervalMs: 0, serverSideCopy: true },
    },
    fixture: {
      googleAbout: { user: { emailAddress: "writer@other.example" }, canCreateDrives: true },
    },
  });
  const refused = await plan(other);
  assert.equal(refused.ok, false);
  if (refused.ok) throw new Error("Server-side copy across Workspaces must refuse");
  assert.match(JSON.stringify(refused.refusal.detail), /"oneWorkspace":false/);

  // Migmate never grants the writer access to the source; it must already have it.
  const unreadable = await harness(t, "google_shared_drive", {
    approve: false,
    config: { options: { consistencyIntervalMs: 0, serverSideCopy: true } },
    fixture: { destinationUnreadableSourceDrives: ["source-drive"] },
  });
  const blocked = await plan(unreadable);
  assert.equal(blocked.ok, false);
  if (blocked.ok) throw new Error("An unreadable source must refuse server-side copy");
  assert.match(
    JSON.stringify(blocked.refusal.detail),
    /"unreadableSourceDrives":\["source-drive"\]/,
  );
});

test("server-side copy and a separate source subject are refused outside Google → Google", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "migmate-same-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const engine = openEngine({ home, provider: new FakeFileMigrationPort(fileFixture()) });
  t.after(() => engine.close());
  for (const [sourceProvider, destinationProvider, extra, field] of [
    ["dropbox", "dropbox", { options: { serverSideCopy: true } }, "options.serverSideCopy"],
    ["sharepoint", "sharepoint", { options: { serverSideCopy: true } }, "options.serverSideCopy"],
    [
      "google_shared_drive",
      "sharepoint",
      { options: { serverSideCopy: true } },
      "options.serverSideCopy",
    ],
    ["google_shared_drive", "sharepoint", { sourceSubject: "reader@example.com" }, "sourceSubject"],
    ["dropbox", "dropbox", { sourceImpersonate: true }, "sourceImpersonate"],
    ["google_shared_drive", "google_shared_drive", { sourceImpersonate: true }, "sourceSubject"],
  ] as const) {
    const result = await engine.initJob({
      type: "file_migration",
      config: { sourceProvider, destinationProvider, ...extra },
    });
    assert.equal(result.ok, false, `${sourceProvider} → ${destinationProvider} ${field}`);
    if (result.ok) continue;
    assert.equal(result.refusal.code, "configuration_invalid");
    assert.equal(result.refusal.detail?.field, field);
  }
  // Streaming stays available everywhere; the option may always be turned off.
  value(
    await engine.initJob({
      type: "file_migration",
      config: {
        sourceProvider: "dropbox",
        destinationProvider: "dropbox",
        options: { serverSideCopy: false },
      },
    }),
  );
});

test("SharePoint → SharePoint keeps the rewrite rule for PDF, Office and HTML files", async (t) => {
  const h = await harness(t, "sharepoint", {
    sourceItems: [
      { id: "doc", parentId: "source-root", name: "report.docx", kind: "file", content: "docx" },
      { id: "pdf", parentId: "source-root", name: "scan.pdf", kind: "file", content: "pdf!" },
      { id: "html", parentId: "source-root", name: "page.html", kind: "file", content: "<p>" },
      { id: "txt", parentId: "source-root", name: "notes.txt", kind: "file", content: "text" },
    ],
  });
  await execute(h);
  assert.equal((await verify(h)).clean, true);
  // SharePoint rewrites these types on upload: their size and stored hash change.
  for (const path of ["report.docx", "scan.pdf", "page.html", "notes.txt"]) {
    const entry = h.port.snapshotDestination().find((item) => item.path === path)!;
    h.port.mutateDestinationContent(entry.id, "rewritten");
  }
  await verify(h);
  const report = await reportJson(h);
  assert.deepEqual(
    report.findings
      .map((entry: { code: string; evidence: { path: string } }) => [
        entry.code,
        entry.evidence.path,
      ])
      .sort(),
    [
      ["destination_rewrote_file", "page.html"],
      ["destination_rewrote_file", "report.docx"],
      ["destination_rewrote_file", "scan.pdf"],
      ["size_mismatch", "notes.txt"],
      ["content_mismatch", "notes.txt"],
    ].sort(),
  );
});

test("Google → Google compares stored MD5 where Drive stores no SHA-256, still without downloading", async (t) => {
  const h = await harness(t, "google_shared_drive");
  const calls = hashListings(t, h.port);
  await execute(h);
  // An older Drive file has no stored SHA-256 on the source; both sides store MD5.
  // The fake withholds SHA-256 by object ID on either side's listing: here the source file.
  h.port.withholdDestinationChecksum("file");
  assert.equal((await verify(h)).clean, true);
  assert.deepEqual(
    calls.filter((call) => call.download),
    [],
  );
  assert.ok(calls.some((call) => call.side === "source" && call.hashType === "md5"));
  assert.ok(calls.some((call) => call.side === "destination" && call.hashType === "md5"));
});

test("Dropbox → Dropbox downloads only source files that store no hash, such as exports", async (t) => {
  const h = await harness(t, "dropbox", {
    sourceItems: [
      { id: "file", parentId: "source-root", name: "file.txt", kind: "file", content: "bytes" },
      { id: "paper", parentId: "source-root", name: "notes.html", kind: "file", content: "<p>" },
    ],
  });
  const calls: { download: boolean; paths?: string[] }[] = [];
  const original = h.port.listFileHashes.bind(h.port);
  t.mock.method(h.port, "listFileHashes", async (input: Parameters<typeof original>[0]) => {
    calls.push({ download: input.download, ...(input.paths ? { paths: input.paths } : {}) });
    return original(input);
  });
  await execute(h);
  h.port.withholdStoredHashes("paper");
  assert.equal((await verify(h)).clean, true);
  assert.deepEqual(
    calls.filter((call) => call.download),
    [{ download: true, paths: ["notes.html"] }],
  );
});

test("a same-provider destination inside, on or above its source tree refuses", async (t) => {
  for (const [name, source, destination, refused] of [
    ["inside", "source-root", "inner", true],
    ["on", "source-root", "source-root", true],
    ["above", "sub", "source-root", true],
    ["beside", "sub", "inner", false],
  ] as const) {
    const home = await mkdtemp(join(tmpdir(), "migmate-same-overlap-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const port = new FakeFileMigrationPort({
      ...fileFixture([{ id: "sub", parentId: "source-root", name: "sub", kind: "folder" }]),
      // One Shared Drive is both sides: provider IDs are global, so they name one folder.
      destinationDriveId: "source-drive",
      destinationRootId: "source-root",
      destinationItems: [
        { id: "source-root", parentId: null, name: "root", kind: "folder" },
        { id: "inner", parentId: "source-root", name: "inner", kind: "folder" },
      ],
      destinationProvider: "google_shared_drive",
      googleAbout: { user: { emailAddress: "writer@example.com" }, canCreateDrives: true },
      googleSourceAbout: { user: { emailAddress: "reader@example.com" }, canCreateDrives: false },
    });
    const engine = openEngine({ home, provider: port, now: () => new Date(now) });
    t.after(() => engine.close());
    const ref = value(
      await engine.initJob({
        type: "file_migration",
        config: {
          sourceProvider: "google_shared_drive",
          destinationProvider: "google_shared_drive",
          ...delegation,
        },
      }),
    );
    const result = await engine.withWriterResult(ref, (writer) =>
      writer.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [
            {
              id: "files",
              source: { type: "google_shared_drive", driveId: "source-drive", folderId: source },
              destination: {
                type: "google_shared_drive",
                driveId: "source-drive",
                folderId: destination,
              },
            },
          ],
        }),
      }),
    );
    assert.equal(!result.ok, refused, name);
    if (!result.ok) {
      assert.equal(result.refusal.code, "configuration_invalid", name);
      assert.match(result.refusal.message, /Source and destination trees overlap/u, name);
    }
  }
});

// The source account is bound through the credential identity instead (credentials.test.ts).
test("changing the copy method after approval needs a new plan", async (t) => {
  const h = await harness(t, "google_shared_drive");
  const path = join(h.home, "jobs", h.ref.id, "job.toml");
  const settings = parseToml(await readFile(path, "utf8"));
  await writeFile(
    path,
    stringifyToml({
      ...settings,
      options: { ...(settings.options as object), serverSideCopy: true },
    }),
  );
  const result = await h.engine.withWriterResult(h.ref, (writer) => writer.execute());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal.code, "plan_revision_required");
});
