# Dropbox as a migration destination

This note extends [`dropbox-to-shared-drives-at-scale.md`](dropbox-to-shared-drives-at-scale.md), which covers Dropbox as a **source**: namespaces, read scopes, request limits, case-insensitivity and upload-size boundaries. It does not repeat those findings. It answers six questions about **writing into Dropbox team folders** with the pinned rclone **v1.75.0** (the Dropbox backend `backend/dropbox/dropbox.go` and its batcher), for [ADR-0018](../adr/0018-provider-pair-file-routes.md) D4 (separate write credential), D7 (create the container, fence it until go-live), D8 (name/path conflicts block) and D9 (monthly upload limit stops the job).

It is fact-finding. No authenticated Dropbox call was made, and nothing was written to a Dropbox team. **[INFERENCE]** labels a derived consequence; **[UNVERIFIED]** labels something no primary source states. Documentation was retrieved on 2026-11-01. The Dropbox API specification is cited at commit [`2de2f5b`][spec-commit] of `dropbox-api-spec` (`main`). The `master` branch is stale: it lacks `quota_limit`, `folder_count_limit_exceeded` and `has_distinct_member_homes`.

## Short answers

| Question                                                                                                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Sources                                                                          |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1. Does rclone v1.75.0 work as a Dropbox write target, and how does it behave?                                | Yes. It uploads with `files/upload` for small files without batching, and otherwise with `upload_session/start` → `append:2` → `finish_batch:2`. The default `batch_mode` is **`sync`**, so every file, even a 1-byte file, takes the session route (≥ 2 counted calls plus a share of one `finish_batch`). It always commits with `mode=overwrite`, never `add`/autorename. It has no partial-upload temp names. `Mkdir` is a no-op at the root and uses `create_folder_v2` below it. To write into a team folder, set `root_namespace` to the team folder's namespace ID (sent as `Dropbox-API-Path-Root: {".tag":"namespace_id",…}` on every call) and, for an admin-run team, `impersonate_admin`. Errors are classified only by substring: `insufficient_space` is fatal, `malformed_path` is no-retry, and everything else is retried, including the monthly-limit 403.                                                                | [rclone-update], [rclone-batcher], [rclone-retry], [rclone-ns], [rclone-options] |
| 2. Which APIs create and manage a team folder, and is there a fence?                                          | `team/team_folder/create` (scope `team_data.content.write`, args `name`, optional `sync_setting`) creates an _active_ team folder. It works **only if** `has_team_shared_dropbox` is false. Dropbox's own guide says a folder created this way "doesn't give access to anyone automatically, not even to the Dropbox team administrators". That is the closest thing to a built-in fence: **no member sees it until `sharing/add_folder_member` adds a group**. The API gives no request key, so `create` is not idempotent; recover by `team_folder/list` and match on `name`. On a team-space team (`has_team_shared_dropbox=true`), `create`, `archive`, `activate`, `rename` and `permanently_delete` fail with `team_shared_dropbox_error/disallowed` or `invalid_account_type/feature`. Top-level folders are made with `files/create_folder_v2` under the team-root namespace instead, and there is **no documented fence** for them. | [team-folder-create], [team-files], [spec-team-create], [spec-team-status]       |
| 3. How do I grant and check membership?                                                                       | Grant with `sharing/add_folder_member` (scope `sharing.write`, `Dropbox-API-Select-Admin`: `team_admin`): `shared_folder_id` = the `team_folder_id`, `members:[{member:{".tag":"dropbox_id","dropbox_id":"g:…"},access_level:{".tag":"editor"}}]`. Team-folder roots take **groups**, not individual users. Check with `sharing/list_folder_members` (scope `sharing.read`, `whole_team` admin mode), reading `groups[].group.group_id` and `access_type`, plus `users` and `invitees`. `AccessLevel.owner` is not allowed in `add_folder_member`. Failures are `bad_member` (`automatic_group`, `group_not_on_team`, `invalid_group`, `group_deleted`, …), `no_permission`, `access_error`, `too_many_members` and others. **The result of `list_folder_members` on a brand-new team folder (is it empty, or does it show the admin or team?) is [UNVERIFIED].**                                                                            | [team-files], [add-member], [list-members], [spec-sharing-add]                   |
| 4. Which OAuth scopes does the WRITE app need?                                                                | Data plane: `files.content.write` (all upload, session and `create_folder`/`delete`/`move` routes) and `files.metadata.read` (existence checks, hashes, listing). Control plane: `team_data.content.write` (create/rename/archive/activate/delete team folder), `team_data.content.read` (`team_folder/list`, `get_info`), `team_info.read` (`team/features/get_values`, `token/get_authenticated_admin`), `sharing.write` and `sharing.read` (membership), `team_data.member` (required for Select-Admin on a team token, and for `team/namespaces/list`), `groups.read`/`groups.write` if Migmate creates or inspects the access group, `members.read` only to resolve admin IDs. rclone's _own_ default scope set is wider (`files.metadata.write`, `files.content.read`, `account_info.read`, `sharing.write`) and does not match the D4 "never request wider" rule.                                                                     | [scopes], [rclone-oauth], [spec-files-scopes], [spec-team-scopes]                |
| 5. What destination name and path rules apply?                                                                | Case-insensitive and case-preserving. The default rclone encoding is `Slash,BackSlash,Del,RightSpace,InvalidUtf8,Dot`, so `/`, `\`, DEL, a trailing space, invalid UTF-8 and dot-only names are rewritten rather than refused. rclone refuses six reserved names client-side (`desktop.ini`, `thumbs.db`, `.ds_store`, `icon\r`, `.dropbox`, `.dropbox.attr`), without failing the run, and refuses any path component over 255 **runes**. The API's own name rejection is `WriteError.disallowed_name`, `malformed_path` and `WriteConflictError`. No API path-length or depth limit is documented. **The size limits that matter are `team_folder_insufficient_space` (per-folder `quota_limit`) and `folder_count_limit_exceeded`.**                                                                                                                                                                                                      | [rclone-names], [spec-write-error], [names], [path-case]                         |
| 6. What does the monthly upload-call limit look like, and how does Migmate detect it before and during a run? | It is a **per-team count of calls**, not bytes, shared by all apps. Exceeded: HTTP **403** `invalid_account_type/feature` with a `user_message` ("Your team has used all of its data transport API calls for the month…"). Exactly nine routes count: `upload`, `upload_session/start`, `append` (deprecated), `append:2`, `append_batch`, `finish`, `start_batch`, `finish_batch` (deprecated) and `finish_batch:2`. Check beforehand with `team/features/get_values` and `features:[{".tag":"upload_api_rate_limit"}]`: the answer is `unlimited` or `limit` with a `UInt32`. The reset is "the 1st day of every month"; the time zone is **[UNVERIFIED]**. **rclone does not recognise this error.** It retries it like any generic failure, so Migmate must detect it itself (see §6).                                                                                                                                                   | [transport], [spec-feature], [spec-transport-routes], [error-handling]           |

## Evidence boundaries

- Facts about rclone come from the v1.75.0 source (tag `v1.75.0`; `go.mod` pins `github.com/dropbox/dropbox-sdk-go-unofficial/v6 v6.4.0`, [rclone-gomod]). The SDK's behaviour is read from that module's source (`dropbox/sdk.go`, `dropbox/auth/sdk.go`, `dropbox/files/types.go`), cited as `sdk-v6.4.0` by path because the module is not linkable by line.
- Facts about Dropbox come from the reference pages and the API specification. The reference pages are rendered by JavaScript and several truncate, so the stone files are used for exact field names, scopes and error tags.
- The Dropbox team-folder help article was read for context. It describes the admin UI, not the API, and is **not** used as evidence for API defaults.
- Nothing here was observed on a live team. §7 lists what a live check must settle.

## 1. rclone v1.75.0 as a write target

### Upload route

`Object.Update` ([L2178-L2220][rclone-update]) refuses reserved names, sets `commitInfo.Mode.Tag = "overwrite"`, rounds `client_modified` to the second, runs `checkPathLength`, and then chooses a route:

- `size > chunk_size || size < 0 || batcher.Batching()` → `uploadChunked` ([L2026-L2146][rclone-update]): `upload_session/start`, one or more `append:2`, then either `upload_session/finish` or, when batching, a hand-off to the batcher.
- otherwise → a single `files/upload` call. This happens only with `batch_mode=off` and a file no larger than `chunk_size`.

`chunk_size` defaults to **48 MiB** and may not exceed **150 MiB** ([L90-L91][rclone-chunk]). `uploadChunked` sets `Close` on the only append of a known-size file that fits one chunk, so a small file costs start + one append (+ its share of a batch finish).

`mode=overwrite` means a second run replaces a destination file at the same case-insensitive path without a conflict. rclone's `Features` for the Dropbox backend ([L610-L614][rclone-features]) do not set `PartialUploads`, so `operations.Copy` writes directly to the final name (`checkPartial`, [copy.go L90-L115][rclone-copy-partial]). There are no `.partial` objects to clean up.

### Batch mode

| Item          | v1.75.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Option        | `batch_mode`: `off`, `sync` (**default**), `async`. [dropbox.md L566-L590][rclone-dropbox-doc]                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Commit route  | `upload_session/finish_batch:2` (`UploadSessionFinishBatchV2`). [dbx_batcher.go L17-L34][rclone-dbx-batcher]                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sizing        | `defaultBatcherOptions`: max 1000, async default 100, timeouts 500 ms (sync) / 10 s (async). In `sync` mode the size defaults to `--transfers`. [L133-L138][rclone-batch-opts], [lib/batcher L72-L96][rclone-lib-batcher]                                                                                                                                                                                                                                                                                                                                    |
| Concurrency   | The source comment says Dropbox allows many batches to be started but only one to be committing at a time. [dbx_batcher.go L1-L8][rclone-dbx-batcher]                                                                                                                                                                                                                                                                                                                                                                                                        |
| Error surface | Per file: `batch upload failed: upload failed: <tag>[/<lookup tag>][/<path tag>]`. The top-level tag is the `UploadSessionFinishError` tag (e.g. `too_many_write_operations`, `payload_too_large`, `content_hash_mismatch`) and `path/<WriteError tag>` for write errors (`path/team_folder_insufficient_space`, `path/upload_traffic_limit_reached`). Per batch: `batch had N errors: last error: …`. [dbx_batcher.go L55-L68][rclone-dbx-batcher], [lib/batcher L155-L180][rclone-lib-batcher], [sdk-v6.4.0 `UploadSessionFinishError`][spec-finish-error] |
| `async`       | Results are not waited for: `Update` returns with a fabricated metadata entry (`hash=""`, size and time from the source), so a failed commit does not fail the file. The rclone docs advise a final `sync` pass or `rclone check`. [L2203-L2216][rclone-update], [dropbox.md L181-L202][rclone-dropbox-doc]                                                                                                                                                                                                                                                  |

**[INFERENCE]** Migmate should run `sync`, not `async`: an `async` run cannot report which files failed, which gives nothing to verify against. Because `sync` ties the batch size to `--transfers`, the number of files committed per `finish_batch` call is a Migmate setting, not a Dropbox one.

Batch errors that come back as a per-file `errors[i]` are plain `fmt.Errorf` values. They are not wrapped as `RetryError` or `FatalError`, so, unlike the unbatched path, `team_folder_insufficient_space` in a batch is **not** converted to a fatal error by the `insufficient_space` substring check. **[INFERENCE]** from reading [dbx_batcher.go L55-L68][rclone-dbx-batcher] and [copy.go L309-L345][rclone-copy-loop]; not exercised.

### Addressing a team folder

Two documented ways reach a team folder:

1. A path with a leading `/`: `remote:/TeamFolder/path`. `NewFs` calls `users/get_current_account` and uses the account's `RootInfo.root_namespace_id` as the namespace. [dropbox.md L92-L107][rclone-dropbox-doc], [dropbox.go L669-L691][rclone-ns]
2. `root_namespace=<namespace id>` ([L319-L324][rclone-options]). When set, `NewFs` skips `get_current_account` and every SDK call gets `Dropbox-API-Path-Root: {".tag": "namespace_id", "namespace_id": "<id>"}` ([headerGenerator L711-L718][rclone-ns]). Paths are then relative to that namespace, and `Mkdir` of the root (`"/"`) is a no-op ([L1224-L1236][rclone-mkdir]).

**[INFERENCE]** Option 2 is the right fit for a destination. The `team_folder_id` returned by `team_folder/create` has type `common.SharedFolderId`, the same type as `NamespaceMetadata.namespace_id` for a `team_folder` namespace ([spec-team-meta], [spec-namespace]). The docs do not say in words that they are the same number, so confirm it with `team/namespaces/list` on the first folder. A wrong ID fails safely: `Dropbox-API-Path-Root` with an inaccessible namespace gives `PathRootError.no_permission`, and with a stale root `invalid_root` ([common.stone L69-L75][spec-pathroot]).

`impersonate_admin` is an exact-ID option ([L220][rclone-options], [`Select-Admin` header at sdk-v6.4.0 `sdk.go` L303-L306]) that takes a **team member ID**, not an email. `impersonate` (email, needs `members.read`) is not needed. The write calls support admin mode: every upload, session, batch, `create_folder:2`, `delete:2`, `move:2` and `copy:2` route is annotated `select_admin_mode = "team_admin"` ([spec-files-scopes]).

### Hashes and verification

`Hashes()` returns only `DropboxHash` ([L1756-L1758][rclone-hashes]). Against a Google or SharePoint source there is no common hash, so rclone compares sizes, as the existing note already says. Modification times can only be changed by re-uploading ([dropbox.md L109-L122][rclone-dropbox-doc]).

### Error classification

`shouldRetryExclude` ([L449-L469][rclone-retry]) matches the error **string**: `insufficient_space` → `FatalError`; `malformed_path` → `NoRetryError`; anything else → retry. `shouldRetry` ([L473-L492][rclone-retry]) adds: `RateLimitAPIError` with `retry_after > 0` → `pacer.RetryAfterError`; strings `too_many_write_operations`/`too_many_requests`; otherwise `fserrors.ShouldRetry`. `AccessAPIError`, which the SDK returns for every 403, is not special-cased. Its `Error()` is the JSON `error_summary`, so a monthly-limit failure reads `invalid_account_type/feature/.` ([sdk-v6.4.0 `auth/sdk.go` L16-L21, L69-L74; `sdk.go` L58-L65]).

## 2. Team folder creation, lifecycle and the fence

### Which model is the team on?

Check first with `team/features/get_values`, `features: [{".tag":"has_team_shared_dropbox"}, {".tag":"has_distinct_member_homes"}, {".tag":"upload_api_rate_limit"}]` (scope `team_info.read`). One call returns all three. `FeaturesGetValuesBatchArg.features` may not be empty (`empty_features_list`). [spec-feature]

| `has_team_shared_dropbox`   | Meaning and what Migmate can do                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `false` (team-folder model) | Team folders are the top-level containers. Use `team_folder/*`.                                                                                                                                                                                                                                                                                                                                                                      |
| `true` (team-space model)   | One team-root namespace holds member homes and team folders. `team_folder/create`, `archive`, `activate`, `permanently_delete` and `rename` fail with `team_shared_dropbox_error/disallowed` or `invalid_account_type/feature`. `team_folder/list` and `get_info` return only the team space. Create top-level folders through the files API, with `Dropbox-API-Path-Root` **and** `Dropbox-API-Select-Admin` both set. [team-files] |

**[INFERENCE]** For ADR-0018 D7, "create a Dropbox team folder" is two different operations depending on this flag. The second model has no `team_folder_id`, so a folder-level `quota_limit` and the access fence below may not apply to it. Treat `true` as a separate, explicitly disclosed path, or refuse it until it has been tested.

### The routes (all team-linked auth)

| Route                                   | Scope                     | Notes ([spec-team-routes])                                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `team/team_folder/create`               | `team_data.content.write` | "Creates a new, active, team folder with no members. This endpoint can only be used for teams that do not already have a shared team space." Args: `name` (required), `sync_setting` (`default` or `not_synced`; needs team selective sync). Returns `TeamFolderMetadata`. |
| `team/team_folder/list` (+ `/continue`) | `team_data.content.read`  | `limit` 1–1000 (default 1000).                                                                                                                                                                                                                                             |
| `team/team_folder/get_info`             | `team_data.content.read`  | `team_folder_ids` (min 1) → per item `id_not_found` or `team_folder_metadata`.                                                                                                                                                                                             |
| `team/team_folder/rename`               | `team_data.content.write` | `invalid_folder_name`, `folder_name_already_used`, `folder_name_reserved`.                                                                                                                                                                                                 |
| `team/team_folder/archive` (+ `/check`) | `team_data.content.write` | "Sets an active team folder's status to archived **and removes all folder and file members**." May be async; `archive_in_progress` can persist after the job says complete.                                                                                                |
| `team/team_folder/activate`, `restore`  | `team_data.content.write` | `folder_count_limit_exceeded` possible.                                                                                                                                                                                                                                    |
| `team/team_folder/permanently_delete`   | `team_data.content.write` | Archived folders only. Irreversible: "not even Dropbox Support can revert". [team-files]                                                                                                                                                                                   |

`TeamFolderMetadata` ([L517-L542][spec-team-meta]): `team_folder_id`, `name`, `status` (`active` / `archived` / `archive_in_progress` / `inactive`), `is_team_shared_dropbox`, `sync_setting`, `content_sync_settings`, and `quota_limit` (Int64 bytes, 0 default).

**Create errors** (`TeamFolderCreateError`, [L577-L587][spec-team-create-error]): `invalid_folder_name`, `folder_name_already_used`, `folder_name_reserved`, `sync_settings_error`, **`folder_count_limit_exceeded`** ("The team has reached the maximum number of team folders allowed by its plan"), `other`. The plan's team-folder count is therefore a hard stop on creating containers.

### Idempotency and recovery

Neither `team_folder/create` nor `files/create_folder_v2` accepts a request key. `folder_name_already_used` is returned for an existing name, but it does not say whether _Migmate_ created it. **[INFERENCE]** This is the same problem as SharePoint's non-idempotent library creation (ADR-0018 D7), and the Google-style name/time recovery cannot prove provenance. The team folder has no description or tag field in which to leave a marker, so provenance is weaker here. A durable `creationAttemptedAt` record plus an exact-name match from `team_folder/list` is the most the API supports. Adopting a same-name folder cannot be proved to be Migmate's, so adoption stays a policy decision.

### The fence

What the documentation does and does not say about who can see a freshly created folder:

- **The Team Files guide** (the developer-facing primary source): "When you create a team folder programmatically, it doesn't give access to anyone automatically, **not even to the Dropbox team administrators**. You will need to add members to the team folder and configure its security settings after the folder has been created." [team-files]
- The route description says "with no members" ([spec-team-create]).
- The `active` status reads "available to all members" ([spec-team-status]). Taken alone this contradicts the guide. **[INFERENCE]** It describes what `active` means (as opposed to `archived`), not who has been granted access, since a team folder is shared with groups, not with "all members" ([team-folders-help]).
- The _help centre_ says that cancelling the UI creation flow leaves the folder "only visible to admins from the admin console". That is a UI flow, not API behaviour, and it disagrees with the guide on whether admins can see it.

**[INFERENCE]** The API default gives the fence for free _for end users_: grant no group until go-live and nobody but Migmate's writer can reach it. This is a consequence of two documents agreeing on "no members", not an observed behaviour. Before relying on it, a live check on a scratch team must show that a non-admin member's `team_folder`/`list_folder` view cannot see the folder, and that `list_folder_members` returns nothing for it.

**The open problem is the writer's own access.** If the folder has no members, "not even admins", the Select-Admin identity might not be able to write to it. Dropbox documents the `Dropbox-API-Select-Admin` team-admin mode as reaching "content of team folders and team spaces" ([auth-types]). Whether that includes a team folder with no members is **[UNVERIFIED]**. If it does not, the fallback is to add a **dedicated writer group** (containing only the Migmate admin/service identity) with `editor`, write through it, and add the real access group at go-live. That group is a fence too, but it makes membership a two-step change that ADR-0017 (pre-grant drift) must account for.

Other fence mechanisms, none verified for this use:

- `team_folder/archive` removes all members and makes the folder "not accessible outside of the team folder manager" ([spec-team-status]), but an archived folder presumably rejects writes. **[UNVERIFIED]**, and it is a poor fence.
- `sharing/update_folder_policy` sets `member_policy`, `acl_update_policy`, `viewer_info_policy` and `shared_link_policy` ([team-files]). `member_policy=team` and `shared_link_policy=team` limit leakage at go-live but do not hide the folder.
- `sync_setting=not_synced` keeps a new folder off members' desktops once it is shared; it does not hide it ([spec-sync-setting]).

## 3. Granting and checking membership

### Grant

`sharing/add_folder_member` ([L2736][spec-sharing-add]): `auth=user`, scope `sharing.write`, `select_admin_mode="team_admin"`. Args ([L2378][spec-sharing-add]): `shared_folder_id` (the `team_folder_id`), `members: List(AddMember)`, `quiet`, `custom_message`. `AddMember` = `member` (`MemberSelector`: `dropbox_id` or `email`) + `access_level` (`AccessLevel?`; `owner` disallowed). `dropbox_id` is documented as a "Dropbox account, team member, or group ID". The call returns `Void`: success carries no per-member result, so the grant must be verified by a read.

The Team Files guide is explicit that **team-folder roots take groups only**: "with team folders you cannot add individual users directly to the root folder; you are required to use groups" ([team-files]). Groups are created with `team/groups/create` (scope `groups.write`) and filled by `team/groups/members/add` ([spec-team-scopes]).

`AddFolderMemberError` tags: `access_error`, `email_unverified`, `banned_member`, `bad_member` (wrapping `AddMemberSelectorError`: `automatic_group` ("Automatically created groups can only be added to team folders"), `invalid_dropbox_id`, `invalid_email`, `invalid_group`, `unverified_dropbox_id`, `group_deleted`, `group_not_on_team`), `cant_share_outside_team`, `too_many_members` (value: the limit), `too_many_pending_invites`, `rate_limit` ("hit the limit of invites they can send per day. Try again in 24 hours"), `too_many_invitees`, `insufficient_plan`, **`team_folder`** ("This action cannot be performed on a team shared folder"), `no_permission`, `invalid_shared_folder` (deprecated). The `team_folder` tag appears to refer to a _shared team root_ ([L2006-L2037][spec-sharing-add]); its meaning for an ordinary team folder is **[UNVERIFIED]**.

Limits from the team-deployment page: 1,000 members per team folder, 1,000 members in a single path, 1,000 members per invite request ([deployments]).

### Change, remove and read

- `update_folder_member` (scope `sharing.write`): `shared_folder_id`, `member` (only `dropbox_id` may be set), `access_level`.
- `remove_folder_member` (scope `sharing.write`): asynchronous, polled with `check_remove_member_job_status`; `leave_a_copy` is a user-folder concept.
- `list_folder_members` ([L2915-L2921][spec-sharing-list]): `auth=user`, scope `sharing.read`, `select_admin_mode="whole_team"`. Args: `shared_folder_id`, `actions`, `limit` 1–1000 (default 1000), optional `path` for inherited members. Returns `SharedFolderMembers` = `users` (`UserMembershipInfo`: `user.account_id`, `user.team_member_id`, `access_type`, `is_inherited`), `groups` (`GroupMembershipInfo`: `group.group_id`, `group.group_name`, `group.member_count`, `access_type`), `invitees`, and `cursor`; page with `list_folder_members/continue`.

**[INFERENCE]** The verification Migmate needs at go-live is "exactly this group, at this role, and nothing else": read `list_folder_members` until the cursor is exhausted and compare `groups[].group.group_id` and `access_type`, and require `users` and `invitees` to be empty (or limited to the writer). The API does not state whether a team folder shows the team administrators as implicit `users`. **[UNVERIFIED]** — see §7.

## 4. OAuth scopes for the WRITE app

The scope names below come from `scope =` attributes in the `main` stone files ([spec-files-scopes], [spec-team-scopes], [spec-sharing-add]).

| Needed for                                | Routes                                                                                                  | Scope                          | Auth style                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------- |
| Upload data                               | `upload`, `upload_session/start`, `append:2`, `append_batch`, `finish`, `start_batch`, `finish_batch:2` | `files.content.write`          | user, `Select-Admin` `team_admin` |
| Create/delete/move/copy folders and files | `create_folder:2`, `create_folder_batch`, `delete:2`, `delete_batch`, `move:2`, `copy:2`                | `files.content.write`          | user, `team_admin`                |
| Existence, listing, hashes                | `get_metadata`, `list_folder`, `list_folder/continue`                                                   | `files.metadata.read`          | user, `whole_team`                |
| Team folder lifecycle                     | `team_folder/create`, `rename`, `archive`, `activate`, `permanently_delete`                             | `team_data.content.write`      | team                              |
| Team folder lookup                        | `team_folder/list`, `get_info`                                                                          | `team_data.content.read`       | team                              |
| Plan facts                                | `team/features/get_values`, `token/get_authenticated_admin`                                             | `team_info.read`               | team                              |
| Membership                                | `add_folder_member`, `update_folder_member`, `remove_folder_member`, `update_folder_policy`             | `sharing.write`                | user, `team_admin` for the first  |
| Membership read                           | `list_folder_members`, `get_folder_metadata`                                                            | `sharing.read`                 | user, `whole_team`                |
| Groups                                    | `groups/create`, `groups/members/add` / `groups/list`, `groups/members/list`                            | `groups.write` / `groups.read` | team                              |
| Namespace IDs                             | `team/namespaces/list`                                                                                  | `team_data.member`             | team                              |
| Admin impersonation on a team token       | the `Dropbox-API-Select-Admin` header                                                                   | `team_data.member`             | team                              |
| Resolve a member email to an ID           | `team/members/get_info`                                                                                 | `members.read`                 | team                              |

Notes:

- `files.content.write` is the only write scope for file content; there is no separate delete or rename scope. `files.metadata.write` (which rclone requests) is carried in `files.stone` by the tag and property routes, not by the upload, folder-create or delete routes listed here **[INFERENCE]** from the route table.
- rclone's own interactive login requests `files.metadata.write`, `files.content.write`, `files.content.read`, `sharing.write` and `account_info.read` ([rclone-oauth], [L102-L111]), plus `team_data.member` (and `members.read` for `impersonate`) when impersonating ([L152-L168][rclone-oauth]). Migmate's own PKCE flow (ADR-0018 D4) is not bound by this. rclone itself only _uses_ the scopes the stored token holds. **[INFERENCE]** With `root_namespace` set, `account_info.read` and `files.content.read` are not exercised on the upload path. This is not verified by running it.
- A read-only source app is refused by D4 when it holds any write scope. The reverse rule is easy to keep: **the write app needs `files.content.write` and `sharing.write`, so it must never be the source app**. Scope sets for the two apps should be disjoint on those two names.
- No `team_data.team_space` scope exists in the `main` stone files. **[UNVERIFIED]** that another scope governs team-space-only calls; none is named in the specification.
- The existing note states that granted scopes are visible only in the token response; the same holds here.

## 5. Destination names and paths

### Case and normalisation

Dropbox paths are case-insensitive but case-preserving, and `path_display` may carry the wrong case in all but the last component ([path-case]). rclone treats Dropbox as case-insensitive (`CaseInsensitive: true`, [L610-L614][rclone-features]); the marching code NFC-normalises and lower-cases keys for such a destination ([L76-L86][rclone-march]), and when two _source_ entries fold to the same key it logs `Duplicate … found in source - ignoring` and **skips the later one** ([march.go L350-L352][rclone-march-dup]).

**[INFERENCE]** For a case-sensitive source such as Drive, `A.txt` and `a.txt` in one folder produce no copy error: one file is silently left behind (a log line, and no failure in the job result). That cannot be allowed to pass for D8, which already blocks "collisions after encoding". Pre-flight must fold the **destination** key (NFC-normalise, then lower-case, as the march does) and block on any collision, per sibling set, including folder names. Dropbox's own Unicode normalisation of stored names is not documented. **[UNVERIFIED]**

### Characters

- The default encoding is `Slash,BackSlash,Del,RightSpace,InvalidUtf8,Dot` ([L306-L318][rclone-options]; [dropbox.md L492-L504][rclone-dropbox-doc]). rclone's comment says Dropbox lists `/` and `\` as invalid, and testing showed names with trailing spaces and DEL fail. `Dot` encodes a leading `.`/`..` name.
- Disclosure per D8: the encoding is applied by rclone and therefore produces `destination_name_encoded` notices when Migmate predicts it. Dropbox's help article additionally calls `< > : " | ? *` and a trailing period "not recommended" ([names]); these are **not** encoded by rclone and not refused by the documented API. Whether the API accepts them is **[UNVERIFIED]**.
- Only the 255-rune per-component limit is enforced by rclone ([checkPathLength L2158-L2171][rclone-pathlen]; constant at [L93][rclone-chunk]). The source comment says Dropbox counts some symbols as two characters (UTF-16-like), so rclone can under-count. An over-long name fails on the server with `malformed_path` (`NoRetryError`).
- Dropbox's name guidance of "under 260 characters" for the whole path ([names]) is a cross-platform sync recommendation, as the existing note says. There is no documented API ceiling on depth, total path length, or files per folder. **[UNVERIFIED]**

### Reserved names

rclone refuses these (case-insensitive, matched as the final path element) _before_ any API call, with a `NoRetryError`: `desktop.ini`, `thumbs.db`, `.ds_store`, `icon\r`, `.dropbox`, `.dropbox.attr` ([ignoredFiles L124][rclone-names]; the check at [L2183-L2185][rclone-update]). The file is not copied. rclone's documentation says "the sync won't fail" ([dropbox.md L654-L663][rclone-dropbox-doc]), but the v1.75.0 code returns a `NoRetryError` that `operations.Copy` passes through `fs.CountError` ([copy.go L336-L342][rclone-copy-loop]). **[INFERENCE]** the file is counted as an error, so a job containing one can end unsuccessfully. Documentation and code disagree; the behaviour was not run. Dropbox's help article lists the same names as ignored, plus temporary-looking names (`~$…`, `.~…`, `~….tmp`) ([ignored-files]). Whether the API rejects the latter is **[UNVERIFIED]**; the API surface is `WriteError.disallowed_name` ([spec-write-error]).

**[INFERENCE]** For D8 these six names are `unsupported reserved names` and must **block** (a file that does not migrate is lost content, the same rule D5 applies to source exports), even though rclone would skip them quietly. The same applies to the `~$`/`.~`/`~…tmp` patterns when found, since Dropbox's own sync ignores them.

### Write and conflict errors (the destination side)

`WriteError` ([files.stone L185-L207][spec-write-error]): `malformed_path`, `conflict` (`WriteConflictError`), `no_write_permission`, `insufficient_space`, `disallowed_name`, `team_folder` ("cannot move or delete team folders"), `operation_suppressed`, `too_many_write_operations`, `access_restricted`, **`team_folder_insufficient_space`** ("The destination team folder has reached its storage limit"), `member_folder_insufficient_space`, **`upload_traffic_limit_reached`** ("The user has reached their monthly upload traffic limit").

`WriteMode` values are `add` (autorename available), `overwrite` and `update(rev)`. rclone always uses `overwrite`, so `conflict` arises from a _folder where a file is expected_ or the reverse, not from two files.

### Capacity numbers

| Limit                   | Value                                                                                            | Source                             |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Per-team-folder storage | `quota_limit` on `TeamFolderMetadata`/`NamespaceMetadata` (bytes, 0 = no limit **[UNVERIFIED]**) | [spec-team-meta], [spec-namespace] |
| Team folders per team   | plan-dependent; `folder_count_limit_exceeded`                                                    | [spec-team-create-error]           |
| Writes per namespace    | **1,000,000 write operations per namespace per 24 h**                                            | [deployments]                      |
| Single-call upload      | ≤ 150 MiB; larger needs sessions                                                                 | existing note                      |
| Session maximum         | 2,199,019,061,248 bytes                                                                          | existing note                      |

**[INFERENCE]** The 1,000,000-write limit applies to the _destination namespace_, which for this design is a single team folder, so a large migration into one team folder is bounded by it. It would be the first number to compare with the plan's file count (with `create_folder`, one write per folder plus one per file). The page does not say whether a batched commit counts per entry or per call, whether the window is rolling, or what error follows. **[UNVERIFIED]** Possibly this limit is what appears as `too_many_write_operations`; the performance guide in the existing note describes that error as namespace-lock contention, so the two are not the same.

## 6. The monthly upload-call (data transport) limit

### What the limit is

From [the data transport page][transport]: it is a number of **calls** per month, applied **per team** and not per app; an app that burns calls can starve other apps. It applies "only to certain Dropbox Business plans". Admins are emailed near and at the limit, and see usage in the Admin console. The deployments page says Standard, Advanced and Enterprise are limited to "1 billion upload operations per month" ([deployments]), so for those plans the limit is far above this migration's scale. The `limit` figure of 25,000 in the specification ([spec-feature]) is an `example`, not a plan value; the existing note makes the same point.

### Which calls count

The specification marks exactly **nine** routes with "Calls to this endpoint will count as data transport calls" ([files.stone L3038-L3215][spec-transport-routes]): `upload`, `upload_session/start`, `upload_session/append` (deprecated), `upload_session/append:2`, `upload_session/append_batch`, `upload_session/finish`, `upload_session/start_batch`, `upload_session/finish_batch` (deprecated) and `upload_session/finish_batch:2`. `get_temporary_upload_link` is **not** annotated. `download`, metadata, listing, `create_folder`, `delete`, `move` and `copy` are not annotated. The existing note listed four; the other five are new here.

### What it costs rclone

| Case                                           | Counted calls per file                                                 | Basis                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `batch_mode=off`, file ≤ `chunk_size`          | 1 (`upload`)                                                           | [Update][rclone-update]                                              |
| `batch_mode=sync`/`async`, file ≤ `chunk_size` | 2 (`start` + one `append:2`) plus 1 `finish_batch:2` per batch, shared | [uploadChunked][rclone-update], [dbx_batcher.go][rclone-dbx-batcher] |
| Any mode, file of `n` chunks                   | 1 + n, plus the finish                                                 | same                                                                 |

**[INFERENCE]** The default batch mode therefore roughly **doubles** counted calls for small files, and a 48 MiB chunk keeps large files cheap. Dropbox advises against small chunk sizes for this reason ([transport]). Whether `finish_batch:2` counts as one call or as one per entry is **[UNVERIFIED]**. At the "1 billion" plans this does not matter; at a plan with a finite `limit` it does.

### How it surfaces

```json
{
  "error_summary": "invalid_account_type/feature/.",
  "error": { ".tag": "invalid_account_type", "invalid_account_type": { ".tag": "feature" } },
  "user_message": {
    "locale": "en",
    "text": "Your team has used all of its data transport API calls for the month. Your monthly limit will reset on the 1st day of every month. If you'd like to move to a plan with unlimited API calls, please contact sales."
  }
}
```

(HTTP 403; [transport]). The 403 class is also used for other account-level blocks ([error-handling]), and the API spec says only "Current account type doesn't have permission to access this feature" for `InvalidAccountTypeError.feature` ([auth.stone L51-L55][spec-auth]). **The same `invalid_account_type/feature` tag is returned when `team_folder/create` is called on a team-space team** ([team-files]). So the error summary alone does not identify the monthly limit; the `user_message.text` and the route do. Per the error-handling guide, match on a **prefix** of `error_summary`, not exactly, and treat `user_message` as the display text ([error-handling]).

There is a second, related tag: `WriteError.upload_traffic_limit_reached` — "The user has reached their monthly upload traffic limit" ([spec-write-error]). The specification does not tie it to the data transport limit, and it speaks of _traffic_ and _the user_. Treat it as a separate signal; whether the two can occur for the same cause is **[UNVERIFIED]**.

### What rclone does with it (v1.75.0)

1. The SDK parses a 403 as `auth.AccessAPIError`; `Error()` returns `error_summary` ([sdk-v6.4.0 `auth/sdk.go` L16-L21, L69-L74]).
2. `shouldRetry` does not special-case it and `fserrors.ShouldRetry` is the last check, so it is retried as a generic error ([L473-L492][rclone-retry]); `shouldRetryExclude` marks it retryable ([L449-L469][rclone-retry]).
3. `pacerInvoker` wraps retries as `fserrors.RetryError` with `max(--low-level-retries, 1)` attempts, default 10, at a pacer between 10 ms and 2 s ([fs/pacer.go L25, L85][rclone-pacer], [L63-L68][rclone-retry-consts]). `operations.Copy` then loops up to `maxTries = ci.LowLevelRetries` again ([copy.go L309-L345, L409][rclone-copy-loop]). Each of these is a failed call on a blocked team.
4. The user sees the error only inside the wrapping text (`upload failed: invalid_account_type/feature/.`, or `batch commit failed: …` on the batched path, [dbx_batcher.go L28-L33][rclone-dbx-batcher]), and the job ends with `Success=false` and `Error = err.Error()` ([job.go L60-L67][rclone-job]).

**[INFERENCE]** Migmate cannot rely on rclone to stop. It should (a) read `upload_api_rate_limit` via `team/features/get_values` before planning and after each wait; (b) pre-estimate the counted calls (§6 table) against the `limit`; (c) classify the job's final error text by a prefix match on `invalid_account_type/feature`, and confirm it is the monthly limit (not the team-space tag) by checking that the failing call was an upload and re-reading `upload_api_rate_limit`, before declaring the job blocked; and (d) set `--low-level-retries` low enough that a blocked team is not hit with 100 failed calls per file. The resume estimate (D9) is 00:00 on the 1st; the zone is **[UNVERIFIED]**, so a conservative resume estimate adds a day.

## 7. What remains unverified

These need one live run on a scratch Business team (once on each model, `has_team_shared_dropbox` false and true):

1. **Fence and writer access.** A new team folder from `team_folder/create`: what does `list_folder_members` return, can a non-admin see it, and can the Select-Admin identity write to it with no membership? If not, does a one-member writer group suffice?
2. `team_folder_id` equals `namespace_id` in `team/namespaces/list`, and works in `root_namespace`.
3. The exact error text rclone's job reports for a 403 `invalid_account_type/feature`, and how many attempts it makes; and whether rejected upload calls still count toward the monthly total.
4. Whether `finish_batch:2` counts per call or per entry; the time zone of the monthly reset; the relation of `upload_traffic_limit_reached` to the transport limit.
5. Whether Dropbox accepts `< > : " | ? *`, trailing periods and the `~$`/`.~`/`~….tmp` names through the API; Unicode normalisation of stored names; any API path length or depth ceiling.
6. What `quota_limit = 0` means for a team folder, and what error follows the 1,000,000 writes/namespace/24 h limit.
7. Whether `team_folder/archive` could serve as a fence (does an archived folder accept writes?) and what `team_folder` in `AddFolderMemberError` means for an ordinary team folder.

[spec-commit]: https://github.com/dropbox/dropbox-api-spec/commit/2de2f5bba692c8458b1499b3fd2a82e22c32ff58
[spec-team-create]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/team.stone#L703-L711
[spec-team-routes]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/team.stone#L703-L800
[spec-team-meta]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/team.stone#L517-L542
[spec-team-create-error]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/team.stone#L577-L587
[spec-team-status]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/team.stone#L493-L501
[spec-namespace]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/team.stone#L3307-L3345
[spec-feature]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/team.stone#L2047-L2142
[spec-team-scopes]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/team.stone
[spec-sharing-add]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/sharing.stone#L2006-L2066
[spec-sharing-list]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/sharing.stone#L2915-L2921
[spec-files-scopes]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/files.stone
[spec-write-error]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/files.stone#L185-L207
[spec-finish-error]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/files.stone#L279-L306
[spec-transport-routes]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/files.stone#L3038-L3215
[spec-sync-setting]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/files.stone#L361-L383
[spec-auth]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/auth.stone#L34-L59
[spec-pathroot]: https://github.com/dropbox/dropbox-api-spec/blob/2de2f5bba692c8458b1499b3fd2a82e22c32ff58/common.stone#L21-L75
[team-folder-create]: https://docs.dropboxapi.com/dropbox-api/api-reference/business-endpoints/team/team-folder-create
[add-member]: https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/sharing/add-folder-member
[list-members]: https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/sharing/list-folder-members
[team-files]: https://docs.dropboxapi.com/dropbox-api/docs/team-files
[auth-types]: https://docs.dropboxapi.com/dropbox-api/docs/auth-types
[scopes]: https://docs.dropboxapi.com/dropbox-api/docs/oauth
[transport]: https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/data-transport-limit
[error-handling]: https://docs.dropboxapi.com/dropbox-api/docs/error-handling
[path-case]: https://docs.dropboxapi.com/riviera/docs/technical-reference/request-response-formats
[deployments]: https://help.dropbox.com/plans/large-deployments
[names]: https://help.dropbox.com/organize/file-names
[ignored-files]: https://help.dropbox.com/sync/files-not-syncing
[team-folders-help]: https://help.dropbox.com/organize/team-folders
[rclone-gomod]: https://github.com/rclone/rclone/blob/v1.75.0/go.mod#L41
[rclone-dropbox-doc]: https://github.com/rclone/rclone/blob/v1.75.0/docs/content/dropbox.md
[rclone-update]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L2026-L2220
[rclone-batch-opts]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L133-L138
[rclone-batcher]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/batcher.go
[rclone-chunk]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L90-L93
[rclone-pathlen]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L2158-L2171
[rclone-dbx-batcher]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/batcher.go#L1-L70
[rclone-lib-batcher]: https://github.com/rclone/rclone/blob/v1.75.0/lib/batcher/batcher.go#L72-L180
[rclone-retry]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L449-L492
[rclone-retry-consts]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L63-L68
[rclone-ns]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L669-L718
[rclone-options]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L199-L324
[rclone-oauth]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L100-L168
[rclone-features]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L610-L614
[rclone-hashes]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L1756-L1758
[rclone-mkdir]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L1224-L1260
[rclone-names]: https://github.com/rclone/rclone/blob/v1.75.0/backend/dropbox/dropbox.go#L93-L124
[rclone-copy-partial]: https://github.com/rclone/rclone/blob/v1.75.0/fs/operations/copy.go#L90-L115
[rclone-copy-loop]: https://github.com/rclone/rclone/blob/v1.75.0/fs/operations/copy.go#L309-L345
[rclone-march]: https://github.com/rclone/rclone/blob/v1.75.0/fs/march/march.go#L76-L86
[rclone-march-dup]: https://github.com/rclone/rclone/blob/v1.75.0/fs/march/march.go#L346-L366
[rclone-pacer]: https://github.com/rclone/rclone/blob/v1.75.0/fs/pacer.go#L25-L85
[rclone-job]: https://github.com/rclone/rclone/blob/v1.75.0/fs/rc/jobs/job.go#L60-L67
