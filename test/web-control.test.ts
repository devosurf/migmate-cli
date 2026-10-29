import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import type { ProviderPort } from "../src/engine/providers/port.ts";
import { WebSession } from "../src/web/session.ts";
import { approve, fileConfig, fileFixture, value } from "./engine-fixture.ts";

async function settled(session: WebSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    const snapshot = await session.snapshot({ stage: "status", phase: "plan" });
    if (!snapshot.busy) return;
    await nextTurn();
  }
  assert.fail("The web action did not settle");
}

for (const kind of ["stop", "cancel"] as const) {
  for (const action of ["doctor", "approve", "report", "close"] as const) {
    it(
      `queued ${kind} before web ${action} leaves a readable released window`,
      { timeout: 5000 },
      async (t) => {
        const home = mkdtempSync(join(tmpdir(), "migmate-web-queued-control-"));
        const provider = new FakeFileMigrationPort(fileFixture());
        const engine = openEngine({ home, provider, adapter: "web" });
        const controller = openEngine({ home, provider, adapter: "cli" });
        const ref = value(await engine.initJob({ type: "file_migration", config: fileConfig() }));
        const session = new WebSession({ engine, job: ref });
        t.after(async () => {
          try {
            await session.close(true);
          } finally {
            controller.close();
            engine.close();
            rmSync(home, { recursive: true, force: true });
          }
        });
        const planDigest = await approve({ engine, ref });
        await session.open();
        // Enqueue synchronously before starting a command, not at the later heartbeat.
        const controlled = controller.requestControl(ref, {
          kind,
          commandId: `queued-${kind}-${action}`,
          signal: AbortSignal.timeout(2000),
        });
        assert.ok(
          session.command({
            action,
            input: action === "approve" ? { planDigest, approver: "fixture", confirm: true } : {},
          }).ok,
        );
        assert.deepEqual(await controlled, {
          ok: true,
          value: kind === "stop" ? { stopped: true } : { cancelled: true },
        });
        const snapshot = await session.snapshot({ stage: "status", phase: "plan" });
        assert.equal(snapshot.readonly, true);
        assert.equal(snapshot.busy, null);
        assert.equal(snapshot.status?.ownership.held, false);
        assert.equal(snapshot.status?.state, kind === "cancel" ? "cancelled" : "approved");
      },
    );
  }
}

