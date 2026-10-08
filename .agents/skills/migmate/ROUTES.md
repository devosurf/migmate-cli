# Routes and file-job operation

## Runtime and workspace

`CONTEXT.md` defines Migmate's terms; `migmate --help` is the authority on invocation syntax.

- Pass `--output json`. Parse the envelope; branch on `refusal.code` and the exit status, never on message text. In `json` and `jsonl`, refusals land on **stdout** beside successes — only text mode diverts a refusal to stderr, so an agent reading stderr for failures reads nothing.
- Run on Node 24.15.0 or later, any later major included. An earlier version refuses with `usage` at exit 2, before the store is touched, because the durable store is the release-candidate `node:sqlite`. `src/versions.ts` is the one place that decides this.
- Read with `--review` (`plan --review`, `verify --review`) when you only need evidence. It takes no writer lease, so it cannot collide with a running job; `status` never takes one at all.
- The store is `--home PATH`, else `MIGMATE_HOME`, else the nearest `.migmate/` directory walking up from the current folder, else the OS default. Work inside the operator's folder and every verb already addresses their store. A `.migmate` that is a file or a symlink refuses with `usage` rather than falling through to a parent or the default.

## Job setup

`init --type file_migration|teams_archive` returns the job id. Every later verb takes `--job ID`. Add `--config job.toml` to `init` to onboard at creation, or use `creds init --job ID --config job.toml` afterward. Until onboarding, `doctor` refuses. Preflight failures name their checks: tenant prerequisites need an administrator, while malformed configuration needs an operator fix. `plan` returns a `planDigest` binding an immutable proposal.

`status` is safe at any point. `cancel` is terminal and exits 0 on success.

## Mapping manifests

For file migration batches, initialize with credential config; `[[mappings]]` may
be omitted. `creds init` and `doctor` can prove credentials before mappings exist.
Run `manifest load --job ID --file mappings.json --output json` before `plan`,
then rerun `doctor` to prove mapping-specific access. An empty job's `plan` refuses
`configuration_invalid` with `detail.field: "mappings"`: load the reviewed manifest.
JSON uses `{ "version": 1, "mappings": [...] }`; each mapping has `id`,
`source: { type: "sharepoint", driveId, folderPath }`, and
`destination: { type: "google_shared_drive", driveId, folderId }` for existing roots.
To provision, use `destination: { type: "google_shared_drive", create: "Drive name" }`
and optional mapping-level `members: [{ email, type, role }]`. Read README's
**Mapping manifests** for member roles and the seven-/nine-column CSV layouts.
`folderPath` is literal drive-relative text (`""` for the root), not URL-encoded.
Extra fields and `anyone`/`domain` members refuse.
On `configuration_invalid`, fix `refusal.detail.row` and `.field`; row 0 means the
document/header, other rows are one-based mapping records. Equal or nested source
roots within one drive, or destination roots within one Shared Drive, overlap and refuse.

The store becomes the authority: editing the manifest file changes nothing.
Loading after a plan creates a new revision needing human approval; if recollection
fails, fix the prerequisite and run `plan` again. Legacy config mappings migrate
on writer open. Review `plan --review --view mappings` and `status --view mappings`
with `--limit`, `--cursor`, `--search`, or `--mapping ID`; counts cover all matches.
In mapping view, read each row's `mapping` and `mappingPass`, not top-level
`mappingPasses` (omitted to keep the page bounded).

## Reverse route

For Google Shared Drives into SharePoint, set top-level `route = "shared_drive_to_sharepoint_library"`
in the job TOML before loading; one job copies in one direction, so a row in the other
direction (or a mixed manifest) refuses `configuration_invalid` with `field: "source.type"`.
A mapping uses
`source: { type: "google_shared_drive", driveId, folderId }` and
`destination: { type: "sharepoint", driveId, folderPath }`; the library and folder must
already exist, so `create`, `members` and mirror refuse. CSV uses README's eleven-column
layout. The job's `[rclone]` needs `sharepointDestinationRemote`, a separate SharePoint
app holding exactly `Sites.ReadWrite.All` (anything else returns `preflight_failed`
with `detail.check: credential_permissions_invalid`). Before mappings exist, the explicit reverse
route already requires this write remote and needs no `sourceRemote`; the default
SharePoint-source route requires `sourceRemote` and refuses the write remote.
Sources are read as the acting account. On `preflight_failed` with
`unreadableSourceDrives` (from `manifest load` or `doctor`/`plan`), surface those drive IDs: a human must add the acting
account as a member; Migmate never does. Verification compares quickXorHash computed
from the source with SharePoint's. For transformed destination content, use
[FINDINGS.md](FINDINGS.md)'s reverse-route decision guidance.

