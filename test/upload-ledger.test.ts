import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { stringify as stringifyToml } from "smol-toml";
import { fileURLToPath } from "node:url";
import {
  CLI_JOB_CONFIG,
  CLI_ARCHIVE_CONFIG,
  FIXTURE_TIME,
  cliArchiveFixture,
} from "./cli-fixture.ts";
import { createTransferSupervisor } from "../src/engine/providers/transfer-worker.ts";
import {
  beginUploadAttempt,
  endAbandonedUploads,
  initializeUploadLedger,
  readUploadActivity,
  UploadLedgerError,
} from "../src/engine/store/uploads.ts";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import { approve, fileConfig, fileFixture, value } from "./engine-fixture.ts";

const DAY = 86_400_000;
const BASE = Date.parse("2026-10-25T00:30:00.000Z");
const account = "user+copy@example.com";
const run = promisify(execFile);

async function home(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "migmate-uploads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("concurrent processes and jobs share an atomic account total, but other accounts and homes do not", async (t) => {
  const directory = await home(t);
  const other = await home(t);
  const module = new URL("../src/engine/store/uploads.ts", import.meta.url).href;
  await Promise.all(
    Array.from({ length: 4 }, (_, job) =>
      run(process.execPath, [
        "--input-type=module",
        "-e",
        `
    import { beginUploadAttempt } from ${JSON.stringify(module)};
    const attempt = beginUploadAttempt(${JSON.stringify(directory)}, {
      jobId: 'job-${job}', revision: 1, source: 'file', identity: 'mapping-pass', account: ' USER+copy@example.com '
    }, new Date(${BASE}));
    for (let i = 1; i <= 40; i++) attempt.observe(i * 10, new Date(${BASE} + i), i === 40, 'worker-${job}');
  `,
      ]),
    ),
  );
  const separate = beginUploadAttempt(
    directory,
    {
      jobId: "job-other",
      revision: 1,
      source: "teams",
      identity: "object",
      account: "user@example.com",
    },
    new Date(BASE),
  );
  separate.observe(7, new Date(BASE + 40), true);
  const snapshot = readUploadActivity(directory, new Date(BASE + 40));
  assert.equal(
    snapshot.accounts.find((entry) => entry.account === account)?.observedBytesInWindow,
    1600,
  );
  assert.equal(
    snapshot.accounts.find((entry) => entry.account === "user@example.com")?.observedBytesInWindow,
    7,
  );
  assert.deepEqual(readUploadActivity(other, new Date(BASE + 40)).accounts, []);
  assert.equal((await stat(join(directory, "uploads.sqlite"))).mode & 0o777, 0o600);
});

test("duplicate, older and expired observations cannot replay; resets disclose gaps and retries count separately", async (t) => {
  const directory = await home(t);
  initializeUploadLedger(directory, new Date(BASE - DAY));
  const input = {
    jobId: "job",
    revision: 1,
    source: "file",
    identity: "mapping-pass",
    account,
  } satisfies Parameters<typeof beginUploadAttempt>[1];
  const first = beginUploadAttempt(directory, input, new Date(BASE));
  first.observe(100, new Date(BASE + 10));
  first.observe(100, new Date(BASE + 10));
  first.observe(900, new Date(BASE + 5));
  first.observe(20, new Date(BASE + 20));
  first.observe(150, new Date(BASE + 30), true);
  const retry = beginUploadAttempt(directory, input, new Date(BASE + 30));
  retry.observe(40, new Date(BASE + 40), true, "new-worker-same-numeric-jobid");
  const current = readUploadActivity(directory, new Date(BASE + 40)).accounts[0]!;
  assert.equal(current.observedBytesInWindow, 190);
  assert.equal(current.estimatedRemainingBytes, null);
  assert.ok(current.gaps.some((gap) => gap.reason === "counter_decreased_without_new_attempt"));
  initializeUploadLedger(directory, new Date(BASE + 3 * DAY));
  first.observe(150, new Date(BASE + 30), true);
  first.observe(500, new Date(BASE + 3 * DAY), true);
  const expired = readUploadActivity(directory, new Date(BASE + 3 * DAY)).accounts[0]!;
  assert.equal(expired.observedBytesInWindow, 0);
  assert.equal(expired.estimatedRemainingBytes, 750_000_000_000);
});

