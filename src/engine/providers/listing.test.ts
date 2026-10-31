import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DiskListing, ListingScratch, disposeListing, indexListing } from "./listing.ts";

it("preserves duplicates, last-value lookup, bigint and repeatable insertion order", () => {
  using listing = new DiskListing<{ path: string; modified: bigint; size: number }>();
  const first = { path: "a", modified: 1n, size: 1 };
  const last = { path: "a", modified: 2n, size: 2 };
  listing.add(first);
  listing.add({ path: "b", modified: 3n, size: 3 });
  assert.equal(listing.has("a"), true);
  listing.add(last);
  assert.equal(listing.size, 3);
  assert.deepEqual(listing.get("a"), last);
  assert.deepEqual([...listing], [first, { path: "b", modified: 3n, size: 3 }, last]);
  assert.deepEqual([...listing.values()], [...listing]);
  assert.deepEqual([...listing.uniqueValues()], [{ path: "b", modified: 3n, size: 3 }, last]);
  listing.delete("a");
  assert.equal(listing.get("a"), undefined);
  assert.equal(listing.has("a"), false);
  assert.equal(listing.size, 1);
});

it("supports scalar folder inventories and takes ownership when indexing", () => {
  let disposed = 0;
  const folders = {
    *[Symbol.iterator]() {
      yield "z";
      yield "é";
      yield "a";
    },
    [Symbol.dispose]() {
      disposed++;
    },
  };
  using listing = indexListing(folders, (path) => path);
  assert.equal(disposed, 1);
  assert.equal(
    indexListing(listing, (path) => path),
    listing,
  );
  assert.equal(listing.get("é"), "é");
  assert.deepEqual([...listing.sorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))], ["a", "z", "é"]);
  disposeListing([]);
  disposeListing(undefined);
});

it("cleans up the input and partial index if conversion fails", () => {
  let disposed = false;
  const failure = new Error("listing failed");
  const input = {
    *[Symbol.iterator]() {
      yield { path: "a" };
      throw failure;
    },
    [Symbol.dispose]() {
      disposed = true;
    },
  };
  assert.throws(
    () => indexListing(input),
    (error) => error === failure,
  );
  assert.equal(disposed, true);
});

it("external sorting preserves stable locale digest order across odd merge runs", () => {
  using listing = new DiskListing<{ path: string; hash: string; size: number }>();
  const paths = ["é", "é", "Z", "z", "a", "😀", "日本", "a10", "a2"];
  const values = Array.from({ length: 4103 }, (_, index) => ({
    path: paths[index % paths.length]!,
    hash: String(index),
    size: index,
  }));
  for (const value of values) listing.add(value);
  const compare = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  const expected = [...values].sort(compare);
  const sorted = [...listing.sorted(compare)];
  assert.deepEqual(sorted, expected);
  const digest = (entries: Iterable<(typeof values)[number]>) => {
    const hash = createHash("sha256");
    for (const entry of entries) hash.update(`${entry.path}\0${entry.size}\0${entry.hash}\n`);
    return hash.digest("hex");
  };
  assert.equal(digest(listing.sorted(compare)), digest(expected));
  assert.deepEqual([...listing], values);
  assert.deepEqual([...listing.sorted(() => 0)], values);
});

it("removes sort scratch on early return, failure and listing disposal", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "migmate-sort-test-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  using scratch = new ListingScratch(parent);
  const listing = scratch.run(() => new DiskListing<{ path: string }>());
  const owner = join(parent, readdirSync(parent)[0]!);
  const path = join(owner, readdirSync(owner)[0]!);
  try {
    for (let index = 0; index < 2049; index++) listing.add({ path: String(index) });
    const iterator = listing.sorted((a, b) => a.path.localeCompare(b.path));
    iterator.next();
    assert.ok(readdirSync(path).some((name) => name.startsWith("sort-")));
    iterator.return?.();
    assert.equal(
      readdirSync(path).some((name) => name.startsWith("sort-")),
      false,
    );
    assert.throws(
      () => [
        ...listing.sorted(() => {
          throw new Error("comparator failed");
        }),
      ],
      /comparator failed/,
    );
    assert.equal(
      readdirSync(path).some((name) => name.startsWith("sort-")),
      false,
    );
  } finally {
    listing[Symbol.dispose]();
  }
  assert.equal(existsSync(path), false);
  listing[Symbol.dispose]();
  assert.throws(() => listing.has("a"), /disposed/);
});
