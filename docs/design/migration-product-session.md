# Migmate migration product design

## Status

Design grilling is complete and the decisions in this document are confirmed.

No implementation has started. Implementation requires a separate explicit instruction.

## Product outcome

Build a reusable one-way migration product in this repository. The sibling `../sharepoint_to_google/` project remains reference material only; do not copy its repository, runtime state, credentials, database, TUI, or configuration wholesale.

The public package is `@devosurf/migmate`. It installs the `migmate` command and is licensed under Apache-2.0.

A **job** is one finite migration from one authoritative source organization to one destination organization. One job may contain many sites, libraries, conversations, generic mapping roots, and destination Shared Drives, but unrelated tenants require separate jobs. This product is not bidirectional synchronization and has no conflict-resolution or reverse-reconciliation contract.

First-release scenarios are all required end to end:

1. generic rclone source to generic rclone destination;
2. SharePoint document libraries to Google Shared Drives, including mapping, provisioning, and permission workflows;
3. Microsoft Teams Graph Export content to a restricted Google Shared Drive archive.

The first release supports built-in modules only. Keep internal seams deep and testable, but do not define a public provider/plugin SDK until another real semantic destination proves the interface.

## Runtime and public API

- TypeScript on Node 24 LTS.
- Strict TypeScript, ESM, compiled JavaScript, declarations, and explicit package exports.
- Initial supported Node range: `>=24.15 <25`. Production runners pin an exact patch.
- The CLI is a thin adapter over a small supported job API.
- The public engine API opens or initializes a job and invokes the same lifecycle operations as the CLI. It returns final result envelopes and async event streams.
- Public engine types do not expose CLI framework, SQLite, rclone, Microsoft Graph, Google, Infisical, or other implementation types.
- Semantic versioning begins at 1.0. Within 1.x, preserve the CLI grammar, engine API, manifest schema, JSON/JSONL contracts, exit meanings, plan execution compatibility, job-state upgrades, and archive schemas. Breaking public-contract changes require 2.0.

## Job folder and lifecycle

One local folder contains exactly one job.

```text
migmate init ./acme-cutover
cd ./acme-cutover
migmate inventory
migmate plan
migmate approve
migmate execute
migmate verify
migmate report
migmate close
```

Commands use the exact current directory as the job root. They never search parent directories and never remember a global active job. `--job <directory>` is the deterministic override for agents, CI, and commands run elsewhere.

The 1.0 top-level command surface is:

```text
init
doctor
inventory
plan
approve
execute
pause
resume
status
verify
report
close
cancel
cleanup
support-bundle
```

Standard `help` and `version` behavior is also required. There is no one-shot `migrate` orchestrator.

Lifecycle behavior:

- `inventory` captures source, destination, identity, permission, and capability evidence.
- `plan` creates an immutable semantic plan revision.
- `approve` binds a human attestation to the exact plan digest.
- `execute` waits by default.
- `execute --detach` is supported only for the currently ready external-RC transfer frontier. Graph collection, rendering, permission work, verification, and newly unblocked transfer work do not continue without a Migmate coordinator.
- `pause` stops active work at a safe boundary and leaves the job resumable.
- `resume` restarts paused or interrupted work from a checkpoint. It does not double as a read-only attach command.
- `status` is a snapshot; `status --watch` observes a running job without mutating it.
- `cancel --reason <text>` stops work and creates a terminal cancellation. It does not roll back destination mutations.
- `verify` records current verification evidence but does not close the job.
- `close` is explicit and requires current successful verification. It records final operator attestation.
- Closed jobs are logically immutable except for report/support generation, internal compatible state migration, and policy-authorized cleanup.
- Work discovered after closure uses a new linked delta/remediation job referencing the prior job and report digests. Closed jobs are never reopened.
- `cleanup` previews eligible paths/categories/bytes by default. `cleanup --apply` performs audited local deletion. It is the explicit enforcement mechanism for diagnostic expiry and optional payload retention policies.

Prompt policy:

- Only human-mode `approve` may prompt.
- JSON/JSONL and non-TTY invocations never prompt.
- Approval displays the job ID/name, source and destination authorities/roots, plan creation time and full digest, operation counts, permission changes, exclusions, downgrades, and blockers.
- Approval is impossible while blockers remain.
- The prompt has no affirmative default and requires typing `yes`.
- The approval transaction rechecks that the displayed digest is still current.
- Non-interactive approval must supply the full digest and approver identity.

Interruption policy:

- Ctrl+C never terminally cancels a job.
- An external RC transfer continues and the CLI detaches.
- A local child process is stopped at the safest available boundary and the job becomes resumable.
- Explicit `migmate cancel` is the only terminal cancellation path.
- Cancellation never rolls back transferred or deleted destination content.

## CLI output and exit contracts

Output selection is explicit:

- human text is the default regardless of TTY detection;
- `--output json` emits one final document;
- `--output jsonl` emits a lifecycle event stream.

JSON uses a versioned result envelope. Every handled invocation emits exactly one object containing at least:

- `schemaVersion`;
- `command` and `commandId`;
- job identity when available;
- `ok`;
- exactly one of `result` or structured `error`.

