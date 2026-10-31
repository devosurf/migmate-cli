# Routes and file-job operation

## Runtime and workspace

`CONTEXT.md` defines Migmate's terms; `migmate --help` is the authority on invocation syntax.

- Pass `--output json`. Parse the envelope; branch on `refusal.code` and the exit status, never on message text. In `json` and `jsonl`, refusals land on **stdout** beside successes — only text mode diverts a refusal to stderr, so an agent reading stderr for failures reads nothing.
- Run on Node 24.15.0 or later, any later major included. An earlier version refuses with `usage` at exit 2, before the store is touched, because the durable store is the release-candidate `node:sqlite`. `src/versions.ts` is the one place that decides this.
- Read with `--review` (`plan --review`, `verify --review`) when you only need evidence. It takes no writer lease, so it cannot collide with a running job; `status` never takes one at all.
- The store is `--home PATH`, else `MIGMATE_HOME`, else the nearest `.migmate/` directory walking up from the current folder, else the OS default. Work inside the operator's folder and every verb already addresses their store. A `.migmate` that is a file or a symlink refuses with `usage` rather than falling through to a parent or the default.

## Job setup

`init --type file_migration|teams_archive` returns the job id. Every later verb takes `--job ID`. Add `--config job.toml` to `init` to onboard at creation, or use `creds init --job ID --config job.toml` afterward. Until onboarding, `doctor` refuses. Preflight failures name their checks: tenant prerequisites need an administrator, while malformed configuration needs an operator fix. `plan` returns a `planDigest` binding an immutable proposal.

`status` is safe at any point. `cancel` is terminal and exits 0 on success.

## File provider pairs

Set the provider pair at the top level of the operator TOML, before any table:

```toml
sourceProvider = "sharepoint"
destinationProvider = "google_shared_drive"
```

For Google → SharePoint, swap the two values. Dropbox → Google uses
`sourceProvider = "dropbox"` and `destinationProvider = "google_shared_drive"`.
Dropbox destinations, Dropbox → SharePoint and same-provider copies refuse
`unsupported_route`. Empty config defaults to the forward pair; saved file configs
name both providers. Explicit `route` in a new file config refuses
`configuration_invalid`: replace `route` with `sourceProvider` and
`destinationProvider` using this example or its reverse. Historical persisted
`job.toml` route values are decoded read-only and preserved; historical status and
reports remain readable. Teams retains `route = "teams_global_archive"`.

Members remain limited to job-created destinations. Shared roles `reader`, `writer`,
and `manager` map to Google `reader`, `writer`, and `organizer`; Google-native
`organizer`, `fileOrganizer`, and `commenter` are also valid. The SharePoint role map
is `reader` → `read`, `writer` → `write`, `manager` → `owner`, but SharePoint
container creation and membership are unshipped. Use existing SharePoint roots
without `create` or `members`; the role map does not enable those operations.

### Dropbox sources

Onboard the read-only team app through [CREDENTIALS.md](CREDENTIALS.md)'s PKCE flow.
Name shared namespaces by `namespaceId` and a namespace-relative `folderPath` in the
manifest, for example `{"type":"dropbox","namespaceId":"123456","folderPath":""}`.
Deduplicate by namespace ID, not member mount name; member homes/app folders are excluded.
The adapter uses Select-Admin plus an explicit root namespace; `shared_folders` refuses
because it mounts content and changes the source.

Disclose Paper → `.html` conversion, Markdown (`.md`) fallback when HTML is
unavailable, and `.web` pointer-only copies. Both export formats are nonblocking.
Present visible
Files API unexportable documents as per-file `source_unsupported_export` blockers,
not legacy-Paper detections. Use [FINDINGS.md](FINDINGS.md) for the nonblocking legacy
notices: PLAN observes the selected admin's `paper_as_files`; false means outside-
namespace legacy content is not migrated, true means no legacy notice, and unknown
means could not check. No legacy acceptance is required. The plan freezes evidence
either way and the report reflects it. Even true does not prove pre-migration legacy
docs absent; plan/report never guarantee Paper parity.
Shared Drive destination depth includes wrapper folders and blocks beyond 100 levels.
The pre-copy folder check blocks the mapping before its worker starts; repair the source
hierarchy or destination wrapper, then plan/approve again before retrying.
Listing verification compares paths and sizes, downloading exports with unknown size;
hash verification downloads source bytes for Drive SHA-256, falling back to MD5.
Pinned rclone has no Dropbox ListR; recursive listings walk folders individually.
Listings and export-collision checks use disposable disk-backed indexes; verification
coverage is paged. Dropbox → Google uploaded bytes contribute to the Google
destination's engine-home account ledger, not a Dropbox upload allowance.

