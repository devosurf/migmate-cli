# Teams export constraints for the first archive contract

This note verifies the Microsoft-supported Teams export surfaces that constrain Migmate’s first Teams archive job and the structured evidence the archive must preserve.

## Recommendation

Use the **production Graph export APIs** as the first archive contract and keep the output as **static HTML + canonical JSONL + attachment/asset sidecars**. That means:

- archive user and channel conversations from the v1.0 Teams export surfaces;
- treat retained-message routes as the way to preserve edits/deletes when retention policies exist;
- preserve meeting transcripts only when Microsoft exposes them through the v1.0 transcript route;
- defer beta-only recording export and targeted-message export to later decision tickets.

That shape matches the repo’s current design intent for a readable HTML archive with a canonical structured representation, explicit gaps, and per-conversation packages in `docs/design/migration-product-session.md`.

## Verified Microsoft-supported routes

### Production-supported, first-contract candidates

| Route | Permission model | Coverage and constraints |
| --- | --- | --- |
| [`chats:getAllMessages`](https://learn.microsoft.com/en-us/graph/api/chats-getallmessages?view=graph-rest-1.0) | Application only: `Chat.Read.All`; delegated not supported | Exports all messages from chats a user participates in, including 1:1, group, and meeting chats. Supports date-range filters and paging. The export overview says Teams export APIs can retrieve messages created or updated in a date range and recommends `$top` no higher than 250. `@odata.nextLink` is expected and `$top` is only a hint, not a guaranteed page size. [Teams export overview](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content) |
| [`chats:getAllRetainedMessages`](https://learn.microsoft.com/en-us/graph/api/chat-getallretainedmessages?view=graph-rest-1.0) | Application only: `Chat.Read.All`; delegated not supported | Requires [Teams retention policies](https://learn.microsoft.com/en-us/purview/create-retention-policies?tabs=teams-retention) to be configured. Supports 1:1, group, and meeting chats. Supports `$filter` on `lastModifiedDateTime` and paging. This is the route that preserves edited history and retained/deleted history when the tenant has the policy in place. |
| [`channel:getAllMessages`](https://learn.microsoft.com/en-us/graph/api/channel-getallmessages?view=graph-rest-1.0) | Application only: `ChannelMessage.Read.All`; delegated not supported | Exports all channel messages in a team, including public and private channels on the API page. The export overview additionally states that shared-channel messages are supported, so treat the docs as a support claim with a wording mismatch rather than as a reason to drop shared channels. Supports date-range filters and paging. |
| [`channel:getAllRetainedMessages`](https://learn.microsoft.com/en-us/graph/api/channel-getallretainedmessages?view=graph-rest-1.0) | Application only: `ChannelMessage.Read.All`; delegated not supported | Requires Teams retention policies. **Does not support private channels.** Supports `$filter` on `lastModifiedDateTime` and `$top`. This is the main retained-history route for standard and shared channels, but not for private-channel retained history. |
| [`deletedTeam:getAllMessages`](https://learn.microsoft.com/en-us/graph/api/deletedteam-getallmessages?view=graph-rest-1.0) | Application only: `ChannelMessage.Read.All`; delegated not supported | Retrieves messages across all channels in a deleted team. The export overview says deleted standard, private, and shared channels are capturable for **30 days** after deletion, after which they are hard-deleted and unrecoverable. Useful as a safety net, not as the primary collection route. |
| [`onlineMeeting:getAllTranscripts`](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getalltranscripts?view=graph-rest-1.0) | Application only: `OnlineMeetingTranscript.Read.All`; delegated not supported | Only returns transcripts for scheduled online meetings organized by the specified user. It **does not support channel-meeting transcripts**. The tenant admin must enable Graph API access to transcripts, and the transcript content URL is subject to the tenant’s speaker-attribution setting. Delta sync is supported. |

### Beta-only routes that should stay out of the first contract unless Main explicitly approves them

| Route | Permission model | Coverage and constraints |
| --- | --- | --- |
| [`onlineMeeting:getAllRecordings`](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getallrecordings?view=graph-rest-beta) | Application only: `OnlineMeetingRecording.Read.All`; delegated not supported | **Beta only.** Returns recordings for scheduled online meetings organized by the user, but only for **private scheduled meetings**. Recordings are not returned for meetings without transcription turned on. The doc also calls out a known issue where `$top` may not return `@odata.nextLink`. This should be treated as a later ticket, not as part of the first archive guarantee. |
| [`userTeamwork:getAllTargetedMessages`](https://learn.microsoft.com/en-us/graph/api/userteamwork-getalltargetedmessages?view=graph-rest-beta) | Application only: `TeamworkTargetedMessage.Read.All`; delegated not supported | **Beta only.** Returns targeted messages sent to a specific user in group chats and channels. It has paging and delta support, but it is not a production-stable foundation for the first archive contract. |

### Compliance fallback route, not the archive engine

Microsoft Purview eDiscovery can export Teams content, but it is a **different compliance workflow** rather than the deterministic archive pipeline Migmate is designing. It exports PST/MSG or native files, requires Microsoft 365 E3/E5 plus SharePoint E3 for SharePoint exports, and search export packages expire after 14 days. Search exports can also run for more than seven days and then cancel. eDiscovery can include Teams and Viva Engage conversations and can collect cloud attachments; for shared-channel cloud attachments, the shared-channel SharePoint site must be included in the search. Sources: [eDiscovery export](https://learn.microsoft.com/en-us/purview/edisc-search-export), [Teams in eDiscovery](https://learn.microsoft.com/en-us/purview/edisc-search-teams).

## What the archive must preserve for faithful static HTML

The first archive contract cannot be “just dump message text.” Microsoft’s own resource model exposes the evidence needed to rebuild a readable archive:

- [`chatMessage`](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0) carries `id`, `replyToId`, `createdDateTime`, `lastModifiedDateTime`, `lastEditedDateTime`, `deletedDateTime`, `from`, `body`, `attachments`, `mentions`, `reactions`, `messageHistory`, `eventDetail`, `summary`, and `webUrl`.
- The `body` is HTML when the message contains mentions, so the archive must preserve source HTML and sanitize it, not flatten it to plain text.
- `messageHistory` is the place to preserve reaction edits and other history items; `reactions` alone is not enough.
- [`chatMessageAttachment`](https://learn.microsoft.com/en-us/graph/api/resources/chatmessageattachment?view=graph-rest-1.0) shows that attachments can be `reference` links, forwarded-message references, rich cards, or ordinary content links. Not every attachment is a file blob.
- [`chatMessageHostedContent`](https://learn.microsoft.com/en-us/graph/api/resources/chatmessagehostedcontent?view=graph-rest-1.0) is separate from attachments. The hosted-content list/get APIs return metadata first; the metadata response sets `contentBytes` and `contentType` to `null`, and the actual bytes are fetched from the `/content` or `/$value` endpoint. Hosted-content retrieval also requires `ConsistencyLevel: eventual` for edited/deleted messages and is not supported for messages in deleted threads. [List hosted content](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-hostedcontents?view=graph-rest-1.0), [Get hosted content](https://learn.microsoft.com/en-us/graph/api/chatmessagehostedcontent-get?view=graph-rest-1.0)
- The export overview says attachments may appear as metadata or as links inside the body, and that the `attachments` collection should be used to retrieve attached files; URLs embedded in the body may not be directly accessible. [Teams export overview](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content)

For the static HTML side, the design doc already requires the archive to preserve searchable HTML, raw source records, manifests, anchors, relative links, images, attachments, CSS, and search shards in deterministic packages (`docs/design/migration-product-session.md`). That is the correct evidence bar for “faithful” archive output.

## Retention, deletion, and completeness gaps that must remain explicit

The Microsoft docs leave several hard edges that later decision tickets must not smooth over:

- **Deleted messages:** Teams messages deleted by users from the client are available through the export APIs only up to **21 days** after deletion unless retention policies preserve them. [Teams export overview](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content)
- **Deleted teams/channels:** deleted-team export remains available for deleted standard/private/shared channels only for **30 days** after deletion. After that, the team/channel is hard deleted and messages cannot be retrieved. [Teams export overview](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content), [`deletedTeam:getAllMessages`](https://learn.microsoft.com/en-us/graph/api/deletedteam-getallmessages?view=graph-rest-1.0)
- **Deleted users / inactive users:** export access is only preserved for about **30 days** after deletion or inactivity. [Teams export overview](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content)
- **Private channels:** the retained-message channel route explicitly says it does **not** support private channels. That means retained edit/delete history for private channels is a special gap, even though the broader export overview still claims private-channel messages are supported overall. [channel:getAllRetainedMessages](https://learn.microsoft.com/en-us/graph/api/channel-getallretainedmessages?view=graph-rest-1.0), [Teams export overview](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content)
- **Meeting control messages:** the export overview says control messages are supported, but meeting-related control messages are currently **not** supported. [Teams export overview](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content)
- **Meeting transcripts:** the transcript route does not support channel-meeting transcripts, and a tenant admin can disable transcript Graph API access entirely. In that case, no retry succeeds until access is re-enabled. [onlineMeeting:getAllTranscripts](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getalltranscripts?view=graph-rest-1.0)
- **Meeting recordings:** the recording route is beta-only, only covers private scheduled meetings, and requires transcription to be turned on. That makes it unsuitable as a first-contract invariant. [onlineMeeting:getAllRecordings](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getallrecordings?view=graph-rest-beta)

## Throttling and polling behavior

- Microsoft Graph applies both global and service-specific throttling. For the Teams export message routes, the current Graph throttling table lists `getAllMessages` and `getAllRetainedMessages` at **1000 rps per app** and **200 rps per app per tenant**. [Graph throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)
- The export overview recommends keeping `$top` at **250 or below** for Teams message export APIs, and it warns that `$top` is a maximum hint rather than a guaranteed page size. Responses may return fewer items and include `@odata.nextLink`. [Teams export overview](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content)
- The transcript route supports **delta** synchronization; the recording route also supports delta synchronization. Both docs say to follow `deltaLink`/`nextLink` rather than inventing a polling loop. [onlineMeeting:getAllTranscripts](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getalltranscripts?view=graph-rest-1.0), [onlineMeeting:getAllRecordings](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getallrecordings?view=graph-rest-beta)
- The recording doc explicitly says results are present only after recordings are available, so the caller needs **no separate polling for availability**. [onlineMeeting:getAllRecordings](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getallrecordings?view=graph-rest-beta)

## Decision implications for the smaller Migmate scope

1. **The first Teams archive job should be a production-API archive, not a beta-API archive.**
   - That keeps the contract anchored in v1.0 routes and avoids making the first release depend on recording export or targeted-message export.

2. **The archive must be evidence-first, not text-first.**
   - Preserve raw HTML, message history, reaction state, attachment metadata, hosted-content bytes, reply/thread structure, and source identifiers.
   - A rendered HTML page without the canonical JSONL and asset sidecars would not satisfy the current design intent.

3. **Private channels need a separate fidelity decision.**
   - Microsoft supports them in the broad export overview, but the retained-message channel route excludes them. Later tickets must decide whether “retained private-channel history” is a hard requirement or an accepted gap.

4. **Meeting recordings should not be silently promised.**
   - The only current Microsoft route is beta-only and limited to private scheduled meetings with transcription enabled. If the product wants recording replay in the archive, that needs an explicit later decision.

5. **Cloud support must be route-specific, not assumed uniform.**
   - `getAllMessages` for chats and channels is Global-service only, while the retained routes and transcripts have broader deployment support. Later tickets should encode the route matrix instead of claiming “Teams export works everywhere.”

6. **For compliance-only collection, eDiscovery is a fallback, not the archive pipeline.**
   - It can help collect Teams content and cloud attachments, but it produces mailbox/PST-style exports with different licensing, packaging, and expiry rules.

## New decision questions for Main

- Do we want the first archive contract to remain **production-only** and defer recording export and targeted messages until later?
- Do we require **private-channel retained history**, even though the retained-message API explicitly excludes private channels?
- Should first-release cloud support be **route-specific**, or do we want to narrow v1 to a smaller deployment matrix?
- If meeting recordings matter, is the intended first path the **beta recording API**, or is recording replay deferred and the archive stores transcript-only evidence for now?

## Sources

- [Microsoft Teams Export APIs overview](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content)
- [`chats:getAllMessages`](https://learn.microsoft.com/en-us/graph/api/chats-getallmessages?view=graph-rest-1.0)
- [`chat:getAllRetainedMessages`](https://learn.microsoft.com/en-us/graph/api/chat-getallretainedmessages?view=graph-rest-1.0)
- [`channel:getAllMessages`](https://learn.microsoft.com/en-us/graph/api/channel-getallmessages?view=graph-rest-1.0)
- [`channel:getAllRetainedMessages`](https://learn.microsoft.com/en-us/graph/api/channel-getallretainedmessages?view=graph-rest-1.0)
- [`deletedTeam:getAllMessages`](https://learn.microsoft.com/en-us/graph/api/deletedteam-getallmessages?view=graph-rest-1.0)
- [`onlineMeeting:getAllTranscripts`](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getalltranscripts?view=graph-rest-1.0)
- [`onlineMeeting:getAllRecordings`](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getallrecordings?view=graph-rest-beta)
- [`userTeamwork:getAllTargetedMessages`](https://learn.microsoft.com/en-us/graph/api/userteamwork-getalltargetedmessages?view=graph-rest-beta)
- [`chatMessage` resource](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0)
- [`chatMessageAttachment` resource](https://learn.microsoft.com/en-us/graph/api/resources/chatmessageattachment?view=graph-rest-1.0)
- [`chatMessageHostedContent` list](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-hostedcontents?view=graph-rest-1.0)
- [`chatMessageHostedContent` get](https://learn.microsoft.com/en-us/graph/api/chatmessagehostedcontent-get?view=graph-rest-1.0)
- [Teams content in eDiscovery](https://learn.microsoft.com/en-us/purview/edisc-search-teams)
- [Export search results in eDiscovery](https://learn.microsoft.com/en-us/purview/edisc-search-export)
- `docs/design/migration-product-session.md`
- `docs/research/teams-to-google-chat-migration.md`
