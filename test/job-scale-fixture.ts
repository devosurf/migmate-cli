import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openEngine } from "../src/engine/index.ts";
import { FakeFileMigrationPort } from "../src/engine/providers/fake.ts";
import type { FileHashEntry, ProviderPort } from "../src/engine/providers/port.ts";
import { DiskListing, disposeListing } from "../src/engine/providers/listing.ts";
import { parseListingJson } from "../src/engine/providers/listing-json.ts";
import { compareListings, type ListedFile } from "../src/engine/providers/listing-comparison.ts";
import { fileFixture, value, approve, closeDecision } from "./engine-fixture.ts";

const files = Number(process.argv[2] ?? 5_000_000);
assert.ok(Number.isSafeInteger(files) && files >= 3003);
const started = performance.now();
let peakHeap = 0;
let peakRss = 0;
function sample() {
  const memory = process.memoryUsage();
  peakHeap = Math.max(peakHeap, memory.heapUsed);
  peakRss = Math.max(peakRss, memory.rss);
}
const sampler = setInterval(sample, 10);
sampler.unref();
const now = () => new Date("2026-10-29T00:00:00.000Z");
const home = await mkdtemp(join(tmpdir(), "migmate-job-scale-"));
const counts = new Map<string, number>();
const observations = new Map<string, number>();
let synthetic = false;
let listingTimeMs = 0;
let listingRecords = 0;
const checksum = "a".repeat(64);

// Same incremental parser as the worker's operations/list response. Only a
// 128 KiB transport chunk and one record are resident, not a synthetic array.
async function listing<T>(
  count: number,
  project: (file: { Path: string; Size: number; ID: string }) => T,
): Promise<DiskListing<T>> {
  const began = performance.now();
  const result = new DiskListing<T>();
  async function* chunks() {
    let chunk = '{"list":[';
    for (let index = count - 1; index >= 0; index--) {
      if (index !== count - 1) chunk += ",";
      chunk += JSON.stringify({
        Path: `folder/file-${String(index).padStart(9, "0")}.txt`,
        Name: `file-${String(index).padStart(9, "0")}.txt`,
        Size: 4,
        MimeType: "application/octet-stream",
        ModTime: "2026-10-29T00:00:00.000000000Z",
        IsDir: false,
        ID: `file-${index}`,
        Hashes: { sha256: checksum },
      });
      if (chunk.length >= 128 * 1024) {
        sample();
        yield Buffer.from(chunk);
        chunk = "";
      }
    }
    yield Buffer.from(chunk + "]}");
  }
  try {
    await parseListingJson(chunks(), "list", (value) => {
      assert.ok(
        value !== null &&
          typeof value === "object" &&
          "Path" in value &&
          "Size" in value &&
          "ID" in value,
      );
      assert.equal(typeof value.Path, "string");
      assert.equal(typeof value.Size, "number");
      assert.equal(typeof value.ID, "string");
      // The checks above deliberately validate the fake wire shape before the
      // same provider-neutral index used by production receives it.
      if (
        typeof value.Path !== "string" ||
        typeof value.Size !== "number" ||
        typeof value.ID !== "string"
      )
        throw new Error("Invalid fake listing");
      result.add(project({ Path: value.Path, Size: value.Size, ID: value.ID }));
      listingRecords++;
    });
    return result;
  } catch (error) {
    result[Symbol.dispose]();
    throw error;
  } finally {
    listingTimeMs += performance.now() - began;
    sample();
  }
}

