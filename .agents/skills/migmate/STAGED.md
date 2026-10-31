# Staged migrations and destination access

## One open job

For file migrations, `[options] staged = true` labels ordinary revisions `prestage` until the job completes an execution and `delta` afterwards, so replanning an unapproved, unexecuted or interrupted prestage stays `prestage`; `plan --job ID --final --output json` makes a `final` revision. Keep all passes in the same open job: closing a prestage is terminal, and a replacement job does not inherit mirror authority. Decide staged intent and mirror/limit before initial manifest load. Once a staged revision is approved, the job stays staged: planning with `staged` removed refuses `configuration_invalid` (`field: "options.staged"`). Teams archive does not use this file-only lifecycle.

### Plan scope and proof

Approval always binds roots, drives, members and options on both file routes. Destination encoding notices disclose observed original → encoded paths in plan/report, not a frozen per-file approval inventory or acceptance request. There is no file/deletion preview or inventory-age/freshness gate. Mirror deletion candidates are listed just before execution and the limit is enforced then, not at approval. Present the recorded map and authority without inventing deletion/upload totals. An idle listing does not prove a freeze.

### Final approval and settling

After `plan --final`, hand the human the ordinary `approve --job ID` command with all three freeze flags: `--freeze-by IDENTITY --freeze-at TIMESTAMP --freeze-how TEXT`, or the web approval form. No digest flag is needed in their interactive terminal. The timestamp must include a timezone; the text records how writes were stopped. The human attestation is approval-bound and retained in the report. Record supporting read-only observations separately: attestation does not mean Migmate locked the tenant. Without a recorded or independently verified freeze, claim only observed quiescence and actual verification results. Even with a freeze, omissions and accepted mismatches qualify parity.

Final execution waits the connector consistency interval and compares source and destination file/folder listings. Catch-up passes stay within the approved mapping roots and cumulative deletion limit. Confirmation that nothing remains to copy or delete precedes final verification. `[options] settleMaxPasses` bounds additional passes (default three); `consistencyIntervalMs` controls the wait. Both accept nonnegative safe integers. Read the configured bound, actual passes, observations and outcome in the report. Exhaustion is incomplete cutover, not successful verification; settling is neither a snapshot nor permission to hide later verification changes.

Every verification covers whole mappings, including intermediate deltas. Listing is the default and hash verification is opt-in; this choice changes the content check, not the scope.

## Member grants and close

`[options] memberGrants` defaults to `before_copy` for unstaged jobs and `after_verification` for staged jobs; either can be explicitly overridden. Google destination provisioning requires `about.canCreateDrives`; reading a Google source does not. Deferred execute creates and copies without manifest grants (`status.memberGrants` stays empty); otherwise grants precede copying. Notification emails are suppressed. Read `status.createdDrives` (a null drive ID is an unresolved intent) and `status.memberGrants`; the report retains both. Before go-live, crash recovery uses the same job's durable creation evidence and container IDs.

For a created SharePoint library without manifest members, only the Graph write
credential is required. It inherits site access and is visible to site members
before go-live; plan/report disclose this per library. Migmate does not manage,
fence or prove its membership, and close requires no membership evidence.

