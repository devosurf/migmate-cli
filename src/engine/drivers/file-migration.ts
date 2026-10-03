import { createHash } from "node:crypto";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CODE_BY_NAME } from "../codes.ts";
import type { CheckResult, MappingPass } from "../types.ts";
import { HttpProviderFault, retryableStatus } from "../providers/http.ts";
import type {
  CopyPassReference,
  DestinationEntry,
  DriveMember,
  ProviderPort,
  SourceEntry,
} from "../providers/port.ts";
import type { CommitFinding, CommitUnit, JobTypeDriver, ReportSection } from "./types.ts";
import {
  FilePlanRevisionRequiredError,
  hashStream,
  terminalUnavailable,
  sourceEvidence,
  type FileContext,
  type FileEvidenceRow,
  type FileExclusion,
} from "./file-state.ts";

export interface FileMappingConfig {
  id: string;
  sourceType?: "sharepoint" | "google_shared_drive";
  sourceDriveId: string;
  sourceItemId: string;
  sourceFolderPath?: string;
  destDriveId?: string;
  destFolderId?: string;
  destFolderPath?: string;
  createDrive?: { name: string; members: DriveMember[] };
  exclusions?: FileExclusion[];
}

export interface FileMigrationConfig {
  /** Fixes the direction of every mapping; defaults to SharePoint → Google Shared Drive. */
  route?: string;
  mappings: FileMappingConfig[];
  impersonate?: boolean;
  subject?: string;
  options?: {
    verificationMode?: "hash" | "size_only";
    mappingsInFlight?: number;
    transfersPerMapping?: number;
    mirror?: boolean;
    deleteLimit?: number;
  };
}

const COPY_DEFAULTS = { mappingsInFlight: 2, transfersPerMapping: 4 };
/** PDF, Office and HTML files SharePoint may rewrite on upload (docs/research/provider-byte-integrity.md). */
const SHAREPOINT_REWRITTEN_TYPES =
  /\.(pdf|docx?|docm|dotx?|dotm|xlsx?|xlsm|xlsb|xltx?|xltm|pptx?|pptm|potx?|potm|ppsx?|ppsm|html?|mhtml?)$/i;

