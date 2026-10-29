# ADR-0018: File routes are provider pairs across Dropbox, Google Drive and SharePoint

- Status: accepted
- Date: 2026-10-29
- Accepted: Morgan, 2026-10-29, after a grilling session and explicit confirmation of the complete design. Implementation is tracked in map [#108](https://github.com/devosurf/migmate-cli/issues/108).
- Amends: [ADR-0003](0003-site-scoped-file-route.md), for the source/destination credential split on every provider and the Google → Google server-side copy exception; [ADR-0010](0010-rclone-executes-file-transfers.md), for server-side copy and stored-hash verification on same-provider routes; [ADR-0012](0012-staged-migrations-and-access-timing.md), for go-live access on containers created on every provider; [ADR-0014](0014-map-approval-and-listing-verification.md), for hash verification by default on same-provider routes.

Migmate has two named file routes, SharePoint library ↔ Google Shared Drive. Provider-specific branches run through the engine, and the credential loader accepts only `onedrive` and `drive` remotes. The next project moves about 17M files and 120 TB from Dropbox to Shared Drives, and later projects can run between any of Dropbox, Google and SharePoint. We make a supported route a pair of providers, each implemented once as an adapter, instead of adding named routes one at a time.

This records an accepted decision, not shipped behavior. Commands, runtime and operator documentation stay unchanged until each part is implemented.

## Decisions

### D1: A supported route is a provider pair

The providers are Dropbox (team content), Google Drive (Shared Drives) and SharePoint (document libraries). Every ordered pair becomes a supported route once its adapters ship: nine directions, including same-provider pairs within one tenant or between two. A job still copies in one direction, fixed for all its mappings. Teams archive jobs are unaffected.

### D2: One adapter per provider

Each provider's adapter owns credential onboarding and proof, preflight, root resolution, rclone remote construction, listing and hash capabilities, container creation, membership and grants, and discovery. Lifecycle, approval, verification and reporting stay provider-neutral.

Job configuration names its source and destination provider. A configuration that still names a `route` refuses and points to the provider-pair form, the same clean cutover ADR-0014 applied to removed options. Existing job stores, frozen plans and reports stay readable.

### D3: Shared containers only

A container is the shared storage unit a provider grants access to as a whole: a Shared Drive, a Dropbox team folder, or a SharePoint document library. Personal storage (Dropbox member folders, My Drive, OneDrive) is out of scope: it needs per-user destinations and identity mapping, which is a separate route family.

### D4: Read-only sources and separate write credentials

Every provider has a read-only source credential and a separate destination write credential. Reusing the source app for writes refuses, and Migmate never requests a wider grant.

Dropbox team access needs an administrator to approve the app once in a browser, and the granted scopes appear only in the token response. `creds init` therefore runs the PKCE authorization-code flow with offline access itself (the administrator pastes back the code), records the granted scopes, and refuses a source app that holds any write scope. rclone's `shared_folders` option refuses because mounting a shared folder changes the source. Google's delegated identity can already write wherever it is a member; Google sources keep today's model.

### D5: Dropbox source content

Dropbox namespaces are deduplicated by namespace ID, so a shared folder mounted under different names in several members' homes is one source. Paper documents export as `.html`, and plan and report disclose the conversion. Legacy Paper documents and exports rclone cannot download raise one blocking finding per file, because a document that did not migrate is lost content. `.web` files only point to Google-hosted content; they copy as-is with a non-blocking disclosure.

### D6: Proof depends on the route kind

Cross-provider routes keep ADR-0014: listing verification by path and size, with hash verification opt-in. Hash verification downloads the source and computes the destination's hash type, whether quickXorHash, Dropbox content hash, SHA-256 or MD5.

Same-provider routes default to hash verification, comparing the hashes both sides store without downloading. SharePoint → SharePoint keeps the existing rewrite rule for PDF, Office and HTML files.

### D7: Containers and go-live access on every destination

Migmate creates Shared Drives, Dropbox team folders, and SharePoint document libraries inside existing sites. It never creates SharePoint sites, which is tenant administration. Creation keeps the creation-intent recovery and provenance rules, and mirror stays limited to containers with proven creation provenance.

Created containers on every provider follow the same go-live lifecycle: manifest members, the fence, grants at go-live, membership checks and acknowledgment (ADR-0012, ADR-0015, ADR-0017). Manifest roles use the shared set `reader`, `writer` and `manager`, which the destination adapter maps to native roles. Native roles the destination supports, such as Google's `commenter` and `fileOrganizer`, stay valid so existing manifests keep their meaning. A role the destination cannot represent refuses at manifest load. A SharePoint library gets unique permissions only when the manifest names members.

### D8: Name and path conflicts are findings, never renames

Some destinations are stricter than their source: Google allows duplicate names, Dropbox is case-insensitive, SharePoint restricts characters and path length, and Shared Drives allow 100 folder levels. Every path that conflicts with the destination raises a blocking finding, to be fixed in the source or explicitly accepted. Migmate never renames automatically.

### D9: Destination limits that stop a job

Dropbox's monthly upload-call limit (HTTP 403 `invalid_account_type/feature`, counted per team and reset on the first of the month) stops the job as blocked, like Google's daily upload limit, with the first of the next month as the resume estimate. Dropbox uploads are batched to limit write contention on a namespace.

### D10: Same-provider routes

Same-provider routes copy files only; identity, mailbox and domain cutover stay in [#86](https://github.com/devosurf/migmate-cli/issues/86). Within one tenant, source and destination still use separate credentials.

Only Google → Google inside one Workspace copies server side, because the delegated identity already holds that authority. Dropbox and SharePoint same-tenant routes stream through the host, since server-side copy would need write scopes on the source app and end the read-only source proof.

## Considered alternatives

- **More named routes:** rejected. Nine named routes would multiply the provider branches already spread through the engine.
- **Generic rclone remotes:** rejected. Per-provider proof of credentials, roots, hashes and quirks is what Migmate adds; the exact rclone pin exists because of one backend's quirk.
- **Importing a Dropbox token made by `rclone config`:** rejected. Its scopes cannot be observed, so read-only source proof would only be a claim.
- **Automatic renames:** rejected. The report must name what moved where.
- **Server-side copy on every same-tenant route:** rejected for Dropbox and SharePoint (D10).

## Implementation consequences

Implementation is tracked in [#110](https://github.com/devosurf/migmate-cli/issues/110) (provider adapters), [#111](https://github.com/devosurf/migmate-cli/issues/111) (Dropbox → Google), [#112](https://github.com/devosurf/migmate-cli/issues/112) (Dropbox and SharePoint as destinations) and [#113](https://github.com/devosurf/migmate-cli/issues/113) (same-provider routes), after [#109](https://github.com/devosurf/migmate-cli/issues/109) implements ADR-0014. Release limits and the migmate skill change with each implementation. Research input: [Dropbox to Google Shared Drives at scale](../research/dropbox-to-shared-drives-at-scale.md).
