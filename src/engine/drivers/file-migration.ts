import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CODE_BY_NAME } from "../codes.ts";
import { canonicalJson } from "../store/digest.ts";
import { validateMappingTrees } from "../manifest.ts";
import {
  containerKey,
  containerRootId,
  createdContainers,
  createdDriveFor,
  provisionedDestination,
  sharingMappings,
} from "./created-containers.ts";
import {
  fileProviderPair,
  sameProviderPair,
  serverSideCopy,
  type FileProviderId,
  type FileProviderCapabilities,
} from "../providers/adapters/capabilities.ts";
import { UploadLedgerError, type UploadAttempt } from "../store/uploads.ts";
import {
  collectDestinationConstraints,
  type DestinationConstraint,
} from "../providers/destination-constraints.ts";
import type {
  CheckResult,
  CreatedDrive,
  GoLiveAcknowledgment,
  GoLiveCheck,
  MappingPass,
  UploadQuotaStop,
} from "../types.ts";
import { checkedBeforeGrant, goLiveCheckSettled, unsettledGoLiveCheck } from "../go-live.ts";
import { HttpProviderFault, retryableStatus } from "../providers/http.ts";
import { DiskListing, indexListing, disposeListing } from "../providers/listing.ts";
import { ProviderFault } from "../providers/fault.ts";
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
import { isCreationRejected } from "../providers/port.ts";
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
  /** ADR-0020 D4: the pass covers only the files directly inside the source root. */
  filesOnly?: true;
  createDrive?: {
    name: string;
    members: DriveMember[];
    siteId?: string;
    /** ADR-0020 D5: the mapping's folder inside a container it may share; absent is the root. */
    folderPath?: string;
    /** Once access management starts, removing members never restores inheritance. */
    manageAccess?: true;
  };
}

export interface FileMigrationConfig {
  /** One fixed provider pair for every mapping in the job. */
  sourceProvider?: FileProviderId;
  destinationProvider?: FileProviderId;
  mappings: FileMappingConfig[];
  impersonate?: boolean;
  subject?: string;
  /**
   * ADR-0019: the acting-account pool passes write as, one account per pass. The job's
   * own identity (subject or admin) still creates containers, grants and verifies.
   */
  actingAccounts?: string[];
  /** Google → Google only: the read-only source account's delegation. */
  sourceImpersonate?: boolean;
  sourceSubject?: string;
  options?: {
    verificationMode?: "hash";
    /** ADR-0018 D10: Google → Google inside one Workspace copies server side. */
    serverSideCopy?: boolean;
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

/** Inherited site access is deliberately unmanaged and never claimed as fenced or checked. */
export function managesCreatedAccess(
  config: FileMigrationConfig,
  mapping: FileMappingConfig,
): boolean {
  return Boolean(
    mapping.createDrive &&
    (!fileProviderPair(config).destination.inheritsSiteAccess ||
      mapping.createDrive.manageAccess ||
      mapping.createDrive.members.length),
  );
}

export const COPY_DEFAULTS = { mappingsInFlight: 2, transfersPerMapping: 4 };

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

type CreatingMapping = FileMappingConfig & {
  createDrive: NonNullable<FileMappingConfig["createDrive"]>;
};

function provisionedMapping(ctx: FileContext, mapping: FileMappingConfig): FileMappingConfig {
  return provisionedDestination(ctx.resume.createdDrives, mapping);
}

/** Later mappings sharing a container find the record this run has just committed. */
function remember(ctx: FileContext, drive: CreatedDrive): void {
  ctx.resume.createdDrives = [
    ...(ctx.resume.createdDrives ?? []).filter((d) => d.mappingId !== drive.mappingId),
    drive,
  ];
}

function provisionUnit(ctx: FileContext, owner: string, key: string): CommitUnit {
  return {
    rev: ctx.revision,
    phase: "execute",
    unitKey: JSON.stringify(["provision", owner, key]),
    checkpoint: owner,
    rows: [],
    findings: [],
  };
}

/** ADR-0020 D5: each container is created and proven once, then each mapping gets its folder. */
async function* provision(ctx: FileContext): AsyncIterable<CommitUnit> {
  // Rows loaded before containers were shared may name one creation without being
  // valid sharers; joining them would let two mappings write, or mirror, one tree.
  for (const group of createdContainers(ctx.resume.createdDrives, ctx.config.mappings)) {
    if (group.mappings.length < 2) continue;
    const members = new Set(
      group.mappings.map((m) =>
        canonicalJson(
          m
            .createDrive!.members.map((member) => ({
              ...member,
              email: member.email.toLowerCase(),
            }))
            .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)),
        ),
      ),
    );
    if (members.size > 1 || group.mappings.some((m) => !m.createDrive!.folderPath && !m.filesOnly))
      throw Object.assign(
        new Error("Mappings naming one created container cannot share it: reload the manifest."),
        {
          code: "drive_creation_ambiguous",
          detail: {
            reason: "container_not_shareable",
            mappingIds: group.mappings.map((m) => m.id),
          },
        },
      );
  }
  const validated = new Set<string>();
  const provisioned = new Set<string>();
  for (const planned of ctx.config.mappings) {
    if (!planned.createDrive) continue;
    const mapping = planned as CreatingMapping;
    const key = containerKey(mapping.createDrive);
    if (!validated.has(key)) {
      validated.add(key);
      await ctx.provider.validateDestinationCreation?.(mapping.createDrive);
    }
    let drive = createdDriveFor(ctx.resume.createdDrives, mapping);
    if (!drive || !provisioned.has(drive.mappingId)) {
      drive = yield* provisionContainer(ctx, mapping, drive);
      provisioned.add(drive.mappingId);
      if (memberGrantTiming(ctx.config.options) === "before_copy")
        yield* grantMembers(ctx, [mapping]);
    }
    yield* provisionFolder(ctx, mapping, drive);
  }
}

