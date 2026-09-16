# Release limits

Four properties of the first release are **measured, not guaranteed**. Two of them are permanent properties of the providers Migmate talks to, so no amount of work in Migmate removes them; two rest on observations of a live tenant whose sample size is stated below.

Each limit says what was measured, what Migmate does about it, and the refusal code or report line that names it while you are running a job. Everything here is already enforced in code; nothing on this page is a future intention.

Scope: the qualified file migration route — SharePoint document-library root to Google Shared Drive folder — measured on `darwin-arm64` against a live tenant on 2026-09-15/16 with the pinned transfer binary `v1.75.0`. The Teams archive route has no live observation yet; it claims none.

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

## Related records

These limits are operator-facing statements of decisions recorded elsewhere. The records are not required reading; they are the longer form.

- [ADR-0003](adr/0003-site-scoped-file-route.md) — the file route is site-scoped, not tenant-wide.
- [ADR-0004](adr/0004-drive-revision-concurrency.md) — destination concurrency rests on Drive's revision, not an ETag.
- [ADR-0005](adr/0005-unrepresentable-path-proof.md) and [ADR-0006](adr/0006-capability-sample-proofs.md) — what the qualification bundle may claim when the source cannot hold a sample.
- `qualification/gates.json` — the release-prerequisite register, including which gates remain unrun.
