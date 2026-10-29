import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "node:test";

it(
  "streams listing, settling, verification, paged coverage and go-live reports under a fixed heap",
  { timeout: 180_000 },
  async (t) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--max-old-space-size=192",
        new URL("./job-scale-fixture.ts", import.meta.url).pathname,
        "6003",
      ],
      { timeout: 170_000, maxBuffer: 1024 * 1024, signal: t.signal },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.files, 6003);
    assert.equal(result.mappings, 3);
    assert.ok(result.peakHeap < 192 * 1024 * 1024);
    assert.ok(result.listingRecords >= 6003 * 8);
    assert.ok(result.reportRows >= 6003);
    t.diagnostic(stdout.trim());
  },
);
