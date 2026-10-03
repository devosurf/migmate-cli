import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TESTED_TRANSFER_VERSIONS, TRANSFER_VERSION } from "../../versions.ts";
import { ProviderFault } from "./credentials.ts";
import type {
  CopyPassHandle,
  CopyPassReference,
  FilePassProvider,
  FilePassPreview,
  ProviderPort,
  TransferWorkerHandle,
  TransferWorkerProbe,
} from "./port.ts";
import { withSocketPath } from "./socket-path.ts";

const VERSION_FLOOR = [1, 69, 0] as const;
const READY_TIMEOUT = 15_000;
const REQUEST_TIMEOUT = 30_000;
const STOP_TIMEOUT = 3_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const REMOTE_NAME = /^[\p{L}\p{N}_.+@]+(?:[ -]+[\p{L}\p{N}_.+@-]+)*$/u;
const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface BinaryProof {
  version: string;
  sha256: string;
  path: string;
  provenance: string;
  versionJson: Record<string, unknown>;
}

export interface TransferSupervisor extends FilePassProvider {
  proveBinary(): Promise<BinaryProof>;
  startTransferWorker: ProviderPort["startTransferWorker"];
  probeTransferWorker: ProviderPort["probeTransferWorker"];
  stopTransferWorker: ProviderPort["stopTransferWorker"];
  terminateTransferWorker: ProviderPort["terminateTransferWorker"];
  transferWorkerVersion: ProviderPort["transferWorkerVersion"];
  call<T>(socketPath: string, method: string, input?: Record<string, unknown>): Promise<T>;
  openRead(socketPath: string, remotePath: string): AsyncIterable<Uint8Array>;
  openSource(
    socketPath: string,
    input: { remote: string; driveId: string; path: string },
  ): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

interface BinarySpec {
  path: string;
  sha256: string;
  provenance: string;
}

interface OwnedChild {
  process: ChildProcess;
  exited: Promise<void>;
  alive: boolean;
}

interface Worker {
  child: OwnedChild;
  directory: string;
  directoryIdentity: Stats;
  socketPath: string;
  socketIdentity: Stats | null;
  user: string;
  password: string;
  group: string;
  passes: Map<number, CopyPassHandle>;
  proof: BinaryProof;
  stopping: Promise<void> | null;
}

function fail(code: string, reason: string, evidence: Record<string, unknown> = {}): ProviderFault {
  return new ProviderFault(
    code,
    "The managed transfer worker could not satisfy its safety contract.",
    {
      check: "transfer_worker",
      reason,
      ...evidence,
    },
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function systemEnvironment(): NodeJS.ProcessEnv {
  // An allowlist also excludes RCLONE_*, all proxy variants, activation FDs,
  // loader injection, cloud credentials and inherited debug/log destinations.
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

function spawnOwned(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
  capture = false,
): OwnedChild {
  const deferred = Promise.withResolvers<void>();
  let child: ChildProcess;
  try {
    child = spawn(binary, args, {
      env,
      ...(cwd === undefined ? {} : { cwd }),
      shell: false,
      stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
    });
  } catch {
    throw fail("preflight_failed", "worker_spawn_failed");
  }
  const owned = { process: child, exited: deferred.promise, alive: true };
  child.on("error", () => {
    // A failed kill can also emit error. Only a failed spawn proves absence.
    if (child.pid === undefined) {
      owned.alive = false;
      deferred.resolve();
    }
  });
  child.once("exit", () => {
    owned.alive = false;
    deferred.resolve();
  });
  return owned;
}

async function awaitExit(child: OwnedChild, timeout: number): Promise<boolean> {
  if (!child.alive) return true;
  const controller = new AbortController();
  try {
    return await Promise.race([
      child.exited.then(() => true),
      delay(timeout, false, { signal: controller.signal }),
    ]);
  } finally {
    controller.abort();
  }
}

async function terminate(child: OwnedChild): Promise<void> {
  // ChildProcess owns the unreaped child identity. Never signal a persisted PID,
  // a PID obtained from the socket, or a process group inferred from either.
  if (!child.alive) return;
  try {
    child.process.kill("SIGTERM");
  } catch {
    /* Escalate only this owned child. */
  }
  if (await awaitExit(child, STOP_TIMEOUT)) return;
  try {
    child.process.kill("SIGKILL");
  } catch {
    /* The exit predicate remains authoritative. */
  }
  if (!(await awaitExit(child, STOP_TIMEOUT)))
    throw fail("recovery_required", "worker_shutdown_timeout");
}

async function capture(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = REQUEST_TIMEOUT,
): Promise<{ value: unknown; success: boolean }> {
  const child = spawnOwned(binary, args, env, undefined, true);
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  child.process.stdout?.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      overflow = true;
      child.process.stdout?.destroy();
    } else chunks.push(chunk);
  });
  child.process.stdout?.on("error", () => {
    overflow = true;
  });
  const finished = await awaitExit(child, timeout);
  if (!finished || overflow) {
    await terminate(child);
    throw fail(
      "provider_failed",
      finished ? "worker_response_too_large" : "worker_request_timeout",
    );
  }
  // Pipes can finish after exit; a inherited pipe must not defeat the deadline.
  if (
    child.process.stdout !== null &&
    !child.process.stdout.readableEnded &&
    !child.process.stdout.destroyed
  ) {
    const drained = Promise.withResolvers<void>();
    const timer = setTimeout(() => child.process.stdout?.destroy(), STOP_TIMEOUT);
    child.process.stdout.once("end", drained.resolve);
    child.process.stdout.once("close", drained.resolve);
    try {
      await drained.promise;
    } finally {
      clearTimeout(timer);
    }
  }
  if (overflow) throw fail("provider_failed", "worker_response_too_large");
  try {
    return {
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      success: child.process.exitCode === 0,
    };
  } catch {
    throw fail("provider_failed", "worker_response_invalid");
  }
}

async function digest(path: string): Promise<string> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    throw fail("preflight_failed", "binary_unreadable");
  }
}

