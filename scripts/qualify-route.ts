#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fileProbeIds, validateCapturedBundle } from "../src/qualification/bundle.ts";
import { canonicalJson, digestJson } from "../src/engine/store/digest.ts";
import type { EvidenceBundle, ProbeCapture } from "../src/qualification/bundle.ts";
import { QualificationBlocked } from "./qualification/common.ts";
import { runFileQualification } from "./qualification/file.ts";
import { runArchiveQualification } from "./qualification/archive.ts";
import { distributionPlatform } from "./platform.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandId = randomUUID();
const run = promisify(execFile);
const controller = new AbortController();
const interrupted = () => controller.abort(new QualificationBlocked("operator_interrupted"));
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
let temporary: string | undefined;
let staging: string | undefined;
let outputCreated: string | undefined;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function credentialReferences(value: unknown): Promise<number> {
  if (Array.isArray(value)) {
    let count = 0;
    for (const child of value) count += await credentialReferences(child);
    return count;
  }
  if (!object(value)) return 0;
  if (value.resolver !== undefined) {
    if (value.resolver !== "file" || typeof value.path !== "string")
      throw new QualificationBlocked("file_credentials_required");
    const stat = await lstat(resolve(value.path));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    ) {
      throw new QualificationBlocked("credential_file_protection_required");
    }
    return 1;
  }
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      /^(?:client_?secret|private_?key|access_?token|refresh_?token|authorization|password)$/i.test(
        key,
      )
    ) {
      throw new QualificationBlocked("secret_values_forbidden_in_probe_config");
    }
    count += await credentialReferences(child);
  }
  return count;
}

async function sourceDigests(
  directory: string,
  prefix: string,
): Promise<{ path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new QualificationBlocked("tool_source_not_regular");
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      result.push(...(await sourceDigests(join(directory, entry.name), path)));
    else if (entry.isFile())
      result.push({
        path,
        sha256: createHash("sha256")
          .update(await readFile(join(directory, entry.name)))
          .digest("hex"),
      });
  }
  return result;
}

async function writeImmutable(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o444);
}

