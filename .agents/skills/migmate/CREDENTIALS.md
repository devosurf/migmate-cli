# Credentials and discovery

Operator config holds **credential references**: typed pointers to operator-owned files, resolved just in time. Keep secret values out of config, out of issues, out of commits, and out of your own output — a reference is the thing to pass around. A reference file must be a regular file owned by the invoking user with no group or other permission bits — `0600`, or stricter — and a `mode` stated in the reference must read exactly `0600`.

`scripts/stage1-prereqs.sh` (file route) and `scripts/archive-prereqs.sh` (archive route) walk a human through tenant setup and write those files. Both accept `--resume <env-file>`. These are human steps; hand them over rather than attempting the tenant work.

For file-job delegation, set top-level `impersonate = true` and `subject` in job
TOML, before any table header. Have a Workspace admin authorize the service account's
numeric client id with only `https://www.googleapis.com/auth/drive`; use an ordinary
non-admin subject with destination access. Migmate cannot check admin status without
Admin SDK scopes and never requests them. The key is domain-wide: do not describe
it as restricted to the subject. `doctor` proves token issuance and exact
`about.user.emailAddress`; delegation refusals name the fix. Keep `impersonate` out
of rclone.conf: Migmate injects it per mapping and refuses operator-file overrides.
Read back the plan's acting account before approval, and hand the closing report's
open key/delegation deletion items to the administrator. With impersonation off,
the service account acts as itself; the plan and report name its email address
observed in preflight. See README's **Acting Google account**.

The rclone remotes need no seed root. `drive_id`, `team_drive` and `root_folder_id`
are optional because every pass overrides them with the approved mapping's roots;
leave them out, especially when the manifest creates the destination drive. A value
that is present must still be a stable ID or onboarding refuses
`credential_config_invalid`.

### SharePoint source discovery

Use exactly one source-app grant: `Sites.Selected` with a read grant per site for
small jobs, or `Sites.Read.All` for tenant-scale reads and discovery. Both together,
`Files.Read.All`, write roles and other extra roles refuse. A leaked scoped key
reaches granted sites; a leaked tenant-read key reaches every site, including sites
outside the job. Surface that tradeoff before asking an administrator to replace
the grant; Migmate never widens it automatically.

For a SharePoint-source file job with no mappings, onboard the route/options and
`[rclone]` config with `creds init --job ID --config job.toml --output json`, then run
`discover --job ID --file draft.json --output json`. Read `value.sites` and
`value.manifest`; the optional new private file contains only the manifest and
refuses overwrite. Without `--file`, the same draft remains in the envelope.
Discovery covers subsites too, and skips personal OneDrive sites. Review each proposed
`Site name (host/site path) - Library name`, remove unwanted libraries, and
fill in `members` before explicitly running `manifest load`. A site Graph returns
unnamed (the classic Search Center, for one) is labelled from its URL path segment or
host, and an unnamed library by its drive ID.
Discovery neither loads nor provisions; human plan approval still gates creation.
Empty discovery produces an empty draft, which cannot be loaded until it has a mapping.

On `preflight_failed` with `detail.check: discovery_requires_sites_read_all`,
surface `detail.requiredGrant: Sites.Read.All`. Keep `Sites.Selected` and author
the manifest manually, or hand the tenant-wide grant decision to the administrator.

On `preflight_failed` with `detail.check: discovery_response_invalid`, Graph returned
a site, library or page discovery cannot trust. It is a defect report, not a tenant
prerequisite: hand `detail.object`, `detail.field` and the named `siteId`, `webUrl` or
`route` to the Migmate maintainers together with `migmate --version`.

On `preflight_failed` with `detail.check: discovery_request_failed`, read
`detail.status`. `401`/`403` means the source app cannot read `detail.siteId` (or, without
one, `detail.route`): hand it to the administrator. `429`, `5xx` or `0` means Graph throttled or was
unreachable; discovery writes nothing, so rerun it later, and report a repeat with
`migmate --version`.