test("rolling UTC window excludes the exact lower bound and future observations independent of midnight or DST", async (t) => {
  const directory = await home(t);
  initializeUploadLedger(directory, new Date(BASE - DAY));
  for (const [offset, bytes] of [
    [0, 10],
    [1, 20],
    [DAY, 30],
    [DAY + 1, 40],
  ]) {
    const at = new Date(BASE + offset!);
    const attempt = beginUploadAttempt(
      directory,
      { jobId: "job", revision: 1, source: "file", identity: String(offset), account },
      at,
    );
    attempt.observe(bytes!, at, true);
  }
  const snapshot = readUploadActivity(directory, new Date(BASE + DAY)).accounts[0]!;
  assert.equal(snapshot.observedBytesInWindow, 50);
  assert.equal(snapshot.estimatedRemainingBytes, 750_000_000_000 - 50);
  assert.equal(
    readUploadActivity(directory, new Date(BASE + DAY + 1)).accounts[0]!.observedBytesInWindow,
    70,
  );
});

test("long passes retain increments at original times and missing intervals spanning the window remain incomplete", async (t) => {
  const directory = await home(t);
  initializeUploadLedger(directory, new Date(BASE - DAY));
  const attempt = beginUploadAttempt(
    directory,
    { jobId: "job", revision: 1, source: "file", identity: "long", account },
    new Date(BASE),
  );
  attempt.observe(100, new Date(BASE + 10_000));
  attempt.observe(250, new Date(BASE + DAY + 20_000), true);
  const snapshot = readUploadActivity(directory, new Date(BASE + DAY + 20_000)).accounts[0]!;
  assert.equal(snapshot.observedBytesInWindow, 150);
  assert.equal(snapshot.estimatedRemainingBytes, null);
  assert.ok(snapshot.gaps.some((gap) => gap.reason === "sampling_interval_exceeded_30_seconds"));
});

test("new history, unknown accounts, missing final stats and crash intents preserve partial totals and never a complete zero", async (t) => {
  const directory = await home(t);
  const absent = readUploadActivity(directory, new Date(BASE), [account]);
  assert.equal(absent.accounts[0]!.estimatedRemainingBytes, null);
  await assert.rejects(stat(join(directory, "uploads.sqlite")), { code: "ENOENT" });
  initializeUploadLedger(directory, new Date(BASE - DAY));
  const known = beginUploadAttempt(
    directory,
    { jobId: "known", revision: 1, source: "teams", identity: "object", account },
    new Date(BASE),
  );
  known.observe(100, new Date(BASE), true);
  for (const jobId of ["unknown-one", "unknown-two"]) {
    const attempt = beginUploadAttempt(
      directory,
      { jobId, revision: 1, source: "teams", identity: "object" },
      new Date(BASE),
    );
    attempt.observe(20, new Date(BASE + 1));
    attempt.missing(new Date(BASE + 2), "terminal_counter_unavailable");
  }
  const snapshot = readUploadActivity(directory, new Date(BASE + 2));
  assert.equal(snapshot.accounts.length, 3);
  assert.equal(
    snapshot.accounts.find((entry) => entry.account === account)?.estimatedRemainingBytes,
    null,
  );
  assert.equal(
    new Set(snapshot.accounts.filter((entry) => !entry.account).map((entry) => entry.attemptId))
      .size,
    2,
  );
  beginUploadAttempt(
    directory,
    { jobId: "crashed-before-job-commit", revision: 1, source: "file", identity: "pass", account },
    new Date(BASE),
  );
  initializeUploadLedger(directory, new Date(BASE + 3 * DAY));
  const crashed = readUploadActivity(directory, new Date(BASE + 3 * DAY)).accounts[0]!;
  assert.equal(crashed.estimatedRemainingBytes, null);
  assert.ok(
    crashed.gaps.some(
      (gap) => gap.reason === "active_or_crashed_attempt_terminal_counter_unavailable",
    ),
  );
});

test("a complete local estimate clamps at zero, and status reads never prune or hide storage failures", async (t) => {
  const directory = await home(t);
  initializeUploadLedger(directory, new Date(BASE - DAY));
  const attempt = beginUploadAttempt(
    directory,
    { jobId: "job", revision: 1, source: "file", identity: "pass", account },
    new Date(BASE),
  );
  attempt.observe(750_000_000_001, new Date(BASE), true);
  assert.equal(
    readUploadActivity(directory, new Date(BASE)).accounts[0]!.estimatedRemainingBytes,
    0,
  );
  const before = await stat(join(directory, "uploads.sqlite"));
  readUploadActivity(directory, new Date(BASE + 3 * DAY));
  assert.equal((await stat(join(directory, "uploads.sqlite"))).mtimeMs, before.mtimeMs);
  await writeFile(join(directory, "uploads.sqlite"), "not sqlite");
  assert.throws(() => readUploadActivity(directory, new Date(BASE)), UploadLedgerError);
});

