import assert from "node:assert/strict";
import { it } from "node:test";
import { compareListings, type ListedFile, type ListedHash } from "./listing-comparison.ts";
import { DiskListing, disposeListing } from "./listing.ts";
import type { FileListingComparison } from "./port.ts";

function disposeComparison(comparison: FileListingComparison): void {
  for (const category of [
    comparison.new,
    comparison.changed,
    comparison.unchanged,
    comparison.deleted,
    comparison.retained,
    comparison.timestampOnly,
  ])
    disposeListing(category);
}

it("bounds hash candidate filters and preserves timestamp-only classifications", async () => {
  using source = new DiskListing<ListedFile>();
  using destination = new DiskListing<ListedFile>();
  for (let index = 0; index < 601; index++) {
    const path = `file-${String(index).padStart(4, "0")}`;
    source.add({ path, size: 4, modified: 10n });
    destination.add({ path, size: 4, modified: 0n });
  }
  const pages: number[] = [];
  let disposedHashes = 0;
  const comparison = await compareListings({
    source,
    destination,
    mode: "copy",
    ignoreSize: false,
    noUnicodeNormalization: false,
    ignoreCase: false,
    window: 1n,
    async readHashes(side, paths) {
      pages.push(paths.length);
      const hashes = new DiskListing<ListedHash>(undefined, () => {
        disposedHashes++;
      });
      for (const path of paths)
        hashes.add({
          path,
          hash: side === "destination" && path === "file-0001" ? "different" : "equal",
        });
      return hashes;
    },
  });
  try {
    assert.deepEqual(pages, [256, 256, 256, 256, 89, 89]);
    assert.equal(disposedHashes, 6);
    assert.deepEqual([...comparison.changed], [{ path: "file-0001", size: 4 }]);
    assert.equal([...comparison.timestampOnly].length, 600);
    assert.equal([...comparison.new].length, 0);
    assert.equal([...comparison.retained].length, 0);
  } finally {
    disposeComparison(comparison);
  }
});

it("matches normalized paths and Map last-duplicate behavior without retaining duplicate deletions", async () => {
  using source = new DiskListing<ListedFile>();
  using destination = new DiskListing<ListedFile>();
  source.add({ path: "É", size: 2, modified: 5n });
  destination.add({ path: "é", size: 1, modified: 0n });
  destination.add({ path: "é", size: 2, modified: 5n });
  destination.add({ path: "z", size: 3, modified: 0n });
  destination.add({ path: "z", size: 4, modified: 0n });
  const comparison = await compareListings({
    source,
    destination,
    mode: "mirror",
    ignoreSize: false,
    noUnicodeNormalization: false,
    ignoreCase: true,
    window: 1n,
  });
  try {
    assert.deepEqual([...comparison.unchanged], [{ path: "É", size: 2 }]);
    assert.deepEqual([...comparison.deleted], [{ path: "z", size: 4 }]);
    assert.deepEqual([...comparison.changed], []);
    assert.equal(source.size, 1);
    assert.equal(destination.size, 4);
  } finally {
    disposeComparison(comparison);
  }
});

it("disposes already-returned hash pages when the other side fails", async () => {
  using source = new DiskListing<ListedFile>();
  using destination = new DiskListing<ListedFile>();
  source.add({ path: "a", size: 1, modified: 2n });
  destination.add({ path: "a", size: 1, modified: 0n });
  const failure = new Error("destination failed");
  let disposed = false;
  await assert.rejects(
    compareListings({
      source,
      destination,
      mode: "copy",
      ignoreSize: false,
      noUnicodeNormalization: false,
      ignoreCase: false,
      window: 1n,
      async readHashes(side) {
        if (side === "destination") throw failure;
        return new DiskListing<ListedHash>(undefined, () => {
          disposed = true;
        });
      },
    }),
    (error) => error === failure,
  );
  assert.equal(disposed, true);
});

it("honors cancellation rather than publishing partial categories", async () => {
  using source = new DiskListing<ListedFile>();
  using destination = new DiskListing<ListedFile>();
  source.add({ path: "a", size: 1, modified: 2n });
  const controller = new AbortController();
  const failure = new Error("cancelled");
  controller.abort(failure);
  await assert.rejects(
    compareListings({
      source,
      destination,
      mode: "copy",
      ignoreSize: false,
      noUnicodeNormalization: false,
      ignoreCase: false,
      window: 1n,
      signal: controller.signal,
    }),
    (error) => error === failure,
  );
});
