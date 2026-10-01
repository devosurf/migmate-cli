# Release limits

Four properties of the first release are **measured, not guaranteed**. Two of them are permanent properties of the providers Migmate talks to, so no amount of work in Migmate removes them; two rest on observations of a live tenant whose sample size is stated below. A fifth section states the supported routes and what every job proves about itself, because everything outside them refuses rather than degrades. A sixth states the archive destination's cold-storage limits.

Each limit says what was measured, what Migmate does about it, and the refusal code or report line that names it while you are running a job. Everything here is already enforced in code; nothing on this page is a future intention.

Scope: file migration from a SharePoint document-library root to a Google Shared Drive folder, and Teams archive from Graph v1.0 Global to a local archive package with or without a Shared Drive destination. The measurements below were taken on `darwin-arm64` against a live tenant on 2026-09-15–20 with the pinned transfer binary `v1.75.0`, with archive options off or only retained history enabled. Limits 1 to 4 describe the file route; the archive destination reuses its Drive concurrency and provenance stack. Limit 5 states what is supported; limit 6 bounds what the Drive archive copy provides.

## 1. The destination concurrency token is measured, not promised

**What Migmate uses.** The destination concurrency token is `"<headRevisionId or ->:<modifiedTime>"`. `headRevisionId` moves when a binary file's content changes; `modifiedTime` covers metadata and the objects Drive gives no head revision, such as folders. Before a destination update, Migmate re-reads the object and compares that token; an absent expected or observed token is never treated as a match.

**What was measured.** On one destination file, with no writer present, Drive's own `version` field advanced from `1` to `2` within four seconds of the upload, while `headRevisionId`, `modifiedTime`, and `size` all held still across the whole observation window of roughly 24 seconds. A real content edit moved those three together. That is why `version` is excluded from the token: Drive documents it as reflecting every server-side change "even those not visible to the user", and a token built on it reported drift that never happened — the first run using it refused its own fixture teardown.

**Sample size: one file, one window, one run.** Google publishes no promise that `headRevisionId` and `modifiedTime` never move server-side. The stability Migmate depends on is an observation of this route, not an API guarantee.

**Consequence if that observation stops holding.** A server-side move of either field looks exactly like an outside edit, so Migmate refuses `prior_copy_drift` on an object nobody touched. That refusal is conservative by construction: it never overwrites. The remediations are the ordinary ones — fix it outside Migmate, or exclude the item and re-plan. There is no overwrite, takeover, or last-writer-wins switch to reach for.

**Where you see it.** The `prior_copy_drift` finding at plan time and the same code from a refused destination write; the "Measured release limits" section of every file migration plan and report.

## 2. The compare-then-write window cannot be closed

**The API fact.** Google Drive v3 publishes no ETag on a file resource and documents no `If-Match` or other precondition on `files.update`. Verified against the live Shared Drive: `files.get` returns `cache-control`, `content-type`, `vary`, and `x-content-type-options`, and nothing else of relevance.

**What that means for a write.** Migmate compares the concurrency token and then writes. Between the comparison and the write there is a window, and a concurrent editor inside that window is **detected by the next verification pass, never prevented**. This is a property of the API, not a gap in Migmate: there is no header, transaction, or retry strategy that makes the destination update atomic against another writer. Migmate sends no `If-Match`, because a header Drive ignores reads as a stronger guarantee than the API can give.

**Nothing in Migmate claims otherwise.** The destination guarantee is a compare-then-write, not an atomic conditional update. An edit that lands inside the window surfaces as a verification finding — `content_mismatch`, `size_mismatch`, or `metadata_mismatch` — and blocks closure until it is remediated or explicitly accepted as an exception.

**Approval is not a destination inventory freeze.** Unrelated destination additions and removals do not invalidate approval. Execution still checks the approved root's identity, drive, and folder type, rejects inconsistent destination enumeration, and checks each write for unowned path collisions and prior-copy drift immediately before mutation. These checks protect the objects the job writes without requiring replanning for other folder contents.

**What bounds the exposure.** Migmate refuses to run two lifecycle writers against one job, so the race is always Migmate against an outside editor of the destination folder, never Migmate against itself. Verification is a timestamped point-in-time statement, not a source freeze or a future-drift guarantee.

**Writer recovery keeps that boundary.** The next writer can automatically take over a same-host lease only after its heartbeat is 30 seconds stale and the owner process and worker are proven gone (including a silent worker socket). Recovery and acquisition commit atomically with a durable recovery event. A fresh heartbeat, live or unknown owner or worker, or foreign host still refuses; stopping a recorded orphan worker requires explicit `reclaim --confirm --stop-worker`.

