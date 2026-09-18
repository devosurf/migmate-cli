import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { runArchiveQualification } from "../scripts/qualification/archive.ts";
import type { ProbeCapture } from "../src/qualification/bundle.ts";

async function qualify(
  t: TestContext,
  channels: { id: string; membershipType: "standard" | "private" }[],
  retainedChannels: string[],
  includeChats = true,
) {
  const directory = await mkdtemp(join(tmpdir(), "migmate-archive-qualification-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secretPath = join(directory, "client-secret");
  const jobDirectory = join(directory, "job");
  await mkdir(jobDirectory, { mode: 0o700 });
  await writeFile(secretPath, "qualification-test-secret", { mode: 0o600 });
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const clientId = "22222222-2222-2222-2222-222222222222";
  const message = (id: string, channelId?: string) => ({
    id,
    ...(channelId ? { channelIdentity: { teamId: "team", channelId } } : { chatId: "chat" }),
    createdDateTime: "2026-09-16T12:00:00.000Z",
    lastModifiedDateTime: "2026-09-16T12:00:00.000Z",
    from: { user: { id: "sender", displayName: "Sender" } },
    body: { contentType: "text", content: "Qualification sample" },
    attachments: [],
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "login.microsoftonline.com") {
      const claims = {
        tid: tenantId,
        appid: clientId,
        aud: "https://graph.microsoft.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        roles: ["Channel.ReadBasic.All", "ChannelMessage.Read.All", "Chat.Read.All"],
      };
      return Response.json({
        access_token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    assert.equal(url.hostname, "graph.microsoft.com");
    const path = url.pathname;
    if (path === "/v1.0/teams/team/channels") return Response.json({ value: channels });
    if (path === "/v1.0/users/user/chats")
      return Response.json({ value: [{ id: "chat", chatType: "group" }] });
    if (path === "/v1.0/teams/team/channels/getAllMessages")
      return Response.json({
        value: [
          message("root", channels[0]!.id),
          { ...message("reply", channels[0]!.id), replyToId: "root" },
        ],
      });
    if (path === "/v1.0/users/user/chats/getAllMessages")
      return Response.json({ value: [message("chat-current")] });
    if (path === "/v1.0/teams/team/channels/getAllRetainedMessages")
      return Response.json({ value: retainedChannels.map((id) => message("retained", id)) });
    if (path === "/v1.0/users/user/chats/getAllRetainedMessages")
      return Response.json({ value: [message("retained")] });
    if (path.endsWith("/hostedContents"))
      return Response.json({ value: path.includes("/retained/") ? [] : [{ id: "image" }] });
    if (path.endsWith("/hostedContents/image/$value")) return new Response("hosted image bytes");
    throw new Error(`Unexpected HTTP request: ${path}`);
  });
  const captures: ProbeCapture[] = [];
  const result = await runArchiveQualification({
    config: {
      schemaVersion: 1,
      jobType: "teams_archive",
      acknowledgement: "I authorize disposable live qualification probes",
      jobConfig: {
        scopes: [
          ...(channels.length > 0 ? [{ kind: "team", teamId: "team" }] : []),
          ...(includeChats ? [{ kind: "user-chats", userId: "user" }] : []),
        ],
        retainedHistory: true,
        window: { from: "2026-09-16T00:00:00Z", to: "2026-09-17T00:00:00Z" },
        graph: { tenantId, clientId },
        secrets: { teams_graph_client_secret: { resolver: "file", path: secretPath } },
      },
    },
    jobDirectory,
    signal: new AbortController().signal,
    capture: (capture) => captures.push(capture),
  });
  return { result, captures };
}

it("qualifies collected private retained history alongside empty private conversations", async (t) => {
  const { result, captures } = await qualify(t, [
    { id: "general", membershipType: "standard" },
    { id: "private-a", membershipType: "private" },
    { id: "private-empty", membershipType: "private" },
  ], ["general", "private-a"]);
  assert.ok(result.requiredProbes.includes("retained_history"));
  const retained = captures.find((capture) => capture.probeId === "retained_history");
  assert.ok(retained);
  assert.deepEqual(
    retained.assertions.find((assertion) => assertion.id === "retained_scope_kind_coverage")?.observed,
    ["channel", "chat"],
  );
  assert.equal(retained.observations.records, 3);
  assert.doesNotMatch(JSON.stringify(captures), /private-a|private-empty|Qualification sample/);
});

it("refuses empty private retained history even with standard and chat samples", async (t) => {
  await assert.rejects(qualify(t, [
    { id: "general", membershipType: "standard" },
    { id: "private-empty", membershipType: "private" },
  ], ["general"]), { gate: "archive_private_retained_history_sample_unavailable" });
});

it("refuses standard-only samples for the universal retained channel tuple", async (t) => {
  await assert.rejects(qualify(t, [
    { id: "general", membershipType: "standard" },
  ], ["general"]), { gate: "archive_private_retained_history_sample_unavailable" });
});

it("qualifies a private-only channel scope with a retained sample", async (t) => {
  const { result } = await qualify(t, [
    { id: "private-a", membershipType: "private" },
  ], ["private-a"], false);
  assert.ok(result.requiredProbes.includes("retained_history"));
});

it("qualifies chat-only retained history without a private channel sample", async (t) => {
  const { result } = await qualify(t, [], []);
  assert.ok(result.requiredProbes.includes("retained_history"));
});
