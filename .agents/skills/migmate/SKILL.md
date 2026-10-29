---
name: migmate
description: Guide Migmate decisions. Use when running a job, reading a refusal or exit status, preparing credentials, or planning a migration or cutover.
---

## Run each phase in rounds

1. Map the **design tree** from durable evidence. Look up facts with tools (or delegate discovery); ask the human only for decisions. A pending lookup leaves its dependent questions outside the **frontier**.
2. Put evidence and context before the **round**. Ask the whole frontier, numbering questions and recommending an answer to each. Keep each question to at most three lines; defer dependent questions until their prerequisites are answered.

   ```text
   ❓ **Q1** - **<decision>**: <short question>

   ➡️ <recommended answer and reason>

   ---

   ❓ **Q2** - **<independent decision>**: <short question>

   ➡️ <recommended answer and reason>
   ```

3. Wait for answers, recompute the frontier, and repeat. Before acting, obtain confirmation of the settled decisions; an empty frontier alone is not consent. Resume interrupted work from `status`, not remembered progress.
4. **Observe** every human action next with a read-only check: tenant configuration, source edits, freeze, external membership or cleanup. Compare actual state with the intended action. If observation cannot prove it, state the limit and leave the affected decision open; a human's “done” is not evidence.
5. At an approval, exception acceptance, initial go-live or recovery-acknowledgment **gate**, present current evidence and hand the human `migmate approve --job ID`, `migmate accept --job ID`, `migmate close --job ID` or `migmate acknowledge --job ID` in their terminal, or the corresponding web view. The surface captures the reviewed digest and offers an editable, unverified identity; no digest transcription, identity read-back or sign-in. **Do not invoke these decisions for the human**, including unattended flags after a conversational “yes.” Observe durable `status` afterward: match `currentApproval.planDigest` to the intended plan, `acceptedExceptions` to verification and selected codes/rationale, `closeAuthorization` to `closeReview.evidenceDigest`, or `goLiveAcknowledgments` to the reviewed failure evidence/authority and selected checks/rationale. An old decision or a human's “done” is insufficient. This is a cooperative workflow, not a security boundary: shell, PTY, browser and writable job-folder access can bypass it.
6. When a command refuses or exits unexpectedly, consult [REFUSALS.md](REFUSALS.md); when evidence contains findings, consult [FINDINGS.md](FINDINGS.md) before proposing decisions.

## 0 — Orient

Read [ROUTES.md](ROUTES.md) for runtime, workspace, command and route boundaries. Inspect `migmate --version`, Node, the resolved store and existing job records; read their `status`. Select the matching phase, including close recovery rather than transfer recovery if go-live has begun. For a new job, confirm intent and initialize it. For a refusal-only question, resolve it through the reference pointer without starting a job.

**Complete when:** durable status (or the absence of a job) identifies the next applicable phase.

## 1 — Scope

Read [CREDENTIALS.md](CREDENTIALS.md) for discovery. Decide route, retained sites/libraries or archive scopes, destination creation versus existing roots, and names. Gather counts and sizes read-only; present every discovered library with a keep/drop recommendation and reasons for system-site exclusions. If discovery lacks prerequisites, perform phase 3's credential work first, then return here before loading a manifest. Review the reverse-route and Teams branches in [ROUTES.md](ROUTES.md) when applicable.

**Complete when:** the human confirms a scope in which every discovered library is keep or drop and every retained scope has a destination decision.

## 2 — Strategy

Read [STAGED.md](STAGED.md) before choosing staging, mirror or access timing; read [ROUTES.md](ROUTES.md) for verification and concurrency, and [FINDINGS.md](FINDINGS.md) for OneNote decisions. Work dependent rounds in order: proof level (`[options] proof = "rclone"` for a map-only plan and listing verification, or the default full inventory); single-shot versus staged; mirror and deletion limit for eligible mappings; access model and grant timing; OneNote shape; verification mode, intermediate verification scope and concurrency. With rclone proof, explain that approval covers the mapping roots only, verification compares paths and sizes without content hashes, and per-file omissions are not listed; skip the OneNote, verification-mode and intermediate-scope rounds, which do not apply. Record applicable choices in the operator TOML before the first manifest load, not by editing the store's job config. For Teams, choose its archive options instead of file-only options.

