import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import type {
  ArchiveConversation,
  ArchiveProvider,
  ArchiveScopeBinding,
} from "../src/engine/providers/archive.ts";
import type { PackageManifest } from "../src/engine/archive/package.ts";

// The fake sits at the same provider-effects seam as production. No driver or
// store mocks: frozen scope, commit replay and offline verification cross engine.
test("archive approval freezes empty conversations and offline verification survives reopening", async () => {
  const home = await mkdtemp(join(tmpdir(), "migmate-archive-engine-"));
  let currentTime = "2026-09-01T00:00:00.000Z";
  const now = () => new Date(currentTime);
  try {
    const conversation: ArchiveConversation = {
      id: "chat-1",
      kind: "chat",
      title: "Original chat",
      scopeEntryId: "user:a",
      participantScopeIds: ["user:a", "user:b"],
      ownerUserId: "a",
      raw: { id: "chat-1", chatType: "group" },
    };
    const empty: ArchiveConversation = {
      ...conversation,
      id: "chat-empty",
      title: "Empty",
      participantScopeIds: ["user:a"],
      raw: { id: "chat-empty", chatType: "group" },
    };
    const scope: ArchiveScopeBinding = {
      id: "user:a",
      kind: "user-chats",
      userId: "a",
      conversationIds: [conversation.id, empty.id],
    };
    let networkAllowed = true;
    let newConversationExists = false;
    const message = {
      id: "message-1",
      chatId: "chat-1",
      createdDateTime: "2020-01-01T00:00:00Z",
      lastModifiedDateTime: "2026-08-01T00:00:00Z",
      from: { user: { id: "a", displayName: "Original identity" } },
      body: { contentType: "html", content: "<p>Preserved message</p>" },
      attachments: [],
      mentions: [],
    };
    const archive: ArchiveProvider = {
      async expand() {
        assert.ok(networkAllowed, "verification must be offline");
        const conversations = [conversation, empty];
        if (newConversationExists)
          conversations.push({ ...conversation, id: "chat-after-approval" });
        return {
          scopes: [scope, { id: "user:b", kind: "user-chats", userId: "b", conversationIds: [] }],
          conversations,
        };
      },
      async *preflight() {
        yield { id: "archive_effects", title: "Scripted fixture", status: "pass", evidence: {} };
      },
      async page({ cursor }) {
        assert.ok(networkAllowed, "verification must be offline");
        // Duplicate records across export pages must not produce a duplicate
        // JSONL row or HTML article. Post-approval conversations stay excluded.
        return cursor === null
          ? {
              records: [message],
              nextLink:
                "https://graph.microsoft.com/v1.0/users/a/chats/getAllMessages?$skiptoken=next",
            }
          : {
              records: [message, { ...message, id: "out-of-scope", chatId: "chat-after-approval" }],
              nextLink: null,
            };
      },
      async transcriptConversationId() {
        throw new Error("transcripts not requested");
      },
      async *assetRequests() {},
      async *openAsset() {
        throw new Error("no asset requested");
      },
    };
    const port = Object.assign(
      new FakeFileMigrationPort({
        sourceDriveId: "unused",
        sourceRootId: "unused",
        destinationDriveId: "unused",
        destinationRootId: "unused",
        sourceItems: [],
        destinationItems: [],
      }),
      { archive },
    );
    const engine = openEngine({ home, now, provider: port });
    const config = {
      scopes: [
        { kind: "user-chats", userId: "a" },
        { kind: "user-chats", userId: "b" },
      ],
      window: { from: "2026-01-01T00:00:00Z" },
      timezone: "Europe/Stockholm",
    };
    const initialized = await engine.initJob({ type: "teams_archive", config });
    assert.ok(initialized.ok);
    if (!initialized.ok) throw new Error("init refused");
    const ref = initialized.value;
    const run = await engine.withWriter(ref, async (writer) => {
      const planned = await writer.plan();
      assert.ok(planned.ok);
      if (!planned.ok) throw new Error("plan refused");
      currentTime = "2026-09-02T00:00:00.000Z";
      const replanned = await writer.plan();
      assert.ok(replanned.ok);
      assert.equal(
        replanned.value.planDigest,
        planned.value.planDigest,
        "Replanning must retain the frozen upper bound",
      );
      assert.ok(
        (
          await writer.approve({
            planDigest: replanned.value.planDigest,
            approver: "test",
            mode: "unattended",
          })
        ).ok,
      );
      assert.ok(
        (
          await writer.onboard({
            ...config,
            window: { ...config.window, to: "2026-08-31T00:00:00Z" },
          })
        ).ok,
      );
      const changedWindow = await writer.execute();
      assert.equal(changedWindow.ok, false);
      if (changedWindow.ok) throw new Error("Changed archive window reused approval");
      assert.equal(changedWindow.refusal.code, "plan_revision_required");
      assert.ok((await writer.onboard(config)).ok);
      newConversationExists = true;
      const execution = await writer.execute();
      assert.ok(execution.ok);
      if (!execution.ok) throw new Error("execute refused");
      assert.equal(execution.value.outcome, "completed");
    });
    assert.ok(run.ok);
    const manifest: PackageManifest = JSON.parse(
      await readFile(join(home, "jobs", ref.id, "archive", "manifest.json"), "utf8"),
    );
    assert.equal(manifest.plan.window.to, "2026-09-01T00:00:00.000Z");
    assert.deepEqual(
      manifest.conversations.map((entry) => ({ id: entry.id, records: entry.recordCount })),
      [
        { id: "chat-1", records: 1 },
        { id: "chat-empty", records: 0 },
      ],
    );
    assert.deepEqual(manifest.scopes.find((entry) => entry.id === "user:b")?.conversationIds, [
      "chat-1",
    ]);
    engine.close();
    networkAllowed = false;
    currentTime = "2026-10-01T00:00:00.000Z";
    const reopened = openEngine({ home, now, provider: port });
    const verified = await reopened.withWriter(ref, async (writer) => writer.verify());
    assert.ok(verified.ok);
    if (!verified.ok) throw new Error("writer refused");
    assert.ok(verified.value.ok);
    if (!verified.value.ok) throw new Error("verify refused");
    const verificationCodes = verified.value.value.findings.map((facet) => facet.code);
    assert.ok(!verificationCodes.includes("record_duplicated"));
    assert.ok(!verificationCodes.includes("record_unrendered"));
    assert.ok(!verificationCodes.includes("manifest_digest_mismatch"));
    assert.ok(verificationCodes.includes("retained_history_not_requested"));
    reopened.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
