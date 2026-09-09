import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, userInfo, hostname } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { run, type Io } from "../src/cli/main.ts";
import { defaultHome } from "../src/cli/arguments.ts";
import { openEngine, type Engine, type JobStatus, type Outcome, type PlanRevision, type RowPage, type ApprovalRecord, type ExecuteResult, type ArtifactSet } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import { cliFixture, CLI_JOB_CONFIG } from "./cli-fixture.ts";

interface Capture { code: number; stdout: string; stderr: string; prompts: number }
interface Document<T> { schemaVersion: number; command: string; commandId: string; job: { id: string; type: string | null } | null; ok: boolean; value: T; refusal: { code: string; detail?: Record<string, unknown>; recovery?: Record<string, unknown> } }
function document<T>(capture: Capture): Document<T> {
  assert.equal(capture.stderr, "");
  const parsed: Document<T> = JSON.parse(capture.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.match(parsed.commandId, /^[\da-f-]{36}$/u);
  assert.notEqual("value" in parsed, "refusal" in parsed);
  return parsed;
}
async function invoke(argv: string[], engine?: Engine, options: { tty?: boolean[]; answer?: string; write?: Io["stdout"]["write"]; signal?: AbortSignal } = {}): Promise<Capture> {
  let stdout = "", stderr = "", prompts = 0;
  const io: Io = {
    stdout: { isTTY: options.tty?.[1] ?? false, async write(chunk) { if (options.write) await options.write(chunk); stdout += chunk; } },
    stderr: { isTTY: options.tty?.[2] ?? false, write(chunk) { stderr += chunk; } },
    stdin: { isTTY: options.tty?.[0] ?? false, async readLine() { prompts++; return options.answer ?? null; } },
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const code = await run(argv, io, engine);
  return { code, stdout, stderr, prompts };
}
function harness(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "migmate-cli-contract-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const provider = new FakeFileMigrationPort(cliFixture());
  const engine = () => openEngine({ home, provider, adapter: "cli" });
  return { home, provider, engine };
}
async function planned(t: TestContext) {
  const h = harness(t);
  const config = join(h.home, "input.toml");
  writeFileSync(config, stringifyToml(CLI_JOB_CONFIG));
  const init = document<{ id: string }>(await invoke(["init", "--type", "file_migration", "--config", config, "--output", "json"], h.engine()));
  assert.equal(init.ok, true);
  const id = init.value.id;
  const plan = document<PlanRevision & { review: RowPage }>(await invoke(["plan", "--job", id, "--limit", "2", "--output", "json"], h.engine()));
  assert.equal(plan.ok, true);
  return { ...h, id, plan: plan.value };
}

it("emits one versioned stdout document for handled usage/configuration failures and help", async t => {
  const h = harness(t);
  const cases = [
    ["execute"], ["not-a-command"], ["init"], ["status", "--job", "../escape"],
    ["status", "--job", "missing", "--limit", "0"], ["status", "--job", "missing", "--from", "9007199254740992"],
    ["status", "--job", "missing", "--schema-version", "2"], ["execute", "--job", "missing", "--yes"],
    ["creds", "init", "--job", "missing"], ["reclaim", "--job", "missing"],
  ];
  for (const argv of cases) for (const mode of ["json", "jsonl"]) {
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

it("parses TOML and JSON inputs but persists only typed TOML references through onboarding", async t => {
  const h = harness(t);
  const secret = join(h.home, "operator-secret");
  const sentinel = "CLI-SECRET-CANARY-do-not-copy";
  writeFileSync(secret, sentinel, { mode: 0o600 });
  const config = { ...CLI_JOB_CONFIG, rclone: { config: { resolver: "file", path: secret, mode: "0600" }, sourceRemote: "sharepoint", destinationRemote: "google" } };
  const input = join(h.home, "operator.json");
  writeFileSync(input, JSON.stringify(config));
  const init = document<{ id: string }>(await invoke(["init", "--type", "file_migration", "--config", input, "--output", "json"], h.engine()));
  assert.equal(init.ok, true);
  const path = join(h.home, "jobs", init.value.id, "job.toml");
  const persisted = readFileSync(path, "utf8");
  assert.deepEqual(parseToml(persisted).rclone, config.rclone);
  assert.equal(persisted.includes(sentinel), false);
  const tomlInput = join(h.home, "operator.toml");
  writeFileSync(tomlInput, stringifyToml(config));
  const onboard = await invoke(["creds", "init", "--job", init.value.id, "--config", tomlInput, "--output", "json"], h.engine());
  const report = document<{ checks: unknown[]; passed: boolean }>(onboard);
  assert.equal(report.command, "creds init");
  assert.equal(report.ok, true);
  assert.equal(report.value.passed, true);
  assert.equal(onboard.stdout.includes(sentinel), false);
  assert.equal(readFileSync(secret, "utf8"), sentinel);
  assert.equal(existsSync(join(h.home, "jobs", init.value.id, "job.config.json")), false);
  writeFileSync(input, '{"secret":"CLI-SECRET-CANARY-do-not-copy"');
  const malformed = await invoke(["creds", "init", "--job", init.value.id, "--config", input, "--output", "json"], h.engine());
  assert.equal(malformed.code, 2);
  assert.equal(document(malformed).refusal.code, "configuration_invalid");
  assert.equal(malformed.stdout.includes(sentinel), false);
  assert.equal(readFileSync(path, "utf8").includes(sentinel), false);
});

it("refuses missing jobs and malformed config rather than creating state", async t => {
  const h = harness(t);
  const status = await invoke(["status", "--job", "missing", "--output", "json"], h.engine());
  assert.equal(status.code, 2);
  assert.equal(document(status).refusal.code, "job_not_found");
  assert.equal(existsSync(join(h.home, "jobs", "missing")), false);
  const config = await invoke(["init", "--type", "teams_archive", "--config", join(h.home, "absent.toml"), "--output", "json"], h.engine());
  assert.equal(config.code, 2);
  assert.equal(document(config).refusal.code, "configuration_invalid");
});

it("pages and filters durable plan evidence without revising the approved digest", async t => {
  const h = await planned(t);
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await invoke(["plan", "--review", "--job", h.id, "--limit", "2", "--code", "created", ...(cursor ? ["--cursor", cursor] : []), "--output", "json"], h.engine());
    const doc = document<{ planDigest: string; review: RowPage }>(result);
    assert.equal(result.code, 0);
    assert.equal(doc.value.planDigest, h.plan.planDigest);
    assert.equal(doc.value.review.totalRows, 8);
    assert.equal(doc.value.review.facets.find(facet => facet.code === "created")?.count, 8);
    for (const row of doc.value.review.rows) { assert.equal(ids.has(row.id), false); ids.add(row.id); }
    cursor = doc.value.review.nextCursor;
  } while (cursor);
  assert.equal(ids.size, 8);
  const search = document<{ review: RowPage }>(await invoke(["plan", "--review", "--job", h.id, "--search", "3.txt", "--code", "created", "--output", "json"], h.engine()));
  assert.equal(search.value.review.totalRows, 1);
  assert.equal(search.value.review.rows[0]?.code, "created");
});

it("machine approval requires both identity and read-back digest, regardless of TTYs", async t => {
  const h = await planned(t);
  for (let mask = 0; mask < 8; mask++) {
    const tty = [Boolean(mask & 1), Boolean(mask & 2), Boolean(mask & 4)];
    for (const mode of ["json", "jsonl"]) {
      const result = await invoke(["approve", "--job", h.id, "--approver", "ci:review", "--output", mode], h.engine(), { tty });
      assert.equal(result.code, 4);
      assert.equal(result.prompts, 0);
      assert.equal(document(result).refusal.code, "approval_required");
    }
  }
  const accepted = await invoke(["approve", "--job", h.id, "--approver", "ci:review", "--plan-digest", h.plan.planDigest, "--output", "json"], h.engine());
  const approval = document<ApprovalRecord>(accepted);
  assert.equal(accepted.code, 0);
  assert.equal(approval.value.planDigest, h.plan.planDigest);
  assert.match(approval.value.approvalDigest, /^[a-f0-9]{64}$/u);
});

it("human approval prompts only with all three TTYs and requires exact literal yes", async t => {
  const h = await planned(t);
  for (let mask = 0; mask < 7; mask++) {
    const result = await invoke(["approve", "--job", h.id], h.engine(), { tty: [Boolean(mask & 1), Boolean(mask & 2), Boolean(mask & 4)], answer: "yes" });
    assert.equal(result.code, 4);
    assert.equal(result.prompts, 0);
  }
  for (const answer of ["", "y", "YES", " yes", "yes "]) {
    const result = await invoke(["approve", "--job", h.id], h.engine(), { tty: [true, true, true], answer });
    assert.equal(result.code, 4);
    assert.equal(result.prompts, 1);
  }
  const accepted = await invoke(["approve", "--job", h.id, "--approver", "not-the-os-user"], h.engine(), { tty: [true, true, true], answer: "yes" });
  assert.equal(accepted.code, 0);
  const approval: Document<ApprovalRecord> = JSON.parse(accepted.stdout);
  assert.equal(approval.value.mode, "interactive");
  assert.equal(approval.value.approver, `${userInfo().username}@${hostname()}`);
  for (const disclosure of h.plan.disclosures) assert.ok(accepted.stderr.includes(disclosure));
});

it("maps stable refusal codes exactly and preserves unknown values fail-closed", async t => {
  const h = harness(t);
  const cases: Array<[string, number]> = [["configuration_invalid", 2], ["job_not_found", 2], ["lease_held", 3], ["foreign_host", 3], ["lease_stale_worker_alive", 3], ["preflight_failed", 4], ["approval_required", 4], ["approval_digest_stale", 4], ["plan_revision_required", 4], ["unqualified_route", 4], ["verification_unaccepted", 4], ["local_filesystem_required", 4], ["retry_budget_exhausted", 5], ["job_closed", 6], ["job_cancelled", 7], ["state_version_unsupported", 8], ["future_code", 1], ["toString", 1]];
  for (const [code, expected] of cases) {
    const engine = h.engine();
    const reader = engine.reader({ id: "absent" });
    engine.reader = () => ({ ...reader, status: async () => ({ ok: false, refusal: { code, message: "opaque" } }) as Outcome<JobStatus> });
    const result = await invoke(["status", "--job", "absent", "--output", "json"], engine);
    assert.equal(result.code, expected);
    assert.equal(document(result).refusal.code, code);
  }
  const engine = h.engine();
  const reader = engine.reader({ id: "absent" });
  engine.reader = () => ({ ...reader, status: async () => ({ ok: true, value: { jobType: "file_migration", state: "future_state" } }) as unknown as Outcome<JobStatus> });
  const future = await invoke(["status", "--job", "absent", "--output", "json"], engine);
  assert.equal(future.code, 1);
  assert.equal(document<{ state: string }>(future).value.state, "future_state");
});

it("redacts sensitive recovery data but keeps actionable owner and checkpoint facts", async t => {
  const h = harness(t);
  const engine = h.engine();
  const reader = engine.reader({ id: "absent" });
  engine.reader = () => ({ ...reader, status: async () => ({ ok: false, refusal: {
    code: "lease_stale_worker_alive", message: "Bearer SECRET-CANARY https://example.invalid/download?sig=SECRET-CANARY",
    detail: { RCLONE_RC_USER: "SECRET-CANARY", RCLONE_RC_PASS: "SECRET-CANARY", workerPid: 424242, authorization: "SECRET-CANARY" },
    recovery: { workerAlive: true, recordedHostId: "host-one", thisHostId: "host-one", holder: { pid: 31337, heartbeatAt: "2026-09-01T00:00:00Z", token: "SECRET-CANARY" }, workerGroup: "run-group", workerPid: 424242, socketPath: "/private/run/worker.sock", rawFutureField: "SECRET-CANARY", lastCheckpoint: "unit-7" },
  } }) as unknown as Outcome<JobStatus> });
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

it("executes a real engine lifecycle with digest-bound reports and successful terminal cancel", async t => {
  const h = await planned(t);
  const approve = await invoke(["approve", "--job", h.id, "--approver", "ci", "--plan-digest", h.plan.planDigest, "--output", "json"], h.engine());
  assert.equal(approve.code, 0);
  const execute = await invoke(["execute", "--job", h.id, "--output", "json"], h.engine());
  assert.equal(execute.code, 0);
  const done = document<ExecuteResult & { state: string }>(execute);
  assert.equal(done.value.state, "completed");
  assert.equal(done.value.resumable, false);
  const verify = await invoke(["verify", "--job", h.id, "--output", "json"], h.engine());
  assert.equal(verify.code, 0);
  const report = document<ArtifactSet>(await invoke(["report", "--job", h.id, "--output", "json"], h.engine()));
  assert.match(report.value.reportDigest!, /^[a-f0-9]{64}$/u);
  for (const format of ["jsonl", "html"]) assert.ok(report.value.artifacts.some(artifact => artifact.format === format && existsSync(artifact.path)));
  const cancel = await invoke(["cancel", "--job", h.id, "--reason", "No rollback requested", "--output", "json"], h.engine());
  assert.equal(cancel.code, 0);
  assert.equal(document<{ state: string }>(cancel).value.state, "cancelled");
  assert.equal(h.provider.snapshotDestination().filter(row => row.kind === "file").length, 8);
});

it("waits for asynchronous stdout completion and never emits a second error after EPIPE", async t => {
  const h = harness(t);
  const { promise, resolve } = Promise.withResolvers<void>();
  let pending = true;
  const result = invoke(["--help", "--output", "json"], h.engine(), { write: () => promise }).finally(() => { pending = false; });
  await new Promise<void>(done => setImmediate(done));
  assert.equal(pending, true);
  resolve();
  assert.equal((await result).code, 0);
  const broken = await invoke(["--help", "--output", "json"], h.engine(), { async write() { await Promise.resolve(); throw Object.assign(new Error("EPIPE"), { code: "EPIPE" }); } });
  assert.equal(broken.code, 141);
  assert.equal(broken.stdout, "");
  assert.equal(broken.stderr, "");
});

it("uses OS-specific persistent engine homes", () => {
  assert.equal(defaultHome("darwin", {}, "/Users/operator"), "/Users/operator/Library/Application Support/Migmate");
  assert.equal(defaultHome("linux", {}, "/home/operator"), "/home/operator/.local/state/migmate");
  assert.equal(defaultHome("linux", { XDG_STATE_HOME: "/local/state" }, "/home/operator"), "/local/state/migmate");
  assert.equal(defaultHome("win32", { LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local" }, "C:\\Users\\operator"), "C:\\Users\\operator\\AppData\\Local\\Migmate");
});

it("keeps acceptance bound to the verification digest and closes only after named gaps are accepted", async t => {
  const h = await planned(t);
  assert.equal((await invoke(["doctor", "--job", h.id, "--output", "json"], h.engine())).code, 0);
  assert.equal((await invoke(["approve", "--job", h.id, "--approver", "ci", "--plan-digest", h.plan.planDigest, "--output", "json"], h.engine())).code, 0);
  assert.equal((await invoke(["execute", "--job", h.id, "--output", "json"], h.engine())).code, 0);
  const verification = document<{ verificationDigest: string; findings: Array<{ code: string }> }>(await invoke(["verify", "--job", h.id, "--output", "json"], h.engine()));
  const stale = await invoke(["accept", "--job", h.id, "--approver", "ci", "--verification-digest", "stale", "--code", "version_history_omitted", "--output", "json"], h.engine());
  assert.equal(stale.code, 4);
  assert.equal(document(stale).refusal.code, "verification_unaccepted");
  const codes = verification.value.findings.map(finding => finding.code);
  if (codes.length) {
    const accepted = await invoke(["accept", "--job", h.id, "--approver", "ci:review", "--verification-digest", verification.value.verificationDigest, ...codes.flatMap(code => ["--code", code, "--note", "Reviewed retained evidence"]), "--output", "json"], h.engine());
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

it("does not translate reader event refusals into a successful empty stream", async t => {
  const h = await planned(t);
  const engine = h.engine();
  const reader = engine.reader({ id: h.id });
  engine.reader = () => ({
    ...reader,
    async *events() { throw Object.assign(new Error("opaque"), { refusal: { code: "state_version_unsupported", message: "opaque", detail: { found: 99 } } }); },
  });
  const result = await invoke(["status", "--job", h.id, "--output", "jsonl"], engine);
  assert.equal(result.code, 8);
  assert.equal(document(result).refusal.code, "state_version_unsupported");
});

it("explicit reclaim refuses a live writer rather than treating confirmation as force", async t => {
  const h = await planned(t);
  const owner = h.engine();
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = owner.withWriter({ id: h.id }, async () => { acquired.resolve(); await release.promise; });
  void holding.then(outcome => { if (!outcome.ok) acquired.reject(new Error("Could not acquire test writer")); }, acquired.reject);
  try {
    await acquired.promise;
    const result = await invoke(["reclaim", "--job", h.id, "--confirm", "--stop-worker", "--output", "json"], h.engine());
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
    } finally { reader.close(); }
  } finally { release.resolve(); await holding; owner.close(); }
});
