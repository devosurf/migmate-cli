import { DiskListing } from "./listing.ts";
import type { FileListingComparison, FileListingComparisonEntry } from "./port.ts";

export interface ListedFile {
  path: string;
  size: number;
  modified: bigint;
}

export interface ListedHash {
  path: string;
  hash: string;
}

/** Compare already-observed inventories without retaining a library-sized map
 * or filter. Inputs remain caller-owned; returned categories are caller-owned.
 * Hash reads are bounded to 256 candidate pairs per request. */
export async function compareListings(input: {
  source: DiskListing<ListedFile>;
  destination: DiskListing<ListedFile>;
  mode: "copy" | "mirror";
  ignoreSize: boolean;
  noUnicodeNormalization: boolean;
  ignoreCase: boolean;
  window: bigint;
  readHashes?: (
    side: "source" | "destination",
    paths: string[],
  ) => Promise<DiskListing<ListedHash>>;
  signal?: AbortSignal;
}): Promise<FileListingComparison> {
  input.signal?.throwIfAborted();
  using temporary = new DisposableStack();
  using output = new DisposableStack();
  const key = (file: ListedFile) => {
    const normalized = input.noUnicodeNormalization ? file.path : file.path.normalize("NFC");
    return input.ignoreCase ? normalized.toLowerCase() : normalized;
  };
  const remaining = temporary.use(new DiskListing<ListedFile>(key));
  for (const file of input.destination) {
    input.signal?.throwIfAborted();
    remaining.add(file);
  }
  const categories = {
    new: temporary.use(new DiskListing<FileListingComparisonEntry>()),
    changed: temporary.use(new DiskListing<FileListingComparisonEntry>()),
    unchanged: temporary.use(new DiskListing<FileListingComparisonEntry>()),
    deleted: temporary.use(new DiskListing<FileListingComparisonEntry>()),
    retained: temporary.use(new DiskListing<FileListingComparisonEntry>()),
    timestampOnly: temporary.use(new DiskListing<FileListingComparisonEntry>()),
  };
  const candidates: { source: ListedFile; destination: ListedFile }[] = [];
  async function flushCandidates(): Promise<void> {
    if (candidates.length === 0 || input.readHashes === undefined) return;
    input.signal?.throwIfAborted();
    using source = await input.readHashes(
      "source",
      candidates.map((pair) => pair.source.path),
    );
    using destination = await input.readHashes(
      "destination",
      candidates.map((pair) => pair.destination.path),
    );
    for (const pair of candidates) {
      const hash = source.get(pair.source.path)?.hash;
      // IgnoreChecksum controls post-copy validation, not rclone's Equal hash
      // branch. SharePoint still uses that branch if a common hash exists.
      const timestampOnly =
        hash !== undefined && hash === destination.get(pair.destination.path)?.hash;
      categories[timestampOnly ? "timestampOnly" : "changed"].add({
        path: pair.source.path,
        size: pair.source.size,
      });
    }
    candidates.length = 0;
  }
  for (const file of input.source) {
    input.signal?.throwIfAborted();
    const entry = { path: file.path, size: file.size };
    const previous = remaining.get(key(file));
    remaining.delete(key(file));
    if (previous === undefined) {
      categories.new.add(entry);
      continue;
    }
    const difference = file.modified - previous.modified;
    const sizeDiffers =
      !input.ignoreSize && file.size >= 0 && previous.size >= 0 && file.size !== previous.size;
    if (sizeDiffers) categories.changed.add(entry);
    else if (difference < input.window && difference > -input.window)
      categories.unchanged.add(entry);
    else if (input.readHashes !== undefined) {
      candidates.push({ source: file, destination: previous });
      if (candidates.length === 256) await flushCandidates();
    } else categories.changed.add(entry);
  }
  await flushCandidates();
  for (const file of remaining.uniqueValues()) {
    input.signal?.throwIfAborted();
    categories[input.mode === "mirror" ? "deleted" : "retained"].add({
      path: file.path,
      size: file.size,
    });
  }
  function sorted(
    category: DiskListing<FileListingComparisonEntry>,
  ): DiskListing<FileListingComparisonEntry> {
    const result = output.use(new DiskListing<FileListingComparisonEntry>());
    for (const entry of category.sorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
      result.add(entry);
    return result;
  }
  const result = {
    new: sorted(categories.new),
    changed: sorted(categories.changed),
    unchanged: sorted(categories.unchanged),
    deleted: sorted(categories.deleted),
    retained: sorted(categories.retained),
    timestampOnly: sorted(categories.timestampOnly),
    modifyWindowNs: input.window.toString(),
  };
  input.signal?.throwIfAborted();
  output.move();
  return result;
}
