import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CODE_BY_NAME } from "../codes.ts";
import { canonicalJson } from "../store/digest.ts";
import { validateMappingTrees } from "../manifest.ts";
import {
  fileProviderPair,
  type FileProviderId,
  type FileProviderCapabilities,
} from "../providers/adapters/capabilities.ts";
import { UploadLedgerError, type UploadAttempt } from "../store/uploads.ts";
import type {
  CheckResult,
  CreatedDrive,
  GoLiveAcknowledgment,
  GoLiveCheck,
  MappingPass,
} from "../types.ts";
import { checkedBeforeGrant, goLiveCheckSettled, unsettledGoLiveCheck } from "../go-live.ts";
import { HttpProviderFault, retryableStatus } from "../providers/http.ts";
import { DiskListing, indexListing, disposeListing } from "../providers/listing.ts";
import type {
  CopyPassReference,
  DestinationEntry,
  DriveMember,
  FilePassRoot,
  DriveMembership,
  FileHashEntry,
  ProviderPort,
  SourceEntry,
} from "../providers/port.ts";
import type { CommitFinding, CommitUnit, JobTypeDriver, ReportSection } from "./types.ts";
import { ReportText, reportJson } from "../report.ts";
import {
  FilePlanRevisionRequiredError,
  hashStream,
  terminalUnavailable,
  sourceEvidence,
  type FileContext,
  type FileEvidenceRow,
  type FileSettleState,
} from "./file-state.ts";

export interface FileMappingConfig {
  id: string;
  sourceType?: FileProviderId;
  sourceDriveId: string;
  sourceItemId: string;
  sourceFolderPath?: string;
  destDriveId?: string;
  destFolderId?: string;
  destFolderPath?: string;
  createDrive?: { name: string; members: DriveMember[] };
}

export interface FileMigrationConfig {
  /** One fixed provider pair for every mapping in the job. */
  sourceProvider?: FileProviderId;
  destinationProvider?: FileProviderId;
  mappings: FileMappingConfig[];
  impersonate?: boolean;
  subject?: string;
  options?: {
    verificationMode?: "hash";
    mappingsInFlight?: number;
    transfersPerMapping?: number;
    mirror?: boolean;
    deleteLimit?: number;
    /** ADR-0012 A1: the job runs prestage, deltas and a final revision before go-live. */
    staged?: boolean;
    consistencyIntervalMs?: number;
    settleMaxPasses?: number;
    /** ADR-0012 A6: when manifest members are granted. Default follows `staged`. */
    memberGrants?: "before_copy" | "after_verification";
  };
}

/** ADR-0012 A6: staged jobs grant at go-live (`close`) unless the plan says otherwise. */
export function memberGrantTiming(
  options: FileMigrationConfig["options"],
): "before_copy" | "after_verification" {
  return options?.memberGrants ?? (options?.staged ? "after_verification" : "before_copy");
}

const COPY_DEFAULTS = { mappingsInFlight: 2, transfersPerMapping: 4 };

type Phase = "plan" | "execute" | "verify";
interface SourceView extends SourceEntry {
  path: string;
  representable: boolean;
  outsideRoot: boolean;
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
      detail.accessMayExist
        ? "Go-live checks failed. Some access may already exist; review the evidence and retry or explicitly acknowledge the failed checks, then retry close."
        : "Pre-grant destination checks failed. No go-live access was granted; repair and reverify before retrying close.",
    );
    this.detail = detail;
  }
}

function membershipIdentities(members: DriveMembership[]): string[] {
  return members
    .map((member) => JSON.stringify([member.email.toLowerCase(), member.type, member.role]))
    .sort();
}

/** Hash the historical JSON representation without building its arrays or string. */
export function destinationDigest(
  files: DiskListing<FileHashEntry>,
  md5: DiskListing<FileHashEntry>,
  folders: DiskListing<string>,
): string {
  const hash = createHash("sha256").update("[");
  const array = <T>(values: Iterable<T>, encode: (value: T) => unknown) => {
    hash.update("[");
    let comma = false;
    for (const value of values) {
      if (comma) hash.update(",");
      hash.update(JSON.stringify(encode(value)));
      comma = true;
    }
    hash.update("]");
  };
  for (const [index, items] of [files, md5].entries()) {
    if (index) hash.update(",");
    array(
      items.sorted((a, b) => a.path.localeCompare(b.path)),
      (item) => [item.path, item.size, item.hash, item.id ?? null],
    );
  }
  hash.update(",");
  array(
    folders.sorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    (path) => path,
  );
  return hash.update("]").digest("hex");
}

async function destinationCheck(
  ctx: FileContext,
  mapping: FileMappingConfig,
  drive: CreatedDrive,
): Promise<GoLiveCheck> {
  const baseline = drive.verifiedDestination;
  const pass = await ctx.provider.resolveFilePass(
    destinationMapping(provisionedMapping(ctx, mapping)),
  );
  const resources: Disposable[] = [];
  try {
    const files = indexListing(
      await ctx.provider.listFileHashes({
        socketPath: pass.socketPath,
        root: pass.destination,
        hashType: baseline?.hashType ?? "sha256",
        download: false,
        ...abortable(ctx),
      }),
    );
    resources.push(files);
    const md5 = indexListing(
      baseline?.md5
        ? await ctx.provider.listFileHashes({
            socketPath: pass.socketPath,
            root: pass.destination,
            hashType: "md5",
            download: false,
            ...abortable(ctx),
          })
        : [],
    );
    resources.push(md5);
    const folders = indexListing(
      await ctx.provider.listFolders({
        socketPath: pass.socketPath,
        root: pass.destination,
        ...abortable(ctx),
      }),
      (path) => path,
    );
    resources.push(folders);
    const observed = destinationDigest(files, md5, folders);
    const matches = baseline?.revision === ctx.revision && baseline.digest === observed;
    return {
      at: ctx.now().toISOString(),
      status: matches ? "passed" : "failed",
      check: matches ? "destination" : "destination_drift",
      evidence: {
        expectedDestinationDigest: baseline?.digest ?? null,
        observedDestinationDigest: observed,
      },
    };
  } finally {
    for (const resource of resources) resource[Symbol.dispose]();
  }
}

