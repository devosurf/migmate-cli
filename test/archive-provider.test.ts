import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
  createArchiveProvider,
  type ArchiveGraphTransport,
} from "../src/engine/providers/archive-graph.ts";
import {
  ArchiveEffectError,
  type ArchiveAssetRequest,
  type ArchiveConfig,
  type ArchiveConversation,
  type ArchivePlan,
  type ArchiveScopeBinding,
} from "../src/engine/providers/archive.ts";

type Json = Record<string, unknown>;
const window = { from: "2026-01-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" };
const config: ArchiveConfig = {
  scopes: [{ kind: "user-chats", userId: "user-a" }],
  cloud: "Global",
  retainedHistory: false,
  transcripts: false,
  attachmentBytes: false,
  timezone: "UTC",
  window,
};
const scope: ArchiveScopeBinding = {
  id: "user-chats:user-a",
  kind: "user-chats",
  userId: "user-a",
  conversationIds: ["chat:chat-a"],
};
const conversation: ArchiveConversation = {
  id: "chat:chat-a",
  kind: "chat",
  title: "A",
  scopeEntryId: scope.id,
  participantScopeIds: [scope.id],
  ownerUserId: "user-a",
  chatType: "group",
  raw: { id: "chat-a", topic: "A" },
};
const message: Json = {
  id: "message-a",
  chatId: "chat-a",
  createdDateTime: "2026-02-01T00:00:00.000Z",
  lastModifiedDateTime: "2026-02-01T00:00:00.000Z",
  body: { contentType: "text", content: "Original text" },
  attachments: [],
};
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
function transport(
  request: (url: URL) => unknown | Promise<unknown>,
  stream: (url: URL) => AsyncIterable<Uint8Array> = async function* () {
    throw new Error("Unexpected byte read");
  },
): ArchiveGraphTransport {
  return {
    async request<T>(path: string): Promise<T> {
      return (await request(new URL(path, "https://graph.microsoft.com"))) as T;
    },
    stream(path) {
      return stream(new URL(path, "https://graph.microsoft.com"));
    },
    async evidence() {
      return {
        tenantId: "tenant-a",
        clientId: "client-a",
        grantedPermissions: [
          "Chat.Read.All",
          "ChannelMessage.Read.All",
          "Channel.ReadBasic.All",
          "Files.Read.All",
          "OnlineMeetingTranscript.Read.All",
          "OnlineMeetings.Read.All",
        ],
      };
    },
  };
}
function plan(options: ArchiveConfig = config): ArchivePlan {
  return {
    version: 1,
    window,
    timezone: "UTC",
    scopes: [scope],
    conversations: [conversation],
    config: options,
  };
}

