import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, digestJson } from "../engine/store/digest.ts";

export const desktopCells = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
export const fileProbeIds = [
  "zero_byte_and_empty_folder_copy",
  "stable_id_additive_rerun_and_move",
  "metadata_round_trip",
  "provenance_marker_round_trip",
  "checksum_fresh_upload",
  "collision_matrix",
  "route_limits_and_version_gate",
] as const;
export const collisionCodes = [
  "destination_duplicate_name",
  "destination_type_conflict",
  "unowned_path_collision",
  "prior_copy_drift",
  "source_identity_reuse_collision",
  "path_unrepresentable",
  "mapping_overlap",
] as const;

export interface ProbeCapture {
  schemaVersion: 1;
  probeId: string;
  startedAt: string;
  completedAt: string;
  codes: string[];
  assertions: { id: string; expected: unknown; observed: unknown }[];
  observations: Record<string, unknown>;
}
export interface EvidenceBundle {
  schemaVersion: 1;
  tuple: Record<string, unknown>;
  capture: {
    suiteVersion: 1;
    capturedAt: string;
    nodeVersion: string;
    osRelease: string;
    desktopCell: string;
    toolSha256: string;
    binarySha256: string;
  };
  probes: { id: string; expectedCodes: string[]; observedCodes: string[]; output: string }[];
  artifacts: { path: string; sha256: string; size: number }[];
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-z][a-z0-9_]{0,127}$/;
const safeMessage =
  "Qualified-route evidence is absent, invalid, incomplete, or does not match this exact route.";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireFact(condition: unknown): asserts condition {
  if (!condition) throw new Error(safeMessage);
}
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length
  );
}
function timestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function confined(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
async function regularFile(root: string, path: string): Promise<Buffer> {
  requireFact(
    !isAbsolute(path) &&
      path.split(/[\\/]/).every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  );
  const absolute = resolve(root, path);
  requireFact(confined(root, absolute));
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    requireFact(!(await lstat(current)).isSymbolicLink());
  }
  const stat = await lstat(absolute);
  requireFact(
    stat.isFile() && stat.size <= 16 * 1024 * 1024 && confined(root, await realpath(absolute)),
  );
  return readFile(absolute);
}
async function allFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    requireFact(!entry.isSymbolicLink());
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await allFiles(root, path)));
    else {
      requireFact(entry.isFile());
      files.push(path);
    }
    requireFact(files.length <= 1024);
  }
  return files.sort();
}

export interface QualifiedBundleInput {
  bundle: string;
  digest: string;
  tuple: Record<string, unknown>;
  requiredProbes: string[];
}

/** Production is confined to the installed artifact, never an operator-selected evidence root. */
export async function readQualifiedBundle(
  input: QualifiedBundleInput,
): Promise<{ digest: string; tuple: Record<string, unknown>; bundle: string }> {
  return validateCapturedBundle(packageRoot, input);
}

