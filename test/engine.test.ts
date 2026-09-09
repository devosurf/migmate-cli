import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openEngine } from "../src/engine/index.ts";
import type { Engine, JobRef } from "../src/engine/index.ts";
import {
  FakeFileMigrationPort,
  type FakeFileMigrationFixture,
} from "../src/engine/providers/fake.ts";

const FIXED_NOW = new Date("2026-09-01T00:00:00.000Z");

function fixture(): FakeFileMigrationFixture {
  return {
    sourceDriveId: "src-drive",
    sourceRootId: "src-root",
    destinationDriveId: "dst-drive",
    destinationRootId: "dst-root",
    sourceItems: [
      { id: "src-root", parentId: null, name: "root", kind: "folder", identity: "src-root" },
      {
        id: "zero",
        parentId: "src-root",
        name: "zero.txt",
        kind: "file",
        size: 0,
        mimeType: "text/plain",
        content: "",
        identity: "zero",
      },
      {
        id: "binary",
        parentId: "src-root",
        name: "binary.bin",
        kind: "file",
        size: 4,
        mimeType: "application/octet-stream",
        content: new Uint8Array([1, 2, 3, 4]),
        identity: "binary",
      },
      {
        id: "empty-folder",
        parentId: "src-root",
        name: "empty-folder",
        kind: "folder",
        identity: "empty-folder",
      },
    ],
    destinationItems: [
      { id: "dst-root", parentId: null, name: "root", kind: "folder", identity: "dst-root" },
    ],
  };
}

function jobConfig() {
  return {
    mappings: [
      {
        id: "map-1",
        sourceDriveId: "src-drive",
        sourceItemId: "src-root",
        destDriveId: "dst-drive",
        destFolderId: "dst-root",
      },
    ],
  };
}

interface Harness {
  engine: Engine;
  port: FakeFileMigrationPort;
  home: string;
}

function harness(overrides: Partial<FakeFileMigrationFixture> = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "migmate-engine-"));
  const port = new FakeFileMigrationPort({ ...fixture(), ...overrides });
  const engine = openEngine({ home, now: () => FIXED_NOW, provider: port });
  return { engine, port, home };
}

async function initialised(h: Harness): Promise<JobRef> {
  const created = await h.engine.initJob({ type: "file_migration", config: jobConfig() });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");
  return created.value;
}