function version(value: unknown): string {
  if (!record(value) || typeof value.version !== "string")
    throw fail("preflight_failed", "version_proof_invalid");
  const parsed = /^v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.version);
  if (parsed !== null) {
    const parts = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
    for (let i = 0; i < VERSION_FLOOR.length; i += 1) {
      if (parts[i]! < VERSION_FLOOR[i]!) throw fail("preflight_failed", "version_below_floor");
      if (parts[i]! > VERSION_FLOOR[i]!) break;
    }
  }
  if (
    TESTED_TRANSFER_VERSIONS[value.version] !== true ||
    value.isGit !== false ||
    value.isBeta !== false
  ) {
    throw fail("preflight_failed", "version_untested");
  }
  return value.version;
}

async function privateDirectory(path: string): Promise<void> {
  await chmod(path, 0o700);
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  ) {
    throw fail("preflight_failed", "run_directory_permissions");
  }
}

function response(
  socketPath: string,
  path: string,
  method: string,
  body: string | undefined,
  authorization: string | undefined,
  timeout: number,
): Promise<IncomingMessage> {
  return withSocketPath(socketPath, (connectPath) => {
    const deferred = Promise.withResolvers<IncomingMessage>();
    try {
      const req = request(
        {
          socketPath: connectPath,
          path,
          method,
          agent: false,
          headers: {
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
            ...(authorization === undefined ? {} : { Authorization: authorization }),
          },
        },
        (res) => {
          clearTimeout(timer);
          deferred.resolve(res);
        },
      );
      // A hard header deadline covers connect hangs as well as idle sockets.
      const timer = setTimeout(() => req.destroy(), timeout);
      req.once("error", (error) => {
        clearTimeout(timer);
        const denied = record(error) && (error.code === "EACCES" || error.code === "EPERM");
        deferred.reject(
          fail(
            denied ? "recovery_required" : "provider_failed",
            denied ? "worker_probe_failed" : "worker_unreachable",
          ),
        );
      });
      req.end(body);
    } catch {
      deferred.reject(fail("provider_failed", "worker_request_invalid"));
    }
    return deferred.promise;
  });
}

async function readJson(res: IncomingMessage, timeout: number): Promise<unknown> {
  const timer = setTimeout(() => res.destroy(), timeout);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_JSON_BYTES) throw fail("provider_failed", "worker_response_too_large");
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ProviderFault) throw error;
    throw fail("provider_failed", "worker_response_invalid");
  } finally {
    clearTimeout(timer);
    res.destroy();
  }
}

function basic(worker: Worker): string {
  return `Basic ${Buffer.from(`${worker.user}:${worker.password}`).toString("base64")}`;
}

function objectPath(path: string): string {
  if (
    path.length === 0 ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f\\]/u.test(path)
  )
    throw fail("preflight_failed", "remote_object_path_invalid");
  try {
    return path.split("/").map(encodeURIComponent).join("/");
  } catch {
    throw fail("preflight_failed", "remote_object_path_invalid");
  }
}

function remoteName(name: string): void {
  if (!REMOTE_NAME.test(name)) throw fail("preflight_failed", "named_remote_required");
}

function quoteOption(value: string): string {
  // The serve route's bracket parser runs after URL decoding, so bracket values
  // cannot be made safe merely by percent encoding. Graph IDs do not require them.
  if (!value || /[\[\]\u0000-\u001f\u007f/\\]/u.test(value))
    throw fail("preflight_failed", "source_identity_invalid");
  return `'${value.replaceAll("'", "''")}'`;
}

function literalFilterPath(path: string): string {
  // Whitespace must survive rclone's rule trimming and splitting.
  return path
    .replace(/[\\*?[\]{}]/g, "\\$&")
    .replace(/\s/g, (character) => `{{\\x{${character.codePointAt(0)!.toString(16)}}}}`);
}

function passFilter(excludePaths?: string[]): Record<string, unknown> {
  return excludePaths?.length
    ? {
        _filter: {
          ExcludeRule: excludePaths.flatMap((path) => {
            const literal = literalFilterPath(path);
            return [`/${literal}`, `/${literal}/**`];
          }),
        },
      }
    : {};
}

