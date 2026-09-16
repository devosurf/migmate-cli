import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distributionPlatform } from "./platform.ts";
import { unsupportedNode } from "../src/versions.ts";

interface PackageManifest {
  name: string;
  version: string;
  bin: Record<string, string>;
  exports: Record<string, unknown>;
  dependencies: Record<string, string>;
}

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = process.argv.slice(2).includes("--desktop");
assert.ok(
  process.argv.slice(2).every((argument) => argument === "--desktop"),
  "Unknown option",
);
assert.equal(unsupportedNode(), null, "Package smoke requires a supported Node runtime");
distributionPlatform();
const npmCli =
  process.env.npm_execpath ??
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
assert.ok(existsSync(npmCli), "Cannot locate npm; invoke this script with npm run check:package");
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const env: NodeJS.ProcessEnv = {
  ...process.env,
  [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ""}`,
};

function command(
  file: string,
  args: string[],
  cwd: string,
  options: { inherit?: boolean } = {},
): string {
  const result = spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error !== undefined) throw result.error;
  assert.equal(
    result.status,
    0,
    `${file} ${args.join(" ")} failed (${result.signal ?? result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  return result.stdout ?? "";
}

async function sourceAssets(directory: string): Promise<string[]> {
  const assets: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) assets.push(...(await sourceAssets(path)));
    else if (!/\.(?:[cm]?ts|tsx)$/i.test(entry.name)) assets.push(path);
  }
  return assets;
}

