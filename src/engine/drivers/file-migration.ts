import { createHash } from "node:crypto";
import { CODE_BY_NAME } from "../codes.ts";
import type { CheckResult } from "../types.ts";
import type { DestinationEntry, SourceEntry } from "../providers/port.ts";
import type { CommitFinding, CommitUnit, JobTypeDriver, ReportSection } from "./types.ts";
import {
  assertSourceStable,
  FilePlanRevisionRequiredError,
  FileSourceChangedError,
  hashStream,
  readObject,
  observe,
  markerMatches,
  outputFindings,
  terminalUnavailable,
  type Observation,
  second,
  sourceEvidence,
  sourceToken,
  stageSource,
  type FileContext,
  type FileEvidenceRow,
  type FileExclusion,
  type FileMarker,
  type FileOutput,
  type FileProvider,
  type FileScope,
  type FileState,
} from "./file-state.ts";

export interface FileMappingConfig {
  id: string;
  sourceDriveId: string;
  sourceItemId: string;
  destDriveId: string;
  destFolderId: string;
  exclusions?: FileExclusion[];
}

export interface FileMigrationConfig {
  mappings: FileMappingConfig[];
}

type Phase = "plan" | "execute" | "verify";
interface SourceView extends SourceEntry {
  path: string;
  representable: boolean;
  outsideRoot: boolean;
}
interface DestinationView extends DestinationEntry {
  path: string;
}
interface Snapshot {
  mapping: FileMappingConfig;
  sources: SourceView[];
  sourceById: Map<string, SourceView>;
  destinations: DestinationView[];
  destinationById: Map<string, DestinationView>;
  destinationByPath: Map<string, DestinationView[]>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function finding(
  ctx: FileContext,
  phase: Phase,
  code: string,
  subjectId: string,
  evidence: Record<string, unknown> = {},
): CommitFinding {
  const definition = CODE_BY_NAME[code];
  if (!definition) throw new Error(`Unregistered file outcome: ${code}`);
  return {
    rev: ctx.revision,
    phase,
    code,
    kind: definition.kind,
    subjectKind: "item",
    subjectId,
    evidence,
    at: ctx.now().toISOString(),
  };
}

function row(
  ctx: FileContext,
  phase: Phase,
  mapping: FileMappingConfig,
  source: SourceView,
  code: string,
  state?: FileState,
): FileEvidenceRow {
  const definition = CODE_BY_NAME[code];
  if (!definition) throw new Error(`Unregistered file outcome: ${code}`);
  return {
    id: JSON.stringify([mapping.id, source.id, phase]),
    jobType: "file_migration",
    rev: ctx.revision,
    phase,
    code,
    kind: definition.kind,
    mappingId: mapping.id,
    sourceDriveId: source.driveId,
    sourceItemId: source.id,
    relativePath: source.path,
    itemType: source.kind === "folder" ? "folder" : "file",
    size: source.size,
    sourceEtag: source.etag,
    sourceEvidence: sourceEvidence(source),
    sourceFingerprint: state?.sourceFingerprint ?? null,
    destinationDriveId: state?.output.driveId ?? null,
    destinationFileId: state?.output.id || null,
    destinationFingerprint: state?.output.sha256 ?? null,
    provenanceState: state?.status === "verified" ? "verified" : state ? "marked" : "none",
    ...(state ? { fileState: state } : {}),
  };
}

function commit(
  ctx: FileContext,
  phase: Phase,
  evidence: FileEvidenceRow,
  findings: CommitFinding[],
  suffix: string,
  done: number,
): CommitUnit {
  // The attempt class includes the admitted source version. A delta under the
  // same plan must not collide with that item's previous execute commit.
  const unitKey = JSON.stringify([
    evidence.mappingId,
    evidence.sourceItemId,
    phase,
    suffix,
    digest([
      evidence.sourceEvidence,
      evidence.code,
      evidence.fileState,
      evidence.fileScope?.exclusions,
    ]),
  ]);
  return {
    rev: ctx.revision,
    phase,
    unitKey,
    checkpoint: evidence.relativePath,
    rows: [evidence],
    findings,
    watermark: { unitKey, value: evidence.relativePath },
    progress: { unit: "items", done, total: null },
  };
}

function durableRows(
  ctx: FileContext,
  mapping: FileMappingConfig,
): {
  states: Map<string, FileState>;
  scope: FileScope | undefined;
} {
  const states = new Map<string, FileState>();
  let scope: FileScope | undefined;
  for (const candidate of ctx.resume.rows ?? []) {
    if (
      candidate.jobType !== "file_migration" ||
      candidate.mappingId !== mapping.id ||
      candidate.sourceDriveId !== mapping.sourceDriveId
    )
      continue;
    const evidence: FileEvidenceRow = candidate;
    if (evidence.fileScope && candidate.rev === ctx.revision && candidate.phase === "plan") {
      scope = evidence.fileScope;
    }
    const state = evidence.fileState;
    if (!state || state.version !== 1 || state.output.driveId !== mapping.destDriveId) continue;
    const previous = states.get(candidate.sourceItemId);
    if (
      !previous ||
      state.generation > previous.generation ||
      (state.generation === previous.generation &&
        previous.status === "prepared" &&
        state.status !== "prepared")
    ) {
      states.set(candidate.sourceItemId, state);
    }
  }
  return { states, scope };
}

async function snapshot(ctx: FileContext, mapping: FileMappingConfig): Promise<Snapshot> {
  const sourceRoot = await ctx.provider.resolveSourceRoot(mapping);
  const destinationRoot = await ctx.provider.resolveDestinationFolder(mapping);
  if (
    !sourceRoot ||
    sourceRoot.kind !== "folder" ||
    sourceRoot.driveId !== mapping.sourceDriveId ||
    !destinationRoot ||
    destinationRoot.kind !== "folder" ||
    destinationRoot.driveId !== mapping.destDriveId
  ) {
    throw Object.assign(new Error("A mapping root is missing or is not an ordinary folder"), {
      code: "unsupported_route",
    });
  }
  const sources: SourceView[] = [
    { ...sourceRoot, path: ".", representable: true, outsideRoot: false },
  ];
  const sourceById = new Map([[sourceRoot.id, sources[0]!]]);
  for (let index = 0; index < sources.length; index++) {
    ctx.signal?.throwIfAborted();
    const parent = sources[index]!;
    if (parent.kind !== "folder" || parent.outsideRoot) continue;
    const children = await ctx.provider.listSourceChildren(parent.id);
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
    for (const child of children) {
      const outsideRoot = child.driveId !== mapping.sourceDriveId || child.parentId !== parent.id;
      if (sourceById.has(child.id)) {
        throw Object.assign(new Error("Source enumeration repeats a stable item identity"), {
          code: "source_read_failed",
        });
      }
      const view: SourceView = {
        ...child,
        path: parent.path === "." ? child.name : `${parent.path}/${child.name}`,
        representable:
          parent.representable &&
          child.name.length > 0 &&
          child.name !== "." &&
          child.name !== ".." &&
          !/[\/\\\u0000]/u.test(child.name),
        outsideRoot,
      };
      sources.push(view);
      sourceById.set(child.id, view);
    }
  }
  const destinations: DestinationView[] = [{ ...destinationRoot, path: "." }];
  const destinationById = new Map([[destinationRoot.id, destinations[0]!]]);
  const destinationByPath = new Map<string, DestinationView[]>([[".", [destinations[0]!]]]);
  for (let index = 0; index < destinations.length; index++) {
    ctx.signal?.throwIfAborted();
    const parent = destinations[index]!;
    if (parent.kind !== "folder") continue;
    const children = await ctx.provider.listDestinationChildren(parent.id);
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
    for (const child of children) {
      if (
        child.driveId !== mapping.destDriveId ||
        child.parentId !== parent.id ||
        destinationById.has(child.id)
      ) {
        throw Object.assign(new Error("Destination enumeration is inconsistent"), {
          code: "destination_path_mismatch",
        });
      }
      const view = {
        ...child,
        path: parent.path === "." ? child.name : `${parent.path}/${child.name}`,
      };
      destinations.push(view);
      destinationById.set(view.id, view);
      const bucket = destinationByPath.get(view.path) ?? [];
      bucket.push(view);
      destinationByPath.set(view.path, bucket);
    }
  }
  return { mapping, sources, sourceById, destinations, destinationById, destinationByPath };
}

function expandedExclusions(tree: Snapshot): FileExclusion[] {
  const excluded = new Map<string, string>();
  for (const selection of tree.mapping.exclusions ?? []) {
    if (!selection.sourceItemId || !selection.reason?.trim()) {
      throw Object.assign(new Error("Exclusions require a stable item ID and a reason"), {
        code: "invalid_config",
      });
    }
    // Retain the selected ID even if its source was deleted after approval.
    excluded.set(selection.sourceItemId, selection.reason);
  }
  for (const source of tree.sources) {
    const inherited = source.parentId === null ? undefined : excluded.get(source.parentId);
    if (inherited !== undefined && !excluded.has(source.id)) excluded.set(source.id, inherited);
  }
  return [...excluded]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sourceItemId, reason]) => ({ sourceItemId, reason }));
}

