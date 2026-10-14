# ADR-0014: File migrations approve the map and verify by listing

- Status: accepted
- Date: 2026-10-14
- Accepted: Morgan, 2026-10-14, in the decision session for [#70](https://github.com/devosurf/migmate-cli/issues/70).
- Supersedes: [ADR-0013](0013-rclone-proof-map-only-approval.md)
- Amends: [ADR-0010](0010-rclone-executes-file-transfers.md) (content hashing is opt-in, not the default; no size-only finding) and [ADR-0012](0012-staged-migrations-and-access-timing.md) A2 (no pre-approval preview), A4 (settle by listing comparison), A5 (no inventory age or freshness fence) and A7 (no partial verification).

Every file migration, on both routes, now works the way ADR-0013's opt-in rclone proof did; the per-file Graph inventory ("full proof") and the `proof` option are removed. A plan binds the map: mapping roots, drives to create, members and options, not a file list. rclone copies, a listing comparison settles the final pass, and verification compares rclone listings of both sides by path and size, folders included. The plan and report disclose that this compares no content; it raises no finding. A job may opt into `[options] verificationMode = "hash"`, the existing ADR-0010 mechanism: rclone downloads the source to compute the destination's hash type and Migmate compares it per file with the destination's stored hash. That needs no Graph inventory. Until implemented, this records a decision, not current behaviour.

We decided this after the Essense → Eidra run (1.34 TB, ~280k files). Full proof's plan for a 52-library wave ran 12 hours without finishing at ~10 Graph calls/s; rclone proof planned the same wave in 53 seconds, copied 291 GB / 34,450 files in 4.5 hours and verified by listing in about 40 minutes. The per-file evidence only full proof collects (version counts, list-item fields, retention labels) changed no decision: those omissions are inherent to the route and were accepted wholesale. The next planned job is ~80 TB.

## Considered options

- **Keep full proof as an explicit opt-in, or keep it and only change the default.** Its remaining uses (exclusions, a per-file preview, per-file omission findings, partial verification) are not ones operators expect to need, and each keeps a second planning, settling and verification path alive.
- **Hash verification by default.** It re-downloads the whole source at every verification, about 7.4 days for 80 TB at a sustained 1 Gbit/s, inside the freeze window.
- **No content hashing at all.** The hash path already exists and costs nothing when off; small or critical jobs keep byte-level proof.
- **Exclusions rebuilt on rclone filter rules.** No field case needed subtree exclusions. Choosing mapping roots is the only scope, so approval binds exactly what is copied, with no pattern that can match more or less than intended.

## Consequences

- Removed: `proof`, mapping exclusions, the per-file plan preview including the deletion preview, inventory age and the execute-start freshness fence, per-file omission findings, `acceptedOmissions`, `oneNoteNotebooks` (notebooks are copied as their section files), `deltaVerification`, `verificationMode = "size_only"` and `content_verification_degraded`. Version history, list-item fields, retention labels and permissions are still not copied; the plan and report say so once instead of per file.
- Mirror keeps its job-created-drive provenance and `deleteLimit` guards, and records each deletion from an rclone listing taken just before the pass. The limit is enforced when the pass runs, not at approval.
- Each verification covers whole mappings. A final pass still settles within its bounded catch-up passes, now when a listing comparison of files and folders finds nothing left to copy or delete.
- Shared Drive → SharePoint: SharePoint rewrites some PDF, Office and HTML files on upload (ADR-0010). Listing verification raises `destination_rewrote_file` for a size difference on those types and `size_mismatch` for any other, the same file-type rule hash verification already applies.
- SharePoint → Shared Drive: SharePoint's served-size rewrite of Office files still surfaces as copy failures and `size_mismatch`; [#75](https://github.com/devosurf/migmate-cli/issues/75) owns that.
- No compatibility with jobs created by earlier builds: configs naming a removed option refuse rather than being read under new meanings.
- Not decided here, and revisited only with a real case: sampled content hashing, and exclusions built on rclone filter rules.
- Teams archive jobs are unaffected.
