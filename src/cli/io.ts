import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";

export interface IoStream {
  isTTY: boolean;
  /** Resolves only after the write callback and, when needed, drain. */
  write(chunk: string): void | Promise<void>;
}
export interface IoInput {
  isTTY: boolean;
  readLine(signal?: AbortSignal): Promise<string | null>;
}
export interface Io {
  stdout: IoStream;
  stderr: IoStream;
  stdin: IoInput;
  signal?: AbortSignal;
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function processIo(): { io: Io; dispose(): void } {
  const controller = new AbortController();
  let failure: Error | undefined;
  const interrupt = () =>
    controller.abort(Object.assign(new Error("Interrupted"), { code: "SIGINT" }));
  const terminate = () =>
    controller.abort(Object.assign(new Error("Terminated"), { code: "SIGTERM" }));
  const brokenPipe = () => {
    failure = Object.assign(new Error("Output unavailable"), { code: "EPIPE" });
    controller.abort(failure);
  };
  const onError = (error: Error) => {
    failure = error;
    controller.abort(error);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGPIPE", brokenPipe);
  process.stdout.on("error", onError);
  process.stderr.on("error", onError);

  const stream = (target: Writable & { isTTY?: boolean }): IoStream => ({
    isTTY: Boolean(target.isTTY),
    async write(chunk) {
      if (failure) throw failure;
      await new Promise<void>((resolve, reject) => {
        let callbackDone = false;
        let writeReturned = false;
        let drained = true;
        let finished = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (error?: Error) => {
          if (finished || (!error && (!writeReturned || !callbackDone || !drained))) return;
          finished = true;
          clearTimeout(timer);
          target.off("drain", onDrain);
          target.off("error", onWriteError);
          controller.signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        const onDrain = () => {
          drained = true;
          finish();
        };
        const onWriteError = (error: Error) => finish(error);
        // A full pipe must not prevent an interrupted engine from checkpointing
        // and releasing the lease. No unbounded flush after a process signal.
        const onAbort = () => {
          if (failure) {
            finish(failure);
            return;
          }
          timer ??= setTimeout(() => finish(controller.signal.reason), 5000);
        };
        target.on("error", onWriteError);
        target.on("drain", onDrain);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        try {
          drained = target.write(chunk, "utf8", (error) => {
            callbackDone = true;
            if (error) {
              onError(error);
              finish(error);
            } else finish();
          });
          writeReturned = true;
          finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Output failed"));
        }
      });
    },
  });
  return {
    io: {
      stdout: stream(process.stdout),
      stderr: stream(process.stderr),
      signal: controller.signal,
      stdin: {
        isTTY: Boolean(process.stdin.isTTY),
        async readLine(signal) {
          const input = createInterface({ input: process.stdin });
          try {
            return await input.question("", signal ? { signal } : {});
          } catch {
            return null;
          } finally {
            input.close();
            process.stdin.pause();
          }
        },
      },
    },
    dispose() {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.off("SIGPIPE", brokenPipe);
      // Writable emits its error after invoking the failed write callback.
      setImmediate(() => {
        process.stdout.off("error", onError);
        process.stderr.off("error", onError);
      });
    },
  };
}