async function ownedObservation(ctx: FileContext, state: FileState): Promise<Observation | null> {
  if (!state.output.id) return null;
  const entry = await readObject(ctx.provider, state.output.driveId, state.output.id);
  return entry ? observe(ctx, entry) : null;
}

function expectedOutput(
  mapping: FileMappingConfig,
  source: SourceView,
  parentId: string,
  fingerprint: string | null,
  previous?: FileState,
): FileOutput {
  return {
    id: previous?.output.id ?? "",
    driveId: mapping.destDriveId,
    parentId,
    name: source.name,
    kind: source.kind === "folder" ? "folder" : "file",
    size: source.kind === "file" ? source.size : null,
    createdAt: previous?.output.createdAt ?? source.createdAt,
    modifiedAt: source.modifiedAt,
    mimeType: source.kind === "file" ? source.mimeType : null,
    sha256: fingerprint,
  };
}

function makeState(
  ctx: FileContext,
  mapping: FileMappingConfig,
  source: SourceView,
  output: FileOutput,
  action: FileState["action"],
  previous?: FileState,
): FileState {
  const generation = (previous?.generation ?? 0) + 1;
  const attempt = digest([mapping.id, sourceToken(source), output, ctx.revision, generation]);
  const marker: FileMarker = {
    mappingId: mapping.id,
    sourceDriveId: source.driveId,
    sourceItemId: source.id,
    sourceIdentity: source.identity,
    sourceKind: source.kind,
    sourceRelativePath: source.path,
    sourceFingerprint: output.sha256,
    verifiedFingerprint: output.sha256,
    createdAt: output.createdAt,
    modifiedAt: source.modifiedAt,
    mimeType: source.mimeType,
    stateRevision: attempt,
  };
  return {
    version: 1,
    generation,
    status: "prepared",
    attempt,
    action,
    source: sourceEvidence(source),
    sourceFingerprint: output.sha256,
    relativePath: source.path,
    output,
    marker,
    previous: previous ? { output: previous.output, marker: previous.marker } : null,
  };
}

