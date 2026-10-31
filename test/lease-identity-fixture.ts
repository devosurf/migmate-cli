import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { openEngine } from "../src/engine/index.ts";
import { getProcessStartTime, processAlive } from "../src/engine/store/lease.ts";

const [home, mode, output] = process.argv.slice(2);
assert.ok(home && mode && output);
const realSpawn = childProcess.spawnSync;
const realRead = fs.readFileSync;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let attempts = 0;
let remaining = mode === "transient" ? 1 : Infinity;
let procReads = 0;
const linux = mode.startsWith("linux");
if (linux) {
  Object.defineProperty(process, "platform", { value: "linux" });
  // Exercise the existing /proc seam on macOS as well as Linux. Field 22
  // remains an opaque kernel tick, not a timestamp estimated by JavaScript.
  mock.method(fs, "readFileSync", function (...args: Parameters<typeof fs.readFileSync>) {
    if (args[0] === `/proc/${process.pid}/stat`) {
      procReads++;
      if (mode === "linux-failure") throw Object.assign(new Error("denied"), { code: "EACCES" });
      return `${process.pid} (node with spaces) S ${Array(18).fill("0").join(" ")} 12345`;
    }
    if (args[0] === `/proc/${process.pid}/status`) return "Uid:\t501\t501\t501\t501\n";
    return realRead(...args);
  });
}
mock.method(
  childProcess,
  "spawnSync",
  function (...args: Parameters<typeof childProcess.spawnSync>) {
    const argv = args[1];
    if (Array.isArray(argv) && argv.includes("lstart=")) {
      attempts++;
      if (remaining-- > 0) {
        const base = { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null };
        if (mode === "empty") return { ...base, status: 0 };
        if (mode === "malformed") return { ...base, status: 0, stdout: "not a process" };
        if (mode === "invalid-date")
          return { ...base, status: 0, stdout: "Fri Xxx 30 12:00:00 2026 501 S /bin/node" };
        if (mode === "nonzero") return { ...base, status: 1 };
        if (mode === "signal") return { ...base, signal: "SIGKILL" };
        const code = ["ENOENT", "EACCES", "EAGAIN"].includes(mode) ? mode : "ETIMEDOUT";
        return { ...base, error: Object.assign(new Error(code), { code }) };
      }
    }
    return realSpawn(...args);
  },
);
syncBuiltinESMExports();

try {
  if (linux) {
    if (mode === "linux-failure") {
      assert.throws(
        () => getProcessStartTime(),
        /Process start identity could not be established/u,
      );
      assert.equal(procReads, 1);
    } else {
      assert.equal(getProcessStartTime(), 12345);
      assert.equal(getProcessStartTime(), 12345);
      assert.equal(procReads, 2);
    }
    assert.equal(attempts, 0);
  } else if (mode === "foreign") {
    assert.throws(() => getProcessStartTime(process.ppid), /Process start identity/u);
    assert.equal(attempts, 1);
    assert.equal(processAlive(process.ppid, 1), null);
    assert.equal(attempts, 2);
  } else {
    const engine = openEngine({ home });
    try {
      const created = await engine.initJob({ type: "file_migration" });
      assert.ok(created.ok);
      const db = new DatabaseSync(join(home, "jobs", created.value.id, "state.db"));
      try {
        let entered = false;
        const acquire = () =>
          engine.withWriter(created.value, async () => {
            entered = true;
            return db.prepare("SELECT process_start_time AS identity FROM lease").get()?.identity;
          });
        if (mode === "transient") {
          const first = await acquire();
          assert.ok(first.ok);
          assert.equal(entered, true);
          // Reconciliation performs its own, unchanged inspection after acquisition.
          assert.equal(attempts, 3);
          remaining = 1;
          const second = await acquire();
          assert.ok(second.ok);
          assert.equal(second.value, first.value);
          assert.equal(attempts, 6);
          fs.writeFileSync(`${output}.tmp`, JSON.stringify({ identity: first.value, attempts }));
        } else {
          await assert.rejects(acquire(), /Process start identity could not be established/u);
          assert.equal(entered, false);
          assert.equal(db.prepare("SELECT count(*) AS n FROM lease").get()?.n, 0);
          assert.equal(attempts, mode === "permanent" ? 2 : 1);
        }
      } finally {
        db.close();
      }
    } finally {
      engine.close();
    }
  }
  if (mode !== "transient")
    fs.writeFileSync(`${output}.tmp`, JSON.stringify({ attempts, procReads }));
} catch (error) {
  fs.writeFileSync(
    `${output}.tmp`,
    JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : null }),
  );
} finally {
  mock.restoreAll();
  Object.defineProperty(process, "platform", platform);
  syncBuiltinESMExports();
  fs.renameSync(`${output}.tmp`, output);
}
// Remain observable until the parent has compared the independently read identity.
setInterval(() => {}, 1000);