## Content proof

For file migrations, the default `[options] verificationMode = "hash"` re-downloads source bytes and compares each relative path to Drive's stored SHA-256, falling back per file to MD5 without downloading the destination. `"size_only"` instead compares listed sizes; consult [FINDINGS.md](FINDINGS.md) for its acceptance requirement. Missing, size-differing, corrupt and unreadable files carry paths, both sizes and available hashes in the report. Both modes check folder existence, including empty folders, on both file routes; file and folder metadata remain unverified. Excluded and omitted folders and their descendants are outside the folder check. Interpret missing/conflicting paths and leftovers through [FINDINGS.md](FINDINGS.md), not as successful copies.

## Copy execution

Read the plan's **Copy concurrency** before approval. Job `[options]` settings `mappingsInFlight` (default `2`) and `transfersPerMapping` (default `4`) accept positive safe integers; the conservative defaults allow eight file transfers across two mappings. Use `mappingsInFlight = 1` for serial mappings. Passes share one managed worker and one serial checkpoint writer; a freed slot starts the next queued mapping. rclone's pacer absorbs throttling within a pass. Ordinary failed passes count against the run's retry budget without stopping other mappings.

Read `status.mappingPasses` for durable outcomes and rclone errors. Re-run `execute` to retry failed/interrupted passes, skipping completed passes for that revision; writer recovery marks all unfinished passes interrupted after the worker is gone, including every pass active at a crash. rclone skips identical files on retry. Ctrl-C stops active passes cooperatively and exits 130. Use `--output jsonl` for `mapping_progress` events (`mappingId`, `passNumber`, `bytes`, `files`, `speed`, `errors`).

For `blocked` (exit 5) with `uploadQuota.code = "upload_quota_exceeded"` in the execute result or `status.mappingPasses[].uploadQuota`, present the acting account, hit time and earliest resume estimate. Google allows 750 GB of uploads per user per day; Migmate stops the other active passes and starts no queued mapping for that account. Recommend waiting until `earliestResumeAt` (hit time + 24 hours), then repeat `execute` on the same job. Explain `resumeTimeIsEstimate = true`: this is not Google's reset clock or guaranteed allowance. An earlier manual retry is allowed; automatic quota resume is unavailable. Quota stops bypass the ordinary failure budget; the quota pass's final `errors = null` means its ordinary failure count is unknown, while `rcloneErrors` retains the unclassified raw aggregate. Preserve earlier failures for review; a quota block is not an acceptance request.

Choose dedicated destination roots: file copy never deletes, but can update existing same-path files without collision protection. File migration uses no reserved IDs, private markers, move-by-id or local staging; Teams archive uploads retain their own protections. rclone copies empty directories and supported file timestamps/content type with owner, permission and label metadata off; folders get modification times only. SharePoint uses paths inside drives pinned by id, never `root_folder_id`. See README's “File mapping copies and recovery” for the shipped boundary.

## Teams archive destination

When driving a `teams_archive` job, distinguish the destination-free local package from the optional Google Shared Drive cold-storage copy. Both support `retainedHistory`, `transcripts`, and `attachmentBytes`, subject to option-specific permissions and tenant probes. Live-test evidence is not required; per-job verification findings are the signal. A hosted-content probe with no non-empty sample skips rather than blocking a text-only or empty scope; an unreadable found asset still fails. `docs/release-limits.md` limit 5 states the coverage and prerequisites.

For a Drive copy, follow `README.md`'s "Teams archive destination" config: stable `destination.destDriveId` and `destination.destFolderId` plus a separate `secrets.google_service_account` file reference. Keep the existing Graph credential unchanged. Omit the destination and Google reference for a local-only archive; this remains the same Teams archive job type and lifecycle.

The local package self-verifies before upload and remains the authority. Drive receives three exposed root files and one ZIP per conversation. For retrieval, use `index.csv` to identify the conversation, download its ZIP, and extract it locally to read it; Drive's web UI is not an archive reading surface.

Before retaining a copy, read `docs/release-limits.md` limit 6 for the shared-drive-wide 500,000-item budget and permission boundary. Surface that capacity and immutability at rest are operator concerns: Drive does not enforce the ZIP's `0444`/`0555` entry modes as object permissions, and create-only uploads do not prevent outside edits.

## Verifying a change to this repo

`npm run typecheck` and `npm test` are hermetic and fast. `npm run check:package` packs, installs globally into a temporary prefix, and smoke-tests the artifact — run it when packaging or the vendored binaries are in scope. `npm run test:live -- --config <file>` exercises real providers, needs tenant access a human prepared, and is optional; never block on it.