function sourceOmission(source: SourceView): string | null {
  if (source.outsideRoot) return "route_limit_omission";
  if (!source.representable) return "path_unrepresentable";
  if (source.kind === "package") return "source_package_omitted";
  if (source.kind === "reference") return "source_reference_omitted";
  if (source.kind === "undownloadable" || (source.kind === "file" && !source.downloadable)) {
    return "source_content_unavailable";
  }
  return null;
}

function metadataOmissions(ctx: FileContext, phase: Phase, source: SourceView): CommitFinding[] {
  const evidence = sourceEvidence(source);
  const results: CommitFinding[] = [];
  if ((evidence.versionCount ?? 0) > 1) {
    results.push(
      finding(ctx, phase, "version_history_omitted", source.id, {
        versionCount: evidence.versionCount,
      }),
    );
  }
  if (
    evidence.listItemFields !== undefined ||
    evidence.contentType !== undefined ||
    evidence.retentionLabel !== undefined
  ) {
    results.push(
      finding(ctx, phase, "source_metadata_export_only", source.id, { sourceEvidence: evidence }),
    );
  }
  return results;
}

/** Resolve by source identity, never by a destination marker search. */
async function collision(
  ctx: FileContext,
  tree: Snapshot,
  source: SourceView,
  state: FileState | undefined,
  owners: Map<string, FileState>,
  parentId: string | undefined,
): Promise<{ code?: string; observation?: Observation | null }> {
  const provider: FileProvider = ctx.provider;
  const siblings = parentId
    ? (await provider.listDestinationChildren(parentId)).filter((item) => item.name === source.name)
    : (tree.destinationByPath.get(source.path) ?? []);
  if (siblings.length > 1) return { code: "destination_duplicate_name" };
  const atPath = siblings[0];
  if (atPath && atPath.kind !== source.kind) return { code: "destination_type_conflict" };
  if (atPath && atPath.id !== state?.output.id) {
    const retainedOwner = owners.get(atPath.id);
    return {
      code:
        retainedOwner && retainedOwner.source.id !== source.id
          ? "source_identity_reuse_collision"
          : "unowned_path_collision",
    };
  }
  if (!state) return {};
  if (state.source.identity !== source.identity || state.source.driveId !== source.driveId) {
    return { code: "source_identity_reuse_collision" };
  }
  const observation = await ownedObservation(ctx, state);
  if (!observation) return { observation: null };
  if (observation.entry.kind !== source.kind)
    return { code: "destination_type_conflict", observation };
  return { observation };
}

