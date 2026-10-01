-- Migmate per-job durable state. One database per job folder, WAL mode.
-- Schema version 2. Forward-only migrations; a newer database refuses to open
-- under an older Migmate with `state_version_unsupported`.

-- The job itself. Exactly one row.
CREATE TABLE job (
  id                    TEXT PRIMARY KEY,
  type                  TEXT NOT NULL CHECK (type IN ('file_migration', 'teams_archive')),
  state                 TEXT NOT NULL CHECK (state IN (
                          'new','planned','approved','executing','interrupted',
                          'blocked','needs_attention','verified','closed','cancelled')),
  schema_version        INTEGER NOT NULL,
  migmate_version       TEXT NOT NULL,
  label                 TEXT,
  created_at            TEXT NOT NULL,
  plan_revision         INTEGER,
  verification_revision INTEGER,
  last_checkpoint       TEXT,
  host_id               TEXT,
  execution_completed   INTEGER NOT NULL DEFAULT 0 CHECK (execution_completed IN (0, 1))
) STRICT;

-- The writer lease. Exactly one row, present only while a writer holds it.
-- `pid` alone is never trusted: `process_start_time` defeats pid reuse.
CREATE TABLE lease (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  owner_uuid         TEXT NOT NULL,
  host_id            TEXT NOT NULL,
  pid                INTEGER NOT NULL,
  process_start_time INTEGER NOT NULL,
  heartbeat_at       TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('cli', 'web')),
  socket_path        TEXT,
  worker_group       TEXT,
  worker_pid         INTEGER,
  worker_process_start_time INTEGER,
  worker_executable  TEXT,
  last_checkpoint    TEXT,
  migmate_version    TEXT NOT NULL
) STRICT;

-- Append-only. A new revision never edits an old one.
CREATE TABLE plan_revision (
  rev                 INTEGER PRIMARY KEY,
  plan_digest         TEXT NOT NULL,
  inputs_digest       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  source_inventory_at TEXT NOT NULL,
  evidence            TEXT NOT NULL,
  payload             TEXT
) STRICT;

-- The exact inputs the inputs digest covers. Changing any of these forces a new
-- revision; anything else may be admitted as an execution delta.
CREATE TABLE plan_input (
  rev   INTEGER NOT NULL REFERENCES plan_revision(rev),
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (rev, key)
) STRICT;

-- Append-only. No code path writes an auto-approval.
CREATE TABLE approval (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rev         INTEGER NOT NULL REFERENCES plan_revision(rev),
  plan_digest TEXT NOT NULL,
  approver    TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('interactive', 'unattended')),
  at          TEXT NOT NULL,
  payload     TEXT
) STRICT;

-- File migration: approved source root -> pre-existing destination folder.
CREATE TABLE mapping (
  id                TEXT PRIMARY KEY,
  rev               INTEGER NOT NULL REFERENCES plan_revision(rev),
  source_drive_id   TEXT NOT NULL,
  source_item_id    TEXT NOT NULL,
  dest_drive_id     TEXT NOT NULL,
  dest_folder_id    TEXT NOT NULL,
  exclusions        TEXT NOT NULL
) STRICT;

-- Teams archive: one frozen, expanded scope entry.
CREATE TABLE scope_entry (
  id           TEXT PRIMARY KEY,
  rev          INTEGER NOT NULL REFERENCES plan_revision(rev),
  kind         TEXT NOT NULL CHECK (kind IN ('channel', 'user_chats')),
  subject_id   TEXT NOT NULL,
  parent_id    TEXT,
  expanded_from TEXT
) STRICT;

-- File migration rows. One per source item per revision.
CREATE TABLE item (
  id                    TEXT NOT NULL,
  rev                   INTEGER NOT NULL,
  phase                 TEXT NOT NULL CHECK (phase IN ('plan', 'execute', 'verify')),
  code                  TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  accepted              INTEGER NOT NULL DEFAULT 0,
  mapping_id            TEXT NOT NULL,
  source_drive_id       TEXT NOT NULL,
  source_item_id        TEXT NOT NULL,
  relative_path         TEXT NOT NULL,
  item_type             TEXT NOT NULL CHECK (item_type IN ('file', 'folder')),
  size                  INTEGER,
  source_etag           TEXT,
  source_fingerprint    TEXT,
  dest_drive_id         TEXT,
  dest_file_id          TEXT,
  dest_fingerprint      TEXT,
  provenance_state      TEXT NOT NULL DEFAULT 'none'
                          CHECK (provenance_state IN ('none','marked','verified','drifted')),
  payload               TEXT,
  PRIMARY KEY (rev, phase, id)
) STRICT;