const fixture = fileFixture(
  [0, 1, 2].flatMap((index) => [
    {
      id: `root-${index}`,
      parentId: "source-root",
      name: `root-${index}`,
      kind: "folder" as const,
    },
    {
      id: `seed-${index}`,
      parentId: `root-${index}`,
      name: "seed.txt",
      kind: "file" as const,
      content: "data",
    },
  ]),
);
fixture.googleAbout = { user: { emailAddress: "files@example.com" }, canCreateDrives: true };
fixture.now = now;
const fake = new FakeFileMigrationPort(fixture);
const overrides: Partial<ProviderPort> = {
  async resolveFilePass(input) {
    const resolved = await fake.resolveFilePass(input);
    const index = Number(input.sourceItemId.replace("root-", ""));
    const count = Math.floor(files / 3) + (index < files % 3 ? 1 : 0);
    counts.set(resolved.source.fs, count);
    counts.set(resolved.destination.fs, count);
    return resolved;
  },
  async listFileHashes(input) {
    if (!synthetic) return fake.listFileHashes(input);
    assert.equal(input.paths, undefined);
    return listing<FileHashEntry>(counts.get(input.root.fs)!, (file) => ({
      path: file.Path,
      size: file.Size,
      hash: checksum,
      id: file.ID,
    }));
  },
  async listFolders(input) {
    if (!synthetic) return fake.listFolders(input);
    return ["empty", "folder", "é-empty"];
  },
  async compareFileListings(input) {
    if (!synthetic) return fake.compareFileListings(input);
    const observation = observations.get(input.source.fs) ?? 0;
    observations.set(input.source.fs, observation + 1);
    const count = counts.get(input.source.fs)!;
    const source = await listing<ListedFile>(count, (file) => ({
      path: file.Path,
      size: observation === 0 && Number(file.ID.slice(5)) < Math.min(2001, count) ? 5 : file.Size,
      modified: 1_000_000_000n,
    }));
    let destination: DiskListing<ListedFile> | undefined;
    try {
      destination = await listing<ListedFile>(count, (file) => ({
        path: file.Path,
        size: file.Size,
        modified: 1_000_000_000n,
      }));
      return await compareListings({
        source,
        destination,
        mode: input.mode,
        ignoreSize: false,
        noUnicodeNormalization: false,
        ignoreCase: false,
        window: 1_000_000_000n,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } finally {
      source[Symbol.dispose]();
      disposeListing(destination);
    }
  },
};
const provider: ProviderPort = new Proxy(fake, {
  get(target, key) {
    const override = Reflect.get(overrides, key);
    if (override !== undefined) return override;
    const member = Reflect.get(target, key, target);
    return typeof member === "function" ? member.bind(target) : member;
  },
});
const engine = openEngine({ home, now, provider });
try {
  const ref = value(
    await engine.initJob({
      type: "file_migration",
      config: {
        mappings: [],
        options: { staged: true, consistencyIntervalMs: 0, mappingsInFlight: 1 },
      },
    }),
  );
  value(
    await engine.withWriterResult(ref, (writer) =>
      writer.loadManifest({
        format: "json",
        content: JSON.stringify({
          version: 1,
          mappings: [0, 1, 2].map((index) => ({
            id: `mapping-${index}`,
            source: { type: "sharepoint", driveId: "source-drive", folderPath: `root-${index}` },
            destination: { type: "google_shared_drive", create: `Scale ${index}` },
            members: [{ email: "reader@example.com", type: "user", role: "reader" }],
          })),
        }),
      }),
    ),
  );
  await approve({ engine, ref });
  value(await engine.withWriterResult(ref, (writer) => writer.execute()));
  const plan = value(await engine.withWriterResult(ref, (writer) => writer.plan({ final: true })));
  value(
    await engine.withWriterResult(ref, (writer) =>
      writer.approve({
        approver: "scale-operator",
        mode: "unattended",
        planDigest: plan.planDigest,
        freeze: { by: "scale-operator", at: now().toISOString(), how: "Synthetic source frozen" },
      }),
    ),
  );
  synthetic = true;
  const executeStarted = performance.now();
  value(await engine.withWriterResult(ref, (writer) => writer.execute()));
  const executeTimeMs = performance.now() - executeStarted;
  assert.deepEqual([...observations.values()], [2, 2, 2]);
  const status = value(await engine.reader(ref).status());
  assert.ok(status.verificationDigest);
  const db = new DatabaseSync(join(home, "jobs", ref.id, "state.db"));
  try {
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM item WHERE rev=? AND phase='verify' AND item_type='file'",
          )
          .get(plan.revision)!.count,
      ),
      files,
    );
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT SUM(json_array_length(payload,'$.fileScope.verification.coveredPaths')) AS count FROM item WHERE rev=? AND phase='verify'",
          )
          .get(plan.revision)!.count,
      ),
      files + 9,
    );
    assert.ok(
      Number(
        db
          .prepare(
            "SELECT MAX(json_array_length(payload,'$.fileScope.verification.coveredPaths')) AS count FROM item WHERE rev=? AND phase='verify'",
          )
          .get(plan.revision)!.count,
      ) <= 1000,
    );
  } finally {
    db.close();
  }
  const closeStarted = performance.now();
  value(
    await engine.withWriterResult(ref, async (writer) =>
      writer.close(await closeDecision({ engine, ref })),
    ),
  );
  const closeTimeMs = performance.now() - closeStarted;
  assert.equal(value(await engine.reader(ref).status()).state, "closed");
  const artifacts = value(await engine.reader(ref).artifacts()).artifacts;
  assert.equal(artifacts.length, 5);
  let artifactBytes = 0;
  let reportRows = 0;
  let headerBytes = 0;
  for (const artifact of artifacts) {
    artifactBytes += (await stat(artifact.path)).size;
    const hash = createHash("sha256");
    let header = true;
    let pending = "";
    for await (const chunk of createReadStream(artifact.path)) {
      hash.update(chunk);
      sample();
      if (artifact.name !== "report.jsonl") continue;
      let text = String(chunk);
      if (header) {
        const newline = text.indexOf("\n");
        headerBytes += Buffer.byteLength(newline < 0 ? text : text.slice(0, newline));
        if (newline < 0) continue;
        header = false;
        text = text.slice(newline + 1);
      }
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const record = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (record.kind === "row") reportRows++;
        assert.notEqual(record.kind, "finding", "synthetic listings must verify cleanly");
      }
    }
    assert.equal(hash.digest("hex"), artifact.digest);
    if (artifact.name === "report.jsonl") assert.equal(pending, "");
  }
  assert.ok(reportRows >= files);
  sample();
  assert.ok(peakHeap < 192 * 1024 * 1024, `heap peak ${peakHeap}`);
  console.log(
    JSON.stringify({
      files,
      mappings: 3,
      heapLimitMiB: 192,
      peakHeap,
      peakRss,
      maxRSS: process.resourceUsage().maxRSS,
      listingRecords,
      listingTimeMs,
      executeTimeMs,
      closeTimeMs,
      artifactBytes,
      headerBytes,
      reportRows,
      wallTimeMs: performance.now() - started,
    }),
  );
} finally {
  clearInterval(sampler);
  engine.close();
  await rm(home, { recursive: true, force: true });
}
