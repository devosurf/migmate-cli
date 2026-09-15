# ADR-0004: Destination concurrency rests on Drive's revision, not an ETag

- Status: accepted
- Date: 2026-09-15
- Context: [file migration contract #6](https://github.com/devosurf/migmate-cli/issues/6), [spec #17](https://github.com/devosurf/migmate-cli/issues/17), [release qualification #25](https://github.com/devosurf/migmate-cli/issues/25)

## Context

The destination effects read `response.headers.get("etag")` and refused any update whose expected ETag was absent or unequal, sending `If-Match` on every conditional write. Unit tests passed because their mocks invented the header.

Google Drive v3 sends no ETag. Verified against the live Shared Drive: `files.get` returns `cache-control`, `content-type`, `vary`, and `x-content-type-options`, and nothing else of relevance — Drive v3 dropped etags from its resources, and its write methods document no `If-Match` precondition. So the token was always `null` on the real API, every conditional destination update refused, and the qualification suite stopped in teardown with `hasEtag: false` after the rest of the route had passed.

An `If-Match` header Drive ignores is worse than no header: it reads as a stronger guarantee than the API can give.

## Decision

**The destination concurrency token is `version`, plus `headRevisionId` when Drive reports one** — `"<version>"` or `"<version>:<headRevisionId>"`. `version` advances on every change to a file's metadata or content; `headRevisionId` changes when a binary file's content does. `DestinationEntry.revision` replaces `DestinationEntry.etag`, and `expectedRevision` replaces `expectedEtag`.

**Writes compare, then write.** Every conditional path re-reads the object, compares the token, and refuses `prior_copy_drift` on any difference before issuing the write. `If-Match` headers are removed rather than left decorative.

**A null token is never a match.** Drive declining to report a version is not agreement, so an absent expected or observed token refuses.

**The guarantee is stated honestly.** #6 said "conditional update"; what the destination actually provides is a compare-then-write with a window between the comparison and the write. A concurrent editor inside that window is caught by the next verification pass, not by the write itself, because Drive offers no precondition to catch it atomically.

The private `appProperties` provenance marker remains the authority for _ownership_ — that Migmate wrote an object — and is unaffected. The revision token answers a different question: whether the object changed since we looked.

## Consequences

- Destination updates work against the real API. Nothing did before, which is why no live route had ever completed.
- The compare-then-write window is real and documented. Two writers racing inside it can both proceed; verification detects the result rather than preventing it. Migmate already refuses to run two lifecycle writers per job, so the exposure is an outside editor, not Migmate against itself.
- `revision` is an opaque string. Nothing parses or orders it; a changed string means "changed".
- Renaming rather than repurposing `etag` keeps the field honest about where its value comes from. Pre-1.0, so no compatibility shim is owed.
- Retaining ETags for the SharePoint source is deliberate: Graph does publish them, and the source read path binds them (see ADR-0003's path binding).