CREATE INDEX item_by_code ON item (rev, phase, code);
CREATE INDEX item_by_path ON item (rev, phase, relative_path);
CREATE INDEX item_by_source ON item (source_drive_id, source_item_id);

-- Teams archive rows. One per conversation per revision.
CREATE TABLE conversation (
  id              TEXT NOT NULL,
  rev             INTEGER NOT NULL,
  phase           TEXT NOT NULL CHECK (phase IN ('plan', 'execute', 'verify')),
  code            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  accepted        INTEGER NOT NULL DEFAULT 0,
  scope_entry_id  TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  title           TEXT,
  records         INTEGER NOT NULL DEFAULT 0,
  assets          INTEGER NOT NULL DEFAULT 0,
  watermark       TEXT,
  payload         TEXT,
  PRIMARY KEY (rev, phase, id)
) STRICT;

CREATE INDEX conversation_by_code ON conversation (rev, phase, code);
CREATE INDEX conversation_by_scope ON conversation (scope_entry_id);

-- Collected message records. Canonical JSONL is rendered from these.
CREATE TABLE record (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  modified_at     TEXT,
  partition       TEXT NOT NULL,
  payload         TEXT NOT NULL
) STRICT;

CREATE INDEX record_by_conversation ON record (conversation_id, created_at, id);

-- Durable assets. Bytes live on disk; this table holds path and digest only.
-- No column here may ever hold a preauthenticated or otherwise transient URL.
CREATE TABLE asset (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT,
  source_kind     TEXT NOT NULL CHECK (source_kind IN ('hosted_content', 'attachment', 'transcript')),
  path            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  retrieved_at    TEXT NOT NULL
) STRICT;

-- Every gap, in every phase. A finding becomes an exception only through acceptance.
CREATE TABLE finding (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rev          INTEGER NOT NULL,
  phase        TEXT NOT NULL CHECK (phase IN ('plan', 'execute', 'verify')),
  code         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  evidence     TEXT NOT NULL,
  at           TEXT NOT NULL
) STRICT;

CREATE INDEX finding_by_code ON finding (rev, phase, code);

-- Acceptance is bound to a verification digest. Re-verification produces a new
-- digest, which strands prior acceptances rather than carrying them forward.
CREATE TABLE acceptance (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  verification_digest TEXT NOT NULL,
  code               TEXT NOT NULL,
  approver           TEXT NOT NULL,
  note               TEXT,
  at                 TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX acceptance_unique ON acceptance (verification_digest, code);

CREATE TABLE verification_revision (
  rev                 INTEGER PRIMARY KEY,
  plan_rev            INTEGER NOT NULL,
  verification_digest TEXT NOT NULL,
  clean               INTEGER NOT NULL,
  findings            TEXT NOT NULL DEFAULT '[]',
  payload             TEXT,
  at                  TEXT NOT NULL
) STRICT;

-- Durable preflight and probe evidence. Records that a probe succeeded and
-- against which identity; never the secret used.
CREATE TABLE check_result (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  verb     TEXT NOT NULL,
  check_id TEXT NOT NULL,
  title    TEXT NOT NULL,
  status   TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'skip')),
  code     TEXT,
  evidence TEXT NOT NULL,
  at       TEXT NOT NULL
) STRICT;

-- The idempotence gate. A repeated unit key makes the whole commit a no-op, which
-- is what turns a driver's at-least-once yield into an exactly-once durable effect.
CREATE TABLE commit_log (
  rev        INTEGER NOT NULL,
  phase      TEXT NOT NULL,
  unit_key   TEXT NOT NULL,
  verification_run INTEGER NOT NULL DEFAULT 0,
  migmate_version TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  at         TEXT NOT NULL,
  resources  TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (rev, phase, verification_run, unit_key)
) STRICT;

