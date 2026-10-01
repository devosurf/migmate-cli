import { canonicalJson } from "../../src/engine/store/digest.ts";

export const fileProbeIds = [
  "rclone_mapping_copy_and_hash_verification",
  "mapping_interrupt_and_resume",
  "route_limits_and_version_gate",
] as const;
/** Unusual source kinds the live file suite must account for, each with a proof value: ADR-0006. */
export const sourceCapabilityKinds = ["package", "reference", "undownloadable"] as const;
export type SourceCapabilityKind = (typeof sourceCapabilityKinds)[number];
export type SourceCapabilityProof =
  "live_source_entry" | "source_refuses_creation" | "absent_from_source_scope";
/** ADR-0006: the one weaker proof each kind may rest on, if any. `live_source_entry` is
 * open to every kind. A package is obtainable on demand, so it has no weaker form. */
export const weakerProofByKind = {
  package: null,
  reference: "source_refuses_creation",
  undownloadable: "absent_from_source_scope",
} as const satisfies Record<SourceCapabilityKind, SourceCapabilityProof | null>;

export interface ProbeCapture {
  schemaVersion: 1;
  probeId: string;
  startedAt: string;
  completedAt: string;
  codes: string[];
  assertions: { id: string; expected: unknown; observed: unknown }[];
  observations: Record<string, unknown>;
}

const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-z][a-z0-9_]{0,127}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Why a completed live run does not prove what its probes claim, one reason per entry;
 * empty means every probe passed. A probe's own assertions compare expected and
 * observed values as it runs; this adds the claims that span a whole capture.
 */
export function probeFailures(input: {
  captures: readonly ProbeCapture[];
  requiredProbes: readonly string[];
  /** Which retained-history routes the configuration exercises. */
  retained: { channel: boolean; chat: boolean };
}): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const capture of input.captures) {
    const fail = (reason: string) => failures.push(`${capture.probeId}: ${reason}`);
    if (!idPattern.test(capture.probeId) || seen.has(capture.probeId))
      fail("duplicate or invalid probe id");
    seen.add(capture.probeId);
    if (capture.assertions.length === 0) fail("no assertions");
    const assertionIds = new Set<string>();
    for (const assertion of capture.assertions) {
      if (!idPattern.test(assertion.id) || assertionIds.has(assertion.id))
        fail(`duplicate or invalid assertion id ${assertion.id}`);
      assertionIds.add(assertion.id);
      if (canonicalJson(assertion.expected) !== canonicalJson(assertion.observed))
        fail(`assertion ${assertion.id} observed a different value`);
    }
    const observations = capture.observations;
    const asserted = (id: string, expected: unknown) =>
      capture.assertions.some(
        (assertion) =>
          assertion.id === id && assertion.expected === expected && assertion.observed === expected,
      );
    if (capture.probeId === "retained_history" && input.retained.channel)
      for (const reason of retainedFailures(observations, input.retained.chat)) fail(reason);
    if (capture.probeId === "route_limits_and_version_gate") {
      const proofs = observations.capabilityProofs;
      if (!record(proofs)) {
        fail("capability proofs missing");
        continue;
      }
      for (const kind of sourceCapabilityKinds) {
        const proof = proofs[kind];
        if (proof === "live_source_entry") {
          // A real item of that kind existed and the driver omitted it.
          if (!asserted(`${kind}_omission`, true)) fail(`${kind} omission not asserted`);
          continue;
        }
        // Each kind rests on at most one weaker proof, and only with its evidence.
        const weaker = weakerProofByKind[kind];
        if (weaker === null || proof !== weaker) {
          fail(`${kind} capability proof ${String(proof)} is not admissible`);
          continue;
        }
        if (weaker === "source_refuses_creation") {
          // Only the reference create is attempted live, so its status is the proof.
          if (observations.sourceRefusedReferenceStatus !== 400)
            fail(`${kind} creation refusal not observed`);
        } else {
          // Absence is only a proof when something was actually scanned.
          const census = observations.sourceKindCensus;
          if (
            !record(census) ||
            !record(census.kinds) ||
            !count(census.itemsScanned) ||
            census.itemsScanned <= 0 ||
            census.kinds[kind] !== 0
          )
            fail(`${kind} absence not proven by a scanned source`);
        }
      }
    }
  }
  const required = [
    ...input.requiredProbes,
    ...(input.retained.channel ? ["retained_history"] : []),
  ];
  for (const id of required) if (!seen.has(id)) failures.push(`${id}: probe did not run`);
  return failures;
}

function retainedFailures(observations: Record<string, unknown>, chatRetained: boolean): string[] {
  const subjects = observations.privateChannels;
  const samples = observations.privateRetainedSamples;
  const paging = observations.paging;
  if (!strings(subjects) || subjects.length === 0 || !subjects.every((s) => hashPattern.test(s)))
    return ["no private channel subject observed"];
  if (!Array.isArray(samples) || samples.length === 0) return ["no private retained sample"];
  if (!Array.isArray(paging) || paging.length === 0) return ["no retained paging observed"];
  if (
    !count(observations.records) ||
    observations.records <= 0 ||
    typeof observations.collectionDigest !== "string" ||
    !hashPattern.test(observations.collectionDigest)
  )
    return ["retained collection incomplete"];
  const pages: {
    scopeKind: string;
    records: number;
    conversationSubjects: string[];
  }[] = [];
  for (const page of paging) {
    if (
      !record(page) ||
      page.route !== "retained" ||
      (page.scopeKind !== "channel" && page.scopeKind !== "chat") ||
      page.exhausted !== true ||
      !count(page.pages) ||
      page.pages <= 0 ||
      page.continuationPages !== page.pages - 1 ||
      !count(page.records) ||
      page.records < 0 ||
      !strings(page.conversationSubjects) ||
      !page.conversationSubjects.every((s) => hashPattern.test(s))
    )
      return ["retained paging not exhausted or malformed"];
    pages.push({
      scopeKind: page.scopeKind,
      records: page.records,
      conversationSubjects: page.conversationSubjects,
    });
  }
  const failures: string[] = [];
  if (
    !subjects.every((subject) =>
      pages.some(
        (page) => page.scopeKind === "channel" && page.conversationSubjects.includes(subject),
      ),
    )
  )
    failures.push("a private channel was not paged");
  const sampleSubjects = new Set<string>();
  let privateRecords = 0;
  for (const sample of samples) {
    if (
      !record(sample) ||
      typeof sample.subject !== "string" ||
      !subjects.includes(sample.subject) ||
      sampleSubjects.has(sample.subject) ||
      !count(sample.records) ||
      sample.records <= 0
    )
      return [...failures, "private retained sample malformed"];
    sampleSubjects.add(sample.subject);
    privateRecords += sample.records;
  }
  if (privateRecords > observations.records)
    failures.push("private samples exceed collected records");
  for (const page of pages) {
    const collected = (samples as { subject: string; records: number }[])
      .filter((sample) => page.conversationSubjects.includes(sample.subject))
      .reduce((total, sample) => total + sample.records, 0);
    if (collected > page.records) failures.push("private samples exceed paged records");
  }
  for (const kind of chatRetained ? ["channel", "chat"] : ["channel"])
    if (!pages.some((page) => page.scopeKind === kind && page.records > 0))
      failures.push(`no retained ${kind} records collected`);
  return failures;
}