describe("persistent web owner control", () => {
  for (const kind of ["stop", "cancel"] as const) {
    for (const active of [false, true]) {
      it(
        `acknowledges ${kind} after releasing an ${active ? "executing" : "idle"} web owner`,
        { timeout: 10000 },
        async (t) => {
          const home = mkdtempSync(join(tmpdir(), "migmate-web-control-"));
          const fixture = fileFixture([
            { id: "one", parentId: "source-root", name: "one.txt", kind: "file", content: "one" },
            { id: "two", parentId: "source-root", name: "two.txt", kind: "file", content: "two" },
          ]);
          fixture.copyPasses = [{ pause: true, afterFiles: 1 }];
          const provider = new FakeFileMigrationPort(fixture);
          const engine = openEngine({ home, provider, adapter: "web" });
          const controller = openEngine({ home, provider, adapter: "cli" });
          const ref = value(await engine.initJob({ type: "file_migration", config: fileConfig() }));
          const session = new WebSession({ engine, job: ref });
          t.after(async () => {
            await session.close(true);
            controller.close();
            engine.close();
            rmSync(home, { recursive: true, force: true });
          });
          await approve({ engine, ref });
          const paused = Promise.withResolvers<void>();
          const startCopyPass = provider.startCopyPass.bind(provider);
          provider.startCopyPass = async (input) => {
            const handle = await startCopyPass(input);
            await provider.waitForCopyPassPaused(handle.jobid);
            paused.resolve();
            return handle;
          };
          await session.open();
          if (active) {
            assert.ok(session.command({ action: "execute", input: {} }).ok);
            await paused.promise;
          }
          const controlled = await controller.requestControl(ref, {
            kind,
            commandId: `web-${kind}-${active ? "executing" : "idle"}`,
            reason: "Operator requested control",
            signal: AbortSignal.timeout(6500),
          });
          assert.deepEqual(controlled, {
            ok: true,
            value: kind === "stop" ? { stopped: true } : { cancelled: true },
          });
          const snapshot = await session.snapshot({ stage: "status", phase: "plan" });
          assert.equal(snapshot.readonly, true);
          assert.equal(snapshot.busy, null);
          assert.equal(snapshot.status?.ownership.held, false);
          assert.equal(snapshot.status?.worker.active, false);
          assert.equal(
            snapshot.status?.state,
            kind === "cancel" ? "cancelled" : active ? "interrupted" : "approved",
          );
          if (active) {
            assert.equal(session.interrupted, true);
            assert.equal(
              provider.snapshotDestination().filter((item) => item.kind === "file").length,
              1,
            );
          }
          assert.ok((await controller.withWriter(ref, async () => undefined)).ok);
        },
      );
    }
    it(`settles planning before ${kind} acknowledgement`, { timeout: 10000 }, async (t) => {
      const home = mkdtempSync(join(tmpdir(), "migmate-web-plan-control-"));
      const provider = new FakeFileMigrationPort(fileFixture());
      const engine = openEngine({ home, provider, adapter: "web" });
      const controller = openEngine({ home, provider, adapter: "cli" });
      const ref = value(await engine.initJob({ type: "file_migration", config: fileConfig() }));
      const session = new WebSession({ engine, job: ref });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const list = provider.listSourceChildren.bind(provider);
      provider.listSourceChildren = async (
        input: Parameters<ProviderPort["listSourceChildren"]>[0],
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
        await session.close(true);
        controller.close();
        engine.close();
        rmSync(home, { recursive: true, force: true });
      });
      await session.open();
      assert.ok(session.command({ action: "plan", input: {} }).ok);
      await entered.promise;
      assert.deepEqual(
        await controller.requestControl(ref, {
          kind,
          commandId: `web-plan-${kind}`,
          signal: AbortSignal.timeout(6500),
        }),
        { ok: true, value: kind === "stop" ? { stopped: true } : { cancelled: true } },
      );
      const snapshot = await session.snapshot({ stage: "status", phase: "plan" });
      assert.equal(snapshot.busy, null);
      assert.equal(snapshot.readonly, true);
      assert.equal(snapshot.status?.ownership.held, false);
      assert.equal(snapshot.status?.planDigest, null);
      assert.equal(
        snapshot.refusal?.code,
        kind === "stop" ? "retry_budget_exhausted" : "job_cancelled",
      );
    });
  }

  it("preserves active go-live when cancel refuses", { timeout: 10000 }, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "migmate-web-refused-control-"));
    const fixture = fileFixture([
      { id: "one", parentId: "source-root", name: "one.txt", kind: "file", content: "one" },
    ]);
    fixture.googleAbout = {
      user: { emailAddress: "files@example.com" },
      canCreateDrives: true,
    };
    const provider = new FakeFileMigrationPort(fixture);
    const engine = openEngine({ home, provider, adapter: "web" });
    const controller = openEngine({ home, provider, adapter: "cli" });
    const ref = value(
      await engine.initJob({
        type: "file_migration",
        config: { mappings: [], options: { memberGrants: "after_verification" } },
      }),
    );
    const session = new WebSession({ engine, job: ref });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const waiting = new AbortController();
    t.after(async () => {
      waiting.abort();
      release.resolve();
      await session.close(true);
      controller.close();
      engine.close();
      rmSync(home, { recursive: true, force: true });
    });
    value(
      await engine.withWriterResult(ref, (writer) =>
        writer.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: [
              {
                id: "mapping",
                source: { type: "sharepoint", driveId: "source-drive", folderPath: "" },
                destination: { type: "google_shared_drive", create: "Reviewed destination" },
                members: [{ email: "member@example.test", type: "group", role: "writer" }],
              },
            ],
          }),
        }),
      ),
    );
    await approve({ engine, ref });
    value(await engine.withWriterResult(ref, (writer) => writer.execute()));
    const addDriveMember = provider.addDriveMember.bind(provider);
    provider.addDriveMember = async (driveId, member) => {
      await addDriveMember(driveId, member);
      entered.resolve();
      await release.promise;
    };
    await session.open();
    const review = value(await engine.reader(ref).status()).closeReview;
    assert.ok(review);
    assert.ok(
      session.command({
        action: "close",
        input: {
          approver: "reviewer",
          evidenceDigest: review.evidenceDigest,
          confirmGoLive: true,
        },
      }).ok,
    );
    await entered.promise;
    let completed = false;
    const cancellation = controller
      .requestControl(ref, {
        kind: "cancel",
        commandId: "web-refused-cancel",
        signal: waiting.signal,
      })
      .then((result) => {
        completed = true;
        return result;
      });
    t.after(async () => {
      waiting.abort();
      await cancellation;
    });
    let answered = false;
    for await (const event of controller.reader(ref).events({
      follow: true,
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(6500)]),
    })) {
      if (event.kind === "control_request" && event.payload.commandId === "web-refused-cancel") {
        assert.equal(event.payload.outcome, "go_live_started");
        answered = true;
        break;
      }
    }
    assert.equal(answered, true);
    const active = await session.snapshot({ stage: "status", phase: "plan" });
    assert.equal(active.busy, "close");
    assert.equal(active.readonly, false);
    assert.equal(active.refusal, null);
    assert.equal(active.status?.ownership.held, true);
    assert.equal(completed, false);
    release.resolve();
    await settled(session);
    const closed = await session.snapshot({ stage: "status", phase: "plan" });
    assert.equal(closed.status?.state, "closed");
    assert.equal(closed.refusal, null);
    assert.equal(closed.readonly, false);
    assert.equal(completed, false);
    await session.close();
    const refused = await cancellation;
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.refusal.code, "go_live_started");
    assert.equal(value(await controller.reader(ref).status()).ownership.held, false);
  });
});