async function* runPhase(ctx: FileContext, phase: Phase): AsyncIterable<CommitUnit> {
  const provider: FileProvider = ctx.provider;
  const trees: Snapshot[] = [];
  for (const mapping of ctx.config.mappings) trees.push(await snapshot(ctx, mapping));
  const overlapping = new Set<string>();
  for (let left = 0; left < trees.length; left++) {
    for (let right = left + 1; right < trees.length; right++) {
      const a = trees[left]!;
      const b = trees[right]!;
      if (
        a.mapping.id === b.mapping.id ||
        (a.mapping.sourceDriveId === b.mapping.sourceDriveId &&
          (a.sourceById.has(b.mapping.sourceItemId) || b.sourceById.has(a.mapping.sourceItemId))) ||
        (a.mapping.destDriveId === b.mapping.destDriveId &&
          (a.destinationById.has(b.mapping.destFolderId) ||
            b.destinationById.has(a.mapping.destFolderId)))
      ) {
        overlapping.add(a.mapping.id);
        overlapping.add(b.mapping.id);
      }
    }
  }
  let done = 0;
  for (const tree of trees) {
    const { mapping } = tree;
    const { states, scope } = durableRows(ctx, mapping);
    if (phase !== "plan" && !scope) throw new FilePlanRevisionRequiredError();
    const owners = new Map(
      [...states.values()]
        .filter((state) => state.output.id)
        .map((state) => [state.output.id, state]),
    );
    const exclusions = expandedExclusions(tree);
    const excluded = new Map(
      (phase === "plan" ? exclusions : (scope?.exclusions ?? exclusions)).map((item) => [
        item.sourceItemId,
        item.reason,
      ]),
    );
    if (phase !== "plan" && scope) {
      const approved = new Map(scope.exclusions.map((item) => [item.sourceItemId, item.reason]));
      const expanded = new Map(exclusions.map((item) => [item.sourceItemId, item.reason]));
      if (
        exclusions.some((item) => approved.get(item.sourceItemId) !== item.reason) ||
        scope.exclusions.some(
          (item) =>
            tree.sourceById.has(item.sourceItemId) &&
            expanded.get(item.sourceItemId) !== item.reason,
        )
      ) {
        throw new FilePlanRevisionRequiredError();
      }
    }
    const root = tree.sources[0]!;
    const rootRow = row(
      ctx,
      phase,
      mapping,
      root,
      overlapping.has(mapping.id) ? "mapping_overlap" : "unchanged",
    );
    rootRow.destinationDriveId = mapping.destDriveId;
    rootRow.destinationFileId = mapping.destFolderId;
    rootRow.fileScope = {
      exclusions: phase === "plan" ? exclusions : (scope?.exclusions ?? exclusions),
      sourceInventoryAt: ctx.now().toISOString(),
    };
    yield commit(
      ctx,
      phase,
      rootRow,
      overlapping.has(mapping.id) ? [finding(ctx, phase, "mapping_overlap", mapping.id)] : [],
      "root",
      ++done,
    );
    if (overlapping.has(mapping.id)) continue;

    const parents = new Map<string, string>([[root.id, mapping.destFolderId]]);
    const blocked = new Map<string, string>();
    for (const source of tree.sources.slice(1)) {
      ctx.signal?.throwIfAborted();
      const prior = states.get(source.id);
      let effect: "source" | "destination" = "destination";
      try {
        const omission = excluded.has(source.id) ? "omitted_by_rule" : sourceOmission(source);
        const inheritedBlock = source.parentId === null ? undefined : blocked.get(source.parentId);
        if (omission || inheritedBlock) {
          const code = omission ?? inheritedBlock!;
          blocked.set(source.id, code);
          yield commit(
            ctx,
            phase,
            row(ctx, phase, mapping, source, code, prior),
            [
              finding(ctx, phase, code, source.id, {
                path: source.path,
                ...(excluded.has(source.id) ? { reason: excluded.get(source.id) } : {}),
              }),
            ],
            "omission",
            ++done,
          );
          continue;
        }
        const parentId = source.parentId === null ? undefined : parents.get(source.parentId);
        const problem = await collision(ctx, tree, source, prior, owners, parentId);
        if (problem.code) {
          blocked.set(source.id, problem.code);
          yield commit(
            ctx,
            phase,
            row(ctx, phase, mapping, source, problem.code, prior),
            [finding(ctx, phase, problem.code, source.id, { path: source.path })],
            "collision",
            ++done,
          );
          continue;
        }
        const observed = problem.observation;
        if (phase === "verify") {
          const verified = await verifyItem(ctx, tree, source, prior, observed, parentId, done + 1);
          done += 1;
          yield verified;
          if (source.kind === "folder" && observed) parents.set(source.id, observed.entry.id);
          continue;
        }
        if (prior && prior.status !== "prepared") {
          const marker = observed ? await provider.readDestinationMarker(observed.entry.id) : null;
          const differences = observed
            ? outputFindings(observed, prior.output)
            : ["destination_missing"];
          if (!observed || !markerMatches(marker, prior.marker) || differences.length > 0) {
            const code = !observed
              ? "destination_missing"
              : !markerMatches(marker, prior.marker)
                ? "provenance_mismatch"
                : differences.every((value) => value === "content_verification_degraded")
                  ? "content_verification_degraded"
                  : "prior_copy_drift";
            blocked.set(source.id, code);
            yield commit(
              ctx,
              phase,
              row(ctx, phase, mapping, source, code, prior),
              [finding(ctx, phase, code, source.id, { differences })],
              "prior-output",
              ++done,
            );
            continue;
          }
        }
        if (phase === "plan") {
          const moved =
            prior && (prior.relativePath !== source.path || prior.output.name !== source.name);
          const changed = prior && sourceToken(prior.source) !== sourceToken(source);
          const code = prior ? (moved ? "moved" : changed ? "updated" : "unchanged") : "created";
          if (source.kind === "folder" && observed) parents.set(source.id, observed.entry.id);
          yield commit(
            ctx,
            phase,
            row(ctx, phase, mapping, source, code, prior),
            metadataOmissions(ctx, phase, source),
            "plan",
            ++done,
          );
          continue;
        }
        if (!parentId) {
          blocked.set(source.id, "destination_missing");
          yield commit(
            ctx,
            phase,
            row(ctx, phase, mapping, source, "destination_missing", prior),
            [
              finding(ctx, phase, "destination_missing", source.id, {
                parentSourceId: source.parentId,
              }),
            ],
            "parent",
            ++done,
          );
          continue;
        }

        // A durable prepared intent is reconciled against its reserved ID, never
        // against a marker discovered at a path. It may represent a lost response.
        if (prior?.status === "prepared" && observed) {
          const actualMarker = await provider.readDestinationMarker(observed.entry.id);
          const differences = outputFindings(observed, prior.output);
          if (differences.length === 0 && markerMatches(actualMarker, prior.marker)) {
            const recovered: FileState = { ...prior, status: "verified", previous: null };
            states.set(source.id, recovered);
            yield commit(
              ctx,
              phase,
              row(
                ctx,
                phase,
                mapping,
                { ...source, ...prior.source, path: prior.relativePath },
                prior.action,
                recovered,
              ),
              [],
              `recovered:${prior.attempt}`,
              ++done,
            );
            // The source may have changed since the lost response. Requeue after
            // recording the old output, rather than blessing it as the new source.
            await assertSourceStable(provider, prior.source);
            if (source.kind === "folder") parents.set(source.id, observed.entry.id);
            continue;
          }
          const previousMatches =
            prior.previous &&
            markerMatches(actualMarker, prior.previous.marker) &&
            outputFindings(observed, prior.previous.output).length === 0;
          if (!previousMatches) {
            blocked.set(source.id, "prior_copy_drift");
            yield commit(
              ctx,
              phase,
              row(ctx, phase, mapping, source, "prior_copy_drift", prior),
              [finding(ctx, phase, "prior_copy_drift", source.id, { differences })],
              "prepared-drift",
              ++done,
            );
            continue;
          }
        }
        if (prior?.status === "prepared" && prior.previous && !observed) {
          blocked.set(source.id, "destination_missing");
          yield commit(
            ctx,
            phase,
            row(ctx, phase, mapping, source, "destination_missing", prior),
            [finding(ctx, phase, "destination_missing", source.id)],
            "prepared-missing",
            ++done,
          );
          continue;
        }

        effect = "source";
        const staged = source.kind === "file" ? await stageSource(ctx, source) : null;
        try {
          if (!staged) await assertSourceStable(provider, source);
          effect = "destination";
          const fingerprint = staged?.sha256 ?? null;
          const expected = expectedOutput(mapping, source, parentId, fingerprint, prior);
          const lastOutput = prior?.status === "prepared" ? prior.previous?.output : prior?.output;
          const changedContent =
            !lastOutput ||
            (source.kind === "file" &&
              (lastOutput.sha256 !== fingerprint ||
                lastOutput.size !== source.size ||
                lastOutput.mimeType !== expected.mimeType ||
                second(lastOutput.modifiedAt) !== second(expected.modifiedAt)));
          const moved =
            prior &&
            (prior.output.parentId !== parentId ||
              prior.output.name !== source.name ||
              prior.relativePath !== source.path);
          if (prior && prior.status !== "prepared" && !changedContent && !moved) {
            if (source.kind === "folder") parents.set(source.id, prior.output.id);
            yield commit(
              ctx,
              phase,
              row(ctx, phase, mapping, source, "unchanged", prior),
              metadataOmissions(ctx, phase, source),
              "unchanged",
              ++done,
            );
            continue;
          }
          let prepared =
            prior?.status === "prepared"
              ? prior
              : makeState(
                  ctx,
                  mapping,
                  source,
                  expected,
                  !prior ? "created" : moved ? "moved" : "updated",
                  prior,
                );
          if (
            prior?.status === "prepared" &&
            (sourceToken(source) !== sourceToken(prior.source) ||
              fingerprint !== prior.sourceFingerprint)
          ) {
            // No write has happened (or the previous output still matches). Replace
            // only the intent; keep its reserved destination identity.
            prepared = makeState(
              ctx,
              mapping,
              source,
              expected,
              prior.action,
              prior.previous
                ? { ...prior, output: prior.previous.output, marker: prior.previous.marker }
                : undefined,
            );
            prepared.generation = prior.generation + 1;
            prepared.output.id = prior.output.id;
            prepared.previous = prior.previous;
          }
          if (!prepared.output.id && provider.reserveDestinationId)
            prepared.output.id = await provider.reserveDestinationId();
          yield commit(
            ctx,
            phase,
            row(ctx, phase, mapping, source, prepared.action, prepared),
            [],
            `intent:${prepared.attempt}`,
            done,
          );
          states.set(source.id, prepared);
          if (prepared.output.id) owners.set(prepared.output.id, prepared);
          // Re-read after the durable intent and immediately before every mutation.
          const race = await collision(ctx, tree, source, prepared, owners, parentId);
          if (race.code) {
            blocked.set(source.id, race.code);
            yield commit(
              ctx,
              phase,
              row(ctx, phase, mapping, source, race.code, prepared),
              [finding(ctx, phase, race.code, source.id)],
              "race",
              ++done,
            );
            continue;
          }
          const before = race.observation;
          if (before && prepared.previous) {
            const marker = await provider.readDestinationMarker(before.entry.id);
            if (
              !markerMatches(marker, prepared.previous.marker) ||
              outputFindings(before, prepared.previous.output).length
            ) {
              yield commit(
                ctx,
                phase,
                row(ctx, phase, mapping, source, "prior_copy_drift", prepared),
                [finding(ctx, phase, "prior_copy_drift", source.id)],
                "race-drift",
                ++done,
              );
              blocked.set(source.id, "prior_copy_drift");
              continue;
            }
          } else if (before) {
            // An object materialized at a reserved identity without our atomic
            // marker/output. It is not permission to take over that object.
            yield commit(
              ctx,
              phase,
              row(ctx, phase, mapping, source, "provenance_mismatch", prepared),
              [finding(ctx, phase, "provenance_mismatch", source.id)],
              "reserved-collision",
              ++done,
            );
            blocked.set(source.id, "provenance_mismatch");
            continue;
          }
          let result: DestinationEntry;
          if (source.kind === "folder" || (before && !changedContent)) {
            if (before) {
              result =
                before.entry.parentId !== parentId || before.entry.name !== source.name
                  ? await provider.moveDestinationObject({
                      objectId: before.entry.id,
                      parentFolderId: parentId,
                      name: source.name,
                      ...(source.kind === "file" ? { modifiedAt: source.modifiedAt } : {}),
                      marker: prepared.marker,
                      ...(before.entry.revision ? { expectedRevision: before.entry.revision } : {}),
                    })
                  : before.entry;
            } else {
              result = await provider.createDestinationFolder({
                parentFolderId: parentId,
                name: source.name,
                createdAt: prepared.output.createdAt,
                modifiedAt: source.modifiedAt,
                ...(prepared.output.id ? { destinationId: prepared.output.id } : {}),
                marker: prepared.marker,
              });
            }
          } else {
            result = await provider.uploadDestinationContent({
              ...(prepared.output.id ? { destinationId: prepared.output.id } : {}),
              create: !before,
              parentFolderId: parentId,
              name: source.name,
              content: staged!.content(),
              createdAt: prepared.output.createdAt,
              modifiedAt: source.modifiedAt,
              mimeType: source.mimeType,
              marker: prepared.marker,
              ...(before?.entry.revision ? { expectedRevision: before.entry.revision } : {}),
            });
          }
          if (prepared.output.id && result.id !== prepared.output.id) {
            throw Object.assign(
              new Error("Provider did not honor the reserved destination identity"),
              { code: "provenance_mismatch" },
            );
          }
          if (!prepared.output.id) {
            // The original scripted port has no reservation capability. A returned
            // ID is journalled before the non-atomic marker write; an unknown
            // orphan after a lost create response still refuses rather than adopts.
            prepared = { ...prepared, output: { ...prepared.output, id: result.id } };
            states.set(source.id, prepared);
            owners.set(prepared.output.id, prepared);
            yield commit(
              ctx,
              phase,
              row(ctx, phase, mapping, source, prepared.action, prepared),
              [],
              `bound:${prepared.attempt}`,
              done,
            );
          }
          const marked = await provider.readDestinationMarker(result.id);
          if (!markerMatches(marked, prepared.marker)) {
            const current = await readObject(provider, mapping.destDriveId, result.id);
            if (!current)
              throw Object.assign(new Error("Destination disappeared before marker write"), {
                code: "destination_missing",
              });
            await provider.writeDestinationMarker({
              objectId: result.id,
              marker: prepared.marker,
              ...(current.revision ? { expectedRevision: current.revision } : {}),
            });
          }
          const output = await ownedObservation(ctx, prepared);
          const differences = output
            ? outputFindings(output, prepared.output)
            : ["destination_missing"];
          const finalMarker = output ? await provider.readDestinationMarker(output.entry.id) : null;
          if (!markerMatches(finalMarker, prepared.marker)) differences.push("provenance_mismatch");
          const completed: FileState = {
            ...prepared,
            status: differences.length ? "unverified" : "verified",
            previous: null,
          };
          states.set(source.id, completed);
          if (source.kind === "folder" && output && !differences.length)
            parents.set(source.id, output.entry.id);
          if (differences.length) blocked.set(source.id, differences[0]!);
          yield commit(
            ctx,
            phase,
            row(ctx, phase, mapping, source, differences[0] ?? prepared.action, completed),
            [
              ...differences.map((code) => finding(ctx, phase, code, source.id)),
              ...metadataOmissions(ctx, phase, source),
            ],
            `result:${prepared.attempt}`,
            ++done,
          );
          effect = "source";
          await assertSourceStable(provider, source);
        } finally {
          await staged?.dispose();
        }
      } catch (error) {
        if (!(error instanceof Error) || error.name === "AbortError") throw error;
        const detail = error as Error & {
          code?: string;
          status?: number;
          statusCode?: number;
          transient?: boolean;
          retryable?: boolean;
        };
        if (detail.transient === true || detail.retryable === true) throw error;
        const status = detail.status ?? detail.statusCode;
        const registered = detail.code === undefined ? undefined : CODE_BY_NAME[detail.code];
        const fileCode =
          registered?.jobType === "file_migration" && registered.kind !== "policy_outcome"
            ? registered.code
            : undefined;
        if (
          detail.transient !== false &&
          !fileCode &&
          !(status !== undefined && status >= 400 && status < 500 && status !== 429)
        )
          throw error;
        const code =
          fileCode ?? (effect === "source" ? "source_read_failed" : "destination_write_failed");
        blocked.set(source.id, code);
        const latest = states.get(source.id);
        yield commit(
          ctx,
          phase,
          row(ctx, phase, mapping, source, code, latest),
          [
            finding(ctx, phase, code, source.id, {
              path: source.path,
              effect,
              ...(status === undefined ? {} : { status }),
            }),
          ],
          `terminal:${latest?.attempt ?? "read"}`,
          ++done,
        );
      }
    }

    // Additive policy does not infer ownership from private properties. Only
    // durable identities distinguish a deleted-source prior copy from unrelated content.
    for (const destination of tree.destinations.slice(1)) {
      const owner = owners.get(destination.id);
      const sourceExists = owner && tree.sourceById.has(owner.source.id);
      if (sourceExists) continue;
      const code =
        owner && !sourceExists
          ? "source_deleted_destination_retained"
          : "destination_only_retained";
      const synthetic: SourceView = {
        ...(owner?.source ?? sourceEvidence(root)),
        id: owner?.source.id ?? `destination:${destination.id}`,
        path: destination.path,
        name: destination.name,
        kind: destination.kind === "folder" ? "folder" : "file",
        size: destination.size,
        representable: true,
        outsideRoot: false,
      };
      const retained = row(ctx, phase, mapping, synthetic, code, owner);
      retained.destinationDriveId = destination.driveId;
      retained.destinationFileId = destination.id;
      yield commit(ctx, phase, retained, [], `retained:${destination.id}`, ++done);
    }
  }
}

