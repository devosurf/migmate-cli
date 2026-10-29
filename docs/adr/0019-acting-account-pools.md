# ADR-0019: Acting-account pools spread destination writes across approved accounts

- Status: accepted
- Date: 2026-10-29
- Accepted: Morgan, 2026-10-29, after a grilling session and explicit confirmation of the complete design. Implementation is tracked in map [#108](https://github.com/devosurf/migmate-cli/issues/108).
- Supersedes: the proposal in [#101](https://github.com/devosurf/migmate-cli/issues/101) (not an ADR).
- Amends: [ADR-0012](0012-staged-migrations-and-access-timing.md), for uploader membership on created containers during copying; [ADR-0017](0017-pre-grant-drift-and-acknowledged-go-live-checks.md), whose post-grant membership check runs after uploader membership is removed.

Google allows each Workspace user 750 GB of uploads per 24 hours and advises against more than about 3 sustained writes per second per account. On one account, a 120 TB, 17M-file project needs 160 days of upload allowance and about 66 days of writes. Google's large-migration guidance recommends spreading writes over many impersonated users. Today a file job has one acting account, bound into its plan. We give a job an approved pool of acting accounts and keep each pass on one of them.

This records an accepted decision, not shipped behavior. Commands, runtime and operator documentation stay unchanged until it is implemented.

## Decisions

### D1: A job holds an approved pool; each pass writes as one account

A job's plan binds an acting-account pool. Each pass writes as exactly one account in it, through credentials and rclone remotes isolated to that account. A shared remote or token session is never swapped under a running pass. One domain-wide-delegated service account (Google) or one team app (Dropbox) serves the whole pool; the pool lists distinct accounts, not aliases of one account.

### D2: Pools apply to Google and Dropbox writes

Google limits each user's daily upload bytes and write rate. Dropbox limits user-endpoint requests per member under Select-User, so a pool spreads those requests. Dropbox's namespace write contention and its monthly upload-call limit are not per member, so a Dropbox pool does not relieve them. Reads and SharePoint keep one identity: Microsoft throttles per app per tenant and discourages extra apps to get around it.

### D3: What may change in a running job

- Copy concurrency (mappings in flight, transfers per mapping) changes without approval and takes effect at the next pass admission; it grants no authority.
- Adding an account is new write authority. It needs an approval through ADR-0016's handoff, but no re-plan of the mappings and no restart of running passes.
- Removing an account needs no approval. Its running passes finish, and it receives no new pass.

### D4: Uploader membership on created containers

Migmate gives each pool account write membership on the containers it creates: content manager on a Shared Drive, editor on a Dropbox team folder. It removes that uploader membership at close, before the membership check, so the check compares only approved members. Plan and report disclose uploader membership and its removal. For existing containers, the operator grants access beforehand and preflight proves that each pool account can write.

### D5: Reassignment after a Google daily-limit stop

After a confirmed daily-upload-limit stop, the account's unfinished mappings move to another eligible pool account once the old attempt is confirmed stopped. A mapping never has two writers. The exhausted account receives no more work for the rest of that `execute`. When every account is exhausted, the job is blocked with each account's evidence and resume estimate; the operator runs `execute` again later, and no background process waits for a reset.

Ordinary throttling, storage, permission and network errors never move work. Reassignment never recreates containers, rewrites provenance or resets deletion limits. A fresh attempt may resend an interrupted large file.

### D6: Dropbox has no reassignment trigger

No per-user byte allowance like Google's was found for Dropbox, so a Dropbox pool only spreads passes. Exhausting the team's monthly upload-call limit blocks the job ([ADR-0018](0018-provider-pair-file-routes.md) D9).

### D7: Observation stays within one engine home; one job runs on one host

[#78](https://github.com/devosurf/migmate-cli/issues/78)'s per-account ledger includes pool accounts. Nothing claims coordination with other engine homes or hosts. One job runs on one host; more capacity comes from more jobs, each with its own host or engine home.

## Considered alternatives

- **One acting account per job:** rejected. The number of jobs would set the number of accounts, so changing accounts mid-migration would mean re-splitting jobs.
- **Service accounts acting as themselves:** rejected. They are not Workspace members, and no source guarantees each a separate upload allowance (research on branch `research/large-migrations-google-limits`).
- **Moving work on ordinary throttling:** rejected. Throttling is shared, transient, and not evidence that an account is exhausted.
- **Automatic resume after 24 hours:** rejected. Hit time plus 24 hours is an estimate, not Google's reset clock.
- **One job spread across hosts:** rejected. It needs distributed ownership and recovery; separate jobs already run on separate hosts.
- **SharePoint app pools:** rejected (D2).

## Implementation consequences

Implementation is tracked in [#115](https://github.com/devosurf/migmate-cli/issues/115) (pools) and [#118](https://github.com/devosurf/migmate-cli/issues/118) (ledger). It needs durable account assignment and attempt evidence, an owner for every worker, and reassignment only after the previous writer is proven stopped. Worker topology (a worker per account, or isolated per-account remotes in one worker) is an implementation choice. Release limits and the migmate skill change with the implementation.
