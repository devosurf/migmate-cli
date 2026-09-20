# Release limits

Four properties of the first release are **measured, not guaranteed**. Two of them are permanent properties of the providers Migmate talks to, so no amount of work in Migmate removes them; two rest on observations of a live tenant whose sample size is stated below. A fifth section states the exact routes and architectures that are qualified at all, because everything outside them refuses rather than degrades. A sixth states the archive destination's cold-storage limits.

Each limit says what was measured, what Migmate does about it, and the refusal code or report line that names it while you are running a job. Everything here is already enforced in code; nothing on this page is a future intention.

Scope: five qualified tuples — file migration from a SharePoint document-library root to a Google Shared Drive folder, and Teams archive from Graph v1.0 Global to a local archive package with or without a Shared Drive destination, each with either all options off or only retained history enabled — all measured on `darwin-arm64` against a live tenant on 2026-09-15–20 with the pinned transfer binary `v1.75.0`. Limits 1 to 4 describe the file route; the archive destination reuses its Drive concurrency and provenance stack. Limit 5 states what is qualified; limit 6 bounds what the Drive archive copy provides.

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

**What bounds the exposure.** Migmate refuses to run two lifecycle writers against one job, so the race is always Migmate against an outside editor of the destination folder, never Migmate against itself. Verification is a timestamped point-in-time statement, not a source freeze or a future-drift guarantee.

**Where you see it.** The "Measured release limits" section of every file migration plan and report; the verification findings above; the decision record is [ADR-0004](adr/0004-drive-revision-concurrency.md).

## 3. rclone behaviour is version-pinned for a reason

**The pin.** Migmate ships and verifies its own transfer binary and accepts exactly one version, `v1.75.0`, from an exact-version table in code — not a semver range. Below the floor `v1.69.0` the refusal is `version_below_floor`, because below it a unix-socket connection silently skipped the configured RC authentication. Anything outside the table refuses with `version_untested`: no warning, no recorded downgrade, no "probably compatible". Widening the table means re-running route qualification.

**Why the pin is load-bearing rather than tidy.** rclone's `onedrive` backend applies `root_folder_id` to listings but **not** to object lookup, which resolves from the drive root. Observed directly against the live tenant on the pinned version: with the filesystem rooted at a fixture folder, a `GET` of a file at the _drive root_ returned 200 while the file actually inside that folder returned 404. An id-rooted filesystem therefore answered 404 for its own children, and could serve a same-named object from the drive root in place of the intended one.

**What Migmate does about it.** Source byte reads are path-addressed, and the path is bound to the item before any byte is read: Graph must resolve the drive-root path to the same item id and the same etag, or the read refuses. The drive itself stays pinned by id. That is why the read path looks the way it does, and it rests on a version-specific observation rather than a documented rclone contract.

**Sample size: one backend, one version.** No other rclone version has been measured against this route. An unqualified version could resolve objects differently and silently substitute bytes, which is precisely what the exact-version allowlist defends against.

**Where you see it.** The `provider.transfer_binary` preflight check, which records the resolved path, SHA-256, and the exact version the binary reports; the `version_untested` and `version_below_floor` refusals; the live worker's version re-checked at execute time, where drift refuses `plan_revision_required`.

## 4. `Sites.Selected` sufficiency is proven for today's calls

**The grant.** The file migration source app requires `Sites.Selected` and nothing else, granted on exactly the site the operator names. The role set is a closed set: a token carrying more — `Files.Read.All`, for instance, which is tenant-wide read of every file in the tenant — is refused with `credential_permissions_invalid` rather than silently accepted.

**What was measured.** With a token carrying `roles: ["Sites.Selected"]` alone, against the granted site: `GET /v1.0/drives/{driveId}`, `GET /v1.0/drives/{driveId}/items/{itemId}/children`, and `GET /v1.0/drives/{driveId}/items/{itemId}/delta` each answered 200, and rclone's `onedrive` backend listed the library with the same credential. The live preflight passes `provider.credentials`, the source root resolution, and the destination write probe on that grant.

**Sample size: the calls this release makes.** Sufficiency is proven for the Graph calls in the current file route, not promised for the route in general. Microsoft does not guarantee that these endpoints will never require a wider permission, and a Graph call added in a later release may need one.

**Consequence.** A call that needs more permission **fails closed**: preflight refuses `credential_permissions_invalid`, or the call itself refuses on a 403 that is classified terminal with zero retries. Migmate never degrades to a partial result or requests a wider grant on your behalf. Re-adding a tenant-wide grant means re-opening [ADR-0003](adr/0003-site-scoped-file-route.md) and re-running route qualification, because the qualified-route tuple binds the granted permission set.