JSONL rules:

- every line is one versioned event envelope;
- public IDs and a monotonic sequence make ordering explicit;
- progress is cumulative and bounded to at most once per second per active work class;
- lifecycle transitions, warnings, and individual failures are emitted;
- complete per-item outcomes belong in SQLite and artifact partitions, not millions of stdout events;
- every handled invocation ends with exactly one terminal event:
  - `command.completed`;
  - `command.failed`;
  - `command.cancelled`;
  - `command.interrupted`.

`command.interrupted` carries the resulting job state such as `running-detached` or `paused` and the appropriate reattach/resume action.

In JSON/JSONL modes, stdout contains the complete structured handled result, warnings, progress, and error. Stderr remains empty except for a fatal failure before output initialization. Detailed redacted diagnostics are written under the job folder.

Public identifiers and time:

- UUIDv7 for jobs, runs, commands, attempts, and events;
- deterministic SHA-256-derived IDs for semantic plan operations;
- monotonic integer event sequences;
- RFC 3339 UTC timestamps with explicit offsets.

Exit codes:

| Code  | Meaning                                                           |
| ----- | ----------------------------------------------------------------- |
| `0`   | Command completed its intended state successfully                 |
| `1`   | Internal or unclassified product defect                           |
| `2`   | Invalid invocation or configuration                               |
| `3`   | Job lifecycle, lock, or lease conflict                            |
| `4`   | Safety, approval, policy, capability, or verification block       |
| `5`   | Retryable dependency outage after the elapsed retry budget        |
| `6`   | Terminal operation failure                                        |
| `7`   | Job was terminally cancelled                                      |
| `130` | Local CLI interrupted by SIGINT; job may remain running or paused |

Precise failure causes use stable public string codes such as `PLAN_DIGEST_MISMATCH` and `RC_UNREACHABLE` inside structured errors.

## Rclone execution

First release supports two executors behind one transfer contract:

1. `local-process` — default;
2. operator-managed `external-rc`.

### Local process

- Resolve the executable in this order: explicit manifest path, `MIGMATE_RCLONE`, then `PATH`.
- Migmate never downloads or replaces an executable during a migration command.
- Operator-installed native rclone is required outside the official Migmate OCI image.
- Resolve endpoint credentials just in time and define uniquely named rclone remotes through a scrubbed child environment.
- Never pass backend secrets in command arguments or job files.
- Discard the environment values when the process exits and redact resolved values from every captured surface.
- A local process cannot detach. Ctrl+C stops it safely and leaves the job resumable.

### External RC

- The operator owns daemon/container creation, configuration, supervision, restart, and removal.
- Migmate targets one stable rclone process/container per executor profile.
- Only one active Migmate job may use an RC instance at a time. Operators may run several isolated RC instances on one host.
- External RC uses operator-provisioned named remotes. Migmate does not transmit backend credentials in RC request payloads.
- Submit transfer work asynchronously.
- Persist rclone `executeId` plus `jobid`; their combination identifies the remote job across local state.
- External work continues after CLI loss. A later invocation reattaches to the exact instance/job when available.
- RC restart changes `executeId`; Migmate then reconciles from its durable checkpoint rather than pretending to reattach.
- If a submission response is lost or ownership is otherwise ambiguous, never blindly resubmit. Block with a recovery report until no prior worker can remain.
- The RC daemon must retain completed async job status for at least seven days. Rclone's configured expiry performs cleanup; native RC has no per-job forget operation.
- Native RC aggregate success/stats are execution evidence, not per-item proof. A post-operation destination inventory reconciles the bounded item set and updates per-item state.
- Stable `_group` values scope progress and cancellation.
- Explicit `pause`/`cancel` stops the job/group and records the resulting job state.

External RC security:

- Same-client Docker uses authenticated loopback TCP: publish only on `127.0.0.1`, authenticate requests, and allow HTTP because transport stays on-host.
- Non-loopback RC requires HTTPS, TLS 1.2 or newer, hostname verification, explicit custom CA support, and rclone username/password authentication.
- Mutual TLS and globally authenticating proxies are supported but are not required by the confirmed first-release policy.
- Cleartext non-loopback endpoints and TLS-verification bypasses are rejected.
- The RC Web GUI and `--rc-serve` are disabled.
- The RC API is shell-equivalent and has no endpoint-level authorization scopes. Operators must isolate the service account, remotes, network, and host.

Reference same-client Compose profile:

- exact rclone image version/digest, never `latest`;
- loopback-only published port;
- mounted hashed authentication secret;
- non-root user;
- read-only root filesystem;
- no Docker socket;
- no Web GUI or file serving;
- only required configuration and local-path mounts;
- explicit operator-owned lifecycle;
- one active job per container.

### Compatibility

- Each Migmate release publishes a tested rclone allowlist plus required command/option/capability probes.
- The initial preferred version at design completion is rclone v1.75.0.
- Untested versions block unless explicitly accepted as a compatibility downgrade.
- Production runners pin an exact version.
- Plans bind required rclone capabilities/version/security and canonical endpoint/root IDs, not one concrete executor URL/path.
- Switching local/RC profiles is allowed only after proving semantic endpoint equivalence. Host-local or container-local paths that cannot be proven equivalent require an amendment.

