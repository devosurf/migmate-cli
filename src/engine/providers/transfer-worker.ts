import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ProviderFault } from "./credentials.ts";
import type { ProviderPort, TransferWorkerHandle, TransferWorkerProbe } from "./port.ts";

const TESTED_VERSIONS: Readonly<Record<string, true>> = { "v1.75.0": true };
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

export interface TransferSupervisor {
  proveBinary(): Promise<BinaryProof>;
  startTransferWorker: ProviderPort["startTransferWorker"];
  probeTransferWorker: ProviderPort["probeTransferWorker"];
  stopTransferWorker: ProviderPort["stopTransferWorker"];
  terminateTransferWorker: ProviderPort["terminateTransferWorker"];
  transferWorkerVersion: ProviderPort["transferWorkerVersion"];
  call<T>(socketPath: string, method: string, input?: Record<string, unknown>): Promise<T>;
  openRead(socketPath: string, remotePath: string): AsyncIterable<Uint8Array>;
  openSource(socketPath: string, input: {
    remote: string;
    parentId: string;
    name: string;
    driveId: string;
  }): AsyncIterable<Uint8Array>;
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
  proof: BinaryProof;
  stopping: Promise<void> | null;
}

function fail(code: string, reason: string, evidence: Record<string, unknown> = {}): ProviderFault {
  return new ProviderFault(code, "The managed transfer worker could not satisfy its safety contract.", {
    check: "transfer_worker", reason, ...evidence,
  });
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
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

function spawnOwned(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string,
  capture = false): OwnedChild {
  const deferred = Promise.withResolvers<void>();
  let child: ChildProcess;
  try {
    child = spawn(binary, args, {
      env, ...(cwd === undefined ? {} : { cwd }), shell: false, windowsHide: true,
      stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
    });
  } catch {
    throw fail("preflight_failed", "worker_spawn_failed");
  }
  const owned = { process: child, exited: deferred.promise, alive: true };
  child.on("error", () => {
    // A failed kill can also emit error. Only a failed spawn proves absence.
    if (child.pid === undefined) { owned.alive = false; deferred.resolve(); }
  });
  child.once("exit", () => { owned.alive = false; deferred.resolve(); });
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
  try { child.process.kill("SIGTERM"); } catch { /* Escalate only this owned child. */ }
  if (await awaitExit(child, STOP_TIMEOUT)) return;
  try { child.process.kill("SIGKILL"); } catch { /* The exit predicate remains authoritative. */ }
  if (!(await awaitExit(child, STOP_TIMEOUT))) throw fail("recovery_required", "worker_shutdown_timeout");
}

async function capture(binary: string, args: string[], env: NodeJS.ProcessEnv,
  timeout = REQUEST_TIMEOUT): Promise<{ value: unknown; success: boolean }> {
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
  child.process.stdout?.on("error", () => { overflow = true; });
  const finished = await awaitExit(child, timeout);
  if (!finished || overflow) {
    await terminate(child);
    throw fail("provider_failed", finished ? "worker_response_too_large" : "worker_request_timeout");
  }
  // Pipes can finish after exit; a inherited pipe must not defeat the deadline.
  if (child.process.stdout !== null && !child.process.stdout.readableEnded && !child.process.stdout.destroyed) {
    const drained = Promise.withResolvers<void>();
    const timer = setTimeout(() => child.process.stdout?.destroy(), STOP_TIMEOUT);
    child.process.stdout.once("end", drained.resolve);
    child.process.stdout.once("close", drained.resolve);
    try { await drained.promise; }
    finally { clearTimeout(timer); }
  }
  if (overflow) throw fail("provider_failed", "worker_response_too_large");
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      success: child.process.exitCode === 0 };
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
  if (!record(value) || typeof value.version !== "string") throw fail("preflight_failed", "version_proof_invalid");
  const parsed = /^v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.version);
  if (parsed !== null) {
    const parts = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
    for (let i = 0; i < VERSION_FLOOR.length; i += 1) {
      if (parts[i]! < VERSION_FLOOR[i]!) throw fail("preflight_failed", "version_below_floor");
      if (parts[i]! > VERSION_FLOOR[i]!) break;
    }
  }
  if (TESTED_VERSIONS[value.version] !== true || value.isGit !== false || value.isBeta !== false) {
    throw fail("preflight_failed", "version_untested");
  }
  return value.version;
}