test("file jobs contribute through the engine and later activity never rewrites the approved plan snapshot", async (t) => {
  const directory = await home(t);
  const engines = [];
  for (let i = 0; i < 2; i++) {
    const provider = new FakeFileMigrationPort(
      fileFixture([
        {
          id: "file",
          parentId: "source-root",
          name: "file.txt",
          kind: "file",
          content: "hello",
          size: 5,
        },
      ]),
    );
    const engine = openEngine({ home: directory, now: () => new Date(BASE), provider });
    t.after(() => engine.close());
    const ref = value(await engine.initJob({ type: "file_migration", config: fileConfig() }));
    await approve({ engine, ref });
    engines.push({ engine, ref });
  }
  const first = engines[0]!;
  const before = value(await first.engine.reader(first.ref).status()).currentPlan;
  await Promise.all(
    engines.map(async ({ engine, ref }) => {
      assert.equal(
        value(await engine.withWriterResult(ref, (writer) => writer.execute())).outcome,
        "completed",
      );
    }),
  );
  const status = value(await first.engine.reader(first.ref).status());
  assert.equal(status.uploadActivity?.accounts[0]?.observedBytesInWindow, 10);
  assert.equal(status.uploadActivity?.accounts[0]?.estimatedRemainingBytes, null);
  assert.deepEqual(status.currentPlan, before);
  assert.ok(
    status.currentPlan?.sections.some((section) =>
      section.body.includes("Planned upload bytes are unavailable"),
    ),
  );
});

test("writer recovery bounds only its own abandoned attempts; unresolved peers remain incomplete", async (t) => {
  const directory = await home(t);
  initializeUploadLedger(directory, new Date(BASE - DAY));
  for (const jobId of ["one", "two"])
    beginUploadAttempt(
      directory,
      { jobId, revision: 1, source: "file", identity: "pass", account: `${jobId}@example.com` },
      new Date(BASE),
    ).observe(5, new Date(BASE + 10));
  endAbandonedUploads(directory, "one", new Date(BASE + 20));
  const after = readUploadActivity(directory, new Date(BASE + DAY + 20));
  assert.equal(after.accounts.find((entry) => entry.account === "one@example.com")?.complete, true);
  assert.equal(
    after.accounts.find((entry) => entry.account === "two@example.com")?.complete,
    false,
  );
});

test("CLI smoke exposes file and Teams observed totals, unavailable allowance and local-only exclusions", async (t) => {
  const directory = await home(t);
  const configPath = join(directory, "input.toml");
  const env = {
    ...process.env,
    CLI_TEST_HOME: join(directory, "home"),
    CLI_TEST_DESTINATION: join(directory, "destination.json"),
    CLI_TEST_NOW: FIXTURE_TIME,
  };
  const cli = async (args: string[], output = "json") => {
    const result = await run(
      process.execPath,
      [
        fileURLToPath(new URL("./cli-process-fixture.ts", import.meta.url)),
        ...args,
        "--output",
        output,
      ],
      { env, maxBuffer: 4 * 1024 * 1024 },
    );
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    return envelope.value;
  };
  let fileBytes = 0;
  for (const type of ["file_migration", "teams_archive"]) {
    await writeFile(
      configPath,
      stringifyToml(
        type === "file_migration"
          ? CLI_JOB_CONFIG
          : {
              ...CLI_ARCHIVE_CONFIG,
              destination: { destDriveId: "dst-drive", destFolderId: "dst-root" },
            },
      ),
    );
    const ref = await cli(["init", "--type", type, "--config", configPath]);
    const plan = await cli(["plan", "--job", ref.id]);
    await cli([
      "approve",
      "--job",
      ref.id,
      "--approver",
      "ci:upload-smoke",
      "--plan-digest",
      plan.planDigest,
    ]);
    await cli(["execute", "--job", ref.id]);
    const status = await cli(["status", "--job", ref.id], "text");
    const observed = status.uploadActivity.accounts[0];
    assert.equal(observed.account, "service-account@example.com");
    assert.equal(observed.estimatedRemainingBytes, null);
    assert.ok(observed.gaps.length > 0);
    if (type === "file_migration") {
      fileBytes = observed.observedBytesInWindow;
      assert.equal(fileBytes, 72);
    } else assert.ok(observed.observedBytesInWindow > fileBytes);
    console.log(
      `CLI ${type}: ${observed.account}; observedBytesInWindow=${observed.observedBytesInWindow}; estimatedRemainingBytes=${observed.estimatedRemainingBytes}; gaps=${observed.gaps.map((gap: { reason: string }) => gap.reason).join(",")}`,
    );
    assert.ok(
      status.uploadActivity.exclusions.some((text: string) =>
        text.includes("no cross-home or cross-host coordination"),
      ),
    );
  }
});

