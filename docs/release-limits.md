# Release limits

This page separates shipped guarantees from historical live observations. File migration supports SharePoint document-library roots to existing Google Shared Drive folders or to Shared Drives created from the manifest, and Google Shared Drive folders to existing SharePoint document libraries or folders. Teams archives remain local packages with optional Shared Drive cold storage.

The file route now executes rclone mapping copy passes ([ADR-0010](adr/0010-rclone-executes-file-transfers.md)). Earlier measurements of Migmate's per-item file writer do not prove this implementation. Archive uploads retain their own reserved IDs, private markers, revision checks and create-only behavior.

## 1. File copy is path-based, not collision-protected

File migration uses rclone copy rather than Migmate's per-item destination writer. It can update existing same-path files and does not reserve destination IDs, attach private provenance markers, move prior copies by ID, or compare a revision token before writing. Choose dedicated destination roots and exclude outside writers during migration. Teams archive uploads are unchanged.

Copy never deletes. A renamed or removed source file can leave a destination-only file; verification reports `destination_only_retained` without blocking close. Mapping manifests load from strict JSON or fixed-column CSV into the job store and freeze into the plan; see README's **Mapping manifests** for the format and paged review. Existing destinations can coexist with drives to create when mirror is off. A job's route fixes one direction for every mapping: a row in the other direction, including any row of a mixed manifest, refuses at load with its row and `source.type`.

Job `[options] mirror = true` requires `deleteLimit`, a nonnegative safe integer applied separately to every mapping pass. Mirror accepts only manifest `destination.create` mappings, reusing their durable job-created drives on repeat passes; existing destinations refuse at load with row and field. The plan and report disclose mirror and its limit. rclone fails a mapping that exceeds the cap without deleting beyond it; other mappings continue. Deletions are not rolled back, and each retry has a fresh cap. Successful mirror passes remove destination-only files; verification still reports leftovers it observes, rather than hiding post-pass drift. This is tested with the fake provider and local-folder rclone binary, not a live tenant mirror run.

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

**Provisioning.** The plan lists each new drive and its explicit user/group members
and roles. Execute checkpoints a deterministic job-and-mapping request ID, creates
the drive, records its ID before granting members, and suppresses notification
emails. Lost responses recover by exact visible name: one candidate is adopted,
none retries the same request, several refuse `drive_creation_ambiguous` (exit 4).
Creation names cannot change after submission for that mapping ID. Schema version 5
adds job-scoped created drives and member grants without revising earlier approvals.

Verification compares created-drive membership against the manifest plus Google's
implicit creator-organizer grant. Missing, additional, or changed grants raise
blocking `drive_membership_mismatch` with both memberships as evidence.
It does not translate source permissions, repair drift, revoke removed members,
or manage existing-drive permissions. `anyone` and `domain` refuse at manifest load.
Status and report retain the created IDs and member grants. Offline engine and
HTTP contracts cover provisioning and crash recovery; no live tenant provisioning
measurement is claimed.

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
reusing the source app's client id. The source app never gains a write role, and a job
without Google-source mappings refuses `credential_config_invalid` if it names this
remote, so a job that only reads SharePoint never holds a write credential. A job with only reverse
mappings needs no SharePoint source remote. Destinations are paths under a library
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

## 2. Mapping recovery is durable; rclone jobs are not

Job `[options]` settings `mappingsInFlight` (default **2**) and `transfersPerMapping` (default **4**) are positive safe integers and appear in the immutable plan and report. These conservative defaults allow up to eight simultaneous file transfers, not a promised throughput under tenant throttling. Set `mappingsInFlight = 1` for serial mappings. At most the configured number of passes run inside one worker; a freed slot admits the next mapping without a batch barrier. One writer commits observations serially.

`status.mappingPasses` records revision, mapping ID, pass number, mode, nullable rclone handle (`executeId`, `jobid`, stats group), status, start/end timestamps, last stats and error. States are pending, running, completed, failed or interrupted. rclone's pacer absorbs throttling within a pass. A failed pass retains rclone's error and counts against the run's retry budget without stopping other active or queued mappings; a run with failures remains blocked.