## Job state and artifact layout

Use built-in `node:sqlite` behind a narrow internal state-store module.

SQLite owns transactional lifecycle state:

- job and plan revisions;
- approvals;
- runs and attempts;
- logical writer leases;
- checkpoints and watermarks;
- compact per-item execution/provenance state;
- control requests;
- artifact manifests and digests;
- current verification state;
- append-only audit events.

Large immutable data stays in files:

- source/destination inventories;
- change sets;
- canonical plans;
- permission exports;
- reports and exception indexes;
- Teams archive staging/output;
- diagnostic logs.

One compact SQLite row per logical source item is required for deterministic resume, provenance-aware updates, exact failures, and verification. It stores compact keys and state, not file bytes, message bodies, attachments, or repeated raw provider payloads. Full metadata remains in partitioned artifacts.

Default layout:

```text
migmate.yaml
inventory/
plans/
reports/
logs/
.migmate/
  state.sqlite
  work/
```

`migmate.yaml` is strict, human-authored YAML:

- versioned JSON Schema;
- duplicate keys rejected;
- unknown fields rejected;
- unsafe tags disabled;
- unsafe implicit coercions disabled;
- credential fields accept typed secret references only.

Inventory snapshots use bounded partitioned `.jsonl.gz` files with a manifest and per-part digests. Plans and destination Teams JSONL remain uncompressed for direct inspection.

### Concurrency and locks

- One lifecycle writer per job; many concurrent read-only `status`, `status --watch`, and report readers.
- Internal transfer/API concurrency occurs inside the one active run and does not constitute additional job writers.
- The writer lock is a SQLite lease containing owner UUID, process/host identity, timestamps, and a heartbeat.
- Detached RC state is an active run state, not a fake process lease.
- `pause` and `cancel` are narrow control-plane exceptions: they append an audited control request in a short transaction while a coordinator owns the lease. If the run is detached, the control command may take recovery control.
- No other lifecycle command bypasses the writer lease.
- Live job folders are supported only on a local filesystem. Network and cloud-synced folders are unsupported for live SQLite state.

### Recovery and backups

- Recover automatically only when ownership is unambiguous.
- Reattach to an exact live RC job when possible.
- If the old worker is proven gone, mark its attempt interrupted and resume the idempotent unit from the last durable checkpoint.
- Ambiguous remote state blocks rather than risking concurrent duplicate transfer.
- Commit connector-native bounded units: Graph page/window segment, archive part, permission batch, or rclone mapping/subtree command.
- Never advance a watermark before all dependent outputs for that unit are durable.
- Use SQLite's online backup API before schema migrations and at plan approval, final verification, and closure. Retain a small configurable milestone rotation.
- New compatible Migmate versions perform forward-only transactional database migrations after a milestone backup. `doctor` previews the required migration. Downgrading the migrated job database is unsupported.

Local storage policy:

- enforce restrictive OS file permissions/ACLs;
- there is no Migmate-enforced encrypted-volume requirement;
- estimate peak state, backup, inventory, archive, recording, and work-space usage;
- require a configured free-space margin and monitor continuously;
- pause before disk exhaustion;
- local archive payload retention is chosen per job;
- verified staging cleanup is explicit and audited.

## Plan, approval, and amendment model

An approvable plan is a resolved semantic operation graph, not a raw command script and not an underspecified goal.

It binds:

- source and destination authority/root stable IDs;
- mapping roots and policies;
- path transforms and accepted name changes;
- identity and permission decisions;
- exclusions;
- capability evidence and typed downgrades;
- ownership/takeover decisions;
- mirror/additive behavior;
- operation dependencies and preconditions;
- schema/planner versions;
- referenced inventory/change-set/identity/capability artifact digests.

At enterprise scale, plan JSON references immutable item-set manifests rather than embedding millions of nodes. The approval root recursively binds every referenced digest.

Approval digest:

- canonicalize the semantic JSON payload using RFC 8785;
- hash with SHA-256;
- include schema/planner versions and all referenced semantic artifact digests;
- exclude only the digest field itself and explicitly non-semantic presentation metadata;
- allow independent reproduction from exported artifacts.

Approval assurance in 1.0 is a recorded local attestation:

- exact plan digest;
- declared approver identity;
- OS identity when available;
- timestamp;
- hash-chained audit event.

This proves digest binding, not cryptographic human identity. The schema remains extensible for later signed/external approvals.

Amendments:

- Approved plan files are never changed in place.
- Before execution, regenerate a new plan revision and approve its new digest.
- After execution starts, create a separately inventoried delta/amendment plan referencing completed operations and current destination evidence.
- Automatic plan rewriting never preserves old approval.
- Another Migmate package version may execute an approved plan only when it explicitly supports the plan schema and feature set. Unsupported plans block without rewriting.

Delta authority:

- Initial approval binds deterministic delta rules for fixed roots, mappings, transforms, identity/ACL decisions, endpoint capabilities, and mirror/additive policy.
- New or changed file/message content that fits those rules is hashed, checkpointed, and audited without per-item reapproval.
- A new site/root, identity, effective principal, group membership, ACL scope/role, collision, endpoint, transform, capability downgrade, or other semantic choice blocks and requires amendment.
- Source permission or group-membership changes always require amendment, even when identities were previously approved.