async function verifyItem(
  ctx: FileContext,
  tree: Snapshot,
  source: SourceView,
  state: FileState | undefined,
  observed: Observation | null | undefined,
  parentId: string | undefined,
  done: number,
): Promise<CommitUnit> {
  const provider: FileProvider = ctx.provider;
  const codes: string[] = [];
  let fingerprint: string | null = null;
  if (!state || !observed) codes.push("destination_missing");
  else {
    if (state.source.identity !== source.identity) codes.push("source_identity_reuse_collision");
    if (observed.entry.parentId !== parentId || observed.entry.name !== source.name)
      codes.push("destination_path_mismatch");
    if (observed.entry.kind !== source.kind) codes.push("destination_type_conflict");
    const marker = await provider.readDestinationMarker(observed.entry.id);
    if (!markerMatches(marker, state.marker)) codes.push("provenance_mismatch");
    await assertSourceStable(provider, source);
    if (source.kind === "file") {
      try {
        const content = await hashStream(provider.openSourceContent(source.id), ctx.signal);
        fingerprint = content.sha256;
        if (source.size !== null && content.size !== source.size)
          throw new FileSourceChangedError(source.id);
      } catch (error) {
        if (!terminalUnavailable(error)) throw error;
        codes.push("source_read_failed");
      }
      if (observed.entry.size !== source.size) codes.push("size_mismatch");
      if (observed.sha256 === null) codes.push("content_verification_degraded");
      else if (fingerprint !== null && observed.sha256 !== fingerprint)
        codes.push("content_mismatch");
      if (
        Date.parse(observed.entry.createdAt) !== Date.parse(state.output.createdAt) ||
        second(observed.entry.modifiedAt) !== second(source.modifiedAt) ||
        observed.entry.mimeType !== source.mimeType
      ) {
        codes.push("metadata_mismatch");
      }
    }
    await assertSourceStable(provider, source);
    const latest = await observe(ctx, observed.entry);
    if (latest.sha256 !== observed.sha256) codes.push("prior_copy_drift");
    const latestMarker = await provider.readDestinationMarker(observed.entry.id);
    if (!markerMatches(latestMarker, state.marker)) codes.push("provenance_mismatch");
    await assertSourceStable(provider, source);
    // A clean match to today's source cannot erase an independently drifted
    // last output or a durable/marker disagreement.
    const priorDifferences = outputFindings(observed, state.output);
    if (priorDifferences.some((code) => code !== "content_verification_degraded"))
      codes.push("prior_copy_drift");
  }
  const unique = [...new Set(codes)];
  const evidence = row(ctx, "verify", tree.mapping, source, unique[0] ?? "unchanged", state);
  evidence.sourceFingerprint = fingerprint;
  evidence.destinationFingerprint = observed?.sha256 ?? null;
  evidence.provenanceState = unique.length ? "drifted" : "verified";
  return commit(
    ctx,
    "verify",
    evidence,
    [
      ...unique.map((code) => finding(ctx, "verify", code, source.id, { path: source.path })),
      ...metadataOmissions(ctx, "verify", source),
    ],
    "verification",
    done,
  );
}

