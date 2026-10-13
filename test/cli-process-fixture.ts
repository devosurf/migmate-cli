import { openEngine } from "../src/engine/index.ts";
import { run } from "../src/cli/main.ts";
import { errorCode, processIo } from "../src/cli/io.ts";
import { PersistentCliPort } from "./cli-fixture.ts";

const home = process.env.CLI_TEST_HOME;
const destination = process.env.CLI_TEST_DESTINATION;
const now = process.env.CLI_TEST_NOW;
if (!home || !destination || !now || !Number.isFinite(Date.parse(now)))
  throw new Error("CLI subprocess fixture needs isolated test paths and a valid clock");
const provider = new PersistentCliPort(
  destination,
  process.env.CLI_TEST_HOLD === "1"
    ? { verb: process.argv[2]!, ready: () => process.send?.("checkpoint") }
    : undefined,
);
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
process.once("disconnect", disconnected);
if (process.env.CLI_TEST_BLOCK_ON_ABORT) {
  const write = transport.io.stdout.write;
  transport.io.stdout.write = (chunk) =>
    write(transport.io.signal?.aborted ? `${" ".repeat(8 * 1024 * 1024)}${chunk}` : chunk);
}
try {
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
