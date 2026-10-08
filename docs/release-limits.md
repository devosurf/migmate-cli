# Release limits

This page separates shipped guarantees from historical live observations. File migration supports SharePoint document-library roots to existing Google Shared Drive folders or to Shared Drives created from the manifest, and Google Shared Drive folders to existing SharePoint document libraries or folders. Teams archives remain local packages with optional Shared Drive cold storage.

The file route now executes rclone mapping copy passes ([ADR-0010](adr/0010-rclone-executes-file-transfers.md)). Earlier measurements of Migmate's per-item file writer do not prove this implementation. Archive uploads retain their own reserved IDs, private markers, revision checks and create-only behavior.

## 1. File copy is path-based, not collision-protected

File migration uses rclone copy rather than Migmate's per-item destination writer. It can update existing same-path files and does not reserve destination IDs, attach private provenance markers, move prior copies by ID, or compare a revision token before writing. Choose dedicated destination roots and exclude outside writers during migration. Teams archive uploads are unchanged.

Copy never deletes. A renamed or removed source file can leave a destination-only file; verification reports `destination_only_retained` without blocking close. Mapping manifests load from strict JSON or fixed-column CSV into the job store and freeze into the plan; see README's **Mapping manifests** for the format and paged review. Existing destinations can coexist with drives to create when mirror is off. A job's route fixes one direction for every mapping: a row in the other direction, including any row of a mixed manifest, refuses at load with its row and `source.type`.

`[options] acceptedOmissions` lists plan-phase planned omissions, such as `version_history_omitted` and `source_metadata_export_only`, that are accepted by approving the plan that discloses them. It is bound to the plan digest. Each verification records as accepted exceptions only the listed codes that the approved plan contained, attributed to its approver and approval time; everything else, including `content_verification_degraded`, still requires `accept` for that verification digest. Accepted codes keep their per-file evidence in the report.

Several document libraries of one SharePoint site can be mapped in one job. Graph gives every library root in a site the same item ID, so Migmate tracks source items by drive and item ID together.

Job `[options] mirror = true` requires `deleteLimit`, a nonnegative safe integer applied separately to every mapping pass. Mirror accepts only manifest `destination.create` mappings, reusing their durable job-created drives on repeat passes; existing destinations refuse at load with row and field. The plan and report disclose mirror and its limit. rclone fails a mapping that exceeds the cap without deleting beyond it; other mappings continue. Deletions are not rolled back. Ordinary retries have a fresh cap; final settle catch-up passes retain the original cumulative deletion authorization. Successful mirror passes remove destination-only files; verification still reports leftovers it observes, rather than hiding post-pass drift. This is tested with the fake provider and local-folder rclone binary, not a live tenant mirror run.

Creation recovery adopts a sole exact-name match only when Google's `createdTime`
is at or after the durable creation-intent timestamp; older or missing evidence
refuses `drive_creation_ambiguous`, as do multiple matches. The creation record
distinguishes an own create response from timestamp-checked name recovery.
Mirror refuses each mapping whose record lacks proven provenance, including
legacy schema-5 records; it never infers ownership solely from the manifest's
`create` label. These optional evidence fields live in the existing JSON payload;
no schema migration fabricates proof for legacy drives.

Approval binds each root's identity, drive and folder type, not an inventory of unrelated destination content. An excluded source subtree gaining a new member still requires replanning.

**Acting account.** File jobs may set top-level `impersonate = true` and `subject`.
Preflight proves a token can be issued and `about.user.emailAddress` equals that
subject. When a manifest creates Shared Drives, `about.canCreateDrives` must be true.
Authorize the service account's numeric client id for domain-wide delegation with
only `https://www.googleapis.com/auth/drive`. The subject must be an ordinary
non-admin account; Migmate cannot check admin status without Admin SDK scopes and
never requests them. The key is domain-wide despite the configured subject.
The plan and report identify that subject, and the closing report lists deleting
the service-account key and delegation entry as open operator tasks. Per-mapping
rclone overrides inject impersonation; setting it in the operator's rclone file
refuses. With impersonation off, the service account continues acting as itself.

**Provisioning and grant timing.** The plan lists each new drive and its explicit
user/group members and roles. Execute checkpoints a deterministic job-and-mapping
request ID, creates the drive and records its ID before any member grant.
Lost responses recover by exact visible name with the timestamp evidence above:
none retries the same request, several refuse `drive_creation_ambiguous` (exit 4).
Creation names cannot change after submission for that mapping ID. Schema version 5
adds job-scoped created drives and member grants without revising earlier approvals.
Grant notification emails are suppressed.

The approval-bound `[options] memberGrants` defaults to `before_copy` for unstaged
jobs and `after_verification` for staged jobs; an explicit value overrides either
default. Plan and report show the effective mode beside Mirror and Copy concurrency.
`before_copy` retains execute-time grants. With `after_verification`, execute creates
and copies without manifest grants, and `status.memberGrants` remains empty through
execution. Verified prestages and intermediate deltas do not grant access.

