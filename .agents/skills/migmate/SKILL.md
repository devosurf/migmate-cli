---
name: migmate
description: Drive a Migmate job from the CLI. Use when running a file-migration or Teams-archive job, reading a Migmate refusal code or exit status, or preparing a route's credentials.
---

Migmate moves or preserves organizational content once, in one direction, leaving durable evidence. `CONTEXT.md` defines every term used here; `migmate --help` is the authority on flags and exit codes. This skill is the operating procedure the two of them do not carry.

The governing idea: Migmate is built to **refuse**. A refusal is a decision the engine has already made on evidence, not a transient error, so the work is to read it and report it — never to route around it.

## Always

- Pass `--output json`. Parse the envelope; branch on `refusal.code` and the exit status, never on message text. Refusal envelopes arrive on stderr.
- Run on Node 24.15.0 or later. Any other runtime refuses with `usage` at exit 2 before touching the store, because the durable store is the release-candidate `node:sqlite`. `src/versions.ts` is the one place that decides this.
- Read with `--review` (`plan --review`, `verify --review`) when you only need evidence. It takes no writer lease, so it cannot collide with a running job.

## Driving a job

Ten verbs on one rail: `init`, `doctor`, `plan`, `approve`, `execute`, `status`, `verify`, `report`, `close`, `cancel`.

1. `init --type file_migration|teams_archive` returns the job id. Every later verb takes `--job ID`.
2. `creds init --job ID --config job.toml` onboards the operator config. Without it the job is unconfigured and `doctor` refuses.
3. `doctor` runs preflight — conditions only an administrator can satisfy. A failure here is a **tenant prerequisite**, so the finishing move is to name the failing check and hand it to a human.
4. `plan` returns a `planDigest` binding an immutable proposal.
5. `approve` needs `--approver IDENTITY` and `--plan-digest DIGEST`. Both belong to the human: carry the identity they gave you and the digest they read back. When either is missing, stop and ask — approval is the one gate that exists to require a person.
6. `execute`, then `verify`.
7. `verify` raises findings. Each one a human chooses to accept becomes an **exception** via `accept --code CODE`, recorded permanently in the report. `close` refuses while any finding is unaccepted, which is the gate working.
8. `report`, then `close`.

`status` is safe at any point. `cancel` is terminal and exits 0 on success.

## Reading a refusal

Match the exit status first, then the code.

| Exit | Meaning                                          | What to do                                           |
| ---- | ------------------------------------------------ | ---------------------------------------------------- |
| 2    | Usage or configuration                           | Fix the invocation or the config file.               |
| 3    | Lease or recovery refusal                        | Another writer holds the job. See below.             |
| 4    | Preflight, approval, route, or verification gate | Evidence or authority is missing. Report it.         |
| 5    | Retry budget exhausted, blocked at a checkpoint  | Execution stopped mid-flight; report the checkpoint. |
| 6, 7 | Already closed, already cancelled                | The job is terminal. Start a new one.                |

Codes worth recognising:

- **`unqualified_route`** — the requested route tuple has no captured evidence. A tuple covers source system, backend, permissions, options, destination, transfer version, and desktop cell, so flipping one archive option produces a different tuple that owns its own bundle. `docs/release-limits.md` states the qualified tuples and desktop cells. Report this and stop: qualifying a route requires live tenant evidence.
- **`credential_permissions_invalid`** — the credential's roles do not match the route's allowlist, which is exclusive. One extra role refuses the whole credential, which is why each route needs its own app registration.
- **`lease_held` / `lease_stale_worker_alive`** — a writer owns the job. Read with `--review`. Clear a genuinely stale lease with `reclaim --job ID --confirm`, and reach for that only once the owning process is known to be gone; removing files by hand corrupts the job.
- **`verification_unaccepted`** — `close` reached an unaccepted finding. Surface the findings and let a human decide each.

`npm run qualify:route` is a separate surface with its own block codes, so they never appear in a CLI envelope: `live_configuration_required` (operator prerequisites absent), `node_runtime_unsupported`, `file_credentials_required`, and `credential_file_protection_required` (a reference file looser than `0600`, or not owned by the invoking user).

## Credentials

Operator config holds **credential references**: typed pointers to operator-owned files, resolved just in time. Keep secret values out of config, out of issues, out of commits, and out of your own output — a reference is the thing to pass around. Reference files must be `0600` and owned by the invoking user, or the runner refuses them.

`scripts/stage1-prereqs.sh` (file route) and `scripts/archive-prereqs.sh` (archive route) walk a human through tenant setup and write those files. Both accept `--resume <env-file>`. These are human steps; hand them over rather than attempting the tenant work.

## Verifying a change to this repo

`npm run typecheck` and `npm test` are hermetic and fast. `npm run check:package` packs, installs globally into a temporary prefix, and smoke-tests the artifact — run it when packaging, the vendored binaries, or the shipped qualification bundles are in scope.

Those bundles under `qualification/<tupleDigest>/<bundleDigest>/` are runtime data: `readQualifiedBundle` is confined to the installed artifact, so dropping a bundle from the package unqualifies its route. Published bundles are `0444`/`0555`; `chmod -R u+w` before removing an evidence directory.
