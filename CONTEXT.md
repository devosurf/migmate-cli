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

**Qualified route**:
A source-and-destination combination whose supported behavior and fidelity have been tested and documented. Qualification of one route does not imply support for every compatible backend.
_Avoid_: Universal remote support, all-remotes support

**Operator**:
A human, agent, or CI process that controls a job through a supported interaction surface.
_Avoid_: End user