## Mapping manifests

For file migration batches, initialize with credential config; `[[mappings]]` may
be omitted. `creds init` and `doctor` can prove credentials before mappings exist.
Run `manifest load --job ID --file mappings.json --output json` before `plan`,
then rerun `doctor` to prove mapping-specific access. An empty job's `plan` refuses
`configuration_invalid` with `detail.field: "mappings"`: load the reviewed manifest.
JSON uses `{ "version": 1, "mappings": [...] }`; each mapping has `id`,
`source: { type: "sharepoint", driveId, folderPath }`, and
`destination: { type: "google_shared_drive", driveId, folderId }` for existing roots.
To provision, use `destination: { type: "google_shared_drive", create: "Drive name" }`
and optional mapping-level `members: [{ email, type, role }]`. Read README's
**Mapping manifests** for member roles and the seven-/nine-column CSV layouts.
`folderPath` is literal drive-relative text (`""` for the root), not URL-encoded.
Extra fields and `anyone`/`domain` members refuse.
On `configuration_invalid`, fix `refusal.detail.row` and `.field`; row 0 means the
document/header, other rows are one-based mapping records. Equal or nested source
roots within one drive, or destination roots within one Shared Drive, overlap and refuse.

The store becomes the authority: editing the manifest file changes nothing.
Loading after a plan creates a new revision needing human approval; if recollection
fails, fix the prerequisite and run `plan` again. Legacy config mappings migrate
on writer open. Review `plan --review --view mappings` and `status --view mappings`
with `--limit`, `--cursor`, `--search`, or `--mapping ID`; counts cover all matches.
In mapping view, read each row's `mapping` and `mappingPass`, not top-level
`mappingPasses` (omitted to keep the page bounded).

## Reverse route

For Google Shared Drives into SharePoint, set top-level
`sourceProvider = "google_shared_drive"` and `destinationProvider = "sharepoint"`
in the operator TOML before loading; one job copies in one direction, so a row in the other
direction (or a mixed manifest) refuses `configuration_invalid` with `field: "source.type"`.
A mapping uses
`source: { type: "google_shared_drive", driveId, folderId }` and
`destination: { type: "sharepoint", driveId, folderPath }`; the library and folder must
already exist, so `create`, `members` and mirror refuse. CSV uses README's eleven-column
layout. The job's `[rclone]` needs `sharepointDestinationRemote`, a separate SharePoint
app holding exactly `Sites.ReadWrite.All` (anything else returns `preflight_failed`
with `detail.check: credential_permissions_invalid`). Before mappings exist, the reverse
provider pair already requires this write remote and needs no `sourceRemote`; the
SharePoint-source pair requires `sourceRemote` and refuses the write remote.
Sources are read as the acting account. On `preflight_failed` with
`unreadableSourceDrives` (from `manifest load` or `doctor`/`plan`), surface those drive IDs: a human must add the acting
account as a member; Migmate never does. Verification defaults to path-and-size
listing comparison; opt-in hash verification compares quickXorHash computed
from the source with SharePoint's. For transformed destination content, use
[FINDINGS.md](FINDINGS.md)'s reverse-route decision guidance.

## Content proof

Both existing file routes always approve the map: roots, drives to create, members and options. Mapping roots alone select scope. Default verification compares rclone listings by relative path and size, including empty folders, without comparing content bytes; this limitation is disclosed without a finding. Every verification covers whole mappings. Opt-in `[options] verificationMode = "hash"` downloads source bytes to compute the destination's stored hash type: Drive SHA-256 (falling back per file to MD5), or SharePoint quickXorHash. It does not download the destination or require a Graph inventory. File and folder metadata remain unverified. Interpret missing/conflicting paths and leftovers through [FINDINGS.md](FINDINGS.md), not as successful copies.

Version history, list-item fields, retention labels and permissions are omitted and disclosed once in plan/report. OneNote copies as section files. Removed proof, exclusions, omission/OneNote policy, partial-verification and size-only options refuse. Old inventory-planned jobs refuse mutation; historical status, evidence and reports remain readable. Start a new job rather than rewriting old evidence.

