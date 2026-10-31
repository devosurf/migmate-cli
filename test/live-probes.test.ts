import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { digestJson } from "../src/engine/store/digest.ts";
import { probeFailures, type ProbeCapture } from "../scripts/live/probes.ts";
import { fixtureConfig } from "../scripts/live/file-fixtures.ts";
import { LiveTestBlocked } from "../scripts/live/common.ts";
import {
  dropboxHashMatch,
  dropboxProbeConfig,
  runDropboxFileLiveTest,
} from "../scripts/live/file-dropbox.ts";
import { dropboxFileProbeIds } from "../scripts/live/probes.ts";

const census = {
  scope: "capability_source_root_children",
  roots: [digestJson("package-root"), digestJson("source-root")].sort(),
  itemsScanned: 5,
  kinds: { file: 2, folder: 2, package: 1, reference: 0, undownloadable: 0 },
};
const noRetained = { channel: false, chat: false };

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
    { id: "package_source_entry", expected: true, observed: true },
    { id: "package_map_only_plan", expected: true, observed: true },
    { id: "package_copy_completed", expected: "completed", observed: "completed" },
    { id: "package_listing_verification_clean", expected: true, observed: true },
    { id: "package_sections_copied", expected: true, observed: true },
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
      capabilitySamples: {
        package: {
          sourceRoot: digestJson("package-root"),
          sourceItem: digestJson("package-item"),
          verifiedFiles: 1,
        },
      },
      sourceRefusedReferenceStatus: 400,
      ...observations,
    },
  });
}
function routeFailures(route: ProbeCapture): string[] {
  return probeFailures({
    captures: [route],
    requiredProbes: ["route_limits_and_version_gate"],
    retained: noRetained,
  });
}

describe("live file probe verdict", () => {
  it("passes a route probe whose capability proofs each carry their evidence", () => {
    assert.deepEqual(routeFailures(routeCapture()), []);
  });

  it("rejects an old omission-only capture even when every old assertion passes", () => {
    assert.ok(
      routeFailures(routeCapture({}, [{ id: "package_omission", expected: true, observed: true }]))
        .length > 0,
    );
  });

  for (const id of [
    "package_source_entry",
    "package_map_only_plan",
    "package_copy_completed",
    "package_listing_verification_clean",
    "package_sections_copied",
  ]) {
    it(`requires live map/copy/listing evidence: ${id}`, () => {
      const route = routeCapture();
      route.assertions = route.assertions.filter((assertion) => assertion.id !== id);
      assert.ok(routeFailures(route).length > 0);
    });
  }

  it("does not call an empty notebook listing a copied package sample", () => {
    assert.ok(
      routeFailures(
        routeCapture({
          capabilitySamples: {
            package: {
              sourceRoot: digestJson("package-root"),
              sourceItem: digestJson("package-item"),
              verifiedFiles: 0,
            },
          },
        }),
      ).length > 0,
    );
  });

  it("fails an assertion whose observed value differs", () => {
    const route = routeCapture();
    const assertion = route.assertions.find((item) => item.id === "package_source_entry")!;
    assertion.observed = false;
    assert.ok(
      routeFailures(route).includes(
        "route_limits_and_version_gate: assertion package_source_entry observed a different value",
      ),
    );
  });

  it("fails a required probe that never ran", () => {
    const failures = probeFailures({
      captures: [routeCapture()],
      requiredProbes: ["route_limits_and_version_gate", "collision_matrix"],
      retained: noRetained,
    });
    assert.deepEqual(failures, ["collision_matrix: probe did not run"]);
  });

  for (const [name, route] of [
    [
      "an absent-from-scope claim with no kind census",
      routeCapture({ sourceKindCensus: undefined }),
    ],
    [
      "an absent-from-scope claim the census contradicts",
      routeCapture({
        sourceKindCensus: { ...census, kinds: { ...census.kinds, undownloadable: 1 } },
      }),
    ],
    [
      "a creation-refusal claim without a live 400",
      routeCapture({ sourceRefusedReferenceStatus: 403 }),
    ],
    [
      "a proof value outside the three",
      routeCapture({
        capabilityProofs: {
          package: "live_source_entry",
          reference: "source_refuses_creation",
          undownloadable: "operator_asserted",
        },
      }),
    ],
    [
      "a capability carrying no proof value",
      routeCapture({
        capabilityProofs: { package: "live_source_entry", reference: "source_refuses_creation" },
      }),
    ],
    ["a live-source-entry claim without observed sample evidence", routeCapture({}, [])],
    [
      "an absence claim from a kind the source can hold on demand",
      routeCapture({
        capabilityProofs: {
          package: "absent_from_source_scope",
          reference: "source_refuses_creation",
          undownloadable: "absent_from_source_scope",
        },
      }),
    ],
    [
      "a kind resting on another kind's weaker proof",
      routeCapture({
        capabilityProofs: {
          package: "live_source_entry",
          reference: "source_refuses_creation",
          undownloadable: "source_refuses_creation",
        },
      }),
    ],
  ] satisfies [string, ProbeCapture][]) {
    it(`fails ${name}`, () => {
      const failures = routeFailures(route);
      assert.ok(failures.length > 0);
      assert.ok(failures.every((failure) => failure.startsWith("route_limits_and_version_gate: ")));
    });
  }
});