async function privateDirectory(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
      (process.getuid !== undefined && info.uid !== process.getuid())) {
      throw fail("preflight_failed", "run_directory_permissions");
    }
    return;
  }
  // chmod is not an ACL seam on Windows. Set and verify an owner-only DACL
  // before rclone is spawned; PowerShell is resolved explicitly, never via PATH.
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (systemRoot === undefined || !isAbsolute(systemRoot)) throw fail("preflight_failed", "run_directory_permissions");
  const script = "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    "$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); " +
    "$acl.SetAccessRuleProtection($true,$false); " +
    "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); " +
    "$acl.AddAccessRule($rule); Set-Acl -LiteralPath $env.MIGMATE_RUN_DIRECTORY -AclObject $acl; " +
    "$actual=Get-Acl -LiteralPath $env.MIGMATE_RUN_DIRECTORY; " +
    "if(-not $actual.AreAccessRulesProtected){exit 1}; " +
    "$rules=$actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); " +
    "if($rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow'){exit 1}; " +
    "if($actual.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid -or " +
    "($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne " +
    "[System.Security.AccessControl.FileSystemRights]::FullControl){exit 1}; " +
    "Write-Output 'true'";
  const result = await capture(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { ...systemEnvironment(), MIGMATE_RUN_DIRECTORY: path });
  if (!result.success || result.value !== true) throw fail("preflight_failed", "run_directory_permissions");
}

function response(socketPath: string, path: string, method: string, body: string | undefined,
  authorization: string | undefined, timeout: number): Promise<IncomingMessage> {
  const deferred = Promise.withResolvers<IncomingMessage>();
  try {
    const req = request({ socketPath, path, method, agent: false,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
        ...(authorization === undefined ? {} : { Authorization: authorization }),
      },
    }, (res) => { clearTimeout(timer); deferred.resolve(res); });
    // A hard header deadline covers connect hangs as well as idle sockets.
    const timer = setTimeout(() => req.destroy(), timeout);
    req.once("error", (error) => {
      clearTimeout(timer);
      const denied = record(error) && (error.code === "EACCES" || error.code === "EPERM");
      deferred.reject(fail(denied ? "recovery_required" : "provider_failed",
        denied ? "worker_probe_failed" : "worker_unreachable"));
    });
    req.end(body);
  } catch {
    deferred.reject(fail("provider_failed", "worker_request_invalid"));
  }
  return deferred.promise;
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
  if (path.length === 0 || path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f\\]/u.test(path)) throw fail("preflight_failed", "remote_object_path_invalid");
  try { return path.split("/").map(encodeURIComponent).join("/"); }
  catch { throw fail("preflight_failed", "remote_object_path_invalid"); }
}

function remoteName(name: string): void {
  if (!REMOTE_NAME.test(name)) throw fail("preflight_failed", "named_remote_required");
}

function quoteOption(value: string): string {
  // The serve route's bracket parser runs after URL decoding, so bracket values
  // cannot be made safe merely by percent encoding. Graph IDs do not require them.
  if (!value || /[\[\]\u0000-\u001f\u007f/\\]/u.test(value)) throw fail("preflight_failed", "source_identity_invalid");
  return `'${value.replaceAll("'", "''")}'`;
}

