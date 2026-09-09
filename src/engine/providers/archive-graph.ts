import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { CheckResult } from "../types.ts";
import {
  ArchiveEffectError,
  type ArchiveConfig,
  type ArchiveConversation,
  type ArchivePage,
  type ArchivePlan,
  type ArchiveProvider,
  type ArchiveRoute,
  type ArchiveScopeBinding,
} from "./archive.ts";

/** Structural equivalent of providers/http.ts GraphTransport. Authentication,
 * HTTPS redirect handling and unauthenticated CDN streaming belong to that adapter. */
export interface ArchiveGraphTransport {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  stream(path: string): AsyncIterable<Uint8Array>;
  evidence(): Promise<Record<string, unknown>>;
}

type Json = Record<string, unknown>;
const graphOrigin = "https://graph.microsoft.com";
const secretKeys: Record<string, true> = {
  authorization: true,
  proxyauthorization: true,
  accesstoken: true,
  refreshtoken: true,
  idtoken: true,
  clientsecret: true,
  token: true,
  headers: true,
  transportheaders: true,
  downloadurl: true,
  microsoftgraphdownloadurl: true,
  odatanextlink: true,
  odatadeltalink: true,
};
const credentialQueryKeys: Record<string, true> = {
  access_token: true,
  refresh_token: true,
  id_token: true,
  token: true,
  authorization: true,
  auth: true,
  tempauth: true,
  sig: true,
  signature: true,
  client_secret: true,
  code: true,
  api_key: true,
  apikey: true,
};
const cursorKeys: Record<string, true> = {
  $top: true,
  $filter: true,
  $select: true,
  $skip: true,
  $skiptoken: true,
  $deltatoken: true,
  skiptoken: true,
  deltatoken: true,
  skip: true,
  startdatetime: true,
  enddatetime: true,
};

function object(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function required(value: unknown, code = "message_collection_incomplete"): string {
  const result = text(value);
  if (!result) throw new ArchiveEffectError(code);
  return result;
}
function segment(value: unknown, code?: string): string {
  return encodeURIComponent(required(value, code)).replaceAll("'", "%27");
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArchiveEffectError("operation_aborted");
}
function url(value: string, code: string): URL {
  try {
    const parsed = new URL(value, graphOrigin);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new ArchiveEffectError(code);
    }
    for (const key of parsed.searchParams.keys()) {
      if (credentialQueryKeys[key.toLowerCase()] === true) throw new ArchiveEffectError(code);
    }
    return parsed;
  } catch {
    throw new ArchiveEffectError(code);
  }
}
function graphUrl(value: string, code = "archive_cursor_invalid"): URL {
  const parsed = url(value, code);
  if (parsed.origin !== graphOrigin || !parsed.pathname.startsWith("/v1.0/")) {
    throw new ArchiveEffectError(code);
  }
  return parsed;
}

/** Microsoft can spell the same transcript route with users(id) and omit the
 * original date parameters once the continuation token carries the window. */
function routeIdentity(parsed: URL): string {
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    throw new ArchiveEffectError("archive_cursor_invalid");
  }
  path = path.replace(/^\/v1\.0\/users\('?([^'()/]+)'?\)\//, "/v1.0/users/$1/");
  const transcript = /^(\/v1\.0\/users\/([^/]+)\/onlineMeetings\/getAllTranscripts)\((.*)\)$/.exec(
    path,
  );
  if (!transcript) return path;
  const parameters = new Map<string, string>();
  for (const part of transcript[3]!.split(",")) {
    const match = /^\s*(meetingOrganizerUserId|startDateTime|endDateTime)\s*=\s*(.*?)\s*$/.exec(
      part,
    );
    if (!match || parameters.has(match[1]!)) throw new ArchiveEffectError("archive_cursor_invalid");
    parameters.set(match[1]!, match[2]!);
  }
  if (parameters.get("meetingOrganizerUserId") !== `'${transcript[2]}'`) {
    throw new ArchiveEffectError("archive_cursor_invalid");
  }
  return transcript[1]!;
}
function continuation(value: unknown, initial: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ArchiveEffectError("archive_cursor_invalid");
  const next = graphUrl(value);
  const start = graphUrl(initial);
  if (routeIdentity(next) !== routeIdentity(start))
    throw new ArchiveEffectError("archive_cursor_invalid");
  const initialPath = decodeURIComponent(start.pathname);
  for (const bound of decodeURIComponent(next.pathname).matchAll(
    /(?:,|\()\s*(startDateTime|endDateTime)\s*=\s*([^,)]+)/g,
  )) {
    if (!initialPath.includes(`${bound[1]}=${bound[2]!.trim()}`))
      throw new ArchiveEffectError("archive_cursor_invalid");
  }
  for (const key of next.searchParams.keys()) {
    if (cursorKeys[key.toLowerCase()] !== true)
      throw new ArchiveEffectError("archive_cursor_invalid");
  }
  // A continuation must not change an explicit filter. Microsoft may instead
  // carry it entirely in its opaque skip/delta token.
  const filter = next.searchParams.get("$filter");
  if (filter !== null && filter !== start.searchParams.get("$filter")) {
    throw new ArchiveEffectError("archive_cursor_invalid");
  }
  return next.href;
}

