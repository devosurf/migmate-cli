import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { destinationDigest } from "../src/engine/drivers/file-migration.ts";
import { DiskListing } from "../src/engine/providers/listing.ts";
import type { FileHashEntry } from "../src/engine/providers/port.ts";

it("preserves historical destination digests including locale ties, duplicates and escaped paths", () => {
  const paths = ["z", "A", "a", "é", "e\u0301", "10", "2", "😀", "\uffff", 'a\n"\\', "", "é"];
  const files: FileHashEntry[] = Array.from({ length: 12_345 }, (_, index) => ({
    path: `${paths[index % paths.length]}${index % 7}`,
    size: index % 3 === 0 ? -1 : index,
    hash: index % 2 === 0 ? null : `hash-${index}`,
    ...(index % 5 === 0 ? { id: `id-${index}` } : {}),
  }));
  const md5 = files.filter((_, index) => index % 11 === 0);
  const folders = [...paths, "nested/empty", "nested/"].reverse();
  const historicalEntries = (entries: FileHashEntry[]) =>
    entries
      .map((entry) => [entry.path, entry.size, entry.hash, entry.id ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const expected = createHash("sha256")
    .update(JSON.stringify([historicalEntries(files), historicalEntries(md5), [...folders].sort()]))
    .digest("hex");
  const source = new DiskListing<FileHashEntry>();
  const fallback = new DiskListing<FileHashEntry>();
  const directories = new DiskListing<string>((path) => path);
  try {
    for (const entry of files) source.add(entry);
    for (const entry of md5) fallback.add(entry);
    for (const path of folders) directories.add(path);
    assert.equal(destinationDigest(source, fallback, directories), expected);
    assert.equal(
      destinationDigest(source, fallback, directories),
      expected,
      "repeatable after external sort cleanup",
    );
  } finally {
    source[Symbol.dispose]();
    fallback[Symbol.dispose]();
    directories[Symbol.dispose]();
  }
});

it("preserves the historical empty destination digest", () => {
  const files = new DiskListing<FileHashEntry>();
  const md5 = new DiskListing<FileHashEntry>();
  const folders = new DiskListing<string>((path) => path);
  try {
    assert.equal(
      destinationDigest(files, md5, folders),
      createHash("sha256").update("[[],[],[]]").digest("hex"),
    );
  } finally {
    files[Symbol.dispose]();
    md5[Symbol.dispose]();
    folders[Symbol.dispose]();
  }
});
