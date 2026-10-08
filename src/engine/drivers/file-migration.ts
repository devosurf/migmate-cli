import { createHash } from "node:crypto";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CODE_BY_NAME } from "../codes.ts";
import { canonicalJson } from "../store/digest.ts";
import type { CheckResult, MappingPass } from "../types.ts";
import { HttpProviderFault, retryableStatus } from "../providers/http.ts";
import type {
  CopyPassReference,
  DestinationEntry,
  DriveMember,
  FilePassPreview,
  FilePassRoot,
  DriveMembership,
  FileHashEntry,
  GoogleAbout,
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
  type FileSettleState,
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
    oneNoteNotebooks?: "omit" | "copy";
    mappingsInFlight?: number;
    transfersPerMapping?: number;
    mirror?: boolean;
    deleteLimit?: number;
    /** ADR-0012 A1: the job runs prestage, deltas and a final revision before go-live. */
    staged?: boolean;
    deltaVerification?: "full" | "changed";
    consistencyIntervalMs?: number;
    settleMaxPasses?: number;
    /** ADR-0012 A6: when manifest members are granted. Default follows `staged`. */
    memberGrants?: "before_copy" | "after_verification";
    /** Plan-phase planned omissions accepted in advance by approving the plan that names them. */
    acceptedOmissions?: string[];
    /**
     * `rclone`: the plan approves mapping roots only; rclone lists files when it copies, and
     * verification compares rclone listings by path and size. Default `full`.
     */
    proof?: "full" | "rclone";
  };
}

/** ADR-0012 A6: staged jobs grant at go-live (`close`) unless the plan says otherwise. */
export function memberGrantTiming(
  options: FileMigrationConfig["options"],
): "before_copy" | "after_verification" {
  return options?.memberGrants ?? (options?.staged ? "after_verification" : "before_copy");
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
    ctx.resume.createdDrives = [
      ...(ctx.resume.createdDrives ?? []).filter((d) => d.mappingId !== mapping.id),
      drive,
    ];
    if (memberGrantTiming(ctx.config.options) === "before_copy")
      yield* grantMembers(ctx, [mapping]);
  }
}

async function* grantMembers(
  ctx: FileContext,
  mappings = ctx.config.mappings,
): AsyncIterable<CommitUnit> {
  for (const mapping of mappings) {
    if (!mapping.createDrive) continue;
    const drive = ctx.resume.createdDrives?.find((item) => item.mappingId === mapping.id);
    if (!drive?.driveId) throw new Error("Member grants require a durable created drive");
    const unit = (key: string): CommitUnit => ({
      rev: ctx.revision,
      phase: "execute",
      unitKey: JSON.stringify(["provision", mapping.id, key]),
      checkpoint: mapping.id,
      rows: [],
      findings: [],
    });
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
          ...(memberGrantTiming(ctx.config.options) === "after_verification"
            ? { at: ctx.now().toISOString() }
            : {}),
        },
      };
    }
  }
}

export class GoLiveCheckError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(detail: Record<string, unknown>) {
    super(
      "Go-live checks failed. Some access may already exist; resolve the evidence with an operator and retry close, never a copy or mirror pass.",
    );
    this.detail = detail;
  }
}

function membershipIdentities(members: DriveMembership[]): string[] {
  return members
    .map((member) => JSON.stringify([member.email.toLowerCase(), member.type, member.role]))
    .sort();
}