async function* preflight(ctx: FileContext): AsyncIterable<CheckResult> {
  const provider: FileProvider = ctx.provider;
  for (const mapping of ctx.config.mappings) {
    const source = await provider.resolveSourceRoot(mapping);
    const destination = await provider.resolveDestinationFolder(mapping);
    const pass =
      source?.kind === "folder" &&
      source.driveId === mapping.sourceDriveId &&
      destination?.kind === "folder" &&
      destination.driveId === mapping.destDriveId;
    yield {
      id: `mapping:${mapping.id}`,
      title: "Exact mapping roots resolve as ordinary folders",
      status: pass ? "pass" : "fail",
      ...(pass ? {} : { code: "unsupported_route" }),
      evidence: {
        sourceItemId: mapping.sourceItemId,
        sourceDriveId: mapping.sourceDriveId,
        destFolderId: mapping.destFolderId,
        destDriveId: mapping.destDriveId,
        sourcePresent: source !== null,
        destinationPresent: destination !== null,
      },
    };
  }
}

async function* reportSections(ctx: FileContext): AsyncIterable<ReportSection> {
  yield {
    title: "File migration fidelity and additive retention",
    format: "text",
    body: [
      "Current downloadable binary file version only; counted version history is omitted.",
      "Permissions and ownership were not assessed and were not migrated.",
      "Destination drives and mapping roots are supplied and administered outside Migmate.",
      "Destination-only content and source-deleted prior copies are retained, never deleted.",
      "Files retain exact names, hierarchy, bytes, size, initial created time, modified time at one-second precision, and MIME type without conversion.",
      "Folder timestamps and richer source metadata are evidence only, never recreated as destination properties or per-file sidecars.",
      "Verification is a timestamped point-in-time statement, not a source freeze, cutover, settled delta, or future-drift guarantee.",
    ].join("\n"),
  };
  yield {
    title: "Measured release limits",
    format: "text",
    body: [
      "Destination change detection is a compare-then-write, never an atomic conditional update: Drive publishes no ETag and honours no update precondition, so an edit landing between the comparison and the write is detected by the next verification pass rather than prevented.",
      "The destination concurrency token is the revision and modified time Drive does publish, measured holding still on one file across one window while Drive's own version field advanced with no writer present; Google promises no such stability, so a server-side move refuses prior_copy_drift instead of overwriting.",
      "Transfer-binary behaviour is pinned to one exact version, recorded with its path and digest in the preflight evidence; any other version refuses.",
      "The source grant is proven sufficient for the Graph calls this release makes, not promised for wider use: a call needing more permission refuses rather than degrading to a partial result.",
    ].join("\n"),
  };
  for (const mapping of ctx.config.mappings) {
    yield {
      title: `Mapping ${mapping.id}`,
      format: "text",
      body: JSON.stringify({
        sourceDriveId: mapping.sourceDriveId,
        sourceItemId: mapping.sourceItemId,
        destDriveId: mapping.destDriveId,
        destFolderId: mapping.destFolderId,
        revision: ctx.revision,
      }),
    };
  }
  const evidence = (ctx.resume.rows ?? [])
    .filter((item): item is FileEvidenceRow => item.jobType === "file_migration")
    .filter((item) => item.sourceEvidence !== undefined)
    .map((item) => ({
      mappingId: item.mappingId,
      sourceDriveId: item.sourceDriveId,
      sourceItemId: item.sourceItemId,
      relativePath: item.relativePath,
      phase: item.phase,
      sourceEvidence: item.sourceEvidence,
    }));
  yield {
    title: "Structured source-only metadata evidence",
    format: "text",
    body: JSON.stringify(evidence),
  };
}

export const fileMigrationDriver: JobTypeDriver<FileMigrationConfig> = {
  preflight,
  collect(ctx) {
    return runPhase(ctx, "plan");
  },
  execute(ctx) {
    return runPhase(ctx, "execute");
  },
  verify(ctx) {
    return runPhase(ctx, "verify");
  },
  reportSections,
};

export function createFileMigrationDriver(): JobTypeDriver<FileMigrationConfig> {
  return fileMigrationDriver;
}