## Generic endpoint capabilities and fidelity

"All rclone remotes" is a byte-tree contract, not a uniform fidelity claim.

Capability model:

- `supported`;
- `unsupported`;
- `unknown`.

Unknown never satisfies a requested guarantee. It blocks only operations depending on that guarantee unless an explicit downgrade exists.

Capability evidence may come from:

- runtime rclone introspection;
- provider-specific API evidence;
- versioned backend knowledge;
- explicit isolated write probes on destinations.

Write probes:

- require a configured disposable namespace;
- use uniquely marked Migmate objects;
- never probe a source or normal production content path;
- remove only Migmate probe objects;
- audit every mutation.

Downgrades are typed and scoped. Each one records the missing guarantee, affected endpoint/path set, item count, fallback behavior, and verification consequence. There is no global accept-all-downgrades switch.

Portable generic baseline:

- preserve file content;
- preserve the approved relative-path mapping;
- require destination presence and size;
- preserve modification time when both endpoints support it;
- compare a common provider hash when both expose one;
- offer opt-in full streaming SHA-256 when stronger evidence justifies the read/egress cost;
- do not promise ACLs, ownership, versions, or provider metadata without a semantic module/profile.

Non-regular filesystem entries such as symlinks, hard links, devices, and sockets block planning until a scoped policy explicitly excludes, safely dereferences, or encodes them. Never follow links by default.

Unsupported names/path lengths and normalized path collisions block planning. The planner emits deterministic reversible transform/remap proposals, but execution requires the accepted mapping in a new plan.

Generic backend support is capability-based. Any stable rclone backend that passes required preflight may run. Publish a fully qualified matrix for local, SFTP, WebDAV, S3-compatible, SharePoint, and Google Drive. Do not claim equal fidelity across backends.

## Mirror, additive, ownership, and collisions

Every job has an authoritative source. Therefore `mirror` is the default transfer policy.

Mirror eligibility requires:

- one non-overlapping destination root owned by one source mapping;
- a stable source and destination root identity;
- provider metadata or a reserved `.migmate-owner.json` marker binding job/mapping IDs and digests;
- the marker excluded from mirror operations;
- verified or explicitly attested destination exclusivity;
- complete source inventory health;
- no unapproved existing content, collisions, or writers.

Mirror execution:

- use rclone single-pass sync behavior with `--delete-after`;
- avoid a duplicate full dry-run before every delta;
- perform cheap root identity, ownership, access, capability, credential, and inventory-health checks first;
- rely on rclone's rule that deletion happens after successful transfer and is suppressed after I/O errors;
- record actual mutations and reconcile destination inventory afterward;
- support configurable per-mapping `--max-delete`/byte circuit breakers;
- do not impose an arbitrary universal delete ceiling;
- run a separate full preview for first-time takeover, changed boundaries, or explicit operator request.

`additive` is an explicit per-mapping mode for an existing/shared/user-writable destination. It copies new/changed approved source content but never removes destination-only content. It does not claim exact source mirror fidelity.

Source mutation/deletion is never allowed. Source retirement remains a separate administrative process after job closure.

Destination collisions:

- update/replace an object proven to be Migmate's prior copy of the same stable source item;
- block on unknown destination content;
- provenance uses compact state records containing source ID/key, destination ID/path key, fingerprint, and attempt; add provider app metadata where safely supported;
- do not create per-file sidecars;
- a non-empty mirror root may be claimed only by explicit whole-root takeover;
- takeover binds an inventory digest and shows overwrite/delete counts;
- mirror selection alone never silently claims a populated root;
- use destination trash/versioning when available;
- disclose and explicitly approve irreversible deletion when unavailable;
- no automatic rollback command exists.

## SharePoint and Google Workspace scope

### SharePoint content

First release migrates document-library files and folders only.

- Migrate only the current file version.
- Inventory available version counts and report omitted history.
- Export document-library columns, content types, retention labels, and workflow metadata to structured JSONL/CSV keyed by stable item ID/path.
- Preserve portable file attributes when endpoint capabilities allow.
- Do not recreate source-specific metadata as Google Drive labels in 1.0.
- Inventory and explicitly report lists, Site Pages, forms, apps, workflows, and other non-document-library components as out of scope.

### Shared Drive mapping/provisioning

Default mapping remains one SharePoint site to one Google Shared Drive, with document libraries as top-level folders. Planner-proposed splits handle endpoint limits or distinct permission requirements.

Custom supported mappings:

- many sites into one drive under non-overlapping folders;
- one site split across several drives;
- per-library drive/folder choices;
- existing and newly created destinations;
- strict site-per-drive, library-per-drive, pooled destinations, and explicit manifests;
- arbitrary generic rclone source/destination roots within the job's authorities.

Create new Shared Drives by default. Reuse an existing drive only through an explicit stable Drive ID plus the approved takeover/additive policy. Never infer reuse by display name.

### Permissions and groups

Never silently broaden access.

