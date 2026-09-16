# ADR-0006: Every capability sample is observed, refused, or absent

- Status: accepted
- Date: 2026-09-16
- Context: [first-release spec #17](https://github.com/devosurf/migmate-cli/issues/17), [capability sample proofs #27](https://github.com/devosurf/migmate-cli/issues/27), [ADR-0005](0005-unrepresentable-path-proof.md)

## Context

The route matrix requires live observations of three unusual source kinds: a `package`, a `reference`, and an item whose content cannot be downloaded. One is reachable; two cannot be manufactured in a clean tenant. The run refused with `file_live_<kind>_fixture_unavailable`, a gate indistinguishable from "nobody looked".

Measured against the live tenant on 2026-09-15/16 with an app that may write to the source library:

- **package** — a OneNote notebook is a real `package:oneNote` item. Supplied as `fixtures.specialSources.packageId`, the driver omitted it with `source_package_omitted` in a full live run.
- **reference** — Graph refuses to create a `remoteItem` in a document library: HTTP 400 `invalidRequest` for a `remoteItem` facet naming an item in the same drive, and HTTP 400 `The provided sharepointIds is invalid` for the `sharepointIds` form.
- **undownloadable** — no API creates a malware-flagged or content-less item on demand, and none exists in the source scope.

A boolean present/absent treatment cannot tell these apart, so the bundle either implied the matrix was fully exercised or said nothing about why a sample was missing.

## Decision

**Each capability records one of three proof values, and the bundle validator requires the matching evidence for each.**

| Value                      | Means                                                    | Required evidence                                             |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `live_source_entry`        | A real item existed and the driver omitted it            | the `<kind>_omission` assertion, expected and observed `true` |
| `source_refuses_creation`  | The platform refused a real create attempt in this run   | the live HTTP status of that attempt, which must be 400       |
| `absent_from_source_scope` | No such item in the scanned scope and no API creates one | a kind census with items scanned > 0 and that kind's count 0  |

The values live in `src/qualification/bundle.ts` beside `weakerProofByKind`, the one table naming the weaker proof each kind may rest on. The suite decides a value from it and the validator enforces it from the same table, so the two cannot drift; the validator refuses any fourth value. The `route_limits_and_version_gate` probe carries `capabilityProofs`, `sourceKindCensus`, and `sourceRefusedReferenceStatus`.

**The scanned scope is the mapping source root's children.** That is the census's subject and the only place a supplied sample is accepted, so absence there is the same absence the omission would have been observed in. A file the source reports as not downloadable is counted as `undownloadable`, which is where the driver's omission falls.

**Only the reference create is attempted live**, by the separate mutation identity under the disposable source root, so no other kind may rest on `source_refuses_creation`. If that create ever **succeeds**, the fixture deletes the created item and the run refuses with `file_live_reference_fixture_creatable`: the weaker proof no longer applies and the operator must supply the sample.

**Only `undownloadable` may rest on absence**, in the suite and in the validator alike. The second half of that value's meaning — no API creates one — is measured for a malware-flagged or content-less item and for nothing else. A OneNote notebook is creatable in the library, so an empty census says only that nobody has made one yet: `package` owes `live_source_entry` or the `file_live_package_fixture_unavailable` gate. A `reference` is covered by the stronger refusal proof instead. A published bundle that swaps one kind's proof for another's is refused.

**A source that can hold a sample still owes `live_source_entry`.** This is ADR-0005's rule, now applied per capability: when the census counts that kind and no sample was supplied, neither weaker proof applies and the run refuses with `file_live_<kind>_fixture_unavailable`, which now means "a proof is owed and none is available".

**The run defers only when a supplied sample failed.** Supplying `fixtures.specialSources.<kind>Id` still demands its omission code live; the gate is `file_live_<kind>_fixture_unproven`, a real failure rather than an absence, and it outranks the absence gates.

**The driver does not move.** Its omission codes and the conditions that produce them are unchanged; only what the bundle may claim about having observed them changes.

## Consequences

- The SharePoint-to-Shared-Drive route can publish a bundle with a package sample and no reference or undownloadable sample, recording `fullLiveMatrix: false` and why each weaker proof applies.
- A hand-written bundle can no longer claim a proof it has no evidence for on this probe, which previously had no validator checks at all.
- The reachability arguments are tenant-specific evidence, not Microsoft guarantees. A tenant that does hold a reference or an undownloadable item produces `live_source_entry` or it fails.
- The census is as wide as the route's source root children, not the whole library. A sample outside that scope is invisible to it, which is the same scope the suite accepts samples from.
