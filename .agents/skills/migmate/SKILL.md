---
name: migmate
description: Drive a Migmate job from the CLI. Use when running a file-migration or Teams-archive job, reading a Migmate refusal code or exit status, or preparing a route's credentials.
---

Migmate moves or preserves organizational content once, in one direction, leaving durable evidence. `CONTEXT.md` defines every term used here; `migmate --help` is the authority on flags and exit codes. This skill is the operating procedure the two of them do not carry.

The governing idea: Migmate is built to **refuse**. A refusal is a decision the engine has already made on evidence, not a transient error, so the work is to read it and report it — never to route around it.

## Always

- Pass `--output json`. Parse the envelope; branch on `refusal.code` and the exit status, never on message text. In `json` and `jsonl`, refusals land on **stdout** beside successes — only text mode diverts a refusal to stderr, so an agent reading stderr for failures reads nothing.
- Run on Node 24.15.0 or later, any later major included. An earlier version refuses with `usage` at exit 2, before the store is touched, because the durable store is the release-candidate `node:sqlite`. `src/versions.ts` is the one place that decides this.
- Read with `--review` (`plan --review`, `verify --review`) when you only need evidence. It takes no writer lease, so it cannot collide with a running job; `status` never takes one at all.
- The store is `--home PATH`, else `MIGMATE_HOME`, else the nearest `.migmate/` directory walking up from the current folder, else the OS default. Work inside the operator's folder and every verb already addresses their store. A `.migmate` that is a file or a symlink refuses with `usage` rather than falling through to a parent or the default.

## Driving a job

Ten verbs on one rail: `init`, `doctor`, `plan`, `approve`, `execute`, `status`, `verify`, `report`, `close`, `cancel`.

1. `init --type file_migration|teams_archive` returns the job id. Every later verb takes `--job ID`.
2. `creds init --job ID --config job.toml` onboards the operator config; `init --config job.toml` does the same at creation. Until it is onboarded the job is unconfigured and `doctor` refuses.
3. `doctor` runs preflight — conditions only an administrator can satisfy. A failure here is a **tenant prerequisite**, so the finishing move is to name the failing check and hand it to a human.
4. `plan` returns a `planDigest` binding an immutable proposal.
5. `approve` needs `--approver IDENTITY` and `--plan-digest DIGEST`. Both belong to the human: carry the identity they gave you and the digest they read back. When either is missing, stop and ask — approval is the one gate that exists to require a person.
6. `execute`, then `verify`.
7. `verify` raises findings. Each one a human chooses to accept becomes an **exception** via `accept --job ID --verification-digest DIGEST --approver IDENTITY --code CODE`, repeating `--code` per finding, recorded permanently in the report. Omitting the digest refuses `verification_unaccepted`; omitting the approver or the codes is `usage`. `close` refuses while any blocking finding is unaccepted; `destination_only_retained` is a nonblocking policy outcome.
8. `report`, then `close`.

`status` is safe at any point. `cancel` is terminal and exits 0 on success.

For file migrations, read the plan's verification mode before approval. The default `"hash"` re-downloads source bytes and compares each relative file path to Drive's stored SHA-256, falling back per file to MD5 without downloading the destination. `[options] verificationMode = "size_only"` trades content proof for listed-size comparison and always requires acceptance of `content_verification_degraded`, even for an empty mapping. Missing, size-differing, corrupt, and unreadable files carry their path, both sizes, and available hashes in the report. Surface those exact paths and evidence. Leftovers (`destination_only_retained`) are retained and reported without blocking close. Verification proves files, not empty folders or metadata.

Read the plan's **Copy concurrency** before approval. Job `[options]` settings `mappingsInFlight` (default `2`) and `transfersPerMapping` (default `4`) accept positive safe integers; the conservative defaults allow eight file transfers across two mappings. Use `mappingsInFlight = 1` for serial mappings. Passes share one managed worker and one serial checkpoint writer; a freed slot starts the next queued mapping. rclone's pacer absorbs throttling within a pass. Failed passes count against the run's retry budget without stopping other mappings.

Read `status.mappingPasses` for durable outcomes and rclone errors. Re-run `execute` to retry failed/interrupted passes, skipping completed passes for that revision; writer recovery marks all unfinished passes interrupted after the worker is gone, including every pass active at a crash. rclone skips identical files on retry. Ctrl-C stops active passes cooperatively and exits 130. Use `--output jsonl` for `mapping_progress` events (`mappingId`, `passNumber`, `bytes`, `files`, `speed`, `errors`).

Choose dedicated destination roots: file copy never deletes, but can update existing same-path files without collision protection. File migration uses no reserved IDs, private markers, move-by-id or local staging; Teams archive uploads retain their own protections. rclone copies empty directories and supported timestamps/content type with owner, permission and label metadata off. SharePoint uses paths inside drives pinned by id, never `root_folder_id`. See README's “File mapping copies and recovery” for the shipped boundary; manifests, mirror and provisioning are not job features in this release.

## Reading a refusal

Match the exit status first, then the code.