**Complete when:** the human-confirmed strategy is written in the operator config and no manifest has bypassed that decision.

## 3 — Prerequisites

Use [CREDENTIALS.md](CREDENTIALS.md) to read existing references, client/tenant IDs and route requirements without printing secrets. Ask only unresolved source-grant and delegation decisions. Hand tenant-only work to the human as a `skill://wizard` checklist, then observe it. Onboard with `creds init`; run `doctor`. For file jobs, load the reviewed manifest using [ROUTES.md](ROUTES.md), then rerun `doctor` for mapping-specific access.

**Complete when:** credential onboarding and the applicable mapping/scope preflight pass after all human prerequisite actions have been observed.

## 4 — Prestage (or single-shot copy)

Run `plan`. Present roots, drives, members and roles, grant timing, mirror/limits, copy concurrency, acting account, omissions and proof scope from the recorded plan. Highlight `status.approvalAuthority`: newly enabled/expanded mirror authority or increased limits, and new grants or role escalations, compared with the latest approved plan. The human confirms each changed set once; unchanged limits stay visible but need no repeated high-risk challenge. Present only evidence this proof mode actually collected; map-only plans have no file/deletion preview or inventory-age gate, and no mode supplies a predicted upload allowance. Hand off approval through the gate, observe its durable binding, then run `execute` and `verify`. Explain findings using [FINDINGS.md](FINDINGS.md). Recover interrupted passes through [ROUTES.md](ROUTES.md). Route a single-shot or archive job to phase 7 once verification is ready; keep a staged job open.

**Complete when:** approval is durable, execution exits 0, and verification's findings and proof scope have been presented to the human.

## 5 — Deltas

Ask when to take the next delta and which changes are acceptable. After human source edits, observe the actual paths and contents read-only before planning. For each round, create a new `plan`, review its scope and any expanded authority, hand off its own approval, then observe the matching durable decision before executing and verifying in the same job. Explain partial proof using [STAGED.md](STAGED.md). Repeat until the human chooses the cutover window.

**Complete when:** every attempted delta has approved execution and verification evidence, and the human confirms readiness to freeze.

## 6 — Freeze + cutover

Ask who freezes, when, how writes are prevented and how users are told. Observe the source lock read-only where possible; record observation separately from the human attestation. Follow [STAGED.md](STAGED.md) for `plan --final`, final approval flags, freshness and bounded settling. Review full final verification and the pre-close `report`; explain and resolve each blocking code through [FINDINGS.md](FINDINGS.md), using the acceptance gate for chosen exceptions. Qualify parity claims with the observed proof and exceptions.

**Complete when:** the latest final revision has a recorded freeze attestation, settled full verification and no unaccepted blocking findings in its reviewed report.

## 7 — Go-live

For single-shot/archive jobs, first review `report` and resolve findings through the same acceptance gate. Present `status.closeReview` and hand initial `close` to the human; use [STAGED.md](STAGED.md) for access consequences, evidence binding and recovery. A conversational authorization is not permission for the agent to submit it. Observe durable authorization and closure afterward. The agent may retry `close --job ID --output json` only when `closeAuthorization.evidenceDigest` matches `closeReview.evidenceDigest` and `closeReview.authorized` is true; inspect `incompleteClose` for unfinished work. For failed post-grant checks, use STAGED's separate acknowledgment handoff and observe the durable decision. Pre-grant failure remains unwaivable. If access uses an externally managed group, let the human enable it after required verification/report acceptance, then observe membership. Disclose partial access and preserve passed/acknowledged evidence on recovery.

**Complete when:** authorized close succeeds with its mandatory final report; go-live checks passed or their exact failures were explicitly acknowledged and retained as exceptions (or local-only archive access is inapplicable). Disclose `completed_with_accepted_exceptions`; do not call failed/unverified checks passed.

## 8 — Close + cleanup

Read durable closed status and the final report, including exceptions, grant timestamps and open items. Hand over applicable cleanup: service-account key deletion, delegation entry removal, secret rotation, narrowing tenant-wide source grants and disposal of temporary drives. Observe completed human cleanup read-only; distinguish confirmed removal from still-open administrator work in the handover.

**Complete when:** the job is durably closed and the final report plus an owner-assigned cleanup list has been handed over.
