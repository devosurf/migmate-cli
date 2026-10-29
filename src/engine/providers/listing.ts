import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";

const PAGE_SIZE = 256;
const SORT_RUN_SIZE = 1024;

function database(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // These are disposable indexes, never durable evidence. Bound SQLite's cache as
  // well as JS pages; a listing may be many times larger than available memory.
  db.exec(
    "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;",
  );
  return db;
}

/** Repeatable, caller-owned disk inventory. Duplicates retain input order;
 * lookup returns the last duplicate. Dispose after all consumers finish. */
export class DiskListing<T> implements Iterable<T>, Disposable {
  readonly #directory: string;
  readonly #db: DatabaseSync;
  readonly #insert: StatementSync;
  readonly #lookup: StatementSync;
  readonly #contains: StatementSync;
  readonly #remove: StatementSync;
  readonly #page: StatementSync;
  readonly #key: (value: T) => string;
  readonly #onDispose: (() => void) | undefined;
  #pending = 0;
  #size = 0;
  #closed = false;
  #sortId = 0;

  constructor(
    key: (value: T) => string = (value) => {
      if (
        value !== null &&
        typeof value === "object" &&
        "path" in value &&
        typeof value.path === "string"
      )
        return value.path;
      throw new TypeError("A listing value needs a path or an explicit key");
    },
    onDispose?: () => void,
  ) {
    this.#directory = mkdtempSync(join(tmpdir(), "migmate-listing-"));
    this.#key = key;
    this.#onDispose = onDispose;
    let opened: DatabaseSync | undefined;
    try {
      this.#db = opened = database(join(this.#directory, "listing.sqlite"));
      this.#db.exec(
        "CREATE TABLE entries (id INTEGER PRIMARY KEY, path TEXT NOT NULL, value BLOB NOT NULL); CREATE INDEX entries_path ON entries(path, id);",
      );
      this.#insert = this.#db.prepare("INSERT INTO entries(path,value) VALUES (?,?)");
      this.#lookup = this.#db.prepare(
        "SELECT value FROM entries WHERE path=? ORDER BY id DESC LIMIT 1",
      );
      this.#contains = this.#db.prepare("SELECT 1 FROM entries WHERE path=? LIMIT 1");
      this.#remove = this.#db.prepare("DELETE FROM entries WHERE path=?");
      this.#page = this.#db.prepare("SELECT id,value FROM entries WHERE id>? ORDER BY id LIMIT ?");
    } catch (error) {
      opened?.close();
      rmSync(this.#directory, { recursive: true, force: true });
      throw error;
    }
  }

  #flush(): void {
    if (this.#closed) throw new Error("Listing is disposed");
    if (this.#pending > 0) {
      this.#db.exec("COMMIT");
      this.#pending = 0;
    }
  }

  add(value: T): void {
    if (this.#closed) throw new Error("Listing is disposed");
    const path = this.#key(value);
    const bytes = serialize(value);
    if (this.#pending === 0) this.#db.exec("BEGIN");
    this.#insert.run(path, bytes);
    this.#size++;
    if (++this.#pending >= 1024) this.#flush();
  }

  get(path: string): T | undefined {
    if (this.#closed) throw new Error("Listing is disposed");
    const row = this.#lookup.get(path);
    return row === undefined ? undefined : (deserialize(row.value as Uint8Array) as T);
  }

  has(path: string): boolean {
    if (this.#closed) throw new Error("Listing is disposed");
    return this.#contains.get(path) !== undefined;
  }

  delete(path: string): void {
    if (this.#closed) throw new Error("Listing is disposed");
    if (this.#pending === 0) this.#db.exec("BEGIN");
    this.#size -= Number(this.#remove.run(path).changes);
    if (++this.#pending >= 1024) this.#flush();
  }

  get size(): number {
    return this.#size;
  }

  *values(): IterableIterator<T> {
    this.#flush();
    let after = 0;
    for (;;) {
      const rows = this.#page.all(after, PAGE_SIZE);
      if (rows.length === 0) return;
      for (const row of rows) {
        after = Number(row.id);
        yield deserialize(row.value as Uint8Array) as T;
      }
    }
  }

  /** Last value per key, for Map-compatible comparison of duplicate paths. */
  *uniqueValues(): IterableIterator<T> {
    this.#flush();
    const page = this.#db.prepare(
      "SELECT id,value FROM entries e WHERE id>? AND NOT EXISTS (SELECT 1 FROM entries later WHERE later.path=e.path AND later.id>e.id) ORDER BY id LIMIT ?",
    );
    let after = 0;
    for (;;) {
      const rows = page.all(after, PAGE_SIZE);
      if (rows.length === 0) return;
      for (const row of rows) {
        after = Number(row.id);
        yield deserialize(row.value as Uint8Array) as T;
      }
    }
  }

  [Symbol.iterator](): Iterator<T> {
    return this.values();
  }

  /** External stable merge sort. Only one initial run or two merge pages are
   * resident; equal keys always take the earlier input run first. Early iterator
   * return and comparator failures both remove the scratch database. */
  *sorted(compare: (a: T, b: T) => number): IterableIterator<T> {
    this.#flush();
    const path = join(this.#directory, `sort-${this.#sortId++}.sqlite`);
    const db = database(path);
    try {
      db.exec(
        "CREATE TABLE runs (pass INTEGER, run INTEGER, position INTEGER, value BLOB, PRIMARY KEY(pass,run,position)) WITHOUT ROWID; BEGIN;",
      );
      const insert = db.prepare("INSERT INTO runs VALUES (?,?,?,?)");
      const page = db.prepare(
        "SELECT position,value FROM runs WHERE pass=? AND run=? AND position>? ORDER BY position LIMIT ?",
      );
      function* runValues(pass: number, run: number): IterableIterator<T> {
        let after = -1;
        for (;;) {
          const rows = page.all(pass, run, after, PAGE_SIZE);
          if (rows.length === 0) return;
          for (const row of rows) {
            after = Number(row.position);
            yield deserialize(row.value as Uint8Array) as T;
          }
        }
      }
      let runs = 0;
      let chunk: T[] = [];
      const save = () => {
        chunk.sort(compare);
        for (let i = 0; i < chunk.length; i++) insert.run(0, runs, i, serialize(chunk[i]));
        runs++;
        chunk = [];
      };
      for (const value of this) {
        chunk.push(value);
        if (chunk.length === SORT_RUN_SIZE) save();
      }
      if (chunk.length > 0) save();
      let pass = 0;
      while (runs > 1) {
        for (let run = 0; run < runs; run += 2) {
          const left = runValues(pass, run);
          const right = runValues(pass, run + 1);
          let a = left.next();
          let b = right.next();
          let position = 0;
          while (!a.done || !b.done) {
            if (!a.done && (b.done || !(compare(a.value, b.value) > 0))) {
              insert.run(pass + 1, run / 2, position++, serialize(a.value));
              a = left.next();
            } else if (!b.done) {
              insert.run(pass + 1, run / 2, position++, serialize(b.value));
              b = right.next();
            }
          }
        }
        db.prepare("DELETE FROM runs WHERE pass=?").run(pass++);
        db.exec("COMMIT; BEGIN;");
        runs = Math.ceil(runs / 2);
      }
      yield* runValues(pass, 0);
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  }

  [Symbol.dispose](): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close();
    } finally {
      rmSync(this.#directory, { recursive: true, force: true });
      this.#onDispose?.();
    }
  }
}

export function disposeListing(value: unknown): void {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    Symbol.dispose in value
  ) {
    const dispose = value[Symbol.dispose];
    if (typeof dispose === "function") dispose.call(value);
  }
}

/** Takes ownership of its input, reusing an existing disk index when possible. */
export function indexListing<T>(input: Iterable<T>, key?: (value: T) => string): DiskListing<T> {
  if (input instanceof DiskListing) return input;
  const listing = new DiskListing<T>(key);
  try {
    for (const value of input) listing.add(value);
    return listing;
  } catch (error) {
    listing[Symbol.dispose]();
    throw error;
  } finally {
    disposeListing(input);
  }
}