**Where you see it.** The "Measured release limits" section of every file migration plan and report; the verification findings above; the decision record is [ADR-0004](adr/0004-drive-revision-concurrency.md).

## 3. rclone behaviour is version-pinned for a reason

**The pin.** Migmate ships and verifies its own transfer binary and accepts exactly one version, `v1.75.0`, from an exact-version table in code — not a semver range. Below the floor `v1.69.0` the refusal is `version_below_floor`, because below it a unix-socket connection silently skipped the configured RC authentication. Anything outside the table refuses with `version_untested`: no warning, no recorded downgrade, no "probably compatible". Widening the table is a code change, and the optional live test is the only way to observe the new version against a real library first.

**Why the pin is load-bearing rather than tidy.** rclone's `onedrive` backend applies `root_folder_id` to listings but **not** to object lookup, which resolves from the drive root. Observed directly against the live tenant on the pinned version: with the filesystem rooted at a fixture folder, a `GET` of a file at the _drive root_ returned 200 while the file actually inside that folder returned 404. An id-rooted filesystem therefore answered 404 for its own children, and could serve a same-named object from the drive root in place of the intended one.

**What Migmate does about it.** Source byte reads are path-addressed, and the path is bound to the item before any byte is read: Graph must resolve the drive-root path to the same item id and the same etag, or the read refuses. The drive itself stays pinned by id. That is why the read path looks the way it does, and it rests on a version-specific observation rather than a documented rclone contract.

**Sample size: one backend, one version.** No other rclone version has been measured against this route. An untested version could resolve objects differently and silently substitute bytes, which is precisely what the exact-version allowlist defends against.

**Where you see it.** The `provider.transfer_binary` preflight check, which records the resolved path, SHA-256, and the exact version the binary reports; the `version_untested` and `version_below_floor` refusals; the live worker's version re-checked at execute time, where drift refuses `plan_revision_required`.