Deferred go-live is authorized by confirming `close`, after the latest required
verification and acceptance of all blocking findings (`verification_unaccepted`
otherwise). Staged finality, settling and full verification are required before any
grant. Close durably fences future copy/mirror work for each affected drive before
the first grant request, grants approved members, checks membership and destination
content/permission drift, records grant evidence after the verification timestamp,
then produces the final report and closes. A crash, ambiguous response, partial
grant or failed check leaves that fence in place. Repeating `close` resumes grants,
checks and reporting, not transfers. Some access may already exist after a failed
close; resolve drift manually without another transfer pass against that drive,
and do not treat failed post-grant checks as successful go-live.

The short drift check re-lists destination file paths, sizes, stored hashes and
object IDs, plus folder paths, against the listing recorded by verification. It
does not re-download content or prove inherited permissions, effective group
membership or absence of later writes. Post-grant mismatches refuse
`verification_unaccepted` with `detail.accessMayExist = true` and a named check;
`execute` against a fenced drive refuses `go_live_started` (exit 4).

Membership checks include Google's implicit creator-organizer grant; deferred
pre-close verification does not require manifest grants that are not yet due.
Missing, additional, or changed grants raise blocking `drive_membership_mismatch`
with both memberships as evidence. Migmate does not translate source permissions,
repair drift, revoke removed members, or manage existing-drive permissions.
`anyone` and `domain` refuse at manifest load. Status and report retain created IDs
and member grants.

The deferred go-live fence does not apply to legacy `before_copy` timing.
Close uses the immutable plan's approved timing, not the current operator file.
Already-verified legacy/before-copy plans retain their previous close behavior,
including plans whose input digests contain retired qualification fields; only
approved deferred grants require the close-time input re-check.
In either mode, plan/report warn that mirror can overwrite or delete existing
writers' files. Deferred grants do not exclude external access, administrators,
existing drive members or members of pre-populated groups. The acting account
requires organizer access; operators must restrict all other access to claim staged
isolation. Offline engine and HTTP contracts cover provisioning and crash recovery;
no live tenant provisioning measurement is claimed.

**Google Shared Drives to SharePoint.** A job with `route = "shared_drive_to_sharepoint_library"`
reads Google Shared Drive folders (drive id and folder id) into existing SharePoint
document libraries or folders (drive id and library-relative path); the route is frozen
into the plan and report. Migmate creates no SharePoint sites,
libraries or folders, and never adds the acting account to a source drive: it must
already be a member. Manifest load and preflight check every source drive as the acting
account and refuse `preflight_failed`, naming each unreadable drive in `unreadableSourceDrives`.
SharePoint is written only by a separate destination app, the optional third rclone
remote `rclone.sharepointDestinationRemote`. Its token's roles must be exactly
`Sites.ReadWrite.All`; anything else refuses `credential_permissions_invalid`, as does
reusing the source app's client id. The source app never gains a write role. Before
manifest load, only the explicit reverse route may name the write remote (and requires
it); the default SharePoint-source route requires `rclone.sourceRemote` instead.
With mappings loaded, only Google-source mappings may hold the write remote;
an unnecessary write remote refuses `credential_config_invalid`. Reverse jobs need
no SharePoint source remote. Destinations are paths under a library
pinned by `drive_id`, never `root_folder_id`, and passes into SharePoint run with
`--ignore-size --ignore-checksum` because SharePoint may rewrite PDF, Office and HTML
bytes. Verification computes quickXorHash by downloading the source and compares it
with SharePoint's stored quickXorHash. A differing PDF, Office or HTML file raises
`destination_rewrote_file`; any other differing file raises `content_mismatch`. Both
carry `sourceHash`, `destinationHash`, `sourceSize` and `destinationSize` and block
`close` until accepted. Mirror and drive provisioning remain Google-destination only.
Engine, HTTP-transport and local-folder rclone tests cover this direction. The optional
live suite runs a reverse probe for a reverse job config (copy, quickXorHash verification,
and a replaced Office file and plain file); no credentialed run of it is claimed.

### rclone proof

`[options] proof = "rclone"` (SharePoint → Shared Drive only) replaces the per-file
Graph inventory with rclone's own listings. Approval binds mapping roots, drives,
members and options, not a file list. No preview, freshness comparison or per-file
omission finding precedes copying. rclone checks each upload's size; SharePoint and
Drive share no hash type, so neither rclone nor this mode compares content. Verification
compares rclone listings by path and size, folders included, and flags a mapping whose
last pass did not complete. Final passes settle on an empty rclone listing comparison.
Mirror passes record each destination-only file as `to_be_deleted` from an rclone
listing taken just before the pass, and delete at most that many, within
`deleteLimit`. Exclusions, `verificationMode`, `deltaVerification = "changed"` and
`oneNoteNotebooks = "omit"` refuse; notebooks are copied as their section files. A
test-tenant run covered two small libraries through prestage, a mirror delta, a final
pass and go-live, plus a copy-only run; no run at large-library scale is claimed.