/** Maintainer capture uses the identical validator before publishing a new immutable directory. */
export async function validateCapturedBundle(
  packageDirectory: string,
  input: QualifiedBundleInput,
): Promise<{ digest: string; tuple: Record<string, unknown>; bundle: string }> {
  try {
    requireFact(hashPattern.test(input.digest));
    const tupleDigest = digestJson(input.tuple);
    requireFact(input.bundle === `qualification/${tupleDigest}/${input.digest}`);
    const qualificationRoot = join(packageDirectory, "qualification");
    requireFact(!(await lstat(qualificationRoot)).isSymbolicLink());
    const root = resolve(packageDirectory, input.bundle);
    requireFact(confined(qualificationRoot, root));
    for (const path of [join(qualificationRoot, tupleDigest), root]) {
      const stat = await lstat(path);
      requireFact(stat.isDirectory() && !stat.isSymbolicLink());
    }
    requireFact(confined(await realpath(qualificationRoot), await realpath(root)));
    const bundle: unknown = JSON.parse((await regularFile(root, "bundle.json")).toString("utf8"));
    requireFact(record(bundle) && bundle.schemaVersion === 1 && record(bundle.tuple));
    requireFact(canonicalJson(bundle.tuple) === canonicalJson(input.tuple));
    const tuple = bundle.tuple;
    requireFact(
      tuple.transferVersion === "v1.75.0" &&
        desktopCells.some((cell) => cell === tuple.desktopCell),
    );
    requireFact(typeof tuple.guaranteeSetId === "string" && tuple.guaranteeSetId.length > 0);
    requireFact(
      record(bundle.capture) &&
        bundle.capture.suiteVersion === 1 &&
        timestamp(bundle.capture.capturedAt),
    );
    requireFact(
      bundle.capture.desktopCell === bundle.tuple.desktopCell &&
        typeof bundle.capture.nodeVersion === "string" &&
        /^v24\./.test(bundle.capture.nodeVersion),
    );
    const vendor: unknown = JSON.parse(
      await readFile(join(packageRoot, "vendor/rclone/manifest.json"), "utf8"),
    );
    requireFact(
      record(vendor) &&
        vendor.schemaVersion === 1 &&
        vendor.version === tuple.transferVersion &&
        record(vendor.binaries),
    );
    const binary = vendor.binaries[String(tuple.desktopCell)];
    requireFact(record(binary) && binary.sha256 === bundle.capture.binarySha256);
    requireFact(
      typeof bundle.capture.osRelease === "string" && bundle.capture.osRelease.length > 0,
    );
    if (String(tuple.desktopCell).startsWith("darwin-")) {
      const osVersion = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(bundle.capture.osRelease);
      requireFact(
        osVersion &&
          (Number(osVersion[1]) > 13 || (Number(osVersion[1]) === 13 && Number(osVersion[2]) >= 5)),
      );
    }
    requireFact(
      typeof bundle.capture.toolSha256 === "string" && hashPattern.test(bundle.capture.toolSha256),
    );
    requireFact(
      typeof bundle.capture.binarySha256 === "string" &&
        hashPattern.test(bundle.capture.binarySha256),
    );
    requireFact(
      Array.isArray(bundle.artifacts) &&
        bundle.artifacts.length > 0 &&
        bundle.artifacts.length <= 1024,
    );
    const artifacts = new Map<string, Buffer>();
    for (const artifact of bundle.artifacts) {
      requireFact(
        record(artifact) &&
          typeof artifact.path === "string" &&
          /^captures\/[a-z][a-z0-9_]*\.json$/.test(artifact.path),
      );
      requireFact(
        typeof artifact.sha256 === "string" &&
          hashPattern.test(artifact.sha256) &&
          Number.isSafeInteger(artifact.size),
      );
      requireFact(!artifacts.has(artifact.path));
      const bytes = await regularFile(root, artifact.path);
      requireFact(
        bytes.length === artifact.size &&
          createHash("sha256").update(bytes).digest("hex") === artifact.sha256,
      );
      artifacts.set(artifact.path, bytes);
    }
    requireFact(
      canonicalJson(await allFiles(root)) ===
        canonicalJson(["bundle.json", ...artifacts.keys()].sort()),
    );
    requireFact(Array.isArray(bundle.probes) && bundle.probes.length > 0);
    const probes = new Set<string>();
    const usedArtifacts = new Set<string>();
    for (const probe of bundle.probes) {
      requireFact(
        record(probe) &&
          typeof probe.id === "string" &&
          idPattern.test(probe.id) &&
          !probes.has(probe.id),
      );
      requireFact(strings(probe.expectedCodes) && strings(probe.observedCodes));
      requireFact(
        canonicalJson([...probe.expectedCodes].sort()) ===
          canonicalJson([...probe.observedCodes].sort()),
      );
      requireFact(
        typeof probe.output === "string" &&
          artifacts.has(probe.output) &&
          !usedArtifacts.has(probe.output),
      );
      const captured: unknown = JSON.parse(artifacts.get(probe.output)!.toString("utf8"));
      requireFact(
        record(captured) && captured.schemaVersion === 1 && captured.probeId === probe.id,
      );
      requireFact(
        timestamp(captured.startedAt) &&
          timestamp(captured.completedAt) &&
          String(captured.startedAt) <= String(captured.completedAt),
      );
      requireFact(
        strings(captured.codes) &&
          canonicalJson([...captured.codes].sort()) ===
            canonicalJson([...probe.expectedCodes].sort()),
      );
      requireFact(
        record(captured.observations) &&
          Array.isArray(captured.assertions) &&
          captured.assertions.length > 0,
      );
      const assertions = new Set<string>();
      for (const assertion of captured.assertions) {
        requireFact(
          record(assertion) &&
            typeof assertion.id === "string" &&
            idPattern.test(assertion.id) &&
            !assertions.has(assertion.id),
        );
        requireFact(Object.hasOwn(assertion, "expected") && Object.hasOwn(assertion, "observed"));
        requireFact(canonicalJson(assertion.expected) === canonicalJson(assertion.observed));
        assertions.add(assertion.id);
      }
      const expectedCodes = probe.expectedCodes;
      if (probe.id === "collision_matrix") {
        requireFact(collisionCodes.every((code) => expectedCodes.includes(code)));
        requireFact(captured.observations.sourcePathProof === "live_source_entry");
        requireFact(
          captured.assertions.some(
            (assertion: unknown) =>
              record(assertion) &&
              assertion.id === "live_source_path_refusal" &&
              assertion.expected === "path_unrepresentable" &&
              assertion.observed === "path_unrepresentable",
          ),
        );
      }
      probes.add(probe.id);
      usedArtifacts.add(probe.output);
    }
    requireFact(
      usedArtifacts.size === artifacts.size &&
        probes.has("desktop_runtime") &&
        input.requiredProbes.length > 0 &&
        input.requiredProbes.every((id) => probes.has(id)),
    );
    requireFact(digestJson(bundle) === input.digest);
    return { digest: input.digest, tuple: input.tuple, bundle: input.bundle };
  } catch {
    throw new Error(safeMessage);
  }
}