Named-member libraries require [optional scoped certificate onboarding](CREDENTIALS.md#optional-sharepoint-library-membership).
They receive unique permissions before copying; named member grants follow the
configured timing and deferred grants remain behind the go-live fence. Observed
permission capabilities are required, not inferred from `Sites.Selected`.
Removing named members never restores inheritance or revokes existing access.
A nonempty initial ACL without independently proven creator identity refuses before
copying or grants as `destination_initial_access_unproven`; an observed implicit
app/system principal is not automatically an authorized baseline.

Initial close is a human go-live decision, not a separate grant verb. Review the pre-close report and settle chosen exceptions, then use the skill's handoff gate. Close binds the reviewed plan, verification, acceptances and configured authority; changed evidence refuses rather than silently authorizing newer evidence. Deferred close requires verification without unaccepted blocking findings and, for staged jobs, the latest final, settled, fully verified revision. It first renders the readiness report, then checks every affected destination before any new fence or grant. Failed/unavailable pre-grant proof is not waivable: repair and reverify under existing approval rules. After all destinations pass, close fences the whole batch before granting members, checks membership (not content again), and produces the final report before closing.

A partial grant, crash or failed post-grant check leaves the fence intact and may leave access. Read `status.closeAuthorization`, `closeReview` and `incompleteClose`; only matching durable authorization permits agent-run `close` recovery without another initial challenge. Recovery preserves passed and acknowledged checks and resumes unfinished grants/checks/reporting. For eligible failures, present `status.goLiveReview` and hand the human `migmate acknowledge --job ID` or the web close view: numbered failure selections in the terminal (checkboxes on the web), shared non-empty rationale and the existing unverified identity confirmation. Observe `goLiveAcknowledgments` against the reviewed evidence/authority and selected checks before retrying close. The guided agent does not submit this decision for the human.

Acknowledgment covers recorded membership differences, unavailable proof (still unverified), or already-live destination drift (original baseline retained; cause unknown). It does not accept future/unselected failures, replace missing checks or bypass incomplete grant recovery. An already-live drive without passed pre-grant proof whose membership check failed never observed content: after that acknowledgment, retry `close` to finish `goLive.destinationCheck` against the original baseline; its failure is a new review. `checksSettled` includes exact acknowledgments; `checksPassed` does not. Closure relying on acknowledgment uses `completed_with_accepted_exceptions`, retaining the evidence in the mandatory final report. Report failure needs a reporting fix, not rechecking settled evidence, repeating acknowledgment or another transfer pass. Once fenced, `cancel` refuses `go_live_started`. [FINDINGS.md](FINDINGS.md) explains the gate codes.

Keep a submitted creation name bound to its mapping ID; use an existing destination ID rather than changing that intent. Google adds the creator as an implicit organizer; membership checks include it unless explicitly listed in the manifest. Deferred pre-close verification does not require manifest grants yet. Removing a manifest member does not revoke access. External access, administrators, existing-drive members and pre-populated group members are outside the deferred-access guarantee. Plan/report disclose the mode and warn that mirror can overwrite/delete existing writers' files in either mode. An externally filled group is operator-managed access, not Migmate grant evidence.

## Mirror authority

`[options] mirror = true` requires a nonnegative safe-integer `deleteLimit` per mapping pass (`0` permits no file deletions). Every manifest mapping must use `destination.create`, otherwise load refuses with row and `field: "destination"`. Keep the mapping ID and creation intent so later passes reuse the durable created drive. A source change needs a newly approved revision; completed passes in the same revision are skipped.

Every revision still needs ordinary approval. Extra confirmation covers enabling mirror, expanding its mapping scope or increasing a mapping's limit, compared with the latest **approved** plan, never a generated or declined one. Access confirmation similarly covers the changed set of new grants and role escalations once. Member email/type/role is declared evidence, not verified internal/external classification; no directory lookup is needed.

Mirror runs `sync/sync`. On a runtime delete-limit failure, surface the mapping's rclone error from `status.mappingPasses` and the report; other mappings continue. Deletions within the cap are not rolled back. Ordinary retries have a fresh per-pass cap; final settle catch-up passes retain the original cumulative deletion authorization. Successful mirror leaves no destination-only files; verification still reports any leftovers it observes, including outside writes after a pass.

Mirror also requires `status.createdDrives` provenance: an own create response or provider-specific proven recovery. Google recovery checks an exact name against the creation-intent timestamp; SharePoint requires the attempted creation's job marker as described below. A legacy record without this evidence fails that mapping before any mirror pass; surface the provenance error rather than treating the manifest's `create` label as ownership. Other mappings continue; copy mode can still retain existing content.

The creation-provenance requirement also applies to SharePoint libraries created with
`destination.create` inside `destination.siteId`; a site's existing library never
inherits mirror authority. Keep both creation name and site fixed after the intent
is submitted. SharePoint constraints inspect native source names and effective
encoded destination paths before each pass and after every consistency wait,
including waits with no apparent changes in flattened listings. OneDrive
encoding changes destination names without changing source names; every affected
path is disclosed as a nonblocking `destination_name_encoded` notice in plan/report.
Duplicate names or encoded collisions, unsupported reserved names/prefixes,
overlong paths after encoding and excessive depth still stop the mapping.
Repair the source and re-check; acceptance and exclusions are unavailable.
See [FINDINGS.md](FINDINGS.md) for the constraint and path-proof rules.
SharePoint records `creationAttemptedAt` before its non-idempotent library POST,
which writes `migmate:creation-request:<requestId>` into the list description.
Recovery needs that durable attempt and a unique qualifying candidate carrying the
exact durable `creationRequestId` marker in the approved site. Name/site/time alone
cannot prove ownership. Foreign or unmarked same-title candidates and HTTP 409
refuse; never adopt them or replay the POST. An attempted creation with no visible
candidate remains `drive_creation_ambiguous` with `creation_outcome_unknown`,
including the crash window between recording the attempt and HTTP. Retry observation;
do not erase the attempt evidence or assume absence. An intent without an attempt
can make its first call but cannot adopt a candidate.