rclone listings and hash sums, in both proof levels, run as polled rclone jobs with no
request deadline. rclone retries each Graph and Drive request up to 10 times, honoring
`Retry-After`, and its own I/O timeouts still apply. One listing response is capped at
256 MiB, roughly 900,000 files at the ~260 bytes per file observed on SharePoint. Split
a larger library into folder mappings.

### Staged migrations and cutover evidence

`[options] staged = true` keeps prestage, ordinary delta revisions and an explicit
`plan --final` revision in **one open job**. Ordinary revisions are prestage until
the job completes an execution and delta afterwards; an unapproved, unexecuted or
interrupted earlier revision does not turn a replan into a delta. Decide mirror and
`deleteLimit` before manifest load; a closed job is terminal and a replacement job
does not inherit its mirror provenance. `close` refuses `cutover_incomplete` unless
the latest revision is final, settled and fully verified; an earlier final result
is not authority for a later revision.
An approved staged revision permanently establishes that intent for the job,
including after manifest reloads clear the current plan pointer.

Plans expose listing-derived new, changed, unchanged and mirror deletion paths
and byte totals. Every proposed deletion is reviewable against its mapping's
limit; an over-limit preview cannot be approved as executable. Copy-only
destination extras are retained. Preview predicts rclone's comparison, not
content equality: same-size changes within its effective modify window can be
skipped. The timestamp boundary, backend precision, common-hash behavior and
reverse-route `IgnoreSize`/`IgnoreChecksum` settings matter; full verification
remains separate.

Planning and approval display `sourceInventoryAt` and its current age.
Execute-start freshness uses a **complete read-only inventory comparison**,
refusing `plan_revision_required` if the source changed or freshness cannot be
established. Graph delta acquisition and unchanged replay were observed with
read-only source credentials, but nested-change coverage and latency remain
unqualified. A cursor, root tag or root modification timestamp is not a qualified
shortcut around that comparison. The freshness fence does not close the race
between checking and copying.

Final approval records `--freeze-by`, `--freeze-at` (timestamp with timezone) and
`--freeze-how`; the web approval fields capture the same attestation. Migmate
does not lock the source tenant. A human attestation and read-only observations
are different evidence. Neither a quiet listing nor successful verification
alone asserts exact cutover parity; omissions, accepted mismatches and retained
destination-only paths continue to qualify the result.

After final copying, `consistencyIntervalMs` defaults to **30000** and
`settleMaxPasses` defaults to **3** additional catch-up passes. The interval is a
configurable wait, not a measured guarantee of SharePoint convergence. Each
confirmation inventories completely; a complete confirmation with no unprocessed
change is required before full verification. Catch-up stays within approval:
new paths or unapproved deletions require a new revision, and original deletion
authority is cumulative across settle passes. Exhaustion leaves cutover
incomplete. Changes during verification still block completion.

`deltaVerification = "full"` is the default. Opt-in `"changed"` gives intermediate
deltas **partial proof**, recording the last verified baseline and covered paths,
including creations, changes and deletions, while preserving earlier exceptions.
Baseline evidence is bound to source/destination roots, expanded exclusions,
OneNote policy and verification mode; a changed or missing binding forces full
verification for that mapping instead of reusing another destination's proof.
Failed or unverified revisions do not advance the baseline. Prestage, missing
baselines and final revisions use full verification; this option is independent
of `verificationMode = "size_only"`. Partial proof does not recheck independent
damage to previously unchanged destination content.

No live tenant writes were used to qualify the staged lifecycle here. Read-only
Graph probes and disposable local rclone probes in
[ADR-0012](adr/0012-staged-migrations-and-access-timing.md) do not establish cloud
settling latency or substitute for an operator-approved live cutover rehearsal.
See README's **Staged cutover: keep one job open** for the operator sequence.

## 2. Mapping recovery is durable; rclone jobs are not

Job `[options]` settings `mappingsInFlight` (default **2**) and `transfersPerMapping` (default **4**) are positive safe integers and appear in the immutable plan and report. These conservative defaults allow up to eight simultaneous file transfers, not a promised throughput under tenant throttling. Set `mappingsInFlight = 1` for serial mappings. At most the configured number of passes run inside one worker; a freed slot admits the next mapping without a batch barrier. One writer commits observations serially.

`status.mappingPasses` records revision, mapping ID, pass number, mode, nullable rclone handle (`executeId`, `jobid`, stats group), status, start/end timestamps, last stats and error. States are pending, running, completed, failed or interrupted. rclone's pacer absorbs throttling within a pass. An ordinary failed pass retains rclone's error and counts against the run's retry budget without stopping other active or queued mappings; a run with failures remains blocked.

