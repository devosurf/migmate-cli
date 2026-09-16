# ADR-0007: What a Teams archive scope reads, and how its window survives an exclusive-only filter

- Status: accepted
- Date: 2026-09-16
- Context: [first-release spec #17](https://github.com/devosurf/migmate-cli/issues/17), [qualify the Teams archive route #29](https://github.com/devosurf/migmate-cli/issues/29), [credential onboarding #15](https://github.com/devosurf/migmate-cli/issues/15)

## Context

The Teams archive route had no live observation of any kind. Pointing the first prerequisite run at a real tenant on 2026-09-16 measured three things the route's shape had assumed away.

**The export routes refuse an inclusive lower bound.** Against both `/v1.0/teams/{teamId}/channels/getAllMessages` and `/v1.0/users/{userId}/chats/getAllMessages`:

| `$filter`                                                         | Result                                                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `lastModifiedDateTime ge <from> and lastModifiedDateTime lt <to>` | HTTP 400 `The entity property 'lastModifiedDateTime' and operationKind 'GreaterThanOrEqual' is not allowed in $filter query` |
| `lastModifiedDateTime gt <from> and lastModifiedDateTime lt <to>` | 200                                                                                                                          |
| `lastModifiedDateTime gt <from>` alone                            | HTTP 400 `Invalid '$filter' query. Missing 'lastModifiedDateTime' value.`                                                    |
| `lastModifiedDateTime lt <to>` alone                              | HTTP 400, same message                                                                                                       |
| `lastModifiedDateTime le <to>` alone                              | HTTP 400 `'LessThanOrEqual' is not allowed`                                                                                  |

Only `gt … and lt …` is accepted, and both bounds are mandatory. The collector sent `ge`, so every collection call and every `archive_current:<scope>` preflight check refused. Spec #17 §11 fixes the plan's window as a **closed half-open** `[from, to)` with `from` inclusive, which the API cannot express.

**A channel scope reads the whole team.** Graph v1.0 publishes no per-channel export route. A `channel` scope entry naming one channel is collected by calling the team-wide `getAllMessages` and discarding records from channels the scope did not name. Measured in a team holding only `General`, the export returned records for the scoped channel alone; in a team with more channels, every channel's messages cross the network.

**A channel scope is resolved through the channel list.** The plan resolves `{teamId, channelId}` by listing `/v1.0/teams/{teamId}/channels` and selecting the entry, never by a direct channel GET, so `Channel.ReadBasic.All` is required for a scope that names one explicit channel.

## Decision

**The request filter and the window guarantee are deliberately different, and the driver's own test is authoritative.** `exportWindowFilter` sends `gt` with the lower bound at `from − 1 ms`, the largest instant below an inclusive `from` at the millisecond precision Graph's timestamps carry. `inWindow` in `src/engine/drivers/teams-archive.ts` already re-tests `time >= from && time < to` on every record, so the request is a widening prefilter and the promised half-open window is enforced where it always was.

Rejected: sending `gt from` and dropping a record modified at exactly `from`, which silently breaks the documented window; and redefining the window as exclusive-lower `(from, to)`, which breaks the chained and overlapping windows #17 §11 makes an explicit feature — tiling `(a, b)` then `(b, c)` loses everything modified at exactly `b`.

`exportWindowFilter` is exported so the prerequisite prober asks exactly what the collector asks. Two copies of this offset would drift, and a prober that disagreed with the collector would certify a tenant the run then refuses.

**A `channel` scope states what it preserves, not what it reads.** `Archive scope` remains the explicit frozen list of what the archive contains — a channel created after approval still never joins it. The breadth of the read is disclosed rather than hidden: the prerequisite prober reports how many records came from channels the scope did not name, and the qualification prerequisites require a team that exists only for the probe. A scope naming a channel in a shared team transmits that team's other conversations, which is a property of the API, not a choice the seam can make.

**The archive route's application roles are six, not four.** `ARCHIVE_ROLES` in `src/engine/providers/credentials.ts` is an **exclusive** allowlist, and a token carrying any role outside it refuses with `credential_permissions_invalid`. Beyond the four #15 named, a channel scope needs `Channel.ReadBasic.All` for the channel-list resolution above, and `transcripts` needs `OnlineMeetings.Read.All` for the meeting lookup that maps a transcript to a frozen chat. Exclusivity means the archive route cannot share an app with the file route or its fixture mutator, whose `Sites.Selected` is outside the allowlist: least privilege here is enforced by refusal rather than by convention.

## Consequences

- The `− 1 ms` offset is load-bearing. Removing it returns the route to refusing every collection call, which is why `exportWindowFilter` carries that warning and a regression test pins the operator and the offset for both roots and both message routes.
- The qualification prerequisites for this route are a purpose-built team and a dedicated user, not a corner of a production tenant. That is a property of the team-wide read, not caution.
- An operator who grants the archive app one extra role gets a refusal rather than a wider archive. The prerequisite prober names the offending role, because the engine's refusal alone does not say which grant to remove.
- The transcript route reaches only chats: `collectionPath` refuses a non-`user-chats` scope with `transcript_unsupported_channel_meeting`, so proving the transcripts option needs a meeting organised by an explicitly scoped user, not merely a tenant toggle.