/** Keep the original Graph payload except transport credentials. Clone only
 * branches containing fields that must never enter durable archive records. */
function withoutTransport(value: unknown): unknown {
  if (Array.isArray(value)) {
    let result: unknown[] | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const clean = withoutTransport(value[index]);
      if (clean !== value[index]) {
        result ??= value.slice();
        result[index] = clean;
      }
    }
    return result ?? value;
  }
  const record = object(value);
  if (!record) return value;
  let result: Json | undefined;
  for (const [key, child] of Object.entries(record)) {
    const forbidden = secretKeys[key.toLowerCase().replace(/[^a-z]/g, "")] === true;
    let clean = child;
    let credentialUrl = false;
    if (typeof child === "string" && /^https?:\/\//i.test(child)) {
      try {
        const parsed = new URL(child);
        credentialUrl = Boolean(parsed.username || parsed.password);
        for (const name of parsed.searchParams.keys()) {
          if (credentialQueryKeys[name.toLowerCase()] === true) credentialUrl = true;
        }
      } catch {
        /* Graph text that is not a URL remains canonical text. */
      }
    }
    if (!forbidden && !credentialUrl) clean = withoutTransport(child);
    if (forbidden || credentialUrl || clean !== child) {
      result ??= { ...record };
      if (forbidden || credentialUrl) delete result[key];
      else result[key] = clean;
    }
  }
  return result ?? record;
}

