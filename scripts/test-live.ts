#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/engine/store/digest.ts";
import { unsupportedNode } from "../src/versions.ts";
import { LIVE_TEST_ACKNOWLEDGEMENT, LiveTestBlocked } from "./live/common.ts";
import { runFileLiveTest } from "./live/file.ts";
import { runArchiveLiveTest } from "./live/archive.ts";
import {
  fileProbeIds,
  probeFailures,
  reverseFileProbeIds,
  type ProbeCapture,
} from "./live/probes.ts";

const usage =
  "Usage: npm run test:live -- --config <file>\n" +
  "Optional. Exercises rclone mapping copies/hash verification or the archive suite in disposable tenant roots; see\n" +
  "scripts/live/config.schema.json. Needs Node 24.15.0 or later and protected file credential references.\n";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandId = randomUUID();
const controller = new AbortController();
const interrupted = () => controller.abort(new LiveTestBlocked("operator_interrupted"));
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
let temporary: string | undefined;

/**
 * A defect is a maintainer's bug, not an operator's missing prerequisite. Emit only
 * what locates it — the error's own kind, the assertion operator when `node:assert`
 * raised it, a provider status, and the first stack frame inside this repository.
 * Never the message: on a provider fault it can carry a URL or a header value.
 */
function defectDiagnosis(error: unknown): Record<string, unknown> {
  const fault = error as Partial<Error> & { operator?: unknown; status?: unknown };
  const frame = String(fault.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes(`${root}/`) && !line.includes("node_modules"));
  const origin = frame?.slice(frame.indexOf(`${root}/`) + root.length + 1).replace(/\)$/, "");
  return {
    defect: typeof fault.name === "string" ? fault.name : typeof error,
    ...(typeof fault.operator === "string" ? { assertion: fault.operator } : {}),
    ...(typeof fault.status === "number" ? { status: fault.status } : {}),
    ...(origin ? { origin } : {}),
  };
}

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
      throw new LiveTestBlocked("file_credentials_required");
    const stat = await lstat(resolve(value.path));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    ) {
      throw new LiveTestBlocked("credential_file_protection_required");
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
      throw new LiveTestBlocked("secret_values_forbidden_in_live_config");
    }
    count += await credentialReferences(child);
  }
  return count;
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

function envelope(body: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, command: "test-live", commandId, job: null, ...body })}\n`,
  );
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(usage);
} else if (args.length !== 2 || args[0] !== "--config" || !args[1] || args[1].startsWith("--")) {
  process.stderr.write(usage);
  envelope({
    ok: false,
    refusal: { code: "usage", message: "test:live needs exactly --config <file>." },
  });
  process.exitCode = 2;
} else {
  try {
    if (unsupportedNode() !== null) throw new LiveTestBlocked("node_runtime_unsupported");
    const configPath = resolve(args[1]);
    const configStat = await lstat(configPath);
    if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.size > 1024 * 1024)
      throw new LiveTestBlocked("live_configuration_required");
    const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (
      !object(config) ||
      config.schemaVersion !== 1 ||
      (config.jobType !== "file_migration" && config.jobType !== "teams_archive") ||
      !object(config.jobConfig) ||
      config.acknowledgement !== LIVE_TEST_ACKNOWLEDGEMENT
    ) {
      throw new LiveTestBlocked("live_configuration_required");
    }
    if ((await credentialReferences(config)) === 0)
      throw new LiveTestBlocked("file_credentials_required");
    const captures: ProbeCapture[] = [];
    temporary = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "mml-"));
    await chmod(temporary, 0o700);
    const suite = config.jobType === "file_migration" ? runFileLiveTest : runArchiveLiveTest;
    const result = await suite({
      config,
      jobDirectory: temporary,
      signal: controller.signal,
      // Snapshot now: later effect mutation cannot rewrite an already captured probe.
      capture: (value) => captures.push(JSON.parse(canonicalJson(value)) as ProbeCapture),
    });
    controller.signal.throwIfAborted();
    const jobConfig = config.jobConfig;
    const scopes = Array.isArray(jobConfig.scopes) ? jobConfig.scopes.filter(object) : [];
    const retainedHistory =
      config.jobType === "teams_archive" && jobConfig.retainedHistory === true;
    const requiredProbes =
      config.jobType === "file_migration"
        ? jobConfig.route === "shared_drive_to_sharepoint_library"
          ? [...reverseFileProbeIds]
          : [...fileProbeIds]
        : [
            "graph_route_matrix",
            "hosted_content_bytes",
            "package_self_consistency",
            ...(jobConfig.destination !== undefined ? ["archive_destination"] : []),
            ...(retainedHistory ? ["retained_history"] : []),
            ...(jobConfig.transcripts === true ? ["transcripts"] : []),
            ...(jobConfig.attachmentBytes === true ? ["attachment_bytes"] : []),
          ];
    const failures = probeFailures({
      captures,
      requiredProbes,
      retained: {
        channel:
          retainedHistory &&
          scopes.some((scope) => scope.kind === "channel" || scope.kind === "team"),
        chat: retainedHistory && scopes.some((scope) => scope.kind === "user-chats"),
      },
    });
    if (canonicalJson([...result.requiredProbes].sort()) !== canonicalJson(requiredProbes.sort()))
      failures.push(`suite: required probes ${result.requiredProbes.join(", ")} differ`);
    for (const capture of captures) {
      const own = failures.filter((failure) => failure.startsWith(`${capture.probeId}: `));
      process.stderr.write(
        own.length
          ? own.map((failure) => `FAIL ${failure}\n`).join("")
          : `PASS ${capture.probeId}\n`,
      );
    }
    if (failures.length) throw new LiveTestBlocked("live_probe_claims_unproven", { failures });
    envelope({
      ok: true,
      value: {
        jobType: config.jobType,
        probes: captures.map((capture) => ({ id: capture.probeId, codes: capture.codes })),
        environment: { node: process.version, platform: process.platform, arch: process.arch },
      },
    });
  } catch (error) {
    const gate = controller.signal.aborted
      ? "operator_interrupted"
      : error instanceof LiveTestBlocked
        ? error.gate
        : "live_probe_or_prerequisite_failed";
    const diagnosis =
      error instanceof LiveTestBlocked
        ? error.detail
        : controller.signal.aborted
          ? undefined
          : defectDiagnosis(error);
    process.stderr.write(`FAIL ${gate}\n`);
    envelope({
      ok: false,
      refusal: {
        code: "live_test_failed",
        message: "The live test did not prove every probe; see detail.gate.",
        detail: { gate, ...(diagnosis ? { diagnosis } : {}) },
      },
    });
    process.exitCode = controller.signal.aborted ? 130 : 4;
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    if (temporary) {
      try {
        await removePrivateTree(temporary);
      } catch {
        process.exitCode = process.exitCode || 4;
      }
    }
  }
}