describe("production archive provider effects", () => {
  it("freezes every paged channel and chat and assigns shared chats to the lowest scoped user", async () => {
    const effects = transport((url) => {
      const path = decodeURIComponent(url.pathname);
      if (path === "/v1.0/teams/team-a/channels") {
        if (url.searchParams.has("$skiptoken"))
          return { value: [{ id: "private", displayName: "P", membershipType: "private" }] };
        return {
          value: [{ id: "general", displayName: "G", membershipType: "standard" }],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/teams/team-a/channels?$skiptoken=next",
        };
      }
      if (path === "/v1.0/users/user-a/chats") {
        if (url.searchParams.has("$skiptoken"))
          return {
            value: [
              { id: "shared", topic: "Shared", chatType: "group" },
              { id: "only-a", topic: "A" },
            ],
          };
        return {
          value: [],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/user-a/chats?$skiptoken=next",
        };
      }
      if (path === "/v1.0/users/user-z/chats")
        return {
          value: [
            { id: "shared", topic: "Shared", chatType: "group" },
            { id: "only-z", topic: "Z" },
          ],
        };
      throw new Error("Unexpected metadata route");
    });
    const input: ArchiveConfig = {
      ...config,
      scopes: [
        { kind: "user-chats", userId: "user-z" },
        { kind: "team", teamId: "team-a" },
        { kind: "user-chats", userId: "user-a" },
        { kind: "channel", teamId: "team-a", channelId: "general" },
      ],
    };
    const provider = createArchiveProvider(effects);
    const frozen = await provider.expand(input);
    const reversed = await provider.expand({ ...input, scopes: [...input.scopes].reverse() });
    assert.deepEqual(frozen, reversed);
    assert.deepEqual(
      frozen.conversations.map((entry) => entry.id),
      [
        "channel:team-a:general",
        "channel:team-a:private",
        "chat:only-a",
        "chat:only-z",
        "chat:shared",
      ],
    );
    const shared = frozen.conversations.find((entry) => entry.id === "chat:shared")!;
    assert.equal(shared.ownerUserId, "user-a");
    assert.deepEqual(shared.participantScopeIds, ["user-chats:user-a", "user-chats:user-z"]);
    assert.deepEqual(
      frozen.scopes
        .filter((entry) => entry.kind === "user-chats")
        .map((entry) => [entry.userId, entry.conversationIds]),
      [
        ["user-a", ["chat:only-a", "chat:shared"]],
        ["user-z", ["chat:only-z"]],
      ],
    );
  });

  it("does not mistake an empty export page for exhaustion and preserves the closed modification filter", async () => {
    const provider = createArchiveProvider(
      transport((url) => {
        if (url.searchParams.has("$skiptoken")) return { value: [message] };
        assert.equal(
          url.searchParams.get("$filter"),
          `lastModifiedDateTime ge ${window.from} and lastModifiedDateTime lt ${window.to}`,
        );
        return {
          value: [],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/users/user-a/chats/getAllMessages?$skiptoken=second",
        };
      }),
    );
    const first = await provider.page({ scope, route: "messages", window, cursor: null });
    assert.deepEqual(first.records, []);
    assert.notEqual(first.nextLink, null);
    const last = await provider.page({ scope, route: "messages", window, cursor: first.nextLink });
    assert.deepEqual(last.records, [message]);
    assert.equal(last.nextLink, null);
  });

  it("rejects foreign, credential-bearing, beta, changed-filter and changed-scope continuation URLs before following them", async () => {
    const badLinks = [
      "https://attacker.invalid/v1.0/users/user-a/chats/getAllMessages?$skiptoken=SECRET",
      "https://user:SECRET@graph.microsoft.com/v1.0/users/user-a/chats/getAllMessages",
      "https://graph.microsoft.com/beta/users/user-a/chats/getAllMessages",
      "https://graph.microsoft.com/v1.0/users/user-b/chats/getAllMessages",
      "https://graph.microsoft.com/v1.0/users/user-a/chats/getAllMessages?access_token=SECRET",
      "https://graph.microsoft.com/v1.0/users/user-a/chats/getAllMessages?$filter=SECRET",
    ];
    for (const nextLink of badLinks) {
      let requests = 0;
      const provider = createArchiveProvider(
        transport(() => {
          requests += 1;
          return { value: [], "@odata.nextLink": nextLink };
        }),
      );
      await assert.rejects(
        provider.page({ scope, route: "messages", window, cursor: null }),
        (error: unknown) => {
          assert.ok(error instanceof ArchiveEffectError);
          assert.equal(error.code, "archive_cursor_invalid");
          assert.equal(JSON.stringify(error).includes("SECRET"), false);
          assert.equal(error.message.includes("SECRET"), false);
          return true;
        },
      );
      assert.equal(requests, 1);
      await assert.rejects(provider.page({ scope, route: "messages", window, cursor: nextLink }), {
        code: "archive_cursor_invalid",
      });
      assert.equal(requests, 1);
    }
  });

  it("preserves Graph identities and content while excluding transport credentials from returned raw records", async () => {
    const raw = {
      ...message,
      from: { user: { id: "original-id", displayName: "Original sender" } },
      authorization: "Bearer SECRET",
      nested: {
        "@microsoft.graph.downloadUrl": "https://cdn.invalid/file?token=SECRET",
        identity: "original",
      },
      attachments: [{ id: "a", contentUrl: "https://tenant.sharepoint.com/sites/site/file.docx" }],
    };
    const provider = createArchiveProvider(transport(() => ({ value: [raw] })));
    const page = await provider.page({ scope, route: "messages", window, cursor: null });
    assert.deepEqual(page.records, [
      {
        ...message,
        from: raw.from,
        nested: { identity: "original" },
        attachments: raw.attachments,
      },
    ]);
    assert.equal(JSON.stringify(page).includes("SECRET"), false);
    assert.equal(raw.authorization, "Bearer SECRET");
  });

  it("lists reply hosted content through exhaustion and streams bytes using the reply route", async () => {
    const channel: ArchiveConversation = {
      id: "channel:t:c",
      kind: "channel",
      title: "C",
      scopeEntryId: "channel:t:c",
      participantScopeIds: ["channel:t:c"],
      teamId: "t",
      channelId: "c",
      raw: { id: "c" },
    };
    const reply = {
      ...message,
      id: "reply",
      replyToId: "root",
      chatId: null,
      channelIdentity: { teamId: "t", channelId: "c" },
    };
    const base = "/v1.0/teams/t/channels/c/messages/root/replies/reply/hostedContents";
    const provider = createArchiveProvider(
      transport(
        (url) => {
          assert.equal(url.pathname, base);
          if (url.searchParams.has("$skiptoken")) return { value: [{ id: "hosted-b" }] };
          return {
            value: [{ id: "hosted-a" }],
            "@odata.nextLink": `https://graph.microsoft.com${base}?$skiptoken=next`,
          };
        },
        async function* (url) {
          assert.equal(url.pathname, `${base}/hosted-b/$value`);
          yield new Uint8Array([0, 255]);
          yield new Uint8Array([128]);
        },
      ),
    );
    const assets = await collect(provider.assetRequests(channel, reply, "messages", config));
    assert.deepEqual(
      assets.map((asset) => asset.id),
      ["hosted-a", "hosted-b"],
    );
    assert.deepEqual(await collect(provider.openAsset(assets[1]!)), [
      new Uint8Array([0, 255]),
      new Uint8Array([128]),
    ]);
  });

  it("re-resolves attachment sharing URLs on every attempt and never follows a returned preauthenticated URL", async () => {
    const source = "https://tenant.sharepoint.com/:w:/s/site/document";
    let resolutions = 0;
    const provider = createArchiveProvider(
      transport(
        (url) => {
          assert.equal(
            url.pathname,
            `/v1.0/shares/u!${Buffer.from(source).toString("base64url")}/driveItem`,
          );
          resolutions += 1;
          return {
            id: "item",
            parentReference: { driveId: "drive" },
            file: {},
            "@microsoft.graph.downloadUrl": "https://cdn.invalid/download?token=SECRET",
          };
        },
        async function* (url) {
          assert.equal(
            url.href,
            "https://graph.microsoft.com/v1.0/drives/drive/items/item/content",
          );
          yield new Uint8Array([1, 2, 3]);
        },
      ),
    );
    const asset: ArchiveAssetRequest = {
      conversation,
      record: message,
      route: "messages",
      kind: "attachment",
      id: "attachment",
      name: "document",
      sourceUrl: source,
    };
    assert.deepEqual(await collect(provider.openAsset(asset)), [new Uint8Array([1, 2, 3])]);
    assert.deepEqual(await collect(provider.openAsset(asset)), [new Uint8Array([1, 2, 3])]);
    assert.equal(resolutions, 2);
    assert.equal(JSON.stringify(asset).includes("SECRET"), false);
  });

  it("keeps cards as payload-only records and classifies missing references without chasing them", async () => {
    const provider = createArchiveProvider(transport(() => ({ value: [] })));
    const record = {
      ...message,
      attachments: [
        { id: "card", contentType: "application/vnd.microsoft.card.adaptive", content: "{}" },
        { id: "forward", contentType: "forwardedMessageReference", content: "{}" },
        { id: "missing-url", contentType: "reference" },
      ],
    };
    const assets = await collect(
      provider.assetRequests(conversation, record, "messages", {
        ...config,
        attachmentBytes: true,
      }),
    );
    assert.deepEqual(
      assets.map((asset) => asset.id),
      ["missing-url"],
    );
    await assert.rejects(collect(provider.openAsset(assets[0]!)), {
      code: "attachment_reference_unresolvable",
    });
  });

  it("distinguishes retained hosted gaps, permanent attachment failures and retryable mid-stream throttling without leaking provider messages", async () => {
    const secretFault = Object.assign(
      new Error("https://cdn.invalid/?token=SECRET Bearer SECRET"),
      { status: 403, evidence: { status: 403, token: "SECRET" } },
    );
    const blocked = createArchiveProvider(
      transport(() => {
        throw secretFault;
      }),
    );
    await assert.rejects(
      collect(blocked.assetRequests(conversation, message, "retained", config)),
      { code: "hosted_content_unavailable_retained_message", status: 403 },
    );
    const asset: ArchiveAssetRequest = {
      conversation,
      record: message,
      route: "messages",
      kind: "attachment",
      id: "a",
      name: "file",
      sourceUrl: "https://tenant.sharepoint.com/file",
    };
    await assert.rejects(collect(blocked.openAsset(asset)), (error: unknown) => {
      assert.ok(error instanceof ArchiveEffectError);
      assert.equal(error.code, "attachment_reference_unresolvable");
      assert.equal(error.message.includes("SECRET"), false);
      assert.equal(JSON.stringify(error).includes("SECRET"), false);
      return true;
    });
    const throttled = createArchiveProvider(
      transport(
        () => ({ id: "item", parentReference: { driveId: "drive" }, file: {} }),
        async function* () {
          yield new Uint8Array([7]);
          throw Object.assign(new Error("SECRET"), {
            status: 429,
            transient: true,
            retryAfterMs: 2500,
          });
        },
      ),
    );
    const iterator = throttled.openAsset(asset)[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, new Uint8Array([7]));
    await assert.rejects(iterator.next(), (error: unknown) => {
      assert.ok(error instanceof ArchiveEffectError);
      assert.equal(error.code, "provider_throttled");
      assert.equal(Reflect.get(error, "retryAfterMs"), 2500);
      assert.equal(Reflect.get(error, "transient"), true);
      assert.equal(JSON.stringify(error).includes("SECRET"), false);
      return true;
    });
  });

  it("maps a transcript to a frozen shared chat without changing its owner or admitting a new conversation", async () => {
    let threadId = "chat-a";
    const transcript = {
      id: "transcript",
      meetingId: "meeting",
      createdDateTime: message.createdDateTime,
      meetingOrganizer: { user: { id: "user-z" } },
      transcriptContentUrl:
        "https://graph.microsoft.com/v1.0/users/user-z/onlineMeetings/meeting/transcripts/transcript/content",
    };
    const shared = { ...conversation, participantScopeIds: [scope.id, "user-chats:user-z"] };
    const organizer: ArchiveScopeBinding = {
      id: "user-chats:user-z",
      kind: "user-chats",
      userId: "user-z",
      conversationIds: [],
    };
    const provider = createArchiveProvider(
      transport(
        (url) => {
          assert.equal(url.pathname, "/v1.0/users/user-z/onlineMeetings/meeting");
          return { id: "meeting", chatInfo: { threadId } };
        },
        async function* (url) {
          assert.equal(url.href, transcript.transcriptContentUrl);
          yield new TextEncoder().encode(
            "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Original speaker>Hello\n",
          );
        },
      ),
    );
    assert.equal(
      await provider.transcriptConversationId(transcript, organizer, [shared]),
      shared.id,
    );
    const assets = await collect(
      provider.assetRequests(shared, transcript, "transcripts", { ...config, transcripts: true }),
    );
    const content = Buffer.concat(await collect(provider.openAsset(assets[0]!))).toString("utf8");
    assert.match(content, /<v Original speaker>Hello/);
    threadId = "new-chat-after-approval";
    assert.equal(await provider.transcriptConversationId(transcript, organizer, [shared]), null);
    assert.equal(shared.ownerUserId, "user-a");
    assert.equal("chatId" in transcript, false);
  });

  it("records a missing in-scope attachment sample without blocking otherwise proven preflight", async () => {
    const options = { ...config, attachmentBytes: true };
    const provider = createArchiveProvider(
      transport(
        (url) => {
          if (url.pathname === "/v1.0/users/user-a/chats") return { value: [conversation.raw] };
          if (url.pathname.endsWith("/getAllMessages")) return { value: [message] };
          if (url.pathname.endsWith("/hostedContents")) return { value: [{ id: "image" }] };
          throw new Error("Unexpected preflight route");
        },
        async function* (url) {
          assert.ok(url.pathname.endsWith("/hostedContents/image/$value"));
          yield new Uint8Array([137, 80, 78, 71]);
        },
      ),
    );
    const checks = await collect(provider.preflight(options, plan(options)));
    assert.equal(
      checks.find((check) => check.id === "archive_hosted_content:chat")?.status,
      "pass",
    );
    const attachment = checks.find((check) => check.id === "archive_attachment_bytes")!;
    assert.equal(attachment.status, "skip");
    assert.equal(attachment.code, "attachment_probe_unavailable");
    assert.equal(
      checks.every((check) => check.status !== "fail"),
      true,
    );
  });

  it("still fails preflight when an in-scope reference attachment cannot be fetched", async () => {
    const options = { ...config, attachmentBytes: true };
    const provider = createArchiveProvider(
      transport(
        (url) => {
          if (url.pathname === "/v1.0/users/user-a/chats") return { value: [conversation.raw] };
          if (url.pathname.endsWith("/getAllMessages"))
            return {
              value: [
                {
                  ...message,
                  attachments: [
                    {
                      id: "attachment",
                      contentType: "reference",
                      name: "file",
                      contentUrl: "https://tenant.sharepoint.com/:u:/s/site/attachment",
                    },
                  ],
                },
              ],
            };
          if (url.pathname.endsWith("/hostedContents")) return { value: [{ id: "image" }] };
          throw Object.assign(new Error("unavailable"), { status: 403 });
        },
        async function* () {
          yield new Uint8Array([137, 80, 78, 71]);
        },
      ),
    );
    const checks = await collect(provider.preflight(options, plan(options)));
    assert.equal(checks.find((check) => check.id === "archive_attachment_bytes")?.status, "fail");
  });

  it("leaves private-channel retained history unrequested even when the current Graph route would accept it", async () => {
    const privateConversation: ArchiveConversation = {
      id: "channel:t:c",
      kind: "channel",
      title: "Private",
      scopeEntryId: "channel:t:c",
      participantScopeIds: ["channel:t:c"],
      teamId: "t",
      channelId: "c",
      membershipType: "private",
      raw: { id: "c", membershipType: "private" },
    };
    const privateScope: ArchiveScopeBinding = {
      id: privateConversation.id,
      kind: "channel",
      teamId: "t",
      channelId: "c",
      conversationIds: [privateConversation.id],
    };
    const options: ArchiveConfig = {
      ...config,
      scopes: [{ kind: "channel", teamId: "t", channelId: "c" }],
      retainedHistory: true,
    };
    let retainedRequests = 0;
    const provider = createArchiveProvider(
      transport((url) => {
        if (url.pathname.endsWith("/getAllRetainedMessages")) retainedRequests += 1;
        if (url.pathname.endsWith("/channels")) return { value: [privateConversation.raw] };
        return { value: [] };
      }),
    );
    const checks = await collect(
      provider.preflight(options, {
        ...plan(options),
        scopes: [privateScope],
        conversations: [privateConversation],
      }),
    );
    assert.equal(retainedRequests, 0);
    assert.equal(
      checks.find((check) => check.id === "archive_hosted_content:channel")?.status,
      "fail",
    );
  });

  it("accepts Microsoft's transcript continuation spelling without widening the frozen window", async () => {
    const record = {
      id: "transcript",
      meetingId: "meeting",
      meetingOrganizer: { user: { id: "user-a" } },
      createdDateTime: window.from,
    };
    const next =
      "https://graph.microsoft.com/v1.0/users(user-a)/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='user-a')?skipToken=next";
    const provider = createArchiveProvider(
      transport((url) => {
        if (url.searchParams.has("skipToken")) return { value: [record] };
        return { value: [], "@odata.nextLink": next };
      }),
    );
    const first = await provider.page({ scope, route: "transcripts", window, cursor: null });
    const second = await provider.page({
      scope,
      route: "transcripts",
      window,
      cursor: first.nextLink,
    });
    assert.deepEqual(second.records, [record]);
    assert.equal(second.nextLink, null);
    const widened =
      "https://graph.microsoft.com/v1.0/users(user-a)/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='user-a',startDateTime=2020-01-01T00:00:00Z)?skipToken=next";
    await assert.rejects(provider.page({ scope, route: "transcripts", window, cursor: widened }), {
      code: "archive_cursor_invalid",
    });
  });

  it("throws network and preflight throttling failures to the engine instead of making durable findings", async () => {
    for (const status of [0, 429]) {
      const provider = createArchiveProvider(
        transport(() => {
          throw Object.assign(new Error("SECRET"), { status, transient: true, retryAfterMs: 4200 });
        }),
      );
      await assert.rejects(collect(provider.preflight(config, plan())), (error: unknown) => {
        assert.ok(error instanceof ArchiveEffectError);
        assert.equal(error.status, status);
        assert.equal(Reflect.get(error, "retryAfterMs"), 4200);
        assert.equal(JSON.stringify(error).includes("SECRET"), false);
        return true;
      });
    }
  });

  it("never turns a programming defect into an acceptable collection gap", async () => {
    const provider = createArchiveProvider(
      transport(() => {
        throw new TypeError("SECRET");
      }),
    );
    await assert.rejects(
      provider.page({ scope, route: "messages", window, cursor: null }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof ArchiveEffectError, false);
        assert.equal(error.message.includes("SECRET"), false);
        return true;
      },
    );
  });

  it("reports a permanent drive-content failure separately from sharing-URL resolution", async () => {
    const provider = createArchiveProvider(
      transport(
        () => ({ id: "item", parentReference: { driveId: "drive" }, file: {} }),
        async function* () {
          throw Object.assign(new Error("SECRET"), { status: 403 });
        },
      ),
    );
    const asset: ArchiveAssetRequest = {
      conversation,
      record: message,
      route: "messages",
      kind: "attachment",
      id: "a",
      name: "file",
      sourceUrl: "https://tenant.sharepoint.com/file",
    };
    await assert.rejects(collect(provider.openAsset(asset)), {
      code: "attachment_content_unavailable",
      status: 403,
    });
  });
});