**Large jobs:** the synthetic single-host gate covers five million files across mappings with a 192 MiB Migmate heap. Listings spill to temporary disk and evidence/reports still grow with job size. Check free disk and each destination's container limits; this does not qualify live-provider throughput or rclone's own memory. Read [release limits](../../../../docs/release-limits.md#listing-execution-and-historical-evidence) before sizing a large job.

**State compatibility:** opening an existing job upgrades it to schema 8 without rewriting historical evidence. Schema 6 first receives schema 7's control-request storage; schema 7 then receives the paged-evidence reader fence. Earlier builds refuse that store rather than misreading paged coverage. Preserve a backup before upgrade when rollback matters.

## Copy execution

Read the plan's **Copy concurrency** before approval. Job `[options]` settings `mappingsInFlight` (default `2`) and `transfersPerMapping` (default `4`) accept positive safe integers; the conservative defaults allow eight file transfers across two mappings. Use `mappingsInFlight = 1` for serial mappings. Passes share one managed worker and one serial checkpoint writer; a freed slot starts the next queued mapping. rclone's pacer absorbs throttling within a pass. Ordinary failed passes count against the run's retry budget without stopping other mappings.

Read `status.mappingPasses` for durable outcomes and rclone errors. Re-run `execute` to retry failed/interrupted passes, skipping completed passes for that revision; writer recovery marks all unfinished passes interrupted after the worker is gone, including every pass active at a crash. rclone skips identical files on retry. Ctrl-C stops active passes cooperatively and exits 130. Use `--output jsonl` for `mapping_progress` events (`mappingId`, `passNumber`, `bytes`, `files`, `speed`, `errors`).

For terminal-independent execution, run `execute --job ID --detach --output json`. Treat its acknowledgement as admitted execution, not completed copying; observe `status` before verification. Only execute detaches; JSONL is unavailable on the launcher. Tail the acknowledged private attempt log for redacted events and the final result. Status ownership records `detached` and job-folder-relative `logPath`, not a liveness probe. Logs under `<job>/logs/` are private, exclusive and retained, including refused launches; SQLite remains authoritative.

To stop a live command resumably, use `stop --job ID`; to end the job terminally, use `cancel --job ID [--reason TEXT]`. Wait for success: it confirms owner acknowledgement, worker cleanup and lease release. Control binds to the current owner UUID, never a PID. Stop with no owner returns `stopped: false`; duplicate stop joins, and cancel upgrades a pending stop. Interrupting the requester leaves the request delivered. Inspect status and repeat its resume verb after stop. A refused cancel leaves the active command untouched; stale/foreign ownership requires [REFUSALS.md](REFUSALS.md)'s recovery guidance.

Explain host lifetime before detaching: terminal closure/SSH disconnect are supported, reboot/shutdown are not. Linux logout with systemd `KillUserProcesses=yes` also stops the coordinator (consider `loginctl enable-linger`). macOS sleep pauses progress; `caffeinate -i -w <PID>` keeps that coordinator awake. Migmate makes no power assertion or automatic restart; after host loss, observe status and apply normal execute/reclaim recovery.

If `plan` is interrupted (exit 130 for Ctrl-C or 143 for SIGTERM), read `status`, then rerun plain `plan --job ID`. File and Teams collection abort in-flight reads, release the lease and leave any earlier completed plan intact; partial collection is not approvable. Normal cooperative interruption needs neither `reclaim` nor `execute`. The web view's **Quit process safely** also interrupts planning.

For `blocked` (exit 5) with `uploadQuota.code = "upload_quota_exceeded"` in the execute result or `status.mappingPasses[].uploadQuota`, present the acting account, hit time and earliest resume estimate. Google allows 750 GB of uploads per user per day; Migmate stops the other active passes and starts no queued mapping for that account. Recommend waiting until `earliestResumeAt` (hit time + 24 hours), then repeat `execute` on the same job. Explain `resumeTimeIsEstimate = true`: this is not Google's reset clock or guaranteed allowance. An earlier manual retry is allowed; automatic quota resume is unavailable. Quota stops bypass the ordinary failure budget; the quota pass's final `errors = null` means its ordinary failure count is unknown, while `rcloneErrors` retains the unclassified raw aggregate. Preserve earlier failures for review; a quota block is not an acceptance request.

Choose dedicated destination roots: file copy never deletes, but can update existing same-path files without collision protection. File migration uses no reserved IDs, private markers, move-by-id or local staging; Teams archive uploads retain their own protections. rclone copies empty directories and supported file timestamps/content type with owner, permission and label metadata off; folders get modification times only. SharePoint uses paths inside drives pinned by id, never `root_folder_id`. See README's “File mapping copies and recovery” for the shipped boundary.

## Observed Google uploads

Before approval and on status, present `uploadActivity`: the dated plan snapshot
versus the current cross-job view in **this engine home**. Name each approved,
provider-observed account, `(asOf - 24 hours, asOf]`, coverage start, partial
observed bytes and gaps. Unknown accounts remain separate attempts. A changed
observed account requires a new plan; credential-file rotation alone does not
reset its ledger.

File accounting follows the destination adapter's policy, not the retired `route`
option: Google Shared Drive destinations and acknowledged Teams cold-storage
content count, including unsuccessful attempts; recovered objects do not count again.
SharePoint destinations and local-only archives have no plan-time upload snapshot.
Downloads, reverse-route writes, local packaging/archives, verification,
metadata/HTTP overhead and preflight probes are excluded. Other engine homes,
hosts and non-Migmate uploads are unobserved, with no cross-home/host coordination.

Treat `estimatedRemainingBytes: null` as unavailable, not zero. New or older
uninstrumented history, unknown identities, missing terminal stats, crashes,
counter decreases and sampling gaps preserve partial totals without complete
coverage. File observations are normally ten seconds apart; archive observations
follow acknowledged chunks, and intervals over 30 seconds disclose timing
uncertainty. Unresolved attempts do not become complete through expiry.
Counter-reset gaps cover the remaining attempt, not only the decreasing sample.
For clock-skew gaps, keep the estimate unavailable until time catches up with
durable evidence; do not re-date observations. A stop acknowledgment is not proof
of a final counter, so unconfirmed termination remains incomplete. An unavailable
execute-time account probe refuses `preflight_failed` with safe evidence; reserve
`plan_revision_required` for an observed identity mismatch.
Even a complete local window only estimates `max(0, 750,000,000,000 - bytes)`;
provider retries and excluded activity make this different from Google's charge.

Planned upload bytes are unavailable; explain that Migmate cannot assess whether
the plan fits. The snapshot adds no scan or predicted-size warning, and current
status never rewrites approval. Estimates neither reserve allowance nor gate
execution or concurrency. Use the existing manual quota-resume procedure above;
scheduling and freeze-window suitability remain the operator/agent's decision.
Keep the home ledger: measurements last 48 hours, compact replay checkpoints last
its lifetime. Status is read-only; a ledger error needs investigation, not a
fabricated empty balance.

## Teams archive destination

When driving a `teams_archive` job, distinguish the destination-free local package from the optional Google Shared Drive cold-storage copy. Both support `retainedHistory`, `transcripts`, and `attachmentBytes`, subject to option-specific permissions and tenant probes. Live-test evidence is not required; per-job verification findings are the signal. A hosted-content probe with no non-empty sample skips rather than blocking a text-only or empty scope; an unreadable found asset still fails. `docs/release-limits.md` limit 5 states the coverage and prerequisites.

For a Drive copy, follow `README.md`'s "Teams archive destination" config: stable `destination.destDriveId` and `destination.destFolderId` plus a separate `secrets.google_service_account` file reference. Keep the existing Graph credential unchanged. Omit the destination and Google reference for a local-only archive; this remains the same Teams archive job type and lifecycle.

The local package self-verifies before upload and remains the authority. Drive receives three exposed root files and one ZIP per conversation. For retrieval, use `index.csv` to identify the conversation, download its ZIP, and extract it locally to read it; Drive's web UI is not an archive reading surface.

Before retaining a copy, read `docs/release-limits.md` limit 6 for the shared-drive-wide 500,000-item budget and permission boundary. Surface that capacity and immutability at rest are operator concerns: Drive does not enforce the ZIP's `0444`/`0555` entry modes as object permissions, and create-only uploads do not prevent outside edits.

## Verifying a change to this repo

`npm run typecheck` and `npm test` are hermetic and fast. `npm run check:package` packs, installs globally into a temporary prefix, and smoke-tests the artifact — run it when packaging or the vendored binaries are in scope. `npm run test:live -- --config <file>` exercises real providers, needs tenant access a human prepared, and is optional; never block on it.
