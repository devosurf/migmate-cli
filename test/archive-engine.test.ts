import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import type { ArchiveConversation, ArchiveProvider, ArchiveScopeBinding } from "../src/engine/providers/archive.ts";

const now = () => new Date("2026-09-01T00:00:00.000Z");

// The fake sits at the same provider-effects seam as production. No driver or
// store mocks: frozen scope, commit replay and offline verification cross engine.
test("archive approval freezes empty conversations and offline verification survives reopening", async () => {
  const home = await mkdtemp(join(tmpdir(), "migmate-archive-engine-"));
  try {
    const conversation: ArchiveConversation = { id: "chat-1", kind: "chat", title: "Original chat", scopeEntryId: "user:a", participantScopeIds: ["user:a", "user:b"], ownerUserId: "a", raw: { id: "chat-1", chatType: "group" } };
    const empty: ArchiveConversation = { ...conversation, id: "chat-empty", title: "Empty", participantScopeIds: ["user:a"], raw: { id: "chat-empty", chatType: "group" } };
    const scope: ArchiveScopeBinding = { id: "user:a", kind: "user-chats", userId: "a", conversationIds: [conversation.id, empty.id] };
    let networkAllowed = true;
    let newConversationExists = false;
    const message = { id: "message-1", chatId: "chat-1", createdDateTime: "2020-01-01T00:00:00Z", lastModifiedDateTime: "2026-08-01T00:00:00Z", from: { user: { id: "a", displayName: "Original identity" } }, body: { contentType: "html", content: "<p>Preserved message</p>" }, attachments: [], mentions: [] };
    const archive: ArchiveProvider = {
      async expand() {
        assert.ok(networkAllowed, "verification must be offline");
        const conversations = [conversation, empty];
        if (newConversationExists) conversations.push({ ...conversation, id: "chat-after-approval" });
        return { scopes: [scope, { id: "user:b", kind: "user-chats", userId: "b", conversationIds: [] }], conversations };
      },
      async *preflight() { yield { id: "archive_effects", title: "Scripted fixture", status: "pass", evidence: {} }; },
      async page({ cursor }) {
        assert.ok(networkAllowed, "verification must be offline");
        // Duplicate records across export pages must not produce a duplicate
        // JSONL row or HTML article. Post-approval conversations stay excluded.
        return cursor === null ? { records: [message], nextLink: "https://graph.microsoft.com/v1.0/users/a/chats/getAllMessages?$skiptoken=next" } : { records: [message, { ...message, id: "out-of-scope", chatId: "chat-after-approval" }], nextLink: null };
      },
      async transcriptConversationId() { throw new Error("transcripts not requested"); },
      async *assetRequests() {},
      async *openAsset() { throw new Error("no asset requested"); },
    };
    const port = Object.assign(new FakeFileMigrationPort({ sourceDriveId: "unused", sourceRootId: "unused", destinationDriveId: "unused", destinationRootId: "unused", sourceItems: [], destinationItems: [] }), { archive });
    const engine = openEngine({ home, now, provider: port });
    const initialized = await engine.initJob({ type: "teams_archive", config: { scopes: [{ kind: "user-chats", userId: "a" }, { kind: "user-chats", userId: "b" }], window: { from: "2026-01-01T00:00:00Z" }, timezone: "Europe/Stockholm" } });
    assert.ok(initialized.ok);
    if (!initialized.ok) throw new Error("init refused");
    const ref = initialized.value;
    const run = await engine.withWriter(ref, async (writer) => {
      const planned = await writer.plan();
      assert.ok(planned.ok);
      if (!planned.ok) throw new Error("plan refused");
      assert.ok((await writer.approve({ planDigest: planned.value.planDigest, approver: "test", mode: "unattended" })).ok);
      newConversationExists = true;
      const execution = await writer.execute();
      assert.ok(execution.ok);
      if (!execution.ok) throw new Error("execute refused");
      assert.equal(execution.value.outcome, "completed");
    });
    assert.ok(run.ok);
    networkAllowed = false;
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
  } finally { await rm(home, { recursive: true, force: true }); }
});
