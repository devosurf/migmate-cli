# Refusals and exits

The governing idea: Migmate is built to **refuse**. A refusal is a decision the engine has already made on evidence, not a transient error, so the work is to read it and report it — never to route around it.

Match the exit status first, then the code.

| Exit | Meaning                                          | What to do                                                           |
| ---- | ------------------------------------------------ | -------------------------------------------------------------------- |
| 0    | Success                                          | Inspect the result; success is not a claim of exception-free parity. |
| 1    | Internal defect, or a code this build cannot map | Report it as a defect; a retry proves nothing.                       |
| 2    | Usage or configuration                           | Fix the invocation or the config file.                               |
| 3    | Lease or recovery refusal                        | Inspect owner/host and recovery evidence before taking action.       |
| 4    | Preflight, approval, route, or verification gate | Evidence or authority is missing. Report it.                         |
| 5    | Retry budget exhausted, blocked at a checkpoint  | Execution stopped mid-flight; report the checkpoint.                 |
| 6, 7 | Already closed, already cancelled                | The job is terminal. Start a new one.                                |
| 8    | Durable state written by a newer build           | Stop: this build cannot read that job.                               |

Exit 5 also covers a _successful_ `execute` whose outcome is `blocked`, so a checkpoint report is the finishing move either way. Statuses `130` (SIGINT), `141` (broken stdout) and `143` (SIGTERM) are process outcomes; inspect any accompanying result. An interrupted `plan` returns `retry_budget_exhausted` with `detail.interrupted: true`, releases its lease, and needs a fresh `plan`, not `reclaim` or `execute`. An interrupted `execute` remains resumable from its durable checkpoint.

A detached launch's exit 0 acknowledges execute admission, not completion; follow its private log and status. Stop/cancel requester success means acknowledgement and lease release. The foreground owner instead exits 130 after stop or 7 after admitted cancellation. A requester interrupted with Ctrl-C leaves its delivered request pending. A stale heartbeat while waiting returns the recovery refusal (3), not a claim that stopping finished. See [ROUTES.md](ROUTES.md) for detached host-lifetime limits and resumable stop.

Codes worth recognising:

- **`plan_revision_required`** — plan and approve again when approved inputs change. For file migrations, a missing or changed destination root and new members in an excluded source subtree still require replanning; unrelated destination additions or removals do not. Same-path file content is governed by rclone copy comparison, not an ownership collision gate.
- **`unsupported_route`** — file jobs support `sharepoint` → `google_shared_drive`, the reverse pair, and `dropbox` → `google_shared_drive`. Dropbox destinations, Dropbox → SharePoint, same-provider copies, personal storage and unsupported root shapes/clouds refuse. Read [ROUTES.md](ROUTES.md)'s provider-pair and destination boundaries. Report this and stop: the fix is a config change or new code, never a retry.
- **`preflight_failed`** — every credential and tenant fault arrives under this one code, with the specific check in `refusal.detail`. `detail.check: credential_permissions_invalid` means the credential's roles do not match the route's allowlist, which is exclusive: one extra role refuses the whole credential, which is why each route needs its own app registration. Read `detail` before reporting, because the top-level code alone says only "preflight".
- **Dropbox credential proof** — a write scope or missing initial-exchange scope proof refuses `credential_permissions_invalid`; arbitrary imported tokens are not read-only evidence. `shared_folders` refuses `credential_backend_unsupported` even when set to `false`: remove the setting, since this route addresses namespace IDs and never mounts source folders.
- **`lease_held` / `lease_stale_worker_alive`** — a writer owns the job. Read with `--review`. A crashed writer's same-host lease is taken over automatically by the next writer once its heartbeat is 30 seconds stale and its process and worker are gone; recovery stays in the job's event history. Use `reclaim --job ID --confirm --stop-worker` to stop a recorded orphan worker once its owner is gone. Explicit `reclaim --confirm` also remains available without opening a writer; removing files by hand corrupts the job.
- **`verification_unaccepted`** — review current verification groups or go-live evidence. Known legacy Paper, unsupported exports and destination path limits are blocking per-file findings; `source_legacy_paper_scope_unverified` separately blocks Dropbox jobs because legacy documents cannot be attributed to namespace roots. Review [FINDINGS.md](FINDINGS.md) before accepting any content loss or unverified scope. Paper-to-HTML and `.web` pointer disclosures are nonblocking policy outcomes. Pre-grant drift/unavailable proof blocks the whole batch and cannot be waived; repair and reverify. After grants, hand eligible failures to the human through STAGED's acknowledgment workflow or retry checks with `close`; failed/unavailable results stay disclosed.
- **`cutover_incomplete` / `delete_limit_exceeded` / `drive_creation_ambiguous`** — use [FINDINGS.md](FINDINGS.md)'s gate decisions; these are also exit-4 refusal codes.
- **`approval_required` / `approval_digest_stale`** — hand off a fresh review of the current evidence; never substitute a newer digest under an old answer. Initial close also requires a recorded decision. Recover without another handoff only when durable `closeAuthorization` matches the current `closeReview`.
- **`go_live_started`** — the durable fence prevents transfers and terminal cancellation. Inspect `incompleteClose` and matching authorization, finish grants/checks/reporting, then resume `close`. Passed and exactly acknowledged checks are preserved; the final report cannot be bypassed.
- **`configuration_invalid` / `usage`** — fix the named field or invocation; manifest row diagnostics are in [ROUTES.md](ROUTES.md). In a new file config, explicit `route` is removed: replace it with top-level `sourceProvider = "sharepoint"` and `destinationProvider = "google_shared_drive"` (swap values for reverse jobs), as shown in ROUTES' **File provider pairs**. Keep historical persisted route values untouched; status and reports remain readable. Teams keeps `route = "teams_global_archive"`.
- **Old inventory-planned file job** — mutation refuses under the map-only cutover. Read historical status, evidence and reports, then create a new job; do not rewrite its frozen plan or remove old evidence to bypass the refusal. Removed configuration options must be removed from a new operator config rather than interpreted as new defaults.
- **`job_not_found`** — inspect the resolved home and job identifier.
- **`local_filesystem_required`** — move the durable store to a supported local filesystem before execution.
- **`foreign_host`** — inspect the lease's host; do not treat another host's worker as a dead local process.
- **`retry_budget_exhausted`** — inspect the blocked checkpoint and pass errors before deciding recovery.
- **`job_closed` / `job_cancelled`** — terminal state; further migration requires a new job.
- **`state_version_unsupported`** — use a build that understands the store; do not rewrite its version.
- **`web_runtime_unavailable`** — the optional web surface is unavailable; use CLI evidence or fix that runtime.
- **`internal_defect`** — retain the evidence and report the defect.

`npm run test:live` is an optional maintainer surface, never part of a job. It refuses with `live_test_failed` and names the block in `refusal.detail.gate`: `live_configuration_required` (operator prerequisites absent), `node_runtime_unsupported`, `file_credentials_required`, `credential_file_protection_required` (a reference file carrying group or other permission bits, or not owned by the invoking user), `operator_interrupted`, `live_probe_claims_unproven`, and one generated gate per live probe. Read `detail.gate`; none of these ever reaches a `migmate` envelope.
