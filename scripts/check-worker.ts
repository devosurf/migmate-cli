import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransferSupervisor } from "../src/engine/providers/transfer-worker.ts";
import { fileWorkerQualification } from "./qualification/file-worker.ts";
import { distributionPlatform } from "./platform.ts";

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let directory: string | undefined;
try {
  if (process.versions.node.split(".")[0] !== "24") throw new Error("Node 24 is required.");
  const platform = distributionPlatform();
  directory = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "mmw-"));
  await chmod(directory, 0o700);
  const supervisor = createTransferSupervisor({ configPath: null, jobDirectory: directory });
  const binary = await supervisor.proveBinary();
  await supervisor.close();
  const proof = await fileWorkerQualification({ jobDirectory: directory, configPath: null, binary, signal: controller.signal });
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, cell: platform.cell, ok: true, assertions: proof.assertions, observations: proof.observations, qualification: "not_claimed", scope: "managed_worker_transport_only" })}\n`);
} catch {
  process.stderr.write("Managed worker transport smoke did not satisfy the required native authentication, lifecycle, or binary gate. No route was qualified.\n");
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (directory) await rm(directory, { recursive: true, force: true });
}