/** No provider message, URL, body, token, or arbitrary evidence crosses this seam. */
function effect(error: unknown, fallback: string): ArchiveEffectError {
  if (error instanceof ArchiveEffectError) return error;
  const fault = object(error);
  const evidence = object(fault?.evidence);
  const rawStatus = fault?.status ?? evidence?.status;
  const status =
    typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : undefined;
  const retry =
    fault?.transient === true ||
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500);
  if (retry) {
    const result = new ArchiveEffectError(
      status === 429 ? "provider_throttled" : "provider_transient",
      status,
    );
    const delay = fault?.retryAfterMs;
    return Object.assign(result, {
      transient: true,
      retryAfterMs:
        typeof delay === "number" && Number.isFinite(delay) && delay >= 0 ? delay : 1000,
    });
  }
  if (fault?.code === "operation_aborted" || fault?.name === "AbortError") {
    return new ArchiveEffectError("operation_aborted");
  }
  if (status === undefined && !(typeof fault?.code === "string" && evidence)) {
    // Programming defects are not acceptable collection gaps. Fail closed
    // without reflecting an arbitrary exception message or cause into state.
    throw new Error("archive_provider_defect");
  }
  return new ArchiveEffectError(fallback, status);
}
function isRetry(error: ArchiveEffectError): boolean {
  return "retryAfterMs" in error || error.code === "operation_aborted";
}
function failed(id: string, error: unknown, fallback = "preflight_failed"): CheckResult {
  const failure = effect(error, fallback);
  if (isRetry(failure)) throw failure;
  return {
    id,
    title: id,
    status: "fail",
    code: fallback,
    evidence: {
      reason: failure.code,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    },
  };
}
function passed(id: string, evidence: Json): CheckResult {
  return { id, title: id, status: "pass", evidence };
}
function channelId(teamId: string, id: string): string {
  return `channel:${teamId}:${id}`;
}
function chatId(id: string): string {
  return `chat:${id}`;
}
function messageConversation(record: Json, scope: ArchiveScopeBinding): string | undefined {
  if (scope.kind === "user-chats")
    return text(record.chatId) ? chatId(String(record.chatId)) : undefined;
  const identity = object(record.channelIdentity);
  if (!identity || identity.teamId !== scope.teamId || !text(identity.channelId)) return undefined;
  return channelId(String(identity.teamId), String(identity.channelId));
}
function messagePath(conversation: ArchiveConversation, record: Json): string {
  const id = segment(record.id);
  if (conversation.kind === "chat")
    return `/v1.0/chats/${segment(conversation.raw.id)}/messages/${id}`;
  const base = `/v1.0/teams/${segment(conversation.teamId)}/channels/${segment(conversation.channelId)}/messages/`;
  return text(record.replyToId)
    ? `${base}${segment(record.replyToId)}/replies/${id}`
    : `${base}${id}`;
}
function transcriptPath(record: Json): string {
  const organizer = object(object(record.meetingOrganizer)?.user);
  return `/v1.0/users/${segment(organizer?.id, "transcript_unavailable")}/onlineMeetings/${segment(record.meetingId, "transcript_unavailable")}/transcripts/${segment(record.id, "transcript_unavailable")}/content`;
}
function collectionPath(
  scope: ArchiveScopeBinding,
  route: ArchiveRoute,
  window: ArchivePlan["window"],
): string {
  if (
    !Number.isFinite(Date.parse(window.from)) ||
    !Number.isFinite(Date.parse(window.to)) ||
    Date.parse(window.from) >= Date.parse(window.to)
  ) {
    throw new ArchiveEffectError("archive_window_invalid");
  }
  if (route === "transcripts") {
    if (scope.kind !== "user-chats")
      throw new ArchiveEffectError("transcript_unsupported_channel_meeting");
    const user = segment(scope.userId);
    return `/v1.0/users/${user}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='${user}',startDateTime=${encodeURIComponent(window.from)},endDateTime=${encodeURIComponent(window.to)})?$top=250`;
  }
  const root =
    scope.kind === "channel"
      ? `/v1.0/teams/${segment(scope.teamId)}/channels`
      : `/v1.0/users/${segment(scope.userId)}/chats`;
  const name = route === "retained" ? "getAllRetainedMessages" : "getAllMessages";
  return `${root}/${name}?$top=250&$filter=${encodeURIComponent(`lastModifiedDateTime ge ${window.from} and lastModifiedDateTime lt ${window.to}`)}`;
}
function hostedFailure(record: Json, route: ArchiveRoute): string {
  if (route === "retained") return "hosted_content_unavailable_retained_message";
  return text(record.deletedDateTime)
    ? "hosted_content_unavailable_deleted_thread"
    : "message_collection_incomplete";
}

/** Exact production route/role tuple used by qualification, never a claim that
 * a tuple has already passed a live route gate. */
