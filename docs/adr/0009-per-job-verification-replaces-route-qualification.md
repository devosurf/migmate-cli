# ADR-0009: Per-job verification replaces route qualification

- Status: accepted
- Date: 2026-09-30
- Supersedes in part: [ADR-0003](0003-site-scoped-file-route.md), [ADR-0005](0005-unrepresentable-path-proof.md), [ADR-0006](0006-capability-sample-proofs.md), [ADR-0008](0008-archive-cold-storage-destination.md)

## Context

Every job used to refuse `unqualified_route` unless a published evidence bundle matched its route tuple exactly: job type, source and destination backend settings, Google authentication kind, archive options, guarantee-set id, rclone version and desktop architecture, compared by canonical equality and never as a subset. The operator config had to name that bundle by path and digest, so every consumer pinned digests, and any change to any tuple element needed a full live-tenant run, a hand-copied immutable bundle, and a hand-written `gates.json` entry before a single job could start. Adding Google domain-wide-delegation impersonation, for instance, touches one tuple field and would have cost that whole cycle.

The gate protected less than it cost. Most tuple fields restate constants the credential loader and transfer worker already enforce, so the only things it actually refused were other desktop architectures, the untested `transcripts` and `attachmentBytes` options, and anything new. Meanwhile every job already verifies every item it writes: size, a SHA-256 re-hash of the source stream against Drive's checksum, created and modified time, MIME type, the provenance marker, and drift on either side, with any mismatch a finding that blocks `close` until accepted. And the tenants the evidence was captured in are not guaranteed to persist.

## Decision

**Per-job verification is the guarantee; the route-qualification gate is removed.** The `provider.qualified_route` preflight check, the route tuple, the evidence bundles, `qualification/gates.json`, the bundle validator, and the `qualification` and `guarantees` job-config keys are deleted. Job folders written by earlier builds still open: their persisted copies of those two keys are ignored, while new config carrying them refuses `configuration_invalid`.

**The refusal code `unqualified_route` becomes `unsupported_route`** (still exit 4) for the shapes this build does not implement: a destination outside the configured Shared Drive, a source that is not the named document library, a cloud other than Global, a mapping root that is not an ordinary folder, and archive options that never ran against a live tenant.

**`transcripts` and `attachmentBytes` refuse at preflight** through `provider.archive_options` rather than through missing evidence.

**The live probe suite survives as an optional test**, `npm run test:live -- --config <file>`. It runs the same probes against disposable roots and reports pass or fail per probe; it writes nothing into the repository, needs no desktop session, and is not part of `npm test`, CI, or any release step, because the test tenants may not last.

**Pins are unchanged.** The transfer binary stays pinned to one checksummed rclone version and Node to 24 at 24.15.0 or later: each guards a specific observed defect, not a gap in evidence. All four CI-installed architectures may run jobs.

## Considered options

Keeping the gate but letting an operator accept an unqualified route as a recorded exception was rejected. It fits the existing exception model, but it keeps the tuple, the bundles, and the digest pinning — the maintainer cost this decision exists to remove.

## Consequences

- What a release no longer proves on a live tenant: crash and restart durability, rerun and move semantics, collision handling, and whether the source listing silently misses an item kind. The offline suite covers the engine logic; only the optional live test observes real Graph and Drive behaviour, and nothing requires it to have run.
- The five routes that previously held evidence last passed the live suite on darwin-arm64 with Node 24.21.0 and rclone v1.75.0, between 2026-09-16 and 2026-09-20. That is a historical fact about those builds, not a claim about later ones.
- Other architectures and new configurations (such as a different Google authentication kind) run without live evidence; their per-job verification findings are the only signal of a behaviour difference.
- ADR-0003's point that the tuple binds the granted permission set no longer applies; the exclusive role allowlists still enforce it at preflight. ADR-0005 and ADR-0006 proof values now bind the optional live test rather than a published bundle. ADR-0008's "second tuple owing its own evidence bundle" no longer applies; the archive destination is simply supported.
