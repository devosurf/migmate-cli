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
  return publishedForTuple(t, tuple, ["route_limits_and_version_gate"], ...captures);
}

function publishedForTuple(
  t: TestContext,
  tuple: Record<string, unknown>,
  requiredProbes: string[],
  ...captures: ProbeCapture[]
) {
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
      nodeVersion: "v24.21.0",
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
      requiredProbes,
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

const privateSubject = digestJson("private-conversation");
const emptyPrivateSubject = digestJson("empty-private-conversation");
const retainedChannelRoute = "/v1.0/teams/{teamId}/channels/getAllRetainedMessages";
const retainedChatRoute = "/v1.0/users/{userId}/chats/getAllRetainedMessages";

function archiveTuple(routes: string[], retainedHistory = true) {
  return {
    ...tuple,
    jobType: "teams_archive",
    source: {
      system: "microsoft_teams",
      backend: { routes, options: { retainedHistory, transcripts: false, attachmentBytes: false } },
    },
    destination: { system: "local_archive_package" },
  };
}

function retainedCapture(observations: Record<string, unknown> = {}): ProbeCapture {
  return capture("retained_history", {
    observations: {
      privateChannels: [privateSubject, emptyPrivateSubject].sort(),
      privateRetainedSamples: [{ subject: privateSubject, records: 1 }],
      records: 1,
      collectionDigest: digestJson(["retained-record"]),
      paging: [
        {
          scopeKind: "channel",
          conversationSubjects: [privateSubject],
          route: "retained",
          pages: 2,
          continuationPages: 1,
          records: 1,
          exhausted: true,
        },
        {
          scopeKind: "channel",
          conversationSubjects: [emptyPrivateSubject],
          route: "retained",
          pages: 1,
          continuationPages: 0,
          records: 0,
          exhausted: true,
        },
      ],
      ...observations,
    },
  });
}

describe("retained channel bundle proof", () => {
  it("accepts a collected private sample alongside an exhaustively paged empty private scope", async (t) => {
    const { root, input } = publishedForTuple(
      t, archiveTuple([retainedChannelRoute]), ["retained_history"],
      capture("desktop_runtime"), retainedCapture(),
    );
    assert.deepEqual(await validateCapturedBundle(root, input), {
      digest: input.digest, tuple: input.tuple, bundle: input.bundle,
    });
  });

  it("refuses old omission-only captures", async (t) => {
    const { root, input } = publishedForTuple(
      t, archiveTuple([retainedChannelRoute]), ["retained_history"],
      capture("desktop_runtime"),
      capture("retained_history", {
        codes: ["retained_history_unsupported_private_channel"],
        assertions: [{
          id: "private_channel_omission_coverage",
          expected: [privateSubject],
          observed: [privateSubject],
        }],
        observations: {
          privateChannels: [privateSubject],
          privateChannelOmissions: [privateSubject],
          records: 1,
        },
      }),
    );
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });

  for (const [name, observations] of [
    ["no collected private samples", { privateRetainedSamples: [] }],
    ["only empty private samples", {
      privateRetainedSamples: [{ subject: privateSubject, records: 0 }],
    }],
    ["standard-only scope metadata", { privateChannels: [] }],
    ["samples outside the frozen private subjects", {
      privateRetainedSamples: [{ subject: digestJson("other-conversation"), records: 1 }],
    }],
    ["raw private identifiers", {
      privateChannels: ["private-conversation"],
      privateRetainedSamples: [{ subject: "private-conversation", records: 1 }],
    }],
    ["a collected count larger than the retained collection", {
      privateRetainedSamples: [{ subject: privateSubject, records: 2 }],
    }],
    ["no paging for the empty private conversation", {
      paging: [{
        scopeKind: "channel", conversationSubjects: [privateSubject], route: "retained",
        pages: 1, continuationPages: 0, records: 1, exhausted: true,
      }],
    }],
    ["unexhausted retained paging", {
      paging: [{
        scopeKind: "channel", conversationSubjects: [privateSubject, emptyPrivateSubject],
        route: "retained", pages: 1, continuationPages: 0, records: 1, exhausted: false,
      }],
    }],
    ["no retained records in the private sample's paging", {
      paging: [{
        scopeKind: "channel", conversationSubjects: [privateSubject, emptyPrivateSubject],
        route: "retained", pages: 1, continuationPages: 0, records: 0, exhausted: true,
      }],
    }],
  ] satisfies [string, Record<string, unknown>][]) {
    it(`refuses ${name}`, async (t) => {
      const { root, input } = publishedForTuple(
        t, archiveTuple([retainedChannelRoute]), ["retained_history"],
        capture("desktop_runtime"), retainedCapture(observations),
      );
      await assert.rejects(validateCapturedBundle(root, input), Error);
    });
  }

  it("still requires a chat sample for a combined channel/chat retained tuple", async (t) => {
    const { root, input } = publishedForTuple(
      t, archiveTuple([retainedChannelRoute, retainedChatRoute]), ["retained_history"],
      capture("desktop_runtime"), retainedCapture(),
    );
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });

  it("requires the retained probe even if the caller omits it from required probes", async (t) => {
    const { root, input } = publishedForTuple(
      t, archiveTuple([retainedChannelRoute]), ["graph_route_matrix"],
      capture("desktop_runtime"), capture("graph_route_matrix"),
    );
    await assert.rejects(validateCapturedBundle(root, input), Error);
  });

  it("preserves chat-only retained bundles without private channel proof", async (t) => {
    const { root, input } = publishedForTuple(
      t, archiveTuple([retainedChatRoute]), ["retained_history"],
      capture("desktop_runtime"), capture("retained_history", { observations: { records: 1 } }),
    );
    assert.deepEqual(await validateCapturedBundle(root, input), {
      digest: input.digest, tuple: input.tuple, bundle: input.bundle,
    });
  });

  it("preserves base bundles without retained proof", async (t) => {
    const { root, input } = publishedForTuple(
      t, archiveTuple(["/v1.0/teams/{teamId}/channels/getAllMessages"], false), ["graph_route_matrix"],
      capture("desktop_runtime"), capture("graph_route_matrix"),
    );
    assert.deepEqual(await validateCapturedBundle(root, input), {
      digest: input.digest, tuple: input.tuple, bundle: input.bundle,
    });
  });
});