**Drive upload quota blocks the whole job.** File uploads into Google Drive enable rclone's `--drive-stop-on-upload-limit`. The first detected daily-upload failure cooperatively stops other active passes and admits no queued mapping: all mappings use the same acting account. Execute returns the existing `blocked` outcome (exit 5), with `uploadQuota` evidence also retained on the failed pass in `status.mappingPasses[].uploadQuota` and the terminal event: `code = "upload_quota_exceeded"`, `hitAt`, `actingGoogleAccount`, `earliestResumeAt`, and `resumeTimeIsEstimate = true`. Account identity comes from the approved plan, falling back to the impersonation subject; old non-impersonated plans without that identity report `null`. No store schema version or outcome/exit-code change is required.

[Google documents 750 GB per user per day](https://developers.google.com/workspace/drive/api/guides/limits#additional_constraints), not a reset clock. The resume estimate is 24 hours after Migmate observes the failure; wait until then and re-run `execute` on the same job. Earlier manual retries are allowed, not refused by a cooldown fence. Quota stops bypass the ordinary failure budget. On that pass, `lastStats.errors` and terminal mapping-progress `errors` become `null` because rclone cannot separate quota errors from real file failures; `rcloneErrors` preserves the unclassified aggregate. This is not a zero-error claim. Detection follows v1.75.0's exact lower-case `User rate limit exceeded.` message with `userRateLimitExceeded` or `rateLimitExceeded`, or its `quotaExceeded` reason. Its fatal wrapper preserves the Google error text in RC job status; the “Received upload limit error” prefix exists only in logs. Storage quota, Shared Drive file count, ordinary API rate limits and download limits are not classified as daily-upload quota. No download-limit flag is enabled; the reverse route is unaffected. Trailing-24-hour byte accounting, plan-time allowance warnings and automatic quota resume are not implemented.

On writer-open recovery, all unfinished passes whose worker is gone become interrupted, including every pass active at a crash. The next `execute` retries failed/interrupted mappings and skips completed passes for the approved revision. rclone compares files and skips identical ones on retry; this is not replay of a durable rclone job. Ctrl-C stops all active passes cooperatively and exits 130, leaving the job resumable.

Planning is interruptible during preflight, full file inventory and Teams archive collection, including provider paging and per-file metadata requests. SIGINT exits 130 and SIGTERM exits 143 after worker cleanup and lease release. Re-run `plan` directly: interrupted collection publishes no new approvable revision and needs no `reclaim`. The existing `retry_budget_exhausted` refusal carries `detail.interrupted: true`; it is not a tenant prerequisite failure. Disposable preflight probes receive up to five seconds of cleanup after interruption; an unavailable destination can still leave privately marked `.migmate-probe-*` objects for operator cleanup. There is no process-kill deadline that bypasses durable cleanup.

`execute --output jsonl` emits `mapping_progress` with `mappingId`, `passNumber`, `bytes`, `files`, `speed` and `errors`. Copy statistics are not verification proof. Hash verification is a point-in-time statement, not a source freeze or future-drift guarantee.

One lifecycle writer holds a job. Automatic same-host takeover requires a heartbeat at least 30 seconds stale and the owner process and worker proven gone. Stop a recorded orphan worker with explicit `reclaim --confirm --stop-worker`; do not delete lease files.

## 3. rclone behaviour is version-pinned for a reason

**The pin.** Migmate ships and verifies its own transfer binary and accepts exactly one version, `v1.75.0`, from an exact-version table in code — not a semver range. Below the floor `v1.69.0` the refusal is `version_below_floor`, because below it a unix-socket connection silently skipped the configured RC authentication. Anything outside the table refuses with `version_untested`: no warning, no recorded downgrade, no "probably compatible". Widening the table is a code change, and the optional live test is the only way to observe the new version against a real library first.

**Why the pin is load-bearing rather than tidy.** rclone's `onedrive` backend applies `root_folder_id` to listings but **not** to object lookup, which resolves from the drive root. Observed directly against the live tenant on the pinned version: with the filesystem rooted at a fixture folder, a `GET` of a file at the _drive root_ returned 200 while the file actually inside that folder returned 404. An id-rooted filesystem therefore answered 404 for its own children, and could serve a same-named object from the drive root in place of the intended one.

**What Migmate does about it.** Each mapping addresses SharePoint by path inside a drive pinned by id, never `root_folder_id`. Per-mapping connection-string overrides reuse the operator's SharePoint and Google remotes. Copy and hash verification use these resolved roots rather than per-item local staging. This rests on a version-specific observation, not a documented rclone contract.

**Sample size: one backend, one version.** No other rclone version has been measured against this route. An untested version could resolve objects differently and silently substitute bytes, which is precisely what the exact-version allowlist defends against.

**Where you see it.** The `provider.transfer_binary` preflight check, which records the resolved path, SHA-256, and the exact version the binary reports; the `version_untested` and `version_below_floor` refusals; the live worker's version re-checked at execute time, where drift refuses `plan_revision_required`.

**Copy behavior.** rclone's asynchronous `sync/copy` (or `sync/sync` with `MaxDelete` for mirror) copies empty source directories and uses metadata to preserve supported created and modified times and Google Drive content type; Drive created time applies to fresh uploads. Folders receive modification times only: the worker runs with rclone's `--disable=WriteDirMetadata`, because v1.75.0's Drive backend turns a folder's source `inode/directory` content type into a 0-byte file of that type and fails the pass. Owner, permission and label metadata are off. File verification checks folder existence, including empty folders, but does not verify file or folder metadata. Finished rclone jobs remain queryable for 24 hours by default, but a worker restart invalidates old handles; Migmate's mapping-pass records supply recovery.

## 4. `Sites.Selected` sufficiency is proven for today's calls

**The source grants.** The file migration source app accepts exactly one of `Sites.Selected` or `Sites.Read.All`. `Sites.Selected` needs an explicit read grant on each named site; `Sites.Read.All` needs one tenant-wide admin consent and enables tenant discovery. Both together, `Files.Read.All`, all write roles, and every other extra role refuse with `credential_permissions_invalid`.

**What was measured.** With a token carrying `roles: ["Sites.Selected"]` alone, against the granted site: `GET /v1.0/drives/{driveId}`, `GET /v1.0/drives/{driveId}/items/{itemId}/children`, and `GET /v1.0/drives/{driveId}/items/{itemId}/delta` each answered 200, and rclone's `onedrive` backend listed the library with the same credential. The live preflight passes `provider.credentials`, the source root resolution, and the destination write probe on that grant.

**Sample size: the calls this release makes.** Sufficiency is proven for the Graph calls in the current file route, not promised for the route in general. Microsoft does not guarantee that these endpoints will never require a wider permission, and a Graph call added in a later release may need one.

**Consequence.** A call requiring more permission fails closed. Migmate never requests a wider grant on your behalf. The [ADR-0003 amendment](adr/0003-site-scoped-file-route.md) is implemented: `Sites.Selected` limits a leaked key to granted sites but costs one grant per site; `Sites.Read.All` avoids those grants but exposes every tenant site to a leaked source key, even sites absent from the manifest.

**Where you see it.** The `provider.credentials` preflight check and its recorded evidence — tenant id, client id, granted roles — and the `credential_permissions_invalid` refusal.

### Tenant discovery boundary

`discover --job ID [--file draft.json]` follows Graph `sites/getAllSites`, each
site's `sites` (subsites, recursively) and `drives` paging links, visiting each site
once and selecting document libraries. Personal OneDrive sites (`isPersonalSite`, or a
`-my.sharepoint.com` host) are skipped without a request; a document library someone
added inside a OneDrive site is therefore never proposed. It requires
`Sites.Read.All`; scoped discovery refuses with `preflight_failed`, detail check
`discovery_requires_sites_read_all`, and required grant `Sites.Read.All`. Site and
library names only label the draft: a missing or unusable name falls back to the
site's URL path segment or host, or the library's drive ID, and never refuses.
Missing or invalid site and library identifiers, site URLs, and malformed, off-Graph
or repeating pages refuse `preflight_failed` with detail check
`discovery_response_invalid`, naming the `object`, `field`, and site or route. A failed
Graph request is not retried: it refuses `preflight_failed` with detail check
`discovery_request_failed`, its HTTP `status`, and the route and site it was reading.
Credential onboarding, `doctor` and discovery accept a job with no mappings;
mapping-specific access checks apply after load. `plan` requires at least one mapping
and otherwise refuses `configuration_invalid`, field `mappings`, directing the operator
to `manifest load`. A fresh job still refuses `execute` with `approval_required` and
`verify` with `verification_unaccepted`; neither can migrate an empty job.
The JSON envelope carries sites/libraries and a draft manifest, proposing one
Shared Drive per library named from site name, site URL path and library with
empty members for the operator. No access translation, automatic manifest load, or provisioning occurs.
The optional private file contains only the draft and never overwrites an existing
path. Review mappings, names and members, then explicitly load, plan and approve.
An empty tenant returns an empty draft, not a loadable job manifest. Enumeration
is a point-in-time observation, not a tenant snapshot or a guarantee against sites
and libraries added after discovery.

## 5. Supported routes, and every job verifies itself

**What is supported.** These routes, on every platform the package installs on — macOS and Linux, x64 and arm64:

| Job type         | Route name                           | Route                                                                     | Archive options                                     |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------- |
| `file_migration` | `sharepoint_library_to_shared_drive` | SharePoint document library → Google Shared Drive folder                  | —                                                   |
| `file_migration` | `shared_drive_to_sharepoint_library` | Google Shared Drive folder → SharePoint document library or folder        | —                                                   |
| `teams_archive`  | `teams_global_archive`               | Graph v1.0 Global → local archive package                                 | `retainedHistory`, `transcripts`, `attachmentBytes` |
| `teams_archive`  | `teams_global_archive`               | Graph v1.0 Global → local package + Google Shared Drive conversation ZIPs | `retainedHistory`, `transcripts`, `attachmentBytes` |

`migmate web`'s native window has been inspected by an operator on `darwin-arm64` only; the other three platforms still need a person at a logged-in desktop ([#32](https://github.com/devosurf/migmate-cli/issues/32)). The CLI itself installs and passes its package smoke on all four in CI.

**What every job proves about itself.** File verification compares each mapping by relative file path using rclone hash listings. It reads Google Drive's stored SHA-256 without downloading the destination, falling back per file to stored MD5 when SHA-256 is absent, and re-downloads the source to compute the same hash type. Findings name missing files (`destination_missing`), size differences (`size_mismatch`), differing bytes (`content_mismatch`), and unreadable source files (`source_read_failed`), with `path`, `sourceSize`, `destinationSize`, `sourceHash`, `destinationHash`, and `hashType` evidence (unavailable values are `null`). Verification rows retain the destination object's observed id alongside its hash, including destination-only files; that id comes from the current listing, not a prior reserved identity. Destination-only files are reported as `destination_only_retained`, never deleted and never blocking close. Verification does not read per-item markers or reserved ids, and works with destinations written by the current execute.

**OneNote notebooks.** `[options] oneNoteNotebooks = "omit"` is the default:
`source_package_omitted` findings retain the source URL, section count, reason and
manual export guidance in plan and verification; paged review shows them. Export
from OneNote for Windows (File → Export → Notebook `.onepkg` or PDF), then upload
the export manually. Opt-in `"copy"` instead records `source_package_copied_as_files`
and copies every notebook descendant as ordinary files, including `.one` sections
and `Open Notebook.onetoc2`. Per-file hashes, unchanged delta skips and mirror
deletions apply normally. Other package types remain omitted, and `"copy"` refuses
on the reverse route (`configuration_invalid`, `options.oneNoteNotebooks`).
Plan and report disclose a read-only reference copy, not a working Google notebook:
download the folder to open `Open Notebook.onetoc2` in OneNote for Windows, not Mac
or Drive. Editing through Drive for desktop is unsafe. This does not enforce
read-only Drive permissions. Fake-provider lifecycle and paged Graph enumeration
are covered; a disposable live Google upload still requires operator approval.

**Size-only is an explicit trade-off.** Set `[options] verificationMode = "size_only"` in the job TOML to compare listed sizes without downloading source bytes. The default is `"hash"`; the immutable plan and report state the mode. Size-only verification raises `content_verification_degraded` even when all sizes match or the mapping is empty. A missing destination hash after MD5 fallback raises that same finding. `close` refuses `verification_unaccepted` until an operator accepts every blocking finding by code. Both modes verify folder existence, including empty folders, on both file routes; neither verifies file or folder metadata. A missing expected folder raises blocking `destination_missing` with `path` and `itemType: "folder"`. A file at an expected folder path raises blocking `destination_type_conflict`, not `destination_only_retained`. Excluded and omitted folders and their descendants are outside this check. Teams archive verification is unchanged: it self-verifies the local package, then byte-verifies every uploaded object and its provenance.

**What the source serves is what gets copied.** SharePoint can rewrite PDF, Office and HTML files and list sizes that contradict downloaded bytes ([provider byte-integrity research](research/provider-byte-integrity.md)). rclone owns execution and its backend checks; Migmate no longer stages files or requires its old two-read agreement before uploading. Hash verification raises `source_size_inconsistent` when listed size contradicts served bytes, with `listedSize`, `servedSize` and hash evidence. When hashes differ, verification measures an additional source read and checks it against downloaded SHA-256 before attributing the discrepancy. A destination length differing from served length also raises `size_mismatch`. Size-only cannot make that distinction; blocking findings require acceptance.

Per-file findings report the compared size in `sourceSize`; if it differs from the listing, `listedSize` preserves that listing. When `source_size_inconsistent` accompanies `size_mismatch` or `content_mismatch` for the same path, those dependent findings carry `cause: "source_size_inconsistent"`. A source change between copy and verify can produce all three. They remain separate blocking findings requiring explicit acceptance.

**What refuses.** `unsupported_route` (exit 4) names a shape this build does not implement: a destination outside the configured Shared Drive, a source that is not the named document library, a cloud other than Global, a mapping root that is not an ordinary folder, or a route name not listed above. Generic remotes and My Drive are not implemented: the credential loader accepts only `onedrive` document-library remotes (the source and, for reverse mappings, the destination) and a `drive` service-account remote, so any other backend refuses `credential_backend_unsupported`. That is a statement about what was built, not a gap in evidence.

**What a release no longer proves.** Published live evidence does not gate jobs ([ADR-0009](adr/0009-per-job-verification-replaces-route-qualification.md)). Engine tests cover mapping recovery and verification with the fake provider; opt-in real-binary checks exercise local-folder copy passes. Tenant execution is exercised only by the optional live suite. No live run is implied by a passing offline suite.

`transcripts` and `attachmentBytes` are supported without live-test evidence, like other configurations under ADR-0009. Their permission and tenant probes remain required; per-job collection and verification findings disclose gaps. Hosted-content preflight skips a scope kind with no non-empty sample (`hosted_content_probe_unavailable`) instead of requiring operators to plant content. A found asset that cannot be read still fails the probe.

**The last live test.** Between 2026-09-16 and 2026-09-20, on `darwin-arm64` with Node 24.21.0 and rclone `v1.75.0`, five configurations (file migration and each archive destination with options off or only retained history enabled) passed the live probe suite:

- **Historical file route only.** The earlier seven-probe run measured the now-removed per-item writer. It is not proof of rclone-executed mapping copies. The replacement optional suite exercises multi-mapping copying, empty directories, zero-byte files, hash verification, cooperative interruption and engine reopen/resume, completed-pass skips, and source capability samples. No credentialed run of the replacement suite is claimed here.
- **Local archive, retained history** (2026-09-17). 16 records in three conversations, including three retained versions — standard channel, private channel, and chat — three hosted assets, exhausted paging, durable restart, and byte-deterministic package regeneration with no local verification findings. System-message `identity_unresolved` and `render_downgraded` findings remain visible; they are not missing collection evidence.
- **Archive to Shared Drive** (2026-09-16). Three root files and two conversation ZIPs uploaded, downloaded, and matched on SHA-256 and size, with provenance markers and revision tokens checked. A lost upload acknowledgement recovered the same reserved object ID after reopening durable state, a rerun left the destination unchanged, ZIPs regenerated after filesystem timestamp changes were identical, and final verification used destination-only credentials.
- **Archive to Shared Drive, retained history** (2026-09-20, macOS 26.6.2). Six Drive objects preserved 16 records and three hosted assets, with each sample's current v2 and retained v1 intact. Stock `unzip` reconstructed the package, which passed production verification; replay preserved object IDs, revision tokens and provenance; and a separate disposable child proved `unowned_path_collision` and content/revision drift refusal without overwriting.

Those samples prove edited-text history, not deleted-message recovery or retained hosted-content availability. The tenant reported migration `Completed` without a completion timestamp, so no historical cutoff was established. Prerequisites are not merely credentials: retained history needs an applicable retention policy, transcripts need a tenant toggle plus an application access policy and an in-scope organizer's meeting, and attachment bytes need a tenant-wide file-read grant.

**Private channels are collected, not categorically omitted, when retained history is requested.**
[Spec #17 §11 and story 33](https://github.com/devosurf/migmate-cli/issues/17) now follow
[Microsoft's current retained-message contract](https://learn.microsoft.com/en-us/graph/api/channel-getallretainedmessages?view=graph-rest-1.0):
private versions are available for edits or deletions **after tenant storage migration
completed**, provided an applicable retention policy captured them. Edits/deletions before
migration are not returned by this API. Message creation time is not the migration boundary.
The archive manifest and report disclose this limit; an accepted or empty response proves
neither historical policy coverage nor a migration cutoff. An administrator can inspect
`Get-TenantPrivateChannelMigrationStatus`, but a missing completion timestamp stays unknown.

Preflight requests the retained route for every frozen binding, including private channels.
Collection and local verification require exhausted retained paging even for empty private
conversations. The live test requires non-empty retained records for every scope kind
present, and a retained channel scope additionally requires an actual private retained
sample. Standard-only data or empty private conversations cannot substitute for that
sample; absence refuses `archive_private_retained_history_sample_unavailable`. The
`retained_history` capture records hashed private conversation subjects, positive record
counts in `privateRetainedSamples`, and exhausted paging for all bindings, never raw
conversation IDs or message bodies, and the live test's verdict enforces that evidence
independently. This supersedes the earlier omission interpretation of [#33](https://github.com/devosurf/migmate-cli/issues/33).

**Running the live test.** It is optional. `scripts/stage1-prereqs.sh` and `scripts/archive-prereqs.sh` write its configuration, described by `scripts/live/config.schema.json`, with protected external credential references and disposable roots:

```sh
npm run test:live -- --config "$PROBE_CONFIG"
```

It prints `PASS` or `FAIL` per probe, exits 0 when every probe passed, and otherwise exits 4 with the refusal code `live_test_failed` and the blocking gate in `refusal.detail.gate`. Nothing it observes is written into the repository.

**Where you see it.** The `unsupported_route` refusal; option-specific tenant and permission probes; verification findings and `verification_unaccepted`.

## 6. The archive destination is cold storage, not a reading surface

**What the copy is.** The Google Shared Drive destination retains the three root files — `index.html`, `index.csv`, and `manifest.json` — plus one deterministic ZIP per conversation. The local package remains the authority: it is built and self-verified before containerization and upload. Destination verification checks the retained bytes and provenance, not a new export from Teams.

**What it is not.** Drive's web UI cannot render the HTML archive as a working site. The exposed root `index.html` does not turn Drive into a reading surface, and conversation contents inside ZIPs are opaque to Drive search. Use the exposed `index.csv` to identify a conversation's path, download the ZIP named for that conversation directory, and extract it locally to open its `index.html`. The retained local package is the complete offline reading surface.

**Read-only modes do not make Drive immutable.** Drive has no POSIX modes. The container writer records canonical `0444` file and `0555` directory modes inside each ZIP, but upload discards their protection as filesystem access controls: ZIP metadata does not become Drive object permissions. Immutability at rest is a **Drive permission concern for the operator**, not a guarantee of Migmate's read-only archive modes or create-only uploads. Migmate neither assesses nor migrates destination permissions or ownership.

**The archive revision token is measured, not promised.** Verification compares `"<headRevisionId or ->:<modifiedTime>"` with the recorded token; a changed or absent observed token raises `prior_copy_drift`. In the historical per-item file-writer measurement, Drive's `version` advanced from `1` to `2` within four seconds of upload with no writer present, while `headRevisionId`, `modifiedTime`, and `size` held still across roughly 24 seconds; a real content edit moved those three together. That is why `version` is excluded. The sample was **one file, one window, one run**, not a separate archive stability measurement. Google does not promise that the token's fields never move server-side, so `prior_copy_drift` can be raised without a real edit and requires review and remediation or explicit acceptance before closure.

**Create-only uploads do not make the name check atomic.** Archive uploads use reserved IDs and private provenance markers; they never update existing content, conditionally or otherwise. Drive v3 sends no ETag and documents no `If-Match` or other precondition to make the same-name check before a create atomic with that create. A concurrent same-name object is detected by the next verification pass, never prevented: `destination_duplicate_name` names multiple objects, and `unowned_path_collision` names a sole unowned file when no recorded copy exists. Neither the token nor the name check provides an atomic conditional update.

**The budget is shared-drive-wide.** Google's [500,000-item cap](https://support.google.com/a/users/answer/7338880?hl=en) counts files, folders, shortcuts, and items in trash across the entire shared drive, not just this job's destination folder. The payload therefore uses **one container per conversation**, rather than expanding every HTML part, JSONL record file, asset, and asset directory into separate Drive items. For `N` conversations, the upload shape is `N + 3` objects in the pre-existing destination folder: 20,000 conversations means 20,003 objects, about 4% of the cap, before counting that folder, other content, trash, or other jobs. This is payload arithmetic, not a tenant-scale measurement or a reservation of available capacity. A single whole-archive container would cost one item but require downloading every conversation to retrieve one.

**Where you see it.** The "Teams archive scope and fidelity" report section states the local authority, cold-storage payload, verification boundary, and operator-owned permissions. The [destination payload code](../src/engine/archive/destination.ts) fixes the object count; the [container writer](../src/engine/archive/container.ts) fixes the ZIP entry modes. The last live test measured three root objects and two conversation ZIPs, not tenant scale. The decision is [ADR-0008](adr/0008-archive-cold-storage-destination.md).

## Related records

These limits are operator-facing statements of decisions recorded elsewhere. The records are not required reading; they are the longer form.

- [ADR-0003](adr/0003-site-scoped-file-route.md) — original site-scoped grant and the later tenant-wide migration design amendment.
- [ADR-0004](adr/0004-drive-revision-concurrency.md) — the measured revision token and Drive precondition limits still apply to archive uploads; see [§6](#6-the-archive-destination-is-cold-storage-not-a-reading-surface) for their create-only boundary.
- [ADR-0010](adr/0010-rclone-executes-file-transfers.md) — rclone executes file transfers; implemented here for existing mappings and destinations.
- [ADR-0013](adr/0013-rclone-proof-map-only-approval.md) — opt-in rclone proof approves the mapping roots and verifies by listing.
- [ADR-0005](adr/0005-unrepresentable-path-proof.md) and [ADR-0006](adr/0006-capability-sample-proofs.md) — what the live test may claim when the source cannot hold a sample.
- [ADR-0007](adr/0007-archive-scope-reads-and-window-filter.md) — what a Teams archive scope reads, and how its window survives an exclusive-only filter.
- [ADR-0008](adr/0008-archive-cold-storage-destination.md) — the archive destination is a cold-storage copy, with one container per conversation.
- [ADR-0009](adr/0009-per-job-verification-replaces-route-qualification.md) — per-job verification replaced route qualification; the live test is optional.
