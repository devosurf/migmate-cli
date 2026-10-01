import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTransferSupervisor } from "../src/engine/providers/transfer-worker.ts";
import { unsupportedNode } from "../src/versions.ts";
import { fileWorkerLiveTest } from "./live/file-worker.ts";
import { distributionPlatform } from "./platform.ts";

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let directory: string | undefined;
try {
  const unsupported = unsupportedNode();
  if (unsupported !== null) throw new Error(unsupported);
  const platform = distributionPlatform();
  directory = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "mmw-"));
  await chmod(directory, 0o700);
  const supervisor = createTransferSupervisor({ configPath: null, jobDirectory: directory });
  const binary = await supervisor.proveBinary();
  await supervisor.close();
  const proof = await fileWorkerLiveTest({
    jobDirectory: directory,
    configPath: null,
    binary,
    signal: controller.signal,
  });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--test",
        fileURLToPath(new URL("../src/engine/providers/copy-pass.test.ts", import.meta.url)),
      ],
      {
        stdio: "inherit",
        signal: controller.signal,
        env: {
          ...process.env,
          MIGMATE_TEST_RCLONE_BINARY: binary.path,
          MIGMATE_TEST_RCLONE_SHA256: binary.sha256,
          MIGMATE_TEST_RCLONE_PROVENANCE: binary.provenance,
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Copy pass acceptance failed")),
    );
  });
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, cell: platform.cell, ok: true, assertions: [...proof.assertions, { id: "file_copy_pass_acceptance", expected: true, observed: true }], observations: proof.observations, scope: "managed_worker_transport_and_file_passes" })}\n`,
  );
} catch {
  process.stderr.write(
    "Managed worker transport or file-pass acceptance did not satisfy the required native authentication, lifecycle, binary, or copy-pass gate.\n",
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (directory) await rm(directory, { recursive: true, force: true });
}