Permission workflow always:

1. inventories effective SharePoint access, including expanded groups and unique library/folder/item ACLs;
2. exports canonical JSON and operator-friendly CSV;
3. proposes an approved destination access graph;
4. uses one of these execution modes:
   - Migmate applies groups/permissions;
   - administrators apply them manually and Migmate verifies actual Google access;
   - explicit report-only downgrade with no parity claim.

Identity mapping candidates use verified primary emails, aliases, and configured domain rewrites. Ambiguous, missing, guest, external, and group mappings require human resolution. Execution never guesses a new identity after approval.

Group policy:

- reuse existing Google Groups only through explicit stable mappings;
- optionally create dedicated Google Groups in managed mode;
- created groups flatten complete effective source user membership per specific ACL scope;
- do not promote users who only have child-folder access into a root group;
- incomplete transitive membership expansion blocks planning;
- preserve source nesting only through explicitly mapped existing organization groups.

Role mapping compares capabilities, not names. Automatically select only a Google role whose effective actions do not broaden the source grant. Missing required actions or a non-equivalent custom level blocks for explicit restriction/layout/group redesign.

Unique-permission subtrees that the Google layout cannot naturally preserve block plan approval. The record names the exact path, effective principals, and conflicting destination access. Resolution is explicit: isolate/split, remap ACLs, exclude, or intentionally restrict.

Permission deltas after approval always require an amended plan.

## Teams archive

### Collection route and scope

Use Microsoft Graph Teams Export APIs in 1.0. Keep an internal collector seam for a future Purview import adapter, but do not implement both routes initially.

Collect all retrievable:

- standard, private, and shared channel posts and replies;
- 1:1, group, and meeting chats;
- reactions and reaction edit history;
- message edits and supported deleted/control records;
- mentions and inline content;
- attachments;
- meeting recordings and transcripts exposed by supported Graph surfaces.

Unsupported, expired, inaccessible, retention-limited, deleted-window, licensing, or omitted records are explicit gaps. Never silently disappear. Teams/Copilot AI insights, summaries, action items, and generated notes are out of scope but should be inventoried when detectable.

The archive audience is admins and legal only. It is a readable reference, not litigation-grade evidence or chain of custody. Google Vault is not a historical import destination.

### Human and structured surfaces

Primary human surface: static HTML.

- Migmate does not generate PDFs in 1.0.
- Provide print CSS so operators may print through their own browser.
- User-created PDFs are outside Migmate's deterministic verification claim.
- JSONL is the canonical structured representation.
- CSV provides bulk indexes and exception lookup.

One package per conversation:

- one channel package containing posts/replies;
- one 1:1 chat package;
- one group chat package;
- one meeting chat/package;
- if meeting media has no retrievable chat, create a meeting-only package.

Folder names use a sanitized readable title plus a stable source-ID-derived suffix. Full IDs remain in manifests.

Suggested package shape:

```text
conversation/
  index.html
  parts/
    2026-08-001.html
  data/
    2026-08-001.jsonl
  search/
    2026-08.idx.js
  images/
    <stable-image-id>/
      original.png
      preview.webp
  attachments/
    <stable-attachment-id>/
      original-name.ext
  assets/
    archive.css
    search.js
  index.csv
  manifest.json
```

### Partitioning and search

- Calendar-month internal partitions use UTC.
- Months with no records produce no part.
- Split a month into deterministic numbered parts when it exceeds 10,000 records or 100 MiB.
- `index.html` presents a unified conversation interface and navigation.
- Every monthly HTML part contains complete pre-rendered message text and remains usable with JavaScript disabled.
- JSONL is canonical data, not the only readable copy.
- Search indexes are deterministic disposable derivatives.
- Full conversation search spans all month/part shards.
- Required enhancements: token/phrase search, author/date/type/attachment/edited/deleted/reaction filters, highlighted snippets, and stable message links.
- Top-level CSV locates conversations; a tenant-wide browser full-text engine is not required in 1.0.
- No CDN, external font, analytics, remote data load, or required hosted service.
- Current and previous Chrome, Edge, Firefox, and Safari must support offline archive reading; enhanced search must work with local scripts enabled.
- Static archive and search target WCAG 2.2 AA.
- English is the only qualified 1.0 interface language. Keep strings localization-ready and preserve arbitrary source Unicode/locale data.
- Partitions remain UTC, but human timestamps use one approved IANA display timezone and always expose canonical UTC. Viewer-machine timezone never changes archive output.

### Message rendering

- Display the latest retrievable message content in conversation context.
- Label edits/deletions with timestamps.
- Include available prior versions and control records in a compact per-message history.
- Preserve raw source response records in restricted JSONL, excluding transport headers/tokens.
- Render Teams HTML through a strict structural allowlist.
- Remove active content, unsafe CSS, scripts, and remote loads.
- Record lossy transformations.
- Preserve safe `https`, `http`, and `mailto` links as visible clickable targets without fetching.
- Rewrite known migrated/archive file links to the archived target.
- Label unresolved links.
- Render original mention text and attach resolved canonical identity/type metadata. Preserve raw mention structures/source IDs in JSONL. Flag unresolved mentions.