function destinationDigest(
  files: Iterable<FileHashEntry>,
  md5: Iterable<FileHashEntry>,
  folders: Iterable<string>,
): string {
  const entries = (items: Iterable<FileHashEntry>) =>
    [...items]
      .map((item) => [item.path, item.size, item.hash, item.id ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return digest([entries(files), entries(md5), [...folders].sort()]);
}

/** Close is the explicit authorization to open verified destinations to members. */
export async function* goLive(ctx: FileContext, verificationAt: string): AsyncIterable<CommitUnit> {
  // Every affected drive is fenced before the first permission request, including
  // drives later in the batch when an earlier grant crashes or has an ambiguous response.
  for (const mapping of ctx.config.mappings) {
    if (!mapping.createDrive) continue;
    const drive = ctx.resume.createdDrives?.find((item) => item.mappingId === mapping.id);
    if (!drive?.driveId) throw new Error("Go-live requires a durable created drive");
    if (drive.goLive) continue;
    drive.goLive = { startedAt: ctx.now().toISOString(), revision: ctx.revision, verificationAt };
    yield {
      rev: ctx.revision,
      phase: "execute",
      unitKey: JSON.stringify(["go-live-fence", drive.driveId]),
      checkpoint: mapping.id,
      rows: [],
      findings: [],
      createdDrive: drive,
    };
  }
  yield* grantMembers({
    ...ctx,
    now: () => new Date(Math.max(ctx.now().getTime(), Date.parse(verificationAt) + 1)),
  });
  for (const mapping of ctx.config.mappings) {
    if (!mapping.createDrive) continue;
    const drive = ctx.resume.createdDrives!.find((item) => item.mappingId === mapping.id)!;
    const expected = [...mapping.createDrive.members];
    if (
      !expected.some(
        (member) =>
          member.type === "user" && member.email.toLowerCase() === drive.creatorEmail.toLowerCase(),
      )
    )
      expected.push({ email: drive.creatorEmail, type: "user", role: "organizer" });
    let check: NonNullable<NonNullable<typeof drive.goLive>["check"]>;
    try {
      const actual = await ctx.provider.listDriveMembers(drive.driveId!);
      if (
        JSON.stringify(membershipIdentities(expected)) !==
        JSON.stringify(membershipIdentities(actual))
      ) {
        check = {
          at: ctx.now().toISOString(),
          status: "failed",
          check: "drive_membership_mismatch",
          evidence: { expected, actual },
        };
      } else {
        const baseline = drive.verifiedDestination;
        const pass = await ctx.provider.resolveFilePass(
          destinationMapping(provisionedMapping(ctx, mapping)),
        );
        const files = await ctx.provider.listFileHashes({
          socketPath: pass.socketPath,
          root: pass.destination,
          hashType: baseline?.hashType ?? "sha256",
          download: false,
          ...abortable(ctx),
        });
        const md5 = baseline?.md5
          ? await ctx.provider.listFileHashes({
              socketPath: pass.socketPath,
              root: pass.destination,
              hashType: "md5",
              download: false,
              ...abortable(ctx),
            })
          : [];
        const folders = await ctx.provider.listFolders({
          socketPath: pass.socketPath,
          root: pass.destination,
          ...abortable(ctx),
        });
        const observed = destinationDigest(files, md5, folders);
        const matches = baseline?.revision === ctx.revision && baseline.digest === observed;
        check = {
          at: ctx.now().toISOString(),
          status: matches ? "passed" : "failed",
          check: matches ? "membership_and_destination" : "destination_drift",
          evidence: {
            expected,
            actual,
            expectedDestinationDigest: baseline?.digest ?? null,
            observedDestinationDigest: observed,
          },
        };
      }
    } catch (error) {
      if (
        !(error instanceof TypeError) &&
        !(error instanceof HttpProviderFault) &&
        !terminalUnavailable(error)
      )
        throw error;
      check = {
        at: ctx.now().toISOString(),
        status: "failed",
        check: "go_live_check_unavailable",
        evidence: {
          expected,
          ...(error instanceof HttpProviderFault ? { status: error.status } : {}),
        },
      };
    }
    drive.goLive = { ...drive.goLive!, check };
    yield {
      rev: ctx.revision,
      phase: "execute",
      unitKey: JSON.stringify(["go-live-check", drive.driveId, digest(check)]),
      checkpoint: mapping.id,
      rows: [],
      findings: [],
      createdDrive: drive,
    };
    if (check.status === "failed")
      throw new GoLiveCheckError({
        accessMayExist: true,
        mappingId: mapping.id,
        driveId: drive.driveId,
        check: check.check,
        ...check.evidence,
      });
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
    itemType: source.kind === "folder" || copiedNotebook(ctx, source) ? "folder" : "file",
    size: source.size,
    sourceEtag: source.etag,
    sourceEvidence: sourceEvidence(source),
    nextStep: code === "source_package_omitted" ? packageOmission(source).nextStep : null,
    omissionReason: code === "source_package_omitted" ? packageOmission(source).reason : null,
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

/** rclone proof: approval binds the map of roots, not a per-file Graph inventory. */
function rcloneProof(ctx: FileContext): boolean {
  return ctx.config.options?.proof === "rclone";
}

async function sourceRoot(ctx: FileContext, mapping: FileMappingConfig): Promise<SourceView> {
  const root = await ctx.provider.resolveSourceRoot(mapping);
  if (!root || root.kind !== "folder" || root.driveId !== mapping.sourceDriveId)
    throw Object.assign(new Error("The source root is missing or is not an ordinary folder"), {
      code: "unsupported_route",
    });
  return { ...root, path: ".", representable: true, outsideRoot: false };
}

async function destinationRoot(
  ctx: FileContext,
  mapping: FileMappingConfig,
): Promise<DestinationEntry> {
  const root = await ctx.provider.resolveDestinationFolder(destinationMapping(mapping));
  if (!root || root.kind !== "folder" || root.driveId !== mapping.destDriveId)
    throw Object.assign(new Error("The destination root is missing or is not an ordinary folder"), {
      code: "unsupported_route",
    });
  return root;
}

/** An item known only from an rclone listing: its path, size and listed provider ID. */
function listedItem(
  driveId: string,
  id: string,
  path: string,
  kind: "file" | "folder",
  size: number | null,
): SourceView {
  return {
    id,
    driveId,
    parentId: null,
    name: path.slice(path.lastIndexOf("/") + 1),
    kind,
    size: size !== null && size >= 0 ? size : null,
    etag: null,
    createdAt: "",
    modifiedAt: "",
    mimeType: null,
    identity: `${driveId}:${id}`,
    downloadable: kind === "file",
    webUrl: null,
    packageSections: null,
    path,
    representable: true,
    outsideRoot: false,
  };
}

/** Listings have no deadline: the run's AbortSignal is what stops them. */
function abortable(ctx: FileContext): { signal?: AbortSignal } {
  return ctx.signal ? { signal: ctx.signal } : {};
}

/**
 * rclone proof: what a pass would still change, from rclone listings of each side. Folders
 * are compared too: rclone's file listing cannot see a new empty source folder.
 */
async function rclonePending(ctx: FileContext, mapping: FileMappingConfig): Promise<string[]> {
  const resolved = await ctx.provider.resolveFilePass(destinationMapping(mapping));
  const [preview, sourceFolders, destinationFolders] = await Promise.all([
    ctx.provider.previewCopyPass({
      ...resolved,
      excludePaths: [],
      mode: ctx.config.options?.mirror ? "mirror" : "copy",
      ...abortable(ctx),
    }),
    ctx.provider.listFolders({
      socketPath: resolved.socketPath,
      root: resolved.source,
      ...abortable(ctx),
    }),
    ctx.provider.listFolders({
      socketPath: resolved.socketPath,
      root: resolved.destination,
      ...abortable(ctx),
    }),
  ]);
  const present = new Set(destinationFolders);
  return [
    ...[...preview.new, ...preview.changed, ...preview.timestampOnly, ...preview.deleted].map(
      (item) => item.path,
    ),
    ...sourceFolders.filter((path) => !present.has(path)),
  ].sort();
}

/**
 * rclone proof: before a mirror pass, list both sides once and record each destination-only
 * file as a `to_be_deleted` row; the pass may delete exactly that many files.
 */
async function* mirrorDeletions(
  ctx: FileContext,
  mapping: FileMappingConfig,
  passNumber: number,
  reserved: number,
): AsyncGenerator<CommitUnit, number> {
  if (!ctx.config.options?.mirror) return 0;
  const resolved = await ctx.provider.resolveFilePass(destinationMapping(mapping));
  // An empty destination has nothing to delete: copying starts without listing the source.
  const present = await ctx.provider.listFileHashes({
    socketPath: resolved.socketPath,
    root: resolved.destination,
    hashType: "md5",
    download: false,
    ...abortable(ctx),
  });
  if (!present.length) return 0;
  const { deleted } = await ctx.provider.previewCopyPass({
    ...resolved,
    excludePaths: [],
    mode: "mirror",
    ...abortable(ctx),
  });
  if (reserved + deleted.length > ctx.config.options.deleteLimit!)
    throw new FilePlanRevisionRequiredError(
      "Mirror would delete more destination files than deleteLimit allows; review the source, then raise deleteLimit in a new plan.",
    );
  if (!deleted.length) return 0;
  yield {
    rev: ctx.revision,
    phase: "execute",
    unitKey: JSON.stringify(["mirror-deletions", mapping.id, passNumber]),
    checkpoint: mapping.id,
    rows: deleted.map((entry) => {
      const id = `destination:${entry.path}`;
      const evidence = row(
        ctx,
        "execute",
        mapping,
        listedItem(mapping.sourceDriveId, id, entry.path, "file", entry.size),
        "to_be_deleted",
      );
      delete evidence.sourceEvidence;
      evidence.destinationDriveId = mapping.destDriveId ?? null;
      return evidence;
    }),
    findings: [],
  };
  return deleted.length;
}

async function sourceInventory(
  ctx: FileContext,
  mapping: FileMappingConfig,
): Promise<SourceView[]> {
  const sources: SourceView[] = [await sourceRoot(ctx, mapping)];
  const sourceById = new Map([[sources[0]!.id, sources[0]!]]);
  for (let index = 0; index < sources.length; index++) {
    ctx.signal?.throwIfAborted();
    const parent = sources[index]!;
    if ((parent.kind !== "folder" && !copiedNotebook(ctx, parent)) || parent.outsideRoot) continue;
    const children = await ctx.provider.listSourceChildren({
      driveId: parent.driveId,
      itemId: parent.id,
    });
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

/** Complete read-only fallback until descendant coverage of change cursors is qualified. */
export async function assertSourceInventoryFresh(
  ctx: FileContext,
  executionResume = false,
): Promise<void> {
  // rclone proof approved no inventory, so there is nothing to compare before copying.
  if (rcloneProof(ctx)) return;
  for (const mapping of ctx.config.mappings) {
    const fresh = await sourceInventory(ctx, mapping);
    if (executionResume && ctx.stage === "final" && settleState(ctx, mapping)) {
      assertApprovedPaths(ctx, mapping, fresh);
      continue;
    }
    const expected = new Map<string, unknown>();
    for (const item of ctx.resume.rows ?? [])
      if (
        item.jobType === "file_migration" &&
        item.phase === "plan" &&
        item.mappingId === mapping.id &&
        item.sourceEvidence
      )
        expected.set(item.sourceItemId, item.sourceEvidence);
    if (
      fresh.length !== expected.size ||
      fresh.some(
        (source) =>
          canonicalJson(sourceEvidence(source)) !== canonicalJson(expected.get(source.id) ?? null),
      )
    )
      throw new FilePlanRevisionRequiredError(
        "The source inventory changed after approval; collect a new plan.",
      );
  }
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
  const root = await destinationRoot(ctx, mapping);
  const destinations: DestinationView[] = [{ ...root, path: "." }];
  const destinationById = new Map([[root.id, destinations[0]!]]);
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

function packageOmission(source: SourceView) {
  const notebook = source.packageSections !== null;
  return {
    path: source.path,
    webUrl: source.webUrl,
    sectionCount: source.packageSections,
    reason: notebook
      ? "OneNote notebooks are packages, not files, and Google Drive cannot open them."
      : "This source package is not a supported downloadable file.",
    nextStep: notebook
      ? "Open the notebook in OneNote for Windows → File → Export → Notebook (.onepkg) or PDF, then upload the export to the destination drive."
      : null,
  };
}

function copiedNotebook(ctx: FileContext, source: SourceEntry): boolean {
  return (
    ctx.config.options?.oneNoteNotebooks === "copy" &&
    source.kind === "package" &&
    source.packageSections !== null
  );
}

function sourceOmission(ctx: FileContext, source: SourceView): string | null {
  if (source.outsideRoot) return "route_limit_omission";
  if (!source.representable) return "path_unrepresentable";
  if (source.kind === "package" && !copiedNotebook(ctx, source)) return "source_package_omitted";
  if (source.kind === "reference") return "source_reference_omitted";
  if (source.kind === "undownloadable" || (source.kind === "file" && !source.downloadable)) {
    return "source_content_unavailable";
  }
  return null;
}
function expectedDestinationFolders(
  ctx: FileContext,
  sources: SourceView[],
  excluded: ReadonlyMap<string, string>,
): Map<string, SourceView> {
  const omittedPaths = sources
    .filter((source) => excluded.has(source.id) || sourceOmission(ctx, source) !== null)
    .map((source) => source.path);
  return new Map(
    sources
      .filter(
        (source) =>
          (source.kind === "folder" || copiedNotebook(ctx, source)) &&
          source.path !== "." &&
          !omittedPaths.some(
            (path) => path === "." || source.path === path || source.path.startsWith(`${path}/`),
          ),
      )
      .map((source) => [source.path, source]),
  );
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

/** rclone proof: the plan is the map of approved roots; rclone lists files when it copies. */
async function* collectMap(ctx: FileContext): AsyncIterable<CommitUnit> {
  let done = 0;
  for (const planned of ctx.config.mappings) {
    const mapping = provisionedMapping(ctx, planned);
    const root = await sourceRoot(ctx, mapping);
    if (!mapping.createDrive || mapping.destDriveId) await destinationRoot(ctx, mapping);
    const evidence = row(ctx, "plan", mapping, root, "unchanged");
    evidence.destinationDriveId = mapping.destDriveId ?? null;
    evidence.destinationFileId = mapping.destFolderId ?? null;
    evidence.fileScope = { exclusions: [], sourceInventoryAt: ctx.now().toISOString() };
    const unit = commit(ctx, "plan", evidence, [], "plan", ++done);
    unit.mappingPass = pendingPass(
      ctx.revision,
      mapping.id,
      1,
      ctx.config.options?.mirror ? "mirror" : "copy",
    );
    yield unit;
  }
}

async function* collect(ctx: FileContext): AsyncIterable<CommitUnit> {
  if (rcloneProof(ctx)) {
    yield* collectMap(ctx);
    return;
  }
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
    const preview = overlapping.has(mapping.id)
      ? undefined
      : await passPreview(ctx, mapping, tree.sources);
    const outcomes = new Map<string, string>();
    if (preview) {
      for (const item of preview.new) outcomes.set(item.path, "created");
      for (const item of preview.changed) outcomes.set(item.path, "updated");
      for (const item of preview.unchanged) outcomes.set(item.path, "unchanged");
      for (const item of preview.timestampOnly) outcomes.set(item.path, "timestamp_only");
    }
    for (const source of tree.sources) {
      if (overlapping.has(mapping.id) && source.path !== ".") continue;
      const code = overlapping.has(mapping.id)
        ? "mapping_overlap"
        : excluded.has(source.id)
          ? "omitted_by_rule"
          : (sourceOmission(ctx, source) ??
            (copiedNotebook(ctx, source)
              ? "source_package_copied_as_files"
              : source.path === "."
                ? "unchanged"
                : (outcomes.get(source.path) ??
                  (tree.destinationByPath.has(source.path) ? "unchanged" : "created"))));
      const evidence = row(ctx, "plan", mapping, source, code);
      if (source.path === ".") {
        evidence.destinationDriveId = mapping.destDriveId ?? null;
        evidence.destinationFileId = mapping.destFolderId ?? null;
        evidence.fileScope = {
          exclusions,
          sourceInventoryAt: ctx.now().toISOString(),
          ...(preview ? { preview } : {}),
        };
      }
      const unit = commit(
        ctx,
        "plan",
        evidence,
        code === "created" ||
          code === "updated" ||
          code === "unchanged" ||
          code === "timestamp_only"
          ? metadataOmissions(ctx, "plan", source)
          : [
              finding(ctx, "plan", code, source.id, {
                path: source.path,
                ...(code === "source_package_omitted" ? packageOmission(source) : {}),
                ...(excluded.has(source.id) ? { reason: excluded.get(source.id) } : {}),
              }),
            ],
        "plan",
        ++done,
      );
      if (
        source.path === "." &&
        preview &&
        ctx.config.options?.mirror &&
        preview.deleted.length > ctx.config.options.deleteLimit!
      )
        unit.findings.push(
          finding(ctx, "plan", "delete_limit_exceeded", mapping.id, {
            mappingId: mapping.id,
            deleteLimit: ctx.config.options.deleteLimit,
            deleted: preview.deleted,
          }),
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
    for (const [code, entries] of [
      ["to_be_deleted", preview?.deleted ?? []],
      ["destination_only_retained", preview?.retained ?? []],
    ] as const) {
      for (const entry of entries) {
        const evidence = row(
          ctx,
          "plan",
          mapping,
          {
            ...tree.sources[0]!,
            id: `destination:${entry.path}`,
            path: entry.path,
            kind: "file",
            size: entry.size,
          },
          code,
        );
        delete evidence.sourceEvidence;
        yield commit(ctx, "plan", evidence, [], code, ++done);
      }
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
        const pass = next.value.mappingPass;
        if (!pass || pass.status !== "running" || !pass.lastStats) progressed = true;
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

function inventoryEvidence(sources: SourceView[]): FileSettleState["copiedInventory"] {
  return sources.map((source) => ({
    id: source.id,
    path: source.path,
    evidence: sourceEvidence(source),
  }));
}

function plannedScope(ctx: FileContext, mapping: FileMappingConfig) {
  return (ctx.resume.rows ?? []).find(
    (item) =>
      item.jobType === "file_migration" &&
      item.phase === "plan" &&
      item.rev === ctx.revision &&
      item.mappingId === mapping.id &&
      item.fileScope !== undefined,
  );
}

function settleState(ctx: FileContext, mapping: FileMappingConfig): FileSettleState | undefined {
  const raw = ctx.resume.watermarks[`file-settle:${mapping.id}`];
  if (!raw) return undefined;
  const state: FileSettleState = JSON.parse(raw);
  return state.revision === ctx.revision ? state : undefined;
}

function assertApprovedPaths(ctx: FileContext, mapping: FileMappingConfig, sources: SourceView[]) {
  const approved = new Map(
    (ctx.resume.rows ?? [])
      .filter(
        (item) =>
          item.jobType === "file_migration" &&
          item.phase === "plan" &&
          item.mappingId === mapping.id &&
          item.sourceEvidence !== undefined,
      )
      .map((item) =>
        item.jobType === "file_migration" ? [item.sourceItemId, item.relativePath] : ["", ""],
      ),
  );
  if (
    sources.length !== approved.size ||
    sources.some((source) => approved.get(source.id) !== source.path)
  )
    throw new FilePlanRevisionRequiredError(
      "Source paths changed outside the approved preview; collect a new plan.",
    );
}

function settleUnit(
  ctx: FileContext,
  state: FileSettleState,
): CommitUnit & { watermark: { unitKey: string; value: string } } {
  const value = JSON.stringify(state);
  return {
    rev: ctx.revision,
    phase: "execute",
    unitKey: JSON.stringify(["settle", state.mappingId, digest(value)]),
    checkpoint: state.mappingId,
    rows: [],
    findings: [],
    watermark: { unitKey: `file-settle:${state.mappingId}`, value },
  };
}

function cutoverIncomplete(): Error {
  return Object.assign(
    new Error("The final source did not settle within the approved pass bound."),
    {
      code: "cutover_incomplete",
    },
  );
}

async function passPreview(
  ctx: FileContext,
  mapping: FileMappingConfig,
  sources: SourceView[],
): Promise<FilePassPreview & { deletedFolders: string[] }> {
  const excluded = new Set(
    expandedExclusions({ mapping, sources }).map((item) => item.sourceItemId),
  );
  const excludePaths = sources
    .filter((source) => excluded.has(source.id) || sourceOmission(ctx, source))
    .map((source) => source.path);
  const resolved: { socketPath: string; source: FilePassRoot; destination?: FilePassRoot } =
    mapping.createDrive && !mapping.destDriveId
      ? await ctx.provider.resolveFilePassSource(mapping)
      : await ctx.provider.resolveFilePass(destinationMapping(mapping));
  const preview = await ctx.provider.previewCopyPass({
    ...resolved,
    excludePaths,
    mode: ctx.config.options?.mirror ? "mirror" : "copy",
    ...abortable(ctx),
  });
  const expectedFolders = expectedDestinationFolders(
    ctx,
    sources,
    new Map(
      expandedExclusions({ mapping, sources }).map((item) => [item.sourceItemId, item.reason]),
    ),
  );
  const deletedFolders =
    ctx.config.options?.mirror && resolved.destination
      ? (
          await ctx.provider.listFolders({
            socketPath: resolved.socketPath,
            root: resolved.destination,
            ...abortable(ctx),
          })
        )
          .filter(
            (path) =>
              path !== "." &&
              !expectedFolders.has(path) &&
              !excludePaths.some(
                (excluded) =>
                  excluded === "." || path === excluded || path.startsWith(`${excluded}/`),
              ),
          )
          .sort()
      : [];
  return { ...preview, deletedFolders };
}

async function* copyMapping(
  ctx: FileContext,
  mapping: FileMappingConfig,
): AsyncGenerator<CommitUnit> {
  const previous = (ctx.resume.mappingPasses ?? [])
    .filter((pass) => pass.mappingId === mapping.id)
    .at(-1);
  const final = ctx.stage === "final";
  let state = final ? settleState(ctx, mapping) : undefined;
  if (state?.outcome === "exhausted") throw cutoverIncomplete();
  if (state?.outcome === "settled" || (!final && previous?.status === "completed")) return;
  const rclone = rcloneProof(ctx);
  // rclone proof copies without a Graph inventory; rclone lists both sides as it copies.
  let sources = rclone ? [] : await sourceInventory(ctx, mapping);
  if (!rclone) assertApprovedPaths(ctx, mapping, sources);
  let copyNeeded = !state || state.copyPending;
  // An ambiguous/crashed attempt consumes a catch-up attempt rather than resetting the bound.
  if (state?.copyPending) {
    if (state.passes >= state.maxPasses) {
      state.outcome = "exhausted";
      yield settleUnit(ctx, state);
      throw cutoverIncomplete();
    }
    state.passes++;
    state.copyPassNumber++;
  }
  if (final && !state)
    state = {
      revision: ctx.revision,
      mappingId: mapping.id,
      maxPasses: ctx.config.options?.settleMaxPasses ?? 3,
      consistencyIntervalMs: ctx.config.options?.consistencyIntervalMs ?? 30_000,
      passes: 0,
      copyPassNumber:
        previous?.status === "pending" ? previous.passNumber : (previous?.passNumber ?? 0) + 1,
      copyPending: true,
      deletionsReserved: 0,
      outcome: "pending",
      copiedInventory: inventoryEvidence(sources),
      observations: [],
    };
  for (;;) {
    if (copyNeeded) {
      const passNumber =
        state?.copyPassNumber ??
        (previous?.status === "pending" ? previous.passNumber : (previous?.passNumber ?? 0) + 1);
      let authorized: number;
      if (rclone)
        authorized = yield* mirrorDeletions(
          ctx,
          mapping,
          passNumber,
          state?.deletionsReserved ?? 0,
        );
      else {
        const preview = await passPreview(ctx, mapping, sources);
        const planned = plannedScope(ctx, mapping);
        const approved =
          planned?.jobType === "file_migration" ? planned.fileScope?.preview : undefined;
        const allowed = new Set(approved?.deleted.map((item) => item.path) ?? []);
        const allowedFolders = new Set(approved?.deletedFolders ?? []);
        if (
          preview.deleted.some((item) => !allowed.has(item.path)) ||
          preview.deletedFolders.some((path) => !allowedFolders.has(path)) ||
          (ctx.config.options?.mirror &&
            (state?.deletionsReserved ?? 0) + preview.deleted.length >
              ctx.config.options.deleteLimit!)
        )
          throw new FilePlanRevisionRequiredError(
            "The cumulative deletion scope exceeds the approved preview or limit.",
          );
        authorized = preview.deleted.length;
      }
      if (state) {
        state.copyPending = true;
        state.copiedInventory = inventoryEvidence(sources);
        state.deletionsReserved += authorized;
        yield settleUnit(ctx, state);
      }
      let completed = false;
      for await (const unit of copyPass(ctx, mapping, sources, passNumber, authorized)) {
        completed = unit.mappingPass?.status === "completed";
        if (completed && state) {
          state.copyPending = false;
          unit.watermark = settleUnit(ctx, state).watermark;
        }
        yield unit;
      }
      if (!completed || !state) return;
    }
    if (!state) return;
    if (ctx.waitForConsistency)
      await ctx.waitForConsistency(state.consistencyIntervalMs, ctx.signal);
    else await delay(state.consistencyIntervalMs, undefined, { signal: ctx.signal });
    let changedPaths: string[];
    if (rclone) changedPaths = await rclonePending(ctx, mapping);
    else {
      sources = await sourceInventory(ctx, mapping);
      assertApprovedPaths(ctx, mapping, sources);
      const copied = new Map(state.copiedInventory.map((item) => [item.id, item]));
      changedPaths = sources
        .filter(
          (source) =>
            canonicalJson(sourceEvidence(source)) !==
            canonicalJson(copied.get(source.id)?.evidence ?? null),
        )
        .map((source) => source.path);
    }
    state.outcome =
      changedPaths.length === 0
        ? "settled"
        : state.passes >= state.maxPasses
          ? "exhausted"
          : "pending";
    state.observations.push({
      at: ctx.now().toISOString(),
      changedPaths,
      outcome: state.outcome === "pending" ? "changed" : state.outcome,
    });
    yield settleUnit(ctx, state);
    if (state.outcome === "settled") return;
    if (state.outcome === "exhausted") throw cutoverIncomplete();
    state.passes++;
    state.copyPassNumber++;
    copyNeeded = true;
  }
}

async function* copyPass(
  ctx: FileContext,
  mapping: FileMappingConfig,
  sources: SourceView[],
  passNumber: number,
  authorizedDeletions: number,
): AsyncGenerator<CommitUnit> {
  let pass = pendingPass(
    ctx.revision,
    mapping.id,
    passNumber,
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
    const excluded = new Set(
      expandedExclusions({ mapping, sources }).map((item) => item.sourceItemId),
    );
    const resolved = await ctx.provider.resolveFilePass(destinationMapping(mapping));
    const handle = await ctx.provider.startCopyPass({
      ...resolved,
      ...(ctx.config.options?.mirror
        ? { mode: "mirror" as const, deleteLimit: authorizedDeletions }
        : { mode: "copy" as const }),
      transfers: ctx.config.options?.transfersPerMapping ?? COPY_DEFAULTS.transfersPerMapping,
      excludePaths: sources
        .filter((source) => excluded.has(source.id) || sourceOmission(ctx, source))
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

function assertSettledInventory(
  ctx: FileContext,
  mapping: FileMappingConfig,
  sources: SourceView[],
) {
  if (ctx.stage !== "final") return;
  const settled = settleState(ctx, mapping);
  if (settled?.outcome !== "settled") throw cutoverIncomplete();
  const copied = new Map(settled.copiedInventory.map((item) => [item.id, item]));
  if (
    sources.length !== copied.size ||
    sources.some(
      (source) =>
        copied.get(source.id)?.path !== source.path ||
        canonicalJson(copied.get(source.id)?.evidence ?? null) !==
          canonicalJson(sourceEvidence(source)),
    )
  )
    throw new FilePlanRevisionRequiredError(
      "The source changed after settled confirmation; final verification cannot complete.",
    );
}

function verificationCoverage(ctx: FileContext, mapping: FileMappingConfig, sources: SourceView[]) {
  const current = inventoryEvidence(sources);
  const destination = destinationMapping(mapping);
  const binding = {
    sourceDriveId: mapping.sourceDriveId,
    sourceItemId: mapping.sourceItemId,
    sourceType: mapping.sourceType ?? "sharepoint",
    destDriveId: destination.destDriveId,
    destFolderId: destination.destFolderId,
    exclusions: expandedExclusions({ mapping, sources }).sort((a, b) =>
      a.sourceItemId < b.sourceItemId ? -1 : a.sourceItemId > b.sourceItemId ? 1 : 0,
    ),
    oneNoteNotebooks: ctx.config.options?.oneNoteNotebooks ?? "omit",
    verificationMode: ctx.config.options?.verificationMode ?? "hash",
  };
  const baseline =
    ctx.stage === "delta" && ctx.config.options?.deltaVerification === "changed"
      ? ctx.verificationBaseline
      : undefined;
  const previous = new Map<string, FileSettleState["copiedInventory"][number]>();
  if (baseline) {
    const rows = baseline.rows.filter(
      (item) => item.jobType === "file_migration" && item.mappingId === mapping.id,
    );
    const complete = rows.find(
      (item) =>
        item.jobType === "file_migration" &&
        item.phase === "verify" &&
        item.fileScope?.verification?.sourceInventory,
    );
    if (
      complete?.jobType === "file_migration" &&
      canonicalJson(complete.fileScope?.verification?.binding ?? null) === canonicalJson(binding)
    ) {
      for (const item of complete.fileScope!.verification!.sourceInventory)
        previous.set(item.path, item);
    }
  }
  const partial = baseline !== undefined && previous.size > 0;
  const paths = new Set(current.map((item) => item.path));
  const deletedPaths = partial
    ? [...previous.keys()].filter((path) => !paths.has(path)).sort()
    : [];
  const coveredPaths = partial
    ? [
        ...new Set([
          ...current
            .filter(
              (item) =>
                canonicalJson(item.evidence) !==
                canonicalJson(previous.get(item.path)?.evidence ?? null),
            )
            .map((item) => item.path),
          ...deletedPaths,
        ]),
      ].sort()
    : [...paths].sort();
  return {
    binding,
    scope: partial ? ("partial" as const) : ("full" as const),
    baselineRevision: partial ? baseline.revision : null,
    coveredPaths,
    deletedPaths,
    sourceInventory: current,
  };
}

/** A created drive whose actual members differ from those due at this point. */
async function membershipUnit(
  ctx: FileContext,
  mapping: FileMappingConfig,
  root: SourceView,
  done: number,
): Promise<CommitUnit | undefined> {
  if (!mapping.createDrive) return undefined;
  const drive = ctx.resume.createdDrives?.find((d) => d.mappingId === mapping.id);
  if (!drive?.driveId) throw new Error("Verification requires the durable created drive");
  const expected =
    memberGrantTiming(ctx.config.options) === "before_copy" || drive.goLive
      ? [...mapping.createDrive.members]
      : [];
  if (
    !expected.some(
      (member) =>
        member.type === "user" && member.email.toLowerCase() === drive.creatorEmail.toLowerCase(),
    )
  )
    expected.push({ email: drive.creatorEmail, type: "user", role: "organizer" });
  const actual = await ctx.provider.listDriveMembers(drive.driveId);
  if (
    JSON.stringify(membershipIdentities(expected)) === JSON.stringify(membershipIdentities(actual))
  )
    return undefined;
  const evidence = row(ctx, "verify", mapping, root, "drive_membership_mismatch");
  evidence.destinationDriveId = drive.driveId;
  evidence.destinationFileId = drive.driveId;
  return commit(
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
    done,
  );
}

/** A1/A4 before A6: the destination listing a deferred go-live is later checked against. */
function goLiveBaseline(
  ctx: FileContext,
  mapping: FileMappingConfig,
  observed: { hashType: "sha256" | "quickxor"; md5: boolean; digest: string },
): CommitUnit | undefined {
  if (!mapping.createDrive || memberGrantTiming(ctx.config.options) !== "after_verification")
    return undefined;
  const drive = ctx.resume.createdDrives!.find((item) => item.mappingId === mapping.id)!;
  // A new verification must never erase the original go-live content fence.
  if (drive.goLive) return undefined;
  drive.verifiedDestination = { revision: ctx.revision, ...observed };
  return {
    rev: ctx.revision,
    phase: "verify",
    unitKey: JSON.stringify(["verified-destination", mapping.id]),
    checkpoint: mapping.id,
    rows: [],
    findings: [],
    createdDrive: drive,
  };
}

/**
 * rclone proof: rclone size-checked each upload; SharePoint and Drive share no hash type.
 * Verification compares rclone listings of both sides by path and size, folders included,
 * without re-reading content.
 */
async function* verifyListing(ctx: FileContext): AsyncIterable<CommitUnit> {
  let done = 0;
  for (const planned of ctx.config.mappings) {
    const mapping = provisionedMapping(ctx, planned);
    if (ctx.stage === "final" && settleState(ctx, mapping)?.outcome !== "settled")
      throw cutoverIncomplete();
    const root = await sourceRoot(ctx, mapping);
    const membership = await membershipUnit(ctx, mapping, root, done + 1);
    if (membership) {
      done++;
      yield membership;
    }
    const planRow = plannedScope(ctx, mapping);
    if (planRow?.jobType !== "file_migration" || !planRow.fileScope)
      throw new FilePlanRevisionRequiredError();
    const pass = await ctx.provider.resolveFilePass(destinationMapping(mapping));
    const list = (side: FilePassRoot, hashType: "quickxor" | "sha256" | "md5") =>
      ctx.provider.listFileHashes({
        socketPath: pass.socketPath,
        root: side,
        hashType,
        download: false,
        ...abortable(ctx),
      });
    const [sources, destinations, sourceFolders, destinationFolders] = await Promise.all([
      list(pass.source, "quickxor"),
      list(pass.destination, "sha256"),
      ctx.provider.listFolders({
        socketPath: pass.socketPath,
        root: pass.source,
        ...abortable(ctx),
      }),
      ctx.provider.listFolders({
        socketPath: pass.socketPath,
        root: pass.destination,
        ...abortable(ctx),
      }),
    ]);
    const needsMd5 = destinations.some((entry) => entry.hash === null);
    const destinationMd5 = needsMd5 ? await list(pass.destination, "md5") : [];
    const md5ByPath = new Map(destinationMd5.map((entry) => [entry.path, entry.hash]));
    const destinationByPath = new Map(destinations.map((entry) => [entry.path, entry]));
    const sourcePaths = new Set(sources.map((entry) => entry.path));
    const target = destinationMapping(mapping);
    const coverageRow = row(ctx, "verify", mapping, root, "unchanged");
    coverageRow.id = JSON.stringify([mapping.id, root.id, "verify", "coverage"]);
    coverageRow.fileScope = {
      ...planRow.fileScope,
      verification: {
        binding: {
          sourceDriveId: mapping.sourceDriveId,
          sourceItemId: mapping.sourceItemId,
          sourceType: "sharepoint",
          destDriveId: target.destDriveId,
          destFolderId: target.destFolderId,
          exclusions: [],
          oneNoteNotebooks: "copy",
          verificationMode: "size_only",
        },
        scope: "full",
        baselineRevision: null,
        coveredPaths: [...sourcePaths].sort(),
        deletedPaths: [],
        sourceInventory: [],
      },
    };
    yield commit(ctx, "verify", coverageRow, [], "verification-coverage", ++done);
    const latest = (ctx.resume.mappingPasses ?? [])
      .filter((item) => item.mappingId === mapping.id)
      .at(-1);
    if (latest?.status !== "completed") {
      const evidence = row(ctx, "verify", mapping, root, "destination_write_failed");
      evidence.id = JSON.stringify([mapping.id, root.id, "verify", "copy-pass"]);
      yield commit(
        ctx,
        "verify",
        evidence,
        [
          finding(ctx, "verify", "destination_write_failed", mapping.id, {
            mappingId: mapping.id,
            passNumber: latest?.passNumber ?? null,
            status: latest?.status ?? null,
            error: latest?.error ?? null,
            errors: latest?.lastStats?.errors ?? null,
          }),
        ],
        "copy-pass",
        ++done,
      );
    }
    for (const source of sources) {
      const copied = destinationByPath.get(source.path);
      // rclone's OneDrive IDs are `driveId#itemId`; rows keep the Graph item ID, as in full proof.
      const listedId = source.id?.startsWith(`${mapping.sourceDriveId}#`)
        ? source.id.slice(mapping.sourceDriveId.length + 1)
        : source.id;
      const view = listedItem(
        mapping.sourceDriveId,
        listedId ?? `path:${source.path}`,
        source.path,
        "file",
        source.size,
      );
      const code = !copied
        ? "destination_missing"
        : view.size !== null && copied.size >= 0 && view.size !== copied.size
          ? "size_mismatch"
          : null;
      const destinationHash = copied ? (copied.hash ?? md5ByPath.get(copied.path) ?? null) : null;
      const evidence = row(ctx, "verify", mapping, view, code ?? "unchanged");
      evidence.destinationDriveId = mapping.destDriveId ?? null;
      evidence.destinationFileId = copied?.id ?? null;
      evidence.sourceFingerprint = source.hash;
      evidence.destinationFingerprint = destinationHash;
      evidence.provenanceState = code ? "drifted" : "verified";
      yield commit(
        ctx,
        "verify",
        evidence,
        code
          ? [
              finding(ctx, "verify", code, view.id, {
                path: source.path,
                sourceSize: view.size,
                destinationSize: copied?.size ?? null,
                sourceHash: source.hash,
                destinationHash,
                hashType: null,
              }),
            ]
          : [],
        "verification",
        ++done,
      );
    }
    const presentFolders = new Set(destinationFolders);
    for (const path of sourceFolders) {
      if (presentFolders.has(path)) continue;
      const conflicting = destinationByPath.get(path);
      const code = conflicting ? "destination_type_conflict" : "destination_missing";
      const view = listedItem(mapping.sourceDriveId, `folder:${path}`, path, "folder", null);
      const evidence = row(ctx, "verify", mapping, view, code);
      evidence.destinationDriveId = mapping.destDriveId ?? null;
      evidence.destinationFileId = conflicting?.id ?? null;
      yield commit(
        ctx,
        "verify",
        evidence,
        [
          finding(
            ctx,
            "verify",
            code,
            view.id,
            conflicting
              ? {
                  path,
                  ...(conflicting.id ? { destinationId: conflicting.id } : {}),
                  destinationSize: conflicting.size,
                  destinationHash: conflicting.hash,
                }
              : { path, itemType: "folder" },
          ),
        ],
        "folder-verification",
        ++done,
      );
    }
    for (const retained of destinations) {
      if (sourcePaths.has(retained.path)) continue;
      const view = listedItem(
        mapping.sourceDriveId,
        `destination:${retained.path}`,
        retained.path,
        "file",
        retained.size,
      );
      const destinationHash = retained.hash ?? md5ByPath.get(retained.path) ?? null;
      const evidence = row(ctx, "verify", mapping, view, "destination_only_retained");
      delete evidence.sourceEvidence;
      evidence.destinationDriveId = mapping.destDriveId ?? null;
      evidence.destinationFileId = retained.id ?? null;
      evidence.destinationFingerprint = destinationHash;
      yield commit(
        ctx,
        "verify",
        evidence,
        [
          finding(ctx, "verify", "destination_only_retained", view.id, {
            path: retained.path,
            sourceSize: null,
            destinationSize: retained.size,
            sourceHash: null,
            destinationHash,
            hashType: null,
          }),
        ],
        "retained",
        ++done,
      );
    }
    const baseline = goLiveBaseline(ctx, mapping, {
      hashType: "sha256",
      md5: needsMd5,
      digest: destinationDigest(destinations, destinationMd5, destinationFolders),
    });
    if (baseline) yield baseline;
  }
}

async function* verify(ctx: FileContext): AsyncIterable<CommitUnit> {
  if (rcloneProof(ctx)) {
    yield* verifyListing(ctx);
    return;
  }
  let done = 0;
  const sizeOnly = ctx.config.options?.verificationMode === "size_only";
  if (
    ctx.stage === "delta" &&
    ctx.config.options?.deltaVerification === "changed" &&
    ctx.verificationBaseline?.findings.length
  ) {
    yield {
      rev: ctx.revision,
      phase: "verify",
      unitKey: "partial-baseline-exceptions",
      checkpoint: "partial-baseline-exceptions",
      rows: [],
      findings: ctx.verificationBaseline.findings
        .filter((item) => item.phase === "verify")
        .map((item) => ({
          ...item,
          rev: ctx.revision,
          at: ctx.now().toISOString(),
          evidence: { ...item.evidence, inheritedFromRevision: ctx.verificationBaseline!.revision },
        })),
    };
  }
  for (const planned of ctx.config.mappings) {
    const mapping = provisionedMapping(ctx, planned);
    const sources = await sourceInventory(ctx, mapping);
    assertSettledInventory(ctx, mapping, sources);
    const membership = await membershipUnit(ctx, mapping, sources[0]!, done + 1);
    if (membership) {
      done++;
      yield membership;
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
    const coverage = verificationCoverage(ctx, mapping, sources);
    const covered = coverage.scope === "partial" ? new Set(coverage.coveredPaths) : undefined;
    const paths = covered ? coverage.coveredPaths : undefined;
    const coverageRow = row(ctx, "verify", mapping, sources[0]!, "unchanged");
    coverageRow.id = JSON.stringify([mapping.id, sources[0]!.id, "verify", "coverage"]);
    coverageRow.fileScope = { ...scope, verification: coverage };
    yield commit(ctx, "verify", coverageRow, [], "verification-coverage", ++done);
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
          ...(paths ? { paths } : {}),
          ...abortable(ctx),
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
          ...(paths ? { paths } : {}),
          ...abortable(ctx),
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
              ...(paths ? { paths } : {}),
              ...abortable(ctx),
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
              ...(paths ? { paths } : {}),
              ...abortable(ctx),
            })
          ).map((entry) => [entry.path, entry])
        : [],
    );
    for (const source of sources) {
      if (covered && !covered.has(source.path)) continue;
      const omission = excluded.has(source.id)
        ? "omitted_by_rule"
        : source.kind === "file" || source.kind === "undownloadable"
          ? null
          : sourceOmission(ctx, source);
      if (omission) {
        yield commit(
          ctx,
          "verify",
          row(ctx, "verify", mapping, source, omission),
          [
            finding(ctx, "verify", omission, source.id, {
              path: source.path,
              ...(omission === "source_package_omitted" ? packageOmission(source) : {}),
              ...(excluded.has(source.id) ? { reason: excluded.get(source.id) } : {}),
            }),
          ],
          "omission",
          ++done,
        );
        continue;
      }
      if (source.kind === "folder" || copiedNotebook(ctx, source)) continue;
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
              ctx.provider.openSourceContent({ driveId: source.driveId, itemId: source.id }),
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
    const expectedFolders = expectedDestinationFolders(ctx, sources, excluded);
    const destinationFolders = new Set(
      await ctx.provider.listFolders({
        socketPath: pass.socketPath,
        root: pass.destination,
        ...abortable(ctx),
      }),
    );
    for (const [path, source] of expectedFolders) {
      if (covered && !covered.has(path)) continue;
      const destination = destinationHashes.get(path);
      if (!destination && destinationFolders.has(path)) continue;
      const code = destination ? "destination_type_conflict" : "destination_missing";
      const evidence = row(ctx, "verify", mapping, source, code);
      evidence.destinationDriveId = mapping.destDriveId ?? null;
      evidence.destinationFileId = destination?.id ?? null;
      const stored =
        destination?.hash === null ? (destinationMd5.get(path) ?? destination) : destination;
      evidence.destinationFingerprint = stored?.hash ?? null;
      yield commit(
        ctx,
        "verify",
        evidence,
        [
          finding(
            ctx,
            "verify",
            code,
            source.id,
            destination
              ? {
                  path,
                  ...(destination.id ? { destinationId: destination.id } : {}),
                  destinationSize: destination.size,
                  destinationHash: stored?.hash ?? null,
                }
              : { path, itemType: "folder" },
          ),
        ],
        "folder-verification",
        ++done,
      );
    }
    for (const destination of destinationHashes.values()) {
      if (sourceHashes.has(destination.path) || expectedFolders.has(destination.path)) continue;
      const source: SourceView = {
        ...sources[0]!,
        id: `destination:${destination.path}`,
        path: destination.path,
        kind: "file",
        size: destination.size,
      };
      const evidence = row(ctx, "verify", mapping, source, "destination_only_retained");
      delete evidence.sourceEvidence;
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
    // A1/A4 before A6: an unsettled final revision must not record a go-live baseline.
    if (ctx.stage === "final")
      assertSettledInventory(ctx, mapping, await sourceInventory(ctx, mapping));
    const baseline = goLiveBaseline(ctx, mapping, {
      hashType: primaryHash,
      md5: needsMd5,
      digest: destinationDigest(
        destinationHashes.values(),
        destinationMd5.values(),
        destinationFolders,
      ),
    });
    if (baseline) yield baseline;
  }
}

async function* preflight(ctx: FileContext): AsyncIterable<CheckResult> {
  const provider = ctx.provider;
  let about: GoogleAbout | undefined;
  try {
    about = await provider.googleAbout();
  } catch {
    // An inaccessible identity cannot be bound into the plan.
  }
  const actualSubject = about?.user.emailAddress ?? null;
  if (ctx.config.impersonate) {
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
  } else {
    const pass = Boolean(actualSubject);
    yield {
      id: "google.actingAccount",
      title: "Google identifies the acting service account",
      status: pass ? "pass" : "fail",
      ...(pass ? {} : { code: "preflight_failed" }),
      evidence: { actualSubject },
    };
    if (!pass) return;
  }
  if (ctx.config.mappings.some((m) => m.createDrive)) {
    const canCreateDrives = about?.canCreateDrives ?? false;
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
  yield { title: "Migration stage", format: "text", body: ctx.stage ?? "unstaged" };
  if (rcloneProof(ctx))
    yield {
      title: "Proof level",
      format: "text",
      body: [
        "rclone proof: approval binds mapping roots, drives, members and options, not a per-file inventory. Copying starts without a preview or source freshness check.",
        "rclone selects files by size and modification time and checks each upload's size. SharePoint and Drive share no hash type, so rclone cannot compare content hashes on this route.",
        "Verification compares rclone listings of source and destination by path and size, folders included. It reads no content again and makes no independent content comparison.",
        "Version history, list-item fields, retention labels and permissions are not copied and are not enumerated per file. OneNote notebooks are copied as their section files.",
        ...(ctx.config.options?.mirror
          ? [
              "Before each mirror pass that finds destination files, rclone lists both sides and records every destination-only file as to_be_deleted; the pass may delete exactly that many.",
            ]
          : []),
      ].join("\n"),
    };
  if (ctx.stage === "final")
    yield {
      title: "Settled confirmation",
      format: "text",
      body: JSON.stringify(
        ctx.config.mappings.map(
          (mapping) =>
            settleState(ctx, mapping) ?? {
              mappingId: mapping.id,
              revision: ctx.revision,
              outcome: "pending",
              maxPasses: ctx.config.options?.settleMaxPasses ?? 3,
              consistencyIntervalMs: ctx.config.options?.consistencyIntervalMs ?? 30_000,
              passes: 0,
              observations: [],
            },
        ),
      ),
    };
  const coverage = (ctx.resume.rows ?? []).flatMap((item) =>
    item.jobType === "file_migration" && item.phase === "verify" && item.fileScope?.verification
      ? [{ mappingId: item.mappingId, ...item.fileScope.verification, sourceInventory: undefined }]
      : [],
  );
  yield {
    title: "Verification scope",
    format: "text",
    body: JSON.stringify({
      requested: ctx.config.options?.deltaVerification ?? "full",
      proof: coverage.some((item) => item.scope === "partial") ? "partial proof" : "full",
      mappings: coverage,
      limitation:
        "Partial proof does not recheck independent destination damage to unchanged paths. Earlier exceptions remain visible; final verification is always full.",
    }),
  };
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
      : ctx.actingGoogleAccount
        ? `Acting account: ${ctx.actingGoogleAccount} (service account; impersonation off).`
        : "The service-account address was not recorded in this plan (impersonation off).",
  };
  if (ctx.config.impersonate)
    yield {
      title: "Open cleanup items",
      format: "text",
      body: "Delete the service-account key after the job.\nDelete the domain-wide delegation entry after the job.",
    };
  // Only SharePoint sources hold OneNote notebooks; the reverse route refuses "copy".
  if (ctx.config.route !== "shared_drive_to_sharepoint_library")
    yield {
      title: "OneNote notebooks",
      format: "text",
      body:
        ctx.config.options?.oneNoteNotebooks === "copy"
          ? "OneNote notebooks are copied as folders of section files: a read-only reference copy, not a working notebook in Google. Download the folder and open Open Notebook.onetoc2 in OneNote for Windows; it cannot open on Mac or in Drive. Editing through Drive for desktop is unsafe: notebooks must sync through OneNote, not file-sync clients."
          : "OneNote notebooks are omitted by default: Google Drive cannot open them. Each omission records the source link and section count. Open the notebook in OneNote for Windows, export the notebook (.onepkg) or PDF, and upload that export to the destination drive.",
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
  const timing = memberGrantTiming(ctx.config.options);
  const mirrorWarnings = [];
  if (ctx.config.options?.mirror)
    for (const mapping of ctx.config.mappings) {
      const driveId = provisionedMapping(ctx, mapping).destDriveId;
      const members = new Map(
        (ctx.resume.memberGrants ?? [])
          .filter((grant) => grant.mappingId === mapping.id || grant.driveId === driveId)
          .map((grant) => [
            JSON.stringify([grant.member.email.toLowerCase(), grant.member.type]),
            grant.member,
          ]),
      );
      if (timing === "before_copy")
        for (const member of mapping.createDrive?.members ?? [])
          members.set(JSON.stringify([member.email.toLowerCase(), member.type]), member);
      const writableMembers = [...members.values()].filter(
        (member) => member.role !== "reader" && member.role !== "commenter",
      ).length;
      if (writableMembers)
        mirrorWarnings.push({
          mappingId: mapping.id,
          driveId: driveId ?? null,
          writableMembers,
          warning: `${writableMembers} manifest members have or will receive write access before this mirror pass; mirror may overwrite or delete their files.`,
        });
    }
  yield {
    title: "Member grants",
    format: "text",
    body: JSON.stringify({
      memberGrants: timing,
      authorization:
        timing === "after_verification"
          ? "Close authorizes go-live after verification and accepted findings; transfers are permanently fenced before grants."
          : "Execute grants manifest members before copying.",
      mirrorWarnings,
      isolation:
        "External grants, administrators and group membership are outside Migmate's control; restrict other access before claiming staged isolation.",
    }),
  };
  const goLiveDrives = (ctx.resume.createdDrives ?? []).filter((drive) => drive.goLive);
  if (goLiveDrives.length)
    yield {
      title: "Go-live",
      format: "text",
      body: JSON.stringify({
        accessMayExist: true,
        transfersFenced: true,
        checksPassed: goLiveDrives.every((drive) => drive.goLive?.check?.status === "passed"),
        resolution:
          "If close fails or is interrupted, some access may already exist. Resolve membership or destination drift with an operator and retry close; do not run another copy or mirror pass.",
        drives: goLiveDrives.map((drive) => ({
          mappingId: drive.mappingId,
          driveId: drive.driveId,
          ...drive.goLive,
        })),
        driftScope:
          "Destination file paths, sizes, stored hashes and identities plus folder paths are compared with verification. This is a point-in-time listing check, not downloaded content, inherited permissions, effective group membership, or a future-write guarantee.",
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
        ? `Mirror removes only ${rcloneProof(ctx) ? "listed" : "approved"} destination-only content in job-created drives, capped at ${ctx.config.options.deleteLimit} cumulative file deletions across final settling attempts; a larger scope requires a new plan.`
        : "Destination-only content and source-deleted prior copies are retained, never deleted.",
      "rclone copies mappings concurrently within the approved limit in one managed worker, preserves supported created and modified times and file types, and creates empty source directories, which keep modification times only. Owner, permission and label metadata are not copied.",
      "Copy passes can replace same-path content; private markers, reserved ids, move-by-id and compare-then-write protection are not used for file migrations.",
      "Verification is a timestamped point-in-time statement, not a source freeze or future-drift guarantee. Settled confirmation is recorded separately; partial intermediate proof is not cutover parity.",
      ...(ctx.config.options?.acceptedOmissions?.length
        ? [
            `Accepted in advance by approving this plan: ${ctx.config.options.acceptedOmissions.join(", ")}. Each verification records those that this plan contains as accepted exceptions under its approver; every other finding still needs explicit acceptance.`,
          ]
        : []),
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
    const planned = plannedScope(ctx, mapping);
    const preview = planned?.jobType === "file_migration" ? planned.fileScope?.preview : undefined;
    const byteTotals = preview
      ? Object.fromEntries(
          (["new", "changed", "unchanged", "deleted", "retained", "timestampOnly"] as const).map(
            (kind) => [kind, preview[kind].reduce((sum, item) => sum + item.size, 0)],
          ),
        )
      : undefined;
    yield {
      title: `Mapping ${mapping.id}`,
      format: "text",
      body: JSON.stringify({
        sourceDriveId: mapping.sourceDriveId,
        sourceItemId: mapping.sourceItemId,
        destDriveId: mapping.destDriveId,
        destFolderId: mapping.destFolderId,
        revision: ctx.revision,
        preview,
        byteTotals,
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
