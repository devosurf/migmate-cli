import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("windowless native protocol", () => {
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
          codes: [{ code: "*" }],
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

  it("reviews final inventory age and requires a complete explicit freeze attestation", async () => {
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
      assert.match(text(document), /inventory age/i);
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

  it("pages and facets real file evidence without changing approval, then binds an explicit approval to its digest", async () => {
    const home = mkdtempSync(join(tmpdir(), "migmate-web-"));
    const provider = new FakeFileMigrationPort(
      fileFixture(
        Array.from({ length: 61 }, (_, index) => ({
          id: `package-${index}`,
          parentId: "source-root",
          name: `package-${String(index).padStart(2, "0")}`,
          kind: "package" as const,
          webUrl: `https://source.example/notebook/${index}?a=1&b=2`,
          packageSections: 3,
        })),
      ),
    );
    const engine = openEngine({ home, provider, adapter: "web" });
    let session: WebSession | undefined;
    try {
      const created = await engine.initJob({
        type: "file_migration",
        config: fileConfig(),
      });
      assert.ok(created.ok);
      session = new WebSession({ engine, job: created.value });
      await session.open();
      const handle = createProtocolHandler({ session });
      assert.equal((await handle(request("plan", {}, "plan"))).status, 202);
      await settled(session);
      const planned = await engine.reader(created.value).status();
      assert.ok(planned.ok);
      assert.equal(planned.value.state, "planned");
      const review = await engine.reader(created.value).rows({
        phase: "plan",
        codes: ["source_package_omitted"],
        limit: 25,
      });
      assert.ok(review.ok);
      const notebook = review.value.rows[0]!;
      assert.equal(notebook.jobType, "file_migration");
      if (notebook.jobType !== "file_migration") throw new Error("Expected file evidence");
      assert.equal(notebook.sourceWebUrl, "https://source.example/notebook/0?a=1&b=2");
      assert.equal(notebook.sourcePackageSections, 3);
      assert.ok(notebook.omissionReason);
      assert.ok(notebook.nextStep);
      const first = parse(
        await (
          await handle(
            new Request(
              "migmate://localhost/view?stage=plan&limit=25&codes=source_package_omitted",
            ),
          )
        ).text(),
      );
      assert.equal(
        elements(
          first,
          (element) =>
            element.tagName === "tr" && attr(element, "data-code") === "source_package_omitted",
        ).length,
        25,
      );
      assert.match(text(first), /61 matching rows/);
      const notebookRow = elements(
        first,
        (element) =>
          element.tagName === "tr" && attr(element, "data-code") === "source_package_omitted",
      )[0]!;
      assert.equal(
        attr(elements(notebookRow, (element) => element.tagName === "a")[0]!, "href"),
        notebook.sourceWebUrl,
      );
      assert.match(text(notebookRow), /3 sections/);
      assert.ok(text(notebookRow).includes(notebook.omissionReason!));
      assert.ok(text(notebookRow).includes(notebook.nextStep!));
      const cursor = attr(
        elements(first, (element) => attr(element, "data-next-cursor") !== undefined)[0]!,
        "data-next-cursor",
      )!;
      const second = parse(
        await (
          await handle(
            new Request(
              `migmate://localhost/view?stage=plan&limit=25&codes=source_package_omitted&cursor=${encodeURIComponent(cursor)}`,
            ),
          )
        ).text(),
      );
      assert.match(text(second), /61 matching rows/);
      const firstIds = elements(
        first,
        (element) => element.tagName === "tr" && attr(element, "data-code") !== undefined,
      ).map(text);
      const secondIds = elements(
        second,
        (element) => element.tagName === "tr" && attr(element, "data-code") !== undefined,
      ).map(text);
      assert.equal(
        secondIds.some((identity) => firstIds.includes(identity)),
        false,
      );
      const beforeApproval = await engine.reader(created.value).status();
      assert.ok(beforeApproval.ok);
      assert.equal(beforeApproval.value.state, "planned");
      assert.equal(
        (
          await handle(
            request(
              "approve",
              { approver: "operator", planDigest: planned.value.planDigest, confirm: true },
              "approve",
            ),
          )
        ).status,
        202,
      );
      await settled(session);
      const approved = await engine.reader(created.value).status();
      assert.ok(approved.ok);
      assert.equal(approved.value.state, "approved");
      assert.equal(approved.value.planDigest, planned.value.planDigest);
    } finally {
      await session?.close();
      engine.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

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
