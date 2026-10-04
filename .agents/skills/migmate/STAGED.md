# Staged migrations and destination access

## One open job

For file migrations, `[options] staged = true` labels ordinary revisions `prestage` until the job completes an execution and `delta` afterwards, so replanning an unapproved, unexecuted or interrupted prestage stays `prestage`; `plan --job ID --final --output json` makes a `final` revision. Keep all passes in the same open job: closing a prestage is terminal, and a replacement job does not inherit mirror authority. Decide staged intent, mirror/limit and `deltaVerification` before initial manifest load. Once a staged revision is approved, the job stays staged: planning with `staged` removed refuses `configuration_invalid` (`field: "options.staged"`). Teams archive does not use this file-only lifecycle.

### Preview and freshness

Plan evidence carries `sourceInventoryAt`; approval records its age. Review new, changed, unchanged and timestamp-only paths and byte totals, plus every mirror deletion against each mapping's limit. Copy-only leftovers are retained, not predicted deletions. Preview predicts pass actions, not content equality; verification is separate.

Execute performs a complete read-only inventory comparison before copying. Changed approved inputs require a new revision through `plan_revision_required`; inventory age is informative, not an arbitrary expiry. Graph cursors are not yet a qualified shortcut: root tags or an idle listing do not prove descendant freshness or a freeze.

### Final approval and settling

After `plan --final`, use the ordinary approval gate with all three flags on `approve`: `--freeze-by IDENTITY --freeze-at TIMESTAMP --freeze-how TEXT`. The timestamp must include a timezone; the text records how writes were stopped. The human attestation is approval-bound and retained in the report. Record supporting read-only observations separately: attestation does not mean Migmate locked the tenant. Without a recorded or independently verified freeze, claim only observed quiescence and actual verification results. Even with a freeze, omissions and accepted mismatches qualify parity.

Final execution waits the connector consistency interval and completely re-inventories what was copied. Catch-up passes stay within the same approved revision and deletion authorization; new paths or unauthorized deletions require replanning. One complete confirmation without unprocessed changes precedes full verification. `[options] settleMaxPasses` bounds additional passes (default three); `consistencyIntervalMs` controls the wait. Both accept nonnegative safe integers. Read the configured bound, actual passes, observations and outcome in the report. Exhaustion is incomplete cutover, not successful verification; settling is neither a snapshot nor permission to hide later verification changes.

### Intermediate proof

`[options] deltaVerification = "full"` is the default. `"changed"` allows intermediate verification against the last verified baseline, covering changed paths, creations and deletions and retaining earlier exceptions. Prestage establishes a full baseline; no baseline means full verification. Failed/unverified revisions do not advance it. Read the baseline revision and covered paths: this is partial proof and does not recheck independent damage to unchanged destination files. Final verification is always full; this option changes scope, not the content-proof mode.

## Member grants and close

`[options] memberGrants` defaults to `before_copy` for unstaged jobs and `after_verification` for staged jobs; either can be explicitly overridden. `doctor` requires `about.canCreateDrives`. Deferred execute creates and copies without manifest grants (`status.memberGrants` stays empty); otherwise grants precede copying. Notification emails are suppressed. Read `status.createdDrives` (a null drive ID is an unresolved intent) and `status.memberGrants`; the report retains both. Before go-live, crash recovery uses the same job's durable request IDs and created drive IDs.

Close is go-live authorization, not a separate grant verb. Review the pre-close report and accept chosen findings before authorizing it. Deferred `close` requires verification without unaccepted blocking findings and, for staged jobs, the latest final, settled, fully verified revision. It durably fences transfers before the first grant request, grants approved members, checks membership and destination drift, records timestamped grant evidence and closes. A partial grant, crash or failed check leaves that fence intact. Resolve drift manually and repeat `close`, not transfers; some access may already exist. [FINDINGS.md](FINDINGS.md) explains the gate codes.

Keep a submitted creation name bound to its mapping ID; use an existing destination ID rather than changing that intent. Google adds the creator as an implicit organizer; membership checks include it unless explicitly listed in the manifest. Deferred pre-close verification does not require manifest grants yet. Removing a manifest member does not revoke access. External access, administrators, existing-drive members and pre-populated group members are outside the deferred-access guarantee. Plan/report disclose the mode and warn that mirror can overwrite/delete existing writers' files in either mode. An externally filled group is operator-managed access, not Migmate grant evidence.

## Mirror authority

`[options] mirror = true` requires a nonnegative safe-integer `deleteLimit` per mapping pass (`0` permits no file deletions). Every manifest mapping must use `destination.create`, otherwise load refuses with row and `field: "destination"`. Keep the mapping ID and creation intent so later passes reuse the durable created drive. A source change needs a newly approved revision; completed passes in the same revision are skipped.

Mirror runs `sync/sync`. On a runtime delete-limit failure, surface the mapping's rclone error from `status.mappingPasses` and the report; other mappings continue. Deletions within the cap are not rolled back. Ordinary retries have a fresh per-pass cap; final settle catch-up passes retain the original cumulative deletion authorization. Successful mirror leaves no destination-only files; verification still reports any leftovers it observes, including outside writes after a pass.

Mirror also requires `status.createdDrives` provenance: an own create response or timestamp-checked name recovery. A legacy record without this evidence fails that mapping before any mirror pass; surface the provenance error rather than treating the manifest's `create` label as ownership. Other mappings continue; copy mode can still retain existing content.
