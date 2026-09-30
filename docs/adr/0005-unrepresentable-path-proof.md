# ADR-0005: A source that refuses every rejected name proves the guard differently

- Status: accepted; superseded in part by [ADR-0009](0009-per-job-verification-replaces-route-qualification.md) (the proof now binds the optional live test, not a published bundle)
- Date: 2026-09-15
- Context: [file migration contract #6](https://github.com/devosurf/migmate-cli/issues/6), [release qualification #25](https://github.com/devosurf/migmate-cli/issues/25), [ADR-0003](0003-site-scoped-file-route.md)

## Context

The route matrix required a live source item whose name the driver must refuse, observed producing the `path_unrepresentable` finding. Without it the run refused with `file_live_path_unrepresentable_fixture_unavailable`, and that gate was the last thing standing between a fully exercised live route and a published bundle.

The fixture cannot exist. The driver refuses a name that is empty, `.`, `..`, contains `/` or NUL, or exceeds 32 KB. Measured against the live tenant with an app that may write to the library, SharePoint refused **every one** of those names with HTTP 400 `invalidRequest`: `""`, `.`, `..`, `a/b.txt`, and a name containing NUL. A 304-character name was accepted, which only confirms the direction of the remaining bound: SharePoint's own path limit is far below 32 KB, so the length branch is unreachable too.

So the requirement asked for an observation the source cannot produce. Waiting for it would block the release permanently, and inventing the fixture would fabricate evidence.

Two things _are_ observable, and together they cover the same ground:

1. **The source refuses those names itself**, recorded as the live 400 from a real create attempt. Nothing downstream ever sees such an item, because SharePoint will not hold one.
2. **The driver's `path_unrepresentable` finding is exercised live** through its other cause: a provenance marker too large for Drive's private-property capacity, with a perfectly valid source name. That case already runs in the matrix and emits the code.

## Decision

**`sourcePathProof` takes one of two values, and the bundle validator requires the matching evidence for each.**

- `live_source_entry` — a real source item with a refused name existed, and the `live_source_path_refusal` assertion shows the driver refusing it. Unchanged, and still what a source that permits such names must produce.
- `source_refuses_every_rejected_name` — the source refuses them all. The bundle must then carry the provenance-capacity refusal (`code: path_unrepresentable`, `cause: private_provenance_capacity`, `sourceNameValid: true`) **and** the source's own recorded 400.

No third value is accepted, and a bundle whose observations claim one form while carrying the other's evidence is refused.

**The run defers only when a fixture was supplied and failed.** Supplying `fixtures.specialSources.pathUnrepresentableId` still demands the live refusal; the new gate name is `file_live_path_unrepresentable_fixture_unproven`, which is a real failure rather than an absence.

**The guard itself does not move.** `requireName` keeps refusing those names. Unreachable from one source is not unreachable from every source: the first-release generic rclone route can carry names SharePoint cannot, and that source must still produce form 1.

## Consequences

- The SharePoint-to-Shared-Drive route can publish a qualified bundle, which it could not before at any amount of operator effort.
- What the bundle claims is narrower and truer than before: it now records _why_ the stronger proof is absent, instead of implying the matrix was fully exercised. `fullLiveMatrix` stays false in that case.
- A future source that permits such names cannot silently inherit the weaker proof: it produces form 1 or it fails.
- The reachability argument is tenant-specific evidence, not a Microsoft guarantee. If SharePoint ever accepts one of those names, form 1 becomes available and should be used.
