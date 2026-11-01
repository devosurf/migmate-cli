import { openEngine } from "../src/engine/index.ts";
import { run, initializeDetachedChild } from "../src/cli/main.ts";
import { errorCode, processIo } from "../src/cli/io.ts";
import { DropboxCliPort, PersistentCliPort } from "./cli-fixture.ts";
import { writeFileSync } from "node:fs";

const home = process.env.CLI_TEST_HOME;
const destination = process.env.CLI_TEST_DESTINATION;
const now = process.env.CLI_TEST_NOW;
if (!home || !destination || !now || !Number.isFinite(Date.parse(now)))
  throw new Error("CLI subprocess fixture needs isolated test paths and a valid clock");
process.env.MIGMATE_HOME = home;
const detachedChild = await initializeDetachedChild();
const FixturePort =
  process.env.CLI_TEST_SOURCE_PROVIDER === "dropbox" ? DropboxCliPort : PersistentCliPort;
const provider = new FixturePort(
  destination,
  process.env.CLI_TEST_HOLD === "1"
    ? {
        verb: process.argv[2]!,
        ready: () => {
          if (process.connected) process.send?.("checkpoint");
        },
      }
    : undefined,
  process.env.CLI_TEST_DESTINATION_PROVIDER === "sharepoint" ? "sharepoint" : "google_shared_drive",
  process.env.CLI_TEST_SHAREPOINT_MEMBERSHIP === "1",
);
if (process.env.CLI_TEST_ENCODED_NAMES === "1") {
  provider.renameSourceItem("source-0", "report?.txt");
  provider.renameSourceItem("source-1", "report？.txt");
  provider.renameSourceItem("source-2", "literal/slash.txt");
}
const engine = openEngine({ home, provider, adapter: "cli", now: () => new Date(now) });
const transport = processIo();
const release = async (message: unknown) => {
  if (message === "release") provider.release();
  if (message === "write-stdout") {
    try {
      // Whitespace is valid between JSONL records; this goes through the real
      // process transport, not a synthetic error or an injected abort signal.
      await transport.io.stdout.write("\n");
    } catch (error) {
      if (errorCode(error) !== "EPIPE") throw error;
    }
  }
};
const disconnected = () => process.kill(process.pid, "SIGTERM");
process.on("message", release);
if (!detachedChild) process.once("disconnect", disconnected);
if (process.env.CLI_TEST_BLOCK_ON_ABORT) {
  const write = transport.io.stdout.write;
  transport.io.stdout.write = (chunk) =>
    write(transport.io.signal?.aborted ? `${" ".repeat(8 * 1024 * 1024)}${chunk}` : chunk);
}
try {
  if (detachedChild && process.env.CLI_TEST_ADMISSION_MARKER) {
    process.once("disconnect", disconnected);
    writeFileSync(process.env.CLI_TEST_ADMISSION_MARKER, String(process.pid));
    await new Promise<void>((resolve) => {
      if (transport.io.signal?.aborted) resolve();
      else transport.io.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    process.off("disconnect", disconnected);
  }
  process.exitCode = await run(process.argv.slice(2), transport.io, engine);
} finally {
  provider.release();
  engine.close();
  process.off("message", release);
  process.off("disconnect", disconnected);
  if (process.connected) process.disconnect();
  transport.dispose();
}
if (transport.io.signal?.aborted) process.exit(process.exitCode);
