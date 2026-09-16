#!/usr/bin/env node
//
// Records and proves the Entra app the live Teams-archive qualification needs,
// and proves the in-scope samples its suite refuses to run without.
//
//   node scripts/probe-archive-app.ts --env <env-file> --client-id <app-id>
//
// Prompts for the app's client secret, stores it 0600 outside the repository,
// then proves against the live tenant that:
//
//   * the granted roles are a subset of ARCHIVE_ROLES and carry the base
//     contract, because src/engine/providers/credentials.ts applies an
//     exclusive allowlist and one extra role refuses the whole credential;
//   * every scope entry resolves, and a channel entry names a real channel;
//   * each scope kind holds at least one positive-byte hosted-content sample,
//     and a channel scope holds one on a root message and one on a reply,
//     which is what scripts/qualification/archive.ts demands separately;
//   * every export page chain terminates, so paging can be exhausted.
//
// It prints counts, byte totals and codes, never message content, and never
// the secret. A channel scope reads the whole team: v1.0 offers no per-channel
// export route, only /teams/{teamId}/channels/getAllMessages, so this reports
// how many records it read from channels the scope did not name.
//
// https://learn.microsoft.com/en-us/graph/api/channel-getallmessages?view=graph-rest-1.0
// https://learn.microsoft.com/en-us/graph/api/chats-getallmessages?view=graph-rest-1.0

import { join } from "node:path";
import { exportWindowFilter } from "../src/engine/providers/archive-graph.ts";
import {
  applicationToken,
  argument,
  Blocked,
  envFile,
  graphRequest,
  pages,
  say,
  storedSecret,
  tokenClaims,
  writeEnv,
} from "./prereq-lib.ts";

const DISPLAY_NAME = "Migmate archive";
const SECRET_NAME = "archive-client-secret.txt";

/** Mirrors ARCHIVE_ROLES in src/engine/providers/credentials.ts, which is an
 *  exclusive allowlist: a role outside it refuses the credential outright. */
const ARCHIVE_ROLES = [
  "Channel.ReadBasic.All",
  "ChannelMessage.Read.All",
  "Chat.Read.All",
  "OnlineMeetings.Read.All",
  "OnlineMeetingTranscript.Read.All",
  "Files.Read.All",
];

const environmentPath = argument("env");
const clientId = argument("client-id");
if (!environmentPath || !clientId) {
  say("Usage: node scripts/probe-archive-app.ts --env <env-file> --client-id <app-id>");
  say("       [--secret-file <path>]");
  process.exit(2);
}