| Exit | Meaning                                          | What to do                                           |
| ---- | ------------------------------------------------ | ---------------------------------------------------- |
| 1    | Internal defect, or a code this build cannot map | Report it as a defect; a retry proves nothing.       |
| 2    | Usage or configuration                           | Fix the invocation or the config file.               |
| 3    | Lease or recovery refusal                        | Another writer holds the job. See below.             |
| 4    | Preflight, approval, route, or verification gate | Evidence or authority is missing. Report it.         |
| 5    | Retry budget exhausted, blocked at a checkpoint  | Execution stopped mid-flight; report the checkpoint. |
| 6, 7 | Already closed, already cancelled                | The job is terminal. Start a new one.                |
| 8    | Durable state written by a newer build           | Stop: this build cannot read that job.               |

Exit 5 also covers a _successful_ `execute` whose outcome is `blocked`, so a checkpoint report is the finishing move either way. Statuses `130` (interrupt, including an interrupted `execute`), `141` (broken stdout) and `143` (SIGTERM) are process outcomes carrying no refusal to read.

Codes worth recognising:

- **`plan_revision_required`** — plan and approve again when approved inputs change. For file migrations, a missing or changed destination root and new members in an excluded source subtree still require replanning; unrelated destination additions or removals do not. Same-path file content is governed by rclone copy comparison, not an ownership collision gate.
- **`unsupported_route`** — the requested shape is not one this build implements: a destination outside the configured Shared Drive, a source that is not the named document library, a cloud other than Global, or a mapping root that is not an ordinary folder. `docs/release-limits.md` limit 5 lists the supported routes. Report this and stop: the fix is a config change or new code, never a retry.
- **`preflight_failed`** — every credential and tenant fault arrives under this one code, with the specific check in `refusal.detail`. `detail.check: credential_permissions_invalid` means the credential's roles do not match the route's allowlist, which is exclusive: one extra role refuses the whole credential, which is why each route needs its own app registration. Read `detail` before reporting, because the top-level code alone says only "preflight".
- **`lease_held` / `lease_stale_worker_alive`** — a writer owns the job. Read with `--review`. A crashed writer's same-host lease is taken over automatically by the next writer once its heartbeat is 30 seconds stale and its process and worker are gone; recovery stays in the job's event history. Use `reclaim --job ID --confirm --stop-worker` to stop a recorded orphan worker once its owner is gone. Explicit `reclaim --confirm` also remains available without opening a writer; removing files by hand corrupts the job.
- **`verification_unaccepted`** — `close` reached an unaccepted finding. Surface the findings and let a human decide each.
- **`source_size_inconsistent`** — SharePoint listed a size its download contradicts (rewritten PDF, Office, or HTML files; iOS Live Photos). The finding carries `listedSize`, `servedSize`, and both sides' available hashes. Hash verification distinguishes a listed-size inconsistency from different destination bytes; size-only cannot. Report it for a human to accept; do not exclude the file to make it go away.

`npm run test:live` is an optional maintainer surface, never part of a job. It refuses with `live_test_failed` and names the block in `refusal.detail.gate`: `live_configuration_required` (operator prerequisites absent), `node_runtime_unsupported`, `file_credentials_required`, `credential_file_protection_required` (a reference file carrying group or other permission bits, or not owned by the invoking user), `operator_interrupted`, `live_probe_claims_unproven`, and one generated gate per live probe. Read `detail.gate`; none of these ever reaches a `migmate` envelope.

## Credentials

Operator config holds **credential references**: typed pointers to operator-owned files, resolved just in time. Keep secret values out of config, out of issues, out of commits, and out of your own output — a reference is the thing to pass around. A reference file must be a regular file owned by the invoking user with no group or other permission bits — `0600`, or stricter — and a `mode` stated in the reference must read exactly `0600`.

`scripts/stage1-prereqs.sh` (file route) and `scripts/archive-prereqs.sh` (archive route) walk a human through tenant setup and write those files. Both accept `--resume <env-file>`. These are human steps; hand them over rather than attempting the tenant work.

## Teams archive destination

When driving a `teams_archive` job, distinguish the destination-free local package from the optional Google Shared Drive cold-storage copy. Both support `retainedHistory`, `transcripts`, and `attachmentBytes`, subject to option-specific permissions and tenant probes. Live-test evidence is not required; per-job verification findings are the signal. A hosted-content probe with no non-empty sample skips rather than blocking a text-only or empty scope; an unreadable found asset still fails. `docs/release-limits.md` limit 5 states the coverage and prerequisites.

For a Drive copy, follow `README.md`'s "Teams archive destination" config: stable `destination.destDriveId` and `destination.destFolderId` plus a separate `secrets.google_service_account` file reference. Keep the existing Graph credential unchanged. Omit the destination and Google reference for a local-only archive; this remains the same Teams archive job type and lifecycle.

The local package self-verifies before upload and remains the authority. Drive receives three exposed root files and one ZIP per conversation. For retrieval, use `index.csv` to identify the conversation, download its ZIP, and extract it locally to read it; Drive's web UI is not an archive reading surface.

Before retaining a copy, read `docs/release-limits.md` limit 6 for the shared-drive-wide 500,000-item budget and permission boundary. Surface that capacity and immutability at rest are operator concerns: Drive does not enforce the ZIP's `0444`/`0555` entry modes as object permissions, and create-only uploads do not prevent outside edits.

## Verifying a change to this repo

`npm run typecheck` and `npm test` are hermetic and fast. `npm run check:package` packs, installs globally into a temporary prefix, and smoke-tests the artifact — run it when packaging or the vendored binaries are in scope. `npm run test:live -- --config <file>` exercises real providers, needs tenant access a human prepared, and is optional; never block on it.
