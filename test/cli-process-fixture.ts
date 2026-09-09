import { openEngine } from "../src/engine/index.ts";
import { run } from "../src/cli/main.ts";
import { processIo } from "../src/cli/io.ts";
import { PersistentCliPort } from "./cli-fixture.ts";

const home = process.env.CLI_TEST_HOME;
const destination = process.env.CLI_TEST_DESTINATION;
const now = process.env.CLI_TEST_NOW;
if (!home || !destination || !now || !Number.isFinite(Date.parse(now))) throw new Error("CLI subprocess fixture needs isolated test paths and a valid clock");
const provider = new PersistentCliPort(destination, Number(process.env.CLI_TEST_DELAY ?? "0"));
const engine = openEngine({ home, provider, adapter: "cli", now: () => new Date(now) });
const transport = processIo();
try { process.exitCode = await run(process.argv.slice(2), transport.io, engine); }
finally { transport.dispose(); }
