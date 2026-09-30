# ADR-0008: The Teams archive gets a cold-storage destination, one container per conversation

- Status: accepted; superseded in part by [ADR-0009](0009-per-job-verification-replaces-route-qualification.md) (the destination no longer owes its own evidence bundle)
- Date: 2026-09-16
- Context: [spec #17](https://github.com/devosurf/migmate-cli/issues/17) §10 and §11, stories 39 and 47; [destination decision #37](https://github.com/devosurf/migmate-cli/issues/37); [ADR-0007](0007-archive-scope-reads-and-window-filter.md)

## Context

Spec #17 line 26 defines a Teams archive job as producing "a self-contained local package … verified against itself", and line 32 admits exactly one route to a Google Shared Drive: the file migration route. `docs/release-limits.md` limit 5 records `teams_archive` as ending at a local package. Issue #30 was closed partly on the grounds that "Teams content to a Shared Drive archive" came from the superseded `docs/design/migration-product-session.md` and must not be mined for requirements.

The operator has since stated the first-version end goal directly: **all personal and channel Teams conversations, saved to a Google Shared Drive for archiving.** So the premise behind that part of #30's closure was wrong. The local package was never the goal; it was the goal minus its destination.

Two facts about the intent decide the shape, and both were established by measurement rather than assumption.

**The Shared Drive is cold storage, not a reading surface.** Content is saved so that someone can retrieve a conversation later. A future reading surface — Postgres behind a web UI with authentication — is explicitly a different product and out of scope here.

**The exposed package tree does not survive tenant scale.** A shared drive caps at 500,000 items, counting files, folders, shortcuts and trash. The package is folder-dense: each asset gets its own `<sha256>/` directory, and each conversation gets `parts/`, `data/` and `assets/hosted/`. Measured on a generated package, one conversation with a single asset is **12 Drive items**, or roughly `9 + 2 x assets`:

| Conversations | Assets each |    Items | Share of one shared drive |
| ------------: | ----------: | -------: | ------------------------: |
|         1,000 |          10 |  ~29,000 |                        6% |
|         5,000 |          20 | ~245,000 |                       49% |
|        20,000 |          20 | ~980,000 |               **exceeds** |

"All conversations" for a real tenant is the bottom rows, and a second pass is a new job under story 47 rather than a replacement, so passes accumulate.

Readability, by contrast, turned out **not** to be a differentiator. Google Drive's web UI cannot serve the archive — it does not host static sites, and assets are extensionless — but Drive for desktop mounts as a real filesystem, so `index.html` opens as `file://` with relative links intact. The strict `img-src 'self' data:` content-security policy was expected to block byte-preserved images from an opaque `file://` origin; measured, it does not (`complete: true, naturalWidth: 64` on a hosted-content asset). Both the exposed tree and a container are readable once local, so readability cannot decide between them. The item budget can.

## Decision

**The Shared Drive holds a copy for retention; the local package remains the authority.** The archive is still built, self-contained, and verified against itself locally before anything leaves the machine, exactly as line 26 requires. Line 26 is extended, not contradicted: the package is no longer the last step.

**The archive job gains an optional destination. No third driver is added.** Spec §10 states "exactly two drivers exist, statically linked, looked up by no string: file migration and Teams archive." A separate package-upload job type would be a third. The archive driver already holds the finished package on local disk, so it needs the destination effects layer, not a new driver. A configured destination produces a new route tuple owing its own evidence bundle; the existing destination-free tuple `6aa55648…` stays valid and untouched.

**The payload is one deterministic container per conversation, with the root index left exposed.** The root `index.html`, `index.csv` and `manifest.json` upload as plain objects; each `conversations/<slug>-<sha256>/` directory uploads as a single container named for that directory. This is what cold storage with occasional targeted retrieval actually needs:

- Retrieval is one download. The root `index.csv` already carries `scopeEntryId`, `conversationId`, `ownerScopeEntryId` and the conversation path per row, so finding the right container needs no index we do not already emit, and Drive previews CSV in the browser.
- The item cost becomes roughly one item per conversation. 20,000 conversations is about 20,000 items, 4% of one shared drive, against 196% for the exposed tree.

A single whole-archive container was rejected: it is 1 item, but retrieving one conversation means downloading every conversation, which defeats the stated purpose.

**Container bytes are reproducible.** The package is digest-bound, so a container whose bytes vary between runs would make its digest meaningless. Entry order is the package's existing sorted artifact order, timestamps are fixed rather than taken from the filesystem, and no archive-level metadata varies per run. The writer is implemented on `node:zlib`, which is already available; ADR-0001 pins three runtime dependencies and this adds no fourth, and controlling the writer is what makes determinism achievable rather than hoped for.

## Consequences

- The archive route gains a second tuple, and a qualified destination archive needs its own live run and published bundle. Nothing about the destination-free archive changes.
- The archive job now needs Google Shared Drive credentials beside its Graph credentials. `ARCHIVE_ROLES` is an exclusive allowlist of six Graph roles and is unaffected: the destination credential is a Google service account, a separate credential reference.
- Verification is two-stage and both stages already exist: the package self-verifies locally, then each uploaded object is byte-verified by the destination stack that route #1 already uses, including the private provenance marker.
- **Drive has no POSIX modes.** The package publishes `0444`/`0555`; upload discards that, so immutability at rest becomes a Drive permission concern for the operator, not a filesystem guarantee Migmate can make.
- **Drive for desktop streams by default.** Irrelevant for cold storage, but an operator who does browse the copy gets placeholders fetched on demand unless the folder is mirrored. Story 39's "opens from disk with no server" is a property of the local package, which is retained, not of the Drive copy.
- A container is opaque to Drive search. Finding a conversation goes through the exposed `index.csv`, which is why it stays exposed.
- The future reading surface is not foreclosed. The container preserves the canonical JSONL records, which are the ingestion format such a system would need, so choosing cold storage now costs nothing later.
- #30 stays closed. A generic rclone-to-rclone route is still neither implemented nor qualified; this decision adds one specific destination to the archive job, not a general remote.