**Where you see it.** The `provider.credentials` preflight check and its recorded evidence — tenant id, client id, granted roles — and the `credential_permissions_invalid` refusal.

## 5. Only five exact routes are qualified, on one machine architecture

**What a qualified route is.** The whole tuple: job type, source system and backend configuration, destination system and backend configuration, pinned transfer-binary version, guarantee-set id, and desktop architecture. A job whose tuple does not match a stored evidence bundle refuses `unqualified_route` before it does any work. There is no "probably compatible", no best-effort flag, and no degrade toggle.

**What is qualified.** Exactly five tuples, all captured on `darwin-arm64`:

| Job type         | Route                                                                                           | Guarantees                           |
| ---------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| `file_migration` | SharePoint document library → Google Shared Drive folder                                        | `default`                            |
| `teams_archive`  | Graph v1.0 Global → local archive package                                                       | `default`, all options off           |
| `teams_archive`  | Graph v1.0 Global → local package + Google Shared Drive conversation ZIPs                       | `default`, all options off           |
| `teams_archive`  | Graph v1.0 Global → local archive package with retained history                                 | `default`, only `retainedHistory` on |
| `teams_archive`  | Graph v1.0 Global → local package + Google Shared Drive conversation ZIPs with retained history | `default`, only `retainedHistory` on |

**Other desktop architectures are not qualified.** `darwin-x64`, `linux-arm64` and `linux-x64` have no captured bundle. The tuple includes the architecture, so running on one of them refuses rather than assuming the observation transfers.

**Generic remotes and My Drive are not qualified or implemented.** A generic rclone remote to another generic rclone remote is not a supported route: the credential loader accepts only an `onedrive` document-library source and a `drive` service-account destination, so any other backend refuses `credential_backend_unsupported`, and the route name itself refuses `unqualified_route`. Google My Drive as a destination is likewise neither qualified nor implemented. This is a statement about what was built, not a temporary gap in evidence.

**The local retained-history tuple is independently qualified.** `retainedHistory=true`,
`transcripts=false`, `attachmentBytes=false`, channel and user-chats scopes, and no Shared
Drive destination have their own [published bundle](../qualification/f92d02ba93d671b31e0e268ad4c1fad3c37123f0fc72a6e97d6224ee7e1a20af/cc7064ad1b1075fd455d7054cada11ce8ab104ca18b3d9558a14e7a9d45417c8/bundle.json),
captured on 2026-09-17 with Node 24.21.0. It proves 16 records in three conversations,
including three retained versions (standard channel, private channel, and chat), three
hosted assets, exhausted paging, durable restart, and byte-deterministic local package
regeneration with no local verification findings. System-message `identity_unresolved`
and `render_downgraded` findings remain visible; they are not missing collection evidence.
The live sample proves edited text history, not deleted-message recovery or retained
hosted-content availability. The tenant reported migration `Completed` without returning
a completion timestamp, so this capture establishes no historical cutoff.