function modTimeNs(value: unknown): bigint {
  if (typeof value !== "string") throw fail("provider_failed", "worker_response_invalid");
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) throw fail("provider_failed", "worker_response_invalid");
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(seconds)) throw fail("provider_failed", "worker_response_invalid");
  return BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

function durationNs(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw fail("provider_failed", "worker_response_invalid");
  return BigInt(value);
}

interface PreviewFile {
  path: string;
  size: number;
  modified: bigint;
}

export function createTransferSupervisor(options: {
  configPath: string | null;
  jobDirectory: string;
  binary?: BinarySpec;
  jobExpiry?: string;
}): TransferSupervisor {
  const workers = new Map<string, Worker>();
  const starting = new Set<Promise<TransferWorkerHandle>>();
  let proof: BinaryProof | null = null;
  let proving: Promise<BinaryProof> | null = null;
  let closed = false;

  async function resolveBinary(): Promise<BinarySpec> {
    try {
      let candidate: unknown = options.binary;
      let root: string | null = null;
      if (candidate === undefined) {
        root = await realpath(PACKAGE_ROOT);
        const manifest: unknown = JSON.parse(
          await readFile(join(root, "vendor", "rclone", "manifest.json"), "utf8"),
        );
        if (
          !record(manifest) ||
          manifest.schemaVersion !== 1 ||
          manifest.version !== TRANSFER_VERSION ||
          !record(manifest.binaries)
        ) {
          throw fail("preflight_failed", "binary_manifest_invalid");
        }
        candidate = manifest.binaries[`${process.platform}-${process.arch}`];
      }
      if (
        !record(candidate) ||
        typeof candidate.path !== "string" ||
        typeof candidate.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(candidate.sha256) ||
        typeof candidate.provenance !== "string" ||
        !/^[\x20-\x7e]{1,512}$/.test(candidate.provenance)
      )
        throw fail("preflight_failed", "binary_provenance_required");
      if (root !== null && isAbsolute(candidate.path))
        throw fail("preflight_failed", "binary_manifest_invalid");
      if (root === null && !isAbsolute(candidate.path))
        throw fail("preflight_failed", "binary_path_must_be_absolute");
      const path = await realpath(root === null ? candidate.path : resolve(root, candidate.path));
      if (root !== null && !inside(root, path))
        throw fail("preflight_failed", "binary_manifest_escape");
      if (!(await lstat(path)).isFile()) throw fail("preflight_failed", "binary_unreadable");
      return { path, sha256: candidate.sha256, provenance: candidate.provenance };
    } catch (error) {
      if (error instanceof ProviderFault) throw error;
      throw fail("preflight_failed", "binary_unavailable");
    }
  }

  async function rehash(expected: BinaryProof): Promise<void> {
    try {
      if ((await digest(expected.path)) !== expected.sha256)
        throw fail("plan_revision_required", "binary_changed");
    } catch {
      throw fail("plan_revision_required", "binary_changed");
    }
  }

  async function establishProof(): Promise<BinaryProof> {
    if (proof !== null) {
      await rehash(proof);
      return structuredClone(proof);
    }
    const binary = await resolveBinary();
    if ((await digest(binary.path)) !== binary.sha256)
      throw fail("preflight_failed", "binary_checksum_mismatch");
    // v1.75.0 has no `version --json`. This runs that exact executable's
    // core/version locally, with no listener; live RC proof is separate below.
    const own = await capture(
      binary.path,
      ["rc", "--loopback", "core/version", "--config", "/dev/null"],
      systemEnvironment(),
    );
    if (!own.success || !record(own.value)) throw fail("preflight_failed", "version_proof_invalid");
    const checked = version(own.value);
    const established = { ...binary, version: checked, versionJson: own.value };
    await rehash(established);
    proof = established;
    return structuredClone(established);
  }

  async function proveBinary(): Promise<BinaryProof> {
    if (proving !== null) return structuredClone(await proving);
    proving = establishProof();
    try {
      return await proving;
    } finally {
      proving = null;
    }
  }

  async function socketWithinJob(socketPath: string): Promise<void> {
    if (!isAbsolute(socketPath)) throw fail("preflight_failed", "worker_socket_invalid");
    const root = await realpath(options.jobDirectory);
    const parent = await realpath(dirname(socketPath));
    if (!inside(root, parent)) throw fail("recovery_required", "worker_ownership_unproven");
  }

  function owned(socketPath: string): Worker {
    const worker = workers.get(socketPath);
    if (worker === undefined) throw fail("recovery_required", "worker_ownership_unproven");
    return worker;
  }

  async function verifySocket(worker: Worker): Promise<void> {
    try {
      const directory = await lstat(worker.directory);
      if (!sameFile(directory, worker.directoryIdentity) || directory.isSymbolicLink())
        throw new Error();
      const socket = await lstat(worker.socketPath);
      if (
        socket.isSymbolicLink() ||
        !socket.isSocket() ||
        (worker.socketIdentity !== null && !sameFile(socket, worker.socketIdentity))
      )
        throw new Error();
      worker.socketIdentity ??= socket;
    } catch {
      throw fail("recovery_required", "worker_ownership_unproven");
    }
  }

  async function rc(
    socketPath: string,
    method: string,
    input: Record<string, unknown>,
    worker: Worker | undefined,
    timeout = REQUEST_TIMEOUT,
  ): Promise<{ status: number; value: unknown }> {
    let body: string;
    try {
      body = JSON.stringify(input);
    } catch {
      throw fail("provider_failed", "worker_request_invalid");
    }
    const res = await response(
      socketPath,
      `/${method}`,
      "POST",
      body,
      worker === undefined ? undefined : basic(worker),
      timeout,
    );
    const status = res.statusCode ?? 0;
    if (status !== 200 || worker === undefined) {
      res.destroy();
      return { status, value: null };
    }
    return { status, value: await readJson(res, timeout) };
  }

  async function authenticated(
    worker: Worker,
    method: string,
    input: Record<string, unknown> = {},
    timeout = REQUEST_TIMEOUT,
  ): Promise<unknown> {
    if (!worker.child.alive) throw fail("provider_failed", "worker_exited");
    await verifySocket(worker);
    const result = await rc(worker.socketPath, method, input, worker, timeout);
    if (result.status !== 200)
      throw fail("provider_failed", "worker_request_failed", { status: result.status });
    return result.value;
  }

  function passWorker({ socketPath, pass }: CopyPassReference): Worker {
    const worker = owned(socketPath);
    const expected = worker.passes.get(pass.jobid);
    if (!expected || expected.executeId !== pass.executeId || expected.group !== pass.group)
      throw fail("provider_failed", "copy_pass_handle_mismatch");
    return worker;
  }

  async function liveVersion(worker: Worker): Promise<string> {
    await rehash(worker.proof);
    const current = await authenticated(worker, "core/version");
    if (
      !record(current) ||
      current.version !== worker.proof.version ||
      current.isGit !== false ||
      current.isBeta !== false
    ) {
      throw fail("plan_revision_required", "worker_version_changed");
    }
    await rehash(worker.proof);
    return worker.proof.version;
  }

  async function cleanup(worker: Worker): Promise<void> {
    if (worker.child.alive) throw fail("recovery_required", "worker_shutdown_timeout");
    try {
      const info = await lstat(worker.directory);
      if (!sameFile(info, worker.directoryIdentity) || info.isSymbolicLink())
        throw fail("recovery_required", "worker_ownership_unproven");
      await rm(worker.directory, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof ProviderFault) throw error;
      throw fail("recovery_required", "worker_cleanup_failed");
    }
    workers.delete(worker.socketPath);
    worker.user = "";
    worker.password = "";
  }

  async function shutdown(worker: Worker, cooperative: boolean): Promise<void> {
    if (worker.stopping !== null) return worker.stopping;
    worker.stopping = (async () => {
      if (cooperative && worker.child.alive) {
        try {
          await Promise.all(
            [worker.group, ...[...worker.passes.values()].map((pass) => pass.group)].map((group) =>
              authenticated(worker, "job/stopgroup", { group }, STOP_TIMEOUT),
            ),
          );
        } catch {
          /* The directly owned child remains eligible for bounded termination. */
        }
        try {
          await authenticated(worker, "core/quit", {}, STOP_TIMEOUT);
        } catch {
          /* core/quit may close its connection before replying. */
        }
        await awaitExit(worker.child, STOP_TIMEOUT);
      }
      await terminate(worker.child);
      await cleanup(worker);
    })();
    try {
      await worker.stopping;
    } catch (error) {
      worker.stopping = null;
      throw error;
    }
  }

  async function start(
    input: Parameters<ProviderPort["startTransferWorker"]>[0],
  ): Promise<TransferWorkerHandle> {
    if (closed) throw fail("provider_failed", "supervisor_closed");
    const executable = await proveBinary();
    let directory: string | null = null;
    let directoryIdentity: Stats | null = null;
    let worker: Worker | null = null;
    try {
      const root = await realpath(options.jobDirectory);
      const configuredRoot = resolve(options.jobDirectory);
      const requested = resolve(configuredRoot, input.runDirectory);
      const relativeRoot = inside(configuredRoot, requested) ? configuredRoot : root;
      if (!inside(relativeRoot, requested))
        throw fail("preflight_failed", "run_directory_outside_job");
      // Resolve the job's external spelling (e.g. macOS /tmp) once, then reject
      // every symlink below it before creating the private worker directory.
      const relativeParts = relative(relativeRoot, requested).split(sep).filter(Boolean);
      let parent = root;
      for (const part of relativeParts) {
        const next = join(parent, part);
        try {
          await mkdir(next, { mode: 0o700 });
        } catch (error) {
          if (!record(error) || error.code !== "EEXIST") throw error;
        }
        const info = await lstat(next);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw fail("preflight_failed", "run_directory_invalid");
        parent = next;
      }
      directory = await mkdtemp(join(parent, "rc-"));
      directoryIdentity = await lstat(directory);
      await privateDirectory(directory);
      const socketPath = join(directory, "s");
      const user = randomBytes(18).toString("hex");
      const password = randomBytes(32).toString("base64url");
      const configPath = options.configPath === null ? "/dev/null" : options.configPath;
      if (!isAbsolute(configPath)) throw fail("preflight_failed", "worker_config_path_invalid");
      await rehash(executable);
      const group = `migmate-${randomBytes(16).toString("hex")}`;
      input.onPrepare?.({ socketPath, group, executablePath: executable.path });
      const child = spawnOwned(
        executable.path,
        [
          "rcd",
          "--rc-addr",
          "unix://s",
          "--rc-serve",
          "--config",
          configPath,
          "--cache-dir",
          directory,
          "--temp-dir",
          directory,
          "--drive-skip-gdocs=true",
          "--drive-skip-shortcuts=true",
          "--drive-import-formats=",
          "--drive-metadata-owner=off",
          "--drive-metadata-permissions=off",
          "--drive-metadata-labels=off",
          "--metadata=false",
          // Passes enable metadata for files only. rclone v1.75.0's Drive backend
          // applies a folder's `content-type` (OneDrive reports `inode/directory`)
          // when creating it, which makes a 0-byte file instead of a folder and fails
          // the pass. Worker-wide, unlike a per-call `_config`, this also binds remotes
          // rclone has already cached. Folders still receive modification times.
          "--disable=WriteDirMetadata",
          "--onedrive-disable-site-permission=true",
          "--onedrive-expose-onenote-files=true",
          "--retries=1",
          "--low-level-retries=1",
          "--rc-job-expire-duration",
          options.jobExpiry ?? "24h",
          "--rc-server-read-timeout",
          "1h",
          "--rc-server-write-timeout",
          "1h",
        ],
        {
          ...systemEnvironment(),
          TMPDIR: directory,
          TEMP: directory,
          TMP: directory,
          RCLONE_RC_USER: user,
          RCLONE_RC_PASS: password,
        },
        directory,
      );
      worker = {
        child,
        directory,
        directoryIdentity,
        socketPath,
        socketIdentity: null,
        user,
        password,
        group,
        passes: new Map(),
        proof: executable,
        stopping: null,
      };
      workers.set(socketPath, worker);
      if (child.process.pid === undefined) throw fail("preflight_failed", "worker_spawn_failed");
      input.onSpawn?.({
        socketPath,
        pid: child.process.pid,
        version: executable.version,
        group,
        executablePath: executable.path,
      });
      const deadline = Date.now() + READY_TIMEOUT;
      let ready = false;
      while (Date.now() < deadline && child.alive) {
        try {
          const probe = await rc(
            socketPath,
            "rc/noop",
            {},
            undefined,
            Math.min(1_000, deadline - Date.now()),
          );
          if (probe.status !== 401) throw fail("preflight_failed", "worker_auth_not_enforced");
          await authenticated(
            worker,
            "rc/noop",
            {},
            Math.min(1_000, Math.max(1, deadline - Date.now())),
          );
          const identity = await authenticated(worker, "core/pid", {}, 1_000);
          if (!record(identity) || identity.pid !== child.process.pid)
            throw fail("recovery_required", "worker_ownership_unproven");
          ready = true;
          break;
        } catch (error) {
          if (error instanceof ProviderFault && error.code !== "provider_failed") throw error;
          await delay(Math.min(50, Math.max(1, deadline - Date.now())));
        }
      }
      if (!ready) throw fail("preflight_failed", "worker_readiness_failed");
      await liveVersion(worker);
      if (closed) throw fail("provider_failed", "supervisor_closed");
      if (child.process.pid === undefined) throw fail("preflight_failed", "worker_spawn_failed");
      return {
        socketPath,
        pid: child.process.pid,
        version: executable.version,
        group: worker.group,
      };
    } catch (error) {
      if (worker !== null) await shutdown(worker, false);
      else if (directory !== null && directoryIdentity !== null) {
        const current = await lstat(directory).catch(() => null);
        if (current !== null && sameFile(current, directoryIdentity) && !current.isSymbolicLink()) {
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      if (error instanceof ProviderFault) throw error;
      throw fail("preflight_failed", "worker_start_failed");
    }
  }

  async function probeTransferWorker(input: { socketPath: string }): Promise<TransferWorkerProbe> {
    try {
      await socketWithinJob(input.socketPath);
      await rc(input.socketPath, "rc/noop", {}, undefined, 1_000);
    } catch (error) {
      if (error instanceof ProviderFault) {
        if (error.code !== "provider_failed") throw error;
      } else if (!record(error) || error.code !== "ENOENT") {
        throw fail("recovery_required", "worker_probe_failed");
      }
      return { alive: false, version: null };
    }
    // Once the socket answers, failed authentication/version requests can never
    // turn it into a dead-worker observation and accidentally permit reclaim.
    const worker = workers.get(input.socketPath);
    if (worker === undefined || !worker.child.alive) return { alive: true, version: null };
    try {
      return { alive: true, version: await liveVersion(worker) };
    } catch (error) {
      if (error instanceof ProviderFault && error.code === "provider_failed")
        return { alive: true, version: null };
      throw error;
    }
  }

  async function* stream(worker: Worker, fs: string, path: string): AsyncIterable<Uint8Array> {
    const encodedPath = objectPath(path);
    if (!worker.child.alive) throw fail("provider_failed", "worker_exited");
    if (worker.stopping !== null) throw fail("provider_failed", "worker_stopping");
    await verifySocket(worker);
    const res = await response(
      worker.socketPath,
      `/${encodeURIComponent(`[${fs}]`)}/${encodedPath}`,
      "GET",
      undefined,
      basic(worker),
      REQUEST_TIMEOUT,
    );
    if (res.statusCode !== 200) {
      const status = res.statusCode ?? 0;
      res.destroy();
      // The remote and object are what makes a 404 actionable; neither is a
      // credential, and per-item paths already appear in reports.
      throw fail("provider_failed", "worker_read_failed", {
        status,
        remote: fs.split(",")[0],
        path,
      });
    }
    const timer = setTimeout(() => res.destroy(), 60 * 60 * 1_000);
    res.setTimeout(REQUEST_TIMEOUT, () => res.destroy());
    try {
      for await (const chunk of res) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    } catch {
      throw fail("provider_failed", "worker_read_failed");
    } finally {
      clearTimeout(timer);
      res.destroy();
    }
  }

  return {
    proveBinary,
    async previewCopyPass(input) {
      const worker = owned(input.socketPath);
      const [sourceInfo, destinationInfo, options] = await Promise.all([
        authenticated(worker, "operations/fsinfo", { fs: input.source.fs }),
        input.destination
          ? authenticated(worker, "operations/fsinfo", { fs: input.destination.fs })
          : Promise.resolve({ Precision: 0, Hashes: [] }),
        authenticated(worker, "options/get", {}),
      ]);
      if (
        !record(sourceInfo) ||
        !record(destinationInfo) ||
        !record(options) ||
        !record(options.main)
      )
        throw fail("provider_failed", "worker_response_invalid");
      const main = options.main;
      if (
        !Array.isArray(sourceInfo.Hashes) ||
        !sourceInfo.Hashes.every((hash) => typeof hash === "string") ||
        !Array.isArray(destinationInfo.Hashes) ||
        !destinationInfo.Hashes.every((hash) => typeof hash === "string")
      )
        throw fail("provider_failed", "worker_response_invalid");
      // fsinfo emits hashes in rclone's priority order (the first overlap is GetOne).
      const destinationHashTypes = destinationInfo.Hashes;
      const commonHash: string | undefined = sourceInfo.Hashes.find((hash: string) =>
        destinationHashTypes.includes(hash),
      );
      const window = [
        durationNs(sourceInfo.Precision),
        durationNs(destinationInfo.Precision),
        durationNs(main.ModifyWindow),
      ].reduce((largest, value) => (value > largest ? value : largest));
      const list = async (fs: string): Promise<PreviewFile[]> => {
        const result = await authenticated(worker, "operations/list", {
          fs,
          remote: "",
          opt: { recurse: true, filesOnly: true, noMimeType: true },
          ...passFilter(input.excludePaths),
        });
        if (!record(result) || !Array.isArray(result.list))
          throw fail("provider_failed", "worker_response_invalid");
        return result.list.map((file: unknown) => {
          if (!record(file) || typeof file.Path !== "string" || typeof file.Size !== "number")
            throw fail("provider_failed", "worker_response_invalid");
          return { path: file.Path, size: file.Size, modified: modTimeNs(file.ModTime) };
        });
      };
      const [source, destination] = await Promise.all([
        list(input.source.fs),
        input.destination ? list(input.destination.fs) : Promise.resolve([]),
      ]);
      const key = (path: string) => {
        const normalized = main.NoUnicodeNormalization === true ? path : path.normalize("NFC");
        return main.IgnoreCaseSync === true ? normalized.toLowerCase() : normalized;
      };
      const remaining = new Map(destination.map((file) => [key(file.path), file]));
      const preview: FilePassPreview = {
        new: [],
        changed: [],
        unchanged: [],
        deleted: [],
        retained: [],
        timestampOnly: [],
        modifyWindowNs: window.toString(),
      };
      const hashCandidates: { source: PreviewFile; destination: PreviewFile }[] = [];
      for (const file of source) {
        const entry = { path: file.path, size: file.size };
        const previous = remaining.get(key(file.path));
        remaining.delete(key(file.path));
        if (!previous) {
          preview.new.push(entry);
          continue;
        }
        const difference = file.modified - previous.modified;
        const sizeDiffers =
          input.destination?.kind !== "sharepoint" &&
          file.size >= 0 &&
          previous.size >= 0 &&
          file.size !== previous.size;
        if (sizeDiffers) preview.changed.push(entry);
        else if (difference < window && difference > -window) preview.unchanged.push(entry);
        else if (commonHash) hashCandidates.push({ source: file, destination: previous });
        else preview.changed.push(entry);
      }
      if (commonHash && input.destination && hashCandidates.length > 0) {
        const hashes = async (fs: string, paths: string[]) => {
          const result = await authenticated(worker, "operations/list", {
            fs,
            remote: "",
            opt: {
              recurse: true,
              filesOnly: true,
              noModTime: true,
              noMimeType: true,
              showHash: true,
              hashTypes: [commonHash],
            },
            _filter: { IncludeRule: paths.map((path) => `/${literalFilterPath(path)}`) },
          });
          if (!record(result) || !Array.isArray(result.list))
            throw fail("provider_failed", "worker_response_invalid");
          const byPath = new Map<string, string>();
          for (const file of result.list) {
            if (!record(file) || typeof file.Path !== "string" || !record(file.Hashes))
              throw fail("provider_failed", "worker_response_invalid");
            const hash = file.Hashes[commonHash];
            if (typeof hash === "string" && hash !== "") byPath.set(file.Path, hash);
          }
          return byPath;
        };
        const [sourceHashes, destinationHashes] = await Promise.all([
          hashes(
            input.source.fs,
            hashCandidates.map((pair) => pair.source.path),
          ),
          hashes(
            input.destination.fs,
            hashCandidates.map((pair) => pair.destination.path),
          ),
        ]);
        for (const pair of hashCandidates) {
          const hash = sourceHashes.get(pair.source.path);
          // IgnoreChecksum controls post-copy validation, not rclone's Equal hash
          // branch. SharePoint still uses that branch if a common hash exists.
          const timestampOnly =
            hash !== undefined && hash === destinationHashes.get(pair.destination.path);
          preview[timestampOnly ? "timestampOnly" : "changed"].push({
            path: pair.source.path,
            size: pair.source.size,
          });
        }
      }
      for (const file of remaining.values()) {
        preview[input.mode === "mirror" ? "deleted" : "retained"].push({
          path: file.path,
          size: file.size,
        });
      }
      for (const entries of [
        preview.new,
        preview.changed,
        preview.unchanged,
        preview.deleted,
        preview.retained,
        preview.timestampOnly,
      ])
        entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return preview;
    },
    async listFolders({ socketPath, root }) {
      const listing = await authenticated(owned(socketPath), "operations/list", {
        fs: root.fs,
        remote: "",
        opt: { recurse: true, dirsOnly: true, noModTime: true, noMimeType: true },
      });
      if (!record(listing) || !Array.isArray(listing.list))
        throw fail("provider_failed", "worker_response_invalid");
      return listing.list
        .map((folder: unknown) => {
          if (!record(folder) || typeof folder.Path !== "string" || folder.IsDir !== true)
            throw fail("provider_failed", "worker_response_invalid");
          return folder.Path;
        })
        .filter((path: string) => path !== "" && path !== ".")
        .sort();
    },
    async listFileHashes({ socketPath, root, hashType, download, paths }) {
      const worker = owned(socketPath);
      if (paths?.length === 0) return [];
      const filter =
        paths === undefined
          ? {}
          : { _filter: { IncludeRule: paths.map((path) => `/${literalFilterPath(path)}`) } };
      const listing = await authenticated(worker, "operations/list", {
        fs: root.fs,
        remote: "",
        opt: { recurse: true, filesOnly: true, noModTime: true, noMimeType: true },
        ...filter,
      });
      const hashes = await authenticated(
        worker,
        "operations/hashsum",
        {
          fs: root.fs,
          hashType,
          download,
          base64: false,
          ...filter,
        },
        60 * 60 * 1_000,
      );
      if (
        !record(listing) ||
        !Array.isArray(listing.list) ||
        !record(hashes) ||
        !Array.isArray(hashes.hashsum)
      )
        throw fail("provider_failed", "worker_response_invalid");
      const byPath = new Map<string, string | null>();
      for (const line of hashes.hashsum) {
        if (typeof line !== "string") throw fail("provider_failed", "worker_response_invalid");
        const match = /^ *(\S*) {2}([\s\S]*)$/.exec(line);
        if (!match) throw fail("provider_failed", "worker_response_invalid");
        byPath.set(match[2]!, /^[a-fA-F0-9]+$/.test(match[1]!) ? match[1]!.toLowerCase() : null);
      }
      return listing.list.map((file: unknown) => {
        if (!record(file) || typeof file.Path !== "string" || typeof file.Size !== "number")
          throw fail("provider_failed", "worker_response_invalid");
        return {
          path: file.Path,
          size: file.Size,
          hash: byPath.get(file.Path) ?? null,
          ...(typeof file.ID === "string" && file.ID.length > 0 ? { id: file.ID } : {}),
        };
      });
    },
    async startCopyPass(input) {
      if (
        input.mode === "mirror" &&
        (!Number.isSafeInteger(input.deleteLimit) || input.deleteLimit < 0)
      )
        throw fail("provider_failed", "copy_pass_delete_limit_invalid");
      const worker = owned(input.socketPath);
      const group = `${worker.group}-${randomBytes(16).toString("hex")}`;
      const result = await authenticated(
        worker,
        input.mode === "mirror" ? "sync/sync" : "sync/copy",
        {
          srcFs: input.source.fs,
          dstFs: input.destination.fs,
          createEmptySrcDirs: true,
          _async: true,
          _group: group,
          ...passFilter(input.excludePaths),
          _config: {
            Transfers: input.transfers,
            Metadata: true,
            ...(input.mode === "mirror" ? { MaxDelete: input.deleteLimit } : {}),
            ...(input.destination.kind === "sharepoint"
              ? { IgnoreSize: true, IgnoreChecksum: true }
              : {}),
          },
        },
      );
      if (
        !record(result) ||
        typeof result.executeId !== "string" ||
        typeof result.jobid !== "number"
      )
        throw fail("provider_failed", "worker_response_invalid");
      const pass = { executeId: result.executeId, jobid: result.jobid, group };
      worker.passes.set(pass.jobid, pass);
      return { ...pass };
    },
    async copyPassStatus({ socketPath, pass }) {
      const result = await authenticated(passWorker({ socketPath, pass }), "job/status", {
        jobid: pass.jobid,
      });
      if (
        !record(result) ||
        typeof result.finished !== "boolean" ||
        typeof result.error !== "string"
      )
        throw fail("provider_failed", "worker_response_invalid");
      return {
        state: !result.finished ? "running" : result.success ? "completed" : "failed",
        error: result.error || null,
      };
    },
    async copyPassStats({ socketPath, pass }) {
      const result = await authenticated(passWorker({ socketPath, pass }), "core/stats", {
        group: pass.group,
      });
      if (
        !record(result) ||
        typeof result.bytes !== "number" ||
        typeof result.transfers !== "number" ||
        typeof result.errors !== "number" ||
        typeof result.speed !== "number"
      )
        throw fail("provider_failed", "worker_response_invalid");
      const transferring = Array.isArray(result.transferring)
        ? result.transferring.map((file: unknown) => {
            if (
              !record(file) ||
              typeof file.name !== "string" ||
              (file.bytes !== undefined && typeof file.bytes !== "number") ||
              typeof file.size !== "number"
            )
              throw fail("provider_failed", "worker_response_invalid");
            // rclone lists a transfer before its byte-accounting reader is attached.
            return { path: file.name, bytes: file.bytes ?? 0, size: file.size };
          })
        : [];
      return {
        bytes: result.bytes,
        files: result.transfers,
        errors: result.errors,
        speed: result.speed,
        transferring,
      };
    },
    async stopCopyPass({ socketPath, pass }) {
      await authenticated(passWorker({ socketPath, pass }), "job/stopgroup", { group: pass.group });
    },
    async startTransferWorker(input) {
      const pending = start(input);
      starting.add(pending);
      try {
        return await pending;
      } finally {
        starting.delete(pending);
      }
    },
    probeTransferWorker,
    async stopTransferWorker({ socketPath }) {
      await shutdown(owned(socketPath), true);
    },
    async terminateTransferWorker({ socketPath }) {
      await shutdown(owned(socketPath), false);
    },
    async transferWorkerVersion({ socketPath }) {
      const worker = workers.get(socketPath);
      if (worker === undefined) return (await probeTransferWorker({ socketPath })).version;
      if (!worker.child.alive) return null;
      return liveVersion(worker);
    },
    async call<T>(
      socketPath: string,
      method: string,
      input: Record<string, unknown> = {},
    ): Promise<T> {
      if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(method))
        throw fail("provider_failed", "worker_method_invalid");
      const worker = owned(socketPath);
      if (worker.stopping !== null) throw fail("provider_failed", "worker_stopping");
      return (await authenticated(worker, method, { ...input, _group: worker.group })) as T;
    },
    async *openRead(socketPath, remotePath) {
      const colon = remotePath.indexOf(":");
      if (colon < 1) throw fail("preflight_failed", "named_remote_required");
      const remote = remotePath.slice(0, colon);
      remoteName(remote);
      yield* stream(owned(socketPath), `${remote}:`, remotePath.slice(colon + 1));
    },
    async *openSource(socketPath, input) {
      remoteName(input.remote);
      // rclone's onedrive backend applies root_folder_id to listings but not to
      // object lookup, which resolves from the drive root: an id-rooted fs
      // answers 404 for its own children and serves a same-named object at the
      // root instead. The drive is still pinned by id, never by remote default.
      const fs = `${input.remote},drive_id=${quoteOption(input.driveId)},encoding=Slash:`;
      yield* stream(owned(socketPath), fs, input.path);
    },
    async close() {
      closed = true;
      await Promise.allSettled(starting);
      const results = await Promise.allSettled(
        [...workers.values()].map((worker) => shutdown(worker, true)),
      );
      if (results.some((result) => result.status === "rejected"))
        throw fail("recovery_required", "worker_cleanup_failed");
    },
  };
}