**Copy-pass provider capability.** The managed worker and fake provider expose asynchronous copy/mirror passes and per-file hash listings ([#46](https://github.com/devosurf/migmate-cli/issues/46)); the job driver has not switched to those capabilities yet. A pass handle contains rclone's `executeId`, `jobid`, and isolated stats group. Finished jobs remain queryable in the live worker for 24 hours by default, configurable through `createTransferSupervisor({ jobExpiry })` using an rclone duration. This is not durable rclone state: a worker restart loses its jobs and invalidates old handles. Mirror requires a nonnegative integer delete limit, may delete up to that limit before failing, and never rolls deletions back. Hash listings return root-relative paths, listed sizes, and hexadecimal hashes (`null` when unavailable); `download` recomputes the requested SHA-256, MD5, or quickXorHash from bytes. The provider does not yet change a job's recovery, mirror-approval, or verification policy.

## 4. `Sites.Selected` sufficiency is proven for today's calls

**The grant.** The file migration source app requires `Sites.Selected` and nothing else, granted on exactly the site the operator names. The role set is a closed set: a token carrying more — `Files.Read.All`, for instance, which is tenant-wide read of every file in the tenant — is refused with `credential_permissions_invalid` rather than silently accepted.

**What was measured.** With a token carrying `roles: ["Sites.Selected"]` alone, against the granted site: `GET /v1.0/drives/{driveId}`, `GET /v1.0/drives/{driveId}/items/{itemId}/children`, and `GET /v1.0/drives/{driveId}/items/{itemId}/delta` each answered 200, and rclone's `onedrive` backend listed the library with the same credential. The live preflight passes `provider.credentials`, the source root resolution, and the destination write probe on that grant.

**Sample size: the calls this release makes.** Sufficiency is proven for the Graph calls in the current file route, not promised for the route in general. Microsoft does not guarantee that these endpoints will never require a wider permission, and a Graph call added in a later release may need one.

**Consequence.** A call that needs more permission **fails closed**: preflight refuses `credential_permissions_invalid`, or the call itself refuses on a 403 that is classified terminal with zero retries. Migmate never degrades to a partial result or requests a wider grant on your behalf. Re-adding a tenant-wide grant means re-opening [ADR-0003](adr/0003-site-scoped-file-route.md); the exclusive role allowlist enforces the granted set at every preflight.

**Where you see it.** The `provider.credentials` preflight check and its recorded evidence — tenant id, client id, granted roles — and the `credential_permissions_invalid` refusal.

## 5. Supported routes, and every job verifies itself

**What is supported.** These routes, on every platform the package installs on — macOS and Linux, x64 and arm64:

| Job type         | Route                                                                     | Archive options                                     |
| ---------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| `file_migration` | SharePoint document library → Google Shared Drive folder                  | —                                                   |
| `teams_archive`  | Graph v1.0 Global → local archive package                                 | `retainedHistory`, `transcripts`, `attachmentBytes` |
| `teams_archive`  | Graph v1.0 Global → local package + Google Shared Drive conversation ZIPs | `retainedHistory`, `transcripts`, `attachmentBytes` |

`migmate web`'s native window has been inspected by an operator on `darwin-arm64` only; the other three platforms still need a person at a logged-in desktop ([#32](https://github.com/devosurf/migmate-cli/issues/32)). The CLI itself installs and passes its package smoke on all four in CI.

**What every job proves about itself.** File verification re-hashes each source item's bytes and compares them with the destination's SHA-256, or with a full destination re-download when Drive withholds one, and checks size, created time, modified time to the second, MIME type, the private provenance marker, and drift on either side. An archive self-verifies its local package before anything leaves the machine, then byte-verifies every uploaded object and its provenance. Any gap is a finding, and `close` refuses `verification_unaccepted` until an operator accepts it by code.

**What the source serves is what gets copied.** SharePoint rewrites some PDF, Office, and HTML files on upload ([onedrive-api-docs#935](https://github.com/OneDrive/onedrive-api-docs/issues/935#issuecomment-441741631)), and it can list a size its download contradicts ([rclone](https://rclone.org/onedrive/#unexpected-file-sizehash-differences-on-sharepoint)). Migmate copies and verifies the bytes SharePoint serves, never a pre-SharePoint original. When the listed size disagrees, a second read must return identical bytes; the copy then proceeds and verification raises `source_size_inconsistent` with both sizes, which blocks `close` until accepted. Reads that disagree with each other are a change in flight and are retried, never copied. No file is skipped for this. See [provider byte-integrity research](research/provider-byte-integrity.md).

**What refuses.** `unsupported_route` (exit 4) names a shape this build does not implement: a destination outside the configured Shared Drive, a source that is not the named document library, a cloud other than Global, a mapping root that is not an ordinary folder, or a route name other than the two above. Generic remotes and My Drive are not implemented: the credential loader accepts only an `onedrive` document-library source and a `drive` service-account destination, so any other backend refuses `credential_backend_unsupported`. That is a statement about what was built, not a gap in evidence.

**What a release no longer proves.** Nothing gates a job on published evidence any more ([ADR-0009](adr/0009-per-job-verification-replaces-route-qualification.md)). Crash and restart durability, rerun and move semantics, collision handling, and whether the source listing silently misses an item kind are covered by the offline suite, and against real providers only by the optional live test. Nothing requires that test to have run for a given build, and other architectures or new configurations run without it.

`transcripts` and `attachmentBytes` are supported without live-test evidence, like other configurations under ADR-0009. Their permission and tenant probes remain required; per-job collection and verification findings disclose gaps. Hosted-content preflight skips a scope kind with no non-empty sample (`hosted_content_probe_unavailable`) instead of requiring operators to plant content. A found asset that cannot be read still fails the probe.

**The last live test.** Between 2026-09-16 and 2026-09-20, on `darwin-arm64` with Node 24.21.0 and rclone `v1.75.0`, five configurations (file migration and each archive destination with options off or only retained history enabled) passed the live probe suite:

- **File route.** All seven probes: zero-byte files and empty folders, stable-id rerun and move, metadata round trip, provenance marker round trip, checksum on fresh upload, the collision matrix, and route limits. Capability samples per [ADR-0006](adr/0006-capability-sample-proofs.md): a real OneNote notebook the driver omitted (`package`), a live HTTP 400 on reference creation (`reference`), and an undownloadable kind absent from the scanned scope.
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

- [ADR-0003](adr/0003-site-scoped-file-route.md) — the file route is site-scoped, not tenant-wide.
- [ADR-0004](adr/0004-drive-revision-concurrency.md) — destination concurrency rests on Drive's revision, not an ETag.
- [ADR-0005](adr/0005-unrepresentable-path-proof.md) and [ADR-0006](adr/0006-capability-sample-proofs.md) — what the live test may claim when the source cannot hold a sample.
- [ADR-0007](adr/0007-archive-scope-reads-and-window-filter.md) — what a Teams archive scope reads, and how its window survives an exclusive-only filter.
- [ADR-0008](adr/0008-archive-cold-storage-destination.md) — the archive destination is a cold-storage copy, with one container per conversation.
- [ADR-0009](adr/0009-per-job-verification-replaces-route-qualification.md) — per-job verification replaced route qualification; the live test is optional.