try {
  const environment = await envFile(environmentPath);
  const tenantId = environment.MIGMATE_TENANT_ID;
  const prerequisiteDirectory = environment.MIGMATE_PREREQ_DIR;
  const teamId = environment.MIGMATE_ARCHIVE_TEAM_ID;
  const channelId = environment.MIGMATE_ARCHIVE_CHANNEL_ID;
  const userId = environment.MIGMATE_ARCHIVE_USER_ID;
  const from = environment.MIGMATE_ARCHIVE_WINDOW_FROM;
  const to = environment.MIGMATE_ARCHIVE_WINDOW_TO;
  if (!tenantId || !prerequisiteDirectory || !from || !to) {
    throw new Blocked(
      "the env file must record MIGMATE_TENANT_ID, MIGMATE_PREREQ_DIR, MIGMATE_ARCHIVE_WINDOW_FROM and MIGMATE_ARCHIVE_WINDOW_TO",
    );
  }
  if (!teamId && !userId) {
    throw new Blocked(
      "the env file must record a scope: MIGMATE_ARCHIVE_TEAM_ID with MIGMATE_ARCHIVE_CHANNEL_ID, or MIGMATE_ARCHIVE_USER_ID",
    );
  }
  if (teamId && !channelId) {
    throw new Blocked(
      "a channel scope needs both MIGMATE_ARCHIVE_TEAM_ID and MIGMATE_ARCHIVE_CHANNEL_ID",
    );
  }

  const { secret, secretPath } = await storedSecret(
    argument("secret-file") ?? join(prerequisiteDirectory, "entra", SECRET_NAME),
    `  Paste the ${DISPLAY_NAME} app client secret value: `,
  );
  const token = await applicationToken(tenantId, clientId, secret).catch((error: unknown) => {
    throw new Blocked(
      `the app could not authenticate, so the secret or client id is wrong: ${String(error instanceof Error ? error.message : error)}`,
    );
  });
  const { roles, applicationOnly } = tokenClaims(token);
  say(`  authenticated; granted roles: ${roles.join(", ") || "none"}`);

  // The credential loader refuses any role outside the allowlist, so a broader
  // grant fails closed rather than passing with extra privilege.
  const outside = roles.filter((role) => !ARCHIVE_ROLES.includes(role));
  if (outside.length > 0) {
    throw new Blocked(
      `remove ${outside.join(", ")} from this app, or use an app dedicated to the archive route: ARCHIVE_ROLES is an exclusive allowlist, so a credential carrying any other role refuses with credential_permissions_invalid`,
    );
  }
  const missing = [
    ...(teamId ? ["Channel.ReadBasic.All", "ChannelMessage.Read.All"] : []),
    ...(userId ? ["Chat.Read.All"] : []),
  ].filter((role) => !roles.includes(role));
  if (missing.length > 0) {
    throw new Blocked(
      `grant and admin-consent ${missing.join(", ")} for the scopes this env file records`,
    );
  }
  if (!applicationOnly) {
    throw new Blocked(
      "the token is not application-only; every Teams export route refuses delegated permissions",
    );
  }

  const graph = graphRequest(token);
  const filter = exportWindowFilter({ from, to });
  say(`  window filter: ${filter}`);

  if (teamId) {
    const channels = await pages(graph, `/v1.0/teams/${teamId}/channels`);
    const channel = channels.records.find((entry) => entry.id === channelId);
    if (!channel) {
      throw new Blocked(
        `channel ${channelId} is not in team ${teamId}; a channel scope is resolved through the team's channel list, never by a direct channel GET`,
      );
    }
    say(
      `  channel resolved: ${String(channel.displayName)} (${String(channel.membershipType)}), ${channels.records.length} channel(s) in the team`,
    );
    const { records, pageCount } = await pages(
      graph,
      `/v1.0/teams/${teamId}/channels/getAllMessages?$top=250&$filter=${encodeURIComponent(filter)}`,
    );
    const scoped = records.filter(
      (record) =>
        (record.channelIdentity as Record<string, unknown> | undefined)?.channelId === channelId,
    );
    say(
      `  channel export: ${records.length} record(s) over ${pageCount} page(s), ${scoped.length} in the scoped channel`,
    );
    if (records.length !== scoped.length) {
      say(
        `  note: ${records.length - scoped.length} record(s) were read from other channels in this team and discarded`,
      );
    }
    let rootBytes = 0;
    let replyBytes = 0;
    for (const record of scoped) {
      const replyToId = record.replyToId;
      const isReply = typeof replyToId === "string" && replyToId.length > 0;
      const channelRoot = `/v1.0/teams/${teamId}/channels/${encodeURIComponent(String(channelId))}/messages`;
      const base = isReply
        ? `${channelRoot}/${replyToId}/replies/${String(record.id)}`
        : `${channelRoot}/${String(record.id)}`;
      const listed = await graph(`${base}/hostedContents`);
      for (const hosted of (listed.value as Record<string, unknown>[] | undefined) ?? []) {
        const response = await fetch(
          `https://graph.microsoft.com${base}/hostedContents/${String(hosted.id)}/$value`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (!response.ok) {
          throw new Blocked(
            `hosted content answered ${response.status} on a scoped channel record; the suite admits no hosted-content gap in the base contract`,
          );
        }
        const bytes = (await response.arrayBuffer()).byteLength;
        if (isReply) replyBytes += bytes;
        else rootBytes += bytes;
      }
    }
    say(
      `  channel hosted content: ${rootBytes} byte(s) on a root message, ${replyBytes} on a reply`,
    );
    if (rootBytes === 0 || replyBytes === 0) {
      throw new Blocked(
        "the scoped channel needs a root message with a pasted image and a reply to it carrying its own pasted image; the suite requires both samples separately (archive_hosted_channel_reply_sample_unavailable)",
      );
    }
  }

  if (userId) {
    const chats = await pages(graph, `/v1.0/users/${userId}/chats?$top=50`);
    say(`  user chats resolved: ${chats.records.length} chat(s)`);
    if (chats.records.length === 0) {
      throw new Blocked(`user ${userId} has no chats, so the scope entry freezes no conversation`);
    }
    const { records, pageCount } = await pages(
      graph,
      `/v1.0/users/${userId}/chats/getAllMessages?$top=250&$filter=${encodeURIComponent(filter)}`,
    );
    say(`  chat export: ${records.length} record(s) over ${pageCount} page(s)`);
    let chatBytes = 0;
    for (const record of records) {
      const chatId = record.chatId;
      if (typeof chatId !== "string" || chatId.length === 0) continue;
      const base = `/v1.0/chats/${encodeURIComponent(chatId)}/messages/${String(record.id)}`;
      const listed = await graph(`${base}/hostedContents`);
      for (const hosted of (listed.value as Record<string, unknown>[] | undefined) ?? []) {
        const response = await fetch(
          `https://graph.microsoft.com${base}/hostedContents/${String(hosted.id)}/$value`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (!response.ok) {
          throw new Blocked(
            `hosted content answered ${response.status} on a scoped chat record; the suite admits no hosted-content gap in the base contract`,
          );
        }
        chatBytes += (await response.arrayBuffer()).byteLength;
      }
    }
    say(`  chat hosted content: ${chatBytes} byte(s)`);
    if (chatBytes === 0) {
      throw new Blocked(
        "the scoped chats need at least one message carrying a pasted image; the suite requires a positive-byte hosted-content sample for every scope kind (archive_hosted_scope_kind_sample_unavailable)",
      );
    }
  }

  await writeEnv(environmentPath, {
    MIGMATE_ARCHIVE_CLIENT_ID: clientId,
    MIGMATE_ARCHIVE_SECRET_FILE: secretPath,
  });
  say();
  say(`Recorded MIGMATE_ARCHIVE_CLIENT_ID and MIGMATE_ARCHIVE_SECRET_FILE in ${environmentPath}.`);
  say(`Next: scripts/archive-prereqs.sh --resume ${environmentPath}`);
} catch (error) {
  if (!(error instanceof Blocked)) throw error;
  process.stderr.write(`Blocked: ${error.message}\n`);
  process.exit(1);
}