async function* provisionContainer(
  ctx: FileContext,
  mapping: CreatingMapping,
  found: CreatedDrive | undefined,
): AsyncGenerator<CommitUnit, CreatedDrive> {
  let drive = found;
  const recovering = drive !== undefined;
  // Units stay keyed by the creating mapping, as they were before containers were shared.
  const owner = drive?.mappingId ?? mapping.id;
  const unit = (key: string): CommitUnit => provisionUnit(ctx, owner, key);
  if (!drive) {
    drive = {
      mappingId: mapping.id,
      requestId: digest([basename(ctx.jobDirectory), mapping.id]),
      name: mapping.createDrive.name,
      driveId: null,
      creatorEmail: await ctx.provider.destinationCreator(),
      ...(mapping.createDrive.siteId ? { siteId: mapping.createDrive.siteId } : {}),
      managedAccess: managesCreatedAccess(ctx.config, mapping),
      intentAt: ctx.now().toISOString(),
    };
    yield { ...unit("intent"), createdDrive: drive };
  }
  if (!drive.driveId) {
    const idempotent = fileProviderPair(ctx.config).destination.idempotentCreation;
    const recover = async () => {
      const matches = await ctx.provider.findDestinationContainers({
        name: drive!.name,
        ...(drive!.siteId ? { siteId: drive!.siteId } : {}),
      });
      if (matches.length > 1)
        throw Object.assign(new Error("Several destination containers match the planned name."), {
          code: "drive_creation_ambiguous",
          detail: { mappingId: mapping.id, name: drive!.name, candidates: matches },
        });
      const match = matches[0];
      if (
        match &&
        (idempotent
          ? !(
              drive!.intentAt &&
              match.createdTime &&
              Date.parse(match.createdTime) >= Date.parse(drive!.intentAt)
            )
          : !drive!.creationAttemptedAt || match.creationRequestId !== drive!.requestId)
      )
        throw Object.assign(
          new Error("The matching container has no job-specific creation proof."),
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
          provenance: idempotent
            ? { kind: "name_recovery", createdTime: match.createdTime! }
            : { kind: "request_marker", requestId: drive!.requestId },
        };
      return matches[0] ?? null;
    };
    let created = recovering ? await recover() : null;
    if (!created) {
      if (!idempotent) {
        if (drive.creationAttemptedAt)
          throw Object.assign(
            new Error(
              "A prior container creation attempt is not visible; refusing to create a duplicate.",
            ),
            {
              code: "drive_creation_ambiguous",
              detail: { mappingId: mapping.id, reason: "creation_outcome_unknown" },
            },
          );
        drive = { ...drive, creationAttemptedAt: ctx.now().toISOString() };
        const attempt = drive.rejectedCreationAttempts?.length ?? 0;
        // Commit keys are idempotent, so each attempt after a rejection needs its own.
        yield {
          ...unit(attempt ? `creation-attempt:${attempt}` : "creation-attempt"),
          createdDrive: drive,
        };
      }
      let rejection: unknown = null;
      try {
        created = await ctx.provider.createDestinationContainer({
          name: drive.name,
          requestId: drive.requestId,
          ...(drive.siteId ? { siteId: drive.siteId } : {}),
        });
        if (created) drive = { ...drive, provenance: { kind: "create_response" } };
        else if (!idempotent) rejection = "conflict";
      } catch (error) {
        if (!idempotent && isCreationRejected(error)) rejection = error;
        else if (
          !(error instanceof TypeError) &&
          !(error instanceof HttpProviderFault && retryableStatus(error.status))
        )
          throw error;
      }
      if (rejection) {
        // The provider created nothing, so a later run may create once the cause is gone.
        const { creationAttemptedAt, ...cleared } = drive;
        drive = {
          ...cleared,
          rejectedCreationAttempts: [
            ...(drive.rejectedCreationAttempts ?? []),
            creationAttemptedAt!,
          ],
        };
        yield {
          ...unit(`creation-rejected:${drive.rejectedCreationAttempts!.length}`),
          createdDrive: drive,
        };
        if (rejection !== "conflict") throw rejection;
        // A conflict names a container without this job's proof: recovery refuses it.
        await recover();
        throw Object.assign(
          new Error("The provider reported a name conflict that is not yet visible; retry."),
          { code: "provider_request_failed", transient: true },
        );
      }
      if (!created) created = await recover();
      if (!created) {
        if (!idempotent)
          throw Object.assign(
            new Error(
              "The container creation response was lost and no candidate is visible; retry recovery, not creation.",
            ),
            {
              code: "drive_creation_ambiguous",
              detail: { mappingId: mapping.id, reason: "creation_outcome_unknown" },
            },
          );
        created = await ctx.provider.createDestinationContainer({
          name: drive.name,
          requestId: drive.requestId,
          ...(drive.siteId ? { siteId: drive.siteId } : {}),
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
    drive = {
      ...drive,
      driveId: created.id,
      ...(created.rootFolderId ? { rootFolderId: created.rootFolderId } : {}),
    };
    // The engine commits this yield before requesting the first permission.
    yield { ...unit("created"), createdDrive: drive };
  }
  if (managesCreatedAccess(ctx.config, mapping) && !drive.managedAccess) {
    drive = { ...drive, managedAccess: true };
    yield { ...unit("managed-access"), createdDrive: drive };
  }
  if (managesCreatedAccess(ctx.config, mapping) && !drive.creatorEmail && !drive.initialMembers) {
    await ctx.provider.prepareDestinationMembers(drive.driveId!);
    const initialMembers = await ctx.provider.listDriveMembers(drive.driveId!);
    // An observed ACL is not identity proof. Without a known creator, never
    // bless arbitrary inherited/implicit grants as the pre-copy baseline.
    if (initialMembers.length > 0)
      throw new ProviderFault(
        "preflight_failed",
        "Initial destination access cannot be attributed to the migration identity. See CREDENTIALS.md.",
        {
          check: "destination_initial_access_unproven",
          mappingId: mapping.id,
          actual: initialMembers,
        },
      );
    drive = { ...drive, initialMembers };
    yield { ...unit("initial-members"), createdDrive: drive };
  }
  remember(ctx, drive);
  return drive;
}

/**
 * Create the mapping's folder chain inside its container. Each folder is committed before
 * the next is looked up, so an uncommitted same-named folder is one whose commit was lost:
 * it is adopted only while empty, since members of a live container may have made it.
 */
async function* provisionFolder(
  ctx: FileContext,
  mapping: CreatingMapping,
  container: CreatedDrive,
): AsyncGenerator<CommitUnit, void> {
  const path = mapping.createDrive.folderPath;
  if (!path) return;
  let drive = container;
  // Siblings a case-insensitive destination cannot hold apart are one folder.
  const sibling = fileProviderPair(ctx.config).destination.destinationSiblingKey ?? ((n) => n);
  let parent = containerRootId(drive)!;
  const parts = path.split("/");
  for (const [index, name] of parts.entries()) {
    const prefix = parts.slice(0, index + 1).join("/");
    ctx.signal?.throwIfAborted();
    // Listing each level, recorded ones too, is what lets a fresh Dropbox or SharePoint
    // adapter address the next: they know only folder IDs they have seen listed.
    const children = await ctx.provider.listDestinationChildren(parent, ctx.signal);
    const known = drive.folders?.[prefix];
    if (known) {
      if (!children.some((child) => child.id === known && child.kind === "folder"))
        throw Object.assign(
          new Error("A mapping folder this job created is gone from its container."),
          {
            code: "drive_creation_ambiguous",
            detail: { mappingId: mapping.id, reason: "mapping_folder_missing", folderPath: prefix },
          },
        );
      parent = known;
      continue;
    }
    const matches = children.filter((child) => sibling(child.name) === sibling(name));
    if (
      matches.length > 1 ||
      matches.some((child) => child.kind !== "folder") ||
      (matches[0] && (await ctx.provider.listDestinationChildren(matches[0].id, ctx.signal)).length)
    )
      throw Object.assign(
        new Error("The mapping folder's name is already taken inside its created container."),
        {
          code: "drive_creation_ambiguous",
          detail: {
            mappingId: mapping.id,
            reason: "mapping_folder_taken",
            folderPath: prefix,
            candidates: matches.length,
          },
        },
      );
    const at = ctx.now().toISOString();
    const folder =
      matches[0] ??
      (await ctx.provider.createDestinationFolder({
        parentFolderId: parent,
        name,
        createdAt: at,
        modifiedAt: at,
      }));
    drive = { ...drive, folders: { ...drive.folders, [prefix]: folder.id } };
    remember(ctx, drive);
    yield { ...provisionUnit(ctx, drive.mappingId, `folder:${prefix}`), createdDrive: drive };
    parent = folder.id;
  }
}

/** Grants belong to a container: each is granted once, whichever mappings share it. */
async function* grantMembers(
  ctx: FileContext,
  mappings = ctx.config.mappings,
): AsyncIterable<CommitUnit> {
  const granted = new Set<string>();
  for (const mapping of mappings) {
    if (!mapping.createDrive || !managesCreatedAccess(ctx.config, mapping)) continue;
    const drive = createdDriveFor(ctx.resume.createdDrives, mapping);
    if (!drive?.driveId) throw new Error("Member grants require a durable created drive");
    if (granted.has(drive.mappingId)) continue;
    granted.add(drive.mappingId);
    const unit = (key: string): CommitUnit => provisionUnit(ctx, drive.mappingId, key);
    if (mapping.createDrive.members.length)
      await ctx.provider.prepareDestinationMembers(drive.driveId);
    for (const member of mapping.createDrive.members) {
      if (
        ctx.resume.memberGrants?.some(
          (grant) =>
            grant.driveId === drive.driveId &&
            grant.member.email === member.email &&
            grant.member.type === member.type &&
            grant.member.role === member.role,
        )
      )
        continue;
      const members = await ctx.provider.listDriveMembers(drive.driveId);
      if (
        !members.some(
          (m) =>
            m.email.toLowerCase() === member.email.toLowerCase() &&
            m.type === member.type &&
            m.role === member.role,
        )
      )
        await ctx.provider.addDriveMember(drive.driveId, member);
      yield {
        ...unit(`member:${digest(member)}`),
        memberGrant: {
          mappingId: drive.mappingId,
          driveId: drive.driveId,
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

/**
 * The container root as a pass destination. Go-live proof covers the whole container,
 * every sharing mapping's folder included; for a mapping at the root it is the mapping's.
 */
async function containerPass(ctx: FileContext, mapping: FileMappingConfig, drive: CreatedDrive) {
  // A files-only scope would stop the listing at the root's own files.
  const { filesOnly: _, ...whole } = mapping;
  return ctx.provider.resolveFilePass({
    ...whole,
    destDriveId: drive.driveId!,
    destFolderId: containerRootId(drive)!,
  });
}

/** One digest of the container's listing; md5 undefined lists it where sha256 is missing. */
async function containerDigest(
  ctx: FileContext,
  mapping: FileMappingConfig,
  drive: CreatedDrive,
  hashType: "sha256" | "quickxor" | "dropbox",
  md5?: boolean,
): Promise<{ digest: string; md5: boolean }> {
  const pass = await containerPass(ctx, mapping, drive);
  const resources: Disposable[] = [];
  try {
    const files = indexListing(
      await ctx.provider.listFileHashes({
        socketPath: pass.socketPath,
        root: pass.destination,
        hashType,
        download: false,
        ...abortable(ctx),
      }),
    );
    resources.push(files);
    let needsMd5 = md5 ?? false;
    if (md5 === undefined && hashType === "sha256")
      for (const entry of files)
        if (entry.hash === null) {
          needsMd5 = true;
          break;
        }
    const md5Listing = indexListing(
      needsMd5
        ? await ctx.provider.listFileHashes({
            socketPath: pass.socketPath,
            root: pass.destination,
            hashType: "md5",
            download: false,
            ...abortable(ctx),
          })
        : [],
    );
    resources.push(md5Listing);
    const folders = indexListing(
      await ctx.provider.listFolders({
        socketPath: pass.socketPath,
        root: pass.destination,
        ...abortable(ctx),
      }),
      (path) => path,
    );
    resources.push(folders);
    return { digest: destinationDigest(files, md5Listing, folders), md5: needsMd5 };
  } finally {
    for (const resource of resources) resource[Symbol.dispose]();
  }
}

async function destinationCheck(
  ctx: FileContext,
  mapping: FileMappingConfig,
  drive: CreatedDrive,
): Promise<GoLiveCheck> {
  const baseline = drive.verifiedDestination;
  const { digest: observed } = await containerDigest(
    ctx,
    mapping,
    drive,
    baseline?.hashType ?? "sha256",
    baseline?.md5 ?? false,
  );
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

/** The members a created container should have now, its creator included. */
function expectedMembers(
  ctx: FileContext,
  mapping: FileMappingConfig,
  drive: CreatedDrive,
  granted: boolean,
): DriveMembership[] {
  const expected: DriveMembership[] = granted
    ? [
        ...(mapping.createDrive!.members.length
          ? mapping.createDrive!.members
          : (drive.initialMembers ?? [])),
      ]
    : [...(drive.initialMembers ?? [])];
  if (
    drive.creatorEmail &&
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
  // ADR-0019 D4: uploader membership is expected only until close removes it.
  for (const uploader of heldUploaders(ctx, drive))
    if (
      !expected.some(
        (member) => member.type === "user" && member.email.toLowerCase() === uploader.email,
      )
    )
      expected.push(uploader);
  return expected;
}

/** Shared containers name every mapping in them; a container of one keeps its old evidence. */
function sharedBy(mappings: FileMappingConfig[]): Record<string, unknown> {
  return mappings.length > 1 ? { mappingIds: mappings.map((mapping) => mapping.id) } : {};
}

/** Close checks the whole unfenced batch before authorizing any new access. */
export async function* goLive(
  ctx: FileContext,
  verificationAt: string,
  recovery: { authorityDigest: string; acknowledgments: GoLiveAcknowledgment[] },
): AsyncIterable<CommitUnit> {
  // One fence, one pre-grant check and one go-live check per container.
  const affected = createdContainers(ctx.resume.createdDrives, ctx.config.mappings)
    .filter((group) => group.mappings.some((m) => managesCreatedAccess(ctx.config, m)))
    .map((group) => {
      if (!group.drive?.driveId) throw new Error("Go-live requires a durable created drive");
      return { mapping: group.mappings[0]!, drive: group.drive, mappings: group.mappings };
    });
  const unit = (drive: CreatedDrive, key: string): CommitUnit => ({
    rev: ctx.revision,
    phase: "execute",
    unitKey: key,
    checkpoint: drive.mappingId,
    rows: [],
    findings: [],
    createdDrive: drive,
  });
  const failures: Record<string, unknown>[] = [];
  for (const { mapping, drive, mappings } of affected) {
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
      drive,
      JSON.stringify(["pre-grant-check", drive.driveId, digest(drive.preGrantCheck)]),
    );
    if (check.status === "failed")
      failures.push({
        mappingId: drive.mappingId,
        ...sharedBy(mappings),
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
  for (const { drive } of affected) {
    if (drive.goLive) continue;
    drive.goLive = { startedAt: ctx.now().toISOString(), revision: ctx.revision, verificationAt };
    yield unit(drive, JSON.stringify(["go-live-fence", drive.driveId]));
  }
  // ADR-0019 D4: uploader membership goes before the membership check, once fenced.
  yield* removeUploaders(ctx);
  // Settled checks never substitute for missing or ambiguous grant checkpoints.
  yield* grantMembers({
    ...ctx,
    now: () => new Date(Math.max(ctx.now().getTime(), Date.parse(verificationAt) + 1)),
  });
  for (const { mapping, drive, mappings } of affected) {
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
      const expected = expectedMembers(ctx, mapping, drive, true);
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
      drive,
      JSON.stringify([
        unsettled === "check" ? "go-live-check" : "go-live-destination-check",
        drive.driveId,
        digest(check),
      ]),
    );
    if (check.status === "failed")
      failures.push({
        mappingId: drive.mappingId,
        ...sharedBy(mappings),
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

/** What the transfer backend lists as a directory: folders and OneNote notebooks. */
function transferDirectory(entry: SourceEntry): boolean {
  return entry.kind === "folder" || (entry.kind === "package" && entry.packageSections !== null);
}

/**
 * Provider-native inventory finds exceptional content omitted by transfer listings.
 * A files-only root's folders are outside its mapping, so they raise nothing.
 */
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
  // Iteration sees newly appended folders without retaining the frontier in RAM.
  // Keeping visited IDs on disk also prevents duplicate mounts or cycles.
  using folders = new DiskListing<{ id: string; path: string }>((folder) => folder.id);
  folders.add({ id: root.id, path: "" });
  for (const parent of folders) {
    ctx.signal?.throwIfAborted();
    using children = indexListing(
      await ctx.provider.listSourceChildren({
        driveId: mapping.sourceDriveId,
        itemId: parent.id,
        ...abortable(ctx),
      }),
      (child) => child.id,
    );
    using names = new DiskListing<{ name: string; first: string; second?: string }>(
      (entry) => entry.name,
    );
    for (const child of children.uniqueValues()) {
      ctx.signal?.throwIfAborted();
      if (mapping.filesOnly && transferDirectory(child)) continue;
      const previous = names.get(child.name);
      if (!previous) names.add({ name: child.name, first: child.id });
      else if (previous.first !== child.id && previous.second === undefined) {
        names.delete(child.name);
        names.add({ ...previous, second: child.id });
      }
    }
    for (const child of children.uniqueValues()) {
      ctx.signal?.throwIfAborted();
      if (mapping.filesOnly && transferDirectory(child)) continue;
      const path = parent.path ? `${parent.path}/${child.name}` : child.name;
      if (child.kind === "folder" && !folders.has(child.id)) folders.add({ id: child.id, path });
      const collision = names.get(child.name);
      // Every affected item identifies itself and one distinct conflicting item,
      // never an unbounded array of all IDs sharing the same effective name.
      const sourceIds =
        collision?.second === undefined
          ? undefined
          : [collision.first, child.id === collision.first ? collision.second : child.id];
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
  prior?: Set<string>,
): AsyncGenerator<
  CommitUnit,
  { authorized: number; counted: number; paths: Set<string> | undefined }
> {
  if (!ctx.config.options?.mirror) return { authorized: 0, counted: 0, paths: undefined };
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
    // Paths an earlier attempt of this pass was authorized to delete, and these, count once.
    const paths = new Set(prior);
    for (const entry of deleted) paths.add(entry.path);
    if (reserved + paths.size > ctx.config.options.deleteLimit!)
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
    return { authorized: deleted.size, counted: paths.size, paths };
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
    sameProviderPair(fileProviderPair(ctx.config)),
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
      // The plan binds the narrower scope, so changing it is a new plan.
      ...(mapping.filesOnly ? { filesOnly: true } : {}),
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
    // Encoding disclosures are observations, not a frozen per-file approval scope.
    if (fileProviderPair(ctx.config).destination.destinationName)
      yield* publishDestinationConstraints(ctx, mapping, "plan", true);
  }
}

/** ADR-0019 D1: one pass's account and copy concurrency, fixed when it is admitted. */
interface PassSlot {
  /** Null is the job's own identity: a job without a pool, or a provider without one. */
  account: string | null;
  transfers: number;
  /** The account's daily-limit stop, once it has one in this run (D5). */
  exhausted(): UploadQuotaStop | undefined;
}

/** What a mapping moved to another account keeps from its stopped attempt (D5). */
interface Carry {
  /** Destination-only paths the stopped attempt was authorized to delete. */
  deletionPaths?: Set<string>;
  /** The settle reservation before the stopped attempt, so it is not counted twice. */
  reservedBefore?: number;
}

interface Admission {
  mapping: FileMappingConfig;
  carry?: Carry;
}

interface Running {
  mapping: FileMappingConfig;
  account: string | null;
  abort: AbortController;
  carry: Carry;
  last?: MappingPass;
}

/** A mapping no approved account can write: its pass fails without starting a transfer. */
function poolRefusal(ctx: FileContext, mapping: FileMappingConfig, error: string): CommitUnit {
  const previous = (ctx.resume.mappingPasses ?? [])
    .filter((pass) => pass.revision === ctx.revision && pass.mappingId === mapping.id)
    .at(-1);
  const passNumber =
    previous?.status === "pending" ? previous.passNumber : (previous?.passNumber ?? 0) + 1;
  const at = ctx.now().toISOString();
  const pass: MappingPass = {
    ...pendingPass(
      ctx.revision,
      mapping.id,
      passNumber,
      ctx.config.options?.mirror ? "mirror" : "copy",
    ),
    status: "failed",
    startedAt: at,
    endedAt: at,
    error,
  };
  const unit: CommitUnit = {
    rev: ctx.revision,
    phase: "execute",
    unitKey: JSON.stringify(["mapping", mapping.id, passNumber, "unassigned"]),
    checkpoint: mapping.id,
    rows: [],
    findings: [],
    mappingPass: pass,
  };
  observe(ctx, unit);
  return unit;
}

function poolError(message: string, detail: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code: "approval_required", detail });
}

/** Keep this run's view of passes and settle state current, so a moved mapping resumes. */
function observe(ctx: FileContext, unit: CommitUnit): void {
  const pass = unit.mappingPass;
  if (pass) {
    const passes = (ctx.resume.mappingPasses ??= []);
    const index = passes.findIndex(
      (item) =>
        item.revision === pass.revision &&
        item.mappingId === pass.mappingId &&
        item.passNumber === pass.passNumber,
    );
    if (index >= 0) passes[index] = pass;
    else passes.push(pass);
  }
  if (unit.watermark) ctx.resume.watermarks[unit.watermark.unitKey] = unit.watermark.value;
}

/** D4: a member of the created container already, by the manifest or as its creator. */
function holdsMembership(ctx: FileContext, drive: CreatedDrive, account: string): boolean {
  if (drive.creatorEmail.toLowerCase() === account) return true;
  return ctx.config.mappings.some(
    (mapping) =>
      mapping.createDrive &&
      createdDriveFor(ctx.resume.createdDrives, mapping) === drive &&
      mapping.createDrive.members.some(
        (member) => member.type === "user" && member.email.toLowerCase() === account,
      ),
  );
}

/** D4: uploader membership for one pool account on every unfenced container the job made. */
async function* grantUploaders(ctx: FileContext, account: string): AsyncIterable<CommitUnit> {
  const role = fileProviderPair(ctx.config).destination.uploaderRole!;
  for (const drive of ctx.resume.createdDrives ?? []) {
    if (!drive.driveId || drive.goLive) continue;
    if (drive.uploaders?.some((uploader) => uploader.account === account && !uploader.removedAt))
      continue;
    if (holdsMembership(ctx, drive, account)) continue;
    if (!ctx.provider.addUploaderMember)
      throw new ProviderFault(
        "unsupported_route",
        "The destination provider cannot grant uploader membership.",
      );
    await ctx.provider.addUploaderMember(drive.driveId, account, ctx.signal);
    drive.uploaders = [
      ...(drive.uploaders ?? []).filter((uploader) => uploader.account !== account),
      { account, role, grantedAt: ctx.now().toISOString() },
    ];
    yield {
      ...provisionUnit(ctx, drive.mappingId, `uploader:${account}`),
      createdDrive: drive,
    };
  }
}

/**
 * D4: remove every uploader membership before the membership check, so it compares only
 * approved members. Runs at close, after transfers are fenced; a recovery resumes it.
 */
export async function* removeUploaders(ctx: FileContext): AsyncIterable<CommitUnit> {
  for (const drive of ctx.resume.createdDrives ?? []) {
    if (!drive.driveId || !drive.uploaders?.some((uploader) => !uploader.removedAt)) continue;
    for (const uploader of drive.uploaders) {
      if (uploader.removedAt) continue;
      if (!ctx.provider.removeUploaderMember)
        throw new ProviderFault(
          "unsupported_route",
          "The destination provider cannot remove uploader membership.",
        );
      await ctx.provider.removeUploaderMember(drive.driveId, uploader.account, ctx.signal);
      uploader.removedAt = ctx.now().toISOString();
      yield {
        rev: ctx.revision,
        phase: "execute",
        unitKey: JSON.stringify(["uploader-removal", drive.driveId, uploader.account]),
        checkpoint: drive.mappingId,
        rows: [],
        findings: [],
        createdDrive: drive,
      };
    }
  }
}

/** Uploader memberships still held, as the membership check must expect them. */
function heldUploaders(ctx: FileContext, drive: CreatedDrive): DriveMembership[] {
  return (drive.uploaders ?? [])
    .filter((uploader) => !uploader.removedAt)
    .map((uploader) => ({ email: uploader.account, type: "user", role: uploader.role }));
}

async function* execute(ctx: FileContext): AsyncIterable<CommitUnit> {
  yield* provision(ctx);
  const destination = fileProviderPair(ctx.config).destination;
  // A team-wide stop (Dropbox's monthly upload calls) halts every pass; a Google
  // daily-limit stop belongs to one account and moves its work instead (D5, D6).
  const teamStop = new AbortController();
  ctx = {
    ...ctx,
    signal: ctx.signal ? AbortSignal.any([ctx.signal, teamStop.signal]) : teamStop.signal,
  };
  const queue: Admission[] = ctx.config.mappings.map((mapping) => ({ mapping }));
  const active = new Map<AsyncGenerator<CommitUnit | null>, Running>();
  const exhausted = new Map<string | null, UploadQuotaStop>();
  const prepared = new Set<string>();
  const writable = new Map<string, boolean>();
  // Assignment is durable: a mapping keeps the account of its last pass while it can.
  const assigned = new Map<string, string | null>();
  let perAccount = false;
  const uses = new Map<string | null, number>();
  for (const pass of ctx.resume.mappingPasses ?? [])
    if (pass.revision === ctx.revision) assigned.set(pass.mappingId, pass.account ?? null);
  function* load(): Iterable<[string | null, number]> {
    const counts = new Map<string | null, number>();
    for (const running of active.values())
      counts.set(running.account, (counts.get(running.account) ?? 0) + 1);
    yield* counts;
  }
  async function* assign(
    mapping: FileMappingConfig,
    eligible: (string | null)[],
  ): AsyncGenerator<CommitUnit, string | null | undefined> {
    const counts = new Map(load());
    const sticky = assigned.get(mapping.id);
    // Prefer the mapping's last account, then the least busy, then the least used.
    const candidates = [...eligible].sort(
      (a, b) =>
        Number(b === sticky) - Number(a === sticky) ||
        (counts.get(a) ?? 0) - (counts.get(b) ?? 0) ||
        (uses.get(a) ?? 0) - (uses.get(b) ?? 0) ||
        eligible.indexOf(a) - eligible.indexOf(b),
    );
    for (const account of candidates) {
      if (account === null) return null;
      if (!prepared.has(account)) {
        yield* grantUploaders(ctx, account);
        prepared.add(account);
      }
      // Existing containers need the operator's pre-grant, proven as the account (D4).
      if (!mapping.createDrive) {
        const key = JSON.stringify([account, mapping.destDriveId]);
        if (!writable.has(key)) {
          const proof = ctx.provider.proveAccountWrite
            ? await ctx.provider.proveAccountWrite({
                account,
                destDriveId: mapping.destDriveId!,
                destFolderId: mapping.destFolderId!,
                ...abortable(ctx),
              })
            : { writable: false };
          writable.set(key, proof.writable);
        }
        if (!writable.get(key)) continue;
      }
      return account;
    }
    return undefined;
  }
  try {
    for (;;) {
      const live = ctx.live?.() ?? {
        mappingsInFlight: ctx.config.options?.mappingsInFlight ?? COPY_DEFAULTS.mappingsInFlight,
        transfersPerMapping:
          ctx.config.options?.transfersPerMapping ?? COPY_DEFAULTS.transfersPerMapping,
        accounts: null,
      };
      // Without a pool every pass writes as the job's own identity, as before pools.
      const pooled = Boolean(live.accounts && destination.uploaderRole);
      const pool: (string | null)[] = pooled ? live.accounts! : [null];
      // Without a pool the one identity's stop halts the run, as it did before pools.
      perAccount = pooled && destination.quotaPerAccount === true;
      while (!ctx.signal?.aborted && queue.length && active.size < live.mappingsInFlight) {
        const eligible = pool.filter((account) => !exhausted.has(account));
        if (!eligible.length) {
          if (!pool.length && !active.size && !exhausted.size)
            throw poolError(
              "No approved acting account remains in the pool. Approve the added accounts or restore an approved one.",
              { mappingIds: queue.map((item) => item.mapping.id) },
            );
          break;
        }
        const next = queue.shift()!;
        const mapping = provisionedMapping(ctx, next.mapping);
        const account = yield* assign(mapping, eligible);
        if (account === undefined) {
          yield poolRefusal(
            ctx,
            mapping,
            "No approved acting account can write to this destination; pre-grant it, then run execute again.",
          );
          continue;
        }
        assigned.set(mapping.id, account);
        uses.set(account, (uses.get(account) ?? 0) + 1);
        const abort = new AbortController();
        const carry = next.carry ?? {};
        const slot: PassSlot = {
          account,
          transfers: live.transfersPerMapping,
          exhausted: () => exhausted.get(account),
        };
        const passCtx: FileContext = {
          ...ctx,
          signal: AbortSignal.any([ctx.signal!, abort.signal]),
          ...(account !== null ? { actingGoogleAccount: account } : {}),
        };
        active.set(copyMapping(passCtx, mapping, slot, carry, next.carry !== undefined), {
          mapping,
          account,
          abort,
          carry,
        });
      }
      if (!active.size) break;
      let progressed = false;
      for (const [iterator, running] of active) {
        const next = await iterator.next();
        if (next.done) {
          active.delete(iterator);
          progressed = true;
          const last = running.last;
          // D5: a stopped account's mapping moves on only once its writer is proven
          // stopped; ordinary throttling and other failures never move work.
          if (
            perAccount &&
            last?.uploadQuota &&
            !ctx.signal?.aborted &&
            (last.status === "failed" || last.stopConfirmed === true)
          )
            queue.unshift({ mapping: running.mapping, carry: running.carry });
          continue;
        }
        // A suppressed stats observation still yields its scheduler turn.
        if (next.value === null) continue;
        observe(ctx, next.value);
        const pass = next.value.mappingPass;
        if (pass) running.last = pass;
        if (pass?.uploadQuota && pass.status !== "running") {
          if (!perAccount) {
            if (!teamStop.signal.aborted) teamStop.abort();
          } else if (!exhausted.has(running.account)) {
            // The account gets no more work in this run; its other passes stop now.
            exhausted.set(running.account, pass.uploadQuota);
            for (const other of active.values())
              if (other !== running && other.account === running.account) other.abort.abort();
          }
        }
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
      [...active.keys()].map((iterator) => iterator.return(undefined)),
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

/**
 * Name rules need the native walk, because rclone's flattened listing hides them,
 * and that walk then also applies the destination's path rules. Path-only limits
 * (Shared Drive depth) are checked from rclone listings before copy and at
 * verification, so map-only routes into Google take no native source walk.
 */
function walksNativeConstraints(destination: FileProviderCapabilities): boolean {
  return Boolean(
    destination.destinationNameFindings ||
    destination.destinationSiblingKey ||
    destination.destinationName,
  );
}

async function destinationConstraints(
  ctx: FileContext,
  mapping: FileMappingConfig,
  planning = false,
): Promise<Iterable<DestinationConstraint>> {
  const { source, destination } = fileProviderPair(ctx.config);
  if (!walksNativeConstraints(destination)) return [];
  const pendingCreation = Boolean(mapping.createDrive && !mapping.destDriveId);
  const root = pendingCreation
    ? null
    : await ctx.provider.resolveDestinationFolder(destinationMapping(mapping));
  return collectDestinationConstraints({
    provider: ctx.provider,
    source,
    destination,
    checkPaths: !planning || !pendingCreation,
    sourceDriveId: mapping.sourceDriveId,
    sourceItemId: mapping.sourceItemId,
    ...(mapping.filesOnly ? { filesOnly: true } : {}),
    root: {
      ...(root?.webUrl ? { webUrl: root.webUrl } : {}),
      ...(mapping.createDrive
        ? {
            folderDepth: mapping.createDrive.folderPath
              ? mapping.createDrive.folderPath.split("/").length
              : 0,
          }
        : mapping.destFolderPath !== undefined
          ? { folderDepth: mapping.destFolderPath ? mapping.destFolderPath.split("/").length : 0 }
          : {}),
    },
    ...abortable(ctx),
  });
}

function constraintUnit(
  ctx: FileContext,
  mapping: FileMappingConfig,
  phase: Phase,
  conflict: DestinationConstraint,
): CommitUnit {
  const view = listedItem(
    mapping.sourceDriveId,
    conflict.sourceId,
    conflict.path,
    conflict.kind,
    null,
  );
  const evidence = row(ctx, phase, mapping, view, conflict.code);
  evidence.id = JSON.stringify([mapping.id, conflict.sourceId, phase, conflict.code]);
  evidence.destinationDriveId = mapping.destDriveId ?? null;
  evidence.destinationConstraint = {
    blocking: conflict.blocking,
    originalPath: conflict.path,
    ...(typeof conflict.detail.encodedPath === "string"
      ? { encodedPath: conflict.detail.encodedPath }
      : {}),
    ...(typeof conflict.detail.originalName === "string"
      ? { originalName: conflict.detail.originalName }
      : {}),
    ...(typeof conflict.detail.encodedName === "string"
      ? { encodedName: conflict.detail.encodedName }
      : {}),
  };
  evidence.nextStep = conflict.blocking
    ? "Fix the source name or path, then re-check; this mapping cannot proceed."
    : `Destination name encoding: ${JSON.stringify(conflict.detail.originalPath)} → ${JSON.stringify(conflict.detail.encodedPath)}. The source name is unchanged.`;
  return commit(
    ctx,
    phase,
    evidence,
    [
      finding(ctx, phase, conflict.code, JSON.stringify([mapping.id, conflict.sourceId]), {
        mappingId: mapping.id,
        path: conflict.path,
        sourceItemId: conflict.sourceId,
        ...conflict.detail,
      }),
    ],
    "destination-constraint",
    0,
  );
}

async function* publishDestinationConstraints(
  ctx: FileContext,
  mapping: FileMappingConfig,
  phase: Phase,
  planning = false,
): AsyncGenerator<CommitUnit, boolean> {
  const constraints = await destinationConstraints(ctx, mapping, planning);
  let blocked = false;
  try {
    for (const constraint of constraints) {
      blocked ||= constraint.blocking;
      yield constraintUnit(ctx, mapping, phase, constraint);
    }
    return blocked;
  } finally {
    disposeListing(constraints);
  }
}

async function* checkDestinationConstraints(
  ctx: FileContext,
  mapping: FileMappingConfig,
  passNumber: number,
): AsyncGenerator<CommitUnit, boolean> {
  if (!(yield* publishDestinationConstraints(ctx, mapping, "execute"))) return true;
  yield {
    rev: ctx.revision,
    phase: "execute",
    unitKey: JSON.stringify(["destination-constraints", mapping.id, passNumber]),
    checkpoint: mapping.id,
    rows: [],
    findings: [],
    mappingPass: {
      ...pendingPass(
        ctx.revision,
        mapping.id,
        passNumber,
        ctx.config.options?.mirror ? "mirror" : "copy",
      ),
      status: "failed",
      endedAt: ctx.now().toISOString(),
      error: "Destination name/path conflicts require source repair before copying or settling.",
    },
  };
  return false;
}

async function* copyMapping(
  ctx: FileContext,
  mapping: FileMappingConfig,
  slot?: PassSlot,
  carry: Carry = {},
  moved = false,
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
  // A mapping moved off a stopped account (ADR-0019 D5) continues the same attempt.
  if (state?.copyPending) {
    if (!moved) {
      if (state.passes >= state.maxPasses) {
        state.outcome = "exhausted";
        yield settleUnit(ctx, state);
        throw cutoverIncomplete();
      }
      state.passes++;
    }
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
      // Native identities are checked before each copy and after every consistency wait.
      if (!(yield* checkDestinationConstraints(ctx, mapping, passNumber))) return;
      // Deletion limits survive a move: the stopped attempt's authorized paths still count.
      const reserved = state ? (carry.reservedBefore ?? state.deletionsReserved) : 0;
      const deletions = yield* mirrorDeletions(
        ctx,
        mapping,
        passNumber,
        reserved,
        carry.deletionPaths,
      );
      if (deletions.paths) carry.deletionPaths = deletions.paths;
      carry.reservedBefore = reserved;
      const authorized = deletions.authorized;
      if (state) {
        state.copyPending = true;
        state.deletionsReserved = reserved + deletions.counted;
        yield settleUnit(ctx, state);
      }
      let completed = false;
      for await (const unit of copyPass(ctx, mapping, passNumber, authorized, slot)) {
        completed = unit?.mappingPass?.status === "completed";
        if (completed && state && unit) {
          state.copyPending = false;
          unit.watermark = settleUnit(ctx, state).watermark;
        }
        yield unit;
      }
      if (!completed || !state) return;
      // The completed attempt consumed its authorization; catch-up passes reserve anew.
      delete carry.deletionPaths;
      delete carry.reservedBefore;
    }
    if (!state) return;
    if (ctx.waitForConsistency)
      await ctx.waitForConsistency(state.consistencyIntervalMs, ctx.signal);
    else await delay(state.consistencyIntervalMs, undefined, { signal: ctx.signal });
    // Preserve the completed copy's statistics; a newly blocked catch-up is a separate attempt.
    if (!(yield* checkDestinationConstraints(ctx, mapping, state.copyPassNumber + 1))) return;
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
  slot?: PassSlot,
): AsyncGenerator<CommitUnit | null> {
  let pass = pendingPass(
    ctx.revision,
    mapping.id,
    passNumber,
    ctx.config.options?.mirror ? "mirror" : "copy",
  );
  if (slot?.account) pass.account = slot.account;
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
  /** True when the transfer is proven ended; a pass that never started is. */
  async function stopAndReconcile(): Promise<boolean> {
    const stopping = reference;
    if (!stopping) return true;
    let ended = false;
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
        ended = terminal;
      } catch {
        // A stop acknowledgment is not proof that the transfer function ended.
      }
      try {
        finalStats = await ctx.provider.copyPassStats(stopping);
      } catch {
        // Worker teardown may have already discarded its counter.
      }
      if (finalStats) {
        // rclone's error text can name files: it is never pass evidence.
        const { lastError: _lastError, ...observed } = finalStats;
        const transferring = observed.transferring.slice(0, 5);
        const transferringTotal = observed.transferringTotal ?? observed.transferring.length;
        pass = {
          ...pass,
          lastStats: {
            ...observed,
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
    if (!upload) {
      try {
        ended = (await ctx.provider.copyPassStatus(stopping)).state !== "running";
      } catch {
        // A stop acknowledgment is not proof that the transfer function ended.
      }
    }
    return ended;
  }
  try {
    ctx.signal?.throwIfAborted();
    if (ctx.config.options?.mirror) {
      // Provenance is the container's; the pass itself deletes only inside this mapping's folder.
      const drive = createdDriveFor(ctx.resume.createdDrives, mapping);
      const proven =
        drive?.provenance?.kind === "create_response" ||
        (drive?.provenance?.kind === "request_marker" &&
          drive.creationAttemptedAt &&
          drive.provenance.requestId === drive.requestId) ||
        (fileProviderPair(ctx.config).destination.idempotentCreation &&
          drive?.provenance?.kind === "name_recovery" &&
          drive.intentAt &&
          Date.parse(drive.provenance.createdTime) >= Date.parse(drive.intentAt));
      if (!mapping.createDrive || drive?.driveId !== mapping.destDriveId || !proven)
        throw new Error(
          "Mirror requires proven job-created drive provenance; this mapping cannot delete.",
        );
    }
    // D1: the pass writes through a destination remote isolated to its own account.
    const resolved = await ctx.provider.resolveFilePass({
      ...destinationMapping(mapping),
      ...(slot?.account ? { account: slot.account } : {}),
    });
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
    if (destinationAdapter.destinationPathFindings && !walksNativeConstraints(destinationAdapter)) {
      const constraintRoot = { folderDepth: await destinationFolderDepth(ctx, mapping) };
      const folders = await ctx.provider.listFolders({
        socketPath: resolved.socketPath,
        root: resolved.source,
        ...abortable(ctx),
      });
      let blocked = false;
      function* paths(): Iterable<string> {
        yield ".";
        yield* folders;
      }
      try {
        for (const path of paths()) {
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
      } finally {
        disposeListing(folders);
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
      transfers:
        slot?.transfers ??
        ctx.config.options?.transfersPerMapping ??
        COPY_DEFAULTS.transfersPerMapping,
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
      let status = await ctx.provider.copyPassStatus(reference);
      const { lastError, ...stats } = await ctx.provider.copyPassStats(reference);
      lastObservation = { bytes: stats.bytes, at: ctx.now() };
      // rclone retries quota errors it does not classify (Dropbox's monthly limit);
      // a match in its running error stops the pass instead of retrying for hours.
      if (
        status.state === "running" &&
        lastError &&
        fileProviderPair(ctx.config).destination.quotaWhileRunning &&
        fileProviderPair(ctx.config).destination.quotaStop?.(ctx, lastError)
      ) {
        try {
          await stopAndReconcile();
        } catch (error) {
          // Keep the quota evidence: the failure path classifies this message.
          throw Object.assign(new Error(lastError), { cause: error });
        }
        status = { state: "failed", error: lastError };
      }
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
    const ended = await stopAndReconcile();
    if (error instanceof UploadLedgerError) throw error;
    const message = interrupted ? null : error instanceof Error ? error.message : String(error);
    // D5: a pass stopped because its account hit the daily limit carries that stop, and
    // whether its transfer is proven ended, so its mapping can move to another account.
    const accountStop = interrupted ? slot?.exhausted() : undefined;
    const uploadQuota =
      accountStop ?? fileProviderPair(ctx.config).destination.quotaStop?.(ctx, message);
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
      ...(accountStop ? { stopConfirmed: ended } : {}),
      endedAt: ctx.now().toISOString(),
    };
    yield unit();
    if (interrupted) return;
  } finally {
    if (reference && pass.status === "running") await stopAndReconcile();
  }
}

/** Containers whose membership this verification run has observed, so each is checked once. */
const membershipChecked = new WeakMap<FileContext, Set<string>>();

/** A created drive whose actual members differ from those due at this point. */
async function membershipUnit(
  ctx: FileContext,
  mapping: FileMappingConfig,
  root: SourceView,
  done: number,
): Promise<CommitUnit | undefined> {
  if (!mapping.createDrive || !managesCreatedAccess(ctx.config, mapping)) return undefined;
  const drive = createdDriveFor(ctx.resume.createdDrives, mapping);
  if (!drive?.driveId) throw new Error("Verification requires the durable created drive");
  const checked = membershipChecked.get(ctx) ?? new Set<string>();
  membershipChecked.set(ctx, checked);
  if (checked.has(drive.mappingId)) return undefined;
  checked.add(drive.mappingId);
  const expected = expectedMembers(
    ctx,
    mapping,
    drive,
    memberGrantTiming(ctx.config.options) === "before_copy" || Boolean(drive.goLive),
  );
  const actual = await ctx.provider.listDriveMembers(drive.driveId);
  if (
    JSON.stringify(membershipIdentities(expected)) === JSON.stringify(membershipIdentities(actual))
  )
    return undefined;
  const evidence = row(ctx, "verify", mapping, root, "drive_membership_mismatch");
  evidence.destinationDriveId = drive.driveId;
  evidence.destinationFileId = drive.rootFolderId ?? drive.driveId;
  return commit(
    ctx,
    "verify",
    evidence,
    [
      finding(ctx, "verify", "drive_membership_mismatch", mapping.id, {
        mappingId: mapping.id,
        ...sharedBy(sharingMappings(ctx.resume.createdDrives, ctx.config.mappings, mapping)),
        driveId: drive.driveId,
        expected,
        actual,
      }),
    ],
    "drive-membership",
    done,
  );
}

/**
 * A1/A4 before A6: the destination listing a deferred go-live is later checked against.
 * A container shared by several mappings, or holding one in a folder, is listed whole
 * once its last mapping is verified, exactly as go-live will list it.
 */
async function goLiveBaseline(
  ctx: FileContext,
  mapping: FileMappingConfig,
  observed: { hashType: "sha256" | "quickxor" | "dropbox"; md5: boolean; digest: string },
): Promise<CommitUnit | undefined> {
  if (
    !managesCreatedAccess(ctx.config, mapping) ||
    memberGrantTiming(ctx.config.options) !== "after_verification"
  )
    return undefined;
  const drive = createdDriveFor(ctx.resume.createdDrives, mapping)!;
  // A new verification must never erase the original go-live content fence.
  if (drive.goLive) return undefined;
  const sharing = sharingMappings(ctx.resume.createdDrives, ctx.config.mappings, mapping);
  // A files-only mapping's own listing omits the container's folders, so it never stands in.
  const wholeContainer =
    sharing.length === 1 && !mapping.createDrive?.folderPath && !mapping.filesOnly;
  if (!wholeContainer && sharing.at(-1)?.id !== mapping.id) return undefined;
  drive.verifiedDestination = {
    revision: ctx.revision,
    ...(wholeContainer
      ? observed
      : {
          hashType: observed.hashType,
          ...(await containerDigest(ctx, mapping, drive, observed.hashType)),
        }),
  };
  return {
    rev: ctx.revision,
    phase: "verify",
    unitKey: JSON.stringify(["verified-destination", drive.mappingId]),
    checkpoint: drive.mappingId,
    rows: [],
    findings: [],
    createdDrive: drive,
  };
}

/**
 * Compare whole mappings by listing. Cross-provider hash verification additionally
 * downloads source content using the destination's hash type, without a Graph inventory.
 * Same-provider routes compare the hashes both sides store (ADR-0018 D6); only source
 * files that store none, such as exported documents, are downloaded to hash.
 */
async function* verifyListing(ctx: FileContext): AsyncIterable<CommitUnit> {
  let done = 0;
  const { source: sourceAdapter, destination: destinationAdapter } = fileProviderPair(ctx.config);
  for (const planned of ctx.config.mappings) {
    const mapping = provisionedMapping(ctx, planned);
    if (yield* publishDestinationConstraints(ctx, mapping, "verify")) continue;
    if (ctx.stage === "final" && settleState(ctx, mapping)?.outcome !== "settled")
      throw cutoverIncomplete();
    const root = await sourceRoot(ctx, mapping);
    const membership = await membershipUnit(ctx, mapping, root, done + 1);
    if (membership) {
      done++;
      yield membership;
    }
    const planRow = plannedScope(ctx, mapping);
    if (
      planRow?.jobType !== "file_migration" ||
      !planRow.fileScope?.mapOnly ||
      Boolean(planRow.fileScope.filesOnly) !== Boolean(mapping.filesOnly)
    )
      throw new FilePlanRevisionRequiredError();
    const pass = await ctx.provider.resolveFilePass(destinationMapping(mapping));
    const sameProvider = sameProviderPair({
      source: sourceAdapter,
      destination: destinationAdapter,
    });
    const hash = sameProvider || ctx.config.options?.verificationMode === "hash";
    const download = hash && !sameProvider;
    const primaryHash = destinationAdapter.hashType;
    const resources: Disposable[] = [];
    try {
      const list = async (
        side: FilePassRoot,
        hashType: "quickxor" | "sha256" | "md5" | "dropbox",
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
      const sources = await list(pass.source, primaryHash, download);
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
        // Drive stores no SHA-256 for some older files; both sides still store MD5.
        if (sameProvider && !needsMd5)
          for (const entry of sources) {
            if (entry.hash === null && destinations.has(entry.path)) {
              needsMd5 = true;
              break;
            }
          }
      }
      const usesMd5 = (sourceHash: string | null, copied: FileHashEntry | undefined) =>
        needsMd5 && (copied?.hash === null || (sameProvider && sourceHash === null));
      const destinationMd5 = needsMd5
        ? await list(pass.destination, "md5")
        : new DiskListing<FileHashEntry>();
      resources.push(destinationMd5);
      const sourceMd5 = new DiskListing<FileHashEntry>();
      resources.push(sourceMd5);
      // Source hashes read by path, a page at a time: MD5 fallbacks, and on same-provider
      // routes the few source files that store no hash of their own.
      const readSourceHashes = async (
        target: DiskListing<FileHashEntry>,
        hashType: "quickxor" | "sha256" | "md5" | "dropbox",
        downloaded: boolean,
        selected: Iterable<string>,
      ) => {
        let paths: string[] = [];
        const flush = async () => {
          const page = await list(pass.source, hashType, downloaded, paths);
          for (const value of page) target.add(value);
          page[Symbol.dispose]();
          resources.pop();
          paths = [];
        };
        for (const path of selected) {
          paths.push(path);
          if (paths.length === 1000) await flush();
        }
        if (paths.length) await flush();
      };
      if (hash && needsMd5) {
        await readSourceHashes(
          sourceMd5,
          "md5",
          download,
          (function* () {
            for (const entry of destinations) if (entry.hash === null) yield entry.path;
            if (sameProvider)
              for (const entry of sources) {
                const copied = destinations.get(entry.path);
                if (entry.hash === null && copied && copied.hash !== null) yield entry.path;
              }
          })(),
        );
      }
      const sourceDownloaded = new DiskListing<FileHashEntry>();
      resources.push(sourceDownloaded);
      if (sameProvider)
        await readSourceHashes(
          sourceDownloaded,
          primaryHash,
          true,
          (function* () {
            for (const entry of sources) {
              const copied = destinations.get(entry.path);
              if (!copied) continue;
              const stored = usesMd5(entry.hash, copied)
                ? (sourceMd5.get(entry.path)?.hash ?? null)
                : entry.hash;
              if (stored === null) yield entry.path;
            }
          })(),
        );
      const coverage = new DiskListing<string>((path) => path);
      resources.push(coverage);
      for (const entry of sources) if (!coverage.has(entry.path)) coverage.add(entry.path);
      for (const path of sourceFolders) if (!coverage.has(path)) coverage.add(path);
      const excludedPaths = new DiskListing<string>((path) => path);
      resources.push(excludedPaths);
      const sourceContentByPath = new DiskListing<SourceView>();
      resources.push(sourceContentByPath);
      if (sourceAdapter.sourceEntryFindings) {
        for await (const item of sourceContentFindings(
          ctx,
          mapping,
          root,
          sourceAdapter.sourceEntryFindings,
        )) {
          if (!coverage.has(item.source.path)) coverage.add(item.source.path);
          sourceContentByPath.add(item.source);
          if (
            item.codes.some((code) => CODE_BY_NAME[code]?.kind !== "policy_outcome") &&
            !excludedPaths.has(item.source.path)
          )
            excludedPaths.add(item.source.path);
          const evidence = row(ctx, "verify", mapping, item.source, item.codes[0]!);
          evidence.id = JSON.stringify([mapping.id, item.source.id, "verify", "source-content"]);
          evidence.destinationDriveId = mapping.destDriveId ?? null;
          evidence.destinationFileId = destinations.get(item.source.path)?.id ?? null;
          yield commit(
            ctx,
            "verify",
            evidence,
            item.codes.map((code) =>
              finding(ctx, "verify", code, item.source.id, {
                path: item.source.path,
                ...item.evidence,
              }),
            ),
            "source-content",
            ++done,
          );
        }
      }
      if (
        destinationAdapter.destinationPathFindings &&
        !walksNativeConstraints(destinationAdapter)
      ) {
        const constraintRoot = { folderDepth: await destinationFolderDepth(ctx, mapping) };
        for (const kind of ["file", "folder"] as const) {
          for (const entry of kind === "file" ? sources : sourceFolders) {
            const path = typeof entry === "string" ? entry : entry.path;
            if (excludedPaths.has(path)) continue;
            const conflicts = destinationAdapter.destinationPathFindings(
              path,
              kind,
              constraintRoot,
            );
            if (!conflicts.length) continue;
            excludedPaths.add(path);
            const view = listedItem(
              mapping.sourceDriveId,
              `path:${path}`,
              path,
              kind,
              typeof entry === "string" ? null : entry.size,
            );
            const evidence = row(ctx, "verify", mapping, view, conflicts[0]!.code);
            evidence.destinationDriveId = mapping.destDriveId ?? null;
            yield commit(
              ctx,
              "verify",
              evidence,
              conflicts.map((conflict) =>
                finding(ctx, "verify", conflict.code, view.id, {
                  path,
                  itemType: kind,
                  destinationRootDepth: constraintRoot.folderDepth,
                  message: conflict.message,
                }),
              ),
              "destination-path",
              ++done,
            );
          }
        }
      }
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
        if (excludedPaths.has(source.path)) continue;
        const copied = destinations.get(source.path);
        // rclone's OneDrive IDs are `driveId#itemId`; durable rows keep the item ID.
        const listedId = source.id?.startsWith(`${mapping.sourceDriveId}#`)
          ? source.id.slice(mapping.sourceDriveId.length + 1)
          : source.id;
        const view = listedItem(
          mapping.sourceDriveId,
          listedId ?? sourceContentByPath.get(source.path)?.id ?? `path:${source.path}`,
          source.path,
          "file",
          source.size,
        );
        let hashType: "quickxor" | "sha256" | "md5" | "dropbox" = usesMd5(source.hash, copied)
          ? "md5"
          : primaryHash;
        let sourceHash =
          hashType === "md5" ? (sourceMd5.get(source.path)?.hash ?? null) : source.hash;
        let destinationHash = copied
          ? hashType === "md5"
            ? (destinationMd5.get(copied.path)?.hash ?? null)
            : (copied.hash ?? destinationMd5.get(copied.path)?.hash ?? null)
          : null;
        // A source that stores no hash was downloaded and hashed as the destination stores it.
        if (sourceHash === null && sourceDownloaded.has(source.path)) {
          hashType = primaryHash;
          sourceHash = sourceDownloaded.get(source.path)!.hash;
          destinationHash = copied?.hash ?? null;
        }
        const codes: string[] = [];
        let servedSize = view.size;
        // Matching downloaded bytes already prove an unknown export's stored size.
        if (servedSize === null && hash && sourceHash && sourceHash === destinationHash && copied)
          servedSize = copied.size >= 0 ? copied.size : null;
        if (servedSize === null) {
          try {
            let size = 0;
            for await (const chunk of ctx.provider.openSourceContent({
              driveId: mapping.sourceDriveId,
              itemId: view.id,
            })) {
              ctx.signal?.throwIfAborted();
              size += chunk.byteLength;
            }
            servedSize = size;
          } catch (error) {
            if (!terminalUnavailable(error)) throw error;
            codes.push("source_read_failed");
          }
        }
        if (
          download &&
          source.size >= 0 &&
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
        if (view.size === null) evidence.size = servedSize;
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
        if (destinationFolders.has(path) || excludedPaths.has(path)) continue;
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
        if (
          sources.has(retained.path) ||
          sourceFolders.has(retained.path) ||
          sourceContentByPath.has(retained.path)
        )
          continue;
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
        if (sourceFolders.has(path) || sources.has(path) || sourceContentByPath.has(path)) continue;
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
      const baseline = await goLiveBaseline(ctx, mapping, {
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
  // Same-provider pairs share one adapter, so each side is named by position, not identity.
  for (const [adapter, destination] of [
    [pair.source, false],
    [pair.destination, true],
  ] as const)
    if (adapter.preflight && !(yield* adapter.preflight(ctx, destination))) return;
  const provider = ctx.provider;
  // ADR-0019 D4: every pool account must already write to each existing destination.
  const proven = new Set<string>();
  for (const account of ctx.config.actingAccounts ?? [])
    for (const mapping of ctx.config.mappings) {
      if (mapping.createDrive || !mapping.destDriveId || !mapping.destFolderId) continue;
      const key = JSON.stringify([account, mapping.destDriveId]);
      if (proven.has(key)) continue;
      proven.add(key);
      ctx.signal?.throwIfAborted();
      const proof = provider.proveAccountWrite
        ? await provider.proveAccountWrite({
            account,
            destDriveId: mapping.destDriveId,
            destFolderId: mapping.destFolderId,
            ...abortable(ctx),
          })
        : { writable: false, evidence: { reason: "provider_cannot_prove" } };
      yield {
        id: `actingAccount:${account}:${mapping.destDriveId}`,
        title: "Pool account can write to the existing destination",
        status: proof.writable ? "pass" : "fail",
        ...(proof.writable ? {} : { code: "preflight_failed" }),
        evidence: {
          account,
          destDriveId: mapping.destDriveId,
          ...proof.evidence,
          ...(proof.writable
            ? {}
            : {
                fix: "Grant this account write access to the existing destination beforehand; Migmate grants uploader membership only on containers it creates.",
              }),
        },
      };
    }
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
  const filesOnly = ctx.config.mappings.filter((m) => m.filesOnly).map((m) => m.id);
  yield {
    title: "Approval and verification",
    format: "text",
    body: [
      "Approval binds mapping roots, drives, members and options, not a per-file inventory.",
      ...(filesOnly.length
        ? [
            `Files-only mappings (${filesOnly.join(", ")}) copy, verify and mirror only the files directly inside their roots; folders on either side are outside them and never created, compared or deleted.`,
          ]
        : []),
      ...(sameProviderPair(fileProviderPair(ctx.config))
        ? [
            "Same-provider route: files only. Identities, mailboxes and domain cutover are outside this job.",
            "Hash verification compares the hashes both sides store, folders by path, without downloading; only source files that store no hash, such as exported documents, are downloaded to hash.",
            serverSideCopy(ctx.config)
              ? "Files copy server side inside one Workspace as the destination's delegated account, which already reads the source; the read-only source account never writes. A file that changed since an earlier pass is copied again as a new file, and its earlier copy goes to the destination drive's trash with its revisions and per-file sharing."
              : "Files stream through this host from the read-only source credential to the separate destination credential.",
          ]
        : [
            "Listing verification compares paths and sizes, folders included; it compares no content.",
            ...(ctx.config.options?.verificationMode === "hash"
              ? [
                  "Hash verification is enabled: rclone downloads source content to compare the destination's stored hash type.",
                ]
              : []),
          ]),
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
    yield {
      title: "Destination containers to create",
      format: "text",
      body: JSON.stringify(drives),
    };
  if (ctx.resume.createdDrives?.length)
    yield {
      title: "Created destination containers and members",
      format: "text",
      body: JSON.stringify({
        // A container shared by several mappings names them all; its folders map each one.
        drives: ctx.resume.createdDrives.map((drive) => ({
          ...drive,
          ...sharedBy(
            ctx.config.mappings.filter(
              (mapping) => createdDriveFor(ctx.resume.createdDrives, mapping) === drive,
            ),
          ),
        })),
        grants: ctx.resume.memberGrants ?? [],
      }),
    };
  const pair = fileProviderPair(ctx.config);
  const inheritedAccess = ctx.config.mappings
    .filter((mapping) => mapping.createDrive && !managesCreatedAccess(ctx.config, mapping))
    .map((mapping) => ({
      mappingId: mapping.id,
      containerName: mapping.createDrive!.name,
      siteId: mapping.createDrive!.siteId,
      access: "inherited_site",
      visibleToSiteMembersBeforeGoLive: true,
      transfersFenced: false,
      membershipManaged: false,
      membershipProven: false,
      disclosure:
        "Inherits site access and is visible to site members before go-live. Migmate does not fence, manage or prove this library's membership.",
    }));
  if (inheritedAccess.length)
    yield {
      title: "Inherited site access",
      format: "text",
      body: JSON.stringify(inheritedAccess),
    };
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
  if (ctx.config.actingAccounts?.length) {
    // ADR-0019 D1/D4: what approving this plan authorizes, and what close takes back.
    const role = pair.destination.uploaderRole;
    yield {
      title: "Acting-account pool",
      format: "text",
      body: [
        `Passes write as one of ${ctx.config.actingAccounts.length} approved acting accounts each: ${ctx.config.actingAccounts.join(", ")}.`,
        `Uploader membership: each pool account is granted ${role} on containers this job creates, and it is removed at close before the membership check. It is not an end-user grant.`,
        "Existing destinations need each pool account's write access granted beforehand; preflight proves it.",
        pair.destination.quotaPerAccount
          ? "An account that hits Google's daily upload limit gets no more work in that execute; its unfinished mappings move to another pool account once its transfer is proven stopped. Ordinary throttling never moves work."
          : "Passes are spread across the pool; nothing moves work between accounts.",
      ].join("\n"),
    };
    const uploaders = (ctx.resume.createdDrives ?? []).flatMap((drive) =>
      (drive.uploaders ?? []).map((uploader) => ({
        driveId: drive.driveId,
        name: drive.name,
        ...uploader,
      })),
    );
    if (uploaders.length)
      yield { title: "Uploader membership", format: "text", body: JSON.stringify(uploaders) };
  }
  if (sameProviderPair(pair) && pair.source.id === "google_shared_drive")
    yield {
      title: "Read-only Google source account",
      format: "text",
      body: ctx.config.sourceImpersonate
        ? `Source account: ${ctx.config.sourceSubject} (domain-wide delegation, drive.readonly).`
        : "Source account: the separate read-only service account (drive.readonly; impersonation off).",
    };
  if (sameProviderPair(pair))
    yield {
      title: "Copy method",
      format: "text",
      body: JSON.stringify({ copyMethod: serverSideCopy(ctx.config) ? "server_side" : "streamed" }),
    };
  if (ctx.config.impersonate || ctx.config.sourceImpersonate)
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
      const driveId =
        createdDriveFor(ctx.resume.createdDrives, mapping)?.driveId ??
        provisionedMapping(ctx, mapping).destDriveId;
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
        (member) => !["reader", "read", "commenter"].includes(member.role),
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
        accessMayExist: goLiveDrives.length > 0 || inheritedAccess.length > 0,
        transfersFenced: goLiveDrives.length > 0,
        unmanagedLibraries: inheritedAccess.map((library) => library.mappingId),
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
          ? {
              status: inheritedAccess.length
                ? "No managed go-live has started. Inherited libraries remain visible through site access; membership is neither managed nor proven."
                : "Go-live has not started. Migmate has granted no member access.",
            }
          : {}),
        resolution:
          "Before go-live, failed or unavailable destination checks require repair and reverification; they cannot be acknowledged. After access starts, retry or explicitly acknowledge reviewed failed checks, then retry close; do not run another copy or mirror pass. Acknowledgment preserves failures, and unavailable checks remain unverified.",
        drives: goLiveDrives.map((drive) => ({
          mappingId: drive.mappingId,
          ...sharedBy(
            ctx.config.mappings.filter(
              (mapping) => createdDriveFor(ctx.resume.createdDrives, mapping) === drive,
            ),
          ),
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
    const folder = provisionedMapping(ctx, mapping);
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
            scope: mapping.filesOnly ? "files_only" : "recursive",
            // ADR-0020 D5: a mapping in a folder of its created container names both.
            ...(mapping.createDrive?.folderPath
              ? {
                  destDriveId: folder.destDriveId,
                  destFolderId: folder.destFolderId,
                  destinationContainer: mapping.createDrive.name,
                  destinationFolderPath: mapping.createDrive.folderPath,
                }
              : {}),
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