export function archiveQualificationRequirements(config: ArchiveConfig): {
  routes: string[];
  permissions: string[];
  options: { retainedHistory: boolean; transcripts: boolean; attachmentBytes: boolean };
} {
  const routes: string[] = [];
  const permissions: string[] = [];
  if (config.scopes.some((scope) => scope.kind === "channel" || scope.kind === "team")) {
    routes.push(
      "/v1.0/teams/{teamId}/channels",
      "/v1.0/teams/{teamId}/channels/getAllMessages",
      "/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/hostedContents",
      "/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/hostedContents/{hostedContentId}/$value",
      "/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies/{replyId}/hostedContents",
      "/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies/{replyId}/hostedContents/{hostedContentId}/$value",
    );
    permissions.push("Channel.ReadBasic.All", "ChannelMessage.Read.All");
    if (config.retainedHistory) routes.push("/v1.0/teams/{teamId}/channels/getAllRetainedMessages");
  }
  if (config.scopes.some((scope) => scope.kind === "user-chats")) {
    routes.push(
      "/v1.0/users/{userId}/chats",
      "/v1.0/users/{userId}/chats/getAllMessages",
      "/v1.0/chats/{chatId}/messages/{messageId}/hostedContents",
      "/v1.0/chats/{chatId}/messages/{messageId}/hostedContents/{hostedContentId}/$value",
    );
    permissions.push("Chat.Read.All");
    if (config.retainedHistory) routes.push("/v1.0/users/{userId}/chats/getAllRetainedMessages");
  }
  if (config.transcripts) {
    routes.push(
      "/v1.0/users/{userId}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='{userId}',startDateTime={from},endDateTime={to})",
      "/v1.0/users/{userId}/onlineMeetings/{meetingId}",
      "/v1.0/users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content",
    );
    permissions.push("OnlineMeetingTranscript.Read.All", "OnlineMeetings.Read.All");
  }
  if (config.attachmentBytes) {
    routes.push(
      "/v1.0/shares/{encodedSharingUrl}/driveItem",
      "/v1.0/drives/{driveId}/items/{itemId}/content",
    );
    permissions.push("Files.Read.All");
  }
  return {
    routes: routes.sort(compare),
    permissions: permissions.sort(compare),
    options: {
      retainedHistory: config.retainedHistory,
      transcripts: config.transcripts,
      attachmentBytes: config.attachmentBytes,
    },
  };
}

