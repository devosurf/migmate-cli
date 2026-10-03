# ADR-0012: Staged migrations and destination access timing

- Status: accepted
- Date: 2026-10-03
- Accepted: Morgan, 2026-10-04, as written. Implementation is tracked in #58 and #59.
- Issues: [#58](https://github.com/devosurf/migmate-cli/issues/58), [#59](https://github.com/devosurf/migmate-cli/issues/59); downstream [#60](https://github.com/devosurf/migmate-cli/issues/60)
- Amends: [ADR-0010](0010-rclone-executes-file-transfers.md), for staged verification scope and provisioning timing only.

A staged file migration remains one finite job: prestage, approved deltas, freeze, settled final delta, full verification, then go-live. We decide on explicit stages and deferred member grants at `close`, because a successful bulk copy is neither a completed cutover nor permission to expose a still-mirrored destination. The commands and guarantees described here ship with #58 and #59; until then they are decisions, not documented behaviour.

## Context

The [product design's cutover lifecycle](../design/migration-product-session.md#cutover) keeps users out until verification and permission validation finish. The 0.2.3 rehearsal instead exposed members before copying, hid planned deletions, used a stale inventory, and found a file changing between copy and verification. A closed prestage cannot resume, and a replacement job cannot inherit its mirror authority. Lessons L1–L10 in the operator handover explain why the lifecycle and its human gates must be explicit rather than a sequence the operator remembers.

Scope is file migration, not Teams archive. OneNote section files opted into by #57 participate as ordinary files; this ADR does not invent a second notebook transfer mechanism. Existing grants outside Migmate's control, provider consistency, and concurrent writers still constrain what can be claimed.

## Decisions

### A1 — Staged intent and the final revision

Use `[options] staged = true` and `plan --final`. The initial ordinary staged revision is labelled **prestage**, later ordinary revisions **delta**, and an explicitly final revision **final**, in plan, status and report. Stage intent is bound into the approved plan. A staged job's `close` refuses `cutover_incomplete` unless the latest revision is final, settled and fully verified, with no unaccepted blocking findings. An earlier verified final revision cannot authorize closing a newer unverified revision. Accepted exceptions remain visible; “clean for closure” is not an assertion of exception-free parity.

Alternatives: flags alone do not protect an operator who forgets to mark staging; config alone does not identify the final revision. Separate jobs lose mirror provenance. Inferring finality from `close` repeats the accidental-close failure. Unstaged jobs keep their current lifecycle.

### A2 — Listing-derived delta preview, not RC dry-run

Before approval, list each mapping's **new**, **changed**, **unchanged** and, for mirror, **to-be-deleted** paths and byte totals. Show every deletion and compare its count with the mapping's `deleteLimit`; an over-limit plan cannot be approved as executable. In copy mode, destination-only paths are retained, not called deletions. New job-created destinations are empty for preview; later revisions compare with the actual destination.

Use RC `operations/list` with recursive file listings to obtain `Path`, `Size` and `ModTime`, applying the same roots, path matching, exclusions and effective configuration as the pass. For the SharePoint-to-Drive route with disjoint hashes, an existing file is unchanged when sizes match and the absolute modtime difference is **strictly less than** rclone's effective modify window; otherwise it is changed. The effective window includes both backends' precision and rclone's configured window, not a hard-coded one second or JavaScript millisecond rounding. The exact-boundary probe below matters.

This is a prediction of pass actions, not proof of content equality. Same-size changes within the modify window can be skipped by both preview and copy; verification remains separate. SharePoint destinations currently use `IgnoreSize` and `IgnoreChecksum` under ADR-0010; their preview must mirror those options instead of blindly applying the forward-route size rule. For backends sharing hashes, rclone may avoid retransmitting a same-content file whose timestamp differs; model that branch and distinguish timestamp-only work from copied bytes. Do not claim that a size/modtime-only implementation covers every backend.

`operations/check` is usable for membership and content comparisons where its comparison mode is sound, or to resolve the common-hash branch after the pass's timestamp decision. It is not an unqualified substitute for the pass predicate: a hash check can find changes the pass would skip, and with no common hash it misses same-size edits the pass would copy. `download: true` would read every byte and still answer content equality rather than exactly which actions the pass will take.

Alternatives: RC dry-run returns `{}`, not a structured action list; parsing human logs is a brittle second protocol. Size-only `check` missed both same-size edits in the probe. Treating every listed item as newly created hides cost and destructive scope. Any future rclone pin or worker-option change must update the preview's real-binary contract tests. Folder creation/deletion evidence from #56 complements, rather than substitutes for, the file preview.

### A3 — Freeze attestation and claim strength

The final approval records **who** froze the source, **when** (timestamp), and **how** (free text); the attestation is bound to that approval and carried into the report. Read-only observations supporting it are recorded separately from the human assertion. The guided flow requires an explicit freeze decision, not an inferred freeze from an idle listing.

Without a recorded or independently verified freeze, the report may claim observed quiescence and the actual verification result, never exact cutover parity. A freeze is necessary but not sufficient: omitted content, accepted mismatches, retained destination-only files and other fidelity limits still qualify any parity claim. Attestation does not claim Migmate locked the tenant.

Alternatives: automatic locking would require write privileges and provider-specific administration outside this scope; an empty delta alone cannot prove nobody may write next. An unrecorded verbal confirmation is not durable evidence.

### A4 — Bounded settled confirmation before verification

After the final copy, wait the connector's consistency interval and re-inventory completely against what was copied through the frozen bound. If approved content has not settled, run a catch-up pass within the same final revision, wait, and repeat. One complete confirmation with no unprocessed change is required before full verification starts. Bound the additional passes (default: **three**) and record the configured bound, actual settle-pass count, observations and outcome in the report. Exhaustion leaves cutover incomplete; it is not a successful verification or an infinite retry.

Settling does not enlarge approval. New paths or deletions outside the approved preview require `plan_revision_required`; never silently approve new destructive work inside a retry. Keep the original deletion authorization and its cumulative limit across settle passes. A change discovered during full verification still blocks completion: the settle loop is not a snapshot or a way to suppress verification findings.

Alternatives: one unconfirmed final pass produced the rehearsal race; unbounded retries can wait forever on a live source; always making a revision for a repeated read/copy of already approved content adds approval churn without stronger consent. The connector consistency interval must be established during implementation; this local probe does not measure SharePoint convergence time.

### A5 — Inventory age and a read-only freshness fence

Show `sourceInventoryAt` and its current age at planning and approval. At execute start, re-check the cheapest **proven read-only, scope-covering** change marker and refuse `plan_revision_required` if the source moved. Age is informative, not an arbitrary expiry that substitutes for detecting change.

For the probed SharePoint tenant, use a Graph delta cursor as the candidate fence: obtaining `/root/delta?token=latest` and reading its returned delta link succeeded with only `Sites.Read.All`. Root `eTag` and `cTag` were absent, so neither is a usable fence here. Capture the cursor before inventory, then replay and drain all pages after inventory to ensure the snapshot did not race a change; persist the approved baseline. At execution, replay that baseline, rather than comparing two opaque `token=latest` strings. Relevant change records, including descendant changes and deletions, invalidate the plan; a missing, expired or unreadable cursor cannot count as unchanged. A drive-wide conservative refusal is safer than missing a mapping-root change.

**Qualification still open:** read-only access and an unchanged replay are proven; detection of a newly changed nested file through this cursor, including consistency delay, is not proven by this read-only session. Root cTag propagation cannot be demonstrated because the root has no cTag, including in the historical inventory. Do not substitute root modification time or assume a folder tag summarizes its descendants. Before relying on the cursor to skip a complete comparison, prove its change coverage with Morgan's approved live fixture. Until then, use a complete read-only inventory comparison or refuse when freshness cannot be established; never silently bypass the gate. The reverse route needs its own qualified read-only marker or complete comparison.

Alternatives: root eTag/cTag would be cheaper if available and proven to cover descendants, but they are absent here. Polling latest-token strings is not a change-feed comparison. A complete inventory is more expensive but remains the safe baseline. A marker does not replace freeze, settled confirmation or final verification: it cannot close the race after the execute-start check.

### A6 / #59 — Deferred grants run at close (option a)

Add the approval-bound option:

```toml
[options]
staged = true
memberGrants = "after_verification" # staged default
# memberGrants = "before_copy"     # explicit legacy timing
```

Unstaged jobs retain the default `before_copy`; either mode is shown beside Mirror and Copy concurrency in plan and report. With `after_verification`, execute creates destinations and copies without granting manifest members; `status.memberGrants` remains empty through execution. Staged jobs do not grant after a verified prestage or intermediate delta.

The explicit **close confirmation is also the go-live authorization**. Once the latest required verification has no unaccepted blocking findings (otherwise `verification_unaccepted`), `close` grants every approved member, checks membership, runs a short destination-content and permission drift check, records timestamped grant evidence after the verification timestamp, produces the final report and closes. `drive_membership_mismatch` remains blocking. Staged finality is checked as A1 before any grant. Existing grant checkpoints, request IDs and resume semantics are retained.

Entering go-live durably fences further copy/mirror work for each affected drive **before** the first grant request. A crash, ambiguous grant response, partial grant or failed membership/drift check must not reopen a copy window. Repeating `close` resumes grant/check/report work, not transfers. Do not declare go-live successful if the post-grant checks fail; disclose that some access may already have been granted and require operator resolution without another pass against that drive.

The no-further-pass rule applies to deferred go-live, not to legacy `before_copy`, whose risk remains explicit. In either mode, if already granted members can write and a mirror pass is proposed, the plan warns that it can overwrite or delete their files. Migmate does not revoke external access or assert that administrators, existing drive members or members of a pre-populated group were excluded. The acting account's organizer access is necessary; restricting all other access is a precondition to the staged isolation claim.

Alternatives: a separate `grant` verb (#59 option b) permits independent go-live scheduling but adds a state, a gate and another place to accidentally run a pass after access. Grants during execute repeat the unsafe rehearsal window. Adding members in another revision repeats copy and verification. Filling an initially empty group outside Migmate remains an operator-managed alternative, but its effective membership and go-live evidence are external and must not be represented as Migmate-managed grants.

### A7 — Optional partial verification for intermediate deltas

Allow intermediate deltas to verify only items changed since the **last verified revision**, explicitly labelled **partial proof** with the baseline revision and covered paths. Account for creations, changes and deletions, retain earlier exceptions and do not advance the baseline on a failed/unverified revision. Prestage establishes a full baseline; without one, verification is full. Final revisions always verify the entire mapping, and full remains the default, including for unstaged jobs. Do not conflate verification scope with opting into size-only evidence.

Alternatives: full-only verification rereads every source byte on every delta and dominates the cutover preparation window. Partial final verification cannot establish final parity or detect independent damage to previously unchanged destination files. Partial intermediate proof deliberately does not claim that such files were rechecked; the savings have that visible cost.

### A8 — One job owns staging and mirror authority

Document that prestage, deltas and final cutover happen within **one open job**. Decide mirror and its deletion limit before the initial manifest load; a completed prestage is not a reason to close. Closing remains terminal. Defer cross-job mirror and do not add a provenance alias or make a path match count as ownership.

Alternative: inheriting another closed job's create evidence could support cross-job mirror, but requires a new provenance kind, ownership/conflict rules and destructive approval boundaries. That is a separate decision, not necessary to make this lifecycle safe. A new copy-only job can still target an existing destination under existing rules, but it does not inherit mirror deletion authority.

## Probe evidence

The probes used the worktree's vendored **rclone v1.75.0**, local disposable directories, and the existing source app for tenant `m365b563007`. No Microsoft or Google content, permissions or configuration were written. Tenant data requests were GET only; the credential session necessarily used the OAuth token endpoint to authenticate. Tokens, secrets and opaque delta links were not printed or committed. Throwaway scripts and local copies were removed after the observations below.

### A2: structured listing and real sync comparison

Commands executed from worktree `58` (the temporary script built the fixtures, called RC using JSON POST requests, and asserted preview versus resulting local bytes):

```sh
./vendor/rclone/osx-arm64/rclone version
./vendor/rclone/osx-arm64/rclone rcd \
  --rc-addr 127.0.0.1:45958 --rc-no-auth --config /dev/null \
  --modify-window 1s --metadata --disable=WriteDirMetadata
node /tmp/migmate-adr0012.Dr5k5u/local.mjs
```

RC is loopback-only and has no tenant configuration. The final run used `:local,hashes=quickxor:<source>` and `:local,hashes=md5:<destination>`, plus a fresh independent copy of the destination for the real sync. Thus `operations/check` really had **no common hash**, rather than merely simulating that condition with a size-only option. The earlier ordinary-local run also matched the four action classes.

The listing request was:

```json
{
  "fs": ":local,hashes=quickxor:<source>",
  "remote": "",
  "opt": { "recurse": true, "filesOnly": true }
}
```

`operations/list` returned per-file `Path`, `Size` and nanosecond-formatted `ModTime`; for example `same-size.txt`, size `4`, modtime `2023-11-14T23:13:30.000000000+01:00`. Destination baseline time was `2023-11-14T23:13:20+01:00`. The fixture and result were:

| Path                | Source / destination bytes | Modtime difference | Preview and actual sync action |
| ------------------- | -------------------------- | ------------------ | ------------------------------ |
| `new.txt`           | `new` / absent             | —                  | new                            |
| `size.txt`          | `longer` / `old`           | 0 s                | changed                        |
| `same-size.txt`     | `BBBB` / `AAAA`            | 10 s               | changed                        |
| `boundary.txt`      | `BBBB` / `AAAA`            | exactly 1 s        | changed                        |
| `same.txt`          | `same` / `same`            | 0 s                | unchanged                      |
| `within-window.txt` | `same` / `same`            | 0.5 s              | unchanged                      |
| `deleted.txt`       | absent / `gone`            | —                  | deleted                        |

The script used this predicate for this whole-second test fixture, not as a production precision implementation:

```js
const changed =
  source.Size !== destination.Size ||
  Math.abs(Date.parse(source.ModTime) - Date.parse(destination.ModTime)) >= 1000;
```

Observed RC calls/results:

- `sync/sync` with `{ srcFs, dstFs, _config: { DryRun: true } }` returned `{}`.
- `operations/check` with `{ srcFs, dstFs, combined: true }` returned `hashType: "none"`, `missingOnDst: ["new.txt"]`, `differ: ["size.txt"]`, `missingOnSrc: ["deleted.txt"]`; its combined output incorrectly classified `same-size.txt` and `boundary.txt` as `=`, for predicting sync actions.
- After resetting stats, real `sync/sync` on the independent destination copy returned `{}`. Reading its resulting paths and bytes produced exactly the preview above: `previewMatchesSync: true`. Stats reported **4 transfers, 17 bytes, 1 deletion, 0 errors**. The sync, not dry-run output, is the behavioral evidence.

This proves the local disjoint-hash predicate, including a same-size edit and the modify-window boundary. It does not qualify every cloud precision, common-hash branch, reverse-route option, exclusion or provider consistency behavior; implementation needs real-binary contract coverage of its actual worker configuration.

### A5: source-only Graph reads and historical limits

Executed:

```sh
node /tmp/migmate-adr0012.Dr5k5u/graph.mjs
```

The script parsed only credential references from the closed job's config at `~/Migrations/migmate-test/.migmate/jobs/ad080d86-7c8e-4d69-b07b-2858da226ec4/job.toml`. It imported `createCredentialSession` from `src/engine/providers/credentials.ts` and `createGraphTransport` from `src/engine/providers/http.ts`. A source-only evidence wrapper supplied the Graph transport's pacing identity without authenticating to Google; the actual Graph token and permission validation still came from the repository's credential session. The selected token-role output was exactly `["Sites.Read.All"]`.

The Marketing drive ID came from that job's `evidence/plan-review.json`, not the rclone remote's configured root. All paths below were requested explicitly under `https://graph.microsoft.com/v1.0`; no remote `drive_id` or `root_folder_id` defaults were used.

| GET route (relative to `/v1.0/drives/{marketingDriveId}`)                                           | Observed result                                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/root?$select=eTag,cTag,lastModifiedDateTime`                                                      | Success; `eTag` and `cTag` absent (printed as null); `lastModifiedDateTime: 2026-10-03T07:13:58Z` |
| `/root/delta?token=latest`                                                                          | Success; zero items, `@odata.deltaLink` present                                                   |
| Returned delta link, used without printing it                                                       | Success; zero items, next delta link present                                                      |
| `/root/children` and `/items/{folderOrNotebookId}/children`, with selected fields                   | Success; inspected nested existing content without changing it                                    |
| `/items/{nestedFileId}?$select=eTag,cTag,lastModifiedDateTime` and `/items/{nestedFileId}/versions` | Success for the three existing notebook files; tags present on files, one exposed version each    |
| `/root/versions`                                                                                    | Success; empty version list                                                                       |

Marketing's historical plan inventory at `2026-10-02T19:39:35.350Z` recorded root `etag: null`, `ctag: null`, and `modifiedAt: 2026-10-02T14:48:24Z`. The current root timestamp is later, but there is **no before/after root cTag to compare**. Existing nested notebook file histories exposed only version `1.0`, at `2026-09-15T19:50:13Z`, `19:50:17Z` and `19:50:21Z`; root versions exposed no history. Those observations do not establish that a root cTag changes on nested edits, or causally attribute the root timestamp change to a nested edit. No edit was made to manufacture that evidence.

Conclusion: delta acquisition and replay are demonstrably readable under the source app's existing read grant; root tags are unavailable in this library. Descendant-change coverage/latency of the delta fence remains a live qualification prerequisite, not an observed guarantee. A5 must retain that distinction.

## Consequences and acceptance gates

- **Accepted as written** (A1–A8, including the three-pass settle bound, A5's conditional delta fence with full-comparison fallback, and close-time go-live), together with the glossary terms.
- **#60's guided skill:** strategy rounds decide staged intent, mirror/limit, grant timing and verification scope before manifest load. Approval reads back inventory age and all previewed deletions; the digest stands alone and the confirmed approver identity is reused deliberately. The agent observes human edits and freeze read-only, distinguishes observation from attestation, and explains findings with a recommendation rather than silently accepting them. Questions remain short and decisions stay human-owned.
- **Go-live/close ordering in #60 changes:** review the pre-close report and settle findings **before** authorizing close. The go-live round authorizes the same close operation that grants members; do not teach a separate grant command or ask the human to fill a group before final verification. Confirm membership/drift and final report afterward, then hand over cleanup. Each round has an empty decision frontier and human confirmation before action; resume from durable status after interruption.
- Implementation must split drive creation from grants, extend immutable approvals/reports, fence transfer resumption once go-live starts, and add scope-aware verification baselines without weakening ADR-0010's default proof. README, release limits and skill changes belong to the implementation waves; this proposal does not advertise unshipped behavior.
- Required subsequent proof includes fake-provider lifecycle/error/recovery scenarios, real-binary preview cases, and Morgan-approved disposable live rehearsal: prestage, edits, destination-side write, freeze, final settling and go-live. Include same-size edits, folder deletion, a changed copied OneNote section, stale-plan refusal, partial grant recovery and no access before go-live. These live mutation checks were **not run** in this docs-only wave.