/** Google source drives the acting account cannot read, checked as that account. */
export async function unreadableSourceDrives(
  provider: Pick<ProviderPort, "readSharedDrive">,
  mappings: { sourceType?: string; sourceDriveId: string }[],
): Promise<string[]> {
  const unreadable: string[] = [];
  for (const driveId of new Set(
    mappings.filter((m) => m.sourceType === "google_shared_drive").map((m) => m.sourceDriveId),
  )) {
    try {
      if ((await provider.readSharedDrive(driveId))?.id !== driveId) unreadable.push(driveId);
    } catch {
      unreadable.push(driveId);
    }
  }
  return unreadable;
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

function destinationMapping(
  mapping: FileMappingConfig,
): FileMappingConfig & { destDriveId: string; destFolderId: string } {
  if (!mapping.destDriveId || !mapping.destFolderId)
    throw new Error(`Mapping ${mapping.id} has no provisioned destination`);
  return { ...mapping, destDriveId: mapping.destDriveId, destFolderId: mapping.destFolderId };
}

function provisionedMapping(ctx: FileContext, mapping: FileMappingConfig): FileMappingConfig {
  if (!mapping.createDrive) return mapping;
  const drive = ctx.resume.createdDrives?.find((d) => d.mappingId === mapping.id);
  return drive?.driveId
    ? { ...mapping, destDriveId: drive.driveId, destFolderId: drive.driveId }
    : mapping;
}

async function* provision(ctx: FileContext): AsyncIterable<CommitUnit> {
  for (const mapping of ctx.config.mappings) {
    if (!mapping.createDrive) continue;
    let drive = ctx.resume.createdDrives?.find((d) => d.mappingId === mapping.id);
    const recovering = drive !== undefined;
    const unit = (key: string): CommitUnit => ({
      rev: ctx.revision,
      phase: "execute",
      unitKey: JSON.stringify(["provision", mapping.id, key]),
      checkpoint: mapping.id,
      rows: [],
      findings: [],
    });
    if (!drive) {
      drive = {
        mappingId: mapping.id,
        requestId: digest([basename(ctx.jobDirectory), mapping.id]),
        name: mapping.createDrive.name,
        driveId: null,
        creatorEmail: (await ctx.provider.googleAbout()).user.emailAddress,
        intentAt: ctx.now().toISOString(),
      };
      yield { ...unit("intent"), createdDrive: drive };
    }
    if (!drive.driveId) {
      const recover = async () => {
        const matches = await ctx.provider.findSharedDrives(drive!.name);
        if (matches.length > 1)
          throw Object.assign(new Error("Several Shared Drives match the planned name."), {
            code: "drive_creation_ambiguous",
            detail: { mappingId: mapping.id, name: drive!.name, candidates: matches },
          });
        const match = matches[0];
        if (
          match &&
          !(
            drive!.intentAt &&
            match.createdTime &&
            Date.parse(match.createdTime) >= Date.parse(drive!.intentAt)
          )
        )
          throw Object.assign(
            new Error(
              "The matching Shared Drive has no creation evidence after this job's intent.",
            ),
            {
              code: "drive_creation_ambiguous",
              detail: {
                mappingId: mapping.id,
                name: drive!.name,
                intentAt: drive!.intentAt ?? null,
                candidates: matches,
              },
            },
          );
        if (match)
          drive = {
            ...drive!,
            provenance: { kind: "name_recovery", createdTime: match.createdTime! },
          };
        return matches[0] ?? null;
      };
      let created = recovering ? await recover() : null;
      if (!created) {
        try {
          created = await ctx.provider.createSharedDrive({
            name: drive.name,
            requestId: drive.requestId,
          });
          if (created) drive = { ...drive, provenance: { kind: "create_response" } };
        } catch (error) {
          if (
            !(error instanceof TypeError) &&
            !(error instanceof HttpProviderFault && retryableStatus(error.status))
          )
            throw error;
        }
        if (!created) created = await recover();
        if (!created) {
          created = await ctx.provider.createSharedDrive({
            name: drive.name,
            requestId: drive.requestId,
          });
          if (created) drive = { ...drive, provenance: { kind: "create_response" } };
        }
        if (!created)
          throw Object.assign(
            new Error("Drive creation is not yet visible; retry the same request."),
            {
              code: "provider_request_failed",
              transient: true,
            },
          );
      }
      drive = { ...drive, driveId: created.id };
      // The engine commits this yield before requesting the first permission.
      yield { ...unit("created"), createdDrive: drive };
    }
    for (const member of mapping.createDrive.members) {
      if (
        ctx.resume.memberGrants?.some(
          (grant) =>
            grant.mappingId === mapping.id &&
            grant.driveId === drive!.driveId &&
            grant.member.email === member.email &&
            grant.member.type === member.type &&
            grant.member.role === member.role,
        )
      )
        continue;
      const members = await ctx.provider.listDriveMembers(drive.driveId!);
      if (
        !members.some(
          (m) =>
            m.email.toLowerCase() === member.email.toLowerCase() &&
            m.type === member.type &&
            m.role === member.role,
        )
      )
        await ctx.provider.addDriveMember(drive.driveId!, member);
      yield {
        ...unit(`member:${digest(member)}`),
        memberGrant: {
          mappingId: mapping.id,
          driveId: drive.driveId!,
          member,
        },
      };
    }
    ctx.resume.createdDrives = [
      ...(ctx.resume.createdDrives ?? []).filter((d) => d.mappingId !== mapping.id),
      drive,
    ];
  }
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
    sourceFingerprint: null,
    destinationDriveId: null,
    destinationFileId: null,
    destinationFingerprint: null,
    provenanceState: "none",
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
  const unitKey = JSON.stringify([
    evidence.mappingId,
    evidence.sourceItemId,
    phase,
    suffix,
    digest([evidence.sourceEvidence, evidence.code, evidence.fileScope?.exclusions]),
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

async function sourceInventory(
  ctx: FileContext,
  mapping: FileMappingConfig,
): Promise<SourceView[]> {
  const sourceRoot = await ctx.provider.resolveSourceRoot(mapping);
  if (!sourceRoot || sourceRoot.kind !== "folder" || sourceRoot.driveId !== mapping.sourceDriveId)
    throw Object.assign(new Error("The source root is missing or is not an ordinary folder"), {
      code: "unsupported_route",
    });
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
  return sources;
}

async function snapshot(ctx: FileContext, mapping: FileMappingConfig): Promise<Snapshot> {
  const sources = await sourceInventory(ctx, mapping);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  if (mapping.createDrive && !mapping.destDriveId)
    return {
      mapping,
      sources,
      sourceById,
      destinations: [],
      destinationById: new Map(),
      destinationByPath: new Map(),
    };
  const destinationRoot = await ctx.provider.resolveDestinationFolder(destinationMapping(mapping));
  if (
    !destinationRoot ||
    destinationRoot.kind !== "folder" ||
    destinationRoot.driveId !== mapping.destDriveId
  )
    throw Object.assign(new Error("The destination root is missing or is not an ordinary folder"), {
      code: "unsupported_route",
    });
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
          code: "unsupported_route",
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

function expandedExclusions(tree: Pick<Snapshot, "mapping" | "sources">): FileExclusion[] {
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

function pendingPass(
  revision: number,
  mappingId: string,
  passNumber: number,
  mode: MappingPass["mode"],
): MappingPass {
  return {
    revision,
    mappingId,
    passNumber,
    mode,
    executeId: null,
    jobid: null,
    group: null,
    status: "pending",
    startedAt: null,
    endedAt: null,
    lastStats: null,
    error: null,
  };
}

async function* collect(ctx: FileContext): AsyncIterable<CommitUnit> {
  const trees: Snapshot[] = [];
  for (const mapping of ctx.config.mappings)
    trees.push(await snapshot(ctx, provisionedMapping(ctx, mapping)));
  const overlapping = new Set<string>();
  for (let left = 0; left < trees.length; left++) {
    for (let right = left + 1; right < trees.length; right++) {
      const a = trees[left]!;
      const b = trees[right]!;
      if (
        a.mapping.id === b.mapping.id ||
        (a.mapping.sourceDriveId === b.mapping.sourceDriveId &&
          (a.sourceById.has(b.mapping.sourceItemId) || b.sourceById.has(a.mapping.sourceItemId))) ||
        (a.mapping.destDriveId !== undefined &&
          a.mapping.destDriveId === b.mapping.destDriveId &&
          (a.destinationById.has(b.mapping.destFolderId!) ||
            b.destinationById.has(a.mapping.destFolderId!)))
      ) {
        overlapping.add(a.mapping.id);
        overlapping.add(b.mapping.id);
      }
    }
  }
  let done = 0;
  for (const tree of trees) {
    const { mapping } = tree;
    const exclusions = expandedExclusions(tree);
    const excluded = new Map(exclusions.map((item) => [item.sourceItemId, item.reason]));
    for (const source of tree.sources) {
      if (overlapping.has(mapping.id) && source.path !== ".") continue;
      const code = overlapping.has(mapping.id)
        ? "mapping_overlap"
        : excluded.has(source.id)
          ? "omitted_by_rule"
          : (sourceOmission(source) ?? (source.path === "." ? "unchanged" : "created"));
      const evidence = row(ctx, "plan", mapping, source, code);
      if (source.path === ".") {
        evidence.destinationDriveId = mapping.destDriveId ?? null;
        evidence.destinationFileId = mapping.destFolderId ?? null;
        evidence.fileScope = { exclusions, sourceInventoryAt: ctx.now().toISOString() };
      }
      const unit = commit(
        ctx,
        "plan",
        evidence,
        code === "created" || code === "unchanged"
          ? metadataOmissions(ctx, "plan", source)
          : [
              finding(ctx, "plan", code, source.id, {
                path: source.path,
                ...(excluded.has(source.id) ? { reason: excluded.get(source.id) } : {}),
              }),
            ],
        "plan",
        ++done,
      );
      if (source.path === ".")
        unit.mappingPass = pendingPass(
          ctx.revision,
          mapping.id,
          1,
          ctx.config.options?.mirror ? "mirror" : "copy",
        );
      yield unit;
    }
  }
}

async function* execute(ctx: FileContext): AsyncIterable<CommitUnit> {
  yield* provision(ctx);
  const mappings = ctx.config.mappings[Symbol.iterator]();
  const active = new Set<AsyncGenerator<CommitUnit>>();
  const limit = ctx.config.options?.mappingsInFlight ?? COPY_DEFAULTS.mappingsInFlight;
  let exhausted = false;
  try {
    while (active.size || !exhausted) {
      while (!ctx.signal?.aborted && !exhausted && active.size < limit) {
        const next = mappings.next();
        if (next.done) exhausted = true;
        else active.add(copyMapping(ctx, provisionedMapping(ctx, next.value)));
      }
      if (!active.size) break;
      let progressed = false;
      for (const iterator of active) {
        const next = await iterator.next();
        if (next.done) {
          active.delete(iterator);
          progressed = true;
          continue;
        }
        const pass = next.value.mappingPass!;
        if (pass.status !== "pending" && pass.status !== "running") {
          active.delete(iterator);
          await iterator.return(undefined);
          progressed = true;
        } else if (!pass.lastStats) {
          progressed = true;
        }
        yield next.value;
      }
      if (!progressed && !ctx.signal?.aborted) {
        // Passes run in rclone; only their durable observations are serialized here.
        await delay(100, undefined, { signal: ctx.signal }).catch((error) => {
          if (!ctx.signal?.aborted) throw error;
        });
      }
    }
  } finally {
    // An engine/store failure must still stop every pass, even if one stop fails.
    const stopped = await Promise.allSettled(
      [...active].map((iterator) => iterator.return(undefined)),
    );
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

async function* copyMapping(
  ctx: FileContext,
  mapping: FileMappingConfig,
): AsyncGenerator<CommitUnit> {
  const previous = (ctx.resume.mappingPasses ?? [])
    .filter((pass) => pass.mappingId === mapping.id)
    .at(-1);
  if (previous?.status === "completed") return;
  let pass =
    previous?.status === "pending"
      ? previous
      : pendingPass(
          ctx.revision,
          mapping.id,
          (previous?.passNumber ?? 0) + 1,
          ctx.config.options?.mirror ? "mirror" : "copy",
        );
  pass = { ...pass, startedAt: ctx.now().toISOString() };
  let sequence = 0;
  const unit = (): CommitUnit => ({
    rev: ctx.revision,
    phase: "execute",
    unitKey: JSON.stringify(["mapping", mapping.id, pass.passNumber, sequence++]),
    checkpoint: mapping.id,
    rows: [],
    findings: [],
    mappingPass: { ...pass },
  });
  yield unit();
  let reference: CopyPassReference | undefined;
  try {
    ctx.signal?.throwIfAborted();
    if (ctx.config.options?.mirror) {
      const drive = ctx.resume.createdDrives?.find((d) => d.mappingId === mapping.id);
      const proven =
        drive?.provenance?.kind === "create_response" ||
        (drive?.provenance?.kind === "name_recovery" &&
          drive.intentAt &&
          Date.parse(drive.provenance.createdTime) >= Date.parse(drive.intentAt));
      if (!mapping.createDrive || drive?.driveId !== mapping.destDriveId || !proven)
        throw new Error(
          "Mirror requires proven job-created drive provenance; this mapping cannot delete.",
        );
    }
    const sources = await sourceInventory(ctx, mapping);
    const excluded = new Set(
      expandedExclusions({ mapping, sources }).map((item) => item.sourceItemId),
    );
    const resolved = await ctx.provider.resolveFilePass(destinationMapping(mapping));
    const handle = await ctx.provider.startCopyPass({
      ...resolved,
      ...(ctx.config.options?.mirror
        ? { mode: "mirror" as const, deleteLimit: ctx.config.options.deleteLimit! }
        : { mode: "copy" as const }),
      transfers: ctx.config.options?.transfersPerMapping ?? COPY_DEFAULTS.transfersPerMapping,
      excludePaths: sources
        .filter((source) => excluded.has(source.id) || sourceOmission(source))
        .map((source) => source.path),
    });
    reference = { socketPath: resolved.socketPath, pass: handle };
    pass = { ...pass, ...handle, status: "running", startedAt: ctx.now().toISOString() };
    yield unit();
    for (;;) {
      ctx.signal?.throwIfAborted();
      const status = await ctx.provider.copyPassStatus(reference);
      const lastStats = await ctx.provider.copyPassStats(reference);
      pass = {
        ...pass,
        status: status.state,
        error: status.error,
        lastStats,
        endedAt: status.state === "running" ? null : ctx.now().toISOString(),
      };
      yield unit();
      if (status.state !== "running") break;
    }
  } catch (error) {
    const interrupted =
      ctx.signal?.aborted || (error instanceof Error && error.name === "AbortError");
    if (reference) {
      await ctx.provider.stopCopyPass(reference);
      reference = undefined;
    }
    pass = {
      ...pass,
      status: interrupted ? "interrupted" : "failed",
      error: interrupted ? null : error instanceof Error ? error.message : String(error),
      endedAt: ctx.now().toISOString(),
    };
    yield unit();
    if (interrupted) return;
  } finally {
    if (reference && pass.status === "running") await ctx.provider.stopCopyPass(reference);
  }
}

async function* verify(ctx: FileContext): AsyncIterable<CommitUnit> {
  let done = 0;
  const sizeOnly = ctx.config.options?.verificationMode === "size_only";
  for (const planned of ctx.config.mappings) {
    const mapping = provisionedMapping(ctx, planned);
    const sources = await sourceInventory(ctx, mapping);
    if (mapping.createDrive) {
      const drive = ctx.resume.createdDrives?.find((d) => d.mappingId === mapping.id);
      if (!drive?.driveId) throw new Error("Verification requires the durable created drive");
      const expected = [...mapping.createDrive.members];
      if (
        !expected.some(
          (member) =>
            member.type === "user" &&
            member.email.toLowerCase() === drive.creatorEmail.toLowerCase(),
        )
      )
        expected.push({ email: drive.creatorEmail, type: "user", role: "organizer" });
      const actual = await ctx.provider.listDriveMembers(drive.driveId);
      const identities = (members: typeof actual) =>
        members
          .map((member) => JSON.stringify([member.email.toLowerCase(), member.type, member.role]))
          .sort();
      if (JSON.stringify(identities(expected)) !== JSON.stringify(identities(actual))) {
        const evidence = row(ctx, "verify", mapping, sources[0]!, "drive_membership_mismatch");
        evidence.destinationDriveId = drive.driveId;
        evidence.destinationFileId = drive.driveId;
        yield commit(
          ctx,
          "verify",
          evidence,
          [
            finding(ctx, "verify", "drive_membership_mismatch", mapping.id, {
              mappingId: mapping.id,
              driveId: drive.driveId,
              expected,
              actual,
            }),
          ],
          "drive-membership",
          ++done,
        );
      }
    }
    const scope = (ctx.resume.rows ?? []).find(
      (candidate): candidate is FileEvidenceRow =>
        candidate.jobType === "file_migration" &&
        candidate.mappingId === mapping.id &&
        candidate.rev === ctx.revision &&
        candidate.phase === "plan" &&
        candidate.fileScope !== undefined,
    )?.fileScope;
    if (!scope) throw new FilePlanRevisionRequiredError();
    const excluded = new Map(scope.exclusions.map((item) => [item.sourceItemId, item.reason]));
    const expanded = expandedExclusions({ mapping, sources });
    const current = new Map(expanded.map((item) => [item.sourceItemId, item.reason]));
    if (
      expanded.some((item) => excluded.get(item.sourceItemId) !== item.reason) ||
      sources.some(
        (source) => excluded.has(source.id) && current.get(source.id) !== excluded.get(source.id),
      )
    )
      throw new FilePlanRevisionRequiredError();
    if (sizeOnly) {
      const evidence = row(ctx, "verify", mapping, sources[0]!, "content_verification_degraded");
      yield commit(
        ctx,
        "verify",
        evidence,
        [
          finding(ctx, "verify", "content_verification_degraded", mapping.id, {
            verificationMode: "size_only",
          }),
        ],
        "verification-mode",
        ++done,
      );
    }
    const pass = await ctx.provider.resolveFilePass(destinationMapping(mapping));
    const primaryHash = mapping.sourceType === "google_shared_drive" ? "quickxor" : "sha256";
    const sourceHashes = new Map(
      (
        await ctx.provider.listFileHashes({
          socketPath: pass.socketPath,
          root: pass.source,
          hashType: primaryHash,
          download: !sizeOnly,
        })
      ).map((entry) => [entry.path, entry]),
    );
    const destinationHashes = new Map(
      (
        await ctx.provider.listFileHashes({
          socketPath: pass.socketPath,
          root: pass.destination,
          hashType: primaryHash,
          download: false,
        })
      ).map((entry) => [entry.path, entry]),
    );
    const needsMd5 =
      !sizeOnly &&
      primaryHash === "sha256" &&
      [...destinationHashes.values()].some((entry) => entry.hash === null);
    const sourceMd5 = new Map(
      needsMd5
        ? (
            await ctx.provider.listFileHashes({
              socketPath: pass.socketPath,
              root: pass.source,
              hashType: "md5",
              download: true,
            })
          ).map((entry) => [entry.path, entry])
        : [],
    );
    const destinationMd5 = new Map(
      needsMd5
        ? (
            await ctx.provider.listFileHashes({
              socketPath: pass.socketPath,
              root: pass.destination,
              hashType: "md5",
              download: false,
            })
          ).map((entry) => [entry.path, entry])
        : [],
    );
    for (const source of sources) {
      const omission = excluded.has(source.id)
        ? "omitted_by_rule"
        : source.kind === "file" || source.kind === "undownloadable"
          ? null
          : sourceOmission(source);
      if (omission) {
        yield commit(
          ctx,
          "verify",
          row(ctx, "verify", mapping, source, omission),
          [
            finding(ctx, "verify", omission, source.id, {
              path: source.path,
              ...(excluded.has(source.id) ? { reason: excluded.get(source.id) } : {}),
            }),
          ],
          "omission",
          ++done,
        );
        continue;
      }
      if (source.kind === "folder") continue;
      const hashType =
        needsMd5 && destinationHashes.get(source.path)?.hash === null ? "md5" : primaryHash;
      const downloaded = (hashType === "md5" ? sourceMd5 : sourceHashes).get(source.path);
      const destination = (hashType === "md5" ? destinationMd5 : destinationHashes).get(
        source.path,
      );
      const codes: string[] = [];
      let servedSize = downloaded?.size ?? source.size;
      if (
        primaryHash === "sha256" &&
        !sizeOnly &&
        downloaded?.hash &&
        destination &&
        (downloaded.size !== destination.size || downloaded.hash !== destination.hash)
      ) {
        // Equal content hashes also prove the served length. If content differs,
        // measure the download before blaming the destination's listed size.
        if (downloaded.hash === destination.hash) servedSize = destination.size;
        else {
          try {
            const measured = await hashStream(
              ctx.provider.openSourceContent(source.id),
              ctx.signal,
            );
            if (measured.sha256 !== sourceHashes.get(source.path)?.hash)
              codes.push("source_read_failed");
            else servedSize = measured.size;
          } catch (error) {
            if (!terminalUnavailable(error)) throw error;
            codes.push("source_read_failed");
          }
        }
        if (servedSize !== downloaded.size) codes.push("source_size_inconsistent");
      }
      if (!destination) codes.push("destination_missing");
      if (!sizeOnly && !downloaded?.hash) codes.push("source_read_failed");
      if (destination && downloaded) {
        // SharePoint may rewrite these types, changing length and hash together: one
        // reviewable finding, so accepting it never also accepts a corrupted file's size_mismatch.
        const rewritten =
          !sizeOnly &&
          mapping.sourceType === "google_shared_drive" &&
          SHAREPOINT_REWRITTEN_TYPES.test(source.path) &&
          destination.hash !== null &&
          !!downloaded.hash &&
          destination.hash !== downloaded.hash;
        if (rewritten) codes.push("destination_rewrote_file");
        else {
          if (servedSize !== destination.size) codes.push("size_mismatch");
          if (!sizeOnly) {
            if (destination.hash === null) codes.push("content_verification_degraded");
            else if (downloaded.hash && destination.hash !== downloaded.hash)
              codes.push("content_mismatch");
          }
        }
      }
      const evidence = row(ctx, "verify", mapping, source, codes[0] ?? "unchanged");
      evidence.destinationDriveId = mapping.destDriveId ?? null;
      evidence.destinationFileId = destination?.id ?? null;
      evidence.sourceFingerprint = downloaded?.hash ?? null;
      evidence.destinationFingerprint = destination?.hash ?? null;
      evidence.provenanceState = codes.some((code) => code !== "source_size_inconsistent")
        ? "drifted"
        : "verified";
      yield commit(
        ctx,
        "verify",
        evidence,
        codes
          .map((code) =>
            finding(ctx, "verify", code, source.id, {
              path: source.path,
              sourceSize: servedSize,
              destinationSize: destination?.size ?? null,
              sourceHash: downloaded?.hash ?? null,
              destinationHash: destination?.hash ?? null,
              hashType: sizeOnly ? null : hashType,
              ...(codes.includes("source_size_inconsistent")
                ? {
                    listedSize: downloaded?.size,
                    ...(code === "source_size_inconsistent" ? { servedSize } : {}),
                    ...(code === "size_mismatch" || code === "content_mismatch"
                      ? { cause: "source_size_inconsistent" }
                      : {}),
                  }
                : {}),
            }),
          )
          .concat(metadataOmissions(ctx, "verify", source)),
        "verification",
        ++done,
      );
    }
    for (const destination of destinationHashes.values()) {
      if (sourceHashes.has(destination.path)) continue;
      const source: SourceView = {
        ...sources[0]!,
        id: `destination:${destination.path}`,
        path: destination.path,
        kind: "file",
        size: destination.size,
      };
      const evidence = row(ctx, "verify", mapping, source, "destination_only_retained");
      evidence.destinationDriveId = mapping.destDriveId ?? null;
      evidence.destinationFileId = destination.id ?? null;
      // MD5 labels the hash only when the MD5 fallback listing actually supplied it.
      const md5 = destination.hash === null ? destinationMd5.get(destination.path) : undefined;
      const stored = md5 ?? destination;
      evidence.destinationFingerprint = stored.hash;
      yield commit(
        ctx,
        "verify",
        evidence,
        [
          finding(ctx, "verify", "destination_only_retained", source.id, {
            path: destination.path,
            sourceSize: null,
            destinationSize: destination.size,
            sourceHash: null,
            destinationHash: stored.hash,
            hashType: sizeOnly ? null : md5 ? "md5" : primaryHash,
          }),
        ],
        "retained",
        ++done,
      );
    }
  }
}

async function* preflight(ctx: FileContext): AsyncIterable<CheckResult> {
  const provider = ctx.provider;
  if (ctx.config.impersonate) {
    let actualSubject: string | null = null;
    try {
      actualSubject = (await provider.googleAbout()).user.emailAddress;
    } catch {
      // Token refusal and inaccessible identity are both delegation prerequisites.
    }
    const pass = actualSubject === ctx.config.subject;
    yield {
      id: "google.delegation",
      title: "Google acts as the configured subject",
      status: pass ? "pass" : "fail",
      ...(pass ? {} : { code: "preflight_failed" }),
      evidence: {
        subject: ctx.config.subject,
        actualSubject,
        ...(!pass
          ? {
              fix: "Authorize domain-wide delegation for the service account's numeric client id with only https://www.googleapis.com/auth/drive, and use an ordinary non-admin subject.",
            }
          : {}),
      },
    };
    if (!pass) return;
  }
  if (ctx.config.mappings.some((m) => m.createDrive)) {
    let canCreateDrives = false;
    try {
      canCreateDrives = (await provider.googleAbout()).canCreateDrives;
    } catch {}
    yield {
      id: "google.canCreateDrives",
      title: "Acting account may create Shared Drives",
      status: canCreateDrives ? "pass" : "fail",
      ...(canCreateDrives ? {} : { code: "preflight_failed" }),
      evidence: { canCreateDrives },
    };
    if (!canCreateDrives) return;
  }
  const unreadable = await unreadableSourceDrives(provider, ctx.config.mappings);
  if (unreadable.length) {
    yield {
      id: "google.source_drives",
      title: "Acting account can read every source Shared Drive",
      status: "fail",
      code: "preflight_failed",
      evidence: {
        unreadableSourceDrives: unreadable,
        subject: ctx.config.subject ?? null,
        fix: "Add the acting account as a member of every named source Shared Drive.",
      },
    };
    return;
  }
  for (const mapping of ctx.config.mappings) {
    const source = await provider.resolveSourceRoot(mapping);
    const destination =
      mapping.createDrive && !mapping.destDriveId
        ? null
        : await provider.resolveDestinationFolder(destinationMapping(mapping));
    const pass =
      source?.kind === "folder" &&
      source.driveId === mapping.sourceDriveId &&
      (mapping.createDrive !== undefined ||
        (destination?.kind === "folder" && destination.driveId === mapping.destDriveId));
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
  const drives = ctx.config.mappings
    .filter((m) => m.createDrive)
    .map((m) => ({
      mappingId: m.id,
      ...m.createDrive!,
    }));
  if (drives.length)
    yield { title: "Shared Drives to create", format: "text", body: JSON.stringify(drives) };
  if (ctx.resume.createdDrives?.length)
    yield {
      title: "Created Shared Drives and members",
      format: "text",
      body: JSON.stringify({
        drives: ctx.resume.createdDrives,
        grants: ctx.resume.memberGrants ?? [],
      }),
    };
  yield { title: "Route", format: "text", body: JSON.stringify({ route: ctx.config.route }) };
  yield {
    title: "Acting Google account",
    format: "text",
    body: ctx.config.impersonate
      ? `Acting account: ${ctx.config.subject} (domain-wide delegation).`
      : "The service account acts as itself (impersonation off).",
  };
  if (ctx.config.impersonate)
    yield {
      title: "Open cleanup items",
      format: "text",
      body: "Delete the service-account key after the job.\nDelete the domain-wide delegation entry after the job.",
    };
  yield {
    title: "Verification mode",
    format: "text",
    body: JSON.stringify({ verificationMode: ctx.config.options?.verificationMode ?? "hash" }),
  };
  yield {
    title: "Mirror",
    format: "text",
    body: JSON.stringify({
      mirror: ctx.config.options?.mirror ?? false,
      deleteLimit: ctx.config.options?.mirror ? ctx.config.options.deleteLimit : null,
    }),
  };
  yield {
    title: "Copy concurrency",
    format: "text",
    body: JSON.stringify({
      mappingsInFlight: ctx.config.options?.mappingsInFlight ?? COPY_DEFAULTS.mappingsInFlight,
      transfersPerMapping:
        ctx.config.options?.transfersPerMapping ?? COPY_DEFAULTS.transfersPerMapping,
    }),
  };
  yield {
    title: "File migration fidelity and retention",
    format: "text",
    body: [
      "Current downloadable binary file version only; counted version history is omitted.",
      "Permissions and ownership were not assessed and were not migrated.",
      "Manifest-created Shared Drives receive only the listed member grants; existing destinations remain administered outside Migmate.",
      ctx.config.options?.mirror
        ? `Mirror removes destination-only content in job-created drives, capped at ${ctx.config.options.deleteLimit} file deletions per mapping pass; exceeding the limit fails that mapping.`
        : "Destination-only content and source-deleted prior copies are retained, never deleted.",
      "rclone copies mappings concurrently within the approved limit in one managed worker, preserves supported created and modified times and file types, and creates empty source directories, which keep modification times only. Owner, permission and label metadata are not copied.",
      "Copy passes can replace same-path content; private markers, reserved ids, move-by-id and compare-then-write protection are not used for file migrations.",
      "Verification is a timestamped point-in-time statement, not a source freeze, cutover, settled delta, or future-drift guarantee.",
    ].join("\n"),
  };
  yield {
    title: "Measured release limits",
    format: "text",
    body: [
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
        passes: (ctx.resume.mappingPasses ?? []).filter((pass) => pass.mappingId === mapping.id),
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
  collect,
  execute,
  verify,
  reportSections,
};

export function createFileMigrationDriver(): JobTypeDriver<FileMigrationConfig> {
  return fileMigrationDriver;
}
