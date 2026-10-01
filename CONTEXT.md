# Migmate

Migmate handles finite, one-way movement or preservation of organizational content. The authoritative source remains unchanged; each job produces durable evidence of what was planned, processed, and verified.

## Language

**Job**:
A durable unit of planning, approval, execution, verification, and reporting. Each job has exactly one job type.
_Avoid_: Run, session, project

**File migration job**:
A job that moves files, folders, and supported basic metadata from an authoritative source to a destination. First-release file migration excludes identity and permission translation.
_Avoid_: File sync, replication

**Teams archive job**:
A job that preserves Microsoft Teams conversations and assets as human-readable HTML plus structured records. It is an archive, not a file migration.
_Avoid_: Teams migration, chat backup

**Supported route**:
A source-and-destination combination this build implements and verifies item by item in every job. Anything outside it refuses as unsupported rather than degrading.
_Avoid_: Qualified route, universal remote support, all-remotes support

**Capability sample**:
Real source content whose observation the optional live test rests on, such as an item kind a driver must omit or a message carrying inline bytes. A sample that cannot exist is recorded with a named reason, never assumed away.
_Avoid_: Fixture, test data, seed

**Operator**:
A human, agent, or CI process that controls a job through a supported interaction surface.
_Avoid_: End user

**Plan**:
An immutable, digest-bound proposal of everything a job will do, produced from evidence collected about the source. A plan is approved as a whole or not at all; changing what a job will do produces a new revision, never an edit.
_Avoid_: Inventory, run, batch, dry run

**Preflight**:
The set of checks that must pass before a job may be planned, covering prerequisites only an administrator can satisfy. Preflight failures are refusals, never retries.
_Avoid_: Health check, validation

**Tenant prerequisite**:
A condition of a source tenant that no credential satisfies and no retry survives, such as an administrator-held toggle or a retention policy. Preflight proves it and refuses when it is absent.
_Avoid_: Setting, environment config, dependency

**Exception**:
A known gap between what a job planned and what is verifiably present, explicitly acknowledged by an operator. An exception is a recorded outcome, not a failure, and it never disappears from a report.
_Avoid_: Error, warning, caveat

**File mapping**:
An approved relation from one stable source root to one stable destination root, such as a SharePoint document library and a Google Shared Drive, in either direction. Items keep their relative hierarchy inside the mapping, and mappings within a job never overlap.
_Avoid_: Route, mount, sync pair

**Mapping manifest**:
The batch list of a job's file mappings, each naming its destination (an existing root, or a Shared Drive the job creates) and that destination's members. It is loaded into the job and frozen into the plan; after that the job, not the file, is the authority.
_Avoid_: Inventory, spreadsheet

**Mirror**:
An opt-in mode in which a repeat pass makes a destination the job created match its source, including deletions. Without it a pass only copies and never deletes.
_Avoid_: Sync

**Provenance**:
Durable evidence tying a destination item to the authoritative source item and file mapping that produced it. A matching path alone is not provenance.
_Avoid_: Ownership, path match

**Archive scope**:
The explicit, stable-ID list of channels and per-user chat sets a Teams archive job covers. A scope entry names its subject by identifier, never by display title, and a conversation shared by several entries belongs to exactly one of them.
_Avoid_: Selection, filter, target set

**Conversation**:
One channel or one chat whose messages form a single archived unit, preserved as human-readable HTML plus canonical structured records.
_Avoid_: Thread, room, transcript

**Hosted content**:
Message-inline bytes that Microsoft serves from the message itself rather than from a file location, such as pasted images. It is distinct from an attachment, which references content stored elsewhere.
_Avoid_: Inline image, embedded file, media

**Engine home**:
The per-user local root that holds Migmate's host identity and its job tree. Live job state is local-filesystem only, so a foreign host identity is a refusal rather than a race.
_Avoid_: install prefix, cache, workspace root

**Job folder**:
The directory under engine home holding everything durable about one job: operator config, state database, assets, artifacts, and the current run's private directory.
_Avoid_: workspace, project folder, run directory

**Credential reference**:
A typed pointer in a job folder's operator config to an operator-owned file holding a secret or secret-bearing config. Migmate resolves it just in time and never copies the bytes into durable state.
_Avoid_: Secret value, credential blob
