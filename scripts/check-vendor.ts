#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const VERSION = "v1.75.0";
const RELEASES = {
  "darwin-arm64": "osx-arm64",
  "darwin-x64": "osx-amd64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-amd64",
  "win32-arm64": "windows-arm64",
  "win32-x64": "windows-amd64",
};
const executeFile = promisify(execFile);

function requireContained(root: string, target: string): void {
  const path = relative(root, target);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Vendor path escapes package root: ${target}`);
  }
}

async function packageFile(root: string, path: string): Promise<string> {
  const parts = path.split("/");
  if (
    isAbsolute(path) ||
    parts.some((part) => part === "" || part === "." || part === ".." || /[\\:]/u.test(part))
  ) {
    throw new Error(`Invalid package-relative vendor path: ${path}`);
  }
  let target = root;
  for (const [index, part] of parts.entries()) {
    target = resolve(target, part);
    requireContained(root, target);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in vendor paths: ${target}`);
    }
    const final = index === parts.length - 1;
    if (final ? !metadata.isFile() : !metadata.isDirectory()) {
      throw new Error(`Vendor path is not a ${final ? "regular file" : "directory"}: ${target}`);
    }
  }
  const resolved = await realpath(target);
  requireContained(root, resolved);
  return resolved;
}

async function hashExecutable(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

async function main(): Promise<void> {
  if (process.argv.length > 3) {
    throw new Error("Usage: node scripts/check-vendor.ts [package-root]");
  }
  const root = await realpath(resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url))));
  const manifestPath = await packageFile(root, "vendor/rclone/manifest.json");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    Object.keys(manifest).length !== 3 ||
    !("schemaVersion" in manifest) ||
    manifest.schemaVersion !== 1 ||
    !("version" in manifest) ||
    manifest.version !== VERSION ||
    !("binaries" in manifest) ||
    typeof manifest.binaries !== "object" ||
    manifest.binaries === null ||
    Array.isArray(manifest.binaries)
  ) {
    throw new Error("Vendor manifest must use schema 1 and exact version v1.75.0");
  }
  const binaries = manifest.binaries;
  const cells = Object.keys(RELEASES);
  if (Object.keys(binaries).length !== cells.length || cells.some((cell) => !(cell in binaries))) {
    throw new Error("Vendor manifest must contain exactly the six supported platform/architecture cells");
  }

  const checked: Array<{
    key: string;
    path: string;
    sha256: string;
    size: number;
    provenance: string;
  }> = [];
  const hostKey = `${process.platform}-${process.arch}`;
  let hostPath: string | undefined;
  // The exact key set was checked above; values remain unknown until parsed below.
  const entries = Object.entries(binaries) as Array<[keyof typeof RELEASES, unknown]>;
  for (const [cell, entry] of entries) {
    const release = RELEASES[cell];
    const executable = cell.startsWith("win32-") ? "rclone.exe" : "rclone";
    const expectedPath = `vendor/rclone/${release}/${executable}`;
    const expectedProvenance = `https://downloads.rclone.org/${VERSION}/rclone-${VERSION}-${release}.zip`;
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 3 ||
      !("path" in entry) ||
      entry.path !== expectedPath ||
      !("provenance" in entry) ||
      entry.provenance !== expectedProvenance ||
      !("sha256" in entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(`Invalid vendor manifest entry for ${cell}`);
    }
    const path = await packageFile(root, expectedPath);
    const metadata = await lstat(path);
    if (process.platform !== "win32" && (metadata.mode & 0o111) === 0) {
      throw new Error(`Packaged binary is not executable: ${path}`);
    }
    const actual = await hashExecutable(path);
    if (actual.sha256 !== entry.sha256) {
      throw new Error(`Packaged executable SHA256 mismatch for ${cell}: ${path}`);
    }
    checked.push({
      key: cell,
      path: expectedPath,
      sha256: actual.sha256,
      size: actual.size,
      provenance: expectedProvenance,
    });
    if (cell === hostKey) {
      hostPath = path;
    }
  }
  if (hostPath === undefined) {
    throw new Error(`No managed rclone binary supports this host: ${hostKey}`);
  }

  // Absolute managed path only. Loopback dispatches locally without an RC listener.
  const { stdout } = await executeFile(hostPath, ["rc", "--loopback", "core/version"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const version: unknown = JSON.parse(stdout);
  if (
    typeof version !== "object" ||
    version === null ||
    Array.isArray(version) ||
    !("version" in version) ||
    version.version !== VERSION
  ) {
    throw new Error(`Managed host binary must report exact version ${VERSION}: ${hostPath}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version: VERSION,
        packageRoot: root,
        binaries: checked,
        host: { key: hostKey, path: hostPath, version: version.version },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`check-vendor: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
