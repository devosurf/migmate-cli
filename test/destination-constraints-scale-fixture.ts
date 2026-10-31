import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { collectDestinationConstraints } from "../src/engine/providers/destination-constraints.ts";
import type { SourceEntry } from "../src/engine/providers/port.ts";
import { DiskListing } from "../src/engine/providers/listing.ts";

// The parent invokes this fixture with --expose-gc and a fixed 64 MiB heap.
const gc: () => void = runInNewContext("gc");
// Sample only after the current job ends: garbage still reachable from it
// (deferred finalization) otherwise counts as retained heap.
const settle = async () => {
  await nextTurn();
  gc();
  gc();
};
await settle();
const baseline = process.memoryUsage().heapUsed;
let retainedHeap = 0;
const measure = async () => {
  await settle();
  retainedHeap = Math.max(retainedHeap, process.memoryUsage().heapUsed - baseline);
  assert.ok(retainedHeap < 8 * 1024 * 1024, `retained heap grew by ${retainedHeap} bytes`);
};
const groupSize = 4097;
const folders = 1025;
const destination = {
  destinationName: (name: string) => `encoded:${name}`,
  destinationSiblingKey: (name: string) => name,
};
function entry(id: string, name: string, kind: "file" | "folder"): SourceEntry {
  return {
    id,
    name,
    kind,
    parentId: "root",
    driveId: "source-drive",
    size: kind === "folder" ? null : 1,
    etag: null,
    createdAt: "2026-10-30T00:00:00Z",
    modifiedAt: "2026-10-30T00:00:00Z",
    mimeType: null,
    identity: id,
    downloadable: kind === "file",
    webUrl: null,
    packageSections: null,
  };
}

let flatFindings = 0;
let flatDisposed = 0;
{
  using findings = await collectDestinationConstraints({
    provider: {
      async listSourceChildren() {
        return {
          *[Symbol.iterator]() {
            for (let index = 0; index < groupSize; index++)
              yield entry(`unique-${index}`, `${index}-${"x".repeat(2048)}`, "file");
            for (let index = 0; index < groupSize; index++)
              yield entry(`duplicate-${index}`, "duplicate?", "file");
          },
          [Symbol.dispose]() {
            flatDisposed++;
          },
        };
      },
    },
    destination,
    sourceDriveId: "source-drive",
    sourceItemId: "root",
  });
  assert.ok(findings instanceof DiskListing);
  assert.equal(flatDisposed, 1);
  assert.equal(findings.size, groupSize * 3);
  await measure();
  let notices = 0;
  let duplicates = 0;
  for (const finding of findings) {
    flatFindings++;
    if (finding.code === "destination_duplicate_name") {
      assert.equal(finding.sourceId, `duplicate-${duplicates++}`);
      assert.equal(finding.detail.siblingSourceCount, groupSize);
      assert.deepEqual(finding.detail.siblingSourceIds, ["duplicate-0", "duplicate-1"]);
      assert.equal(finding.blocking, true);
    } else {
      assert.equal(finding.code, "destination_name_encoded");
      assert.equal(finding.blocking, false);
      notices++;
    }
  }
  assert.equal(duplicates, groupSize);
  assert.equal(notices, groupSize * 2);
  await measure();
}

let frontierFindings = 0;
let listed = 0;
let frontierDisposed = 0;
{
  using findings = await collectDestinationConstraints({
    provider: {
      async listSourceChildren({ itemId }) {
        if (itemId !== "root") {
          assert.equal(itemId, `folder-${folders - ++listed}`);
          // All remaining siblings are pending here; measuring only after return
          // would miss a heap-resident frontier that had already been drained.
          if (listed === 1) await measure();
        }
        return {
          *[Symbol.iterator]() {
            if (itemId === "root")
              for (let index = 0; index < folders; index++)
                yield entry(`folder-${index}`, `${index}-${"y".repeat(16_384)}`, "folder");
          },
          [Symbol.dispose]() {
            frontierDisposed++;
          },
        };
      },
    },
    destination,
    sourceDriveId: "source-drive",
    sourceItemId: "root",
  });
  assert.equal(listed, folders);
  assert.equal(frontierDisposed, folders + 1);
  for (const finding of findings) {
    assert.equal(finding.sourceId, `folder-${frontierFindings++}`);
    assert.equal(finding.code, "destination_name_encoded");
    assert.equal(finding.blocking, false);
  }
  assert.equal(findings.size, folders);
  await measure();
}
console.log(
  JSON.stringify({
    flatItems: groupSize * 2,
    flatFindings,
    folders,
    frontierFindings,
    retainedHeap,
  }),
);
