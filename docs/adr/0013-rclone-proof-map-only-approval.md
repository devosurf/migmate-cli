# ADR-0013: Opt-in rclone proof approves the map and verifies by listing

- Status: accepted
- Date: 2026-10-04
- Accepted: Morgan, 2026-10-04, after measuring an ~8 hour plan for ~45k files.
- Amends: [ADR-0010](0010-rclone-executes-file-transfers.md) (size-only proof without a named finding) and [ADR-0012](0012-staged-migrations-and-access-timing.md) A2 and A5 (no pre-approval preview or source freshness comparison), for jobs that set `[options] proof = "rclone"` only.

The full proof level makes two Graph metadata calls per source file, and repeats that per-file inventory in `plan`, before `execute` copies anything, and in `verify`, which also re-reads every byte. On large libraries that costs hours at every pass, including the final pass during the freeze, for operators whose prior migrations relied on rclone alone. We added an opt-in proof level for SharePoint → Shared Drive. Its approval binds the mapping roots, drives, members and options, not a file list. rclone lists both sides as it copies, and verification compares rclone listings by path and size, folders included, plus copy-pass completion. Choosing this level is the operator's explicit acceptance of weaker proof. It is disclosed in the plan and report instead of raising `content_verification_degraded`, and verification refuses `plan_revision_required` if the operator file's proof level no longer matches the approved plan.

## Consequences

- SharePoint and Drive share no hash type, so neither rclone nor Migmate compares content on this route. Each verified row still records the source quickXorHash and the destination's stored hash as evidence.
- Nothing is reviewed per file before copying: no deletion preview, exclusions, OneNote omission or per-file omission findings. Mirror keeps its job-created-drive and `deleteLimit` guards, and records each deletion from an rclone listing taken just before the pass.
- A final pass settles when an rclone listing comparison of files and folders finds nothing left to copy or delete, not on a per-file Graph inventory.
- The default stays `proof = "full"`. Moving a job between levels requires a new plan and approval.