describe("live capability fixture configuration", () => {
  const mapping = {
    id: "live",
    sourceDriveId: "source-drive",
    sourceItemId: "source-root",
    destDriveId: "destination-drive",
    destFolderId: "destination-root",
  };
  const fixtures = {
    disposableRoots: { ...mapping, acknowledged: true },
    graphMutation: {
      tenantId: "11111111-1111-1111-1111-111111111111",
      clientId: "22222222-2222-2222-2222-222222222222",
      clientSecret: { resolver: "file", path: "/private/mutator-secret" },
    },
  };

  it("refuses old direct-child sample IDs instead of treating them as folder roots", () => {
    assert.throws(
      () => fixtureConfig({ ...fixtures, specialSources: { packageId: "notebook" } }, mapping),
      (error: unknown) =>
        error instanceof LiveTestBlocked &&
        error.gate === "file_special_sources_removed_use_capability_roots",
    );
  });

  it("retains explicit isolated folder roots and their real sample identities", () => {
    const capabilityRoots = {
      package: { sourceItemId: "package-root", sampleItemId: "notebook" },
    };
    assert.deepEqual(fixtureConfig({ ...fixtures, capabilityRoots }, mapping), {
      disposableRoots: {
        sourceDriveId: "source-drive",
        sourceItemId: "source-root",
        destDriveId: "destination-drive",
        destFolderId: "destination-root",
        acknowledged: true,
      },
      graphMutation: {
        ...fixtures.graphMutation,
        clientSecret: { ...fixtures.graphMutation.clientSecret, mode: "0600" },
      },
      capabilityRoots,
    });
  });
});

const privateSubject = digestJson("private-conversation");
const emptyPrivateSubject = digestJson("empty-private-conversation");

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
function retainedFailures(
  retained: ProbeCapture,
  scope = { channel: true, chat: false },
  requiredProbes = ["retained_history"],
): string[] {
  return probeFailures({ captures: [retained], requiredProbes, retained: scope });
}