const temporary = await mkdtemp(join(tmpdir(), "migmate-package-"));
try {
  // Run the real prepack lifecycle: emission and vendor verification, never an npm link to sources.
  command(process.execPath, [npmCli, "pack", "--pack-destination", temporary], root, {
    inherit: true,
  });
  const tarballs = (await readdir(temporary)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "npm pack must produce exactly one artifact");
  const prefix = join(temporary, "prefix");
  command(
    process.execPath,
    [
      npmCli,
      "install",
      "--global",
      "--prefix",
      prefix,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(temporary, tarballs[0]!),
    ],
    temporary,
    { inherit: true },
  );
  const consumer = join(prefix, "lib");
  const expected = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as PackageManifest;
  const installed = join(consumer, "node_modules", ...expected.name.split("/"));
  const manifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  ) as PackageManifest;
  assert.equal(manifest.name, expected.name);
  assert.equal(manifest.version, expected.version);
  assert.deepEqual(manifest.bin, { migmate: "dist/cli/main.js" });
  assert.deepEqual(manifest.exports, {}, "The CLI package must expose no public SDK");
  assert.deepEqual(manifest.dependencies, {
    "@webviewjs/webview": "0.4.5",
    parse5: "8.0.0",
    "smol-toml": "1.8.0",
  });
  assert.equal(existsSync(join(installed, "src")), false, "Unemitted source must not be shipped");
  assert.equal(
    existsSync(join(installed, "scripts")),
    false,
    "Repository tooling must not be shipped",
  );
  assert.equal(existsSync(join(installed, "dist", "package.json")), false);

  const assets = await sourceAssets(join(root, "src"));
  for (const source of assets) {
    const destination = join(installed, "dist", relative(join(root, "src"), source));
    assert.deepEqual(
      await readFile(destination),
      await readFile(source),
      `Embedded asset: ${source}`,
    );
  }
  assert.ok((await stat(join(installed, "dist", "engine", "store", "schema.sql"))).isFile());

  // A route stays qualified only if its evidence survives packing and validates
  // through the installed reader, whose root must not fall back to this checkout.
  const gates = JSON.parse(await readFile(join(root, "qualification/gates.json"), "utf8"));
  command(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const installed = ${JSON.stringify(installed)};
const { readQualifiedBundle } = await import(pathToFileURL(installed + '/dist/qualification/bundle.js'));
for (const route of ${JSON.stringify(gates.qualifiedRoutes)}) {
  const bundle = 'qualification/' + route.tupleDigest + '/' + route.bundleDigest;
  const evidence = JSON.parse(await readFile(installed + '/' + bundle + '/bundle.json', 'utf8'));
  await readQualifiedBundle({
    bundle, digest: route.bundleDigest, tuple: evidence.tuple,
    requiredProbes: evidence.probes.map(probe => probe.id),
  });
  console.log('Installed qualified bundle accepted: ' + route.tupleDigest);
}`,
    ],
    temporary,
    { inherit: true },
  );

  const privateSpecifiers = [
    manifest.name,
    `${manifest.name}/engine`,
    `${manifest.name}/dist/engine/index.js`,
    `${manifest.name}/package.json`,
  ];
  command(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from 'node:assert/strict';
for (const specifier of ${JSON.stringify(privateSpecifiers)}) {
  await assert.rejects(import(specifier), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}`,
    ],
    consumer,
  );

  // The verifier hashes all four installed binaries and asserts the host's local core/version.
  command(process.execPath, [join(root, "scripts", "check-vendor.ts"), installed], temporary, {
    inherit: true,
  });

  const binDirectory = join(prefix, "bin");
  const binFiles = (await readdir(binDirectory)).filter((name) => name !== "node_modules");
  assert.deepEqual(
    binFiles.sort(),
    ["migmate"],
    "Global install must expose only the migmate command",
  );
  const bin = join(binDirectory, "migmate");
  assert.ok((await stat(bin)).mode & 0o111, "The installed CLI must be executable");
  function cli(args: string[], inherit = false): string {
    return command(bin, args, temporary, { inherit });
  }

  const home = join(temporary, "home");
  env.MIGMATE_HOME = home;
  assert.match(cli(["--help"]), /migmate/);
  const initialized = JSON.parse(
    cli(["init", "--type", "file_migration", "--home", home, "--output", "json"]),
  ) as { command: string; job: { id: string }; ok: boolean };
  assert.equal(initialized.command, "init");
  assert.equal(initialized.ok, true);
  assert.ok(
    initialized.job.id,
    "The installed CLI must create a durable job using its embedded schema",
  );
  const status = JSON.parse(
    cli(["status", "--job", initialized.job.id, "--home", home, "--output", "json"]),
  ) as { command: string; job: { id: string }; ok: boolean };
  assert.equal(status.command, "status");
  assert.equal(status.ok, true);
  assert.equal(status.job.id, initialized.job.id);

  // Exercise embedded assets through the installed adapter, whether emitted from
  // TypeScript constants or copied files. A source-tree .html file is not the contract.
  command(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const installed = ${JSON.stringify(installed)};
const require = createRequire(pathToFileURL(installed + '/package.json'));
const { parse } = await import(pathToFileURL(require.resolve('parse5')));
const { openEngine } = await import(pathToFileURL(installed + '/dist/engine/index.js'));
const { WebSession } = await import(pathToFileURL(installed + '/dist/web/session.js'));
const { createProtocolHandler } = await import(pathToFileURL(installed + '/dist/web/protocol.js'));
const engine = openEngine({ home: ${JSON.stringify(home)}, adapter: 'web' });
const session = new WebSession({ engine, job: ${JSON.stringify(initialized.job)} });
try {
  const handler = createProtocolHandler({ session });
  const response = await handler(new Request('migmate://localhost/'));
  assert.equal(response.status, 200);
  assert.ok((response.headers.get('content-type') ?? '').startsWith('text/html'));
  const failures = [];
  const document = parse(await response.text(), { onParseError: (failure) => failures.push(failure.code) });
  assert.deepEqual(failures, []);
  const pending = [document];
  while (pending.length) {
    const node = pending.pop();
    const attributes = Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
    const resource = node.tagName === 'script' ? attributes.src
      : node.tagName === 'link' && attributes.rel === 'stylesheet' ? attributes.href : undefined;
    if (resource) {
      const url = new URL(resource, 'migmate://localhost/');
      assert.equal(url.protocol, 'migmate:');
      assert.equal(url.hostname, 'localhost');
      const asset = await handler(new Request(url));
      assert.equal(asset.status, 200);
      await asset.arrayBuffer();
    }
    pending.push(...(node.childNodes ?? []));
  }
} finally {
  await session.close();
  engine.close();
}
`,
    ],
    temporary,
  );

  if (desktop) {
    console.log(
      "MANUAL DESKTOP GATE: an operator must inspect the installed native window and close it. " +
        "A successful process exit alone is not visual or route qualification evidence.",
    );
    cli(["web", "--job", initialized.job.id, "--home", home], true);
    console.log("Native desktop command exited; visual qualification must be recorded separately.");
  }
  console.log(
    `Installed package smoke passed for ${process.platform}-${process.arch}: one bin, private modules, ` +
      "embedded assets, durable job, and managed rclone v1.75.0. No live route was qualified.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