### Images, attachments, recordings, and transcripts

Inline images:

- download only through authorized Microsoft export/file surfaces;
- never fetch arbitrary external URLs;
- preserve original bytes once;
- use pinned `sharp` processing for bounded WebP/PNG previews;
- strip active/unneeded metadata from previews;
- keep originals unchanged;
- explicit gap for missing/expired images.

Attachments:

- store under `attachments/<stable-source-id>/<sanitized-original-name>`;
- reuse the same stored object when the same source ID appears repeatedly within a conversation package;
- retrieve the exact message-time/historical file version when Microsoft exposes it;
- otherwise preserve current retrievable bytes with retrieval timestamp and an explicit historical-version gap;
- treat bytes as opaque and never execute them;
- Migmate makes no malware-scanning claim;
- report files rejected by Google/source security controls.

Meeting media:

- store recordings/transcripts in the correlated meeting conversation package;
- cross-reference channel/chat mentions without duplicating media bytes;
- render non-autoplay HTML5 controls plus ordinary download links for supported recordings;
- retain size/hash/duration metadata when available;
- preserve original transcripts;
- render sanitized time-coded searchable HTML linked to recordings;
- index speaker/text/time and flag unresolved speakers.

Deltas deterministically regenerate only affected month/part HTML, JSONL, CSV, search, and manifests. Audit old/new artifact digests and rely on provider version history when available instead of visible revision files.

## Authentication, secrets, TLS, and proxies

First-release secret providers:

- environment references;
- mounted-file references;
- Infisical Cloud and self-hosted.

Credential fields accept typed references such as:

```yaml
clientSecret:
  provider: infisical
  profile: corp
  key: GRAPH_CLIENT_SECRET
```

Provider-specific fields are schema-validated. Do not use URI mini-languages or template interpolation. Literal plaintext credentials are rejected in every mode, including development.

Secret invariants:

- plans, SQLite, JSON/JSONL output, logs, errors, reports, approval digests, support bundles, and process arguments contain references only;
- resolve values just in time;
- retain them in process memory only;
- redact known resolved values and credential fields;
- never fall back to plaintext after provider failure;
- provider outage before execution fails preflight;
- provider outage during execution pauses at a safe checkpoint.

Infisical:

- use the official pinned Node SDK behind Migmate's generic provider interface;
- explicit base URL, project ID, environment, path, and optional organization scope;
- Universal Auth machine identity is the default unattended bootstrap;
- client bootstrap credentials arrive through workload identity where supported, protected environment, or mounted file;
- short-lived bearer tokens are cached/renewed in memory only;
- static/pre-minted tokens remain compatibility fallback, not default;
- support custom CA bundles for self-hosted instances;
- never spawn the Infisical CLI.

Microsoft Graph:

- support certificate-based client assertions and client-secret application auth;
- prefer certificates for production;
- required protected application permissions are preflighted and reported;
- auth material arrives through typed secret references.

Google Workspace:

- support service-account private keys plus domain-wide delegation in 1.0;
- workload identity is not a qualified 1.0 Google auth path;
- subject/impersonation identity and scopes are explicit and preflighted.

TLS/proxy:

- allow explicit provider/executor custom CA bundle references;
- retain hostname verification;
- reject insecure skip-verification flags;
- support explicit per-provider/job outbound proxy settings plus standard proxy variables and `NO_PROXY`;
- proxy credentials use typed secret references and participate in leakage tests/redaction.

## Scale, concurrency, retry, and checkpoints

Qualified 1.0 single-coordinator envelope:

- 10,000 users;
- 1,000 SharePoint sites;
- 10 million filesystem objects;
- 50 million Teams message/control/version records.

Larger jobs may run but are outside the verified envelope.

Coordinator memory:

- RSS ceiling of 4 GiB at the qualified metadata scale;
- rclone and any bounded child/image worker have separate explicit resource limits;
- no tenant-scale collection is retained wholly in memory;
- streams, bounded queues, SQLite, and partitioned artifacts are mandatory.

Concurrency:

- independent maximum/adaptive budgets for Microsoft, Google, Infisical, HTML/search/image work, and rclone;
- reduce concurrency on `Retry-After`, throttling, latency, and error signals;
- cautiously recover to the configured maximum;
- rclone checkers/transfers remain separately bounded.

Retries:

- rclone handles bounded backend-aware low-level/high-level retries inside one transfer command;
- Migmate counts command elapsed time against its run-level budget;
- Migmate resubmits only after durable reconciliation;
- no independent multiplicative retry defaults;
- use jittered backoff and honor provider `Retry-After`;
- default consecutive transient-failure budget is 30 minutes during inventory, bulk, and ordinary deltas;
- final cutover budget is the smaller of 30 minutes or the remaining approved cutover deadline;
- exhaustion persists a safe checkpoint, pauses the job, emits a retryable error, and exits 5.

Checkpoints:

- commit complete Graph pages/closed time-window segments;
- commit complete archive parts and their dependent attachments/indexes;
- commit permission batches;
- commit bounded rclone mapping/subtree command outcomes;
- never advance a watermark until the complete dependent unit is durable.

Failure isolation:

- after retry exhaustion, stop dependent/destructive work for the failed unit;
- continue unrelated approved mappings/conversations/batches;
- end the phase non-successfully with exact failures;
- closure remains blocked until resolved or explicitly approved as an exception.

Performance claim:

- no universal wall-clock SLA because provider throttling, byte volume, geography, bandwidth, and endpoint capabilities dominate;
- qualify bounded memory and absence of superlinear coordinator behavior;
- publish reference-hardware metadata/render benchmarks;
- report measured call volume, throughput, throttling, and ETA per job.

## Cutover, verification, reports, and closure

### Cutover

Finite lifecycle:

1. inventory;
2. plan;
3. approve;
4. bulk migration/export;
5. one or more incremental passes;
6. source freeze;
7. final delta;
8. settled zero-change confirmation;
9. content/archive verification;
10. destination permission application/validation;
11. post-permission drift verification;
12. report/review;
13. explicit close.

Exact parity requires a verified or recorded operator source freeze. Quiescence without a freeze may be reported but cannot make the exact-cutover claim.

Final delta:

- capture the frozen upper bound;
- process all changes through that bound with connector-specific overlap/watermark rules;
- wait the provider-specific consistency interval;
- run a complete confirmation query/sync;
- process discoveries and repeat until one complete pass finds no unprocessed change through the frozen bound.

Destination access:

- keep end users out of staging during bulk/final mirror work;
- run final content/archive verification first;
- then apply managed permissions or validate the administrator-applied graph;
- run a short destination-content/permission drift check;
- only then declare the destination open.

### Verification

Generic files:

- compare every expected mapped path and size;
- compare common provider hashes where available;
- label size-only evidence explicitly;
- opt-in full streaming SHA-256 for stronger jobs;
- verify requested supported timestamps/metadata;
- verify no unapproved destination-only content in mirror roots;
- reconcile per-item provenance state.

Permissions:

- re-inventory effective Google access;
- compare with the approved destination access graph, including approved restrictions/redesigns;
- any additional effective access is a hard failure;
- missing expected users/roles also fail unless already approved as an exception.

Teams archive:

- every collected message/version/control record maps exactly once into canonical JSONL and a static HTML/index location;
- attachments/media match expected size and hash when available;
- every HTML page parses and exposes expected searchable text;
- manifests, anchors, relative links, images, attachments, CSP, CSS, and search shards resolve;
- search behavior is browser-driven across the supported matrix;
- automated and manual accessibility qualification covers WCAG 2.2 AA;
- source omissions remain explicit gaps.

Verification outcomes:

- unapproved gaps block closure;
- approved plan exceptions or separately approved amendments may close as `completed_with_approved_exceptions` with exit 0;
- jobs without exceptions close as `completed`;
- reports never collapse approved exceptions into clean success.

Reports:

- canonical `report.json`;
- self-contained static `report.html` with artifact links;
- spreadsheet-friendly exception CSV;
- bind report formats and referenced artifacts by digest;
- reports are available for successful, blocked, failed, paused, and cancelled jobs.

## Audit, privacy, telemetry, and support

Audit model:

- normalized current state plus an append-only event for every lifecycle transition, approval, mutation summary, retry exhaustion, pause, recovery, verification, close, cancellation, and cleanup;
- event and state transition commit atomically;
- each audit event binds the previous event digest;
- final reports bind the audit chain head and artifact digests;
- this detects later edits/corruption but does not claim independent authenticity without an external signature.

Telemetry:

- off by default;
- explicit organization opt-in only;
- opt-in fields limited to coarse version/performance/error-code metrics;
- never send tenant IDs, paths, filenames, identities, message data, secret references, endpoint URLs, or content-derived values.

Log retention:

- approval/audit state and final reports remain with the job;
- redacted diagnostic JSONL expires after 30 days by default, configurable by policy;
- active-job diagnostics are never expired;
- no background daemon exists, so `cleanup --apply` enforces expiry;
- cleanup previews and audits every removed path/category/byte count.

Support bundles:

- generated only by explicit command;
- written locally for operator review;
- include versions, schema/config with references, state/audit summaries, error codes, artifact manifests, and selected redacted logs;
- exclude message bodies, file/attachment bytes, credentials, and raw inventories;
- never upload automatically.

## Distribution and release provenance

Primary distribution: public global npm package `@devosurf/migmate`, installing `migmate`.

The package name was not present in the public registry when checked during design. Organization ownership and trusted publishing configuration still need to be established before release.

Secondary distribution: signed OCI image.

- exact Migmate and Node versions;
- pinned preferred rclone binary included;
- non-root runtime;
- no credentials or job state in image layers;
- no Chromium/PDF renderer;
- operator mounts a local job volume;
- image version/provenance records bundled rclone and native dependencies.

Offline distribution:

- verified per-platform archives containing Migmate and production dependencies;
- exact checksums and signatures;
- SBOM;
- installation/verification instructions;
- exportable signed OCI image archive;
- native rclone remains an independently operator-installed and verified dependency.

Publishing:

