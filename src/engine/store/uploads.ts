import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY = 86_400_000;
const ALLOWANCE = 750_000_000_000;
const SAMPLING_GAP_MS = 30_000;
const FILENAME = "uploads.sqlite";
const busyWait = new Int32Array(new SharedArrayBuffer(4));

export class UploadLedgerError extends Error {
  constructor(cause: unknown) {
    super(
      "The engine-home upload ledger could not be read or persisted; upload accounting is unavailable.",
      { cause },
    );
  }
}
export interface UploadGap {
  reason: string;
  from: string | null;
  to: string | null;
  attemptId?: string;
}
export interface UploadAccountView {
  account: string | null;
  /** Unknown identities are kept separate, never combined into a fictional account. */
  attemptId?: string;
  jobId?: string;
  observedBytesInWindow: number;
  coverageStart: string | null;
  complete: boolean;
  gaps: UploadGap[];
  estimatedRemainingBytes: number | null;
}
export interface UploadActivity {
  engineHome: string;
  scope: string;
  asOf: string;
  windowStartExclusive: string;
  windowEndInclusive: string;
  coverageStart: string | null;
  accounts: UploadAccountView[];
  gaps: UploadGap[];
  exclusions: string[];
  uncertainty: string;
  dailyAllowanceBytes: number;
  plannedUploadBytes: null;
  prediction: string;
}
export interface UploadAttempt {
  observe(bytes: number, at: Date, terminal?: boolean, worker?: string): void;
  /** Unconfirmed termination leaves the attempt open until worker recovery proves it ended. */
  missing(at: Date, reason: string, terminal?: boolean): void;
}
interface AttemptRow {
  id: string;
  job_id: string;
  account: string | null;
  started: number;
  observed: number;
  high_water: number;
  ended: number | null;
}
const schema = `
CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id = 1), coverage_start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attempts (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, revision INTEGER NOT NULL,
 source TEXT NOT NULL, identity TEXT NOT NULL, worker TEXT, account TEXT,
 started INTEGER NOT NULL, observed INTEGER NOT NULL, high_water INTEGER NOT NULL DEFAULT 0,
 ended INTEGER
);
CREATE TABLE IF NOT EXISTS measurements (
 attempt_id TEXT NOT NULL REFERENCES attempts(id), at INTEGER NOT NULL, bytes INTEGER NOT NULL,
 PRIMARY KEY(attempt_id, at)
);
CREATE INDEX IF NOT EXISTS measurements_time ON measurements(at);
CREATE TABLE IF NOT EXISTS gaps (
 attempt_id TEXT NOT NULL REFERENCES attempts(id), reason TEXT NOT NULL,
 start INTEGER NOT NULL, end INTEGER NOT NULL,
 PRIMARY KEY(attempt_id, reason, start, end)
);`;

function access<T>(home: string, write: boolean, fn: (db: DatabaseSync) => T): T {
  let db: DatabaseSync | undefined;
  try {
    if (write) mkdirSync(home, { recursive: true, mode: 0o700 });
    const path = join(home, FILENAME);
    db = new DatabaseSync(path, { readOnly: !write });
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    if (write) {
      chmodSync(path, 0o600);
      // Concurrent first opens can race the rollback-journal → WAL transition.
      // SQLite can return BUSY here without invoking its connection busy handler.
      const deadline = Date.now() + 5_000;
      for (;;) {
        try {
          db.exec("PRAGMA journal_mode=WAL");
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("errcode" in error) ||
            error.errcode !== 5 ||
            Date.now() >= deadline
          )
            throw error;
          Atomics.wait(busyWait, 0, 0, 10);
        }
      }
      db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    } else db.exec("BEGIN");
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version !== 1 && !(write && version === 0))
      throw new Error(`Unsupported upload-ledger schema version: ${version}`);
    if (write && version === 0) {
      db.exec(schema);
      db.exec("PRAGMA user_version=1");
    }
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    throw error instanceof UploadLedgerError ? error : new UploadLedgerError(error);
  } finally {
    db?.close();
  }
}
function maintain(db: DatabaseSync, now: number): void {
  db.prepare("INSERT OR IGNORE INTO metadata VALUES (1, ?)").run(now);
  db.prepare("DELETE FROM measurements WHERE at < ?").run(now - 2 * DAY);
  db.prepare(
    `DELETE FROM gaps WHERE end < ? AND attempt_id IN
    (SELECT id FROM attempts WHERE ended IS NOT NULL)`,
  ).run(now - 2 * DAY);
}
export function initializeUploadLedger(home: string, now: Date): void {
  access(home, true, (db) => maintain(db, now.getTime()));
}

