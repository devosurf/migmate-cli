import { spawnSync } from "node:child_process";
import { chmod, cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const require = createRequire(import.meta.url);

await rm(dist, { recursive: true, force: true });
const compiled = spawnSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "--project", join(root, "tsconfig.build.json")],
  { cwd: root, stdio: "inherit" },
);
if (compiled.error !== undefined) throw compiled.error;
if (compiled.status !== 0) {
  throw new Error(`TypeScript emission failed (${compiled.signal ?? compiled.status})`);
}

// Preserve every embedded asset beside its emitted module, not just today's web files and schema.
await cp(join(root, "src"), dist, {
  recursive: true,
  filter: (source) => !/\.(?:[cm]?ts|tsx)$/i.test(source),
});
await chmod(join(dist, "cli", "main.js"), 0o755);
