# ADR-0017: Check destination drift before grants and allow acknowledged post-grant failures

- Status: accepted
- Date: 2026-10-27
- Accepted: Morgan, after the focused grilling and explicit confirmation of the complete policy for [#95](https://github.com/devosurf/migmate-cli/issues/95).
- Amends: [ADR-0012](0012-staged-migrations-and-access-timing.md) A6, for check ordering and the post-grant hard-stop rule; [ADR-0015](0015-close-report-readiness-and-resume.md), for pre-grant drift checks and recovery from acknowledged checks; [ADR-0016](0016-human-handoff-without-digest-transcription.md), for a separately acknowledged post-grant failure, without changing its human-handoff or local-attestation model.

For a fresh deferred go-live, every affected destination must pass its drift check before the first permanent fence or member grant. After access is live, an explicit acknowledgment may permit closure with a failed or unavailable check, retaining that result as an exception rather than relabelling it as passed. Keeping a job open does not revoke already-live access; the useful recovery boundary is a deliberate decision about the unresolved evidence, followed by the required final report.

This records an accepted decision, not shipped behavior. This change does not implement or authorize implementation of the policy. The existing command syntax, runtime behavior and operator instructions remain unchanged until implementation is separately authorized.

## Decisions

### D1: Check the whole destination batch before the first fence

For a fresh go-live with `memberGrants = "after_verification"`, retain report readiness and require every affected Migmate-created drive to pass the destination-drift check before any drive is permanently fenced or any member grant is requested. Compare against the current verification baseline using the existing check's proof scope. Move this content check; do not repeat it after grants, when intended users can legitimately edit content. Membership validation remains after grants.

A failed or unavailable pre-grant check stops the whole batch without new fences or grants. Repair and reverification remain available under the existing planning, approval and execution rules. Post-grant acknowledgment is not a way to waive this pre-grant requirement.

The close lease excludes this job's transfers, not external writers. A passed listing comparison is a point-in-time observation, not a destination lock, effective-group-membership proof or future-write guarantee. This decision does not claim that administrators or previously granted external members lacked access.

### D2: Offer retry or explicit acknowledgment after grants

A failed post-grant check offers recovery by retry or by explicit acknowledgment of the reviewed failure evidence. There is no automatic acceptance, required retry count or waiting period before acknowledgment. The following conditions are eligible:

- **`drive_membership_mismatch`:** observed missing members, extra members or different roles. Show expected versus observed membership. Acknowledgment accepts the specific difference, including lack of intended access or additional access; it does not make membership match the approved plan.
- **`go_live_check_unavailable`:** the check could not obtain evidence. Disclose the unverified condition rather than treating unknown membership or content as a successful check. Acknowledgment permits ending the job without that proof; it does not establish that access or content is correct.
- **`destination_drift` in already-live jobs:** retain the original verification baseline and recorded drift evidence. Acknowledgment does not establish whether the difference is legitimate user activity or migration damage, does not reset the baseline to manufacture a pass, and does not pretend that a pre-grant check happened.

These are post-grant recovery decisions, not new permissions to bypass pre-go-live verification or lifecycle gates. Every required post-grant check must either pass or have its recorded failure explicitly acknowledged. A missing check remains unfinished work; acknowledging one check does not acknowledge unreviewed failures elsewhere.

Incomplete or ambiguous grant requests still require grant recovery. Acknowledgment does not authorize abandoning approved grants, changing their scope, or silently correcting already-observed permission differences.

### D3: One evidence-bound review, using the existing handoff model

Present selected failures together with their consequences and a shared, non-empty rationale, rather than requiring a separate confirmation for each member or drive. Capture the exact reviewed evidence automatically and reject a stale submission if that recorded evidence or its authority has changed. There is no blanket acceptance of future failures.

Retain the selected check evidence, rationale, declared identity, interaction mode and timestamp. The underlying failed or unavailable result remains intact. The original go-live authorization does not authorize acceptance of a later failure.

Use ADR-0016's existing assurance model: the guided agent presents evidence and hands the decision to the human's terminal or web view, then observes the durable result. It does not submit the acknowledgment on the human's behalf. Genuine unattended automation remains explicitly labelled unattended, with the same evidence binding and rationale requirements; neither mode implies authenticated identity. No new sign-in, identity read-back or digest transcription is introduced.

### D4: Preserve passed and acknowledged checks on retry

A retry of `close` preserves passed checks under the existing go-live fence and also preserves acknowledged failed or unavailable checks with their reviewed evidence. Resume unfinished work instead of rerunning a settled check or demanding the same acknowledgment again.

In particular, a final-report failure must not restart checking against users' later content or membership changes. Acknowledgment is scoped to the reviewed check evidence; it does not cover a different drive's unreviewed failure, a newly recorded failure or changed authority. Preserving a decision is not a claim that the destination has remained unchanged since its recorded observation.

### D5: Close with a truthful final report

The final report remains mandatory. Include the timestamped grant and check evidence and each acknowledgment's selected evidence, rationale and declared decision record. An acknowledged failure remains failed; an unavailable check remains unverified. Neither is counted as a passed check.

If closure relies on a go-live acknowledgment, use the existing `completed_with_accepted_exceptions` outcome rather than `completed`, even when verification itself had no accepted exceptions. The job is durably `closed`, but its closure does not claim that every go-live check passed. Existing verification exceptions remain visible as before.

If the final report cannot be produced, the job remains incomplete. Acknowledgment is not permission to omit the report or publish it later after closure.

### D6: Preserve the safety boundaries and existing jobs

- The permanent fence still precedes the first grant request and never reopens a transfer window after go-live starts.
- `cancel` remains refused after go-live starts. Only `close` with its final report ends the job.
- Migmate does not automatically revoke access. This decision adds no automatic content or permission repair.
- Existing passed go-live checks remain passed. Already-live jobs use their actual recorded evidence; they do not need fabricated pre-grant observations or a replacement verification baseline.
- ADR-0016's human-handoff design is not reopened. A recovery acknowledgment is a new decision about a failure, not a repetition of the initial go-live challenge.
- This scope is deferred-go-live recovery. It does not add go-live acknowledgment requirements to `before_copy` jobs or Teams archive jobs.

## Considered alternatives

- **Require every observed discrepancy to be repaired:** rejected after grants because users can legitimately edit content and membership, and forcing those changes to be undone can be harmful. Before new grants, the destination-drift check remains a hard stop.
- **Allow observed differences but keep unavailable checks permanently blocking:** initially recommended during the grilling, then rejected. Once access is live, indefinitely retaining an open job does not remove exposure. Explicit acknowledgment and a report that discloses missing proof preserve the distinction without imposing a forced retry loop.
- **Treat acknowledgment as a passed check:** rejected because accepting risk is not evidence that the original condition held.
- **Recheck or reconfirm acknowledged failures after a report-only failure:** rejected because it recreates the moving-target recovery problem and adds no new authority.

## Implementation consequences

Implementation must separate pre-grant destination proof from post-grant membership evidence, persist acknowledgment independently of check success, and carry accepted go-live exceptions through status, closure outcomes and reports. The CLI and web must use the same evidence-bound recovery decision without new identity ceremony. Operational documentation must change with the implementation, not advertise this decision as already shipped.

Required behavioral coverage includes a multi-drive pre-grant failure with no new fences or grants; repair before go-live; post-grant membership differences and unavailable checks; already-live destination drift; stale or unselected acknowledgment refusal; unfinished grant and check work; and a report failure followed by retry that retains passed and acknowledged evidence. These scenarios were not run in this decision-only change.