async function removePrivateTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink())
        await removePrivateTree(join(path, entry.name));
    }
  }
  await rm(path, { recursive: true, force: true });
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: node scripts/qualify-route.ts --config <file> --output <new-directory>\nRequires Node 24, a real native desktop, protected file credential references, and disposable real tenant fixtures. See qualification/probe-config.schema.json. No bundle is written unless every exact-route probe succeeds.\n",
    );
  } else {
    const options: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (
        (key !== "--config" && key !== "--output") ||
        !value ||
        value.startsWith("--") ||
        options[key]
      )
        throw new QualificationBlocked("live_configuration_required");
      options[key] = value;
    }
    if (!options["--config"] || !options["--output"])
      throw new QualificationBlocked("live_configuration_required");
    if (Number(process.versions.node.split(".")[0]) !== 24)
      throw new QualificationBlocked("node_24_required");
    let platform;
    try {
      platform = distributionPlatform();
    } catch {
      throw new QualificationBlocked("supported_desktop_and_os_floor_required");
    }
    const desktopCell = platform.cell;
    const configPath = resolve(options["--config"]);
    const configStat = await lstat(configPath);
    if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.size > 1024 * 1024)
      throw new QualificationBlocked("live_configuration_required");
    const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (
      !object(config) ||
      config.schemaVersion !== 1 ||
      (config.jobType !== "file_migration" && config.jobType !== "teams_archive") ||
      !object(config.jobConfig) ||
      config.acknowledgement !== "I authorize disposable live qualification probes"
    ) {
      throw new QualificationBlocked("live_configuration_required");
    }
    if ((await credentialReferences(config)) === 0)
      throw new QualificationBlocked("file_credentials_required");
    if (
      process.platform === "linux" &&
      ((!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) ||
        !["x11", "wayland"].includes(process.env.XDG_SESSION_TYPE ?? ""))
    ) {
      throw new QualificationBlocked("real_desktop_session_required");
    }
    const destination = resolve(options["--output"]);
    try {
      await lstat(destination);
      throw new QualificationBlocked("immutable_output_already_exists");
    } catch (error) {
      if (!(object(error) && error.code === "ENOENT")) throw error;
    }
    const captures: ProbeCapture[] = [];
    const capture = (value: ProbeCapture): void => {
      assert.equal(value.schemaVersion, 1);
      assert.ok(/^[a-z][a-z0-9_]{0,127}$/.test(value.probeId));
      assert.ok(!captures.some((prior) => prior.probeId === value.probeId));
      assert.ok(value.assertions.length > 0);
      for (const assertion of value.assertions)
        assert.deepEqual(assertion.observed, assertion.expected);
      // Snapshot now: later effect mutation cannot rewrite already captured evidence.
      captures.push(JSON.parse(canonicalJson(value)) as ProbeCapture);
    };
    let desktopOutput: string;
    try {
      ({ stdout: desktopOutput } = await run(
        process.execPath,
        [join(root, "scripts/qualification/desktop.ts")],
        {
          cwd: root,
          timeout: 45_000,
          maxBuffer: 1024 * 1024,
          signal: controller.signal,
          windowsHide: false,
        },
      ));
    } catch {
      throw new QualificationBlocked("native_desktop_runtime_required");
    }
    capture(JSON.parse(desktopOutput) as ProbeCapture);
    temporary = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "mmq-"));
    await chmod(temporary, 0o700);
    const suite =
      config.jobType === "file_migration" ? runFileQualification : runArchiveQualification;
    const result = await suite({
      config,
      jobDirectory: temporary,
      signal: controller.signal,
      capture,
    });
    controller.signal.throwIfAborted();
    assert.equal(result.tuple.jobType, config.jobType);
    assert.equal(result.tuple.transferVersion, "v1.75.0");
    assert.equal(result.tuple.desktopCell, desktopCell);
    assert.equal(result.tuple.guaranteeSetId, config.jobConfig.guarantees ?? "default");
    const requiredProbes =
      config.jobType === "file_migration"
        ? [...fileProbeIds]
        : [
            "graph_route_matrix",
            "hosted_content_bytes",
            "package_self_consistency",
            ...(config.jobConfig.retainedHistory === true ? ["retained_history"] : []),
            ...(config.jobConfig.transcripts === true ? ["transcripts"] : []),
            ...(config.jobConfig.attachmentBytes === true ? ["attachment_bytes"] : []),
          ];
    assert.deepEqual([...result.requiredProbes].sort(), [...requiredProbes].sort());
    assert.ok(requiredProbes.every((id) => captures.some((value) => value.probeId === id)));
    const vendor = JSON.parse(await readFile(join(root, "vendor/rclone/manifest.json"), "utf8"));
    assert.equal(result.binarySha256, vendor.binaries[desktopCell]?.sha256);
    const sources = [
      ...(await sourceDigests(join(root, "src"), "src")),
      ...(await sourceDigests(join(root, "scripts/qualification"), "scripts/qualification")),
    ];
    for (const path of [
      "scripts/qualify-route.ts",
      "scripts/platform.ts",
      "package-lock.json",
      "vendor/rclone/manifest.json",
    ])
      sources.push({
        path,
        sha256: createHash("sha256")
          .update(await readFile(join(root, path)))
          .digest("hex"),
      });
    captures.sort((left, right) => left.probeId.localeCompare(right.probeId, "en"));
    const artifacts = captures.map((value) => {
      const bytes = Buffer.from(`${canonicalJson(value)}\n`);
      return {
        path: `captures/${value.probeId}.json`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        bytes,
      };
    });
    const bundle: EvidenceBundle = {
      schemaVersion: 1,
      tuple: result.tuple,
      capture: {
        suiteVersion: 1,
        capturedAt: new Date().toISOString(),
        nodeVersion: process.version,
        osRelease: platform.osVersion,
        desktopCell,
        toolSha256: digestJson(sources.sort((left, right) => (left.path < right.path ? -1 : 1))),
        binarySha256: result.binarySha256,
      },
      probes: captures.map((value) => ({
        id: value.probeId,
        expectedCodes: [...value.codes].sort(),
        observedCodes: [...value.codes].sort(),
        output: `captures/${value.probeId}.json`,
      })),
      artifacts: artifacts.map(({ path, sha256, size }) => ({ path, sha256, size })),
    };
    const digest = digestJson(bundle);
    const bundlePath = `qualification/${digestJson(result.tuple)}/${digest}`;
    await mkdir(dirname(destination), { recursive: true });
    staging = await mkdtemp(join(dirname(destination), ".migmate-evidence-"));
    const bundleDirectory = join(staging, bundlePath);
    await mkdir(join(bundleDirectory, "captures"), { recursive: true, mode: 0o700 });
    for (const artifact of artifacts)
      await writeImmutable(join(bundleDirectory, artifact.path), artifact.bytes);
    await writeImmutable(
      join(bundleDirectory, "bundle.json"),
      Buffer.from(`${canonicalJson(bundle)}\n`),
    );
    await validateCapturedBundle(staging, {
      bundle: bundlePath,
      digest,
      tuple: result.tuple,
      requiredProbes,
    });
    await removePrivateTree(temporary);
    temporary = undefined;
    await chmod(join(bundleDirectory, "captures"), 0o555);
    await chmod(bundleDirectory, 0o555);
    await mkdir(destination, { mode: 0o700 });
    outputCreated = destination;
    await rename(join(staging, "qualification"), join(destination, "qualification"));
    await removePrivateTree(staging);
    staging = undefined;
    outputCreated = undefined;
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, command: "qualify-route", commandId, job: null, ok: true, value: { bundle: bundlePath, digest, tuple: result.tuple, output: destination, fullLifecycleWebParity: "separate_required_gate" } })}\n`,
    );
  }
} catch (error) {
  const gate = controller.signal.aborted
    ? "operator_interrupted"
    : error instanceof QualificationBlocked
      ? error.gate
      : "live_probe_or_prerequisite_failed";
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, command: "qualify-route", commandId, job: null, ok: false, refusal: { code: "unqualified_route", message: "No qualified-route bundle was published; real prerequisites and all observed guarantees are required.", detail: { gate } } })}\n`,
  );
  process.exitCode = controller.signal.aborted ? 130 : 4;
} finally {
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  for (const path of [temporary, staging, outputCreated]) {
    if (path) {
      try {
        await removePrivateTree(path);
      } catch {
        process.exitCode = process.exitCode || 4;
      }
    }
  }
}
