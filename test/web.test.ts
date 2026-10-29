import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it } from "node:test";
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { openEngine, VERBS } from "../src/engine/index.ts";
import type {
  Engine,
  JobStatus,
  JobWriter,
  Outcome,
  Refusal,
  RowPage,
} from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import { createProtocolHandler, allowedNavigation } from "../src/web/protocol.ts";
import { WebSession } from "../src/web/session.ts";
import { fileConfig, fileFixture } from "./engine-fixture.ts";
import type { ProviderPort } from "../src/engine/providers/port.ts";

const JOB = { id: "one-job" };
type HtmlNode = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
function elements(node: HtmlNode, predicate: (element: Element) => boolean): Element[] {
  const found = "tagName" in node && predicate(node) ? [node] : [];
  if ("childNodes" in node)
    for (const child of node.childNodes) found.push(...elements(child, predicate));
  return found;
}
function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}
function text(node: HtmlNode): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(text).join("") : "";
}

function status(): JobStatus {
  return {
    jobId: JOB.id,
    jobType: "file_migration",
    state: "planned",
    schemaVersion: 1,
    rail: VERBS.map((verb) => ({
      verb,
      state:
        verb === "approve" ? "current" : verb === "init" || verb === "plan" ? "done" : "pending",
    })),
    ownership: {
      held: true,
      heldByThisProcess: false,
      hostId: "this-host",
      pid: 900,
      heartbeatAt: "2026-09-01T00:00:00Z",
      kind: "cli",
      detached: false,
      logPath: null,
    },
    planRevision: 1,
    planDigest: "reviewed-plan-digest",
    verificationDigest: null,
    currentPlan: null,
    progress: { unit: "records", done: 27, total: null },
    mappingPasses: [],
    createdDrives: [],
    memberGrants: [],
    lastCheckpoint: "durable-page-3",
    outstandingFindings: [],
    worker: { active: true, group: "recorded-group" },
    resumable: true,
    terminalState: "interrupted",
  };
}