- protected signed source tags;
- CI-only production release;
- npm OIDC trusted publishing with provenance;
- keyless-signed OCI images;
- signatures/checksums/SBOM for offline artifacts;
- one source/version identity across all channels;
- no maintainer workstation publishes production artifacts.

Release stages:

- alpha for local/schema validation;
- beta for supervised real pilots and contract freeze;
- 1.0 only after every acceptance gate passes.

## First-release acceptance gates

1. All three scenarios work end to end with no incomplete placeholders or fake fallbacks.
2. Local-process and external-RC paths pass their applicable lifecycle, pause/resume, cancellation, crash, and verification contracts.
3. Deterministic automated tests cover state machines, plans/digests, manifests, artifacts, mirror/additive behavior, permissions, archives, output contracts, and secret redaction.
4. Release-gated live sandbox migrations run against dedicated:
   - Microsoft 365/Teams/SharePoint;
   - Google Workspace/Shared Drives/Groups;
   - Infisical Cloud;
   - self-hosted Infisical;
   - local rclone;
   - external RC;
   - the qualified generic backend matrix.
5. Complete two representative real-tenant pilots:
   - one nontrivial SharePoint/files/permissions migration;
   - one nontrivial Teams archive migration;
   - use different executor and permission workflows;
   - no unapproved verification gaps.
6. Fault injection at every durable boundary includes:
   - coordinator/process kill;
   - expired writer lease;
   - RC restart;
   - response loss after remote submission;
   - provider throttling/outage;
   - secret-provider outage/token renewal;
   - disk exhaustion around SQLite/artifact commits;
   - cancellation/pause races;
   - prove no silent skips, duplicate semantic mutations, or approval bypass.
7. Qualified scale passes within 4 GiB coordinator RSS and published local-disk expectations.
8. Independent security review completes. No unresolved critical or high finding may ship; medium findings require documented ownership/decision; low findings enter the backlog.
9. Automated canary-secret leakage tests cover process arguments, child environments/captures, state/backups, artifacts, logs, stdout/stderr, errors, crashes, reports, support bundles, OCI layers, and offline packages.
10. Static archive passes record reconciliation, current/previous major-browser offline reading/search, and WCAG 2.2 AA qualification.
11. Operator-complete documentation covers:
    - native, OCI, and offline installation;
    - manifest and schema reference;
    - provider/auth/permission setup;
    - RC security/reference Compose;
    - lifecycle and approval;
    - mirror/additive/takeover/deletion behavior;
    - cutover/freeze/recovery;
    - verification and exception interpretation;
    - archive format/search/limitations;
    - JSON/JSONL/exit/error contracts;
    - scale/disk sizing;
    - privacy/security/telemetry/support;
    - troubleshooting and remediation jobs.
12. Publish reference benchmarks and resource/call-volume guidance without a universal completion-time SLA.

## Explicit accepted risks

### External RC route authentication

The confirmed policy allows non-loopback external RC with HTTPS plus rclone basic authentication and does not require a globally authenticating reverse proxy or mutual TLS. Rclone documents some job list/status routes as not requiring application authentication, and job status may expose output/progress. This is an explicit accepted design risk, not a claim that every RC route is protected by basic auth.

The independent security review remains authoritative for the 1.0 gate. If it classifies this critical/high, the finding must be fixed or external RC removed from 1.0; risk acceptance cannot bypass that gate.

### Local encryption at rest

Migmate enforces restrictive OS permissions/ACLs but does not require an encrypted host volume and does not provide application-level encryption for SQLite/inventories/archive staging. Sensitive tenant paths, identities, permissions, messages, and media can therefore be exposed by lost disks, snapshots, or privileged local access. Operators own host/storage protection.

### Local approval identity

The 1.0 local approval record binds a declared approver and exact plan digest but is not a cryptographic proof that a human approved it. Stronger signed/external approval can be added through a future explicit design.

### Google service-account keys

Google Workspace 1.0 supports long-lived service-account private keys for domain-wide delegation, not workload identity. Secret providers and in-memory handling reduce local leakage but do not remove key issuance/rotation risk.

### No automatic rollback

Source remains authoritative and untouched, but destination overwrite/delete operations are not universally reversible. Provider trash/versioning is preferred and irreversible behavior is disclosed; Migmate does not promise automatic rollback.

## Reference artifacts and primary evidence

Repository research:

- `docs/research/teams-to-google-chat-migration.md`
- `docs/research/infisical-secret-provider.md`

Important primary references:

- [Rclone remote control/API security, authentication, jobs, grouping, and expiry](https://rclone.org/rc/)
- [Rclone rcd server and Unix/TLS/auth options](https://rclone.org/commands/rclone_rcd/)
- [Rclone sync deletion and error behavior](https://rclone.org/commands/rclone_sync/)
- [Rclone sync/check/delete limits](https://rclone.org/docs/)
- [Node 24 `node:sqlite`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [Microsoft Teams Export APIs](https://learn.microsoft.com/en-us/microsoftteams/export-teams-content)
- [Google Drive roles and Shared Drive role mapping](https://developers.google.com/workspace/drive/api/guides/ref-roles)
- [SharePoint sharing and nested security-group considerations](https://learn.microsoft.com/en-us/sharepoint/modern-experience-sharing-permissions)