/** Call only after this job's writer lease proves its previous worker is gone. */
export function endAbandonedUploads(home: string, jobId: string, now: Date): void {
  if (!existsSync(join(home, FILENAME))) return;
  access(home, true, (db) => {
    const end = now.getTime();
    db.prepare(
      `INSERT OR IGNORE INTO gaps
      SELECT id, 'recovered_attempt_terminal_counter_unavailable', observed, MAX(observed, ?)
      FROM attempts WHERE job_id = ? AND ended IS NULL`,
    ).run(end, jobId);
    db.prepare(
      `UPDATE gaps SET end = MAX(end, ?) WHERE reason = 'counter_decreased_without_new_attempt'
      AND attempt_id IN (SELECT id FROM attempts WHERE job_id = ? AND ended IS NULL)`,
    ).run(end, jobId);
    db.prepare(
      "UPDATE attempts SET ended = MAX(observed, ?) WHERE job_id = ? AND ended IS NULL",
    ).run(end, jobId);
    maintain(db, end);
  });
}
export function normalizeUploadAccount(account: string | undefined | null): string | null {
  return account?.trim().toLowerCase() || null;
}

/** The intent is durable BEFORE any upload can start. Observations go straight to
 * this ledger before job commits: a crash leaves either bytes or an open gap,
 * never a job-local checkpoint that silently loses or duplicates accounting. */
