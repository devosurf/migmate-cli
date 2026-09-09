import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { ProviderFault } from "./credentials.ts";
import { createTransferSupervisor } from "./transfer-worker.ts";

// Opt-in, real executable only. These exercise the supervisor seam, not route qualification.
const binaryPath = process.env.MIGMATE_TEST_RCLONE_BINARY;
const binarySha256 = process.env.MIGMATE_TEST_RCLONE_SHA256;
const binaryProvenance = process.env.MIGMATE_TEST_RCLONE_PROVENANCE;
const enabled = process.platform !== "win32" && binaryPath !== undefined &&
  binarySha256 !== undefined && binaryProvenance !== undefined;

function suppliedBinary() {
  assert.ok(binaryPath);
  assert.ok(binarySha256);
  assert.ok(binaryProvenance);
  return { path: binaryPath, sha256: binarySha256, provenance: binaryProvenance };
}

function unauthenticatedNoop(socketPath: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const req = request({ socketPath, path: "/rc/noop", method: "POST", agent: false }, (res) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode ?? 0));
    res.on("error", reject);
  });
  // A real external worker requires a bounded network deadline, not fake time.
  req.setTimeout(2_000, () => req.destroy(new Error("Test probe timed out")));
  req.on("error", reject);
  req.end();
  return promise;
}

function fault(code: string, reason?: string) {
  return (error: unknown) => error instanceof ProviderFault && error.code === code &&
    (reason === undefined || error.evidence.reason === reason);
}

describe("real rclone transfer supervisor", { skip: !enabled }, () => {
  it("requires socket authentication, streams exact remote bytes, and refuses unowned shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "mm-rc-"));
    const source = join(root, "source");
    const configPath = join(root, "rclone.conf");
    await mkdir(source);
    const name = "bytes # % [snow 雪].bin";
    const bytes = Buffer.alloc(1024 * 1024, 0x8b);
    await writeFile(join(source, name), bytes);
    await writeFile(configPath, `[source]\ntype = alias\nremote = ${source}\n`, { mode: 0o600 });
    const supervisor = createTransferSupervisor({ configPath, jobDirectory: root, binary: suppliedBinary() });
    const observer = createTransferSupervisor({ configPath: null, jobDirectory: root, binary: suppliedBinary() });
    try {
      const proof = await supervisor.proveBinary();
      assert.equal(proof.version, "v1.75.0");
      assert.equal(proof.sha256, binarySha256);
      const worker = await supervisor.startTransferWorker({ runDirectory: join(root, "run") });
      assert.equal((await lstat(dirname(worker.socketPath))).mode & 0o777, 0o700);
      assert.equal(await unauthenticatedNoop(worker.socketPath), 401);
      assert.deepEqual(await supervisor.call(worker.socketPath, "rc/noop", { value: "authenticated" }), {
        value: "authenticated",
      });
      assert.equal(await supervisor.transferWorkerVersion({ socketPath: worker.socketPath }), "v1.75.0");
      const digest = createHash("sha256");
      for await (const chunk of supervisor.openRead(worker.socketPath, `source:${name}`)) digest.update(chunk);
      assert.equal(digest.digest("hex"), createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(await observer.probeTransferWorker({ socketPath: worker.socketPath }), {
        alive: true,
        version: null,
      });
      await assert.rejects(observer.terminateTransferWorker({ socketPath: worker.socketPath }),
        fault("recovery_required", "worker_ownership_unproven"));
      await assert.rejects(observer.stopTransferWorker({ socketPath: worker.socketPath }),
        fault("recovery_required", "worker_ownership_unproven"));
      assert.equal(await unauthenticatedNoop(worker.socketPath), 401);
      await assert.rejects(async () => {
        for await (const _chunk of supervisor.openRead(worker.socketPath, ":local:/etc/passwd")) {
          assert.fail("Inline backend must not be served");
        }
      }, fault("preflight_failed", "named_remote_required"));
      const secret = "SECRET_SENTINEL_DO_NOT_PUBLISH";
      await assert.rejects(supervisor.call(worker.socketPath, "rc/error", { secret }), (error: unknown) => {
        assert.ok(error instanceof ProviderFault);
        assert.equal(error.code, "provider_failed");
        assert.equal(JSON.stringify(error).includes(secret), false);
        assert.equal(error.message.includes(secret), false);
        assert.equal(JSON.stringify(error.evidence).includes(worker.socketPath), false);
        return true;
      });
      await supervisor.stopTransferWorker({ socketPath: worker.socketPath });
      assert.deepEqual(await observer.probeTransferWorker({ socketPath: worker.socketPath }), {
        alive: false,
        version: null,
      });
      await assert.rejects(lstat(dirname(worker.socketPath)), { code: "ENOENT" });
      assert.deepEqual(await readFile(join(source, name)), bytes);
    } finally {
      await observer.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts with hostile inherited settings and detects executable drift before reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "mm-rc-"));
    const executable = join(root, "rclone");
    const original = suppliedBinary();
    await copyFile(original.path, executable);
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: root,
      binary: { ...original, path: executable },
    });
    const overrides: Record<string, string> = {
      RCLONE_RC_ADDR: "127.0.0.1:1",
      RCLONE_RC_NO_AUTH: "true",
      RCLONE_RC_PASS: "INHERITED_SECRET_SENTINEL",
      RCLONE_CONFIG: "/nonexistent/config",
      HTTPS_PROXY: "http://invalid.invalid:1",
      http_proxy: "http://invalid.invalid:1",
      LISTEN_FDS: "1",
    };
    const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      await supervisor.proveBinary();
      Object.assign(process.env, overrides);
      const worker = await supervisor.startTransferWorker({ runDirectory: join(root, "run") });
      assert.equal(await unauthenticatedNoop(worker.socketPath), 401);
      await writeFile(join(root, "replacement"), Buffer.from("changed executable"));
      await rename(join(root, "replacement"), executable);
      await assert.rejects(supervisor.transferWorkerVersion({ socketPath: worker.socketPath }),
        fault("plan_revision_required", "binary_changed"));
      await supervisor.terminateTransferWorker({ socketPath: worker.socketPath });
      assert.deepEqual(await supervisor.probeTransferWorker({ socketPath: worker.socketPath }), {
        alive: false,
        version: null,
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
