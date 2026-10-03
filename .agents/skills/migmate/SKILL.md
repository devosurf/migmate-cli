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
5. At an approval or acceptance **gate**, read the current plan or verification evidence and its digest. Confirm the approver identity once per job before first use, retain that explicit confirmation, and read that identity back at every gate. A changed identity needs fresh confirmation. Present the digest alone on its own line, with no label, punctuation or prompt appended. Ask the human to read it back; compare it exactly with the evidence digest before invoking `approve` or `accept`. On mismatch, display the expected and received values separately and ask again. Use only the matched digest and confirmed identity.
6. When a command refuses or exits unexpectedly, consult [REFUSALS.md](REFUSALS.md); when evidence contains findings, consult [FINDINGS.md](FINDINGS.md) before proposing decisions.

## 0 — Orient

Read [ROUTES.md](ROUTES.md) for runtime, workspace, command and route boundaries. Inspect `migmate --version`, Node, the resolved store and existing job records; read their `status`. Select the matching phase, including close recovery rather than transfer recovery if go-live has begun. For a new job, confirm intent and initialize it. For a refusal-only question, resolve it through the reference pointer without starting a job.

**Complete when:** durable status (or the absence of a job) identifies the next applicable phase.

## 1 — Scope

Read [CREDENTIALS.md](CREDENTIALS.md) for discovery. Decide route, retained sites/libraries or archive scopes, destination creation versus existing roots, and names. Gather counts and sizes read-only; present every discovered library with a keep/drop recommendation and reasons for system-site exclusions. If discovery lacks prerequisites, perform phase 3's credential work first, then return here before loading a manifest. Review the reverse-route and Teams branches in [ROUTES.md](ROUTES.md) when applicable.

**Complete when:** the human confirms a scope in which every discovered library is keep or drop and every retained scope has a destination decision.

## 2 — Strategy

Read [STAGED.md](STAGED.md) before choosing staging, mirror or access timing; read [ROUTES.md](ROUTES.md) for verification and concurrency, and [FINDINGS.md](FINDINGS.md) for OneNote decisions. Work dependent rounds in order: single-shot versus staged; mirror and deletion limit for eligible mappings; access model and grant timing; OneNote shape; verification mode, intermediate verification scope and concurrency. Record applicable choices in the operator TOML before the first manifest load, not by editing the store's job config. For Teams, choose its archive options instead of file-only options.

**Complete when:** the human-confirmed strategy is written in the operator config and no manifest has bypassed that decision.

## 3 — Prerequisites

Use [CREDENTIALS.md](CREDENTIALS.md) to read existing references, client/tenant IDs and route requirements without printing secrets. Ask only unresolved source-grant and delegation decisions. Hand tenant-only work to the human as a `skill://wizard` checklist, then observe it. Onboard with `creds init`; run `doctor`. For file jobs, load the reviewed manifest using [ROUTES.md](ROUTES.md), then rerun `doctor` for mapping-specific access.

**Complete when:** credential onboarding and the applicable mapping/scope preflight pass after all human prerequisite actions have been observed.

## 4 — Prestage (or single-shot copy)

Run `plan`. Read back drives, members and roles, grant timing, mirror/limit, copy concurrency, acting account, omissions, verification mode, inventory timestamp and age, predicted changes/bytes and every deletion. Apply the approval gate, then `approve --job ID --approver IDENTITY --plan-digest DIGEST --output json`. Run `execute`, then `verify`; explain findings using [FINDINGS.md](FINDINGS.md). Recover interrupted passes through [ROUTES.md](ROUTES.md). Route a single-shot or archive job to phase 7 once verification is ready; keep a staged job open.

**Complete when:** approval is durable, execution exits 0, and verification's findings and proof scope have been presented to the human.

## 5 — Deltas

Ask when to take the next delta and which changes are acceptable. After human source edits, observe the actual paths and contents read-only before planning. For each round, create a new `plan`, review the inventory age and complete delta/deletion preview, apply the approval gate, execute and verify in the same job. Explain partial proof using [STAGED.md](STAGED.md). Repeat until the human chooses the cutover window.

**Complete when:** every attempted delta has approved execution and verification evidence, and the human confirms readiness to freeze.

## 6 — Freeze + cutover

Ask who freezes, when, how writes are prevented and how users are told. Observe the source lock read-only where possible; record observation separately from the human attestation. Follow [STAGED.md](STAGED.md) for `plan --final`, final approval flags, freshness and bounded settling. Review full final verification and the pre-close `report`; explain and resolve each blocking code through [FINDINGS.md](FINDINGS.md), using the acceptance gate for chosen exceptions. Qualify parity claims with the observed proof and exceptions.

**Complete when:** the latest final revision has a recorded freeze attestation, settled full verification and no unaccepted blocking findings in its reviewed report.

## 7 — Go-live

For single-shot/archive jobs, first review `report` and resolve findings through the same acceptance gate. Ask explicitly whether to authorize `close` now; use [STAGED.md](STAGED.md) for the access consequences and recovery fence. Only after that authorization run `close --job ID --output json`. If the access model is an externally managed group, let the human enable it only after required verification and report acceptance, then observe membership. Check grant evidence, effective membership and destination drift; disclose any partial access after failure and resolve it before retrying close.

**Complete when:** authorized close succeeds and the selected access model's membership/drift checks confirm go-live (or local-only archive access is explicitly inapplicable).

## 8 — Close + cleanup

Read durable closed status and the final report, including exceptions, grant timestamps and open items. Hand over applicable cleanup: service-account key deletion, delegation entry removal, secret rotation, narrowing tenant-wide source grants and disposal of temporary drives. Observe completed human cleanup read-only; distinguish confirmed removal from still-open administrator work in the handover.

**Complete when:** the job is durably closed and the final report plus an owner-assigned cleanup list has been handed over.