describe("engine seam", () => {
  it("drives a file migration job from init to close", async () => {
    const h = harness();
    const ref = await initialised(h);

    const planned = await h.engine.withWriter(ref, async (w) => {
      const preflight = await w.doctor();
      assert.equal(preflight.ok, true);

      const plan = await w.plan();
      assert.equal(plan.ok, true);
      if (!plan.ok) throw new Error("unreachable");
      return plan.value;
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");

    const digest = planned.value.planDigest;
    assert.match(digest, /^[0-9a-f]{64}$/);

    const finished = await h.engine.withWriter(ref, async (w) => {
      const stale = await w.approve({
        approver: "ci",
        planDigest: "sha256:wrong",
        mode: "unattended",
      });
      assert.equal(stale.ok, false);
      if (stale.ok) throw new Error("unreachable");
      assert.equal(stale.refusal.code, "approval_digest_stale");

      const approved = await w.approve({ approver: "ci", planDigest: digest, mode: "unattended" });
      assert.equal(approved.ok, true);

      const executed = await w.execute();
      assert.equal(executed.ok, true);
      if (!executed.ok) throw new Error("unreachable");
      return executed.value;
    });
    assert.equal(finished.ok, true);
    if (!finished.ok) throw new Error("unreachable");
    assert.equal(finished.value.outcome, "completed");

    const reader = h.engine.reader(ref);
    const status = await reader.status();
    assert.equal(status.ok, true);
    if (!status.ok) throw new Error("unreachable");
    assert.ok(["verified", "needs_attention"].includes(status.value.state));

    const closed = await h.engine.withWriter(ref, async (w) => {
      const verification = await w.verify();
      assert.equal(verification.ok, true);
      if (!verification.ok) throw new Error("unreachable");

      if (!verification.value.clean) {
        const outstanding = verification.value.findings.map((f) => ({ code: f.code }));
        const accepted = await w.accept({
          verificationDigest: verification.value.verificationDigest,
          codes: outstanding,
          approver: "ci",
        });
        assert.equal(accepted.ok, true);
      }

      const report = await w.report();
      assert.equal(report.ok, true);
      if (!report.ok) throw new Error("unreachable");
      assert.ok(report.value.artifacts.some((a) => a.format === "jsonl"));
      assert.ok(report.value.artifacts.some((a) => a.format === "html"));

      return w.close();
    });
    assert.equal(closed.ok, true);
    if (!closed.ok) throw new Error("unreachable");
    assert.equal(closed.value.ok, true);
    if (!closed.value.ok) throw new Error("close refused");
    assert.equal(closed.value.value.state, "closed");
  });

  it("refuses every verb once the job is closed", async () => {
    const h = harness();
    const ref = await initialised(h);

    await h.engine.withWriter(ref, async (w) => w.cancel("operator stopped it"));

    const after = await h.engine.withWriter(ref, async (w) => w.plan());
    assert.equal(after.ok, true);
    if (!after.ok) throw new Error("unreachable");
    assert.equal(after.value.ok, false);
    if (after.value.ok) throw new Error("unreachable");
    assert.equal(after.value.refusal.code, "job_cancelled");
  });

  it("refuses a second writer while the first holds the lease", async () => {
    const h = harness();
    const ref = await initialised(h);

    const outer = await h.engine.withWriter(ref, async () => {
      return h.engine.withWriter(ref, async () => "should not run");
    });

    assert.equal(outer.ok, true);
    if (!outer.ok) throw new Error("unreachable");
    assert.equal(outer.value.ok, false);
    if (outer.value.ok) throw new Error("unreachable");
    assert.equal(outer.value.refusal.code, "lease_held");
    assert.ok(outer.value.refusal.recovery);
  });

  it("serves a lease-free reader while a writer holds the job", async () => {
    const h = harness();
    const ref = await initialised(h);

    const observed = await h.engine.withWriter(ref, async () => {
      const status = await h.engine.reader(ref).status();
      assert.equal(status.ok, true);
      if (!status.ok) throw new Error("unreachable");
      return status.value;
    });

    assert.equal(observed.ok, true);
    if (!observed.ok) throw new Error("unreachable");
    assert.equal(observed.value.ownership.held, true);
    assert.equal(observed.value.jobType, "file_migration");
  });

  it("resumes an interrupted run without duplicating destination writes", async () => {
    const h = harness();
    const ref = await initialised(h);

    const digest = await h.engine.withWriter(ref, async (w) => {
      const plan = await w.plan();
      if (!plan.ok) throw new Error("plan refused");
      return plan.value.planDigest;
    });
    assert.equal(digest.ok, true);
    if (!digest.ok) throw new Error("unreachable");

    const interrupted = await h.engine.withWriter(ref, async (w) => {
      const approved = await w.approve({
        approver: "ci",
        planDigest: digest.value,
        mode: "unattended",
      });
      assert.equal(approved.ok, true);

      // Abort before the first unit so the run stops at a commit boundary.
      const controller = new AbortController();
      controller.abort();
      return w.execute({ signal: controller.signal });
    });
    assert.equal(interrupted.ok, true);
    if (!interrupted.ok) throw new Error("unreachable");
    if (!interrupted.value.ok) throw new Error("execute refused");
    assert.equal(interrupted.value.value.outcome, "interrupted");

    const statusAfterInterrupt = await h.engine.reader(ref).status();
    assert.equal(statusAfterInterrupt.ok, true);
    if (!statusAfterInterrupt.ok) throw new Error("unreachable");
    assert.equal(statusAfterInterrupt.value.state, "interrupted");

    const resumed = await h.engine.withWriter(ref, async (w) => w.execute());
    assert.equal(resumed.ok, true);
    if (!resumed.ok) throw new Error("unreachable");
    if (!resumed.value.ok) throw new Error("resume refused");
    assert.equal(resumed.value.value.outcome, "completed");

    const names = h.port.snapshotDestination().map((e) => `${e.parentId ?? ""}/${e.name}`);
    assert.equal(
      new Set(names).size,
      names.length,
      "resume created a duplicate destination object",
    );
  });

  it("uses the production provider and refuses an unqualified route without credentials", async () => {
    const home = mkdtempSync(join(tmpdir(), "migmate-engine-"));
    const engine = openEngine({ home, now: () => FIXED_NOW });
    const created = await engine.initJob({ type: "file_migration", config: jobConfig() });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");

    const planned = await engine.withWriter(created.value, async (w) => w.plan());
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.ok, false);
    if (planned.value.ok) throw new Error("unreachable");
    assert.equal(planned.value.refusal.code, "unqualified_route");
  });

  it("streams durable events with monotonic cursors", async () => {
    const h = harness();
    const ref = await initialised(h);

    await h.engine.withWriter(ref, async (w) => {
      const plan = await w.plan();
      if (!plan.ok) throw new Error("plan refused");
      return plan.value;
    });

    const seen: number[] = [];
    for await (const event of h.engine.reader(ref).events({})) seen.push(event.cursor);

    assert.ok(seen.length > 0, "no events were recorded");
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      seen,
    );

    const resumed: number[] = [];
    const first = seen[0];
    assert.ok(first !== undefined);
    for await (const event of h.engine.reader(ref).events({ from: first }))
      resumed.push(event.cursor);
    assert.ok(!resumed.includes(first), "resumption from a cursor must be exclusive");
  });
});