-- Per-unit resumption watermarks. Never advanced before referenced assets are durable.
CREATE TABLE watermark (
  rev        INTEGER NOT NULL,
  unit_key   TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (rev, unit_key)
) STRICT;

-- The only progress channel. Commit-grained, never item-grained, never pruned.
-- `cursor` is the rowid: monotonic, gap-free, and free to index.
CREATE TABLE event (
  cursor  INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  verb    TEXT NOT NULL,
  phase   TEXT NOT NULL,
  kind    TEXT NOT NULL,
  payload TEXT NOT NULL
) STRICT;

-- Durable projections, written inside the commit transaction. Never views:
-- a lease-free reader in another process must answer both without scanning evidence.
CREATE TABLE projection_verb_state (
  verb       TEXT PRIMARY KEY,
  state      TEXT NOT NULL CHECK (state IN ('pending','done','current','blocked','checkpoint')),
  checkpoint TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE projection_facet (
  phase    TEXT NOT NULL,
  rev      INTEGER NOT NULL,
  code     TEXT NOT NULL,
  kind     TEXT NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (phase, rev, code)
) STRICT;

-- Live progress, one row per unit. Read by `status()`; `total` may be null.
CREATE TABLE projection_progress (
  unit       TEXT PRIMARY KEY,
  done       INTEGER NOT NULL,
  total      INTEGER,
  updated_at TEXT NOT NULL
) STRICT;

-- Full file intents/results are retained even when the visible row is replaced.
CREATE TABLE file_state_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  rev INTEGER NOT NULL,
  phase TEXT NOT NULL,
  verification_run INTEGER NOT NULL,
  unit_key TEXT NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE file_authority (
  mapping_id TEXT NOT NULL,
  source_drive_id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state_rank INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (mapping_id, source_drive_id, source_item_id)
) STRICT;

-- Current verification is a projection; historical evidence is append-only.
CREATE TABLE verification_run (
  plan_rev INTEGER PRIMARY KEY,
  run INTEGER NOT NULL UNIQUE,
  started_at TEXT NOT NULL
) STRICT;
CREATE TABLE verification_history (
  run INTEGER NOT NULL,
  plan_rev INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('item', 'conversation', 'finding')),
  row_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run, category, row_key)
) STRICT;

CREATE TABLE archive_plan (
  rev INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  manifest_digest TEXT
) STRICT;
CREATE TABLE archive_record (
  key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE INDEX archive_record_by_conversation ON archive_record (conversation_id, key);
CREATE TABLE archive_revision_record (
  rev INTEGER NOT NULL,
  key TEXT NOT NULL REFERENCES archive_record(key),
  PRIMARY KEY (rev, key)
) STRICT;
CREATE TABLE archive_evidence (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  rev INTEGER NOT NULL,
  phase TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (rev, phase, unit_key)
) STRICT;
CREATE INDEX archive_evidence_by_revision ON archive_evidence (rev, sequence);
CREATE TABLE archive_file (
  rev INTEGER NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (rev, path)
) STRICT;
CREATE TABLE revision_asset (
  rev INTEGER NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (rev, path)
) STRICT;
CREATE INDEX asset_by_path ON asset (path);
CREATE TABLE projection_archive (
  rev INTEGER PRIMARY KEY,
  conversations INTEGER NOT NULL,
  total_conversations INTEGER NOT NULL,
  records INTEGER NOT NULL,
  total_records INTEGER,
  assets INTEGER NOT NULL,
  bytes INTEGER NOT NULL
) STRICT;
CREATE TABLE artifact_set (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  report_digest TEXT,
  payload TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;

CREATE TABLE revision_sequence (
  name TEXT PRIMARY KEY CHECK (name IN ('plan', 'verification')),
  value INTEGER NOT NULL
) STRICT;

-- Mapping copy passes survive the worker's in-memory RC jobs.
CREATE TABLE mapping_pass (
  rev INTEGER NOT NULL,
  mapping_id TEXT NOT NULL,
  pass_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','interrupted')),
  payload TEXT NOT NULL,
  PRIMARY KEY (rev, mapping_id, pass_number)
) STRICT;
