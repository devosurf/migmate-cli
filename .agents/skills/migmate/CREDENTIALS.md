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

### Dropbox source authorization

For Dropbox → Shared Drives, hand app creation and consent to a Dropbox team
administrator. Use a scoped **Full Dropbox** app, with only these permissions:
`account_info.read`, `files.metadata.read`, `files.content.read`, `team_data.member`.
These are the requested minimum. Existing grants may additionally contain the known
read-only scopes `sharing.read`, `team_info.read`, `team_data.content.read`, and
`members.read`; Migmate does not request those unnecessary permissions.
Full Dropbox selects the accessible content; these scopes constrain operations.
Use the administrator's **team-member ID** (`dbmid:…`), not their email.

Prepare an owner-only rclone file outside the engine home with the Google destination
remote and this source seed:

```ini
[dropbox-source]
type = dropbox
client_id = DROPBOX_APP_KEY
impersonate_admin = dbmid:ADMIN_TEAM_MEMBER_ID
export_formats = html
```

The job config names `sourceProvider = "dropbox"`,
`destinationProvider = "google_shared_drive"` and, under `[rclone]`,
`dropboxRemote = "dropbox-source"` plus `destinationRemote` and the existing typed
`config` file reference. There is no Dropbox app secret to paste into job config.
`creds init` validates and persists these pair-specific remote bindings; Dropbox
does not also require a SharePoint `sourceRemote`.
Persisted Dropbox mappings retain `/` for the namespace root or the provider's
immutable `id:…` folder identity. Credential reconstruction validates these
Dropbox-specific identities without relaxing other providers' ID rules.

Have the administrator run `migmate creds init --job ID --config job.toml` in a
terminal, open the displayed URL in their browser, approve the app, and paste the
authorization code into the command. Migmate uses single-use S256 PKCE with offline
access. It writes the refresh token and initial authorization-code response's scope
proof only to the referenced credential file. Job config, events and evidence
contain no token or pasted code. The file must be writable (`0600`) for onboarding
and rclone's token refresh; subsequent reads accept stricter owner-only permissions.

Observe `doctor` after consent. Its Dropbox credential evidence names the app,
team, acting administrator and granted scopes, with `scopeEvidence:
authorization_code`. A successful refresh is authentication, not fresh permission
introspection: Dropbox need not repeat scopes on refresh. Preserve the generated
`migmate_scope_proof` field when rclone refreshes its token; its refresh-token digest
binds the saved initial grant to the credential. Operator-owned evidence is not a
tamper-proof audit log.

During PLAN, `users/features/get_values` observes `paper_as_files` for this selected
administrator using `Dropbox-API-Select-User`, rather than the namespace-read
Select-Admin context. The plan freezes the observation even when true, and the
report uses the frozen evidence. False produces a nonblocking outside-namespace
legacy-Paper notice; true produces no legacy notice; unknown produces a nonblocking
could-not-check notice, not a credential refusal or acceptance requirement.
True describes the creation model, not proof that pre-migration legacy documents
are absent. See [FINDINGS.md](FINDINGS.md) for the coverage limit.

Any write or unknown scope, missing proof, or substituted app/refresh token refuses
`credential_permissions_invalid`; importing a token from `rclone config` is not
read-only proof. For a changed grant, have the administrator revoke the old
authorization, prepare a new source credential file and repeat `creds init`.
`shared_folders` is forbidden even when set to false: that backend mode can mount
folders and mutate the source. `impersonate`, app secrets, custom OAuth endpoints
and export-hiding overrides also refuse. Already-proven credentials can onboard
without another browser prompt; first authorization without a terminal refuses
`credential_interaction_required`.

### SharePoint source discovery

Use exactly one source-app grant: `Sites.Selected` with a read grant per site for
small jobs, or `Sites.Read.All` for tenant-scale reads and discovery. Both together,
`Files.Read.All`, write roles and other extra roles refuse. A leaked scoped key
reaches granted sites; a leaked tenant-read key reaches every site, including sites
outside the job. Surface that tradeoff before asking an administrator to replace
the grant; Migmate never widens it automatically.

For a SharePoint-source file job with no mappings, onboard the provider pair/options and
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