describe("live retained channel verdict", () => {
  it("passes a collected private sample alongside an exhaustively paged empty private scope", () => {
    assert.deepEqual(retainedFailures(retainedCapture()), []);
  });

  it("fails an omission-only capture", () => {
    const failures = retainedFailures(
      capture("retained_history", {
        codes: ["retained_history_unsupported_private_channel"],
        observations: {
          privateChannels: [privateSubject],
          privateChannelOmissions: [privateSubject],
          records: 1,
        },
      }),
    );
    assert.ok(failures.length > 0);
  });

  for (const [name, observations] of [
    ["no collected private samples", { privateRetainedSamples: [] }],
    [
      "only empty private samples",
      { privateRetainedSamples: [{ subject: privateSubject, records: 0 }] },
    ],
    ["standard-only scope metadata", { privateChannels: [] }],
    [
      "samples outside the frozen private subjects",
      { privateRetainedSamples: [{ subject: digestJson("other-conversation"), records: 1 }] },
    ],
    [
      "raw private identifiers",
      {
        privateChannels: ["private-conversation"],
        privateRetainedSamples: [{ subject: "private-conversation", records: 1 }],
      },
    ],
    [
      "a collected count larger than the retained collection",
      { privateRetainedSamples: [{ subject: privateSubject, records: 2 }] },
    ],
    [
      "no paging for the empty private conversation",
      {
        paging: [
          {
            scopeKind: "channel",
            conversationSubjects: [privateSubject],
            route: "retained",
            pages: 1,
            continuationPages: 0,
            records: 1,
            exhausted: true,
          },
        ],
      },
    ],
    [
      "unexhausted retained paging",
      {
        paging: [
          {
            scopeKind: "channel",
            conversationSubjects: [privateSubject, emptyPrivateSubject],
            route: "retained",
            pages: 1,
            continuationPages: 0,
            records: 1,
            exhausted: false,
          },
        ],
      },
    ],
    [
      "no retained records in the private sample's paging",
      {
        paging: [
          {
            scopeKind: "channel",
            conversationSubjects: [privateSubject, emptyPrivateSubject],
            route: "retained",
            pages: 1,
            continuationPages: 0,
            records: 0,
            exhausted: true,
          },
        ],
      },
    ],
  ] satisfies [string, Record<string, unknown>][]) {
    it(`fails ${name}`, () => {
      const failures = retainedFailures(retainedCapture(observations));
      assert.ok(failures.length > 0);
      assert.ok(failures.every((failure) => failure.startsWith("retained_history: ")));
    });
  }

  it("still requires a chat sample when channel and chat history are both retained", () => {
    assert.ok(retainedFailures(retainedCapture(), { channel: true, chat: true }).length > 0);
  });

  it("requires the retained probe even if the caller omits it from required probes", () => {
    const failures = probeFailures({
      captures: [capture("graph_route_matrix")],
      requiredProbes: ["graph_route_matrix"],
      retained: { channel: true, chat: false },
    });
    assert.deepEqual(failures, ["retained_history: probe did not run"]);
  });

  it("passes chat-only retained history without private channel proof", () => {
    const failures = retainedFailures(
      capture("retained_history", { observations: { records: 1 } }),
      { channel: false, chat: true },
    );
    assert.deepEqual(failures, []);
  });
});

