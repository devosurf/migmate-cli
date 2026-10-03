# ADR-0010: rclone executes file transfers; Migmate plans, provisions, and verifies

- Status: accepted
- Date: 2026-10-01
- Supersedes in part: [spec #17](https://github.com/devosurf/migmate-cli/issues/17) (per-item destination writes, private provenance markers, reserved destination ids, move-by-id, and the provisioning boundary), [ADR-0004](0004-drive-revision-concurrency.md) (Migmate no longer writes file content, so it needs no compare-then-write token)
- Implementation: [spec #45](https://github.com/devosurf/migmate-cli/issues/45)
- Amended by: [ADR-0012](0012-staged-migrations-and-access-timing.md) (staged verification scope and provisioning timing)

## Context

The original product design (`docs/design/migration-product-session.md`) had rclone execute transfers and Migmate provision Shared Drives and permissions. Spec #17 reversed both: Migmate became its own per-file Google Drive writer (rclone only streams SharePoint bytes into it), one file at a time, staged to local disk, with reserved destination ids, a private marker on every object, and a rule that Migmate never creates a drive, a mapping root, or a permission. That buys per-file guarantees aimed at a shared, pre-existing destination, and it costs everything rclone exists for: parallel transfers, its backend-aware uploaders and retries, and the remotes it already supports.

Migmate's job is to let agents run large migrations, such as 1000 SharePoint sites into Google Shared Drives and back, and later between any rclone remotes. Into destinations Migmate creates for the job, the per-file write machinery protects against collisions that cannot happen while blocking the scale the product is for.

## Decision

**rclone executes every file copy; Migmate owns everything around it.** Copies run in the managed rclone worker through its remote-control API: `sync/copy` submitted asynchronously per mapping, progress from `core/stats`, cancellation through `job/stop`. rclone keeps no durable job state, so Migmate checkpoints each mapping's pass in the job's SQLite store and recovers by re-running the same copy, which rclone makes idempotent by skipping identical files ([rclone RC capabilities research](https://github.com/devosurf/migmate-cli/blob/research/rclone-rc-capabilities/docs/research/rclone-rc-capabilities.md)).

**Migmate keeps:** the lifecycle (preflight, immutable plan, human approval, verification, findings, acceptance, report, close); the **mapping manifest**, loaded into SQLite and frozen into the plan; destination provisioning (creating Shared Drives and adding the members the manifest lists); identity, including an optional Google domain-wide-delegation subject that rclone and Migmate both act as, so created files are attributed to an account such as `files@eidra.com`; and per-file verification.

**Passes copy and never delete by default.** A job may opt into **mirror** for drives it created, which runs `sync/sync` with a max-delete limit; nothing outside a job-created drive is ever deleted.

**Verification hashes every file by default.** For each mapping, rclone computes the destination's own hash type from a fresh read of the source (`operations/hashsum` with `download`, or `operations/check` where neither side stores a hash) and Migmate compares it per file with what the destination stores, raising findings for missing, differing, and unreadable items. A job may opt into size-only verification, which raises a named finding that must be accepted.

## Consequences

- File migration's per-item writer is removed in a clean cutover: its use of destination uploads, reserved ids, private markers, move-by-id, compare-then-write tokens, and the collision codes that exist only for them. The Teams archive destination keeps its own create-only Drive uploads with reserved ids and markers. Provenance for file migration becomes job evidence: mapping, source path and hash, destination id and hash, inside a destination root the job owns.
- Under copy, a renamed or deleted source item leaves its earlier destination copy in place. Verification reports such leftovers; mirror removes them only in job-created drives.
- Hash verification reads every source byte twice: once to copy, once to verify. Size-only verification trades that cost for weaker proof, recorded as a finding.
- rclone runs with `--metadata`, which writes created time (`btime`; on Google Drive only for fresh uploads) on both Google Drive and OneDrive/SharePoint, and content type on Google Drive; SharePoint sets content type itself. Owner, permission, and label metadata stay off. Metadata applies to files only: the worker disables directory metadata writes (`--disable=WriteDirMetadata`) because rclone v1.75.0's Drive backend applies a SharePoint folder's `inode/directory` content type to the folder it creates, producing a 0-byte file instead. Folders keep modification times.
- SharePoint rewrites some PDF, Office, and HTML files on upload ([research](../research/provider-byte-integrity.md)), which makes rclone's own size and hash checks fail. SharePoint destinations therefore run with rclone's `--ignore-size --ignore-checksum`, and Migmate's verification names each rewritten file for acceptance.
- The exact rclone version pin stays (`docs/release-limits.md` §3), and SharePoint remotes stay path-rooted, because rclone v1.75.0 resolves `root_folder_id` object lookups from the drive root.
- Domain-wide delegation is a domain-wide key. Migmate requests only the Drive scope, proves in preflight that it acts as the configured subject, shows the subject in the plan, and lists deleting the key and the delegation entry as an open item in the closing report. The subject must be an ordinary account, not an admin; Migmate cannot check that without Admin SDK scopes, which it never requests, so the documentation states it as the operator's responsibility.
- Teams archive jobs are unaffected: they collect from Graph rather than copying files.