/** The protocol seam permits projected engine data; it never substitutes a native window. */
function readerEngine(
  projected: JobStatus,
  page: RowPage,
  refusal?: Refusal,
  writer?: JobWriter,
): Engine {
  const refused: Outcome<never> = {
    ok: false,
    refusal: refusal ?? { code: "lease_held", message: "Owned by another process." },
  };
  const reader = {
    async discover() {
      throw new Error("This window must not initiate tenant discovery");
    },
    async status() {
      return { ok: true as const, value: projected };
    },
    async rows() {
      return { ok: true as const, value: page };
    },
    async artifacts() {
      return { ok: true as const, value: { reportDigest: null, artifacts: [] } };
    },
    async *events() {},
  };
  return {
    async initJob() {
      throw new Error("This window must not address a second job");
    },
    reader(ref) {
      assert.equal(ref.id, JOB.id);
      return reader;
    },
    async withWriter(ref, callback) {
      assert.equal(ref.id, JOB.id);
      return writer ? { ok: true, value: await callback(writer) } : refused;
    },
    async withWriterResult(ref, callback) {
      assert.equal(ref.id, JOB.id);
      return writer ? await callback(writer) : refused;
    },
    async reclaim() {
      return refused;
    },
    async requestControl() {
      return refused;
    },
    close() {},
  };
}
const EMPTY: RowPage = { facets: [], rows: [], totalRows: 0, nextCursor: null };
function request(action: string, input: Record<string, unknown> = {}, stage = "status"): Request {
  return new Request(`migmate://localhost/command?stage=${stage}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Migmate-Action": "1" },
    body: JSON.stringify({ action, input }),
  });
}

async function settled(session: WebSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    const snapshot = await session.snapshot({ stage: "status", phase: "plan" });
    if (!snapshot.busy) return;
    await nextTurn();
  }
  assert.fail("The protocol action did not settle");
}

function renderedForm(document: HtmlNode, action: string): Element {
  const form = elements(document, (element) => attr(element, "data-action") === action)[0];
  assert.ok(form, `Expected a rendered ${action} form`);
  return form;
}

function formField(form: Element, name: string): Element {
  const field = elements(form, (element) => attr(element, "name") === name)[0];
  assert.ok(field, `Expected rendered field ${name}`);
  return field;
}

function capturedField(form: Element, name: string): string {
  const field = formField(form, name);
  assert.equal(attr(field, "type"), "hidden", `${name} must not require transcription`);
  const value = attr(field, "value");
  assert.ok(value);
  return value;
}

function noDefaultConsent(form: Element): void {
  for (const field of elements(form, (element) => attr(element, "type") === "checkbox"))
    assert.equal(attr(field, "checked"), undefined);
}

class RecoveryProvider extends FakeFileMigrationPort {
  unavailableMember: string | null = null;

  override async listDriveMembers(driveId: string) {
    const members = await super.listDriveMembers(driveId);
    if (members.some((member) => member.email === this.unavailableMember))
      throw new TypeError("Post-grant membership observation unavailable");
    return members;
  }
}

describe("windowless native protocol", () => {
  it("binds selected go-live failures to rendered evidence and authority, retaining durable decisions without auto-close", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "migmate-web-go-live-recovery-"));
    const fixture = fileFixture([
      { id: "one", parentId: "source-root", name: "one", kind: "folder" },
      { id: "two", parentId: "source-root", name: "two", kind: "folder" },
      { id: "first", parentId: "one", name: "first.txt", kind: "file", content: "first" },
      { id: "second", parentId: "two", name: "second.txt", kind: "file", content: "second" },
    ]);
    fixture.googleAbout = {
      user: { emailAddress: "files@example.com" },
      canCreateDrives: true,
    };
    const provider = new RecoveryProvider(fixture);
    let engine = openEngine({ home, provider, adapter: "web" });
    const created = await engine.initJob({
      type: "file_migration",
      config: { mappings: [], options: { memberGrants: "after_verification" } },
    });
    assert.ok(created.ok);
    let session = new WebSession({ engine, job: created.value });
    t.after(async () => {
      await session.close();
      engine.close();
      rmSync(home, { recursive: true, force: true });
    });
    const loaded = await engine.withWriterResult(created.value, (writer) =>
      writer.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: ["one", "two"].map((id) => ({
            id,
            source: { type: "sharepoint", driveId: "source-drive", folderPath: id },
            destination: { type: "google_shared_drive", create: id },
            members: [{ email: `${id}@example.test`, type: "group", role: "writer" }],
          })),
        }),
      }),
    );
    assert.ok(loaded.ok);
    await session.open();
    let handle = createProtocolHandler({ session });
    const view = async (stage = "close") =>
      parse(await (await handle(new Request(`migmate://localhost/view?stage=${stage}`))).text());
    const run = async (action: string, input: Record<string, unknown> = {}) => {
      assert.equal((await handle(request(action, input, "close"))).status, 202);
      await settled(session);
    };
    const current = async () => {
      const result = await engine.reader(created.value).status();
      assert.ok(result.ok);
      return result.value;
    };
    const refused = async (input: Record<string, unknown>) => {
      const before = (await current()).goLiveAcknowledgments;
      await run("acknowledge", input);
      const snapshot = await session.snapshot({ stage: "close", phase: "plan" });
      assert.ok(snapshot.refusal);
      assert.ok(
        ["approval_digest_stale", "verification_unaccepted"].includes(snapshot.refusal.code),
      );
      assert.deepEqual((await current()).goLiveAcknowledgments, before);
      await run("acquire");
    };
    await run("plan");
    await run("approve", {
      approver: "plan reviewer",
      planDigest: capturedField(renderedForm(await view("approve"), "approve"), "planDigest"),
      confirm: true,
      confirmAccess: true,
    });
    await run("execute");
    await run("verify");
    await run("report");
    const firstDrive = (await current()).createdDrives.find((drive) => drive.mappingId === "one");
    assert.ok(firstDrive?.driveId);
    const extraMember = { email: "<extra>@example.test", type: "user", role: "reader" };
    await provider.addDriveMember(firstDrive.driveId, {
      email: extraMember.email,
      type: "user",
      role: "reader",
    });
    provider.unavailableMember = "two@example.test";
    await run("close", {
      approver: "go-live reviewer",
      evidenceDigest: capturedField(renderedForm(await view(), "close"), "evidenceDigest"),
      confirmGoLive: true,
    });
    await run("acquire");
    const initial = await current();
    assert.equal(initial.goLiveReview?.checks.length, 2);
    const initialAuthorization = initial.closeAuthorization;
    let document = await view();
    let form = renderedForm(document, "acknowledge");
    noDefaultConsent(form);
    assert.equal(attr(formField(form, "rationale"), "required"), "");
    assert.equal(attr(formField(form, "approver"), "value"), "go-live reviewer");
    assert.equal(elements(form, (element) => attr(element, "name") === "mappingIds").length, 2);
    for (const failure of initial.goLiveReview!.checks) {
      assert.ok(text(form).includes(failure.consequence));
      assert.ok(text(form).includes(JSON.stringify(failure.check.evidence, null, 2)));
      assert.ok(text(form).includes(failure.verificationAt));
    }
    assert.match(text(form), /unverified \(failed check\)/);
    assert.equal(elements(form, (element) => element.tagName === "extra").length, 0);
    assert.equal(attr(formField(renderedForm(document, "close"), "recovery"), "type"), "hidden");
    const input = {
      evidenceDigest: capturedField(form, "evidenceDigest"),
      mappingIds: ["one"],
      rationale: "  Retain the explicitly reviewed additional access <not a pass>  ",
      approver: "recovery reviewer",
      confirm: true,
    };
    for (const invalid of [
      { ...input, mappingIds: [] },
      { ...input, mappingIds: ["one", "one"] },
      { ...input, rationale: " " },
      { ...input, approver: " " },
      { ...input, confirm: false },
      { ...input, confirm: undefined },
    ])
      assert.equal((await handle(request("acknowledge", invalid, "close"))).status, 409);
    assert.deepEqual((await current()).goLiveAcknowledgments, []);
    await refused({ ...input, mappingIds: ["unknown"] });

    // A later failed observation is not the evidence captured by the old form.
    await provider.addDriveMember(firstDrive.driveId, {
      email: extraMember.email,
      type: "user",
      role: "writer",
    });
    await run("close");
    await run("acquire");
    assert.notEqual((await current()).goLiveReview?.evidenceDigest, input.evidenceDigest);
    await refused(input);
    form = renderedForm(await view(), "acknowledge");
    input.evidenceDigest = capturedField(form, "evidenceDigest");

    // A rendered decision cannot authorize a changed deferred-access policy.
    const configPath = join(home, "jobs", created.value.id, "job.toml");
    const originalConfig = await readFile(configPath, "utf8");
    await writeFile(configPath, originalConfig.replace("after_verification", "before_copy"));
    assert.equal((await current()).goLiveReview, null);
    await refused(input);
    await writeFile(configPath, originalConfig);

    const reviewed = (await current()).goLiveReview;
    assert.ok(reviewed);
    await run("acknowledge", input);
    const acknowledged = await current();
    assert.notEqual(acknowledged.state, "closed");
    assert.equal(acknowledged.goLiveAcknowledgments?.length, 1);
    const record = acknowledged.goLiveAcknowledgments![0]!;
    assert.equal(record.evidenceDigest, input.evidenceDigest);
    assert.equal(record.authorityDigest, reviewed.authorityDigest);
    assert.deepEqual(
      record.checks,
      reviewed.checks.filter((check) => check.mappingId === "one"),
    );
    assert.equal(record.approver, input.approver);
    assert.equal(record.rationale, input.rationale.trim());
    assert.equal(record.mode, "interactive");
    assert.equal(record.identityAssurance, "declared_unverified");
    assert.ok(Number.isFinite(Date.parse(record.at)));
    assert.equal(record.checks.length, 1);
    assert.equal(record.checks[0]?.mappingId, "one");
    assert.equal(record.checks[0]?.check.status, "failed");
    assert.deepEqual(acknowledged.closeAuthorization, initialAuthorization);
    assert.deepEqual(
      acknowledged.goLiveReview?.checks.map((check) => check.mappingId),
      ["two"],
    );
    assert.equal(acknowledged.incompleteClose?.checksPassed, false);
    assert.equal(acknowledged.incompleteClose?.checksSettled, false);

    // Old selection/digest cannot implicitly accept a remaining or already-settled check.
    await refused({ ...input, mappingIds: ["two"] });
    form = renderedForm(await view(), "acknowledge");
    assert.equal(attr(formField(form, "approver"), "value"), input.approver);
    noDefaultConsent(form);
    const remainingDigest = capturedField(form, "evidenceDigest");
    await refused({ ...input, evidenceDigest: remainingDigest, mappingIds: ["one"] });
    await run("acknowledge", {
      ...input,
      evidenceDigest: remainingDigest,
      mappingIds: ["two"],
      rationale: "End the job without membership proof for this selected drive",
    });
    const decisions = (await current()).goLiveAcknowledgments;
    assert.equal(decisions?.length, 2);
    assert.equal((await current()).incompleteClose?.checksPassed, false);
    assert.equal((await current()).incompleteClose?.checksSettled, true);
    assert.notEqual((await current()).state, "closed");

    await session.close();
    engine.close();
    engine = openEngine({ home, provider, adapter: "web" });
    session = new WebSession({ engine, job: created.value });
    await session.open();
    handle = createProtocolHandler({ session });
    assert.deepEqual((await current()).goLiveAcknowledgments, decisions);
    document = await view();
    assert.ok(text(document).includes(input.rationale.trim()));
    assert.ok(text(document).includes("declared_unverified"));
    assert.equal(
      elements(document, (element) => attr(element, "data-action") === "acknowledge").length,
      0,
    );
    await run("close");
    const closed = await current();
    assert.equal(closed.state, "closed");
    assert.equal(closed.closureOutcome, "completed_with_accepted_exceptions");
    assert.deepEqual(closed.goLiveAcknowledgments, decisions);
    assert.ok(closed.createdDrives.every((drive) => drive.goLive?.check?.status === "failed"));
    assert.deepEqual(closed.closeAuthorization, initialAuthorization);
    assert.ok(text(await view()).includes(input.rationale.trim()));
  });

  it("projects the ten-verb rail and unknown-denominator counts without inventing progress", async () => {
    const engine = readerEngine(status(), EMPTY);
    const session = new WebSession({ engine, job: JOB });
    const handle = createProtocolHandler({ session });
    const response = await handle(new Request("migmate://localhost/view?stage=status"));
    const document = parse(await response.text());
    const rail = elements(document, (element) => attr(element, "data-stage") !== undefined);
    assert.deepEqual(
      rail.map((element) => attr(element, "data-stage")),
      VERBS,
    );
    assert.equal(
      text(rail.find((element) => attr(element, "data-stage") === "approve")!),
      "approvecurrent",
    );
    assert.match(text(document), /27.*total not known/);
    assert.doesNotMatch(text(document), /\d\s*%/);
    assert.match(text(document), /durable-page-3/);
    assert.match(text(document), /recorded-group/);
    assert.match(text(document), /reviewed-plan-digest/);
    await session.close();
  });

  it("shows mapping pass state, transfer stats and escaped failures in execute and status views", async () => {
    const projected = status();
    projected.progress = null;
    projected.mappingPasses = [
      {
        revision: 1,
        mappingId: "waiting",
        passNumber: 1,
        mode: "copy",
        executeId: null,
        jobid: null,
        group: null,
        status: "pending",
        startedAt: null,
        endedAt: null,
        lastStats: null,
        error: null,
      },
      {
        revision: 1,
        mappingId: "copying",
        passNumber: 2,
        mode: "copy",
        executeId: "worker",
        jobid: 7,
        group: "group-7",
        status: "running",
        startedAt: "2026-10-01T00:00:00Z",
        endedAt: null,
        lastStats: { bytes: 8192, files: 3, speed: 1024, errors: 0, transferring: [] },
        error: null,
      },
      {
        revision: 1,
        mappingId: "failed <mapping>",
        passNumber: 1,
        mode: "copy",
        executeId: "worker",
        jobid: 6,
        group: "group-6",
        status: "failed",
        startedAt: "2026-10-01T00:00:00Z",
        endedAt: "2026-10-01T00:00:05Z",
        lastStats: { bytes: 4096, files: 1, speed: 0, errors: 2, transferring: [] },
        error: '<img src="bad" onerror="steal()"> access denied',
      },
    ];
    const session = new WebSession({ engine: readerEngine(projected, EMPTY), job: JOB });
    const handle = createProtocolHandler({ session });
    for (const stage of ["execute", "status"]) {
      const document = parse(
        await (await handle(new Request(`migmate://localhost/view?stage=${stage}`))).text(),
      );
      const table = elements(
        document,
        (element) =>
          element.tagName === "table" &&
          elements(element, (child) => child.tagName === "th" && text(child) === "Mapping").length >
            0,
      )[0];
      assert.ok(table, `Mapping progress is missing from ${stage}`);
      const rows = elements(table, (element) => element.tagName === "tr").slice(1);
      const cells = rows.map((row) =>
        elements(row, (element) => element.tagName === "td").map(text),
      );
      assert.deepEqual(
        cells.map((row) => row.slice(0, 7)),
        [
          ["waiting", "1", "pending", "—", "—", "—", "—"],
          ["copying", "2", "running", "8192", "3", "1024 bytes/s", "0"],
          ["failed <mapping>", "1", "failed", "4096", "1", "0 bytes/s", "2"],
        ],
      );
      assert.equal(cells[2]?.[7], '<img src="bad" onerror="steal()"> access denied');
      assert.equal(elements(table, (element) => element.tagName === "img").length, 0);
    }
    await session.close();
  });

  for (const code of ["lease_held", "lease_stale_worker_alive"] as const) {
    it(`${code} flips every ownership statement read-only and preserves the safe recovery facts`, async () => {
      const refusal: Refusal = {
        code,
        message: "The job cannot be acquired.",
        recovery: {
          workerAlive: code === "lease_stale_worker_alive",
          recordedHostId: "this-host",
          thisHostId: "this-host",
          holder: {
            ownerUuid: "other-owner",
            pid: 900,
            processStartTime: 42,
            heartbeatAt: "2026-09-01T00:00:00Z",
            heartbeatAgeMs: 45000,
            kind: "cli",
          },
          workerGroup: "recorded-group",
          lastCheckpoint: "durable-page-3",
          reclaimable: false,
        },
      };
      const session = new WebSession({ engine: readerEngine(status(), EMPTY, refusal), job: JOB });
      await session.open();
      const handle = createProtocolHandler({ session });
      const document = parse(
        await (await handle(new Request("migmate://localhost/view?stage=execute"))).text(),
      );
      const claims = elements(document, (element) => attr(element, "data-ownership") !== undefined);
      assert.ok(claims.length >= 3);
      for (const claim of claims) assert.match(text(claim), /^Read-only/);
      assert.doesNotMatch(text(document), /Writer access held/);
      assert.match(text(document), /other-owner/);
      const execute = elements(
        document,
        (element) => attr(element, "data-action") === "execute",
      )[0]!;
      assert.equal(
        elements(
          execute,
          (element) => element.tagName === "fieldset" && attr(element, "disabled") !== undefined,
        ).length,
        1,
      );
      const reclaim = elements(
        document,
        (element) => attr(element, "data-action") === "reclaim",
      )[0]!;
      assert.equal(
        elements(
          reclaim,
          (element) =>
            attr(element, "name") === "confirm" && attr(element, "checked") === undefined,
        ).length,
        1,
      );
      if (code === "lease_stale_worker_alive")
        assert.equal(
          elements(
            reclaim,
            (element) =>
              attr(element, "name") === "stopWorker" && attr(element, "required") !== undefined,
          ).length,
          1,
        );
      await session.close();
    });
  }

  it("escapes notebook guidance and permits only HTTP source links", async () => {
    for (const sourceWebUrl of [
      'https://source.example/notebook?a=1&label="<img>"',
      "http://source.example/notebook",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/relative-notebook",
    ]) {
      const page: RowPage = {
        facets: [{ code: "source_package_omitted", kind: "planned_omission", count: 1 }],
        totalRows: 1,
        nextCursor: null,
        rows: [
          {
            id: "notebook",
            jobType: "file_migration",
            mappingId: "mapping",
            sourceItemId: "notebook",
            relativePath: "Notebook",
            size: null,
            destinationFileId: null,
            provenanceState: "none",
            code: "source_package_omitted",
            kind: "planned_omission",
            phase: "plan",
            revision: 1,
            accepted: false,
            sourceWebUrl,
            sourcePackageSections: 0,
            omissionReason: "Cannot open <notebook> & sections",
            nextStep: 'Export <img src="bad" onerror="steal()"> & upload',
          },
        ],
      };
      const session = new WebSession({ engine: readerEngine(status(), page), job: JOB });
      try {
        const handle = createProtocolHandler({ session });
        const document = parse(
          await (await handle(new Request("migmate://localhost/view?stage=plan"))).text(),
        );
        const row = elements(
          document,
          (element) =>
            element.tagName === "tr" && attr(element, "data-code") === "source_package_omitted",
        )[0]!;
        assert.match(text(row), /0 sections/);
        assert.ok(text(row).includes("Cannot open <notebook> & sections"));
        assert.ok(text(row).includes('Export <img src="bad" onerror="steal()"> & upload'));
        assert.equal(
          elements(row, (element) => ["img", "script", "notebook"].includes(element.tagName))
            .length,
          0,
        );
        const links = elements(row, (element) => element.tagName === "a");
        if (sourceWebUrl.startsWith("http")) {
          assert.equal(links.length, 1);
          assert.equal(attr(links[0]!, "href"), sourceWebUrl);
        } else assert.equal(links.length, 0);
      } finally {
        await session.close();
      }
    }
  });

  it("renders conversation identities and accepted omissions safely through the same review query", async () => {
    const projected = {
      ...status(),
      jobType: "teams_archive" as const,
      verificationDigest: "verification-digest",
    };
    const page: RowPage = {
      facets: [{ code: "retained_history_not_requested", kind: "planned_omission", count: 18000 }],
      totalRows: 18000,
      nextCursor: "next-page",
      rows: [
        {
          id: "conversation-row",
          code: "retained_history_not_requested",
          kind: "planned_omission",
          phase: "verify",
          revision: 1,
          accepted: true,
          jobType: "teams_archive",
          scopeEntryId: "scope-1",
          conversationId: '<img src="https://attacker.invalid" onerror="steal()">',
          records: 7,
          assets: 3,
          watermark: "last-page",
        },
      ],
    };
    const session = new WebSession({ engine: readerEngine(projected, page), job: JOB });
    const handle = createProtocolHandler({ session });
    const document = parse(
      await (await handle(new Request("migmate://localhost/view?stage=verify"))).text(),
    );
    assert.equal(
      elements(document, (element) => element.tagName === "img" || element.tagName === "script")
        .length,
      0,
    );
    assert.match(text(document), /18000 matching rows/);
    assert.match(text(document), /7 records · 3 assets/);
    assert.match(text(document), /Accepted exception — still disclosed/);
    assert.equal(
      elements(document, (element) => attr(element, "data-next-cursor") === "next-page").length,
      1,
    );
    await session.close();
  });

  it("serves only exact embedded paths and rejects cross-origin, unknown, and non-JSON actions", async () => {
    const session = new WebSession({ engine: readerEngine(status(), EMPTY), job: JOB });
    const handle = createProtocolHandler({ session });
    const root = await handle(new Request("migmate://localhost/"));
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.match(root.headers.get("content-security-policy")!, /form-action 'none'/);
    assert.equal(root.headers.get("access-control-allow-origin"), null);
    const attacks: [Request, number][] = [
      [new Request("migmate://localhost/engine/state.db"), 404],
      [new Request("migmate://localhost/%2e%2e/%2e%2e/etc/passwd"), 404],
      [new Request("migmate://localhost/client.js?file=/etc/passwd"), 404],
      [new Request("migmate://other/"), 403],
      [new Request("http://migmate.localhost/"), 403],
      [new Request("migmate://localhost/view?stage=status&job=other-job"), 400],
      [new Request("migmate://localhost/view?stage=plan&codes=constructor"), 400],
      [new Request("migmate://localhost/view?stage=plan&codes=not_registered"), 400],
      [
        new Request("migmate://localhost/command", {
          method: "POST",
          headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
          body: "{}",
        }),
        403,
      ],
      [
        new Request("migmate://localhost/command", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        }),
        415,
      ],
      [new Request("migmate://localhost/command", { method: "GET" }), 405],
      [request("auto-approve"), 409],
      [
        request("accept", {
          approver: "operator",
          verificationDigest: "digest",
          codes: ["*"],
          rationale: "Explicit but invalid selection",
          confirm: true,
        }),
        409,
      ],
      [request("approve", { approver: "operator", planDigest: "digest" }), 409],
    ];
    for (const [attack, expected] of attacks)
      assert.equal((await handle(attack)).status, expected, attack.url);
    assert.equal(allowedNavigation("migmate://localhost/"), true);
    assert.equal(allowedNavigation("migmate://localhost/client.js"), false);
    assert.equal(allowedNavigation("https://attacker.invalid/"), false);
    assert.equal(allowedNavigation("file:///etc/passwd"), false);
    await session.close();
  });

  it("reviews final mapping scope and requires a complete explicit freeze attestation", async () => {
    const home = mkdtempSync(join(tmpdir(), "migmate-web-final-"));
    const engine = openEngine({
      home,
      provider: new FakeFileMigrationPort(fileFixture()),
      adapter: "web",
    });
    let session: WebSession | undefined;
    try {
      const config = fileConfig();
      config.options = { ...config.options, staged: true };
      const created = await engine.initJob({ type: "file_migration", config });
      assert.ok(created.ok);
      session = new WebSession({ engine, job: created.value });
      await session.open();
      const handle = createProtocolHandler({ session });
      assert.equal((await handle(request("plan", { final: true }, "plan"))).status, 202);
      await settled(session);
      const planned = await engine.reader(created.value).status();
      assert.ok(planned.ok);
      assert.equal(planned.value.currentPlan?.stage, "final");
      const document = parse(
        await (await handle(new Request("migmate://localhost/view?stage=approve"))).text(),
      );
      assert.doesNotMatch(text(document), /inventory age/i);
      for (const name of ["freezeBy", "freezeAt", "freezeHow"])
        assert.equal(
          elements(
            document,
            (element) => attr(element, "name") === name && attr(element, "required") !== undefined,
          ).length,
          1,
        );
      const approval = {
        approver: "operator",
        planDigest: planned.value.planDigest,
        confirm: true,
      };
      assert.equal(
        (await handle(request("approve", { ...approval, freezeBy: "Morgan" }))).status,
        409,
      );
      assert.equal(
        (
          await handle(
            request("approve", {
              ...approval,
              freezeBy: "Morgan",
              freezeAt: "yesterday",
              freezeHow: "Read only",
            }),
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await handle(
            request("approve", {
              ...approval,
              freezeBy: "Morgan",
              freezeAt: "2026-10-04T12:00:00Z",
              freezeHow: "Read only",
            }),
          )
        ).status,
        202,
      );
      await settled(session);
      const approved = await engine.reader(created.value).status();
      assert.ok(approved.ok);
      assert.equal(approved.value.state, "approved");
    } finally {
      await session?.close();
      engine.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reviews a map-only plan and pages verification findings without changing approval", async () => {
    const home = mkdtempSync(join(tmpdir(), "migmate-web-"));
    const provider = new FakeFileMigrationPort(
      fileFixture(
        Array.from({ length: 61 }, (_, index) => ({
          id: `file-${index}`,
          parentId: "source-root",
          name: `file-${String(index).padStart(2, "0")}.txt`,
          kind: "file" as const,
          content: "original",
        })),
      ),
    );
    const engine = openEngine({ home, provider, adapter: "web" });
    let session: WebSession | undefined;
    try {
      const created = await engine.initJob({ type: "file_migration", config: fileConfig() });
      assert.ok(created.ok);
      session = new WebSession({ engine, job: created.value });
      await session.open();
      const handle = createProtocolHandler({ session });
      assert.equal((await handle(request("plan", {}, "plan"))).status, 202);
      await settled(session);
      const planned = await engine.reader(created.value).status();
      assert.ok(planned.ok);
      const review = await engine.reader(created.value).rows({ phase: "plan", limit: 25 });
      assert.ok(review.ok);
      assert.equal(review.value.totalRows, 1);
      assert.equal(planned.value.state, "planned");
      assert.equal(
        (
          await handle(
            request(
              "approve",
              {
                approver: "operator",
                planDigest: planned.value.planDigest,
                confirm: true,
              },
              "approve",
            ),
          )
        ).status,
        202,
      );
      await settled(session);
      assert.equal((await handle(request("execute"))).status, 202);
      await settled(session);
      for (const item of provider.snapshotDestination())
        if (item.kind === "file") provider.mutateDestinationContent(item.id, "changed and longer");
      assert.equal((await handle(request("verify"))).status, 202);
      await settled(session);
      const first = parse(
        await (
          await handle(
            new Request("migmate://localhost/view?stage=verify&limit=25&codes=size_mismatch"),
          )
        ).text(),
      );
      const rows = (document: DefaultTreeAdapterMap["document"]) =>
        elements(
          document,
          (element) => element.tagName === "tr" && attr(element, "data-code") === "size_mismatch",
        );
      assert.equal(rows(first).length, 25);
      assert.match(text(first), /61 matching rows/);
      const cursor = attr(
        elements(first, (element) => attr(element, "data-next-cursor") !== undefined)[0]!,
        "data-next-cursor",
      )!;
      const second = parse(
        await (
          await handle(
            new Request(
              `migmate://localhost/view?stage=verify&limit=25&codes=size_mismatch&cursor=${encodeURIComponent(cursor)}`,
            ),
          )
        ).text(),
      );
      assert.equal(rows(second).length, 25);
      const firstRows = rows(first).map(text);
      assert.ok(rows(second).every((row) => !firstRows.includes(text(row))));
      const observed = await engine.reader(created.value).status();
      assert.ok(observed.ok);
      assert.equal(observed.value.currentApproval?.planDigest, planned.value.planDigest);
    } finally {
      await session?.close();
      engine.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("captures approval evidence, refuses stale or cancelled review, and reuses only recorded interactive identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "migmate-web-handoff-"));
    const provider = new FakeFileMigrationPort(
      fileFixture([
        { id: "notebook", parentId: "source-root", name: "Original notebook", kind: "package" },
      ]),
    );
    const engine = openEngine({ home, provider, adapter: "web" });
    let session: WebSession | undefined;
    try {
      const created = await engine.initJob({ type: "file_migration", config: fileConfig() });
      assert.ok(created.ok);
      session = new WebSession({ engine, job: created.value });
      await session.open();
      const handle = createProtocolHandler({ session });
      const review = async () =>
        renderedForm(
          parse(await (await handle(new Request("migmate://localhost/view?stage=approve"))).text()),
          "approve",
        );
      assert.equal((await handle(request("plan"))).status, 202);
      await settled(session);
      const first = await review();
      noDefaultConsent(first);
      assert.equal(
        attr(formField(first, "approver"), "value"),
        `${userInfo().username}@${hostname()}`,
      );
      assert.equal(attr(formField(first, "approver"), "readonly"), undefined);
      const firstDigest = capturedField(first, "planDigest");
      assert.equal(
        (
          await handle(
            request("approve", {
              approver: "cancelled identity",
              planDigest: firstDigest,
              confirm: false,
            }),
          )
        ).status,
        409,
      );
      let projected = await engine.reader(created.value).status();
      assert.ok(projected.ok);
      assert.equal(projected.value.currentApproval, null);
      assert.equal(projected.value.lastInteractiveIdentity, null);

      provider.mutateSourceItem("notebook", { name: "Changed notebook", etag: "changed" });
      assert.equal((await handle(request("plan"))).status, 202);
      await settled(session);
      const next = await review();
      const nextDigest = capturedField(next, "planDigest");
      assert.notEqual(firstDigest, nextDigest);
      assert.equal(
        (
          await handle(
            request("approve", {
              approver: "stale identity",
              planDigest: firstDigest,
              confirm: true,
            }),
          )
        ).status,
        202,
      );
      await settled(session);
      projected = await engine.reader(created.value).status();
      assert.ok(projected.ok);
      assert.equal(projected.value.currentApproval, null);
      assert.equal(projected.value.lastInteractiveIdentity, null);
      assert.equal((await session.snapshot({ stage: "approve", phase: "plan" })).readonly, true);
      assert.equal((await handle(request("acquire"))).status, 202);
      await settled(session);
      assert.equal(
        (
          await handle(
            request("approve", {
              approver: "edited@identity",
              planDigest: nextDigest,
              confirm: true,
            }),
          )
        ).status,
        202,
      );
      await settled(session);
      projected = await engine.reader(created.value).status();
      assert.ok(projected.ok);
      assert.equal(projected.value.currentApproval?.planDigest, nextDigest);
      assert.equal(projected.value.currentApproval?.approver, "edited@identity");
      assert.equal(projected.value.currentApproval?.mode, "interactive");
      assert.equal(projected.value.currentApproval?.identityAssurance, "declared_unverified");
      assert.equal(attr(formField(await review(), "approver"), "value"), "edited@identity");
      await session.close();
      session = undefined;
      const unattended = await engine.withWriterResult(created.value, async (writer) => {
        const plan = await writer.plan();
        assert.ok(plan.ok);
        return writer.approve({
          approver: "automation",
          planDigest: plan.value.planDigest,
          mode: "unattended",
        });
      });
      assert.ok(unattended.ok);
      session = new WebSession({ engine, job: created.value });
      await session.open();
      const reopened = createProtocolHandler({ session });
      const form = renderedForm(
        parse(await (await reopened(new Request("migmate://localhost/view?stage=approve"))).text()),
        "approve",
      );
      assert.equal(attr(formField(form, "approver"), "value"), "edited@identity");
    } finally {
      await session?.close();
      engine.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reviews whole exception groups, requires a common rationale, and captures initial go-live authority", async () => {
    const home = mkdtempSync(join(tmpdir(), "migmate-web-exceptions-"));
    const provider = new FakeFileMigrationPort(
      fileFixture([
        {
          id: "file-1",
          parentId: "source-root",
          name: "one.txt",
          kind: "file",
          content: "original",
        },
        {
          id: "file-2",
          parentId: "source-root",
          name: "two.txt",
          kind: "file",
          content: "original",
        },
        {
          id: "file-3",
          parentId: "source-root",
          name: "missing.txt",
          kind: "file",
          content: "original",
        },
      ]),
    );
    const engine = openEngine({ home, provider, adapter: "web" });
    let session: WebSession | undefined;
    try {
      const created = await engine.initJob({
        type: "file_migration",
        config: { ...fileConfig(), options: { verificationMode: "hash" } },
      });
      assert.ok(created.ok);
      session = new WebSession({ engine, job: created.value });
      await session.open();
      const handle = createProtocolHandler({ session });
      const view = async (stage: string) =>
        parse(
          await (
            await handle(new Request(`migmate://localhost/view?stage=${stage}&limit=25`))
          ).text(),
        );
      const run = async (action: string, input: Record<string, unknown> = {}) => {
        assert.equal((await handle(request(action, input))).status, 202);
        await settled(session!);
      };
      await run("plan");
      await run("approve", {
        approver: "reviewer",
        planDigest: capturedField(renderedForm(await view("approve"), "approve"), "planDigest"),
        confirm: true,
      });
      await run("execute");
      for (const item of provider.snapshotDestination()) {
        if (item.path === "one.txt" || item.path === "two.txt")
          provider.mutateDestinationContent(item.id, "modified");
        if (item.path === "missing.txt") provider.removeDestinationItem(item.id);
      }
      await run("verify");
      const document = await view("verify");
      const form = renderedForm(document, "accept");
      noDefaultConsent(form);
      assert.equal(attr(formField(form, "approver"), "value"), "reviewer");
      assert.equal(attr(formField(form, "rationale"), "required"), "");
      let projected = await engine.reader(created.value).status();
      assert.ok(projected.ok);
      const group = projected.value.exceptionGroups?.find(
        (entry) => entry.code === "content_mismatch",
      );
      assert.ok(group);
      assert.equal(group.count, 2);
      assert.ok(group.examples.length > 0);
      const groupElement = elements(
        form,
        (element) => attr(element, "data-exception-code") === group.code,
      )[0]!;
      assert.ok(text(groupElement).includes(group.consequence));
      for (const example of group.examples) assert.ok(text(groupElement).includes(example));
      assert.equal(attr(formField(groupElement, "codes"), "value"), group.code);
      const input = {
        approver: "exception reviewer",
        verificationDigest: capturedField(form, "verificationDigest"),
        codes: [group.code, "destination_missing"],
        rationale: "  Preserve source originals separately  ",
        confirm: true,
      };
      for (const invalid of [
        { ...input, rationale: " " },
        { ...input, codes: [] },
        { ...input, confirm: false },
      ])
        assert.equal((await handle(request("accept", invalid))).status, 409);
      projected = await engine.reader(created.value).status();
      assert.ok(projected.ok);
      assert.deepEqual(projected.value.acceptedExceptions, []);
      await run("verify");
      await run("accept", input);
      projected = await engine.reader(created.value).status();
      assert.ok(projected.ok);
      assert.deepEqual(projected.value.acceptedExceptions, []);
      await run("acquire");
      const currentForm = renderedForm(await view("verify"), "accept");
      await run("accept", {
        ...input,
        verificationDigest: capturedField(currentForm, "verificationDigest"),
      });
      projected = await engine.reader(created.value).status();
      assert.ok(projected.ok);
      assert.deepEqual(
        projected.value.acceptedExceptions
          ?.map((record) => ({
            code: record.code,
            note: record.note,
            mode: record.mode,
            identityAssurance: record.identityAssurance,
          }))
          .sort((a, b) => a.code.localeCompare(b.code)),
        input.codes
          .map((code) => ({
            code,
            note: input.rationale.trim(),
            mode: "interactive",
            identityAssurance: "declared_unverified",
          }))
          .sort((a, b) => a.code.localeCompare(b.code)),
      );
      const acceptedView = await view("verify");
      assert.ok(text(acceptedView).includes(input.rationale.trim()));
      assert.equal(
        elements(
          renderedForm(acceptedView, "accept"),
          (element) => attr(element, "name") === "codes",
        ).length,
        0,
      );
      await run("report");
      const closeForm = renderedForm(await view("close"), "close");
      noDefaultConsent(closeForm);
      assert.equal(attr(formField(closeForm, "approver"), "value"), "exception reviewer");
      const closeInput = {
        approver: "go-live reviewer",
        evidenceDigest: capturedField(closeForm, "evidenceDigest"),
        confirmGoLive: true,
      };
      assert.equal(
        (await handle(request("close", { ...closeInput, confirmGoLive: false }))).status,
        409,
      );
      projected = await engine.reader(created.value).status();
      assert.ok(projected.ok);
      assert.equal(projected.value.closeAuthorization, null);
      await run("verify");
      await run("close", closeInput);
      projected = await engine.reader(created.value).status();
      assert.ok(projected.ok);
      assert.equal(projected.value.closeAuthorization, null);
      assert.notEqual(projected.value.state, "closed");
      await run("acquire");
      await run("accept", {
        ...input,
        verificationDigest: capturedField(
          renderedForm(await view("verify"), "accept"),
          "verificationDigest",
        ),
      });
      await run("report");
      closeInput.evidenceDigest = capturedField(
        renderedForm(await view("close"), "close"),
        "evidenceDigest",
      );
      await run("close", closeInput);
      projected = await engine.reader(created.value).status();
      assert.ok(projected.ok);
      assert.equal(projected.value.state, "closed");
      assert.equal(projected.value.closeAuthorization?.evidenceDigest, closeInput.evidenceDigest);
      assert.equal(projected.value.closeAuthorization?.approver, closeInput.approver);
      assert.equal(projected.value.closeAuthorization?.mode, "interactive");
      assert.equal(projected.value.closeAuthorization?.identityAssurance, "declared_unverified");
    } finally {
      await session?.close();
      engine.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("confirms expanded authority once and resumes durably authorized go-live without another challenge", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "migmate-web-authority-"));
    const fixture = fileFixture([
      { id: "file", parentId: "source-root", name: "a.txt", kind: "file", content: "proof" },
    ]);
    fixture.googleAbout = {
      user: { emailAddress: "files@example.com" },
      canCreateDrives: true,
    };
    const provider = new RecoveryProvider(fixture);
    const engine = openEngine({ home, provider, adapter: "web" });
    const created = await engine.initJob({
      type: "file_migration",
      config: {
        mappings: [],
        options: { mirror: true, deleteLimit: 10, memberGrants: "after_verification" },
      },
    });
    assert.ok(created.ok);
    const session = new WebSession({ engine, job: created.value });
    t.after(async () => {
      await session.close();
      engine.close();
      rmSync(home, { recursive: true, force: true });
    });
    const loaded = await engine.withWriterResult(created.value, (writer) =>
      writer.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [
            {
              id: "mapping",
              source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
              destination: { type: "google_shared_drive", create: "Reviewed destination" },
              members: [
                { email: "one@example.test", type: "user", role: "writer" },
                { email: "two@example.test", type: "group", role: "reader" },
              ],
            },
          ],
        }),
      }),
    );
    assert.ok(loaded.ok);
    await session.open();
    const handle = createProtocolHandler({ session });
    const view = async (stage: string) =>
      parse(await (await handle(new Request(`migmate://localhost/view?stage=${stage}`))).text());
    const run = async (action: string, input: Record<string, unknown> = {}) => {
      assert.equal((await handle(request(action, input))).status, 202);
      await settled(session);
    };
    await run("plan");
    let form = renderedForm(await view("approve"), "approve");
    noDefaultConsent(form);
    for (const name of ["confirmMirror", "confirmAccess"]) {
      assert.equal(elements(form, (element) => attr(element, "name") === name).length, 1);
      assert.equal(attr(formField(form, name), "required"), "");
    }
    for (const identity of ["one@example.test", "two@example.test"])
      assert.ok(text(form).includes(identity));
    const input = {
      approver: "operator",
      planDigest: capturedField(form, "planDigest"),
      confirm: true,
      confirmMirror: true,
      confirmAccess: true,
    };
    await run("approve", { ...input, confirmAccess: false });
    let projected = await engine.reader(created.value).status();
    assert.ok(projected.ok);
    assert.equal(projected.value.currentApproval, null);
    await run("acquire");
    await run("approve", input);
    projected = await engine.reader(created.value).status();
    assert.ok(projected.ok);
    assert.equal(projected.value.state, "approved");
    assert.equal(projected.value.currentApproval?.planDigest, input.planDigest);
    await run("plan");
    form = renderedForm(await view("approve"), "approve");
    for (const name of ["confirmMirror", "confirmAccess"])
      assert.equal(elements(form, (element) => attr(element, "name") === name).length, 0);
    assert.equal(attr(formField(form, "confirm"), "required"), "");
    await run("approve", {
      approver: "operator",
      planDigest: capturedField(form, "planDigest"),
      confirm: true,
    });
    await run("execute");
    const closeForm = renderedForm(await view("close"), "close");
    noDefaultConsent(closeForm);
    provider.unavailableMember = "two@example.test";
    await run("close", {
      approver: "go-live reviewer",
      evidenceDigest: capturedField(closeForm, "evidenceDigest"),
      confirmGoLive: true,
    });
    projected = await engine.reader(created.value).status();
    assert.ok(projected.ok);
    assert.equal(projected.value.state, "verified");
    assert.equal(projected.value.createdDrives[0]?.goLive?.check?.status, "failed");
    const authorization = projected.value.closeAuthorization;
    assert.equal(authorization?.approver, "go-live reviewer");
    assert.equal(authorization?.mode, "interactive");
    await run("acquire");
    const recovery = renderedForm(await view("close"), "close");
    assert.equal(attr(formField(recovery, "recovery"), "type"), "hidden");
    for (const name of ["confirmGoLive", "approver"])
      assert.equal(elements(recovery, (element) => attr(element, "name") === name).length, 0);
    provider.unavailableMember = null;
    await run("close");
    projected = await engine.reader(created.value).status();
    assert.ok(projected.ok);
    assert.equal(projected.value.state, "closed");
    assert.equal(projected.value.createdDrives[0]?.goLive?.check?.status, "passed");
    assert.deepEqual(projected.value.closeAuthorization, authorization);
    const artifacts = await engine.reader(created.value).artifacts();
    assert.ok(artifacts.ok);
    assert.ok(artifacts.value.artifacts.some((artifact) => artifact.name === "report.json"));
  });

  it(
    "safe process quit interrupts plan collection and releases the real writer lease",
    { timeout: 5000 },
    async (t) => {
      const home = mkdtempSync(join(tmpdir(), "migmate-web-plan-abort-"));
      const provider = new FakeFileMigrationPort(fileFixture());
      const engine = openEngine({ home, provider, adapter: "web" });
      const created = await engine.initJob({ type: "file_migration", config: fileConfig() });
      assert.ok(created.ok);
      const session = new WebSession({ engine, job: created.value });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const list = provider.resolveSourceRoot.bind(provider);
      provider.resolveSourceRoot = async (
        input: Parameters<ProviderPort["resolveSourceRoot"]>[0],
      ) => {
        const abort = () => release.resolve();
        input.signal?.addEventListener("abort", abort, { once: true });
        entered.resolve();
        try {
          input.signal?.throwIfAborted();
          await release.promise;
          input.signal?.throwIfAborted();
          return list(input);
        } finally {
          input.signal?.removeEventListener("abort", abort);
        }
      };
      t.after(async () => {
        release.resolve();
        await session.close();
        engine.close();
        rmSync(home, { recursive: true, force: true });
      });
      await session.open();
      assert.ok(session.command({ action: "plan", input: {} }).ok);
      await entered.promise;
      await session.close(true);
      assert.equal(session.interrupted, true);
      const status = await engine.reader(created.value).status();
      assert.ok(status.ok);
      assert.equal(status.value.ownership.held, false);
      assert.equal(status.value.planDigest, null);
      provider.resolveSourceRoot = list;
      assert.ok((await engine.withWriterResult(created.value, (writer) => writer.plan())).ok);
    },
  );

  it("keeps an in-flight execute inside the writer scope after window close, but interrupts on process quit", async () => {
    for (const interrupt of [false, true]) {
      let finishExecute!: () => void;
      let began!: () => void;
      const executing = new Promise<void>((resolve) => {
        began = resolve;
      });
      const checkpoint = new Promise<void>((resolve) => {
        finishExecute = resolve;
      });
      let aborted = false;
      const unsupported = async (): Promise<never> => {
        throw new Error("Unexpected mutation");
      };
      const writer: JobWriter = {
        loadManifest: unsupported,
        onboard: unsupported,
        doctor: unsupported,
        plan: unsupported,
        approve: unsupported,
        verify: unsupported,
        accept: unsupported,
        acknowledgeGoLive: unsupported,
        report: unsupported,
        close: unsupported,
        cancel: unsupported,
        async execute(options) {
          began();
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              finishExecute();
            },
            { once: true },
          );
          await checkpoint;
          return {
            ok: true,
            value: {
              outcome: aborted ? "interrupted" : "completed",
              checkpoint: "committed-unit",
              committedUnits: 1,
              resumable: aborted,
            },
          };
        },
      };
      const engine = readerEngine(status(), EMPTY, undefined, writer);
      const session = new WebSession({ engine, job: JOB });
      await session.open();
      assert.ok(session.command({ action: "execute", input: {} }).ok);
      await executing;
      let closed = false;
      const closing = session.close(interrupt).then(() => {
        closed = true;
      });
      await nextTurn();
      assert.equal(aborted, interrupt);
      if (!interrupt) {
        assert.equal(closed, false);
        finishExecute();
      }
      await closing;
      assert.equal(session.interrupted, interrupt);
      assert.equal(session.command({ action: "execute", input: {} }).ok, false);
    }
  });
});