**Retained history with a Shared Drive destination owns a fifth tuple.** The complete
live run for [#43](https://github.com/devosurf/migmate-cli/issues/43), captured on 2026-09-20
with Node 24.21.0, macOS 26.6.2 and `darwin-arm64`, published
[tuple `2be46b0c…`, bundle `5087860e…`](../qualification/2be46b0c84231a54b9f1e5418bbe44a1db675c2f79932d1b2ef9386da123f04d/5087860e601a4a7095d376b6163585d949a6fceaa0a24d8586a1eb8e9d3841ed/bundle.json).
The exact combination is application-only Graph v1.0 Global, channel and user-chats scopes,
`retainedHistory=true`, `transcripts=false`, `attachmentBytes=false`, a separate Google
service-account credential, `default` guarantees and transfer `v1.75.0`.

The existing standard-channel, private-channel and chat samples were reused without source
mutation, in the closed modification window `[2026-09-16T00:00:00Z, 2026-09-17T19:36:28.566Z)`.
All three retained bindings exhausted paging. Six Drive objects — three exposed root files
and three conversation ZIPs — preserve 16 records and three hosted assets. Each original
sample's current v2 and retained v1 share their message identity and retain their content.
The local package self-verified before upload; every downloaded object matched durable
size/SHA-256 and provenance. Stock `unzip` reconstructed the complete package, whose
canonical records, HTML, counts, manifests, links and assets passed production verification.
Independent destination-only retrieval matched all six versions to live source observations;
offline browser inspection rendered both versions for every sample, with all three hosted
images loaded and no remote resources.

ZIPs regenerated from that live package after filesystem timestamp changes were identical.
A lost upload acknowledgement recovered the same reserved object after reopening durable
state; replay preserved object IDs, revision tokens and provenance. A separate disposable
child proved `unowned_path_collision` and real content/revision drift refusal without
overwriting or deleting those bytes during execution or verification. Ownership-checked
fixture teardown removed only its eight tool-created objects; the primary archive was
unchanged. Destination proof removed the Graph secret reference and used Google-only
verification sessions; nonsecret source identity fields remain bound in configuration.
The seven immutable evidence files were audited against live identifiers, names, message
bodies, credential references and secrets, plus raw identifier and URL patterns.

This edited-text sample still proves neither deleted-message recovery nor retained
hosted-content availability. The tenant previously reported migration `Completed` without
a completion timestamp; this run invents neither a timestamp nor a historical cutoff.
The four earlier bundles are unchanged. No qualification transfers to another option
combination, architecture, or full native ten-verb lifecycle.

Other option tuples still refuse `unqualified_route`, including transcripts and attachment
bytes. Prerequisites are not merely credentials: retained history needs an applicable
retention policy, transcripts need a tenant toggle plus an application access policy and
an in-scope organizer's meeting, and attachment bytes need a tenant-wide file-read grant.

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
conversations. Qualification still requires non-empty retained records for every scope kind
present, and a retained channel tuple additionally requires an actual private retained
capability sample. Standard-only data or empty private conversations cannot substitute for
that sample; absence refuses `archive_private_retained_history_sample_unavailable`.
The `retained_history` capture publishes hashed private conversation subjects, positive
record counts in `privateRetainedSamples`, and exhausted paging for all bindings, never raw
conversation IDs or message bodies. The bundle validator enforces that evidence independently.
This supersedes the earlier omission interpretation of [#33](https://github.com/devosurf/migmate-cli/issues/33).

**The optional Shared Drive archive destination has its own live qualification.**
`destination.destDriveId` and `destination.destFolderId` bind stable IDs, with a separate
`secrets.google_service_account` file reference beside the existing Graph credential.
The existing archive driver self-verifies its local package, containerizes each conversation
as a deterministic ZIP, and uploads the three root files plus one ZIP per conversation.
Durable reserved IDs, private provenance markers, revision tokens, and byte verification
govern replay and retention. Copies are create-only; collisions and drift are findings,
never permission to overwrite.
Configuring the destination changes the route tuple: `8f413512…` owns the separate
[published bundle](../qualification/8f413512e1d5f04cd4f102745a9bd958e16713e582002b04ca82b1cc6779621c/ab8c13259eba61eb7740b6b278e544cf6a73cdcd0c0b55cc82e1434a1f2bf5fd/bundle.json)
captured on 2026-09-16; the published local archive bundle cannot qualify it.
The live probe uploaded three root files and two conversation ZIPs, downloaded every
object to compare SHA-256 and size, and checked private provenance markers and revision
tokens. It lost an upload acknowledgement before the verified commit, reopened the durable
journal, and recovered the same reserved object ID. A subsequent rerun left the destination
inventory unchanged. Both ZIPs were regenerated from the live package after changing
filesystem timestamps, with identical bytes. Final verification used destination-only
credentials, not Graph.
With no destination and all options off, tuple `6aa55648…`, package behavior, and its bundle remain unchanged.
The six-role Graph allowlist is unchanged, and an extra Graph role still refuses
`credential_permissions_invalid`.

**Reproducing the combined qualification.** Use supported Node 24 on `darwin-arm64`.
`PROBE_CONFIG` names an operator-owned configuration with protected external Graph and
Google file references, the explicit sample scope/window, and an empty disposable Drive
destination; `EVIDENCE_OUTPUT` names a new directory outside the repository:

```sh
node --version
node --test test/archive-qualification.test.ts
node --test test/archive-destination.test.ts
node --test test/archive-container.test.ts test/archive-package.test.ts test/qualification-bundle.test.ts
npm run typecheck
npm run qualify:route -- --config "$PROBE_CONFIG" --output "$EVIDENCE_OUTPUT"
npm test
npm run check:package
```

Recorded local results on the runtime/platform above: 49 targeted behavioral regressions
passed; typecheck passed; the full behavioral suite ran once with 195 passing tests and
zero failures. The actual package smoke built, packed, globally installed into a temporary
prefix, exercised the installed CLI and embedded assets, and accepted all five bundles
through the installed production evidence loader. All 26 files in the four earlier bundles
remained byte-identical. Production tuple binding also accepted the new combination and
refused attempts to enable transcripts or attachment bytes with its evidence.

The qualification command publishes nothing unless every real probe succeeds. Its
[`archive_destination` capture](../qualification/2be46b0c84231a54b9f1e5418bbe44a1db675c2f79932d1b2ef9386da123f04d/5087860e601a4a7095d376b6163585d949a6fceaa0a24d8586a1eb8e9d3841ed/captures/archive_destination.json)
records reconstruction, per-kind version counts/digests, recovery, determinism and safety;
the companion captures record retained paging, hosted bytes, package fidelity and native
runtime readiness. Private configuration, downloaded content and browser screenshots are
not published with the evidence. Paid CI availability is not part of this local proof.

**Where you see it.** The `provider.qualified_route` preflight check and the `unqualified_route` refusal; `qualification/gates.json`, which records all five published bundles and every gate still unrun.

## 6. The archive destination is cold storage, not a reading surface

**What the copy is.** The Google Shared Drive destination retains the three root files — `index.html`, `index.csv`, and `manifest.json` — plus one deterministic ZIP per conversation. The local package remains the authority: it is built and self-verified before containerization and upload. Destination verification checks the retained bytes and provenance, not a new export from Teams.

**What it is not.** Drive's web UI cannot render the HTML archive as a working site. The exposed root `index.html` does not turn Drive into a reading surface, and conversation contents inside ZIPs are opaque to Drive search. Use the exposed `index.csv` to identify a conversation's path, download the ZIP named for that conversation directory, and extract it locally to open its `index.html`. The retained local package is the complete offline reading surface.

**Read-only modes do not make Drive immutable.** Drive has no POSIX modes. The container writer records canonical `0444` file and `0555` directory modes inside each ZIP, but upload discards their protection as filesystem access controls: ZIP metadata does not become Drive object permissions. Immutability at rest is a **Drive permission concern for the operator**, not a guarantee of Migmate's read-only archive modes or create-only uploads. Migmate neither assesses nor migrates destination permissions or ownership.

**The budget is shared-drive-wide.** Google's [500,000-item cap](https://support.google.com/a/users/answer/7338880?hl=en) counts files, folders, shortcuts, and items in trash across the entire shared drive, not just this job's destination folder. The payload therefore uses **one container per conversation**, rather than expanding every HTML part, JSONL record file, asset, and asset directory into separate Drive items. For `N` conversations, the upload shape is `N + 3` objects in the pre-existing destination folder: 20,000 conversations means 20,003 objects, about 4% of the cap, before counting that folder, other content, trash, or other jobs. This is payload arithmetic, not a tenant-scale qualification or a reservation of available capacity. A single whole-archive container would cost one item but require downloading every conversation to retrieve one.

**Where you see it.** The "Teams archive scope and fidelity" report section states the local authority, cold-storage payload, verification boundary, and operator-owned permissions. The [destination payload code](../src/engine/archive/destination.ts) fixes the object count; the [container writer](../src/engine/archive/container.ts) fixes the ZIP entry modes. The [published destination capture](../qualification/8f413512e1d5f04cd4f102745a9bd958e16713e582002b04ca82b1cc6779621c/ab8c13259eba61eb7740b6b278e544cf6a73cdcd0c0b55cc82e1434a1f2bf5fd/captures/archive_destination.json) measured three root objects and two conversation ZIPs, not tenant scale. The decision is [ADR-0008](adr/0008-archive-cold-storage-destination.md).

## Related records

These limits are operator-facing statements of decisions recorded elsewhere. The records are not required reading; they are the longer form.

- [ADR-0003](adr/0003-site-scoped-file-route.md) — the file route is site-scoped, not tenant-wide.
- [ADR-0004](adr/0004-drive-revision-concurrency.md) — destination concurrency rests on Drive's revision, not an ETag.
- [ADR-0005](adr/0005-unrepresentable-path-proof.md) and [ADR-0006](adr/0006-capability-sample-proofs.md) — what the qualification bundle may claim when the source cannot hold a sample.
- [ADR-0007](adr/0007-archive-scope-reads-and-window-filter.md) — what a Teams archive scope reads, and how its window survives an exclusive-only filter.
- [ADR-0008](adr/0008-archive-cold-storage-destination.md) — the archive destination is a cold-storage copy, with one container per conversation.
- `qualification/gates.json` — the release-prerequisite register, including which gates remain unrun.