export function createArchiveProvider(transport: ArchiveGraphTransport): ArchiveProvider {
  async function request(path: string, code: string, signal?: AbortSignal): Promise<Json> {
    abort(signal);
    try {
      const response = await transport.request<unknown>(graphUrl(path, code).href, {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      abort(signal);
      const record = object(response);
      if (!record) throw new ArchiveEffectError(code);
      return record;
    } catch (error) {
      throw effect(error, code);
    }
  }
  async function readPage(
    initial: string,
    cursor: string | null,
    code: string,
    signal?: AbortSignal,
  ): Promise<ArchivePage> {
    const path = cursor === null ? initial : continuation(cursor, initial)!;
    const response = await request(path, code, signal);
    if (!Array.isArray(response.value) || response.value.some((entry) => !object(entry))) {
      throw new ArchiveEffectError(code);
    }
    const nextLink = continuation(response["@odata.nextLink"], initial);
    const deltaLink = continuation(response["@odata.deltaLink"], initial);
    if (nextLink === graphUrl(path).href) throw new ArchiveEffectError("archive_paging_cycle");
    return {
      records: response.value.map((entry) => withoutTransport(entry) as Json),
      nextLink,
      ...(deltaLink === null ? {} : { deltaLink }),
    };
  }
  async function* list(path: string, code: string, signal?: AbortSignal): AsyncIterable<Json> {
    let cursor: string | null = null;
    const visited = new Set<string>();
    do {
      const result = await readPage(path, cursor, code, signal);
      for (const record of result.records) yield record;
      cursor = result.nextLink;
      if (cursor !== null) {
        if (visited.has(cursor)) throw new ArchiveEffectError("archive_paging_cycle");
        visited.add(cursor);
      }
    } while (cursor !== null);
  }
  async function* stream(
    path: string,
    code: string,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    abort(signal);
    try {
      for await (const chunk of transport.stream(graphUrl(path, code).href)) {
        abort(signal);
        if (!(chunk instanceof Uint8Array)) throw new ArchiveEffectError(code);
        yield chunk;
      }
      abort(signal);
    } catch (error) {
      throw effect(error, code);
    }
  }

  const provider: ArchiveProvider = {
    async expand(config, signal) {
      if (config.cloud !== "Global") throw new ArchiveEffectError("unqualified_route");
      const bindings = new Map<string, ArchiveScopeBinding>();
      const conversations = new Map<string, ArchiveConversation>();
      const channels = new Map<string, Map<string, Json>>();
      const users = new Set<string>();
      for (const scope of config.scopes) {
        abort(signal);
        if (scope.kind === "user-chats") {
          users.add(scope.userId);
          continue;
        }
        let metadata = channels.get(scope.teamId);
        if (!metadata) {
          metadata = new Map();
          for await (const channel of list(
            `/v1.0/teams/${segment(scope.teamId)}/channels`,
            "archive_scope_unavailable",
            signal,
          )) {
            metadata.set(required(channel.id, "archive_scope_unavailable"), channel);
          }
          channels.set(scope.teamId, metadata);
        }
        const selected =
          scope.kind === "team" ? [...metadata.values()] : [metadata.get(scope.channelId)];
        for (const channel of selected) {
          if (!channel) throw new ArchiveEffectError("archive_scope_unavailable");
          const id = required(channel.id, "archive_scope_unavailable");
          const identity = channelId(scope.teamId, id);
          bindings.set(identity, {
            id: identity,
            kind: "channel",
            teamId: scope.teamId,
            channelId: id,
            conversationIds: [identity],
          });
          conversations.set(identity, {
            id: identity,
            kind: "channel",
            title: text(channel.displayName) ?? "Channel",
            scopeEntryId: identity,
            participantScopeIds: [identity],
            teamId: scope.teamId,
            channelId: id,
            ...(typeof channel.membershipType === "string"
              ? { membershipType: channel.membershipType }
              : {}),
            raw: channel,
          });
        }
      }
      // Sorting users before insertion fixes both owner and chosen raw metadata,
      // independent of config order and Graph page ordering.
      for (const userId of [...users].sort(compare)) {
        const scopeId = `user-chats:${userId}`;
        const binding: ArchiveScopeBinding = {
          id: scopeId,
          kind: "user-chats",
          userId,
          conversationIds: [],
        };
        bindings.set(scopeId, binding);
        for await (const chat of list(
          `/v1.0/users/${segment(userId)}/chats?$top=50`,
          "archive_scope_unavailable",
          signal,
        )) {
          const id = required(chat.id, "archive_scope_unavailable");
          const identity = chatId(id);
          const existing = conversations.get(identity);
          if (existing) {
            if (!existing.participantScopeIds.includes(scopeId))
              existing.participantScopeIds.push(scopeId);
            continue;
          }
          binding.conversationIds.push(identity);
          conversations.set(identity, {
            id: identity,
            kind: "chat",
            title: text(chat.topic) ?? "Chat",
            scopeEntryId: scopeId,
            participantScopeIds: [scopeId],
            ownerUserId: userId,
            ...(typeof chat.chatType === "string" ? { chatType: chat.chatType } : {}),
            raw: chat,
          });
        }
      }
      for (const binding of bindings.values()) binding.conversationIds.sort(compare);
      return {
        scopes: [...bindings.values()].sort((a, b) => compare(a.id, b.id)),
        conversations: [...conversations.values()].sort((a, b) => compare(a.id, b.id)),
      };
    },
    async page({ scope, route, window, cursor, signal }) {
      const path = collectionPath(scope, route, window);
      return readPage(
        path,
        cursor,
        route === "transcripts" ? "transcript_unavailable" : "message_collection_incomplete",
        signal,
      );
    },
    async transcriptConversationId(record, scope, conversations, signal) {
      const organizer = object(object(record.meetingOrganizer)?.user);
      if (
        scope.kind !== "user-chats" ||
        required(organizer?.id, "transcript_unavailable") !== scope.userId
      ) {
        throw new ArchiveEffectError("transcript_unavailable");
      }
      const meeting = await request(
        `/v1.0/users/${segment(scope.userId)}/onlineMeetings/${segment(record.meetingId, "transcript_unavailable")}?$select=id,chatInfo`,
        "transcript_unavailable",
        signal,
      );
      const threadId = required(object(meeting.chatInfo)?.threadId, "transcript_unavailable");
      const conversation = conversations.find(
        (entry) =>
          entry.kind === "chat" &&
          entry.raw.id === threadId &&
          entry.participantScopeIds.includes(scope.id),
      );
      return conversation?.id ?? null;
    },
    async *assetRequests(conversation, record, route, config, signal) {
      abort(signal);
      if (route === "transcripts") {
        const id = required(record.id, "transcript_unavailable");
        yield {
          conversation,
          record,
          route,
          kind: "transcript",
          id,
          name: `${id}.vtt`,
          sourceUrl: graphOrigin + transcriptPath(record),
        };
        return;
      }
      if (config.attachmentBytes && Array.isArray(record.attachments)) {
        for (const value of record.attachments) {
          const attachment = object(value);
          if (attachment?.contentType !== "reference") continue;
          const id = required(attachment.id, "attachment_reference_unresolvable");
          yield {
            conversation,
            record,
            route,
            kind: "attachment",
            id,
            name: text(attachment.name) ?? id,
            ...(typeof attachment.contentUrl === "string"
              ? { sourceUrl: attachment.contentUrl }
              : {}),
          };
        }
      }
      const code = hostedFailure(record, route);
      const base = `${messagePath(conversation, record)}/hostedContents`;
      const seen = new Set<string>();
      for await (const hosted of list(base, code, signal)) {
        const id = required(hosted.id, code);
        if (seen.has(id)) continue;
        seen.add(id);
        yield {
          conversation,
          record,
          route,
          kind: "hosted_content",
          id,
          name: id,
          sourceUrl: `${graphOrigin}${base}/${segment(id)}/$value`,
        };
      }
    },
    async *openAsset(asset, signal) {
      if (asset.kind === "hosted_content") {
        yield* stream(
          `${messagePath(asset.conversation, asset.record)}/hostedContents/${segment(asset.id)}/$value`,
          hostedFailure(asset.record, asset.route),
          signal,
        );
        return;
      }
      if (asset.kind === "transcript") {
        yield* stream(transcriptPath(asset.record), "transcript_unavailable", signal);
        return;
      }
      // Never use @microsoft.graph.downloadUrl, and never redeem a sharing link:
      // resolution is read-only and repeated when a staged download is retried.
      const source = required(asset.sourceUrl, "attachment_reference_unresolvable");
      if (!source.startsWith("https://"))
        throw new ArchiveEffectError("attachment_reference_unresolvable");
      url(source, "attachment_reference_unresolvable");
      const sharingToken = `u!${Buffer.from(source, "utf8").toString("base64url")}`;
      const item = await request(
        `/v1.0/shares/${sharingToken}/driveItem?$select=id,parentReference,file,remoteItem`,
        "attachment_reference_unresolvable",
        signal,
      );
      const remote = object(item.remoteItem);
      const resolved = remote ?? item;
      const driveId = required(
        object(resolved.parentReference)?.driveId,
        "attachment_reference_unresolvable",
      );
      const itemId = required(resolved.id, "attachment_reference_unresolvable");
      if (!object(resolved.file)) throw new ArchiveEffectError("attachment_reference_unresolvable");
      yield* stream(
        `/v1.0/drives/${segment(driveId)}/items/${segment(itemId)}/content`,
        "attachment_content_unavailable",
        signal,
      );
    },
    async *preflight(config, plan, signal) {
      abort(signal);
      if (config.cloud !== "Global") {
        yield failed("archive_cloud", new ArchiveEffectError("unqualified_route"));
        return;
      }
      const requiredRoles = archiveQualificationRequirements(config).permissions;
      try {
        const identity = await transport.evidence();
        abort(signal);
        const granted = new Set(
          Array.isArray(identity.grantedPermissions)
            ? identity.grantedPermissions.filter((role): role is string => typeof role === "string")
            : [],
        );
        const alternatives: Record<string, string[]> = {
          "Channel.ReadBasic.All": ["ChannelSettings.Read.All", "ChannelSettings.ReadWrite.All"],
          "Chat.Read.All": ["Chat.ReadWrite.All"],
          "OnlineMeetings.Read.All": ["OnlineMeetings.ReadWrite.All"],
          "Files.Read.All": ["Files.ReadWrite.All", "Sites.Read.All", "Sites.ReadWrite.All"],
        };
        const missing = [...requiredRoles].filter(
          (role) =>
            !granted.has(role) &&
            !(alternatives[role] ?? []).some((alternative) => granted.has(alternative)),
        );
        yield {
          id: "archive_application_permissions",
          title: "Archive application permissions",
          status: missing.length === 0 ? "pass" : "fail",
          ...(missing.length === 0 ? {} : { code: "preflight_failed" }),
          evidence: {
            tenantId: text(identity.tenantId),
            clientId: text(identity.clientId),
            requiredPermissions: [...requiredRoles].sort(compare),
            missingPermissions: missing,
            transcriptApplicationAccessPolicyRequired: config.transcripts,
          },
        };
      } catch (error) {
        yield failed("archive_application_permissions", error);
      }
      try {
        const resolved = await provider.expand(config, signal);
        const existing = new Map(
          resolved.conversations.map((conversation) => [conversation.id, conversation]),
        );
        if (
          plan.conversations.some((conversation) => {
            const current = existing.get(conversation.id);
            return (
              !current ||
              conversation.participantScopeIds.some(
                (scope) => !current.participantScopeIds.includes(scope),
              )
            );
          })
        )
          throw new ArchiveEffectError("archive_scope_unavailable");
        // Only prove the frozen entries still resolve. New conversations never
        // replace or join the approved set.
        yield passed("archive_scope_resolution", {
          scopeEntries: plan.scopes.length,
          conversations: plan.conversations.length,
          proof: "graph_metadata_expansion",
        });
      } catch (error) {
        yield failed("archive_scope_resolution", error);
      }
      const samples = new Map<string, ArchivePage>();
      let routesAccepted = plan.scopes.length > 0;
      for (const scope of plan.scopes) {
        try {
          const sample = await provider.page({
            scope,
            route: "messages",
            window: plan.window,
            cursor: null,
            ...(signal ? { signal } : {}),
          });
          samples.set(scope.id, sample);
          yield passed(`archive_current:${scope.id}`, {
            scopeEntryId: scope.id,
            route: "messages",
            proof: "graph_request_accepted",
          });
        } catch (error) {
          routesAccepted = false;
          yield failed(`archive_current:${scope.id}`, error);
        }
        const privateChannel =
          scope.kind === "channel" &&
          plan.conversations.some(
            (conversation) =>
              conversation.scopeEntryId === scope.id && conversation.membershipType === "private",
          );
        // Decision #7 deliberately excludes private retained history, even where
        // newer Graph tenants/docs have acquired partial support.
        if (config.retainedHistory && !privateChannel) {
          try {
            await provider.page({
              scope,
              route: "retained",
              window: plan.window,
              cursor: null,
              ...(signal ? { signal } : {}),
            });
            yield passed(`archive_retention:${scope.id}`, {
              scopeEntryId: scope.id,
              proof: "retained_route_accepted",
            });
          } catch (error) {
            routesAccepted = false;
            yield failed(`archive_retention:${scope.id}`, error);
          }
        }
      }
      if (config.transcripts) {
        const organizers = plan.scopes.filter((scope) => scope.kind === "user-chats");
        if (organizers.length === 0) {
          routesAccepted = false;
          yield failed(
            "archive_transcript_toggle",
            new ArchiveEffectError("transcript_probe_unavailable"),
          );
        }
        for (const scope of organizers) {
          try {
            let transcriptSample: Json | undefined;
            for await (const record of list(
              collectionPath(scope, "transcripts", plan.window),
              "transcript_unavailable",
              signal,
            )) {
              const id = await provider.transcriptConversationId(
                record,
                scope,
                plan.conversations,
                signal,
              );
              const conversation = plan.conversations.find((entry) => entry.id === id);
              if (!conversation) continue;
              for await (const asset of provider.assetRequests(
                conversation,
                record,
                "transcripts",
                config,
                signal,
              )) {
                const digest = createHash("sha256");
                let bytes = 0;
                for await (const chunk of provider.openAsset(asset, signal)) {
                  bytes += chunk.byteLength;
                  digest.update(chunk);
                }
                transcriptSample = {
                  conversationId: conversation.id,
                  transcriptId: asset.id,
                  bytes,
                  sha256: digest.digest("hex"),
                };
              }
              break;
            }
            yield passed(`archive_transcript_toggle:${scope.id}`, {
              scopeEntryId: scope.id,
              proof: "transcript_export_route_accepted",
              applicationAccessPolicyRequired: true,
              ...(transcriptSample
                ? { sample: transcriptSample, applicationAccessPolicyVerified: true }
                : { applicationAccessPolicyVerified: false }),
            });
          } catch (error) {
            routesAccepted = false;
            yield failed(`archive_transcript_toggle:${scope.id}`, error);
          }
        }
      }
      // licenseDetails is not an app-only Graph v1.0 API. The proof is acceptance
      // by every requested export route, not an invented SKU or policy assertion.
      yield {
        id: "archive_route_licensing",
        title: "Archive route licensing",
        status: routesAccepted ? "pass" : "fail",
        ...(routesAccepted ? {} : { code: "preflight_failed" }),
        evidence: { proof: "requested_export_routes_accepted", accepted: routesAccepted },
      };
      const kinds = new Set(
        config.scopes.map((scope) => (scope.kind === "user-chats" ? "chat" : "channel")),
      );
      const hosted = new Map<string, Json>();
      const hostedFailures = new Map<string, ArchiveEffectError>();
      let attachmentFound = false;
      let attachmentProved: Json | undefined;
      let attachmentFailure: ArchiveEffectError | undefined;
      const byId = new Map(
        plan.conversations.map((conversation) => [conversation.id, conversation]),
      );
      for (const scope of plan.scopes) {
        let current = samples.get(scope.id);
        const visited = new Set<string>();
        while (current) {
          for (const record of current.records) {
            const identity = messageConversation(record, scope);
            const conversation = identity ? byId.get(identity) : undefined;
            if (!conversation || !scope.conversationIds.includes(conversation.id)) continue;
            if (hosted.has(conversation.kind) && (!config.attachmentBytes || attachmentProved))
              continue;
            try {
              for await (const asset of provider.assetRequests(
                conversation,
                record,
                "messages",
                config,
                signal,
              )) {
                if (asset.kind === "attachment") {
                  attachmentFound = true;
                  if (attachmentProved) continue;
                } else if (hosted.has(conversation.kind)) continue;
                try {
                  let byteCount = 0;
                  const digest = createHash("sha256");
                  for await (const chunk of provider.openAsset(asset, signal)) {
                    byteCount += chunk.byteLength;
                    digest.update(chunk);
                  }
                  const sample = {
                    conversationId: conversation.id,
                    messageId: required(record.id),
                    assetId: asset.id,
                    bytes: byteCount,
                    sha256: digest.digest("hex"),
                  };
                  if (asset.kind === "attachment") attachmentProved = sample;
                  else if (byteCount > 0) hosted.set(conversation.kind, sample);
                } catch (error) {
                  const failure = effect(
                    error,
                    asset.kind === "attachment"
                      ? "attachment_content_unavailable"
                      : "message_collection_incomplete",
                  );
                  if (isRetry(failure)) throw failure;
                  if (asset.kind === "attachment") attachmentFailure = failure;
                  else hostedFailures.set(conversation.kind, failure);
                }
              }
            } catch (error) {
              const failure = effect(error, "message_collection_incomplete");
              if (isRetry(failure)) throw failure;
              hostedFailures.set(conversation.kind, failure);
            }
          }
          if (hosted.size === kinds.size && (!config.attachmentBytes || attachmentProved)) break;
          if (!current.nextLink) break;
          if (visited.has(current.nextLink)) throw new ArchiveEffectError("archive_paging_cycle");
          visited.add(current.nextLink);
          try {
            current = await provider.page({
              scope,
              route: "messages",
              window: plan.window,
              cursor: current.nextLink,
              ...(signal ? { signal } : {}),
            });
          } catch (error) {
            yield failed(`archive_asset_scan:${scope.id}`, error);
            break;
          }
        }
      }
      for (const kind of kinds) {
        yield hosted.has(kind)
          ? passed(`archive_hosted_content:${kind}`, {
              scopeKind: kind,
              proof: "hosted_content_bytes_consumed",
              sample: hosted.get(kind),
            })
          : failed(
              `archive_hosted_content:${kind}`,
              hostedFailures.get(kind) ??
                new ArchiveEffectError("hosted_content_probe_unavailable"),
            );
      }
      if (config.attachmentBytes) {
        yield attachmentProved
          ? passed("archive_attachment_bytes", {
              proof: "sharing_url_resolved_and_drive_bytes_consumed",
              attachmentBytesAsRetrieved: true,
              sample: attachmentProved,
            })
          : failed(
              "archive_attachment_bytes",
              attachmentFailure ??
                new ArchiveEffectError(
                  attachmentFound
                    ? "attachment_content_unavailable"
                    : "attachment_probe_unavailable",
                ),
              attachmentFound ? "preflight_failed" : "attachment_probe_unavailable",
            );
      }
    },
  };
  return provider;
}
