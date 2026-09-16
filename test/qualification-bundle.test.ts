import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { canonicalJson, digestJson } from "../src/engine/store/digest.ts";
import {
  validateCapturedBundle,
  type EvidenceBundle,
  type ProbeCapture,
} from "../src/qualification/bundle.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../vendor/rclone/manifest.json", import.meta.url), "utf8"),
) as { version: string; binaries: Record<string, { sha256: string }> };
const desktopCell = "linux-x64";
const tuple = {
  jobType: "file_migration",
  source: { system: "sharepoint_document_library" },
  destination: { system: "google_shared_drive" },
  transferVersion: manifest.version,
  guaranteeSetId: "default",
  desktopCell,
};
const census = {
  scope: "mapping_source_root_children",
  itemsScanned: 4,
  kinds: { file: 2, folder: 2, package: 0, reference: 0, undownloadable: 0 },
};

function capture(probeId: string, overrides: Partial<ProbeCapture> = {}): ProbeCapture {
  return {
    schemaVersion: 1,
    probeId,
    startedAt: "2026-09-16T10:00:00.000Z",
    completedAt: "2026-09-16T10:05:00.000Z",
    codes: [],
    assertions: [{ id: "probe_ran", expected: true, observed: true }],
    observations: {},
    ...overrides,
  };
}
/** The proven route probe: a supplied package sample, a refused reference create, and an absent undownloadable kind. */
function routeCapture(
  observations: Record<string, unknown> = {},
  assertions: ProbeCapture["assertions"] = [
    { id: "package_omission", expected: true, observed: true },
  ],
): ProbeCapture {
  return capture("route_limits_and_version_gate", {
    assertions: [{ id: "probe_ran", expected: true, observed: true }, ...assertions],
    observations: {
      capabilityProofs: {
        package: "live_source_entry",
        reference: "source_refuses_creation",
        undownloadable: "absent_from_source_scope",
      },
      sourceKindCensus: census,
      sourceRefusedReferenceStatus: 400,
      ...observations,
    },
  });
}

function published(t: TestContext, ...captures: ProbeCapture[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "migmate-bundle-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = captures
    .map((value) => {
      const bytes = Buffer.from(`${canonicalJson(value)}\n`);
      return {
        path: `captures/${value.probeId}.json`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        bytes,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const bundle: EvidenceBundle = {
    schemaVersion: 1,
    tuple,
    capture: {
      suiteVersion: 1,
      capturedAt: "2026-09-16T10:06:00.000Z",
      nodeVersion: "v24.8.0",
      osRelease: "6.8.0",
      desktopCell,
      toolSha256: createHash("sha256").update("tool").digest("hex"),
      binarySha256: manifest.binaries[desktopCell]!.sha256,
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
  const path = `qualification/${digestJson(tuple)}/${digest}`;
  const directory = join(root, path);
  mkdirSync(join(directory, "captures"), { recursive: true });
  for (const artifact of artifacts) writeFileSync(join(directory, artifact.path), artifact.bytes);
  writeFileSync(join(directory, "bundle.json"), `${canonicalJson(bundle)}\n`);
  return {
    root,
    input: {
      bundle: path,
      digest,
      tuple,
      requiredProbes: ["route_limits_and_version_gate"],
    },
  };
}

describe("captured bundle validation", () => {
  it("accepts a route probe whose capability proofs each carry their evidence", async (t) => {
    const { root, input } = published(t, capture("desktop_runtime"), routeCapture());
    assert.deepEqual(await validateCapturedBundle(root, input), {
      digest: input.digest,
      tuple: input.tuple,
      bundle: input.bundle,
    });
  });

  it("accepts a bundle reached through a symlinked ancestor, as every real publish is", async (t) => {
    // A maintainer publishes with --output under a temporary directory, and on macOS
    // /tmp resolves to /private/tmp and $TMPDIR to /private/var/folders/..., so the
    // package directory the runner hands the validator is almost never its own
    // realpath. published() calls realpathSync, which hid this from every other case.
    const { root, input } = published(t, capture("desktop_runtime"), routeCapture());
    const parent = mkdtempSync(join(tmpdir(), "migmate-symlinked-"));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const link = join(parent, "link");
    symlinkSync(root, link);
    assert.deepEqual(await validateCapturedBundle(link, input), {
      digest: input.digest,
      tuple: input.tuple,
      bundle: input.bundle,
    });
  });

  it("refuses an absent-from-scope claim with no kind census", async (t) => {
    const { root, input } = published(
      t,
      capture("desktop_runtime"),
      routeCapture({ sourceKindCensus: undefined }),
    );
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });

  it("refuses an absent-from-scope claim the census contradicts", async (t) => {
    const { root, input } = published(
      t,
      capture("desktop_runtime"),
      routeCapture({
        sourceKindCensus: { ...census, kinds: { ...census.kinds, undownloadable: 1 } },
      }),
    );
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });

  it("refuses a creation-refusal claim without a live 400", async (t) => {
    const { root, input } = published(
      t,
      capture("desktop_runtime"),
      routeCapture({ sourceRefusedReferenceStatus: 403 }),
    );
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });

  it("refuses a proof value outside the three", async (t) => {
    const { root, input } = published(
      t,
      capture("desktop_runtime"),
      routeCapture({
        capabilityProofs: {
          package: "live_source_entry",
          reference: "source_refuses_creation",
          undownloadable: "operator_asserted",
        },
      }),
    );
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });

  it("refuses a capability carrying no proof value", async (t) => {
    const { root, input } = published(
      t,
      capture("desktop_runtime"),
      routeCapture({
        capabilityProofs: {
          package: "live_source_entry",
          reference: "source_refuses_creation",
        },
      }),
    );
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });

  it("refuses a live-source-entry claim without the observed omission", async (t) => {
    const { root, input } = published(t, capture("desktop_runtime"), routeCapture({}, []));
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });

  it("refuses an absence claim from a kind the source can hold on demand", async (t) => {
    const { root, input } = published(
      t,
      capture("desktop_runtime"),
      routeCapture({
        capabilityProofs: {
          package: "absent_from_source_scope",
          reference: "source_refuses_creation",
          undownloadable: "absent_from_source_scope",
        },
      }),
    );
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });

  it("refuses a kind resting on another kind's weaker proof", async (t) => {
    const { root, input } = published(
      t,
      capture("desktop_runtime"),
      routeCapture({
        capabilityProofs: {
          package: "live_source_entry",
          reference: "source_refuses_creation",
          undownloadable: "source_refuses_creation",
        },
      }),
    );
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });
});