export function createTransferSupervisor(options: {
  configPath: string | null;
  jobDirectory: string;
  binary?: BinarySpec;
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
        const manifest: unknown = JSON.parse(await readFile(join(root, "vendor", "rclone", "manifest.json"), "utf8"));
        if (!record(manifest) || manifest.schemaVersion !== 1 || manifest.version !== "v1.75.0" || !record(manifest.binaries)) {
          throw fail("preflight_failed", "binary_manifest_invalid");
        }
        candidate = manifest.binaries[`${process.platform}-${process.arch}`];
      }
      if (!record(candidate) || typeof candidate.path !== "string" || typeof candidate.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(candidate.sha256) || typeof candidate.provenance !== "string" ||
        !/^[\x20-\x7e]{1,512}$/.test(candidate.provenance)) throw fail("preflight_failed", "binary_provenance_required");
      if (root !== null && isAbsolute(candidate.path)) throw fail("preflight_failed", "binary_manifest_invalid");
      if (root === null && !isAbsolute(candidate.path)) throw fail("preflight_failed", "binary_path_must_be_absolute");
      const path = await realpath(root === null ? candidate.path : resolve(root, candidate.path));
      if (root !== null && !inside(root, path)) throw fail("preflight_failed", "binary_manifest_escape");
      if (!(await lstat(path)).isFile()) throw fail("preflight_failed", "binary_unreadable");
      return { path, sha256: candidate.sha256, provenance: candidate.provenance };
    } catch (error) {
      if (error instanceof ProviderFault) throw error;
      throw fail("preflight_failed", "binary_unavailable");
    }
  }

  async function rehash(expected: BinaryProof): Promise<void> {
    try {
      if (await digest(expected.path) !== expected.sha256) throw fail("plan_revision_required", "binary_changed");
    } catch {
      throw fail("plan_revision_required", "binary_changed");
    }
  }

  async function establishProof(): Promise<BinaryProof> {
    if (proof !== null) { await rehash(proof); return structuredClone(proof); }
    const binary = await resolveBinary();
    if (await digest(binary.path) !== binary.sha256) throw fail("preflight_failed", "binary_checksum_mismatch");
    // v1.75.0 has no `version --json`. This runs that exact executable's
    // core/version locally, with no listener; live RC proof is separate below.
    const own = await capture(binary.path, ["rc", "--loopback", "core/version", "--config", process.platform === "win32" ? "NUL" : "/dev/null"], systemEnvironment());
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
    try { return await proving; }
    finally { proving = null; }
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
      if (!sameFile(directory, worker.directoryIdentity) || directory.isSymbolicLink()) throw new Error();
      const socket = await lstat(worker.socketPath);
      if (socket.isSymbolicLink() || (process.platform !== "win32" && !socket.isSocket()) ||
        (worker.socketIdentity !== null && !sameFile(socket, worker.socketIdentity))) throw new Error();
      worker.socketIdentity ??= socket;
    } catch {
      throw fail("recovery_required", "worker_ownership_unproven");
    }
  }

  async function rc(socketPath: string, method: string, input: Record<string, unknown>,
    worker: Worker | undefined, timeout = REQUEST_TIMEOUT): Promise<{ status: number; answered: boolean; value: unknown }> {
    let body: string;
    try { body = JSON.stringify(input); }
    catch { throw fail("provider_failed", "worker_request_invalid"); }
    if (process.platform === "win32") {
      const executable = worker?.proof ?? await proveBinary();
      await rehash(executable);
      // Go's native client supplies AF_UNIX on Windows. Request JSON and Basic
      // credentials are environment-only, not CLI arguments or files.
      const result = await capture(executable.path,
        ["rc", "--unix-socket", socketPath, method, "--config", "NUL"], {
          ...systemEnvironment(), RCLONE_JSON: body,
          ...(worker === undefined ? {} : { RCLONE_USER: worker.user, RCLONE_PASS: worker.password }),
        }, timeout);
      const status = result.success ? 200 : record(result.value) && typeof result.value.status === "number"
        ? result.value.status : 503;
      // The native client synthesizes 503 only when dialing fails; a real HTTP
      // 503 still proves liveness. Never publish its diagnostic error string.
      const noConnection = !result.success && status === 503 && record(result.value) &&
        typeof result.value.error === "string" && result.value.error.startsWith("connection failed:");
      return { status, answered: !noConnection, value: status === 200 ? result.value : null };
    }
    const res = await response(socketPath, `/${method}`, "POST", body, worker === undefined ? undefined : basic(worker), timeout);
    const status = res.statusCode ?? 0;
    if (status !== 200 || worker === undefined) {
      res.destroy();
      return { status, answered: true, value: null };
    }
    return { status, answered: true, value: await readJson(res, timeout) };
  }

  async function authenticated(worker: Worker, method: string, input: Record<string, unknown> = {}, timeout = REQUEST_TIMEOUT): Promise<unknown> {
    if (!worker.child.alive) throw fail("provider_failed", "worker_exited");
    await verifySocket(worker);
    const result = await rc(worker.socketPath, method, input, worker, timeout);
    if (result.status !== 200) throw fail("provider_failed", "worker_request_failed", { status: result.status });
    return result.value;
  }

  async function liveVersion(worker: Worker): Promise<string> {
    await rehash(worker.proof);
    const current = await authenticated(worker, "core/version");
    if (!record(current) || current.version !== worker.proof.version || current.isGit !== false || current.isBeta !== false) {
      throw fail("plan_revision_required", "worker_version_changed");
    }
    await rehash(worker.proof);
    return worker.proof.version;
  }

  async function cleanup(worker: Worker): Promise<void> {
    if (worker.child.alive) throw fail("recovery_required", "worker_shutdown_timeout");
    try {
      const info = await lstat(worker.directory);
      if (!sameFile(info, worker.directoryIdentity) || info.isSymbolicLink()) throw fail("recovery_required", "worker_ownership_unproven");
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
        try { await authenticated(worker, "job/stopgroup", { group: worker.group }, STOP_TIMEOUT); }
        catch { /* The directly owned child remains eligible for bounded termination. */ }
        try { await authenticated(worker, "core/quit", {}, STOP_TIMEOUT); }
        catch { /* core/quit may close its connection before replying. */ }
        await awaitExit(worker.child, STOP_TIMEOUT);
      }
      await terminate(worker.child);
      await cleanup(worker);
    })();
    try { await worker.stopping; }
    catch (error) { worker.stopping = null; throw error; }
  }

  async function start(input: { runDirectory: string }): Promise<TransferWorkerHandle> {
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
      if (!inside(relativeRoot, requested)) throw fail("preflight_failed", "run_directory_outside_job");
      // Resolve the job's external spelling (e.g. macOS /tmp) once, then reject
      // every symlink below it before creating the private worker directory.
      const relativeParts = relative(relativeRoot, requested).split(sep).filter(Boolean);
      let parent = root;
      for (const part of relativeParts) {
        const next = join(parent, part);
        try { await mkdir(next, { mode: 0o700 }); }
        catch (error) { if (!record(error) || error.code !== "EEXIST") throw error; }
        const info = await lstat(next);
        if (!info.isDirectory() || info.isSymbolicLink()) throw fail("preflight_failed", "run_directory_invalid");
        parent = next;
      }
      directory = await mkdtemp(join(parent, "rc-"));
      directoryIdentity = await lstat(directory);
      await privateDirectory(directory);
      const socketPath = join(directory, "s");
      if (Buffer.byteLength(socketPath) > (process.platform === "darwin" ? 103 : 107)) throw fail("preflight_failed", "worker_socket_path_too_long");
      const user = randomBytes(18).toString("hex");
      const password = randomBytes(32).toString("base64url");
      const configPath = options.configPath === null ? (process.platform === "win32" ? "NUL" : "/dev/null") : options.configPath;
      if (!isAbsolute(configPath) && configPath !== "NUL") throw fail("preflight_failed", "worker_config_path_invalid");
      await rehash(executable);
      const child = spawnOwned(executable.path, ["rcd", "--rc-addr", `unix://${socketPath}`,
        "--rc-serve", "--config", configPath, "--cache-dir", directory, "--temp-dir", directory,
        "--drive-skip-gdocs=true", "--drive-skip-shortcuts=true", "--drive-import-formats=",
        "--drive-metadata-owner=off", "--drive-metadata-permissions=off", "--drive-metadata-labels=off",
        "--metadata=false", "--onedrive-disable-site-permission=true", "--onedrive-expose-onenote-files=true",
        "--retries=1", "--low-level-retries=1",
        "--rc-server-read-timeout", "1h", "--rc-server-write-timeout", "1h"],
      { ...systemEnvironment(), TMPDIR: directory, TEMP: directory, TMP: directory,
        RCLONE_RC_USER: user, RCLONE_RC_PASS: password }, directory);
      worker = { child, directory, directoryIdentity, socketPath,
        socketIdentity: null, user, password, group: `migmate-${randomBytes(16).toString("hex")}`,
        proof: executable, stopping: null };
      workers.set(socketPath, worker);
      const deadline = Date.now() + READY_TIMEOUT;
      let ready = false;
      while (Date.now() < deadline && child.alive) {
        try {
          const probe = await rc(socketPath, "rc/noop", {}, undefined, Math.min(1_000, deadline - Date.now()));
          if (!probe.answered) throw fail("provider_failed", "worker_unreachable");
          if (probe.status !== 401) throw fail("preflight_failed", "worker_auth_not_enforced");
          await authenticated(worker, "rc/noop", {}, Math.min(1_000, Math.max(1, deadline - Date.now())));
          const identity = await authenticated(worker, "core/pid", {}, 1_000);
          if (!record(identity) || identity.pid !== child.process.pid) throw fail("recovery_required", "worker_ownership_unproven");
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
      return { socketPath, pid: child.process.pid, version: executable.version, group: worker.group };
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
      const result = await rc(input.socketPath, "rc/noop", {}, undefined, 1_000);
      if (!result.answered) return { alive: false, version: null };
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
    try { return { alive: true, version: await liveVersion(worker) }; }
    catch (error) {
      if (error instanceof ProviderFault && error.code === "provider_failed") return { alive: true, version: null };
      throw error;
    }
  }

  async function* stream(worker: Worker, fs: string, path: string): AsyncIterable<Uint8Array> {
    const encodedPath = objectPath(path);
    if (!worker.child.alive) throw fail("provider_failed", "worker_exited");
    if (worker.stopping !== null) throw fail("provider_failed", "worker_stopping");
    await verifySocket(worker);
    if (process.platform === "win32") {
      // Node exposes named pipes rather than AF_UNIX here. The verified rclone
      // client requests a real worker copy into an owned private temporary file.
      const name = `read-${randomBytes(16).toString("hex")}`;
      const target = join(worker.directory, name);
      try {
        await authenticated(worker, "operations/copyfile", {
          srcFs: fs, srcRemote: path, dstFs: worker.directory, dstRemote: name, _group: worker.group,
        }, 60 * 60 * 1_000);
        for await (const chunk of createReadStream(target)) yield chunk;
      } catch (error) {
        if (error instanceof ProviderFault) throw error;
        throw fail("provider_failed", "worker_read_failed");
      } finally {
        await rm(target, { force: true }).catch(() => undefined);
      }
      return;
    }
    const res = await response(worker.socketPath, `/${encodeURIComponent(`[${fs}]`)}/${encodedPath}`,
      "GET", undefined, basic(worker), REQUEST_TIMEOUT);
    if (res.statusCode !== 200) { const status = res.statusCode ?? 0; res.destroy(); throw fail("provider_failed", "worker_read_failed", { status }); }
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
    async startTransferWorker(input) {
      const pending = start(input);
      starting.add(pending);
      try { return await pending; }
      finally { starting.delete(pending); }
    },
    probeTransferWorker,
    async stopTransferWorker({ socketPath }) { await shutdown(owned(socketPath), true); },
    async terminateTransferWorker({ socketPath }) { await shutdown(owned(socketPath), false); },
    async transferWorkerVersion({ socketPath }) {
      const worker = workers.get(socketPath);
      if (worker === undefined) return (await probeTransferWorker({ socketPath })).version;
      if (!worker.child.alive) return null;
      return liveVersion(worker);
    },
    async call<T>(socketPath: string, method: string, input: Record<string, unknown> = {}): Promise<T> {
      if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(method)) throw fail("provider_failed", "worker_method_invalid");
      const worker = owned(socketPath);
      if (worker.stopping !== null) throw fail("provider_failed", "worker_stopping");
      return await authenticated(worker, method, { ...input, _group: worker.group }) as T;
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
      if (input.name.includes("/")) throw fail("preflight_failed", "remote_object_path_invalid");
      const fs = `${input.remote},root_folder_id=${quoteOption(input.parentId)},drive_id=${quoteOption(input.driveId)},encoding=Slash:`;
      yield* stream(owned(socketPath), fs, input.name);
    },
    async close() {
      closed = true;
      await Promise.allSettled(starting);
      const results = await Promise.allSettled([...workers.values()].map((worker) => shutdown(worker, true)));
      if (results.some((result) => result.status === "rejected")) throw fail("recovery_required", "worker_cleanup_failed");
    },
  };
}
