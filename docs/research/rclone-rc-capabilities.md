# rclone RC capabilities for managed local execution

This note answers whether a Migmate-managed, loopback-only local `rclone rcd` process can satisfy the first-release robustness floor for async transfer, progress, stop, resumability/idempotence, and process-loss recovery.

## Recommendation

Use rclone RC as a **local async executor**, not as the durable workflow engine.

A loopback-only `rclone rcd` process can cover the transport/control plane for first release: async submission, live progress via `core/stats`, and cooperative stop are native. But rclone does **not** provide a durable job store or crash-recovery contract. Migmate must therefore own checkpointing, replay, and post-crash reconciliation if the first-release robustness floor includes resumability and process-loss recovery.

## Verified facts

### 1) A local loopback RC daemon is a documented, first-party rclone mode

`rclone rcd` is the “run rclone listening to remote control commands only” command, and by default `--rc-addr` listens on `localhost:5572`. The docs also allow Unix sockets and multiple listeners. The RC docs recommend keeping the port on loopback unless there is a specific reason to expose it elsewhere. [rclone rcd docs](https://rclone.org/commands/rclone_rcd/), [rclone RC security docs](https://rclone.org/rc/)

### 2) Async transfer is native RC behavior

Every RC call can be marked `_async=true`. In that mode rclone returns immediately with a `jobid` and `executeId`, runs the work in the background, and exposes status through `job/status`. The docs also note that `Prefer: respond-async` has the same effect and returns HTTP 202. [rclone RC docs](https://rclone.org/rc/)

The upstream job implementation confirms that `_async` creates an in-memory job record, assigns a new integer `jobid`, and returns the current process-wide `executeId`. [rclone job source](https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/jobs/job.go)

### 3) Live progress is native, but only through `core/stats`

rclone exposes live transfer statistics through `core/stats`, including current `transferring` entries, per-file percentage, ETA, speed, and total bytes. The RC docs mention a `progress` field on `job/status`, but the current upstream `Job` struct has no `Progress` field and `rc.Reshape()` is just a JSON round-trip, so `job/status` should not be treated as a live progress source in current rclone master. [rclone RC docs](https://rclone.org/rc/), [rclone job source](https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/jobs/job.go), [rclone params source](https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/params.go)

### 4) Stop is native, but it is cooperative cancellation

rclone provides `job/stop` and `job/stopgroup`. In upstream code, `job/stop` simply calls the job’s cancellation function; the job stops when the underlying operation observes context cancellation. That is a safe boundary, not a hard kill. [rclone RC docs](https://rclone.org/rc/), [rclone job source](https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/jobs/job.go)

### 5) Rerun idempotence exists only at the copy/sync comparison layer

`rclone copy` and `rclone sync` both skip files that are identical on source and destination, comparing by size and modtime or checksum. `sync` also makes destination match source and may delete destination items; `copy` does not delete. That means a rerun can be idempotent at the object level **if Migmate recreates the same operation inputs**, but rclone does not itself provide a durable job-level resume token or checkpoint contract. [rclone copy docs](https://rclone.org/commands/rclone_copy/), [rclone sync docs](https://rclone.org/commands/rclone_sync/)

### 6) Process-loss recovery is not native

The job registry is an in-memory map (`jobs map[int64]*Job`) inside the running process. The process-wide `executeID` is generated once at startup, and `job/list` / `job/status` identify jobs only by the pair `(executeId, jobid)`. The docs say `executeId` changes after restart, `jobids` restart at 1 on each restart, and finished jobs expire after `--rc-job-expire-duration` (default 60s). There is no durable on-disk job store in this code path. [rclone job source](https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/jobs/job.go), [rclone RC docs](https://rclone.org/rc/)

So:

- if Migmate loses its own CLI process but the supervised rclone daemon survives, Migmate can reattach by `(executeId, jobid)`;
- if the rclone process itself exits or restarts, old job IDs are gone and the only recovery path is Migmate-owned checkpoint/reconciliation logic.

### 7) Security is all-or-nothing, and the status/list endpoints are deliberately unauthenticated

The RC docs state that access to the API is equivalent to shell access as the rclone user, that there is no per-endpoint authorization scope system, and that loopback is the preferred bind. In upstream code, `job/list` and `job/status` are registered with `NoAuth: true`, and the docs explicitly say authentication is not required for those calls. [rclone RC security docs](https://rclone.org/rc/), [rclone job source](https://raw.githubusercontent.com/rclone/rclone/master/fs/rc/jobs/job.go)

That is acceptable for a loopback-only daemon, but it is a hard constraint against later exposing RC beyond a trusted local boundary without additional isolation.

## First-release RC contract that follows from the evidence

3. Treat rclone as an async worker: submit work with `_async=true` and persist both `jobid` and `executeId` in Migmate state.
4. Use `core/stats` for live progress while the same rclone process is alive.
5. Use `job/stop` / `job/stopgroup` for cooperative cancellation.
6. Do **not** treat rclone’s job registry as durable state; Migmate must persist its own checkpoints, watermarks, and post-crash reconciliation data.
7. If post-completion polling matters, set `--rc-job-expire-duration` to cover the operator’s polling window; do not rely on the default 60s retention.
8. Keep `--rc-serve`, `--rc-web-gui`, and any non-loopback RC exposure out of first release.

## Limitations that must constrain later decision tickets

- **No durable resume contract from rclone RC itself.** Later tickets must not assume a stopped or crashed job can be resumed from rclone state.
- **No process-loss recovery for the rclone daemon.** Restarting rclone changes `executeId` and drops the old in-memory job map.
- **No per-endpoint auth scopes.** If later work wants broader exposure than loopback, it needs a separate trust boundary design.
- **`job/status` and `job/list` are unauthenticated.** Any later deployment model that exposes RC off-host must account for that explicitly.
- **Stop is cooperative.** If a backend or transfer path fails to observe cancellation quickly, Migmate still needs its own timeout/kill policy.
- **Idempotence is conditional, not automatic.** It comes from rclone’s compare-and-skip behavior plus Migmate reproducing the same inputs; it is not a native transaction.
- **Finished-job retention is short by default.** Seven-day retention, if still desired, must be achieved by configuration and/or Migmate-owned history.

## Decision implication for the smaller Migmate scope

For first release, rclone RC is a good fit **only if Migmate owns durability**.

The safe narrower contract is: *Migmate manages one loopback-only local rclone daemon, uses `_async` jobs for file-transfer execution, and records all recovery-critical state itself.* That contract supports the proposed smaller build, but it also means later decision tickets must resolve how Migmate checkpoints, how long completed jobs stay queryable, and what recovery action happens after a daemon crash.

## New precise questions for Main

- Should Migmate persist its own transfer checkpoint and completion record even when rclone is still running, or only on failure paths?
- What is the minimum accepted retention window for completed RC jobs: the rclone default 60 seconds, a longer configured value, or an external Migmate store?
- Is the first-release local executor bound to localhost TCP, Unix socket, or both?
- Should first release allow only cooperative stop (`job/stop`) or also a Migmate hard-kill fallback for hung transfers?
- Which semantic does the first file-migration route use by default: `copy` (never delete) or `sync` (destination converges to source, including deletes)?
- Does progress need to survive rclone process loss, or only be visible while the same daemon stays alive?
