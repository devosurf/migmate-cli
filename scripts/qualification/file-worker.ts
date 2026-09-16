import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProviderFault } from "../../src/engine/providers/credentials.ts";
import {
  createTransferSupervisor,
  type BinaryProof,
} from "../../src/engine/providers/transfer-worker.ts";
import type { ProbeCapture } from "../../src/qualification/bundle.ts";
import { QualificationBlocked } from "./common.ts";

async function unauthenticatedStatus(socketPath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const call = request(
      {
        socketPath,
        method: "POST",
        path: "/rc/noop",
        headers: { "Content-Type": "application/json" },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        resolve(status);
      },
    );
    call.setTimeout(10_000, () =>
      call.destroy(new QualificationBlocked("file_worker_negative_auth_timeout")),
    );
    call.on("error", () =>
      reject(new QualificationBlocked("file_worker_negative_auth_unavailable")),
    );
    call.end("{}");
  });
}

export async function fileWorkerQualification(input: {
  jobDirectory: string;
  configPath: string | null;
  binary: BinaryProof;
  signal: AbortSignal;
}): Promise<{
  assertions: ProbeCapture["assertions"];
  observations: Record<string, unknown>;
  codes: string[];
}> {
  const assertions: ProbeCapture["assertions"] = [];
  function expect(id: string, expected: unknown, observed: unknown): void {
    if (JSON.stringify(expected) !== JSON.stringify(observed))
      throw new QualificationBlocked(`file_worker_${id}`);
    assertions.push({ id, expected, observed });
  }
  const supervisor = createTransferSupervisor({
    configPath: input.configPath,
    jobDirectory: input.jobDirectory,
    binary: input.binary,
  });
  let closeSucceeded = false;
  try {
    const proof = await supervisor.proveBinary();
    expect("exact_binary_version", "v1.75.0", proof.version);
    expect("binary_rehash", input.binary.sha256, proof.sha256);
    const handle = await supervisor.startTransferWorker({
      runDirectory: join(input.jobDirectory, "w"),
    });
    const privateDirectory = await lstat(dirname(handle.socketPath));
    expect(
      "private_socket_directory",
      true,
      privateDirectory.isDirectory() && !privateDirectory.isSymbolicLink(),
    );
    expect("private_socket_mode", 0o700, privateDirectory.mode & 0o777);
    expect("socket_owner", process.getuid?.(), privateDirectory.uid);
    expect("native_unix_socket", true, (await lstat(handle.socketPath)).isSocket());
    expect("missing_authentication_status", 401, await unauthenticatedStatus(handle.socketPath));
    const nonce = "live-qualification-owned-worker";
    const noop = await supervisor.call<{ nonce?: string }>(handle.socketPath, "rc/noop", { nonce });
    expect("authenticated_round_trip", nonce, noop.nonce);
    const identity = await supervisor.call<{ pid?: number }>(handle.socketPath, "core/pid");
    expect("owned_child_identity", true, identity.pid === handle.pid);
    expect(
      "authenticated_liveness",
      { alive: true, version: "v1.75.0" },
      await supervisor.probeTransferWorker(handle),
    );
    const asynchronous = await supervisor.call<{ jobid?: number }>(handle.socketPath, "rc/noop", {
      _async: true,
      nonce,
    });
    if (!Number.isSafeInteger(asynchronous.jobid))
      throw new QualificationBlocked("file_worker_async_job_id_unavailable");
    let status: { finished?: boolean; success?: boolean; output?: { nonce?: string } } = {};
    const deadline = Date.now() + 10_000;
    do {
      input.signal.throwIfAborted();
      status = await supervisor.call(handle.socketPath, "job/status", {
        jobid: asynchronous.jobid,
      });
      if (status.finished) break;
      await delay(25, undefined, { signal: input.signal });
    } while (Date.now() < deadline);
    expect("managed_job_finished", true, status.finished);
    expect("managed_job_succeeded", true, status.success);
    expect("managed_job_output", nonce, status.output?.nonce);
    const jobs = await supervisor.call<{ jobids?: number[] }>(handle.socketPath, "job/list");
    expect("managed_job_listed", true, jobs.jobids?.includes(asynchronous.jobid!) === true);
    await supervisor.stopTransferWorker(handle);
    expect(
      "cooperative_shutdown",
      { alive: false, version: null },
      await supervisor.probeTransferWorker(handle),
    );
    const forced = await supervisor.startTransferWorker({
      runDirectory: join(input.jobDirectory, "w"),
    });
    await supervisor.terminateTransferWorker(forced);
    expect(
      "forced_shutdown",
      { alive: false, version: null },
      await supervisor.probeTransferWorker(forced),
    );
    const closing = await supervisor.startTransferWorker({
      runDirectory: join(input.jobDirectory, "w"),
    });
    await supervisor.close();
    closeSucceeded = true;
    expect(
      "session_close_shutdown",
      { alive: false, version: null },
      await supervisor.probeTransferWorker(closing),
    );
    // Real digest refusal against the real executable; never fabricate a version response or mutate the binary.
    const alteredDigest = `${proof.sha256[0] === "0" ? "1" : "0"}${proof.sha256.slice(1)}`;
    const refused = createTransferSupervisor({
      configPath: null,
      jobDirectory: input.jobDirectory,
      binary: { ...proof, sha256: alteredDigest },
    });
    let observedCode: string | null = null;
    try {
      await refused.proveBinary();
    } catch (error) {
      if (error instanceof ProviderFault) observedCode = error.code;
      else throw error;
    } finally {
      await refused.close();
    }
    expect("changed_binary_refused", "preflight_failed", observedCode);
    return {
      assertions,
      codes: [observedCode!],
      observations: {
        transferVersion: proof.version,
        binarySha256: proof.sha256,
        versionCommand: "rc --loopback core/version",
        transport: "unix_socket",
        processOwned: true,
        unauthenticatedStatus: 401,
        authenticatedNoop: noop.nonce === nonce,
        asynchronousJobFinished: status.finished,
        asynchronousJobSucceeded: status.success,
        cooperativeShutdown: true,
        forcedShutdown: true,
        sessionCloseShutdown: true,
      },
    };
  } finally {
    if (!closeSucceeded) await supervisor.close();
  }
}
