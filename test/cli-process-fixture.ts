import { openEngine } from "../src/engine/index.ts";
import { run } from "../src/cli/main.ts";
import { processIo } from "../src/cli/io.ts";
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
const release = (message: unknown) => {
  if (message === "release") provider.release();
};
const disconnected = () => process.kill(process.pid, "SIGTERM");
process.on("message", release);
process.once("disconnect", disconnected);
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
