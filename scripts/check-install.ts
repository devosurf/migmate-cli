// Installer smoke: serves packed releases from 127.0.0.1 in GitHub's URL shape,
// then drives scripts/install.sh and the launcher it writes through a fresh
// install, upgrades, pruning, a tampered checksum, and a private Node runtime.
// The private-runtime case downloads Node from nodejs.org.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Install {
  installDir: string;
  install(args?: string[]): Promise<Run>;
  migmate(args: string[]): Promise<Run>;
  current(): Promise<string | undefined>;
  versions(): Promise<string[]>;
  node(): Promise<string>;
}

const root = fileURLToPath(new URL("../", import.meta.url));
const installer = join(root, "scripts", "install.sh");
const npmCli =
  process.env.npm_execpath ??
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.ok(
  manifest && typeof manifest === "object" && "version" in manifest,
  "package.json has no version",
);
const version = String(manifest.version);
const upgraded = `${version}.1`;
const newest = `${version}.2`;
const tampered = `${version}.tampered`;

// Async on purpose: the release server lives in this process.
function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  const { promise, resolve: done, reject } = Promise.withResolvers<Run>();
  const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.on("error", reject);
  child.on("close", (status) => done({ status, stdout, stderr }));
  return promise;
}

function succeeded(result: Run, what: string): string {
  assert.equal(result.status, 0, `${what} failed\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

const temporary = await mkdtemp(join(tmpdir(), "migmate-install-"));
const server = createServer();
try {
  const packed = join(temporary, "pack");
  await mkdir(packed);
  const packing = spawnSync(process.execPath, [npmCli, "pack", "--pack-destination", packed], {
    cwd: root,
    stdio: "inherit",
  });
  assert.equal(packing.status, 0, "npm pack failed");
  const [tarball] = await readdir(packed);
  assert.ok(tarball !== undefined && tarball.endsWith(".tgz"), "npm pack must produce a tarball");
  const tarballBytes = await readFile(join(packed, tarball));
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

  // One release per version, laid out as the release workflow uploads them.
  const releases = join(temporary, "releases");
  const installerBytes = await readFile(installer);
  for (const release of [version, upgraded, newest, tampered]) {
    const directory = join(releases, `v${release}`);
    const asset = `migmate-${release}.tgz`;
    await mkdir(directory, { recursive: true });
    await copyFile(join(packed, tarball), join(directory, asset));
    await copyFile(installer, join(directory, "install.sh"));
    const assetSum = release === tampered ? "0".repeat(64) : sha256(tarballBytes);
    await writeFile(
      join(directory, "SHA256SUMS"),
      `${assetSum}  ${asset}\n${sha256(installerBytes)}  install.sh\n`,
    );
  }

  let latest = version;
  server.on("request", (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const redirect = (location: string) => {
      response.writeHead(302, { location });
      response.end();
    };
    if (path === "/releases/latest") return redirect(`/releases/tag/v${latest}`);
    if (path.startsWith("/releases/tag/")) return void response.end("release page");
    const latestAsset = /^\/releases\/latest\/download\/([\w.-]+)$/u.exec(path);
    if (latestAsset) return redirect(`/releases/download/v${latest}/${latestAsset[1]}`);
    const asset = /^\/releases\/download\/(v[\w.-]+)\/([\w.-]+)$/u.exec(path);
    const file = asset ? join(releases, asset[1]!, asset[2]!) : undefined;
    if (!file || !existsSync(file)) {
      response.writeHead(404);
      return void response.end();
    }
    createReadStream(file).pipe(response);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === "object", "release server has no TCP address");
  const releasesUrl = `http://127.0.0.1:${address.port}/releases`;

  function layout(name: string, nodeMode: "system" | "bundled"): Install {
    const installDir = join(temporary, name, "install");
    const binDir = join(temporary, name, "bin");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: join(temporary, name, "home"),
      MIGMATE_INSTALL_DIR: installDir,
      MIGMATE_BIN_DIR: binDir,
      MIGMATE_NODE: nodeMode,
      MIGMATE_RELEASES_URL: releasesUrl,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    };
    return {
      installDir,
      install: (args = []) => run("sh", [installer, ...args], env),
      migmate: (args) => run(join(binDir, "migmate"), args, env),
      current: async () => (await readlink(join(installDir, "current"))).split("/").pop(),
      versions: async () => (await readdir(join(installDir, "versions"))).sort(),
      node: async () => (await readFile(join(installDir, "current", ".node"), "utf8")).trim(),
    };
  }

  async function createsJob(install: Install): Promise<void> {
    const home = join(temporary, "jobs", String(Math.random()).slice(2));
    const output = succeeded(
      await install.migmate([
        "init",
        "--type",
        "file_migration",
        "--home",
        home,
        "--output",
        "json",
      ]),
      "installed migmate init",
    );
    const document: unknown = JSON.parse(output);
    assert.ok(document && typeof document === "object" && "ok" in document);
    assert.equal(document.ok, true);
  }

  const system = layout("system", "system");
  succeeded(await system.install(), "fresh install");
  assert.equal(await system.current(), version);
  assert.equal(await system.node(), join(dirname(process.execPath), "node"));
  await createsJob(system);
  assert.match(
    succeeded(await system.migmate(["upgrade"]), "upgrade when current"),
    /already installed and current/u,
  );

  latest = upgraded;
  succeeded(await system.migmate(["upgrade"]), "first upgrade");
  assert.equal(await system.current(), upgraded);
  assert.deepEqual(await system.versions(), [version, upgraded].sort());
  latest = newest;
  succeeded(await system.migmate(["upgrade"]), "second upgrade");
  assert.equal(await system.current(), newest);
  assert.deepEqual(
    await system.versions(),
    [upgraded, newest].sort(),
    "only the current and previous versions are kept",
  );

  const refused = await system.migmate(["upgrade", "--version", tampered]);
  assert.notEqual(refused.status, 0, "a tampered artifact must not install");
  assert.match(refused.stderr, /checksum mismatch/u);
  assert.equal(await system.current(), newest, "a refused upgrade leaves the install untouched");
  await createsJob(system);

  const bundled = layout("bundled", "bundled");
  succeeded(await bundled.install(), "install with a private Node runtime");
  assert.ok(
    (await bundled.node()).startsWith(join(bundled.installDir, "runtime")),
    "MIGMATE_NODE=bundled must use the private runtime",
  );
  await createsJob(bundled);

  console.log(
    `Installer smoke passed for ${process.platform}-${process.arch}: install, upgrade, prune, ` +
      "checksum refusal, and private Node runtime.",
  );
} finally {
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
