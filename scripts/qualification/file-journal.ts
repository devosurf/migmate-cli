import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CODE_BY_NAME } from "../../src/engine/codes.ts";
import { fileMigrationDriver, type FileMigrationConfig } from "../../src/engine/drivers/file-migration.ts";
import type { FileContext, FileEvidenceRow, FileState } from "../../src/engine/drivers/file-state.ts";
import type { CommitUnit } from "../../src/engine/drivers/types.ts";
import { QualificationBlocked } from "./common.ts";

export type FilePhase = "plan" | "execute" | "verify";

/** A private durability adapter. Every operation closes SQLite; restart has no retained authoritative rows. */
export class FileJournal {
  readonly path: string;
  readonly #jobDirectory: string;
  readonly #signal: AbortSignal;
  readonly #onDurable: (unit: CommitUnit) => Promise<void>;

  private constructor(path: string, jobDirectory: string, signal: AbortSignal, onDurable: (unit: CommitUnit) => Promise<void>) {
    this.path = path; this.#jobDirectory = jobDirectory; this.#signal = signal; this.#onDurable = onDurable;
  }
  static async create(jobDirectory: string, name: string, signal: AbortSignal, onDurable: (unit: CommitUnit) => Promise<void>): Promise<FileJournal> {
    if (!/^[a-z0-9_-]+$/.test(name)) throw new QualificationBlocked("file_journal_name_invalid");
    const path = join(jobDirectory, `${name}.sqlite`);
    const handle = await open(path, "wx", 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
    const database = new DatabaseSync(path);
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE qualification_commit (sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL);");
    } finally { database.close(); }
    if (process.platform !== "win32") {
      const directory = await open(jobDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return new FileJournal(path, jobDirectory, signal, onDurable);
  }
  static async reopen(path: string, jobDirectory: string, signal: AbortSignal, onDurable: (unit: CommitUnit) => Promise<void>): Promise<FileJournal> {
    const info = await lstat(path);
    if (dirname(path) !== jobDirectory || !info.isFile() || info.isSymbolicLink() ||
        (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new QualificationBlocked("file_journal_ownership_invalid");
    }
    const journal = new FileJournal(path, jobDirectory, signal, onDurable);
    await journal.units();
    return journal;
  }
  async units(): Promise<CommitUnit[]> {
    const database = new DatabaseSync(this.path, { readOnly: true });
    try {
      return database.prepare("SELECT payload FROM qualification_commit ORDER BY sequence").all()
        .map((row) => JSON.parse(String(row.payload)) as CommitUnit);
    } finally { database.close(); }
  }
  async rows(): Promise<FileEvidenceRow[]> {
    return (await this.units()).flatMap((unit) => unit.rows).filter((row): row is FileEvidenceRow => row.jobType === "file_migration");
  }
  async state(sourceId: string): Promise<FileState> {
    let latest: FileState | undefined;
    for (const row of await this.rows()) {
      const state = row.sourceItemId === sourceId ? row.fileState : undefined;
      if (state && (!latest || state.generation > latest.generation ||
          (state.generation === latest.generation && latest.status === "prepared" && state.status !== "prepared"))) latest = state;
    }
    if (!latest) throw new QualificationBlocked("file_journal_state_missing");
    return latest;
  }
  async run(phase: FilePhase, config: FileMigrationConfig, provider: FileContext["provider"], stopAtPreparedSource?: string): Promise<{ units: CommitUnit[]; interrupted: boolean }> {
    this.#signal.throwIfAborted();
    const committed = await this.units();
    let revision = 0;
    for (const unit of committed) for (const row of unit.rows) revision = Math.max(revision, row.rev);
    if (phase === "plan") revision++;
    if (revision < 1) throw new QualificationBlocked("file_journal_plan_required");
    const context: FileContext = { config, provider, revision, jobDirectory: this.#jobDirectory,
      resume: { checkpoint: committed.at(-1)?.checkpoint ?? null,
        watermarks: Object.fromEntries(committed.filter((unit) => unit.watermark).map((unit) => [unit.watermark!.unitKey, unit.watermark!.value])),
        rows: committed.flatMap((unit) => unit.rows), committedUnits: committed.map((unit) => unit.unitKey) },
      now: () => new Date(), signal: this.#signal };
    const iterable = phase === "plan" ? fileMigrationDriver.collect(context) : phase === "execute"
      ? fileMigrationDriver.execute(context) : fileMigrationDriver.verify(context);
    const iterator = iterable[Symbol.asyncIterator]();
    const observed: CommitUnit[] = [];
    let interrupted = false;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const unit = next.value;
        const database = new DatabaseSync(this.path);
        try {
          database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
          try {
            database.prepare("INSERT INTO qualification_commit(payload) VALUES (?)").run(JSON.stringify(unit));
            database.exec("COMMIT;");
          } catch (error) { database.exec("ROLLBACK;"); throw error; }
        } finally { database.close(); }
        // FULL-synchronous COMMIT and connection close precede callbacks and the next driver effect.
        await this.#onDurable(unit);
        observed.push(unit);
        if (stopAtPreparedSource && unit.rows.some((row) => row.jobType === "file_migration" &&
            row.sourceItemId === stopAtPreparedSource && (row as FileEvidenceRow).fileState?.status === "prepared")) {
          interrupted = true; break;
        }
      }
    } finally { await iterator.return?.(); }
    return { units: observed, interrupted };
  }
}

export function observedCodes(units: readonly CommitUnit[], sourceId?: string): string[] {
  const codes = [...new Set(units.flatMap((unit) => [
    ...unit.rows.filter((row) => sourceId === undefined || (row.jobType === "file_migration" && row.sourceItemId === sourceId)).map((row) => row.code),
    ...unit.findings.filter((finding) => sourceId === undefined || finding.subjectId === sourceId).map((finding) => finding.code),
  ]))].sort();
  if (codes.some((code) => !Object.hasOwn(CODE_BY_NAME, code))) throw new QualificationBlocked("file_probe_unregistered_driver_code");
  return codes;
}