function unavailableGoLiveCheck(
  ctx: FileContext,
  error: unknown,
  evidence: Record<string, unknown>,
): GoLiveCheck {
  if (
    !(error instanceof TypeError) &&
    !(error instanceof HttpProviderFault) &&
    !terminalUnavailable(error)
  )
    throw error;
  return {
    at: ctx.now().toISOString(),
    status: "failed",
    check: "go_live_check_unavailable",
    evidence: {
      ...evidence,
      ...(error instanceof HttpProviderFault ? { status: error.status } : {}),
    },
  };
}

/** Close checks the whole unfenced batch before authorizing any new access. */
export async function* goLive(
  ctx: FileContext,
  verificationAt: string,
  recovery: { authorityDigest: string; acknowledgments: GoLiveAcknowledgment[] },
): AsyncIterable<CommitUnit> {
  const affected = ctx.config.mappings.filter((mapping) => mapping.createDrive);
  const unit = (mapping: FileMappingConfig, drive: CreatedDrive, key: string): CommitUnit => ({
    rev: ctx.revision,
    phase: "execute",
    unitKey: key,
    checkpoint: mapping.id,
    rows: [],
    findings: [],
    createdDrive: drive,
  });
  const failures: Record<string, unknown>[] = [];
  for (const mapping of affected) {
    const drive = ctx.resume.createdDrives?.find((item) => item.mappingId === mapping.id);
    if (!drive?.driveId) throw new Error("Go-live requires a durable created drive");
    if (drive.goLive) continue;
    let check: GoLiveCheck;
    try {
      check = await destinationCheck(ctx, mapping, drive);
    } catch (error) {
      check = unavailableGoLiveCheck(ctx, error, { scope: "destination" });
    }
    // Always observe again on a fresh attempt: repair may have changed even a prior pass.
    drive.preGrantCheck = { revision: ctx.revision, verificationAt, check };
    yield unit(
      mapping,
      drive,
      JSON.stringify(["pre-grant-check", drive.driveId, digest(drive.preGrantCheck)]),
    );
    if (check.status === "failed")
      failures.push({
        mappingId: mapping.id,
        driveId: drive.driveId,
        check: check.check,
        ...check.evidence,
      });
  }
  if (failures.length)
    throw new GoLiveCheckError({
      accessMayExist: ctx.resume.createdDrives?.some((drive) => drive.goLive) ?? false,
      ...failures[0],
      failures,
    });

  // Persist every fence before the first request, including later drives in a crash.
  for (const mapping of affected) {
    const drive = ctx.resume.createdDrives!.find((item) => item.mappingId === mapping.id)!;
    if (drive.goLive) continue;
    drive.goLive = { startedAt: ctx.now().toISOString(), revision: ctx.revision, verificationAt };
    yield unit(mapping, drive, JSON.stringify(["go-live-fence", drive.driveId]));
  }
  // Settled checks never substitute for missing or ambiguous grant checkpoints.
  yield* grantMembers({
    ...ctx,
    now: () => new Date(Math.max(ctx.now().getTime(), Date.parse(verificationAt) + 1)),
  });
  for (const mapping of affected) {
    const drive = ctx.resume.createdDrives!.find((item) => item.mappingId === mapping.id)!;
    const unsettled =
      drive.goLive?.revision === ctx.revision && drive.goLive.verificationAt === verificationAt
        ? unsettledGoLiveCheck(drive, recovery.authorityDigest, recovery.acknowledgments)
        : "check";
    if (!unsettled) continue;
    let check: GoLiveCheck;
    if (unsettled === "destinationCheck") {
      // Keep the settled membership evidence; finish only the content proof it never reached.
      try {
        check = await destinationCheck(ctx, mapping, drive);
      } catch (error) {
        check = unavailableGoLiveCheck(ctx, error, { scope: "destination" });
      }
      drive.goLive = { ...drive.goLive!, destinationCheck: check };
    } else {
      const expected = [...mapping.createDrive!.members];
      if (
        !expected.some(
          (member) =>
            member.type === "user" &&
            member.email.toLowerCase() === drive.creatorEmail.toLowerCase(),
        )
      )
        expected.push({
          email: drive.creatorEmail,
          type: "user",
          role: fileProviderPair(ctx.config).destination.creatorRole,
        });
      const membershipOnly = checkedBeforeGrant(drive);
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
        } else if (membershipOnly) {
          check = {
            at: ctx.now().toISOString(),
            status: "passed",
            check: "membership",
            evidence: { expected, actual },
          };
        } else {
          // Already-live jobs retain their original content baseline, not invented pregrant proof.
          const destination = await destinationCheck(ctx, mapping, drive);
          check = {
            ...destination,
            check:
              destination.status === "passed" ? "membership_and_destination" : destination.check,
            evidence: { expected, actual, ...destination.evidence },
          };
        }
      } catch (error) {
        check = unavailableGoLiveCheck(ctx, error, {
          expected,
          scope: membershipOnly ? "membership" : "membership_and_destination",
        });
      }
      // A new membership observation supersedes content proof finished after the old one.
      const { destinationCheck: _superseded, ...live } = drive.goLive!;
      drive.goLive = { ...live, check };
    }
    yield unit(
      mapping,
      drive,
      JSON.stringify([
        unsettled === "check" ? "go-live-check" : "go-live-destination-check",
        drive.driveId,
        digest(check),
      ]),
    );
    if (check.status === "failed")
      failures.push({
        mappingId: mapping.id,
        driveId: drive.driveId,
        check: check.check,
        ...check.evidence,
      });
  }
  if (failures.length)
    throw new GoLiveCheckError({ accessMayExist: true, ...failures[0], failures });
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
    nextStep: null,
    omissionReason: null,
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
    digest([evidence.sourceEvidence, evidence.code]),
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

async function sourceRoot(ctx: FileContext, mapping: FileMappingConfig): Promise<SourceView> {
  const root = await ctx.provider.resolveSourceRoot({ ...mapping, ...abortable(ctx) });
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
  const root = await ctx.provider.resolveDestinationFolder({
    ...destinationMapping(mapping),
    ...abortable(ctx),
  });
  if (!root || root.kind !== "folder" || root.driveId !== mapping.destDriveId)
    throw Object.assign(new Error("The destination root is missing or is not an ordinary folder"), {
      code: "unsupported_route",
    });
  return root;
}

