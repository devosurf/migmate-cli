# ADR-0015: Close proves report readiness before go-live and resumes at the first unfinished step

- Status: accepted
- Date: 2026-10-14
- Accepted: Morgan, 2026-10-14, in the decision session for [#90](https://github.com/devosurf/migmate-cli/issues/90).
- Amends: [ADR-0012](0012-staged-migrations-and-access-timing.md) A6 (deferred grants at close): what close checks before the first fence, what a retry repeats, and how a job ends once go-live starts.

A `close` with deferred grants now renders and publishes the report before it fences or grants anything, so a report that cannot be produced stops close while nobody has access. A retry keeps every go-live check that already passed and resumes at the first unfinished step. Once go-live starts, only `close` with its final report ends the job. The order grants → checks → final report → closed is unchanged: the final report still carries the actual grant and check evidence.

We decided this after the Essense → Eidra heavy job (3 created drives, ~245k files). On 0.3.3 its `close` granted every member as organizer, then failed while generating the report, leaving a live go-live on a job that stayed `verified`. 0.3.5 bounded report memory and added `status.incompleteClose` (#81), but its recovery, fixing the report and retrying `close`, ran every go-live check again. By then members with access had been editing files and adding people, so the repeated checks would refuse `close` on every attempt.

## Decisions

### D1: Readiness render before the first fence

This applies whenever close publishes a final report, which means jobs with `memberGrants = "after_verification"`. File jobs with `before_copy` grants and Teams archive jobs still close without a report.

- **When:** after the closure gates pass and before the first go-live fence, close renders and publishes the report of the verified job, exactly as `report` does.
- **On failure:** close refuses. No drive is fenced, no member is granted, and the job state is unchanged.
- **Publication:** this is the ordinary content-addressed artifact set. If the evidence is unchanged since the operator's pre-close `report`, it publishes to the same directory.
- **Go-live section:** for a job whose close grants members, the report always includes it. Before go-live it states that go-live has not started and that Migmate has granted no member access. A pre-close report is therefore never evidence of go-live.
- **The operator's review stays.** ADR-0012 still requires reviewing the pre-close report and settling its findings before authorizing close. The readiness render proves the report can be produced, not that its findings are acceptable.

**What it cannot guarantee.** The render runs against the evidence, configuration, storage and report registration as they are at that moment. It does not cover the grant and check evidence written afterwards, storage or permission changes between the two renders, or a configuration edited in between. The final report can still fail; D2 and D3 cover recovery. The cost is a second report render on every close with deferred grants.

### D2: A retry resumes at the first unfinished step

Retrying `close` keeps the recorded fences and grants, as before. It also skips every drive whose go-live check passed under its current fence: only failed or missing checks run. When every check has passed, the retry goes straight to the final report and closes. A passed check is never overwritten.

A passed check records go-live at its own timestamp. Once members have access, they legitimately change content and membership; checking again would measure their work, not the go-live, and would refuse `close` indefinitely with `destination_drift` or `drive_membership_mismatch`. `status.incompleteClose.nextAction` stays `"close"`, which is now accurate.

### D3: Only close ends a job once go-live starts

Once any created drive has a go-live fence, the job ends only through `close` with its final report:

- `cancel` refuses with `go_live_started`.
- No exception, acceptance or flag closes a job without its final report.
- A job whose final report can never be produced stays `verified`, with `status.incompleteClose`. `report` remains runnable on it.
- Migmate still never revokes access.

`cancelled` would claim that nothing went live while members have access, and it drops the final report. Until now `cancel` was allowed from `verified` with fenced drives and left a terminal job whose `status.incompleteClose.nextAction` said `"close"`. With D2 a retry converges once reporting works, so report failures leave nothing to bypass.

## Considered options

- **Readiness by procedure only:** the operator runs `report` before `close`, which ADR-0012 already asks for. That depends on the operator, and nothing stops a close whose report cannot be produced.
- **Close requires an existing report for the current verification:** this avoids the second render, but it needs a staleness rule and leaves a time gap between that report and close.
- **Render between the fence and the grants:** the fence is permanent, so a failure there would leave a drive nobody can reach and no pass can repair.
- **Close with the missing report recorded as an exception and regenerated later (#81's open question):** rejected by D3. It would need its own authorization, evidence and terminal-state meaning.
- **`cancel` as a sanctioned abandonment after go-live,** for example a `cancelled_after_go_live` outcome: rejected by D3 for the same reasons.

## Not decided here

Recovery from a go-live check that fails after the grants, and whether the destination drift check should run before the first grant: [#95](https://github.com/devosurf/migmate-cli/issues/95).

## Consequences

- **Engine:**
  - `JobWriter.close` renders and publishes the report before `goLive`.
  - `goLive` skips drives whose check passed. The transfer worker starts only when a check has to run.
  - `JobWriter.cancel` refuses `go_live_started` once any created drive is fenced.
  - The file driver's Go-live report section is present for every job whose close grants members.
- **Fake-provider coverage:**
  - An injected readiness failure fences and grants nothing.
  - After a post-grant report failure, members change the content and the membership, and the retry still closes, keeping the original passed checks.
  - `cancel` after the fence refuses.
  - The final report contains the actual grants and checks.
- **Docs:** README, `docs/release-limits.md` and the migmate skill (STAGED, REFUSALS) say that close renders the report before granting, that a retry resumes at the report, and that `cancel` refuses once go-live has started.