test("real local rclone worker counters reach the file driver's home ledger (not cloud charging proof)", async (t) => {
  const directory = await home(t);
  const source = join(directory, "source");
  const destination = join(directory, "destination");
  await mkdir(source);
  await mkdir(destination);
  await writeFile(join(source, "file.txt"), "hello");
  const provider = new FakeFileMigrationPort(
    fileFixture([
      {
        id: "file",
        parentId: "source-root",
        name: "file.txt",
        kind: "file",
        content: "hello",
        size: 5,
      },
    ]),
  );
  const engine = openEngine({ home: directory, provider });
  t.after(() => engine.close());
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      config: { ...fileConfig(), options: { proof: "rclone" } },
    }),
  );
  const supervisor = createTransferSupervisor({
    configPath: null,
    jobDirectory: join(directory, "jobs", ref.id),
  });
  t.after(() => supervisor.close());
  let socketPath = "";
  provider.startTransferWorker = async (input) => {
    const worker = await supervisor.startTransferWorker(input);
    socketPath = worker.socketPath;
    return worker;
  };
  provider.stopTransferWorker = supervisor.stopTransferWorker;
  provider.terminateTransferWorker = supervisor.terminateTransferWorker;
  provider.probeTransferWorker = supervisor.probeTransferWorker;
  provider.transferWorkerVersion = supervisor.transferWorkerVersion;
  provider.startCopyPass = supervisor.startCopyPass;
  provider.stopCopyPass = supervisor.stopCopyPass;
  provider.copyPassStatus = supervisor.copyPassStatus;
  provider.copyPassStats = supervisor.copyPassStats;
  provider.listFileHashes = supervisor.listFileHashes;
  provider.listFolders = supervisor.listFolders;
  provider.resolveFilePass = async () => ({
    socketPath,
    source: { fs: source, kind: "sharepoint" },
    destination: { fs: destination, kind: "google_drive" },
  });
  await approve({ engine, ref });
  const executed = value(await engine.withWriterResult(ref, (writer) => writer.execute()));
  const status = value(await engine.reader(ref).status());
  assert.equal(executed.outcome, "completed", JSON.stringify(status.mappingPasses));
  assert.equal(status.uploadActivity?.accounts[0]?.observedBytesInWindow, 5);
  console.log(
    "Local rclone smoke: file-driver observedBytesInWindow=5; fake account, local filesystem only.",
  );
});

test("reverse-route and local-only archive execution add no Google content observations", async (t) => {
  const directory = await home(t);
  const provider = new FakeFileMigrationPort({
    ...fileFixture([
      {
        id: "file",
        parentId: "source-root",
        name: "file.txt",
        kind: "file",
        content: "hello",
        size: 5,
      },
    ]),
    archive: cliArchiveFixture(),
  });
  const engine = openEngine({ home: directory, now: () => new Date(BASE), provider });
  t.after(() => engine.close());
  const reverse = value(
    await engine.initJob({
      type: "file_migration",
      config: { mappings: [], route: "shared_drive_to_sharepoint_library" },
    }),
  );
  value(
    await engine.withWriterResult(reverse, (writer) =>
      writer.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [
            {
              id: "reverse",
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
    ),
  );
  await approve({ engine, ref: reverse });
  assert.equal(
    value(await engine.withWriterResult(reverse, (writer) => writer.execute())).outcome,
    "completed",
  );
  const archive = value(
    await engine.initJob({
      type: "teams_archive",
      config: CLI_ARCHIVE_CONFIG,
    }),
  );
  await approve({ engine, ref: archive });
  assert.equal(
    value(await engine.withWriterResult(archive, (writer) => writer.execute())).outcome,
    "completed",
  );
  await assert.rejects(stat(join(directory, "uploads.sqlite")), { code: "ENOENT" });
  assert.deepEqual(readUploadActivity(directory, new Date(BASE)).accounts, []);
});