On writer-open recovery, all unfinished passes whose worker is gone become interrupted, including every pass active at a crash. The next `execute` retries failed/interrupted mappings and skips completed passes for the approved revision. rclone compares files and skips identical ones on retry; this is not replay of a durable rclone job. Ctrl-C stops all active passes cooperatively and exits 130, leaving the job resumable.

`execute --output jsonl` emits `mapping_progress` with `mappingId`, `passNumber`, `bytes`, `files`, `speed` and `errors`. Copy statistics are not verification proof. Hash verification is a point-in-time statement, not a source freeze or future-drift guarantee.

One lifecycle writer holds a job. Automatic same-host takeover requires a heartbeat at least 30 seconds stale and the owner process and worker proven gone. Stop a recorded orphan worker with explicit `reclaim --confirm --stop-worker`; do not delete lease files.

## 3. rclone behaviour is version-pinned for a reason

**The pin.** Migmate ships and verifies its own transfer binary and accepts exactly one version, `v1.75.0`, from an exact-version table in code — not a semver range. Below the floor `v1.69.0` the refusal is `version_below_floor`, because below it a unix-socket connection silently skipped the configured RC authentication. Anything outside the table refuses with `version_untested`: no warning, no recorded downgrade, no "probably compatible". Widening the table is a code change, and the optional live test is the only way to observe the new version against a real library first.

**Why the pin is load-bearing rather than tidy.** rclone's `onedrive` backend applies `root_folder_id` to listings but **not** to object lookup, which resolves from the drive root. Observed directly against the live tenant on the pinned version: with the filesystem rooted at a fixture folder, a `GET` of a file at the _drive root_ returned 200 while the file actually inside that folder returned 404. An id-rooted filesystem therefore answered 404 for its own children, and could serve a same-named object from the drive root in place of the intended one.

**What Migmate does about it.** Each mapping addresses SharePoint by path inside a drive pinned by id, never `root_folder_id`. Per-mapping connection-string overrides reuse the operator's SharePoint and Google remotes. Copy and hash verification use these resolved roots rather than per-item local staging. This rests on a version-specific observation, not a documented rclone contract.

**Sample size: one backend, one version.** No other rclone version has been measured against this route. An untested version could resolve objects differently and silently substitute bytes, which is precisely what the exact-version allowlist defends against.

**Where you see it.** The `provider.transfer_binary` preflight check, which records the resolved path, SHA-256, and the exact version the binary reports; the `version_untested` and `version_below_floor` refusals; the live worker's version re-checked at execute time, where drift refuses `plan_revision_required`.

**Copy behavior.** rclone's asynchronous `sync/copy` (or `sync/sync` with `MaxDelete` for mirror) copies empty source directories and uses metadata to preserve supported created and modified times and Google Drive content type; Drive created time applies to fresh uploads. Owner, permission and label metadata are off. File verification does not verify folders or metadata. Finished rclone jobs remain queryable for 24 hours by default, but a worker restart invalidates old handles; Migmate's mapping-pass records supply recovery.

## 4. `Sites.Selected` sufficiency is proven for today's calls

**The source grants.** The file migration source app accepts exactly one of `Sites.Selected` or `Sites.Read.All`. `Sites.Selected` needs an explicit read grant on each named site; `Sites.Read.All` needs one tenant-wide admin consent and enables tenant discovery. Both together, `Files.Read.All`, all write roles, and every other extra role refuse with `credential_permissions_invalid`.

**What was measured.** With a token carrying `roles: ["Sites.Selected"]` alone, against the granted site: `GET /v1.0/drives/{driveId}`, `GET /v1.0/drives/{driveId}/items/{itemId}/children`, and `GET /v1.0/drives/{driveId}/items/{itemId}/delta` each answered 200, and rclone's `onedrive` backend listed the library with the same credential. The live preflight passes `provider.credentials`, the source root resolution, and the destination write probe on that grant.

**Sample size: the calls this release makes.** Sufficiency is proven for the Graph calls in the current file route, not promised for the route in general. Microsoft does not guarantee that these endpoints will never require a wider permission, and a Graph call added in a later release may need one.

**Consequence.** A call requiring more permission fails closed. Migmate never requests a wider grant on your behalf. The [ADR-0003 amendment](adr/0003-site-scoped-file-route.md) is implemented: `Sites.Selected` limits a leaked key to granted sites but costs one grant per site; `Sites.Read.All` avoids those grants but exposes every tenant site to a leaked source key, even sites absent from the manifest.

