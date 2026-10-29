# ADR-0020: Discovery proposes capacity-aware partitions by access boundary

- Status: accepted
- Date: 2026-10-29
- Accepted: Morgan, 2026-10-29, after a grilling session and explicit confirmation of the complete design. Implementation is tracked in map [#108](https://github.com/devosurf/migmate-cli/issues/108).
- Amends: [ADR-0014](0014-map-approval-and-listing-verification.md): a mapping may cover only its root's direct files, and several mappings may share one created container. Plans still bind the map, without a planning scan.

Destination containers have hard item limits. A Shared Drive holds 500,000 items, counting folders, shortcuts and trash, and Google refuses further items with `teamDriveFileLimitExceeded`. Migmate counts nothing at planning (ADR-0014 binds only the map) and treats that refusal as an ordinary failed pass. A 17M-file source needs at least 34 Shared Drives. We make `discover` count the source and propose a partitioned draft manifest for the operator to review; the plan still binds only the reviewed map.

This records an accepted decision, not shipped behavior. Commands, runtime and operator documentation stay unchanged until it is implemented.

## Decisions

### D1: Discovery counts every source provider

`discover` works for Dropbox, Google and SharePoint sources and counts files and folders per access boundary, with Dropbox namespaces deduplicated by namespace ID. Counting is read-only discovery, separate from the plan, and its counts are a point-in-time observation.

### D2: Partition by access boundary first, then size

An access boundary is source content that shares one membership: a Dropbox team folder or shared folder, a Shared Drive, or a SharePoint library or folder with unique permissions. A boundary maps to one container when it fits. Membership applies to a whole container, so packing by size alone would mix audiences.

### D3: Capacity targets keep headroom

By default, the capacity target is 80% of the destination provider's hard item limit, counting files and folders (400,000 for a Shared Drive). It can be overridden per destination. The headroom absorbs deltas and trash. Desktop-sync guidance is not applied by default; the override expresses it where people will sync the destination.

### D4: Oversize boundaries split by subfolder

A boundary over its target splits by subfolder across several containers. A files-only mapping, which covers only the files directly inside its root, carries the files directly inside the split folder. Approval still binds exactly what is copied, and ADR-0014's rejection of filter-based exclusions stands.

### D5: Identical memberships share a container

Several mappings may target one created container, each as its own folder. Discovery groups boundaries with identical membership into one container rather than creating one container per small boundary. Equal or nested destination roots still overlap and refuse.

### D6: Discovery output is a draft

`discover` writes a draft manifest for review. It does not load, provision or translate access automatically. The operator reviews the draft, and the plan binds the reviewed map.

### D7: Mirror deletions keep going to trash

Mirror deletions still go to the destination's trash, keeping deleted files recoverable. The capacity target's headroom absorbs trashed items.

## Considered alternatives

- **Agent-computed partitions:** rejected. They are not repeatable or testable, and they leave no reviewable artifact.
- **Packing by size alone:** rejected (D2).
- **Capacity checks inside `plan`:** rejected. That needs a planning scan, which ADR-0014 removed; discovery is where counting belongs.
- **Exclusions instead of files-only mappings:** rejected, as in ADR-0014.
- **One container per boundary:** rejected. Many small shared folders would become thousands of containers.
- **Permanent mirror deletion:** rejected. Capacity headroom already exists, and deletion would be irreversible.

## Implementation consequences

Implementation is tracked in [#114](https://github.com/devosurf/migmate-cli/issues/114). It adds files-only mappings and shared created containers to the manifest, and uses provider hard limits for Dropbox team folders and SharePoint libraries that are still to be established (map [#108](https://github.com/devosurf/migmate-cli/issues/108), "Not yet specified"). Release limits and the migmate skill change with the implementation.