export function beginUploadAttempt(
  home: string,
  input: {
    jobId: string;
    revision: number;
    source: "file" | "teams";
    identity: string;
    account?: string;
  },
  now: Date,
): UploadAttempt {
  const id = JSON.stringify([input.jobId, input.revision, input.identity, randomUUID()]);
  access(home, true, (db) => {
    maintain(db, now.getTime());
    db.prepare(
      `INSERT INTO attempts
      (id, job_id, revision, source, identity, account, started, observed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.jobId,
      input.revision,
      input.source,
      input.identity,
      normalizeUploadAccount(input.account),
      now.getTime(),
      now.getTime(),
    );
  });
  return {
    observe(bytes, at, terminal = false, worker) {
      access(home, true, (db) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(at.getTime()))
          throw new Error("Invalid upload observation");
        const row = db
          .prepare("SELECT * FROM attempts WHERE id = ?")
          .get(id) as unknown as AttemptRow;
        const time = at.getTime();
        // Completion tombstones survive sample retention and job removal.
        if (row.ended !== null || time < row.observed) return;
        const gap = (reason: string) =>
          db
            .prepare("INSERT OR IGNORE INTO gaps VALUES (?, ?, ?, ?)")
            .run(id, reason, row.observed, time);
        if (
          bytes < row.high_water &&
          !db
            .prepare(
              "SELECT 1 FROM gaps WHERE attempt_id = ? AND reason = 'counter_decreased_without_new_attempt'",
            )
            .get(id)
        )
          gap("counter_decreased_without_new_attempt");
        // A retained high-water mark cannot explain a decreased counter's later
        // increments. Keep that uncertainty through the whole affected attempt.
        db.prepare(
          `UPDATE gaps SET end = ? WHERE attempt_id = ?
          AND reason = 'counter_decreased_without_new_attempt'`,
        ).run(time, id);
        if (time - row.observed > SAMPLING_GAP_MS) gap("sampling_interval_exceeded_30_seconds");
        const delta = Math.max(0, bytes - row.high_water);
        if (delta)
          db.prepare(
            `INSERT INTO measurements VALUES (?, ?, ?)
          ON CONFLICT(attempt_id, at) DO UPDATE SET bytes = bytes + excluded.bytes`,
          ).run(id, time, delta);
        db.prepare(
          `UPDATE attempts SET observed = ?, high_water = ?, ended = ?, worker = COALESCE(worker, ?) WHERE id = ?`,
        ).run(time, Math.max(bytes, row.high_water), terminal ? time : null, worker ?? null, id);
        maintain(db, time);
      });
    },
    missing(at, reason, terminal = true) {
      access(home, true, (db) => {
        const row = db
          .prepare("SELECT * FROM attempts WHERE id = ?")
          .get(id) as unknown as AttemptRow;
        if (row.ended !== null) return;
        const end = Math.max(at.getTime(), row.observed);
        db.prepare("INSERT OR IGNORE INTO gaps VALUES (?, ?, ?, ?)").run(
          id,
          reason,
          row.observed,
          end,
        );
        db.prepare(
          `UPDATE gaps SET end = ? WHERE attempt_id = ?
          AND reason = 'counter_decreased_without_new_attempt'`,
        ).run(end, id);
        if (terminal) db.prepare("UPDATE attempts SET ended = ? WHERE id = ?").run(end, id);
        maintain(db, end);
      });
    },
  };
}

/** Snapshot-only: no creation, maintenance, worker, or job writer lease. */
export function readUploadActivity(
  home: string,
  asOf: Date,
  accounts: string[] = [],
): UploadActivity {
  const end = asOf.getTime();
  const start = end - DAY;
  const iso = (time: number) => new Date(time).toISOString();
  const result: UploadActivity = {
    engineHome: resolve(home),
    scope: "job-content uploads observed in this engine home",
    asOf: iso(end),
    windowStartExclusive: iso(start),
    windowEndInclusive: iso(end),
    coverageStart: null,
    accounts: [],
    gaps: [],
    exclusions: [
      "Other engine homes, other hosts, and non-Migmate uploads are unobserved; no cross-home or cross-host coordination.",
      "Google downloads, Google-to-SharePoint uploads, local-only archives and packaging, verification/hash downloads, metadata/HTTP overhead, and preflight test uploads are excluded.",
    ],
    uncertainty:
      "Observed content counters are not Google's charged bytes. File samples are normally about 10 seconds apart; archive samples follow acknowledged chunks. Provider retries and ambiguous responses can overstate or understate allowance. This is not a reservation, safe upload budget, or reset clock.",
    dailyAllowanceBytes: ALLOWANCE,
    plannedUploadBytes: null,
    prediction:
      "Planned upload bytes are unavailable; Migmate cannot assess whether a plan fits the allowance. Non-upload routes are not applicable.",
  };
  const views = new Map<string, UploadAccountView>();
  const view = (account: string | null, attempt?: AttemptRow) => {
    const key = account ?? attempt?.id ?? "unknown-plan-account";
    let value = views.get(key);
    if (!value) {
      value = {
        account,
        ...(attempt && !account ? { attemptId: attempt.id, jobId: attempt.job_id } : {}),
        observedBytesInWindow: 0,
        coverageStart: null,
        complete: false,
        gaps: [],
        estimatedRemainingBytes: null,
      };
      views.set(key, value);
    }
    return value;
  };
  for (const account of accounts) view(normalizeUploadAccount(account));
  if (existsSync(join(home, FILENAME)))
    access(home, false, (db) => {
      const metadata = db.prepare("SELECT coverage_start FROM metadata WHERE id = 1").get();
      if (!metadata) throw new Error("Upload ledger coverage metadata is missing");
      const coverage = Number(metadata.coverage_start);
      result.coverageStart = iso(coverage);
      const latest = Number(
        db
          .prepare(
            `SELECT MAX(at) AS latest FROM (
        SELECT coverage_start AS at FROM metadata
        UNION ALL SELECT MAX(started, observed, COALESCE(ended, observed)) FROM attempts
        UNION ALL SELECT end FROM gaps
      )`,
          )
          .get()!.latest,
      );
      if (end < latest)
        result.gaps.push({
          reason: "clock_precedes_durable_observation",
          from: iso(end),
          to: iso(latest),
        });
      if (coverage > start)
        result.gaps.push({
          reason: "new_ledger_or_uninstrumented_older_activity",
          from: null,
          to: iso(coverage),
        });
      for (const row of db
        .prepare("SELECT DISTINCT account FROM attempts WHERE account IS NOT NULL")
        .all())
        view(String(row.account));
      const rows = db
        .prepare("SELECT * FROM attempts WHERE started <= ? AND (ended IS NULL OR ended > ?)")
        .all(end, start) as unknown as AttemptRow[];
      const sumBytes = db.prepare(
        "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM measurements WHERE attempt_id = ? AND at > ? AND at <= ?",
      );
      const readGaps = db.prepare(
        "SELECT * FROM gaps WHERE attempt_id = ? AND end > ? AND start <= ?",
      );
      for (const row of rows) {
        const accountView = view(row.account, row);
        const sum = sumBytes.get(row.id, start, end)!;
        accountView.observedBytesInWindow += Number(sum.bytes);
        for (const gap of readGaps.all(row.id, start, end))
          accountView.gaps.push({
            reason: String(gap.reason),
            from: iso(Number(gap.start)),
            to: iso(Number(gap.end)),
            attemptId: row.id,
          });
        if (row.ended === null)
          accountView.gaps.push({
            reason: "active_or_crashed_attempt_terminal_counter_unavailable",
            from: iso(row.observed),
            to: null,
            attemptId: row.id,
          });
        if (!row.account)
          result.gaps.push({
            reason: "unattributed_upload_attempt",
            from: iso(row.started),
            to: row.ended === null ? null : iso(row.ended),
            attemptId: row.id,
          });
      }
    });
  else
    result.gaps.push({
      reason: "ledger_unavailable_no_instrumented_history",
      from: null,
      to: null,
    });
  for (const value of views.values()) {
    value.coverageStart = result.coverageStart;
    value.gaps.push(...result.gaps);
    if (value.account === null)
      value.gaps.push({ reason: "verified_approved_account_unavailable", from: null, to: null });
    value.complete = value.gaps.length === 0;
    value.estimatedRemainingBytes = value.complete
      ? Math.max(0, ALLOWANCE - value.observedBytesInWindow)
      : null;
  }
  result.accounts = [...views.values()].sort((a, b) =>
    (a.account ?? a.attemptId ?? "").localeCompare(b.account ?? b.attemptId ?? ""),
  );
  return result;
}

export function uploadActivityText(activity: UploadActivity): string {
  return [
    `${activity.scope}: ${activity.engineHome}`,
    `Window (${activity.windowStartExclusive}, ${activity.windowEndInclusive}]; coverage start: ${activity.coverageStart ?? "unknown"}.`,
    ...activity.accounts.map(
      (account) =>
        `${account.account ?? `unattributed ${account.jobId ?? "plan"} ${account.attemptId ?? ""}`}: ${account.observedBytesInWindow} observed bytes; estimated remaining bytes: ${account.estimatedRemainingBytes ?? "unavailable"}; gaps: ${account.gaps.map((gap) => gap.reason).join(", ") || "none"}.`,
    ),
    ...activity.gaps.map((gap) => `Coverage gap: ${gap.reason}.`),
    "750 GB = 750,000,000,000 bytes. Estimates are advisory only; quota resume remains manual.",
    ...activity.exclusions,
    activity.uncertainty,
    activity.prediction,
  ].join("\n");
}