**Where you see it.** The `provider.credentials` preflight check and its recorded evidence — tenant id, client id, granted roles — and the `credential_permissions_invalid` refusal.

### Tenant discovery boundary

`discover --job ID [--file draft.json]` follows Graph `sites/getAllSites`, each
site's `sites` (subsites, recursively) and `drives` paging links, visiting each site
once and selecting document libraries. It requires
`Sites.Read.All`; scoped discovery refuses with `preflight_failed`, detail check
`discovery_requires_sites_read_all`, and required grant `Sites.Read.All`.
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

**Size-only is an explicit trade-off.** Set `[options] verificationMode = "size_only"` in the job TOML to compare listed sizes without downloading source bytes. The default is `"hash"`; the immutable plan and report state the mode. Size-only verification raises `content_verification_degraded` even when all sizes match or the mapping is empty. A missing destination hash after MD5 fallback raises that same finding. `close` refuses `verification_unaccepted` until an operator accepts every blocking finding by code. Neither mode verifies empty folders or basic metadata. Teams archive verification is unchanged: it self-verifies the local package, then byte-verifies every uploaded object and its provenance.

**What the source serves is what gets copied.** SharePoint can rewrite PDF, Office and HTML files and list sizes that contradict downloaded bytes ([provider byte-integrity research](research/provider-byte-integrity.md)). rclone owns execution and its backend checks; Migmate no longer stages files or requires its old two-read agreement before uploading. Hash verification raises `source_size_inconsistent` when listed size contradicts served bytes, with `listedSize`, `servedSize` and hash evidence. When hashes differ, verification measures an additional source read and checks it against downloaded SHA-256 before attributing the discrepancy. A destination length differing from served length also raises `size_mismatch`. Size-only cannot make that distinction; blocking findings require acceptance.

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

**The budget is shared-drive-wide.** Google's [500,000-item cap](https://support.google.com/a/users/answer/7338880?hl=en) counts files, folders, shortcuts, and items in trash across the entire shared drive, not just this job's destination folder. The payload therefore uses **one container per conversation**, rather than expanding every HTML part, JSONL record file, asset, and asset directory into separate Drive items. For `N` conversations, the upload shape is `N + 3` objects in the pre-existing destination folder: 20,000 conversations means 20,003 objects, about 4% of the cap, before counting that folder, other content, trash, or other jobs. This is payload arithmetic, not a tenant-scale measurement or a reservation of available capacity. A single whole-archive container would cost one item but require downloading every conversation to retrieve one.

**Where you see it.** The "Teams archive scope and fidelity" report section states the local authority, cold-storage payload, verification boundary, and operator-owned permissions. The [destination payload code](../src/engine/archive/destination.ts) fixes the object count; the [container writer](../src/engine/archive/container.ts) fixes the ZIP entry modes. The last live test measured three root objects and two conversation ZIPs, not tenant scale. The decision is [ADR-0008](adr/0008-archive-cold-storage-destination.md).

## Related records

These limits are operator-facing statements of decisions recorded elsewhere. The records are not required reading; they are the longer form.

- [ADR-0003](adr/0003-site-scoped-file-route.md) — original site-scoped grant and the later tenant-wide migration design amendment.
- [ADR-0004](adr/0004-drive-revision-concurrency.md) — historical file-writer revision checks; archive uploads retain that boundary.
- [ADR-0010](adr/0010-rclone-executes-file-transfers.md) — rclone executes file transfers; implemented here for existing mappings and destinations.
- [ADR-0005](adr/0005-unrepresentable-path-proof.md) and [ADR-0006](adr/0006-capability-sample-proofs.md) — what the live test may claim when the source cannot hold a sample.
- [ADR-0007](adr/0007-archive-scope-reads-and-window-filter.md) — what a Teams archive scope reads, and how its window survives an exclusive-only filter.
- [ADR-0008](adr/0008-archive-cold-storage-destination.md) — the archive destination is a cold-storage copy, with one container per conversation.
- [ADR-0009](adr/0009-per-job-verification-replaces-route-qualification.md) — per-job verification replaced route qualification; the live test is optional.
