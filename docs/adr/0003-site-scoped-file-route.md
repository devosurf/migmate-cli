# ADR-0003: The file route is site-scoped, not tenant-wide

- Status: accepted
- Date: 2026-09-15
- Context: [credential onboarding decision #15](https://github.com/devosurf/migmate-cli/issues/15), [spec #17](https://github.com/devosurf/migmate-cli/issues/17), [release qualification #25](https://github.com/devosurf/migmate-cli/issues/25)

## Context

Decision #15 chose `Files.Read.All` + `Sites.Selected` for the file migration source app, reasoning only about what it rejected: `Sites.Read.All`, because v1 never searches for a site and the operator supplies exact ids. It never established that `Files.Read.All` was needed. The engine encoded that pair as a closed set: the token must carry every role in it and nothing else.

The first live tenant refused on exactly that. Its app holds `roles: ["Sites.Selected"]`, and preflight failed `provider.credentials` with `credential_permissions_invalid` while every other check passed, including the exact managed transfer binary.

Sites.Selected alone serves the whole route. Against the granted site, `GET /v1.0/drives/{driveId}`, `/items/{itemId}/children`, and `/items/{itemId}/delta` all answered 200, and rclone's `onedrive` backend listed the library with the same credential. Nothing in the file route reads a file outside the site the operator explicitly granted.

`Files.Read.All` is tenant-wide read of every file in the tenant. Decision #15 says so itself, in the archive section: it "grants tenant-wide file read, so onboarding must never request it by default". Requiring it for the file route contradicted that principle inside one document.

## Decision

**The file route requires `Sites.Selected` and nothing else.** `FILE_ROLES` holds exactly that role, so the existing closed-set rule now refuses a token that carries `Files.Read.All` instead of demanding it. An operator who already granted the pair must remove the tenant-wide grant; the refusal names it rather than silently accepting more access than the route needs.

**One privilege level, not two.** Tolerating either grant would leave the qualified-route evidence unable to pin which permissions a route was proven against, so the wider grant is refused rather than permitted.

**The optional rclone `access_scopes` value follows `FILE_ROLES`** instead of repeating a second hardcoded scope string.

The archive route is untouched: its roles stay as #15 resolved them, including `Files.Read.All` only when `attachmentBytes` is requested.

## Consequences

- The source grant is now the least privilege the route can run on: read on exactly the granted site, and the tenant's other content is unreachable even if the credential leaks.
- Tenants onboarded against the old requirement fail `doctor` with `credential_permissions_invalid` until the tenant-wide grant is removed. That is a deliberate refusal, not a compatibility break to paper over: no job ever ran on this path, since the loader could not read a real client secret at all before today.
- The prerequisite wizard's consent stage, which already instructs `Sites.Selected` only, is now consistent with what the engine enforces.
- Re-adding `Files.Read.All` means re-opening this ADR and #15 together, and re-running route qualification, because the qualified-route tuple binds the granted permission set.
