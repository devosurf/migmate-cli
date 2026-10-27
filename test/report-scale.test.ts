import assert from "node:assert/strict";
import { constants } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "node:test";

it(
  "reports 250,000 files across three mappings and staged passes within a fixed heap, then closes",
  // ADR-0015 requires readiness and final report renders. The previous single-render
  // gate took ~211 s on hosted darwin-x64; budget both renders within the 30-minute job.
  { timeout: 600_000 },
  async (t) => {
    const results: Array<{
      files: number;
      bytes: number;
      headerBytes: number;
      peakHeap: number;
      maxRSS: number;
      wallTimeMs: number;
    }> = [];
    for (const files of [25_000, 250_000]) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--max-old-space-size=192",
          new URL("./report-scale-fixture.ts", import.meta.url).pathname,
          String(files),
        ],
        { timeout: 540_000, maxBuffer: 1024 * 1024, signal: t.signal },
      );
      results.push(JSON.parse(stdout));
    }
    const [small, large] = results;
    t.diagnostic(JSON.stringify(results));
    assert.equal(large!.files, 250_000);
    assert.ok(large!.bytes > constants.MAX_STRING_LENGTH);
    assert.ok(large!.bytes < 1_500_000_000, "keep the default gate's I/O under 1.5 GB");
    assert.ok(large!.headerBytes > small!.headerBytes * 8);
    assert.ok(large!.bytes > small!.bytes * 8);
    assert.ok(large!.peakHeap < small!.peakHeap * 4, JSON.stringify(results));
  },
);