/** Count the observed wrapper and ancestors, not just the source-relative path. */
async function destinationFolderDepth(
  ctx: FileContext,
  mapping: FileMappingConfig,
): Promise<number> {
  let current = await destinationRoot(ctx, mapping);
  let depth = 0;
  const seen = new Set<string>();
  while (current.parentId !== null) {
    if (seen.has(current.id)) throw new Error("Destination folder ancestry contains a cycle");
    seen.add(current.id);
    depth++;
    const parent = ctx.provider.readDestinationObject
      ? await ctx.provider.readDestinationObject({
          driveId: current.driveId,
          objectId: current.parentId,
          ...abortable(ctx),
        })
      : await ctx.provider.resolveDestinationFolder({
          destDriveId: current.driveId,
          destFolderId: current.parentId,
          ...abortable(ctx),
        });
    if (!parent || parent.kind !== "folder" || parent.driveId !== current.driveId)
      throw new Error("Destination folder ancestry could not be proven");
    current = parent;
  }
  return depth;
}

/** Provider-native inventory finds exceptional content omitted by transfer listings. */
async function* sourceContentFindings(
  ctx: FileContext,
  mapping: FileMappingConfig,
  root: SourceView,
  classify: NonNullable<FileProviderCapabilities["sourceEntryFindings"]>,
): AsyncIterable<{
  source: SourceView;
  codes: readonly string[];
  evidence?: Record<string, unknown>;
}> {
  const pending = [{ id: root.id, path: "" }];
  while (pending.length) {
    const parent = pending.pop()!;
    const children = await ctx.provider.listSourceChildren({
      driveId: mapping.sourceDriveId,
      itemId: parent.id,
      ...abortable(ctx),
    });
    const firstByName = new Map<string, SourceEntry>();
    const collisions = new Map<string, string[]>();
    for (const child of children) {
      const first = firstByName.get(child.name);
      if (!first) firstByName.set(child.name, child);
      else if (first.id !== child.id) {
        const ids = collisions.get(child.name);
        if (ids) ids.push(child.id);
        else collisions.set(child.name, [first.id, child.id]);
      }
    }
    for (const child of children) {
      const path = parent.path ? `${parent.path}/${child.name}` : child.name;
      if (child.kind === "folder") pending.push({ id: child.id, path });
      const sourceIds = collisions.get(child.name);
      const codes = sourceIds
        ? ["destination_duplicate_name", ...classify(child)]
        : classify(child);
      if (codes.length)
        yield {
          source: { ...child, path, representable: true, outsideRoot: false },
          codes,
          ...(sourceIds
            ? { evidence: { sourceIds, originalName: child.metadata?.originalName ?? child.name } }
            : {}),
        };
    }
  }
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
 * What a pass would still change, from rclone listings of each side. Folders
 * are compared too: rclone's file listing cannot see a new empty source folder.
 */
async function rclonePending(
  ctx: FileContext,
  mapping: FileMappingConfig,
): Promise<DiskListing<string>> {
  const resolved = await ctx.provider.resolveFilePass(destinationMapping(mapping));
  const resources: unknown[] = [];
  const pending = new DiskListing<string>((path) => path);
  try {
    const comparison = await ctx.provider.compareFileListings({
      ...resolved,
      mode: ctx.config.options?.mirror ? "mirror" : "copy",
      ...abortable(ctx),
    });
    resources.push(...Object.values(comparison));
    const expected = indexListing(
      await ctx.provider.listFolders({
        socketPath: resolved.socketPath,
        root: resolved.source,
        ...abortable(ctx),
      }),
      (path) => path,
    );
    resources.push(expected);
    const present = indexListing(
      await ctx.provider.listFolders({
        socketPath: resolved.socketPath,
        root: resolved.destination,
        ...abortable(ctx),
      }),
      (path) => path,
    );
    resources.push(present);
    for (const entries of [
      comparison.new,
      comparison.changed,
      comparison.timestampOnly,
      comparison.deleted,
    ]) {
      for (const entry of entries) pending.add(entry.path);
    }
    for (const path of expected) if (!present.has(path)) pending.add(path);
    if (ctx.config.options?.mirror) {
      for (const path of present) if (!expected.has(path)) pending.add(path);
    }
    return pending;
  } catch (error) {
    pending[Symbol.dispose]();
    throw error;
  } finally {
    for (const resource of resources) disposeListing(resource);
  }
}

/**
 * Before a mirror pass, record destination-only files and folders from fresh listings.
 * rclone's deletion limit counts files; folder removals are recorded separately.
 */
async function* mirrorDeletions(
  ctx: FileContext,
  mapping: FileMappingConfig,
  passNumber: number,
  reserved: number,
): AsyncGenerator<CommitUnit, number> {
  if (!ctx.config.options?.mirror) return 0;
  const resolved = await ctx.provider.resolveFilePass(destinationMapping(mapping));
  const resources: unknown[] = [];
  try {
    const comparison = await ctx.provider.compareFileListings({
      ...resolved,
      mode: "mirror",
      ...abortable(ctx),
    });
    resources.push(...Object.values(comparison));
    const deleted = indexListing(comparison.deleted);
    resources.push(deleted);
    if (reserved + deleted.size > ctx.config.options.deleteLimit!)
      throw new FilePlanRevisionRequiredError(
        "Mirror would delete more destination files than deleteLimit allows; review the source, then raise deleteLimit in a new plan.",
      );
    const expectedFolders = indexListing(
      await ctx.provider.listFolders({
        socketPath: resolved.socketPath,
        root: resolved.source,
        ...abortable(ctx),
      }),
      (path) => path,
    );
    resources.push(expectedFolders);
    const destinationFolders = indexListing(
      await ctx.provider.listFolders({
        socketPath: resolved.socketPath,
        root: resolved.destination,
        ...abortable(ctx),
      }),
      (path) => path,
    );
    resources.push(destinationFolders);
    let rows: FileEvidenceRow[] = [];
    let page = 0;
    for (const entries of [
      (function* () {
        for (const entry of deleted) yield { ...entry, kind: "file" as const };
      })(),
      (function* () {
        for (const path of destinationFolders)
          if (path !== "." && !expectedFolders.has(path))
            yield { path, size: null, kind: "folder" as const };
      })(),
    ]) {
      for (const entry of entries) {
        const id = `destination:${entry.path}`;
        const evidence = row(
          ctx,
          "execute",
          mapping,
          listedItem(mapping.sourceDriveId, id, entry.path, entry.kind, entry.size),
          "to_be_deleted",
        );
        delete evidence.sourceEvidence;
        evidence.id = JSON.stringify([mapping.id, id, "execute", passNumber]);
        evidence.destinationDriveId = mapping.destDriveId ?? null;
        rows.push(evidence);
        if (rows.length === 1000) {
          yield {
            rev: ctx.revision,
            phase: "execute",
            unitKey: JSON.stringify(["mirror-deletions", mapping.id, passNumber, page++]),
            checkpoint: mapping.id,
            rows,
            findings: [],
          };
          rows = [];
        }
      }
    }
    if (rows.length)
      yield {
        rev: ctx.revision,
        phase: "execute",
        unitKey: JSON.stringify(["mirror-deletions", mapping.id, passNumber, page]),
        checkpoint: mapping.id,
        rows,
        findings: [],
      };
    return deleted.size;
  } finally {
    for (const resource of resources) disposeListing(resource);
  }
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

/** Approval binds mapping roots, not a per-file inventory. */
async function* collect(ctx: FileContext): AsyncIterable<CommitUnit> {
  await validateMappingTrees(
    ctx.provider,
    ctx.config.mappings.map((mapping) => provisionedMapping(ctx, mapping)),
    ctx.signal,
  );
  let done = 0;
  const sourcePlanning = await ctx.provider.sourcePlanningEvidence?.(ctx.signal);
  const sourceDisclosures = [
    ...(fileProviderPair(ctx.config).source.sourceDisclosures ?? []),
    ...(sourcePlanning?.notices ?? []),
  ];
  for (const planned of ctx.config.mappings) {
    const mapping = provisionedMapping(ctx, planned);
    const root = await sourceRoot(ctx, mapping);
    if (!mapping.createDrive || mapping.destDriveId) await destinationRoot(ctx, mapping);
    const evidence = row(ctx, "plan", mapping, root, "unchanged");
    evidence.destinationDriveId = mapping.destDriveId ?? null;
    evidence.destinationFileId = mapping.destFolderId ?? null;
    evidence.fileScope = {
      mapOnly: true,
      ...(sourceDisclosures.length ? { sourceDisclosures } : {}),
      ...(sourcePlanning && Object.keys(sourcePlanning.evidence).length
        ? { sourceObservation: sourcePlanning.evidence }
        : {}),
    };
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

async function* execute(ctx: FileContext): AsyncIterable<CommitUnit> {
  yield* provision(ctx);
  const quotaStop = new AbortController();
  ctx = {
    ...ctx,
    signal: ctx.signal ? AbortSignal.any([ctx.signal, quotaStop.signal]) : quotaStop.signal,
  };
  const mappings = ctx.config.mappings[Symbol.iterator]();
  const active = new Set<AsyncGenerator<CommitUnit | null>>();
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
        // A suppressed stats observation still yields its scheduler turn.
        if (next.value === null) continue;
        const pass = next.value.mappingPass;
        if (pass?.uploadQuota && !quotaStop.signal.aborted) quotaStop.abort();
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

async function* copyMapping(
  ctx: FileContext,
  mapping: FileMappingConfig,
): AsyncGenerator<CommitUnit | null> {
  const previous = (ctx.resume.mappingPasses ?? [])
    .filter((pass) => pass.mappingId === mapping.id)
    .at(-1);
  const final = ctx.stage === "final";
  let state = final ? settleState(ctx, mapping) : undefined;
  if (state?.outcome === "exhausted") throw cutoverIncomplete();
  if (state?.outcome === "settled" || (!final && previous?.status === "completed")) return;
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
      observations: [],
    };
  for (;;) {
    if (copyNeeded) {
      const passNumber =
        state?.copyPassNumber ??
        (previous?.status === "pending" ? previous.passNumber : (previous?.passNumber ?? 0) + 1);
      const authorized = yield* mirrorDeletions(
        ctx,
        mapping,
        passNumber,
        state?.deletionsReserved ?? 0,
      );
      if (state) {
        state.copyPending = true;
        state.deletionsReserved += authorized;
        yield settleUnit(ctx, state);
      }
      let completed = false;
      for await (const unit of copyPass(ctx, mapping, passNumber, authorized)) {
        completed = unit?.mappingPass?.status === "completed";
        if (completed && state && unit) {
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
    const pending = await rclonePending(ctx, mapping);
    try {
      state.outcome =
        pending.size === 0 ? "settled" : state.passes >= state.maxPasses ? "exhausted" : "pending";
      let changedPaths: string[] = [];
      let changedPathPages = 0;
      const changedPathGeneration = randomUUID();
      for (const path of pending.sorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        changedPaths.push(path);
        if (pending.size > 1000 && changedPaths.length === 1000) {
          const unitKey = `file-settle-paths:${mapping.id}:${changedPathGeneration}:${changedPathPages++}`;
          yield {
            rev: ctx.revision,
            phase: "execute",
            unitKey,
            checkpoint: mapping.id,
            rows: [],
            findings: [],
            watermark: { unitKey, value: JSON.stringify(changedPaths) },
          };
          changedPaths = [];
        }
      }
      if (changedPathPages && changedPaths.length) {
        const unitKey = `file-settle-paths:${mapping.id}:${changedPathGeneration}:${changedPathPages++}`;
        yield {
          rev: ctx.revision,
          phase: "execute",
          unitKey,
          checkpoint: mapping.id,
          rows: [],
          findings: [],
          watermark: { unitKey, value: JSON.stringify(changedPaths) },
        };
        changedPaths = [];
      }
      state.observations.push({
        at: ctx.now().toISOString(),
        changedPaths,
        ...(changedPathPages ? { changedPathPages, changedPathGeneration } : {}),
        outcome: state.outcome === "pending" ? "changed" : state.outcome,
      });
    } finally {
      pending[Symbol.dispose]();
    }
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
  passNumber: number,
  authorizedDeletions: number,
): AsyncGenerator<CommitUnit | null> {
  let pass = pendingPass(
    ctx.revision,
    mapping.id,
    passNumber,
    ctx.config.options?.mirror ? "mirror" : "copy",
  );
  pass = { ...pass, startedAt: ctx.now().toISOString() };
  let sequence = 0;
  let publishedAt: number | undefined;
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
  let upload: UploadAttempt | undefined;
  let lastObservation: { bytes: number; at: Date } | undefined;
  async function stopAndReconcile(): Promise<void> {
    const stopping = reference;
    if (!stopping) return;
    reference = undefined;
    let stopped = false;
    let stopError: unknown;
    try {
      await ctx.provider.stopCopyPass(stopping);
      stopped = true;
    } catch (error) {
      stopError = error;
    }
    if (upload) {
      let terminal = false;
      let finalStats;
      try {
        terminal = (await ctx.provider.copyPassStatus(stopping)).state !== "running";
      } catch {
        // A stop acknowledgment is not proof that the transfer function ended.
      }
      try {
        finalStats = await ctx.provider.copyPassStats(stopping);
      } catch {
        // Worker teardown may have already discarded its counter.
      }
      if (finalStats) {
        const transferring = finalStats.transferring.slice(0, 5);
        const transferringTotal = finalStats.transferringTotal ?? finalStats.transferring.length;
        pass = {
          ...pass,
          lastStats: {
            ...finalStats,
            transferring,
            transferringTotal,
            transferringTruncated: transferringTotal > transferring.length,
          },
        };
        upload.observe(finalStats.bytes, ctx.now(), terminal);
      } else if (lastObservation) {
        upload.observe(lastObservation.bytes, lastObservation.at);
      }
      if (!terminal || !finalStats)
        upload.missing(
          ctx.now(),
          terminal
            ? "terminal_counter_unavailable_after_stop"
            : "copy_pass_termination_unconfirmed",
          terminal,
        );
    }
    if (!stopped) throw stopError;
  }
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
    const resolved = await ctx.provider.resolveFilePass(destinationMapping(mapping));
    const { source: sourceAdapter, destination: destinationAdapter } = fileProviderPair(ctx.config);
    if (sourceAdapter.sourceEntryFindings) {
      let blocked = false;
      for await (const item of sourceContentFindings(
        ctx,
        mapping,
        await sourceRoot(ctx, mapping),
        sourceAdapter.sourceEntryFindings,
      )) {
        if (!item.codes.includes("destination_duplicate_name")) continue;
        blocked = true;
        const evidence = row(ctx, "execute", mapping, item.source, "destination_duplicate_name");
        evidence.destinationDriveId = mapping.destDriveId ?? null;
        yield {
          ...unit(),
          rows: [evidence],
          findings: [
            finding(ctx, "execute", "destination_duplicate_name", item.source.id, {
              path: item.source.path,
              ...item.evidence,
            }),
          ],
        };
      }
      if (blocked) {
        pass = {
          ...pass,
          status: "failed",
          endedAt: ctx.now().toISOString(),
          error:
            "Source objects resolve to the same exported path; fix the named source conflicts before retrying.",
        };
        yield unit();
        return;
      }
    }
    if (destinationAdapter.destinationPathFindings) {
      const constraintRoot = { folderDepth: await destinationFolderDepth(ctx, mapping) };
      const folders = await ctx.provider.listFolders({
        socketPath: resolved.socketPath,
        root: resolved.source,
        ...abortable(ctx),
      });
      let blocked = false;
      for (const path of [".", ...folders]) {
        const conflicts = destinationAdapter.destinationPathFindings(
          path,
          "folder",
          constraintRoot,
        );
        if (!conflicts.length) continue;
        blocked = true;
        const source = listedItem(mapping.sourceDriveId, `path:${path}`, path, "folder", null);
        const evidence = row(ctx, "execute", mapping, source, conflicts[0]!.code);
        evidence.destinationDriveId = mapping.destDriveId ?? null;
        yield {
          ...unit(),
          rows: [evidence],
          findings: conflicts.map((conflict) =>
            finding(ctx, "execute", conflict.code, source.id, {
              path,
              itemType: "folder",
              destinationRootDepth: constraintRoot.folderDepth,
              message: conflict.message,
            }),
          ),
        };
      }
      if (blocked) {
        pass = {
          ...pass,
          status: "failed",
          endedAt: ctx.now().toISOString(),
          error:
            "Destination path constraints prevent this mapping from copying; fix the named source paths or mapping root before retrying.",
        };
        yield unit();
        return;
      }
    }
    if (fileProviderPair(ctx.config).destination.ledgerAccountedUploads)
      upload = ctx.beginUpload?.(
        "file",
        JSON.stringify([mapping.id, passNumber]),
        ctx.actingGoogleAccount,
      );
    const handle = await ctx.provider.startCopyPass({
      ...resolved,
      ...(ctx.config.options?.mirror
        ? { mode: "mirror" as const, deleteLimit: authorizedDeletions }
        : { mode: "copy" as const }),
      transfers: ctx.config.options?.transfersPerMapping ?? COPY_DEFAULTS.transfersPerMapping,
    });
    reference = { socketPath: resolved.socketPath, pass: handle };
    upload?.observe(
      0,
      ctx.now(),
      false,
      JSON.stringify([handle.executeId, handle.group, handle.jobid]),
    );
    pass = { ...pass, ...handle, status: "running", startedAt: ctx.now().toISOString() };
    yield unit();
    for (;;) {
      ctx.signal?.throwIfAborted();
      const status = await ctx.provider.copyPassStatus(reference);
      const stats = await ctx.provider.copyPassStats(reference);
      lastObservation = { bytes: stats.bytes, at: ctx.now() };
      const transferring = stats.transferring.slice(0, 5);
      const transferringTotal = stats.transferringTotal ?? stats.transferring.length;
      const lastStats = {
        ...stats,
        transferring,
        transferringTotal,
        transferringTruncated: transferringTotal > transferring.length,
      };
      const uploadQuota =
        status.state === "failed"
          ? fileProviderPair(ctx.config).destination.quotaStop?.(ctx, status.error)
          : undefined;
      const evidenceChanged =
        pass.status !== status.state ||
        pass.error !== status.error ||
        pass.lastStats?.errors !== lastStats.errors;
      pass = {
        ...pass,
        status: status.state,
        error: status.error,
        lastStats: uploadQuota
          ? { ...lastStats, errors: null, rcloneErrors: lastStats.errors }
          : lastStats,
        ...(uploadQuota ? { uploadQuota } : {}),
        endedAt: status.state === "running" ? null : ctx.now().toISOString(),
      };
      const observedAt = ctx.now().getTime();
      if (
        publishedAt === undefined ||
        status.state !== "running" ||
        evidenceChanged ||
        observedAt - publishedAt >= 10_000
      ) {
        publishedAt = observedAt;
        upload?.observe(stats.bytes, new Date(observedAt), status.state !== "running");
        yield unit();
      } else {
        yield null;
      }
      if (status.state !== "running") break;
    }
  } catch (error) {
    const interrupted =
      ctx.signal?.aborted || (error instanceof Error && error.name === "AbortError");
    await stopAndReconcile();
    if (error instanceof UploadLedgerError) throw error;
    const message = interrupted ? null : error instanceof Error ? error.message : String(error);
    const uploadQuota = fileProviderPair(ctx.config).destination.quotaStop?.(ctx, message);
    pass = {
      ...pass,
      status: interrupted ? "interrupted" : "failed",
      error: message,
      ...(uploadQuota
        ? {
            uploadQuota,
            lastStats: pass.lastStats
              ? {
                  ...pass.lastStats,
                  errors: null,
                  rcloneErrors: pass.lastStats.rcloneErrors ?? pass.lastStats.errors ?? 0,
                }
              : null,
          }
        : {}),
      endedAt: ctx.now().toISOString(),
    };
    yield unit();
    if (interrupted) return;
  } finally {
    if (reference && pass.status === "running") await stopAndReconcile();
  }
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
    expected.push({
      email: drive.creatorEmail,
      type: "user",
      role: fileProviderPair(ctx.config).destination.creatorRole,
    });
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
 * Compare whole mappings by listing. Hash verification additionally downloads source
 * content using the destination's hash type, without a Graph inventory.
 */
async function* verifyListing(ctx: FileContext): AsyncIterable<CommitUnit> {
  let done = 0;
  const { source: sourceAdapter, destination: destinationAdapter } = fileProviderPair(ctx.config);
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
    if (planRow?.jobType !== "file_migration" || !planRow.fileScope?.mapOnly)
      throw new FilePlanRevisionRequiredError();
    const pass = await ctx.provider.resolveFilePass(destinationMapping(mapping));
    const hash = ctx.config.options?.verificationMode === "hash";
    const primaryHash = destinationAdapter.hashType;
    const resources: Disposable[] = [];
    try {
      const list = async (
        side: FilePassRoot,
        hashType: "quickxor" | "sha256" | "md5",
        download = false,
        paths?: string[],
      ) => {
        const result = indexListing(
          await ctx.provider.listFileHashes({
            socketPath: pass.socketPath,
            root: side,
            hashType,
            download,
            ...(paths ? { paths } : {}),
            ...abortable(ctx),
          }),
        );
        resources.push(result);
        return result;
      };
      const sources = await list(pass.source, primaryHash, hash);
      const destinations = await list(pass.destination, primaryHash);
      const sourceFolders = indexListing(
        await ctx.provider.listFolders({
          socketPath: pass.socketPath,
          root: pass.source,
          ...abortable(ctx),
        }),
        (path) => path,
      );
      resources.push(sourceFolders);
      const destinationFolders = indexListing(
        await ctx.provider.listFolders({
          socketPath: pass.socketPath,
          root: pass.destination,
          ...abortable(ctx),
        }),
        (path) => path,
      );
      resources.push(destinationFolders);
      let needsMd5 = false;
      if (primaryHash === "sha256") {
        for (const entry of destinations) {
          if (entry.hash === null) {
            needsMd5 = true;
            break;
          }
        }
      }
      const destinationMd5 = needsMd5
        ? await list(pass.destination, "md5")
        : new DiskListing<FileHashEntry>();
      resources.push(destinationMd5);
      const sourceMd5 = new DiskListing<FileHashEntry>();
      resources.push(sourceMd5);
      if (hash && needsMd5) {
        let paths: string[] = [];
        for (const entry of destinations) {
          if (entry.hash !== null) continue;
          paths.push(entry.path);
          if (paths.length === 1000) {
            const page = await list(pass.source, "md5", true, paths);
            for (const value of page) sourceMd5.add(value);
            page[Symbol.dispose]();
            resources.pop();
            paths = [];
          }
        }
        if (paths.length) {
          const page = await list(pass.source, "md5", true, paths);
          for (const value of page) sourceMd5.add(value);
          page[Symbol.dispose]();
          resources.pop();
        }
      }
      const coverage = new DiskListing<string>((path) => path);
      resources.push(coverage);
      for (const entry of sources) if (!coverage.has(entry.path)) coverage.add(entry.path);
      for (const path of sourceFolders) coverage.add(path);
      let coveredPaths: string[] = [];
      let coveragePage = 0;
      for (const path of coverage.sorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        coveredPaths.push(path);
        if (coveredPaths.length === 1000) {
          const coverageRow = row(ctx, "verify", mapping, root, "unchanged");
          coverageRow.id = JSON.stringify([
            mapping.id,
            root.id,
            "verify",
            "coverage",
            coveragePage++,
          ]);
          coverageRow.fileScope = { mapOnly: true, verification: { scope: "full", coveredPaths } };
          yield commit(ctx, "verify", coverageRow, [], coverageRow.id, ++done);
          coveredPaths = [];
        }
      }
      if (coveredPaths.length || coveragePage === 0) {
        const coverageRow = row(ctx, "verify", mapping, root, "unchanged");
        coverageRow.id = JSON.stringify([mapping.id, root.id, "verify", "coverage", coveragePage]);
        coverageRow.fileScope = { mapOnly: true, verification: { scope: "full", coveredPaths } };
        yield commit(ctx, "verify", coverageRow, [], coverageRow.id, ++done);
      }
      coverage[Symbol.dispose]();
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
        const copied = destinations.get(source.path);
        // rclone's OneDrive IDs are `driveId#itemId`; durable rows keep the item ID.
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
        const hashType = needsMd5 && copied?.hash === null ? "md5" : primaryHash;
        const sourceHash =
          hashType === "md5" ? (sourceMd5.get(source.path)?.hash ?? null) : source.hash;
        const destinationHash = copied
          ? (copied.hash ?? destinationMd5.get(copied.path)?.hash ?? null)
          : null;
        const codes: string[] = [];
        let servedSize = view.size;
        if (
          hash &&
          primaryHash === "sha256" &&
          sourceHash &&
          copied &&
          (source.size !== copied.size || sourceHash !== destinationHash)
        ) {
          if (sourceHash === destinationHash) servedSize = copied.size;
          else {
            try {
              const measured = await hashStream(
                ctx.provider.openSourceContent({ driveId: mapping.sourceDriveId, itemId: view.id }),
                ctx.signal,
              );
              if (measured.sha256 !== source.hash) codes.push("source_read_failed");
              else servedSize = measured.size;
            } catch (error) {
              if (!terminalUnavailable(error)) throw error;
              codes.push("source_read_failed");
            }
          }
          if (servedSize !== source.size) codes.push("source_size_inconsistent");
        }
        if (!copied)
          codes.push(
            destinationFolders.has(source.path)
              ? "destination_type_conflict"
              : "destination_missing",
          );
        if (hash && !sourceHash) codes.push("source_read_failed");
        if (copied) {
          const sizeMismatch =
            servedSize !== null && copied.size >= 0 && servedSize !== copied.size;
          const hashMismatch =
            hash && !!sourceHash && !!destinationHash && sourceHash !== destinationHash;
          const rewritten =
            destinationAdapter.rewritesPath(source.path) && (sizeMismatch || hashMismatch);
          if (rewritten) codes.push("destination_rewrote_file");
          else {
            if (sizeMismatch) codes.push("size_mismatch");
            if (hashMismatch) codes.push("content_mismatch");
          }
          if (hash && !destinationHash) codes.push("destination_read_failed");
        }
        const evidence = row(ctx, "verify", mapping, view, codes[0] ?? "unchanged");
        evidence.destinationDriveId = mapping.destDriveId ?? null;
        evidence.destinationFileId = copied?.id ?? null;
        evidence.sourceFingerprint = sourceHash;
        evidence.destinationFingerprint = destinationHash;
        evidence.provenanceState = codes.some((code) => code !== "source_size_inconsistent")
          ? "drifted"
          : "verified";
        yield commit(
          ctx,
          "verify",
          evidence,
          codes.map((code) =>
            finding(ctx, "verify", code, view.id, {
              path: source.path,
              sourceSize: servedSize,
              destinationSize: copied?.size ?? null,
              sourceHash,
              destinationHash,
              hashType: hash ? hashType : null,
              ...(codes.includes("source_size_inconsistent")
                ? {
                    listedSize: source.size,
                    ...(code === "source_size_inconsistent" ? { servedSize } : {}),
                    ...(code === "size_mismatch" || code === "content_mismatch"
                      ? { cause: "source_size_inconsistent" }
                      : {}),
                  }
                : {}),
            }),
          ),
          "verification",
          ++done,
        );
      }
      for (const path of sourceFolders) {
        if (destinationFolders.has(path)) continue;
        const conflicting = destinations.get(path);
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
        if (sources.has(retained.path) || sourceFolders.has(retained.path)) continue;
        const view = listedItem(
          mapping.sourceDriveId,
          `destination:${retained.path}`,
          retained.path,
          "file",
          retained.size,
        );
        const destinationHash = retained.hash ?? destinationMd5.get(retained.path)?.hash ?? null;
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
              hashType: hash
                ? retained.hash === null && destinationMd5.has(retained.path)
                  ? "md5"
                  : primaryHash
                : null,
            }),
          ],
          "retained",
          ++done,
        );
      }
      for (const path of destinationFolders) {
        if (sourceFolders.has(path) || sources.has(path)) continue;
        const view = listedItem(
          mapping.sourceDriveId,
          `destination-folder:${path}`,
          path,
          "folder",
          null,
        );
        const evidence = row(ctx, "verify", mapping, view, "destination_only_retained");
        delete evidence.sourceEvidence;
        evidence.destinationDriveId = mapping.destDriveId ?? null;
        yield commit(
          ctx,
          "verify",
          evidence,
          [
            finding(ctx, "verify", "destination_only_retained", view.id, {
              path,
              itemType: "folder",
            }),
          ],
          "retained-folder",
          ++done,
        );
      }
      const baseline = goLiveBaseline(ctx, mapping, {
        hashType: primaryHash,
        md5: needsMd5,
        digest: destinationDigest(destinations, destinationMd5, destinationFolders),
      });
      if (baseline) yield baseline;
    } finally {
      for (const resource of resources) resource[Symbol.dispose]();
    }
  }
}

async function* preflight(ctx: FileContext): AsyncIterable<CheckResult> {
  const pair = fileProviderPair(ctx.config);
  for (const adapter of [pair.source, pair.destination])
    if (adapter.preflight && !(yield* adapter.preflight(ctx))) return;
  const provider = ctx.provider;
  for (const mapping of ctx.config.mappings) {
    ctx.signal?.throwIfAborted();
    const source = await provider.resolveSourceRoot({ ...mapping, ...abortable(ctx) });
    const destination =
      mapping.createDrive && !mapping.destDriveId
        ? null
        : await provider.resolveDestinationFolder({
            ...destinationMapping(mapping),
            ...abortable(ctx),
          });
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
  yield {
    title: "Approval and verification",
    format: "text",
    body: [
      "Approval binds mapping roots, drives, members and options, not a per-file inventory.",
      "Listing verification compares paths and sizes, folders included; it compares no content.",
      ...(ctx.config.options?.verificationMode === "hash"
        ? [
            "Hash verification is enabled: rclone downloads source content to compare the destination's stored hash type.",
          ]
        : []),
      "Version history, list-item fields, retention labels and permissions are not copied. OneNote notebooks are copied as their section files.",
      ...(fileProviderPair(ctx.config).source.sourceDisclosures ?? []),
      ...(ctx.config.options?.mirror
        ? [
            "Before each mirror pass, rclone lists both sides and records every destination-only file and folder as to_be_deleted; deleteLimit bounds file deletions, with folder removals recorded separately.",
          ]
        : []),
    ].join("\n"),
  };
  if (ctx.stage === "final")
    yield {
      title: "Settled confirmation",
      format: "text",
      body: new ReportText(() =>
        reportJson(
          ctx.config.mappings.map(
            (mapping) =>
              (ctx.reportEvidence
                ? ctx.reportEvidence.settled(mapping.id)
                : settleState(ctx, mapping)) ?? {
                mappingId: mapping.id,
                revision: ctx.revision,
                outcome: "pending",
                maxPasses: ctx.config.options?.settleMaxPasses ?? 3,
                consistencyIntervalMs: ctx.config.options?.consistencyIntervalMs ?? 30_000,
                passes: 0,
                observations: [],
              },
          ),
          false,
        ),
      ),
    };
  const coverage = (ctx.resume.rows ?? []).flatMap((item) =>
    item.jobType === "file_migration" && item.phase === "verify" && item.fileScope?.verification
      ? [{ mappingId: item.mappingId, ...item.fileScope.verification }]
      : [],
  );
  yield {
    title: "Verification scope",
    format: "text",
    body: new ReportText(() =>
      reportJson(
        {
          scope: "full",
          mappings: ctx.reportEvidence?.coverage ?? coverage,
        },
        false,
      ),
    ),
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
  const pair = fileProviderPair(ctx.config);
  yield {
    title: "Provider pair",
    format: "text",
    body: JSON.stringify({
      sourceProvider: pair.source.id,
      destinationProvider: pair.destination.id,
    }),
  };
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
  yield {
    title: "Verification mode",
    format: "text",
    body: JSON.stringify({ verificationMode: ctx.config.options?.verificationMode ?? "listing" }),
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
  if (timing === "after_verification" || goLiveDrives.length)
    yield {
      title: "Go-live",
      format: "text",
      body: JSON.stringify({
        accessMayExist: goLiveDrives.length > 0,
        transfersFenced: goLiveDrives.length > 0,
        checksPassed:
          goLiveDrives.length > 0 &&
          goLiveDrives.every((drive) => drive.goLive?.check?.status === "passed"),
        checksSettled:
          goLiveDrives.length > 0 &&
          goLiveDrives.every((drive) =>
            goLiveCheckSettled(
              drive,
              ctx.resume.goLiveAuthorityDigest,
              ctx.resume.goLiveAcknowledgments ?? [],
            ),
          ),
        preGrantChecks: (ctx.resume.createdDrives ?? [])
          .filter((drive) => drive.preGrantCheck)
          .map((drive) => ({
            mappingId: drive.mappingId,
            driveId: drive.driveId,
            ...drive.preGrantCheck,
          })),
        acknowledgments: ctx.resume.goLiveAcknowledgments ?? [],
        ...(!goLiveDrives.length
          ? { status: "Go-live has not started. Migmate has granted no member access." }
          : {}),
        resolution:
          "Before go-live, failed or unavailable destination checks require repair and reverification; they cannot be acknowledged. After access starts, retry or explicitly acknowledge reviewed failed checks, then retry close; do not run another copy or mirror pass. Acknowledgment preserves failures, and unavailable checks remain unverified.",
        drives: goLiveDrives.map((drive) => ({
          mappingId: drive.mappingId,
          driveId: drive.driveId,
          ...drive.goLive,
          ...([drive.goLive?.check, drive.goLive?.destinationCheck].some(
            (check) => check?.check === "go_live_check_unavailable",
          )
            ? { proof: "unverified" }
            : {}),
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
      "Manifest-created Shared Drives receive only the listed member grants; existing destinations remain administered outside Migmate.",
      ctx.config.options?.mirror
        ? `Mirror removes listed destination-only content in job-created drives, capped at ${ctx.config.options.deleteLimit} cumulative file deletions across final settling attempts; a larger scope requires a new plan.`
        : "Destination-only content and source-deleted prior copies are retained, never deleted.",
      "rclone copies mappings concurrently within the approved limit in one managed worker, preserves supported created and modified times and file types, and creates empty source directories, which keep modification times only.",
      "Copy passes can replace same-path content; private markers, reserved ids, move-by-id and compare-then-write protection are not used for file migrations.",
      "Verification is a timestamped point-in-time statement, not a source freeze or future-drift guarantee. Settled confirmation is recorded separately.",
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
    const sourcePlanning = ctx.reportEvidence
      ? ctx.reportEvidence.sourcePlanning(mapping.id)
      : planned?.jobType === "file_migration"
        ? planned.fileScope
        : undefined;
    yield {
      title: `Mapping ${mapping.id}`,
      format: "text",
      body: new ReportText(() =>
        reportJson(
          {
            sourceDriveId: mapping.sourceDriveId,
            sourceItemId: mapping.sourceItemId,
            destDriveId: mapping.destDriveId,
            destFolderId: mapping.destFolderId,
            revision: ctx.revision,
            ...(sourcePlanning?.sourceObservation
              ? { sourceObservation: sourcePlanning.sourceObservation }
              : {}),
            ...(sourcePlanning?.sourceDisclosures
              ? { sourceDisclosures: sourcePlanning.sourceDisclosures }
              : {}),
            passes: (ctx.resume.mappingPasses ?? []).filter(
              (pass) => pass.mappingId === mapping.id,
            ),
          },
          false,
        ),
      ),
    };
  }
}

export const fileMigrationDriver: JobTypeDriver<FileMigrationConfig> = {
  preflight,
  collect,
  execute,
  verify: verifyListing,
  reportSections,
};

export function createFileMigrationDriver(): JobTypeDriver<FileMigrationConfig> {
  return fileMigrationDriver;
}
