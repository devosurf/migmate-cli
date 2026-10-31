import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Invocation } from "./arguments.ts";
import type { AdapterOutcome } from "./envelope.ts";
import type { Io } from "./io.ts";

let initialization: Promise<boolean> | undefined;

/** IPC negotiation also permits fixture entries to retain their own IPC protocol. */
export function initializeDetachedChild(): Promise<boolean> {
  if (initialization) return initialization;
  if (!process.connected || !process.send) return Promise.resolve(false);
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  initialization = promise;
  const cleanup = () => {
    process.off("message", message);
    process.off("disconnect", disconnected);
  };
  const disconnected = () => {
    cleanup();
    reject(new Error("Launcher disconnected before admission"));
  };
  const message = (value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("type" in value) ||
      value.type !== "migmate:launch" ||
      !("detached" in value)
    )
      return;
    cleanup();
    resolve(value.detached === true);
  };
  process.on("message", message);
  process.once("disconnect", disconnected);
  process.send!({ type: "migmate:launch-ready" }, (error) => {
    if (error) {
      cleanup();
      reject(error);
    }
  });
  return initialization;
}

export async function sendLaunchMessage(value: unknown): Promise<void> {
  if (!process.connected || !process.send) throw new Error("Launcher disconnected");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  process.send!(value as Parameters<NonNullable<typeof process.send>>[0], (error: Error | null) =>
    error ? reject(error) : resolve(),
  );
  await promise;
}

export interface DetachedAdmission {
  pid: number;
  ownerUuid: string;
  commandId: string;
  logPath: string;
}

export async function launchDetached(
  invocation: Invocation,
  signal: AbortSignal,
): Promise<AdapterOutcome<DetachedAdmission>> {
  if (signal.aborted)
    return { ok: false, refusal: { code: "internal_defect", message: "Launch interrupted." } };
  const entry = process.argv[1];
  if (!entry) throw new Error("Missing CLI entry");
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      resolve(entry),
      "execute",
      "--home",
      invocation.home,
      "--job",
      invocation.jobId!,
      "--output",
      invocation.output,
    ],
    {
      cwd: join(invocation.home, "jobs", invocation.jobId!),
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: process.env,
    },
  );
  const { promise, resolve: complete } = Promise.withResolvers<AdapterOutcome<DetachedAdmission>>();
  let settled = false;
  let refused: AdapterOutcome<DetachedAdmission> | undefined;
  const finish = (result: AdapterOutcome<DetachedAdmission>) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", interrupt);
    child.unref();
    complete(result);
  };
  const defect = (): AdapterOutcome<never> => ({
    ok: false,
    refusal: {
      code: "internal_defect",
      message: "The background coordinator exited before acknowledging execution.",
    },
  });
  const interrupt = () => {
    if (!settled) child.kill("SIGTERM");
  };
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  child.on("error", () => finish(defect()));
  child.on("exit", () => finish(refused ?? defect()));
  child.on("message", (value: unknown) => {
    if (!value || typeof value !== "object" || !("type" in value)) return;
    if (value.type === "migmate:launch-ready") {
      child.send({ type: "migmate:launch", detached: true }, (error) => {
        if (error) interrupt();
      });
    } else if (value.type === "migmate:refused" && "result" in value) {
      refused = value.result as AdapterOutcome<DetachedAdmission>;
    } else if (value.type === "migmate:admitted" && "admission" in value && !signal.aborted) {
      finish({ ok: true, value: value.admission as DetachedAdmission });
    }
  });
  return promise;
}

export interface AttemptLog {
  logPath: string;
  file: FileHandle;
  io: Io;
}

export async function openAttemptLog(
  home: string,
  jobId: string,
  commandId: string,
  io: Io,
): Promise<AttemptLog> {
  const directory = join(home, "jobs", jobId, "logs");
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
      throw error;
  });
  return createLog();
  async function createLog() {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700)
      throw Object.assign(new Error("Unsafe log directory"), { code: "EACCES" });
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/gu, "")
      .replace(/\.\d{3}Z$/u, "Z");
    const logPath = `logs/execute-${timestamp}-${commandId}.jsonl`;
    const file = await open(
      join(home, "jobs", jobId, logPath),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const stream = {
      isTTY: false,
      async write(chunk: string) {
        await file.writeFile(chunk);
      },
    };
    return { logPath, file, io: { ...io, stdout: stream, stderr: stream } };
  }
}
