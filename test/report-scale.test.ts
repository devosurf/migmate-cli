import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "node:test";

it(
  "reports 250,000 files across three mappings and staged passes within a fixed heap, then closes",
  { timeout: 900_000 },
  async (t) => {
    const results: Array<{
      files: number;
      bytes: number;
      headerBytes: number;
      peakHeap: number;
      maxRSS: number;
    }> = [];
    for (const files of [25_000, 250_000]) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--max-old-space-size=192",
          new URL("./report-scale-fixture.ts", import.meta.url).pathname,
          String(files),
        ],
        { timeout: 800_000, maxBuffer: 1024 * 1024 },
      );
      results.push(JSON.parse(stdout));
    }
    const [small, large] = results;
    t.diagnostic(JSON.stringify(results));
    assert.equal(large!.files, 250_000);
    assert.ok(large!.bytes > 536_870_888);
    assert.ok(
      large!.headerBytes > 536_870_888,
      "even the JSONL header exceeds the single-string limit",
    );
    assert.ok(large!.bytes > small!.bytes * 8);
    assert.ok(large!.peakHeap < small!.peakHeap * 4, JSON.stringify(results));
  },
);
