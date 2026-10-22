# ADR-0016: Human handoff without digest transcription

- Status: accepted
- Date: 2026-10-20
- Accepted: Morgan, in the decision session for [#83](https://github.com/devosurf/migmate-cli/issues/83), including the explicit narrowing from an agent-proof channel to a cooperative-agent workflow.
- Amends: [ADR-0012](0012-staged-migrations-and-access-timing.md), for guided approval, exception acceptance and initial go-live authorization.
- Preserves: [ADR-0014](0014-map-approval-and-listing-verification.md), for map-only file plans, and [ADR-0015](0015-close-report-readiness-and-resume.md), for close ordering and recovery.

Humans review the proposed authority or verification exceptions and act in their own terminal or web view, without transcribing a digest or reading back an identity. The guided agent presents the evidence, hands over the decision and observes the durable result. We choose this lower-friction workflow for a cooperative agent, not an enforceable boundary against an agent that can bypass it. This records an accepted decision, not shipped behavior; CLI, web, engine and installed-skill changes belong to implementation of #83.

## Assurance and automation

Approval remains a **recorded local attestation**. The interaction mode is evidence of how a command was submitted, not proof that a human submitted it. A terminal, simulated PTY, local web action or declared identity is not an authentication mechanism. An agent with shell, browser and writable job-folder access can bypass this workflow; preventing that is explicitly outside this decision. Neither local digest binding nor a local audit record claims protection from arbitrary modification by that operator.

The guided agent must not invoke `approve`, `accept` or the initial go-live `close` on the human's behalf, including by supplying unattended flags after a conversational “yes.” It gives the human the job-specific terminal command or web handoff, without asking them to copy a digest. Afterward it reads durable status/evidence and checks the recorded decision against the intended job and current plan or verification. A human's “done” or an old approval alone is insufficient to continue.

Genuine unattended automation remains supported. It supplies explicit evidence identifiers and a declared identity rather than relying on interactive defaults, and its records are labelled unattended. It is not separately authenticated or authorized under a protected policy, and must never be presented as human authorization. Interactive and unattended actions have the same digest, named-code and closure gates; noninteractive output never silently consents or prompts. Automated acceptance also requires a rationale.

No external approval service, signed authorization, Entra/Google sign-in, device-code application or new approval token storage is introduced. The original #83 requirements for an agent-proof channel and authenticated approver are deliberately removed from this scope, not satisfied by the handoff. An enforceable approval authority or protected execution boundary would require a separate decision. Existing transfer credentials and permissions are unchanged.

## Declared approver identity

Each interactive confirmation displays an editable **unverified declared identity**. Initially suggest the current `user@host`; afterward suggest the job's last interactively declared identity. The ordinary affirmative confirmation records the displayed identity: there is no separate identity read-back or sign-in. A changed identity is visible in the new confirmation and retained in that action's record.

Unattended actions must supply their own identity and do not replace the interactive suggestion. Record the declaration, interaction mode, timestamp and relevant evidence binding without implying verified identity provenance. The acting Google account used for transfer attribution in #78 is not the approver.

## Review and risk confirmations

Every new plan revision requires its own review and digest-bound approval, even when the authority is unchanged. The human-facing surface captures the exact digest it displayed and submits that value; it must not fetch and silently approve a newer plan when the human answers. The engine rechecks the binding before recording approval. Digests remain available for audit, never as a human transcription challenge.

The normal confirmation requires an explicit affirmative action, with no affirmative default. Add a stronger, specific confirmation when:

- **Mirror authority expands:** mirror is enabled, its approved mapping scope expands, or a mapping's `deleteLimit` increases. Review the affected mappings and their limits together; confirm the changed deletion authority, not an unknown number of future deletions.
- **Access expands:** any new member grant or role escalation is proposed. Show the changed identities, user/group types, roles and grant timing, then confirm the changed set once, not one member at a time. Current member evidence has no verified internal/external classification; apply this rule to all new grants and escalations without adding directory permissions or lookups.
- **Go-live is first authorized:** confirm the access consequences at `close`, after the pre-close report and exceptions have been reviewed. Plan approval or a completed copy is not go-live authorization.

Compare proposed authority with the job's latest approved plan, not a merely generated or declined revision. Without an approved baseline, mirror authority and member grants are new. Unchanged mirror authority and approved access stay prominent in the review but do not require repeatedly typing the same limit or reconfirming the same changed set. This reduces ceremony, not the risk of the next pass: file deletions remain unknown until execution. A previous risk confirmation never substitutes for approval of a new plan digest.

These are fixed workflow triggers, not configurable “small delta” thresholds. No additional planning scan, file/deletion preview, inventory-age gate, predicted-upload total or quota-allowance refusal is introduced. Under ADR-0014, approval covers roots, drives, members and options; mirror limits are enforced at pass time. A meaningful numeric confirmation may concern a reviewed authority such as `deleteLimit`, never an invented deletion or upload count.

The dated account-activity snapshot decided in [#78](https://github.com/devosurf/migmate-cli/issues/78#issuecomment-6290730729) is informational, not a confirmation threshold. Later activity or expiry of observations does not rewrite the plan snapshot, change its digest or invalidate approval. Unknown coverage is not zero usage or a known remaining allowance.

Declining, cancelling, interrupting or failing a confirmation records no new approval, acceptance or go-live authorization. An unattended action must not claim that interactive risk questions were answered.

## Named exception acceptance

Present verification findings grouped by code, with consequences, affected-item counts and representative examples. The human explicitly selects the groups to accept and supplies one non-empty rationale for the selection; retain that rationale with every selected code. Separate essays per code are not required.

Confirm the number of selected **groups**, showing their per-group affected-item counts separately. Groups can overlap, so do not turn their sum into a claimed count of distinct affected items. No blanket accept-all, hidden selections or successful-verification relabelling is introduced. Selected codes, notes and their consequences remain visible in durable evidence and reports.

As with approval, capture the reviewed verification digest automatically and recheck it at submission. Changed verification or a superseding plan refuses without writing a stale acceptance. Reverification does not inherit earlier acceptances; all current engine restrictions on which codes can be accepted remain in force.

## Go-live recovery and existing decisions

The human initiates the first go-live `close`. Record the decision against the reviewed job evidence; do not grant access after the evidence changes while confirmation is pending. Existing closure gates still apply. In accordance with ADR-0015, report readiness precedes the first fence or grant, and retry preserves passed go-live checks and resumes unfinished work.

An unchanged, already-authorized close recovery is not a new go-live decision and must not repeatedly demand the initial high-risk challenge. Before resuming, the guided agent must establish the existing authorization and recovery state from durable evidence, not conversation memory. Recovery cannot authorize changed scope or access, reopen transfers after go-live begins, skip failed checks or close without the required final report. A failed initial attempt with no recorded authorization is not authority to resume unattended.

ADR-0012's digest and identity read-back ceremony is replaced by this handoff. Its human-owned decisions, freeze attestation, read-only observation, pre-close review, and distinction between copying and go-live remain. ADR-0014 already supersedes its inventory-age and deletion-preview readbacks. This decision preserves the product session's local-attestation assurance model rather than extending it to authenticated identity.

## Implementation acceptance

- CLI and web support the same digest-free human review and confirmation workflow for approval and named exception acceptance; the initial go-live action uses the human handoff.
- CLI, web and engine preserve stale-evidence refusals, blockers, mirror limits and closure gates. A cancelled or failed confirmation creates no new authority.
- Durable records distinguish interactive from unattended local attestations and disclose that declared identities are unverified. Interactive identity suggestions do not inherit unattended declarations.
- Risk confirmations cover newly enabled/expanded mirror authority, increased limits, new grants, role escalation and first go-live. Unchanged authority still gets ordinary plan approval, not repeated high-risk transcription. No confirmation depends on unavailable file or upload counts.
- Acceptance retains explicitly selected codes and a required non-empty rationale, with counts/examples in the review and exceptions visible afterward. Replanning and reverification do not carry stale authority forward.
- Close confirmation is tied to the reviewed evidence; unchanged authorized recovery preserves ADR-0015 behavior without another initial-go-live challenge.
- Local fake-provider/adapter coverage proves these behavior boundaries, including stale submissions, cancellation, identity reuse, unattended labelling, changed versus unchanged authority, and close recovery. No identity-provider qualification or agent-proof claim is part of this work.
- Update README, release limits and the migmate skill with the implementation. The skill must hand off the gates and observe their durable results rather than call approval/acceptance with digests copied from a human response.

## Evidence and trade-off

An isolated smoke run through the real CLI and engine with the existing fake provider approved a job using an arbitrary declared identity and the current digest. It recorded `mode: unattended`, retained the digest binding and reached durable `approved` state. No tenant calls were made. Code inspection also showed that the web view calls the same in-process writer, and that member declarations contain email, type and role rather than verified externality.

The rejected stronger design would place approval authority outside agent-controlled shell/browser/state access. That could protect approval evidence, but adds deployment and authentication concerns and still cannot prevent arbitrary cloud writes by an operator holding transfer credentials without a protected execution boundary. For the described migration workflow, Morgan chose explicit handoff and honest assurance over that additional system. This docs-only decision does not claim that the new interactions or their regression coverage have shipped.