describe("Dropbox optional live probe configuration and verdict", () => {
  const config = {
    jobConfig: {
      sourceProvider: "dropbox",
      destinationProvider: "google_shared_drive",
      rclone: {
        config: { resolver: "file", path: "/private/rclone.conf" },
        sourceRemote: "dropbox",
        destinationRemote: "drive",
      },
    },
    dropboxProbe: {
      adminMemberId: "dbmid:admin",
      namespaceId: "123",
      destDriveId: "drive",
      destFolderId: "folder",
      filePath: "fixtures/file.bin",
      paperPath: "fixtures/note.paper",
    },
  };
  async function invocationHarness(
    t: TestContext,
    options: {
      paperPath?: string;
      paperEntries?: Record<string, unknown>[];
      destinationMode?: "duplicate" | "missing_id" | "cleanup_duplicate" | "cleanup_changed";
      corruptHash?: boolean;
    } = {},
  ) {
    const directory = await mkdtemp(join(tmpdir(), "dropbox-probe-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const configPath = join(directory, "fixture.conf");
    await writeFile(configPath, "[dropbox]\ntype = dropbox\n[drive]\ntype = drive\n");
    const calls: string[][] = [];
    const captures: ProbeCapture[] = [];
    const paperPath = options.paperPath ?? config.dropboxProbe.paperPath;
    const paperName = paperPath.split("/").at(-1)!;
    const paperParent = paperPath.split("/").slice(0, -1).join("/");
    const destination = "drive,team_drive=drive,root_folder_id=folder:";
    const bytes = Buffer.from("<html>existing Paper sample</html>");
    let root = "";
    let parentLookups = 0;
    let closed = false;
    const invoke = () =>
      runDropboxFileLiveTest(
        {
          config: {
            ...config,
            jobConfig: {
              ...config.jobConfig,
              rclone: {
                ...config.jobConfig.rclone,
                config: { resolver: "file", path: configPath },
              },
            },
            dropboxProbe: { ...config.dropboxProbe, paperPath },
          },
          jobDirectory: directory,
          signal: new AbortController().signal,
          capture: (value) => captures.push(value),
        },
        {
          createSupervisor: () => ({
            proveBinary: async () => ({
              path: "/offline/rclone",
              version: "v1.75.0",
              sha256: "a".repeat(64),
              provenance: "offline invocation fixture",
              versionJson: { version: "v1.75.0" },
            }),
            close: async () => {
              closed = true;
            },
          }),
          spawn: (binary, args, spawnOptions) => {
            assert.equal(binary, "/offline/rclone");
            assert.deepEqual(spawnOptions.stdio, ["ignore", "pipe", "ignore"]);
            const configIndex = args.indexOf("--config");
            assert.deepEqual(args.slice(configIndex), [
              "--config",
              join(directory, "dropbox-rclone.conf"),
              "--ask-password=false",
              "--log-level",
              "ERROR",
            ]);
            const command = args.slice(0, configIndex);
            calls.push(command);
            const [verb, target] = command;
            assert.ok(target);
            let output: unknown;
            if (verb === "config") {
              assert.equal(target, "dump");
              output = { dropbox: { type: "dropbox" }, drive: { type: "drive" } };
            } else if (verb === "mkdir") {
              assert.ok(target.startsWith(destination + "migmate-live-"));
              root = target.slice(destination.length);
              output = "";
            } else if (verb === "lsjson" && target === destination) {
              assert.deepEqual(command, ["lsjson", destination]);
              parentLookups++;
              const folder = {
                Name: root,
                Path: root,
                IsDir: true,
                ID:
                  options.destinationMode === "missing_id"
                    ? undefined
                    : options.destinationMode === "cleanup_changed" && parentLookups > 1
                      ? "replacement-id"
                      : "created-folder-id",
              };
              output = [
                { Name: root + "-other", IsDir: true, ID: "unrelated-id" },
                folder,
                ...(options.destinationMode === "duplicate" ||
                (options.destinationMode === "cleanup_duplicate" && parentLookups > 1)
                  ? [{ ...folder, ID: "duplicate-id" }]
                  : []),
              ];
            } else if (verb === "lsjson" && target.includes("show_all_exports=true")) {
              assert.equal(target.slice(target.lastIndexOf(":") + 1), paperParent);
              assert.equal(command.length, 2, "original Paper must use a parent listing, not stat");
              output = options.paperEntries ?? [
                { Name: "unrelated.paper", IsDir: false, Size: -1 },
                { Name: paperName, Path: paperName, IsDir: false, Size: -1 },
                { Name: paperName.replace(/\.paper$/, ".html"), IsDir: false, Size: -1 },
              ];
            } else if (verb === "lsjson" && target.startsWith("dropbox,")) {
              assert.deepEqual(command.slice(2), ["--stat"]);
              assert.ok(target.endsWith("file.bin") || target.endsWith(".html"));
              output = { IsDir: false, Size: target.endsWith(".html") ? -1 : bytes.length };
            } else if (verb === "lsjson" && target.startsWith(destination)) {
              assert.deepEqual(command.slice(2), ["--stat", "--hash"]);
              assert.ok(
                target === `${destination}${root}/ordinary.bin` ||
                  target === `${destination}${root}/paper.html`,
              );
              output = {
                Name: target.split("/").at(-1),
                Size: bytes.length,
                Hashes: {
                  "SHA-256": options.corruptHash
                    ? "0".repeat(64)
                    : createHash("sha256").update(bytes).digest("hex"),
                },
              };
            } else if (verb === "copyto") {
              assert.ok(target.startsWith("dropbox,"));
              assert.ok(command[2]?.startsWith(`${destination}${root}/`));
              output = "";
            } else if (verb === "cat") {
              assert.ok(target.startsWith("dropbox,"));
              output = bytes;
            } else if (verb === "purge") {
              assert.equal(target, destination + root);
              output = "";
            } else {
              assert.fail(`Unexpected offline invocation: ${command.join(" ")}`);
            }
            const child = Object.assign(new ChildProcess(), { stdout: new PassThrough() });
            queueMicrotask(() => {
              child.stdout.end(Buffer.isBuffer(output) ? output : JSON.stringify(output));
              child.emit("close", 0);
            });
            return child;
          },
        },
      );
    return { invoke, calls, captures, closed: () => closed, parentLookups: () => parentLookups };
  }

  for (const paperPath of ["fixtures/note.paper", "note.paper"]) {
    it(`copies and hashes a real-shaped non-downloadable sample at ${paperPath}`, async (t) => {
      const h = await invocationHarness(t, { paperPath });
      assert.deepEqual(await h.invoke(), { requiredProbes: [...dropboxFileProbeIds] });
      assert.equal(h.calls.filter(([verb]) => verb === "copyto").length, 2);
      assert.equal(h.calls.filter(([verb]) => verb === "cat").length, 2);
      assert.equal(h.parentLookups(), 2);
      assert.equal(h.calls.at(-1)?.[0], "purge");
      assert.equal(h.closed(), true);
      assert.deepEqual(
        probeFailures({
          captures: h.captures,
          requiredProbes: dropboxFileProbeIds,
          retained: noRetained,
        }),
        [],
      );
    });
  }

  for (const paperEntries of [
    [],
    [
      { Name: "note.paper", IsDir: false, Size: -1 },
      { Name: "note.paper", IsDir: false, Size: -1 },
    ],
    [{ Name: "note.paper", IsDir: true, Size: -1 }],
    [{ Name: "note.paper", IsDir: false, Size: 12 }],
  ]) {
    it(`refuses missing, ambiguous, or invalid original metadata ${JSON.stringify(paperEntries)}`, async (t) => {
      const h = await invocationHarness(t, { paperEntries });
      await assert.rejects(h.invoke(), LiveTestBlocked);
      assert.ok(h.calls.every(([verb]) => verb !== "mkdir" && verb !== "copyto"));
      assert.equal(h.closed(), true);
    });
  }

  for (const destinationMode of [
    "duplicate",
    "missing_id",
    "cleanup_duplicate",
    "cleanup_changed",
  ] as const) {
    it(`refuses unsafe destination identity: ${destinationMode}`, async (t) => {
      const h = await invocationHarness(t, { destinationMode });
      await assert.rejects(
        h.invoke(),
        (error: unknown) =>
          error instanceof LiveTestBlocked &&
          error.gate === "dropbox_probe_cleanup_identity_changed",
      );
      assert.equal(h.parentLookups(), 2);
      assert.ok(h.calls.every(([verb]) => verb !== "purge"));
      if (destinationMode === "duplicate" || destinationMode === "missing_id")
        assert.ok(h.calls.every(([verb]) => verb !== "copyto"));
      assert.equal(h.closed(), true);
    });
  }

  it("rechecks parent identity and cleans up after a content verification failure", async (t) => {
    const h = await invocationHarness(t, { corruptHash: true });
    await assert.rejects(
      h.invoke(),
      (error: unknown) =>
        error instanceof LiveTestBlocked && error.gate === "dropbox_probe_content_unverified",
    );
    assert.equal(h.parentLookups(), 2);
    assert.equal(h.calls.at(-1)?.[0], "purge");
    assert.equal(h.captures.length, 0);
    assert.equal(h.closed(), true);
  });
  it("accepts explicit admin and namespace with existing source samples", () => {
    const parsed = dropboxProbeConfig(config);
    assert.equal(parsed.namespaceId, "123");
    assert.equal(parsed.adminMemberId, "dbmid:admin");
    assert.equal(parsed.paperPath, "fixtures/note.paper");
  });
  for (const overrides of [
    { adminMemberId: "admin@example.com" },
    { namespaceId: "123,shared_folders=true" },
    { filePath: "../escape" },
    { filePath: "/absolute" },
    { filePath: "a//b" },
    { paperPath: "note.html" },
    { destFolderId: "folder:elsewhere" },
  ]) {
    it(`rejects unsafe or ambiguous fixture fields ${JSON.stringify(overrides)}`, () => {
      assert.throws(
        () =>
          dropboxProbeConfig({ ...config, dropboxProbe: { ...config.dropboxProbe, ...overrides } }),
        LiveTestBlocked,
      );
    });
  }
  it("rejects remote option injection and non-file credentials", () => {
    for (const rclone of [
      { ...config.jobConfig.rclone, sourceRemote: "dropbox,shared_folders=true" },
      { ...config.jobConfig.rclone, config: { resolver: "env", path: "TOKEN" } },
    ]) {
      assert.throws(
        () => dropboxProbeConfig({ ...config, jobConfig: { ...config.jobConfig, rclone } }),
        LiveTestBlocked,
      );
    }
  });
  const hashes = { sha256: "a".repeat(64), md5: "b".repeat(32) };
  it("prefers Drive SHA256 and falls back to MD5 only without SHA256", () => {
    assert.equal(
      dropboxHashMatch(hashes, { "SHA-256": hashes.sha256, MD5: "c".repeat(32) }),
      "sha256",
    );
    assert.equal(dropboxHashMatch(hashes, { MD5: hashes.md5 }), "md5");
    assert.throws(
      () => dropboxHashMatch(hashes, { "SHA-256": "c".repeat(64), MD5: hashes.md5 }),
      LiveTestBlocked,
    );
    assert.throws(() => dropboxHashMatch(hashes, { Dropbox: hashes.sha256 }), LiveTestBlocked);
    assert.throws(() => dropboxHashMatch(hashes, {}), LiveTestBlocked);
    assert.throws(
      () => dropboxHashMatch(hashes, { "SHA-256": "malformed", MD5: hashes.md5 }),
      LiveTestBlocked,
    );
  });
  function proven(): ProbeCapture {
    return capture(dropboxFileProbeIds[0], {
      assertions: [
        ["pinned_version", "v1.75.0"],
        ["dropbox_backend", "dropbox"],
        ["drive_backend", "drive"],
        ["paper_is_export", -1],
        ["paper_html_name", "paper.html"],
        ["file_hash_verified", true],
        ["paper_hash_verified", true],
        ["ordinary_downloadable_file", true],
        ["paper_html_export", true],
      ].map(([id, expected]) => ({ id: String(id), expected, observed: expected })),
      observations: {
        version: "v1.75.0",
        sourceMode: "select_admin_namespace",
        sharedFolders: false,
        samples: ["file", "paper"].map((kind) => ({
          kind,
          algorithm: "sha256",
          sourceSha256: hashes.sha256,
          bytes: 12,
        })),
      },
    });
  }
  it("requires both ordinary and exported downloaded-byte evidence", () => {
    const failures = (value: ProbeCapture) =>
      probeFailures({
        captures: [value],
        requiredProbes: dropboxFileProbeIds,
        retained: noRetained,
      });
    assert.deepEqual(failures(proven()), []);
    for (const observations of [
      { samples: [] },
      { sharedFolders: true },
      { version: "v1.74.0" },
      { sourceMode: "select_user" },
      { samples: [{ kind: "file", algorithm: "dropbox", sourceSha256: hashes.sha256, bytes: 12 }] },
    ]) {
      const value = proven();
      Object.assign(value.observations, observations);
      assert.ok(failures(value).length > 0);
    }
    const value = proven();
    value.assertions = value.assertions.filter((item) => item.id !== "paper_is_export");
    assert.ok(failures(value).length > 0);
  });
});
