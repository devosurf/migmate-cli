import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { digestJson } from "../src/engine/store/digest.ts";
import { probeFailures, type ProbeCapture } from "../scripts/live/probes.ts";

const census = {
  scope: "mapping_source_root_children",
  itemsScanned: 4,
  kinds: { file: 2, folder: 2, package: 0, reference: 0, undownloadable: 0 },
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

  it("fails an assertion whose observed value differs", () => {
    const failures = routeFailures(
      routeCapture({}, [{ id: "package_omission", expected: true, observed: false }]),
    );
    assert.ok(failures.length > 0);
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
    ["a live-source-entry claim without the observed omission", routeCapture({}, [])],
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
