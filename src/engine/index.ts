import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { Engine, EngineOptions, JobReader, JobWriter, ReclaimDecision } from "./engine.ts";
import {
  ManifestError,
  parseManifest,
  validateMappingTrees,
  type LoadedManifest,
} from "./manifest.ts";
import {
  ok,
  refuse,
  type ApprovalRecord,
  type Artifact,
  type ArtifactSet,
  type CheckResult,
  type Closure,
  type ExecuteResult,
  type FacetCount,
  type JobEvent,
  type JobRef,
  type JobSpec,
  type JobType,
  type Outcome,
  type PreflightReport,
  type RecoveryReport,
  type Refusal,
  type RefusalCode,
  type RowPhase,
  type VerificationRevision,
  type Verb,
} from "./types.ts";
import { CODE_BY_NAME, isAcceptable } from "./codes.ts";
import {
  nextState,
  reconcileOnWriterOpen,
  refusalForClosedJob,
  type Transition,
} from "./state-chart.ts";
import {
  openReadStore,
  openStore,
  SCHEMA_VERSION,
  type Store,
  type JobRecord,
  type LeaseRecord,
} from "./store/store.ts";
import { canonicalJson, digestJson } from "./store/digest.ts";
import {
  acquire,
  getHostId,
  getProcessStartTime,
  readHostId,
  release,
  reconcileWriterOpen,
  reclaimLease,
  inspectLease,
  probeWorker,
  stopOrphanWorker,
} from "./store/lease.ts";
import type { ProviderPort, TransferWorkerHandle } from "./providers/port.ts";
import { createProductionProvider } from "./providers/production.ts";
import {
  fileMigrationDriver,
  type FileMappingConfig,
  type FileMigrationConfig,
} from "./drivers/file-migration.ts";
import { teamsArchiveDriver } from "./drivers/teams-archive.ts";
import { parseArchiveConfig } from "./archive/config.ts";
import type { ArchiveConfig } from "./providers/archive.ts";
import type { CommitRow } from "./commit.ts";
import type { DriverContext, JobTypeDriver, ReportSection } from "./drivers/types.ts";

export type { Engine, JobReader, JobWriter, EngineOptions, ReclaimDecision } from "./engine.ts";
export * from "./types.ts";

const packageMetadata: unknown = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
if (
  !packageMetadata ||
  typeof packageMetadata !== "object" ||
  !("version" in packageMetadata) ||
  typeof packageMetadata.version !== "string"
)
  throw new Error("Package version is missing");
const MIGMATE_VERSION = packageMetadata.version;
const CONFIG_FILENAME = "job.toml";
const LEGACY_CONFIG_FILENAME = "job.config.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const REFUSAL_CODES: Record<string, true> = Object.fromEntries(
  [
    "configuration_invalid",
    "job_not_found",
    "local_filesystem_required",
    "retry_budget_exhausted",
    "lease_held",
    "lease_stale_worker_alive",
    "foreign_host",
    "preflight_failed",
    "approval_required",
    "approval_digest_stale",
    "plan_revision_required",
    "unsupported_route",
    "verification_unaccepted",
    "job_closed",
    "job_cancelled",
    "state_version_unsupported",
  ].map((code) => [code, true]),
);

/** Events cannot turn a refused store open into an apparently successful empty tail. */
export class EngineRefusalError extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "EngineRefusalError";
    this.refusal = refusal;
  }
}

interface EngineDeps {
  home: string;
  now: () => Date;
  adapter: "cli" | "web";
  provider?: ProviderPort;
  closed: boolean;
}
interface JobPaths {
  dir: string;
  configPath: string;
  artifactsDir: string;
}
export interface ProvidedEngineOptions extends EngineOptions {
  provider?: ProviderPort;
}
type FileReference = { resolver: "file"; path: string; mode: "0600" };
type Mapping = FileMappingConfig & { sourceSiteId?: string };
interface CommonConfig {
  route: string;
  transferBinary?: { path: string; sha256: string; provenance: string };
}
type FileConfig = CommonConfig & {
  mappings: Mapping[];
  options: NonNullable<FileMigrationConfig["options"]>;
  manifestDigest?: string;
  rclone?: { config: FileReference; sourceRemote: string; destinationRemote: string };
};
type TeamsConfig = CommonConfig &
  ArchiveConfig & {
    graph?: { tenantId: string; clientId: string };
    secrets?: {
      teams_graph_client_secret: FileReference;
      google_service_account?: FileReference;
    };
  };
export type JobConfig = FileConfig | TeamsConfig;

function configError(field: string): never {
  throw new EngineRefusalError({
    code: "configuration_invalid",
    message: "The job configuration is not supported.",
    detail: { field },
  });
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    configError(field);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) configError(field);
    result[key] = descriptor.value;
  }
  return result;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) configError(field);
}
function text(value: unknown, field: string, maximum = 2048): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    configError(field);
  return value;
}
function fileReference(value: unknown, field: string, jobDir: string): FileReference {
  const ref = object(value, field);
  keys(ref, ["resolver", "path", "mode"], field);
  const path = text(ref.path, field);
  if (
    ref.resolver !== "file" ||
    (ref.mode !== undefined && ref.mode !== "0600") ||
    !isAbsolute(path) ||
    /[$%~]/u.test(path)
  )
    configError(field);
  const destination = existsSync(path) ? realpathSync(path) : resolve(path);
  if (within(jobDir, destination)) configError(field);
  return { resolver: "file", path, mode: "0600" };
}
function parseConfig(raw: unknown, type: JobType, paths: JobPaths): JobConfig {
  const input = object(raw, "config");
  const commonKeys = ["route", "transferBinary"];
  keys(
    input,
    type === "file_migration"
      ? [...commonKeys, "mappings", "options", "rclone"]
      : [
          ...commonKeys,
          "scopes",
          "cloud",
          "retainedHistory",
          "transcripts",
          "attachmentBytes",
          "timezone",
          "window",
          "lineage",
          "destination",
          "graph",
          "secrets",
        ],
    "config",
  );
  const common: CommonConfig = {
    route:
      input.route === undefined
        ? type === "file_migration"
          ? "sharepoint_library_to_shared_drive"
          : "teams_global_archive"
        : text(input.route, "route"),
  };
  if (input.transferBinary !== undefined) {
    const b = object(input.transferBinary, "transferBinary");
    keys(b, ["path", "sha256", "provenance"], "transferBinary");
    const path = text(b.path, "transferBinary.path"),
      sha256 = text(b.sha256, "transferBinary.sha256"),
      provenance = text(b.provenance, "transferBinary.provenance");
    if (!isAbsolute(path) || !SHA256.test(sha256)) configError("transferBinary");
    let url: URL;
    try {
      url = new URL(provenance);
    } catch {
      configError("transferBinary.provenance");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search)
      configError("transferBinary.provenance");
    common.transferBinary = { path, sha256, provenance };
  }
  if (type === "file_migration") {
    if (input.mappings !== undefined && !Array.isArray(input.mappings)) configError("mappings");
    const mappings = (input.mappings ?? ([] as unknown[])) as unknown[];
    const parsedMappings = mappings
      .map((raw, index): Mapping => {
        const m = object(raw, "mappings");
        keys(
          m,
          [
            "id",
            "sourceDriveId",
            "sourceItemId",
            "destDriveId",
            "destFolderId",
            "sourceSiteId",
            "exclusions",
          ],
          "mappings",
        );
        const mapping: Mapping = {
          id: text(m.id, `mappings[${index}].id`),
          sourceDriveId: text(m.sourceDriveId, "sourceDriveId"),
          sourceItemId: text(m.sourceItemId, "sourceItemId"),
          destDriveId: text(m.destDriveId, "destDriveId"),
          destFolderId: text(m.destFolderId, "destFolderId"),
        };
        if (m.sourceSiteId !== undefined)
          mapping.sourceSiteId = text(m.sourceSiteId, "sourceSiteId");
        if (m.exclusions !== undefined) {
          if (!Array.isArray(m.exclusions)) configError("exclusions");
          mapping.exclusions = m.exclusions
            .map((raw) => {
              const e = object(raw, "exclusions");
              keys(e, ["sourceItemId", "reason"], "exclusions");
              return {
                sourceItemId: text(e.sourceItemId, "exclusions.sourceItemId"),
                reason: text(e.reason, "exclusions.reason"),
              };
            })
            .sort((a, b) => compareText(a.sourceItemId, b.sourceItemId));
          if (
            new Set(mapping.exclusions.map((e) => e.sourceItemId)).size !==
            mapping.exclusions.length
          )
            configError("exclusions");
        }
        return mapping;
      })
      .sort((a, b) => compareText(a.id, b.id));
    if (new Set(parsedMappings.map((m) => m.id)).size !== parsedMappings.length)
      configError("mappings");
    const options = input.options === undefined ? {} : object(input.options, "options");
    keys(options, ["verificationMode", "mappingsInFlight", "transfersPerMapping"], "options");
    if (
      options.verificationMode !== undefined &&
      options.verificationMode !== "hash" &&
      options.verificationMode !== "size_only"
    )
      configError("options.verificationMode");
    const config: FileConfig = {
      ...common,
      mappings: parsedMappings,
      options:
        options.verificationMode === undefined
          ? {}
          : { verificationMode: options.verificationMode },
    };
    for (const name of ["mappingsInFlight", "transfersPerMapping"] as const) {
      const value = options[name];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
        configError(`options.${name}`);
      config.options[name] = value;
    }
    if (input.rclone !== undefined) {
      const r = object(input.rclone, "rclone");
      keys(r, ["config", "sourceRemote", "destinationRemote"], "rclone");
      const sourceRemote = text(r.sourceRemote, "rclone.sourceRemote", 64),
        destinationRemote = text(r.destinationRemote, "rclone.destinationRemote", 64);
      if (
        ![sourceRemote, destinationRemote].every((s) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(s)) ||
        sourceRemote.toLowerCase() === destinationRemote.toLowerCase()
      )
        configError("rclone");
      config.rclone = {
        config: fileReference(r.config, "rclone.config", paths.dir),
        sourceRemote,
        destinationRemote,
      };
    }
    return config;
  }
  for (const raw of Array.isArray(input.scopes) ? input.scopes : []) {
    const scope = object(raw, "scopes");
    keys(
      scope,
      scope.kind === "channel"
        ? ["kind", "teamId", "channelId"]
        : scope.kind === "team"
          ? ["kind", "teamId"]
          : ["kind", "userId"],
      "scopes",
    );
  }
  if (input.window !== undefined) keys(object(input.window, "window"), ["from", "to"], "window");
  if (input.lineage !== undefined)
    keys(object(input.lineage, "lineage"), ["jobId", "reportDigest", "to"], "lineage");
  if (input.destination !== undefined)
    keys(object(input.destination, "destination"), ["destDriveId", "destFolderId"], "destination");
  let archive: ArchiveConfig;
  try {
    archive = parseArchiveConfig(input);
  } catch {
    configError("archive");
  }
  const config: TeamsConfig = { ...common, ...archive };
  if (input.graph !== undefined || input.secrets !== undefined) {
    const g = object(input.graph, "graph"),
      s = object(input.secrets, "secrets");
    keys(g, ["tenantId", "clientId"], "graph");
    keys(
      s,
      archive.destination
        ? ["teams_graph_client_secret", "google_service_account"]
        : ["teams_graph_client_secret"],
      "secrets",
    );
    const tenantId = text(g.tenantId, "graph.tenantId"),
      clientId = text(g.clientId, "graph.clientId");
    if (
      ![tenantId, clientId].every((v) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(v))
    )
      configError("graph");
    config.graph = { tenantId, clientId };
    config.secrets = {
      teams_graph_client_secret: fileReference(
        s.teams_graph_client_secret,
        "secrets.teams_graph_client_secret",
        paths.dir,
      ),
    };
    if (archive.destination)
      config.secrets.google_service_account = fileReference(
        s.google_service_account,
        "secrets.google_service_account",
        paths.dir,
      );
  }
  return config;
}
function within(root: string, path: string): boolean {
  const r = relative(resolve(root), resolve(path));
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}
function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function privateDirectory(path: string): void {
  if (!existsSync(path)) {
    privateDirectory(dirname(path));
    mkdirSync(path, { mode: 0o700 });
    syncDirectory(dirname(path));
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) configError("job_directory");
}
function atomicFile(path: string, body: string): void {
  privateDirectory(dirname(path));
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) configError("job_file");
  const temp = join(dirname(path), `.staged-${randomUUID()}`),
    fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(temp, { force: true });
  }
}
function localFilesystem(home: string): Outcome<null> {
  try {
    let existing = resolve(home);
    while (!existsSync(existing)) existing = dirname(existing);
    const real = realpathSync(existing),
      projected = join(real, relative(existing, resolve(home)));
    if (
      /(?:^|[/\\])(?:Dropbox|OneDrive(?:[^/\\]*)|Google Drive|GoogleDrive(?:[^/\\]*)|iCloud Drive|CloudStorage|Mobile Documents)(?:[/\\]|$)/iu.test(
        projected,
      ) ||
      /^[/\\]{2}/u.test(home)
    )
      return refuse(
        "local_filesystem_required",
        "Live job state requires local, non-synced storage.",
      );
    const fs = statfsSync(existing);
    if (
      [0x6969, 0x517b, 0x5346414f, 0xff534d42, 0x65735546, 0x01021997, 0x564c].includes(
        Number(fs.type),
      )
    )
      return refuse(
        "local_filesystem_required",
        "The filesystem cannot establish local WAL ownership.",
      );
    if (process.platform === "darwin") {
      const mounts = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 5000 })
        .trim()
        .split("\n");
      const candidates = mounts
        .flatMap((line) => {
          const match = / on (.+) \(([^)]+)\)$/u.exec(line);
          return match?.[1] && match[2] && within(match[1], real)
            ? [{ root: match[1], options: match[2].split(", ") }]
            : [];
        })
        .sort((a, b) => b.root.length - a.root.length);
      const mount = candidates[0];
      if (
        !mount ||
        !mount.options.includes("local") ||
        !mount.options.some((option) => ["apfs", "hfs", "ufs"].includes(option))
      )
        return refuse(
          "local_filesystem_required",
          "The filesystem is not a supported local volume.",
        );
    }
    return ok(null);
  } catch {
    return refuse(
      "local_filesystem_required",
      "Local filesystem ownership could not be established.",
    );
  }
}
function pathsFor(deps: EngineDeps, ref: JobRef): JobPaths {
  if (!ref || typeof ref.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(ref.id))
    configError("job");
  const dir = join(deps.home, "jobs", ref.id);
  return { dir, configPath: join(dir, CONFIG_FILENAME), artifactsDir: join(dir, "artifacts") };
}
/** Keys earlier builds persisted into every job folder's config; ADR-0009 retired them. */
const RETIRED_CONFIG_KEYS = ["guarantees", "qualification"];
function persisted(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !RETIRED_CONFIG_KEYS.includes(key)),
  );
}
function readConfig(paths: JobPaths, type: JobType, store?: Store): JobConfig {
  if (!existsSync(paths.configPath)) configError("config_missing");
  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(paths.configPath, "utf8"));
  } catch {
    configError("job.toml");
  }
  const config = parseConfig(persisted(parsed), type, paths);
  const loaded = store?.readMappings();
  if ("mappings" in config && loaded)
    return { ...config, mappings: loaded.mappings, manifestDigest: loaded.digest };
  return config;
}
function migrateConfig(paths: JobPaths, type: JobType): void {
  const legacy = join(paths.dir, LEGACY_CONFIG_FILENAME);
  if (!existsSync(legacy)) return;
  if (!existsSync(paths.configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(legacy, "utf8"));
    } catch {
      configError("legacy_config");
    }
    atomicFile(paths.configPath, stringifyToml(parseConfig(persisted(parsed), type, paths)));
  }
  rmSync(legacy);
  syncDirectory(paths.dir);
}
function persistConfig(paths: JobPaths, config: JobConfig, store: Store): void {
  if ("mappings" in config) {
    if (config.mappings.length)
      store.writeMappings({ mappings: config.mappings, digest: digestJson(config.mappings) });
    const { mappings: _mappings, manifestDigest: _digest, ...settings } = config;
    atomicFile(paths.configPath, stringifyToml(settings));
  } else atomicFile(paths.configPath, stringifyToml(config));
}
function expectedFailure<T>(error: unknown): Outcome<T> | null {
  if (error instanceof EngineRefusalError) return { ok: false, refusal: error.refusal };
  if (error instanceof ManifestError)
    return refuse(error.code, error.message, { detail: error.detail });
  const code = errorCode(error);
  if (code && Object.hasOwn(REFUSAL_CODES, code))
    return refuse(code as RefusalCode, "The operation could not satisfy its required gate.");
  if (code?.startsWith("credential_") || code === "recovery_required")
    return refuse("preflight_failed", "A provider prerequisite could not be established.", {
      detail: { check: code },
    });
  return null;
}
function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
function driverFor(type: JobType): JobTypeDriver<never> {
  return (
    type === "file_migration" ? fileMigrationDriver : teamsArchiveDriver
  ) as JobTypeDriver<never>;
}
function providerFor(
  deps: EngineDeps,
  paths: JobPaths,
  type: JobType,
  config: JobConfig,
  archiveVerification = false,
): ProviderPort {
  return (
    deps.provider ??
    createProductionProvider({
      jobType: type,
      config,
      jobDirectory: paths.dir,
      ...(archiveVerification && type === "teams_archive" && needsTransferWorker(config)
        ? { mode: "archive_verification" as const }
        : {}),
    })
  );
}

export function openEngine(opts: ProvidedEngineOptions): Engine {
  if (typeof opts.home !== "string" || opts.home.length === 0) configError("home");
  const deps: EngineDeps = {
    home: resolve(opts.home),
    now: opts.now ?? (() => new Date()),
    adapter: opts.adapter ?? "cli",
    ...(opts.provider ? { provider: opts.provider } : {}),
    closed: false,
  };
  return {
    initJob: (spec) => initJob(deps, spec),
    reader: (ref) => makeReader(deps, ref),
    withWriter: (ref, fn) => withWriter(deps, ref, fn),
    async withWriterResult(ref, fn) {
      const outer = await withWriter(deps, ref, fn);
      return outer.ok ? outer.value : outer;
    },
    reclaim: (ref, decision) => reclaimJob(deps, ref, decision),
    close() {
      deps.closed = true;
    },
  };
}
async function initJob(deps: EngineDeps, spec: JobSpec): Promise<Outcome<JobRef>> {
  try {
    if (deps.closed) return refuse("lease_held", "The engine is closed.");
    if (!spec || (spec.type !== "file_migration" && spec.type !== "teams_archive"))
      configError("type");
    const label = spec.label === undefined ? null : text(spec.label, "label");
    const ref = { id: randomUUID() },
      paths = pathsFor(deps, ref);
    const config =
      spec.config === undefined ? undefined : parseConfig(spec.config, spec.type, paths);
    const local = localFilesystem(deps.home);
    if (!local.ok) return local;
    privateDirectory(deps.home);
    const hostId = getHostId(deps.home);
    privateDirectory(paths.dir);
    const opened = openStore(paths.dir, { migmateVersion: MIGMATE_VERSION, now: deps.now });
    if (!opened.ok) return opened;
    const store = opened.value;
    try {
      if (config) persistConfig(paths, config, store);
      store.atomic(() => {
        store.writeJob({
          id: ref.id,
          type: spec.type,
          state: "new",
          schemaVersion: SCHEMA_VERSION,
          migmateVersion: MIGMATE_VERSION,
          hostId,
          label,
          createdAt: deps.now().toISOString(),
          planRevision: null,
          verificationRevision: null,
          lastCheckpoint: null,
          executionCompleted: false,
        });
        store.appendEvent({
          verb: "init",
          phase: "init",
          kind: "phase_completed",
          payload: { id: ref.id },
        });
      });
    } finally {
      store.close();
    }
    return ok(ref);
  } catch (error) {
    const failure = expectedFailure<JobRef>(error);
    if (failure) return failure;
    throw error;
  }
}
// Readers never migrate on their own, but every CLI verb reads status before it opens
// a writer, so a job written by an older build would be unreachable. Upgrade it forward
// once, exactly as a writer's open does, then read. Newer or unknown schemas still refuse.
function openForRead(deps: EngineDeps, ref: JobRef): Outcome<Store> {
  const paths = pathsFor(deps, ref),
    options = {
      migmateVersion: MIGMATE_VERSION,
      now: deps.now,
      hostId: readHostId(deps.home) ?? "",
    };
  const opened = openReadStore(paths.dir, options);
  if (opened.ok || opened.refusal.code !== "state_version_unsupported") return opened;
  const found = opened.refusal.detail?.schemaVersion;
  if (typeof found !== "number" || found < 1 || found >= SCHEMA_VERSION) return opened;
  const local = localFilesystem(paths.dir);
  if (!local.ok) return local;
  const upgraded = openStore(paths.dir, { ...options, existingOnly: true });
  if (!upgraded.ok) return upgraded;
  upgraded.value.close();
  return openReadStore(paths.dir, options);
}
function makeReader(deps: EngineDeps, ref: JobRef): JobReader {
  async function withStore<T>(fn: (store: Store) => T): Promise<Outcome<T>> {
    try {
      const opened = openForRead(deps, ref);
      if (!opened.ok) return opened;
      try {
        return ok(fn(opened.value));
      } finally {
        opened.value.close();
      }
    } catch (error) {
      const failure = expectedFailure<T>(error);
      if (failure) return failure;
      throw error;
    }
  }
  return {
    status: () => withStore((s) => s.status()),
    rows: (q) => withStore((s) => s.rows(q)),
    artifacts: () => withStore((s) => s.readArtifactSet()),
    async *events(q): AsyncIterable<JobEvent> {
      const opened = openForRead(deps, ref);
      if (!opened.ok) throw new EngineRefusalError(opened.refusal);
      try {
        yield* opened.value.events(q);
      } finally {
        opened.value.close();
      }
    },
  };
}
function hostRefusal<T>(
  job: JobRecord,
  hostId: string,
  lease: LeaseRecord | null,
): Outcome<T> | null {
  const recordedHostId = job.hostId ?? lease?.hostId;
  if (!recordedHostId || recordedHostId === hostId) return null;
  return refuse("foreign_host", "Live job state belongs to another host.", {
    recovery: {
      workerAlive: false,
      workerStatus: "unknown",
      recordedHostId,
      thisHostId: hostId,
      holder: lease
        ? {
            ownerUuid: lease.ownerUuid,
            pid: lease.pid,
            processStartTime: lease.processStartTime,
            heartbeatAt: lease.heartbeatAt,
            heartbeatAgeMs: 0,
            kind: lease.kind,
          }
        : null,
      workerGroup: lease?.workerGroup ?? null,
      lastCheckpoint: job.lastCheckpoint,
      reclaimable: false,
    },
  });
}
async function withWriter<T>(
  deps: EngineDeps,
  ref: JobRef,
  fn: (writer: JobWriter) => Promise<T>,
): Promise<Outcome<T>> {
  let store: Store | undefined;
  try {
    if (deps.closed) return refuse("lease_held", "The engine is closed.");
    const paths = pathsFor(deps, ref),
      local = localFilesystem(paths.dir);
    if (!local.ok) return local;
    const opened = openStore(paths.dir, {
      migmateVersion: MIGMATE_VERSION,
      now: deps.now,
      existingOnly: true,
      hostId: readHostId(deps.home) ?? "",
    });
    if (!opened.ok) return opened;
    store = opened.value;
    const job = store.readJob();
    if (!job) return refuse("job_not_found", "The job does not exist.");
    const hostId = getHostId(deps.home),
      mismatch = hostRefusal<T>(job, hostId, store.readLease());
    if (mismatch) return mismatch;
    const probe = deps.provider
      ? async (socketPath: string) => {
          try {
            return (await deps.provider!.probeTransferWorker({ socketPath })).alive;
          } catch {
            return null;
          }
        }
      : probeWorker;
    const identity = { hostId, pid: process.pid, processStartTime: getProcessStartTime() };
    const acquired = await acquire(store.db, identity, {
      kind: deps.adapter,
      now: deps.now,
      probeWorker: probe,
    });
    if (!acquired.ok) return acquired;
    let active = true;
    const session = makeWriter(deps, store, paths, () => active, acquired.value.row.ownerUuid);
    try {
      await reconcileWriterOpen(store.db, reconcileOnWriterOpen, {
        now: deps.now,
        hostId,
        ownerUuid: acquired.value.row.ownerUuid,
      });
      migrateConfig(paths, job.type);
      if (job.type === "file_migration" && existsSync(paths.configPath)) {
        const config = readConfig(paths, job.type);
        if ("mappings" in config && config.mappings.length) {
          // Store wins if a crash happened after its commit but before config replacement.
          if (!store.readMappings())
            store.writeMappings({ mappings: config.mappings, digest: digestJson(config.mappings) });
          const { mappings: _mappings, ...settings } = config;
          atomicFile(paths.configPath, stringifyToml(settings));
        }
      }
      for (const [relative, prefixes] of [
        ["assets/.staging", ["file-", "package-"]],
        ["assets/staging", ["archive-"]],
      ] as const) {
        const staging = join(paths.dir, relative);
        if (existsSync(staging))
          for (const name of readdirSync(staging))
            if (prefixes.some((prefix) => name.startsWith(prefix)))
              rmSync(join(staging, name), { recursive: true, force: true });
      }
      return ok(await fn(session.writer));
    } finally {
      active = false;
      try {
        await session.dispose();
      } finally {
        if (!store.readLease()?.socketPath) release(store.db, acquired.value);
        else clearInterval(acquired.value.timer ?? undefined);
      }
    }
  } catch (error) {
    const failure = expectedFailure<T>(error);
    if (failure) return failure;
    throw error;
  } finally {
    store?.close();
  }
}
async function reclaimJob(
  deps: EngineDeps,
  ref: JobRef,
  decision: ReclaimDecision,
): Promise<Outcome<RecoveryReport>> {
  let store: Store | undefined;
  try {
    if (decision?.confirm !== true) configError("reclaim.confirm");
    const paths = pathsFor(deps, ref),
      local = localFilesystem(paths.dir);
    if (!local.ok) return local;
    const opened = openStore(paths.dir, {
      migmateVersion: MIGMATE_VERSION,
      now: deps.now,
      existingOnly: true,
      hostId: readHostId(deps.home) ?? "",
    });
    if (!opened.ok) return opened;
    store = opened.value;
    const job = store.readJob();
    if (!job) return refuse("job_not_found", "The job does not exist.");
    const hostId = getHostId(deps.home),
      lease = store.readLease(),
      mismatch = hostRefusal<RecoveryReport>(job, hostId, lease);
    if (mismatch) return mismatch;
    if (!lease)
      return ok({
        workerAlive: false,
        workerStatus: "absent",
        recordedHostId: hostId,
        thisHostId: hostId,
        holder: null,
        workerGroup: null,
        lastCheckpoint: job.lastCheckpoint,
        reclaimable: true,
      });
    const options = {
      now: deps.now,
      ...(deps.provider
        ? {
            probeWorker: async (socketPath: string) => {
              try {
                return (await deps.provider!.probeTransferWorker({ socketPath })).alive;
              } catch {
                return null;
              }
            },
          }
        : {}),
    };
    let inspection = await inspectLease(lease, hostId, options);
    if (!inspection.decision.reclaimable && decision.stopWorker && inspection.stopEligible) {
      if (await stopOrphanWorker(lease)) inspection = await inspectLease(lease, hostId, options);
    }
    if (!inspection.decision.reclaimable)
      return refuse(
        inspection.decision.code ?? "lease_held",
        "The recorded ownership has not been safely released.",
        { recovery: inspection.report },
      );
    store.atomic(() => {
      if (!reclaimLease(store!.db, lease, deps.now))
        throw new EngineRefusalError({
          code: "lease_held",
          message: "Ownership changed during recovery.",
          recovery: inspection.report,
        });
    });
    return ok({ ...inspection.report, reclaimable: true });
  } catch (error) {
    const failure = expectedFailure<RecoveryReport>(error);
    if (failure) return failure;
    throw error;
  } finally {
    store?.close();
  }
}

interface BoundEvidence {
  applicationIdentity: string;
  binarySha256: string;
  binaryVersion: string;
  binaryPath: string;
}
function readBoundEvidence(value: unknown): BoundEvidence {
  const evidence = object(value, "plan.evidence"),
    binding = object(evidence.binding, "plan.evidence.binding");
  const fields = ["applicationIdentity", "binarySha256", "binaryVersion", "binaryPath"] as const;
  const bound = {} as BoundEvidence;
  for (const field of fields) {
    const value = binding[field];
    if (typeof value !== "string")
      throw new EngineRefusalError({
        code: "plan_revision_required",
        message: "The plan lacks complete bound execution evidence.",
      });
    bound[field] = value;
  }
  // Plans from earlier builds may carry retired members; only these are compared.
  return bound;
}
function needsTransferWorker(config: JobConfig): boolean {
  return "mappings" in config || config.destination !== undefined;
}
async function boundEvidence(provider: ProviderPort, config: JobConfig): Promise<BoundEvidence> {
  const identity = provider.applicationIdentity ? await provider.applicationIdentity() : "";
  const binary: Record<string, unknown> =
    needsTransferWorker(config) && provider.binaryEvidence ? await provider.binaryEvidence() : {};
  return {
    applicationIdentity: identity,
    binarySha256: typeof binary.sha256 === "string" ? binary.sha256 : "",
    binaryVersion: typeof binary.version === "string" ? binary.version : "",
    binaryPath: typeof binary.path === "string" ? binary.path : "",
  };
}
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "rev",
            "revision",
            "at",
            "sourceInventoryAt",
            "cursor",
            "nextLink",
            "watermark",
            "accepted",
          ].includes(key),
      )
      .map(([key, item]) => [key, ["raw", "listItemFields"].includes(key) ? item : semantic(item)]),
  );
}
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function contentDigest(rows: unknown[]): string {
  const hash = createHash("sha256");
  for (const row of rows.map((row) => canonicalJson(semantic(row))).sort())
    hash.update(row).update("\n");
  return hash.digest("hex");
}
function inputFields(
  config: JobConfig,
  evidence: BoundEvidence,
  rows: CommitRow[],
  archivePlan: unknown,
): Record<string, string> {
  const settings =
    "mappings" in config
      ? {
          mappings: config.mappings,
          options: config.options,
          ...(config.manifestDigest ? { manifestDigest: config.manifestDigest } : {}),
          route: config.route,
        }
      : {
          scopes: config.scopes,
          cloud: config.cloud,
          window: config.window,
          timezone: config.timezone,
          retainedHistory: config.retainedHistory,
          transcripts: config.transcripts,
          attachmentBytes: config.attachmentBytes,
          lineage: config.lineage,
          ...(config.destination ? { destination: config.destination } : {}),
          route: config.route,
        };
  const scopes = rows
    .filter((r) => r.jobType === "file_migration" && r.phase === "plan" && r.fileScope)
    .map((r) =>
      canonicalJson(
        r.jobType === "file_migration"
          ? { mappingId: r.mappingId, fileScope: semantic(r.fileScope) }
          : null,
      ),
    )
    .sort();
  const { binaryPath: _path, ...binding } = evidence;
  return {
    configuration: canonicalJson(settings),
    identity: canonicalJson(binding),
    scope: canonicalJson(scopes),
    archive: canonicalJson(semantic(archivePlan ?? null)),
  };
}
function findingFacets(store: Store, revision: number): FacetCount[] {
  return store.currentFindingCounts(revision, "verify");
}
function currentVerification(store: Store): (VerificationRevision & { planRev: number }) | null {
  const rev = store.readJob()?.verificationRevision;
  return rev == null ? null : store.readVerificationRevision(rev);
}
function outstanding(store: Store, revision: number, digest?: string): string[] {
  const accepted = new Set(digest ? store.readAcceptances(digest).map((a) => a.code) : []);
  return findingFacets(store, revision)
    .filter((f) => !accepted.has(f.code))
    .map((f) => f.code);
}

class RetryBudget {
  failedAttempts = 0;
  readonly failedUnits = new Set<string>();
  readonly attempts = new Map<string, number>();
  readonly throttles = new Map<string, number>();
  readonly requests = new Map<string, number>();
  readonly total: number;
  constructor(total: number) {
    this.total = total;
  }
  mappingFailure(mappingId: string): void {
    this.failedAttempts++;
    this.failedUnits.add(`mapping:${mappingId}`);
  }
  failure(
    error: unknown,
    key: string,
  ): { retry: boolean; delay: number; classified: boolean; transient: boolean } {
    const e = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
    const evidence =
      e.evidence !== null && typeof e.evidence === "object" && "status" in e.evidence
        ? e.evidence
        : undefined;
    const status =
      typeof e.status === "number"
        ? e.status
        : typeof evidence?.status === "number"
          ? evidence.status
          : 0;
    const code = errorCode(error);
    const terminal =
      [401, 403, 404, 412].includes(status) ||
      (code !== undefined &&
        (CODE_BY_NAME[code]?.retryable === false ||
          code === "plan_revision_required" ||
          code === "unsupported_route"));
    const workerReason =
      e.evidence !== null && typeof e.evidence === "object" && "reason" in e.evidence
        ? e.evidence.reason
        : undefined;
    const workerTransient =
      code === "provider_failed" &&
      typeof workerReason === "string" &&
      [
        "worker_exited",
        "worker_unreachable",
        "worker_read_failed",
        "worker_request_timeout",
        "worker_request_failed",
      ].includes(workerReason);
    const transient =
      !terminal &&
      (workerTransient ||
        e.transient === true ||
        e.retryable === true ||
        [408, 429, 500, 502, 503, 504].includes(status) ||
        [
          "ECONNRESET",
          "ECONNREFUSED",
          "ETIMEDOUT",
          "EPIPE",
          "UND_ERR_SOCKET",
          "UND_ERR_CONNECT_TIMEOUT",
          "worker_unit_failed",
        ].includes(code ?? ""));
    if (!transient)
      return {
        retry: false,
        delay: 0,
        classified: terminal || (code !== undefined && CODE_BY_NAME[code] !== undefined),
        transient: false,
      };
    this.failedAttempts++;
    const requests = (this.requests.get(key) ?? 0) + 1;
    this.requests.set(key, requests);
    const throttles = status === 429 ? (this.throttles.get(key) ?? 0) + 1 : 0;
    if (status === 429) this.throttles.set(key, throttles);
    const attempts = (this.attempts.get(key) ?? 0) + (status !== 429 || throttles <= 2 ? 1 : 0);
    this.attempts.set(key, attempts);
    if (attempts >= 5) this.failedUnits.add(key);
    const ratio = this.failedUnits.size / Math.max(1, this.total);
    const retry = attempts < 5 && requests < 200 && this.failedAttempts < 200 && ratio < 0.2;
    const retryAfter =
      typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs)
        ? Math.max(0, e.retryAfterMs)
        : undefined;
    return {
      retry,
      delay: Math.min(
        300000,
        retryAfter ?? Math.random() * Math.min(32000, 1000 * 2 ** Math.max(0, attempts - 1)),
      ),
      classified: true,
      transient: true,
    };
  }
  summary() {
    return {
      failedAttempts: this.failedAttempts,
      failedUnitRatio: this.failedUnits.size / Math.max(1, this.total),
    };
  }
}
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function makeWriter(
  deps: EngineDeps,
  store: Store,
  paths: JobPaths,
  active: () => boolean,
  ownerUuid: string,
): { writer: JobWriter; dispose: () => Promise<void> } {
  let busy = false;
  let executionInterrupt: AbortController | undefined;
  let settled = Promise.resolve();
  const providers = new Set<ProviderPort>();
  function job(): JobRecord {
    const record = store.readJob();
    if (!record) throw new Error("Missing durable job record");
    return record;
  }
  function guard(verb: Verb): void {
    if (!active() || deps.closed || store.readLease()?.ownerUuid !== ownerUuid)
      throw new EngineRefusalError({
        code: "lease_held",
        message: "The writer is outside its lease lifetime.",
      });
    const terminal = refusalForClosedJob(job().state);
    if (terminal && verb !== "report")
      throw new EngineRefusalError({
        code: terminal,
        message: "The job has reached an absorbing terminal state.",
      });
  }
  async function operation<T>(verb: Verb, fn: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    let entered = false;
    let finish: (() => void) | undefined;
    const progressStop = new AbortController();
    let progressLoop = Promise.resolve();
    let progressFailure: unknown;
    function record(outcome: Outcome<T>): Outcome<T> {
      if (!outcome.ok && entered)
        store.appendEvent({
          verb,
          phase: verb,
          kind: "refusal",
          payload: {
            code: outcome.refusal.code,
            ...(outcome.refusal.detail ? { detail: outcome.refusal.detail } : {}),
          },
        });
      return outcome;
    }
    try {
      guard(verb);
      if (busy) return refuse("lease_held", "The writer already owns an active operation.");
      busy = true;
      entered = true;
      settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      progressLoop = (async () => {
        try {
          while (!progressStop.signal.aborted) {
            await delay(1000, progressStop.signal);
            if (!progressStop.signal.aborted) {
              guard(verb);
              store.publishProgress();
            }
          }
        } catch (error) {
          progressFailure = error;
          executionInterrupt?.abort();
        }
      })();
      return record(await fn());
    } catch (error) {
      const failure = expectedFailure<T>(error);
      if (failure) return record(failure);
      throw error;
    } finally {
      if (entered) {
        progressStop.abort();
        await progressLoop;
        try {
          if (active() && store.readLease()?.ownerUuid === ownerUuid) store.finishOperation();
        } finally {
          busy = false;
          executionInterrupt = undefined;
          finish?.();
        }
        if (progressFailure) throw progressFailure;
      }
    }
  }
  function provider(config: JobConfig, archiveVerification = false): ProviderPort {
    const p = providerFor(deps, paths, job().type, config, archiveVerification);
    providers.add(p);
    return p;
  }
  function context(
    p: ProviderPort,
    config: JobConfig,
    revision: number,
    signal?: AbortSignal,
  ): DriverContext<never> {
    return {
      config: config as never,
      revision,
      jobDirectory: paths.dir,
      resume: { ...store.readResume(revision), checkpoint: job().lastCheckpoint },
      provider: p,
      now: deps.now,
      ...(signal ? { signal } : {}),
    };
  }
  function transition(t: Transition, verb: Verb, payload: Record<string, unknown> = {}): void {
    store.atomic(() => {
      const record = job(),
        target = nextState(record.state, t);
      if (!target)
        throw new EngineRefusalError({
          code:
            t === "close" || t.startsWith("verify") || t === "accept"
              ? "verification_unaccepted"
              : "approval_required",
          message: "The operation is not available in the current state.",
          detail: { state: record.state, verb },
        });
      store.writeJob({
        ...record,
        state: target,
        verificationRevision: t === "execute" ? null : record.verificationRevision,
      });
      store.appendEvent({
        verb,
        phase: verb,
        kind: "phase_completed",
        payload: { state: target, ...payload },
      });
    });
  }
  async function preflight(config: JobConfig, p: ProviderPort): Promise<Outcome<PreflightReport>> {
    const local = localFilesystem(paths.dir);
    if (!local.ok) return local;
    if (
      config.route !==
      (job().type === "file_migration"
        ? "sharepoint_library_to_shared_drive"
        : "teams_global_archive")
    )
      return refuse("unsupported_route", "The requested route is not implemented.");
    const checks: CheckResult[] = [];
    const recordCheck = (check: CheckResult) => {
      checks.push(check);
      store.atomic(() => {
        store.writeCheckResult({ ...check, verb: "doctor", at: deps.now().toISOString() });
        store.appendEvent({
          verb: "doctor",
          phase: "doctor",
          kind: "check_result",
          payload: {
            id: check.id,
            status: check.status,
            ...(check.code ? { code: check.code } : {}),
          },
        });
      });
    };
    try {
      if (p.preflight)
        for await (const c of p.preflight({ jobType: job().type, config, jobDirectory: paths.dir }))
          recordCheck(c);
      for await (const c of driverFor(job().type).preflight(
        context(p, config, job().planRevision ?? 0),
      ))
        recordCheck(c);
      if (needsTransferWorker(config)) {
        if (checks.some((check) => check.status === "fail"))
          recordCheck({
            id: "provider.transfer_worker",
            title: "Private authenticated transfer worker",
            status: "skip",
            evidence: { prerequisitesPassed: false },
          });
        else {
          const worker = await startWorker(p);
          try {
            const version = await p.transferWorkerVersion({ socketPath: worker.socketPath });
            recordCheck({
              id: "provider.transfer_worker",
              title: "Private authenticated transfer worker",
              status: version === worker.version ? "pass" : "fail",
              ...(version === worker.version ? {} : { code: "preflight_failed" }),
              evidence: {
                runDirectoryPermissions: "0700",
                socketOnly: true,
                missingAuthenticationRefused: true,
                authenticatedLiveness: true,
                version,
              },
            });
          } finally {
            await stopWorker(p, worker);
          }
        }
      }
    } catch (error) {
      const known = expectedFailure(error),
        code = known && !known.ok ? known.refusal.code : "preflight_failed";
      if (!known && !errorCode(error) && !(error instanceof TypeError)) throw error;
      recordCheck({
        id: "provider.prerequisites",
        title: "Provider prerequisites",
        status: "fail",
        code,
        evidence: { prerequisiteEstablished: false },
      });
    }
    const report = {
      passed: checks.length > 0 && checks.every((c) => c.status !== "fail"),
      checks,
    };
    store.appendEvent({
      verb: "doctor",
      phase: "doctor",
      kind: "phase_completed",
      payload: { passed: report.passed },
    });
    if (!report.passed)
      return refuse(
        checks.some((c) => c.code === "unsupported_route")
          ? "unsupported_route"
          : "preflight_failed",
        "Preflight did not satisfy every required check.",
        { detail: { report } },
      );
    return ok(report);
  }
  async function sections(
    p: ProviderPort,
    config: JobConfig,
    revision: number,
  ): Promise<ReportSection[]> {
    const result: ReportSection[] = [];
    for await (const section of driverFor(job().type).reportSections(context(p, config, revision)))
      result.push(section);
    return result;
  }
  async function drain(
    p: ProviderPort,
    config: JobConfig,
    revision: number,
    phase: RowPhase,
    budget: RetryBudget,
    signal?: AbortSignal,
    verificationRun?: number,
  ): Promise<{ committed: number; interrupted: boolean; blocked: boolean }> {
    let committed = 0;
    let mappingFailed = false;
    let lastUnit = job().lastCheckpoint ?? "start";
    for (;;) {
      if (signal?.aborted) return { committed, interrupted: true, blocked: false };
      try {
        const driver = driverFor(job().type),
          ctx = context(p, config, revision, signal);
        const units =
          phase === "plan"
            ? driver.collect(ctx)
            : phase === "execute"
              ? driver.execute(ctx)
              : driver.verify(ctx);
        for await (const yielded of units) {
          guard(phase);
          const unit = verificationRun === undefined ? yielded : { ...yielded, verificationRun };
          if (unit.rev !== revision || unit.phase !== phase)
            throw new Error("Driver yielded a commit outside its current phase");
          if (store.commit(unit).applied) {
            committed++;
            store.publishProgress();
            if (unit.mappingPass?.status === "failed") {
              budget.mappingFailure(unit.mappingPass.mappingId);
              mappingFailed = true;
            }
          }
          lastUnit = unit.unitKey;
          if (signal?.aborted && !unit.mappingPass)
            return { committed, interrupted: true, blocked: false };
        }
        if (signal?.aborted) return { committed, interrupted: true, blocked: false };
        store.appendEvent({ verb: phase, phase, kind: "phase_completed", payload: { committed } });
        return { committed, interrupted: false, blocked: mappingFailed };
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
          return { committed, interrupted: true, blocked: false };
        const expected = expectedFailure(error);
        if (expected) throw error;
        const e =
          error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
        const key = `${phase}:${typeof e.sourceItemId === "string" ? e.sourceItemId : lastUnit}`;
        const retry = budget.failure(error, key);
        if (retry.retry) {
          await delay(retry.delay, signal);
          continue;
        }
        if (!retry.classified) throw error;
        if (retry.transient) return { committed, interrupted: false, blocked: true };
        const code = errorCode(error),
          findingCode =
            code && CODE_BY_NAME[code]
              ? code
              : job().type === "teams_archive"
                ? "message_collection_incomplete"
                : "destination_write_failed";
        store.commit({
          rev: revision,
          phase,
          unitKey: canonicalJson(["terminal-effect", phase, key, findingCode]),
          checkpoint: job().lastCheckpoint ?? "start",
          rows: [],
          findings: [
            {
              rev: revision,
              phase,
              code: findingCode,
              kind: CODE_BY_NAME[findingCode]?.kind ?? "finding",
              subjectKind: "job",
              subjectId: job().id,
              evidence: {
                retryable: false,
                consequence: "The affected collection unit is incomplete.",
              },
              at: deps.now().toISOString(),
            },
          ],
          ...(verificationRun ? { verificationRun } : {}),
        });
        return { committed, interrupted: false, blocked: true };
      }
    }
  }
  async function verifyRun(
    p: ProviderPort,
    config: JobConfig,
    revision: number,
    budget: RetryBudget,
    signal?: AbortSignal,
  ): Promise<Outcome<VerificationRevision & { planRev: number }>> {
    const run = store.nextVerificationRun();
    store.beginVerification(revision, run);
    store.appendEvent({
      verb: "verify",
      phase: "verify",
      kind: "phase_started",
      payload: { revision, run },
    });
    const drained = await drain(p, config, revision, "verify", budget, signal, run);
    if (drained.interrupted)
      return refuse(
        "retry_budget_exhausted",
        "Verification was interrupted at a durable checkpoint.",
        { detail: { interrupted: true } },
      );
    if (drained.blocked)
      return refuse("retry_budget_exhausted", "Verification stopped at its retry budget.", {
        detail: budget.summary(),
      });
    const evidenceDigest = digestJson({
      rows: store.readAllRows(revision, "verify"),
      findings: store.readCurrentFindings(revision, "verify"),
      archive: store.readResume(revision).archiveManifestDigest ?? null,
    });
    const verificationDigest = digestJson({
      planDigest: store.readPlanRevision(revision)?.planDigest,
      revision: run,
      nonce: randomUUID(),
      evidenceDigest,
    });
    const findings = findingFacets(store, revision),
      at = deps.now().toISOString();
    const result = {
      revision: run,
      planRev: revision,
      verificationDigest,
      evidenceDigest,
      clean: findings.length === 0,
      findings,
      acceptedCodes: [],
      at,
    };
    store.atomic(() => {
      store.writeVerificationRevision(result);
      store.writeJob({ ...job(), verificationRevision: run });
    });
    return ok(result);
  }
  async function startWorker(p: ProviderPort, executablePath = ""): Promise<TransferWorkerHandle> {
    let claimed = false;
    const worker = await p.startTransferWorker({
      runDirectory: join(paths.dir, "run"),
      onPrepare(intent) {
        const lease = store.readLease();
        if (!lease || lease.ownerUuid !== ownerUuid)
          throw new Error("Lease lost before worker launch intent");
        store.writeLease({
          ...lease,
          socketPath: intent.socketPath,
          workerGroup: intent.group,
          workerExecutable: intent.executablePath,
          workerPid: null,
          workerProcessStartTime: null,
        });
      },
      onSpawn(spawned) {
        const lease = store.readLease();
        if (!lease || lease.ownerUuid !== ownerUuid)
          throw new Error("Lease lost before worker process claim");
        store.writeLease({
          ...lease,
          socketPath: spawned.socketPath,
          workerPid: spawned.pid,
          workerGroup: spawned.group ?? null,
          workerProcessStartTime: getProcessStartTime(spawned.pid),
          workerExecutable: spawned.executablePath,
        });
        claimed = true;
      },
    });
    if (!claimed) {
      const lease = store.readLease();
      if (!lease || lease.ownerUuid !== ownerUuid)
        throw new Error("Lease lost before worker claim");
      store.writeLease({
        ...lease,
        socketPath: worker.socketPath,
        workerPid: worker.pid,
        workerGroup: worker.group ?? null,
        workerProcessStartTime: deps.provider ? null : getProcessStartTime(worker.pid),
        workerExecutable: executablePath || null,
      });
    }
    return worker;
  }
  async function stopWorker(p: ProviderPort, worker: TransferWorkerHandle): Promise<void> {
    await p.stopTransferWorker({ socketPath: worker.socketPath });
    const lease = store.readLease();
    if (lease)
      store.writeLease({
        ...lease,
        socketPath: null,
        workerPid: null,
        workerGroup: null,
        workerProcessStartTime: null,
        workerExecutable: null,
      });
  }
  function terminalResult(
    outcome: ExecuteResult["outcome"],
    committedUnits: number,
    budget: RetryBudget,
  ): Outcome<ExecuteResult> {
    const resumable = outcome !== "completed";
    store.atomic(() => {
      if (outcome !== "completed")
        transition(outcome === "interrupted" ? "interrupt" : "budget_exhausted", "execute");
      store.appendEvent({
        verb: "execute",
        phase: "execute",
        kind: "terminal",
        payload: { state: outcome, resumable, resumeVerb: resumable ? "execute" : null },
      });
    });
    return ok({
      outcome,
      resumable,
      checkpoint: job().lastCheckpoint,
      committedUnits,
      ...(outcome === "blocked" ? { budget: budget.summary() } : {}),
    });
  }
  const writer: JobWriter = {
    async loadManifest(input) {
      const loaded = await operation<LoadedManifest>("plan", async () => {
        if (job().type !== "file_migration")
          return refuse("unsupported_route", "Mapping manifests require a file migration job.");
        const manifest = parseManifest(input.content, input.format);
        const base = existsSync(paths.configPath)
          ? readConfig(paths, job().type, store)
          : parseConfig({}, job().type, paths);
        if (!("mappings" in base)) throw new Error("Expected file configuration");
        const pending = manifest.mappings.map((m) => ({
          id: m.id,
          sourceDriveId: m.source.driveId,
          sourceFolderPath: m.source.folderPath,
          destDriveId: m.destination.driveId,
          destFolderId: m.destination.folderId,
        }));
        const p =
          deps.provider ??
          createProductionProvider({
            jobType: "file_migration",
            config: { ...base, mappings: pending },
            jobDirectory: paths.dir,
          });
        providers.add(p);
        const mappings: Mapping[] = [];
        for (let index = 0; index < pending.length; index++) {
          const mapping = pending[index]!,
            source = manifest.mappings[index]!.source;
          const root = await p.resolveSourceFolder({
            driveId: source.driveId,
            folderPath: source.folderPath,
          });
          if (!root || root.kind !== "folder" || root.driveId !== source.driveId)
            throw new ManifestError(
              index + 1,
              "source.folderPath",
              "Source folder does not resolve",
            );
          mappings.push({ ...mapping, sourceItemId: root.id });
        }
        await validateMappingTrees(p, mappings);
        const previousRevision = job().planRevision;
        store.atomic(() => {
          store.writeMappings({ mappings, digest: manifest.digest });
          // Even failed recollection must not leave the previous approval executable.
          if (previousRevision !== null)
            store.writeJob({
              ...job(),
              state: "new",
              planRevision: null,
              verificationRevision: null,
              lastCheckpoint: null,
            });
        });
        if (!existsSync(paths.configPath)) {
          const { mappings: _mappings, manifestDigest: _digest, ...settings } = base;
          atomicFile(paths.configPath, stringifyToml(settings));
        }
        store.appendEvent({
          verb: "plan",
          phase: "plan",
          kind: "phase_completed",
          payload: { manifestDigest: manifest.digest, mappingCount: mappings.length },
        });
        return ok({
          mappingCount: mappings.length,
          manifestDigest: manifest.digest,
          planRevision: previousRevision,
        });
      });
      if (!loaded.ok || loaded.value.planRevision === null) return loaded;
      const plan = await writer.plan();
      return plan.ok ? ok({ ...loaded.value, planRevision: plan.value.revision }) : plan;
    },
    onboard: (raw) =>
      operation("doctor", async () => {
        persistConfig(paths, parseConfig(raw, job().type, paths), store);
        const config = readConfig(paths, job().type, store);
        const p = provider(config),
          proof = await preflight(config, p);
        if (!proof.ok) return proof;
        const plan =
          job().planRevision === null ? null : store.readPlanRevision(job().planRevision!);
        if (plan) {
          const fresh = await boundEvidence(p, config),
            old = JSON.parse(plan.inputs.identity ?? "{}") as BoundEvidence;
          if (fresh.applicationIdentity !== old.applicationIdentity)
            return refuse(
              "plan_revision_required",
              "The authenticated application identity has changed.",
            );
        }
        return proof;
      }),
    doctor: () =>
      operation("doctor", async () => {
        const config = readConfig(paths, job().type, store);
        return preflight(config, provider(config));
      }),
    plan: () =>
      operation("plan", async () => {
        if (job().type === "teams_archive" && job().executionCompleted)
          return refuse(
            "plan_revision_required",
            "A completed archive requires a new job with an optional lineage pointer.",
          );
        let config = readConfig(paths, job().type, store);
        if (!("mappings" in config) && !config.window.to && job().planRevision !== null) {
          const previous = store.readResume(job().planRevision!).archivePlan;
          if (previous)
            config = { ...config, window: { ...config.window, to: previous.window.to } };
        }
        const p = provider(config),
          ready = await preflight(config, p);
        if (!ready.ok) return ready;
        const revision = store.nextPlanRevision();
        store.appendEvent({
          verb: "plan",
          phase: "plan",
          kind: "phase_started",
          payload: { revision },
        });
        const drained = await drain(p, config, revision, "plan", new RetryBudget(200));
        if (drained.interrupted)
          return refuse(
            "retry_budget_exhausted",
            "Plan collection was interrupted before a complete review could be produced.",
            { detail: { interrupted: true } },
          );
        if (drained.blocked)
          return refuse("retry_budget_exhausted", "Plan collection exhausted its retry budget.");
        const rows = store.readAllRows(revision, "plan"),
          resume = store.readResume(revision),
          evidence = await boundEvidence(p, config);
        if (!("mappings" in config) && !config.window.to && resume.archivePlan)
          config = { ...config, window: { ...config.window, to: resume.archivePlan.window.to } };
        const inputs = inputFields(config, evidence, rows, resume.archivePlan),
          inputsDigest = digestJson(inputs);
        const reportSections = await sections(p, config, revision);
        const disclosures = reportSections
          .filter((s) => !s.body.startsWith("{") && !s.body.startsWith("["))
          .flatMap((s) => s.body.split("\n"));
        const planDigest = digestJson({
          inputsDigest,
          rows: contentDigest(rows),
          findings: contentDigest(
            store.readFindings(revision).map(({ id: _id, ...finding }) => finding),
          ),
          archive: semantic(resume.archivePlan ?? null),
          disclosures,
        });
        const createdAt = deps.now().toISOString();
        const record = {
          revision,
          ...("mappings" in config ? { manifestDigest: config.manifestDigest } : {}),
          planDigest,
          inputsDigest,
          createdAt,
          sourceInventoryAt: createdAt,
          rowCount: rows.length,
          inputs,
          evidence: { binding: evidence, reportSections },
          disclosures,
          sections: reportSections.map((s, i) => ({
            id: `section-${i}`,
            title: s.title,
            body: s.body,
          })),
        };
        store.atomic(() => {
          store.writePlanRevision(record);
          store.writeJob({ ...job(), planRevision: revision, verificationRevision: null });
          transition("plan", "plan", { revision, planDigest });
        });
        return ok({ ...record, review: store.rows({ revision, phase: "plan", limit: 200 }) });
      }),
    approve: (a) =>
      operation("approve", async () => {
        if (
          !a ||
          typeof a.approver !== "string" ||
          !a.approver.trim() ||
          !["interactive", "unattended"].includes(a.mode)
        )
          return refuse(
            "approval_required",
            "Approval requires an explicit named approver and mode.",
          );
        const revision = job().planRevision,
          plan = revision === null ? null : store.readPlanRevision(revision);
        if (!plan) return refuse("approval_required", "There is no plan to approve.");
        if (a.planDigest !== plan.planDigest)
          return refuse("approval_digest_stale", "The digest is not the current plan.", {
            detail: { expected: plan.planDigest },
          });
        const blockers = store
          .readFindings(plan.revision, "plan")
          .filter((f) => f.kind === "finding");
        if (blockers.length)
          return refuse("preflight_failed", "The plan contains unresolved blockers.", {
            detail: { codes: [...new Set(blockers.map((f) => f.code))] },
          });
        if (job().state !== "planned")
          return refuse("approval_required", "Only the current unapproved plan may be approved.");
        const approval = {
          revision: plan.revision,
          planDigest: plan.planDigest,
          approver: text(a.approver, "approver"),
          mode: a.mode,
          at: deps.now().toISOString(),
        };
        const record: ApprovalRecord = { ...approval, approvalDigest: digestJson(approval) };
        store.atomic(() => {
          store.writeApproval(record);
          transition("approve", "approve", {
            planDigest: plan.planDigest,
            approvalDigest: record.approvalDigest,
          });
        });
        return ok(record);
      }),
    execute: (opts) =>
      operation("execute", async () => {
        executionInterrupt = new AbortController();
        const signal = opts?.signal
          ? AbortSignal.any([opts.signal, executionInterrupt.signal])
          : executionInterrupt.signal;
        const revision = job().planRevision,
          plan = revision === null ? null : store.readPlanRevision(revision);
        if (!plan) return refuse("approval_required", "There is no approved plan.");
        const approval = store.readApproval(plan.revision);
        if (!approval) return refuse("approval_required", "The current plan has no approval.");
        if (approval.planDigest !== plan.planDigest)
          return refuse("approval_digest_stale", "The approval is stale.");
        const archiveVerificationResume =
          job().type === "teams_archive" &&
          job().executionCompleted === true &&
          ["interrupted", "blocked"].includes(job().state);
        if (
          job().type === "teams_archive" &&
          job().executionCompleted &&
          !archiveVerificationResume
        )
          return refuse(
            "plan_revision_required",
            "A completed archive cannot execute a second pass.",
          );
        if (!nextState(job().state, "execute"))
          return refuse(
            "verification_unaccepted",
            "The current execution must be assessed before another pass.",
          );
        let config = readConfig(paths, job().type, store);
        const resume = store.readResume(plan.revision);
        if (!("mappings" in config) && !config.window.to && resume.archivePlan)
          config = { ...config, window: { ...config.window, to: resume.archivePlan.window.to } };
        const p = provider(config, archiveVerificationResume),
          evidence = await boundEvidence(p, config);
        const currentInputs = inputFields(
          config,
          evidence,
          store.readAllRows(plan.revision, "plan"),
          resume.archivePlan,
        );
        if (digestJson(currentInputs) !== plan.inputsDigest)
          return refuse(
            "plan_revision_required",
            "The approved inputs or authenticated route identity have changed.",
          );
        const bound = readBoundEvidence(plan.evidence);
        if (p.assertExecutionEvidence) await p.assertExecutionEvidence(bound);
        if ("mappings" in config)
          await checkApprovedMappingScope(p, config, store.readAllRows(plan.revision, "plan"));
        transition("execute", "execute");
        store.appendEvent({
          verb: "execute",
          phase: "execute",
          kind: "phase_started",
          payload: { revision: plan.revision },
        });
        const budget = new RetryBudget(Math.max(1, plan.rowCount));
        if (signal.aborted) return terminalResult("interrupted", 0, budget);
        let worker: TransferWorkerHandle | undefined;
        try {
          if (needsTransferWorker(config)) {
            worker = await startWorker(p, evidence.binaryPath);
            const version = await p.transferWorkerVersion({ socketPath: worker.socketPath });
            if (
              version !== worker.version ||
              (bound.binaryVersion && version !== bound.binaryVersion)
            )
              throw new EngineRefusalError({
                code: "plan_revision_required",
                message: "The live worker version changed after approval.",
              });
            if (p.assertExecutionEvidence) await p.assertExecutionEvidence(bound);
          }
          const drained = archiveVerificationResume
            ? { committed: 0, interrupted: false, blocked: false }
            : await drain(p, config, plan.revision, "execute", budget, signal);
          if (drained.interrupted || drained.blocked)
            return terminalResult(
              drained.interrupted ? "interrupted" : "blocked",
              drained.committed,
              budget,
            );
          store.writeJob({ ...job(), executionCompleted: true });
          store.appendEvent({
            verb: "execute",
            phase: "execute",
            kind: "phase_completed",
            payload: { revision: plan.revision, committed: drained.committed },
          });
          const verified = await verifyRun(p, config, plan.revision, budget, signal);
          if (!verified.ok)
            return terminalResult(
              signal.aborted ? "interrupted" : "blocked",
              drained.committed,
              budget,
            );
          transition(verified.value.clean ? "finish_clean" : "finish_gaps", "verify", {
            verificationDigest: verified.value.verificationDigest,
          });
          return terminalResult("completed", drained.committed, budget);
        } catch (error) {
          if (job().state === "executing") transition("interrupt", "execute");
          throw error;
        } finally {
          if (worker) await stopWorker(p, worker);
        }
      }),
    verify: () =>
      operation("verify", async () => {
        if (!["verified", "needs_attention"].includes(job().state) || job().planRevision === null)
          return refuse("verification_unaccepted", "Verification requires completed execution.");
        const config = readConfig(paths, job().type, store),
          p = provider(config, true),
          revision = job().planRevision!,
          plan = store.readPlanRevision(revision)!;
        let worker: TransferWorkerHandle | undefined;
        try {
          if (needsTransferWorker(config)) {
            const bound = readBoundEvidence(plan.evidence);
            const evidence = await boundEvidence(p, config);
            if (canonicalJson(evidence) !== canonicalJson(bound))
              return refuse(
                "plan_revision_required",
                "The approved application, route, or binary evidence changed.",
              );
            if (p.assertExecutionEvidence) await p.assertExecutionEvidence(bound);
            worker = await startWorker(p, evidence.binaryPath);
            const version = await p.transferWorkerVersion({ socketPath: worker.socketPath });
            if (
              version !== worker.version ||
              (bound.binaryVersion && version !== bound.binaryVersion)
            )
              return refuse(
                "plan_revision_required",
                "The live worker version changed after approval.",
              );
            if (p.assertExecutionEvidence) await p.assertExecutionEvidence(bound);
          }
          const result = await verifyRun(p, config, revision, new RetryBudget(plan.rowCount));
          if (!result.ok) return result;
          transition(result.value.clean ? "verify_clean" : "verify_gaps", "verify", {
            verificationDigest: result.value.verificationDigest,
          });
          return result;
        } finally {
          if (worker) await stopWorker(p, worker);
        }
      }),
    accept: (x) =>
      operation("verify", async () => {
        if (
          !x ||
          typeof x.verificationDigest !== "string" ||
          !Array.isArray(x.codes) ||
          x.codes.some((code) => !code || typeof code !== "object" || typeof code.code !== "string")
        )
          return refuse(
            "verification_unaccepted",
            "Acceptance requires a current digest and explicit named exception records.",
          );
        const current = currentVerification(store);
        if (
          !current ||
          current.verificationDigest !== x.verificationDigest ||
          job().planRevision !== current.planRev
        )
          return refuse(
            "verification_unaccepted",
            "Acceptance must name the current verification digest.",
          );
        if (typeof x.approver !== "string" || !x.approver.trim() || x.codes.length === 0)
          return refuse(
            "verification_unaccepted",
            "Acceptance requires an approver and a nonempty named exception set.",
          );
        const actual = new Set(current.findings.map((f) => f.code));
        // A repeated code names the same exception again; only distinct notes conflict.
        const named = new Map<string, string | undefined>();
        for (const c of x.codes) {
          if (
            !isAcceptable(c.code) ||
            !actual.has(c.code) ||
            (c.note !== undefined && typeof c.note !== "string")
          )
            return refuse(
              "verification_unaccepted",
              "Every accepted code must occur in this verification.",
              { detail: { code: c.code } },
            );
          const prior = named.get(c.code);
          if (prior !== undefined && c.note !== undefined && prior !== c.note)
            return refuse(
              "verification_unaccepted",
              "A repeated exception code carries conflicting notes.",
              { detail: { code: c.code } },
            );
          named.set(c.code, c.note ?? prior);
        }
        const at = deps.now().toISOString();
        return store.atomic(() => {
          store.writeAcceptances(
            [...named].map(([code, note]) => ({
              verificationDigest: current.verificationDigest,
              code,
              approver: text(x.approver, "approver"),
              note: note ?? null,
              at,
            })),
          );
          const acceptedCodes = store
              .readAcceptances(current.verificationDigest)
              .map((a) => a.code),
            clean = outstanding(store, current.planRev, current.verificationDigest).length === 0;
          if (clean && job().state === "needs_attention") transition("accept", "verify");
          return ok({ ...current, clean, acceptedCodes });
        });
      }),
    report: () =>
      operation("report", async () => {
        const revision = job().planRevision ?? 0,
          verification = currentVerification(store);
        const config = revision > 0 ? readConfig(paths, job().type, store) : undefined;
        const reportSections = config ? await sections(provider(config), config, revision) : [];
        const phase: RowPhase = verification ? "verify" : store.currentPhase(revision);
        const findings = store.readCurrentFindings(revision, phase),
          rows = store.readAllRows(revision);
        const accepted = verification
          ? store.readAcceptances(verification.verificationDigest).map((a) => ({
              ...a,
              evidenceDigest: verification.evidenceDigest ?? verification.verificationDigest,
              items: findings
                .filter((f) => f.code === a.code)
                .map((f) => ({
                  subjectKind: f.subjectKind,
                  subjectId: f.subjectId,
                  phase: f.phase,
                  evidence: f.evidence,
                  consequence: consequence(f.code),
                })),
            }))
          : [];
        const acceptedCodes = new Set(accepted.map((a) => a.code));
        const report = {
          schemaVersion: 1,
          job: { id: job().id, type: job().type, label: job().label, state: job().state },
          plan: revision ? store.readPlanRevision(revision) : null,
          approval: revision ? store.readApproval(revision) : null,
          verification,
          sections: reportSections,
          disclosures: [
            "Permissions and ownership were neither assessed nor migrated.",
            "Same-user processes are not isolated; local state has no application-level at-rest encryption.",
          ],
          checks: store.readCheckResults(),
          rows: rows.map((r) => ({ ...r, accepted: acceptedCodes.has(r.code) })),
          findings,
          acceptedExceptions: accepted,
          archive: store.readResume(revision).archivePlan ?? null,
        };
        const json = `${canonicalJson(report)}\n`;
        const jsonl =
          [
            canonicalJson({ kind: "report", ...report, rows: undefined, findings: undefined }),
            ...report.rows.map((row) => canonicalJson({ kind: "row", row })),
            ...findings.map((finding) => canonicalJson({ kind: "finding", finding })),
          ].join("\n") + "\n";
        const html = reportHtml(report),
          contents = [
            { name: "report.json", format: "json" as const, body: json },
            { name: "report.jsonl", format: "jsonl" as const, body: jsonl },
            { name: "report.html", format: "html" as const, body: html },
          ];
        const archiveArtifacts: Artifact[] = [];
        if (job().type === "teams_archive")
          for (const [name, format] of [
            ["index.html", "html"],
            ["index.csv", "csv"],
            ["manifest.json", "json"],
          ] as const) {
            const path = join(paths.dir, "archive", name);
            if (existsSync(path))
              archiveArtifacts.push({
                name: `archive/${name}`,
                format,
                path,
                digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
              });
          }
        const manifest = [
          ...contents.map((c) => ({
            name: c.name,
            format: c.format,
            digest: createHash("sha256").update(c.body).digest("hex"),
          })),
          ...archiveArtifacts.map(({ name, format, digest }) => ({ name, format, digest })),
        ];
        const reportDigest = digestJson(manifest),
          dir = join(
            paths.artifactsDir,
            `report-${revision}-${verification?.revision ?? 0}-${reportDigest}`,
          );
        const artifacts: Artifact[] = [];
        for (const c of contents) {
          const path = join(dir, c.name);
          if (!existsSync(path)) atomicFile(path, c.body);
          else if (readFileSync(path, "utf8") !== c.body)
            throw new Error("Immutable report artifact was modified");
          artifacts.push({
            name: c.name,
            format: c.format,
            path,
            digest: createHash("sha256").update(c.body).digest("hex"),
          });
        }
        artifacts.push(...archiveArtifacts);
        const result = { reportDigest, artifacts };
        store.atomic(() => {
          store.writeArtifactSet(result);
          store.appendEvent({
            verb: "report",
            phase: "report",
            kind: "phase_completed",
            payload: { reportDigest, artifacts: artifacts.length },
          });
        });
        return ok(result);
      }),
    close: () =>
      operation("close", async () => {
        const verification = currentVerification(store),
          revision = job().planRevision;
        if (
          !verification ||
          revision === null ||
          verification.planRev !== revision ||
          job().state !== "verified" ||
          outstanding(store, revision, verification.verificationDigest).length
        )
          return refuse(
            "verification_unaccepted",
            "Closure requires current verification with every exception explicitly accepted.",
          );
        const acceptedExceptions = store
          .readAcceptances(verification.verificationDigest)
          .map((a) => a.code);
        const result: Closure = {
          state: "closed",
          at: deps.now().toISOString(),
          acceptedExceptions,
          outcome: acceptedExceptions.length ? "completed_with_accepted_exceptions" : "completed",
        };
        store.atomic(() => {
          transition("close", "close");
          store.appendEvent({
            verb: "close",
            phase: "close",
            kind: "terminal",
            payload: { state: "completed", resumable: false, outcome: result.outcome },
          });
        });
        return ok(result);
      }),
    async cancel(reason) {
      if (busy) {
        executionInterrupt?.abort();
        await settled;
      }
      return operation("cancel", async () => {
        text(reason, "reason");
        const verification = currentVerification(store);
        const result: Closure = {
          state: "cancelled",
          at: deps.now().toISOString(),
          acceptedExceptions: verification
            ? store.readAcceptances(verification.verificationDigest).map((a) => a.code)
            : [],
          reason,
          outcome: "cancelled",
        };
        store.atomic(() => {
          transition("cancel", "cancel");
          store.appendEvent({
            verb: "cancel",
            phase: "cancel",
            kind: "terminal",
            payload: { state: "cancelled", resumable: false, reason },
          });
        });
        return ok(result);
      });
    },
  };
  return {
    writer,
    async dispose() {
      let failure: unknown;
      for (const p of providers)
        if (p !== deps.provider) {
          try {
            await p.close?.();
          } catch (error) {
            failure ??= error;
          }
        }
      const lease = store.readLease();
      if (lease?.socketPath) {
        const controlledStop = !deps.provider && failure === undefined;
        const inspection = controlledStop
          ? undefined
          : await inspectLease(lease, lease.hostId, { now: deps.now });
        if (
          controlledStop ||
          (inspection?.workerStatus === "absent" && inspection.socketStatus === "absent")
        )
          store.writeLease({
            ...lease,
            socketPath: null,
            workerPid: null,
            workerGroup: null,
            workerProcessStartTime: null,
            workerExecutable: null,
          });
      }
      if (failure) throw failure;
    },
  };
}
async function checkApprovedMappingScope(
  p: ProviderPort,
  config: FileConfig,
  planned: CommitRow[],
): Promise<void> {
  for (const mapping of config.mappings) {
    const frozen = planned.find(
      (r) => r.jobType === "file_migration" && r.mappingId === mapping.id && r.fileScope,
    );
    if (!frozen || frozen.jobType !== "file_migration" || !frozen.fileScope)
      throw new EngineRefusalError({
        code: "plan_revision_required",
        message: "The plan has no frozen mapping scope.",
      });
    const root = await p.resolveDestinationFolder(mapping);
    if (
      !root ||
      root.id !== mapping.destFolderId ||
      root.driveId !== mapping.destDriveId ||
      root.kind !== "folder"
    )
      throw new EngineRefusalError({
        code: "plan_revision_required",
        message: "An approved destination root changed identity or type.",
      });
    if (mapping.exclusions?.length) {
      const excluded = new Set(frozen.fileScope.exclusions.map((e) => e.sourceItemId));
      const sourceRoot = await p.resolveSourceRoot(mapping);
      if (
        !sourceRoot ||
        sourceRoot.driveId !== mapping.sourceDriveId ||
        sourceRoot.kind !== "folder"
      )
        throw new EngineRefusalError({
          code: "plan_revision_required",
          message: "An approved source root no longer resolves.",
        });
      const requested = new Set(mapping.exclusions.map((e) => e.sourceItemId));
      const sourceStack = [{ id: sourceRoot.id, excluded: requested.has(sourceRoot.id) }],
        sourceSeen = new Set<string>();
      while (sourceStack.length) {
        const parent = sourceStack.pop()!;
        if (sourceSeen.has(parent.id))
          throw new EngineRefusalError({
            code: "plan_revision_required",
            message: "The source hierarchy is no longer a tree.",
          });
        sourceSeen.add(parent.id);
        for (const child of await p.listSourceChildren(parent.id)) {
          const inExclusion = parent.excluded || requested.has(child.id);
          if (inExclusion !== excluded.has(child.id))
            throw new EngineRefusalError({
              code: "plan_revision_required",
              message: "The excluded subtree no longer matches its approved stable-ID set.",
            });
          if (child.kind === "folder") sourceStack.push({ id: child.id, excluded: inExclusion });
        }
      }
    }
  }
}
function consequence(code: string): string {
  return CODE_BY_NAME[code]?.kind === "planned_omission"
    ? "The named items or fidelity are omitted from the promised result; acceptance does not restore them."
    : "The named verification or collection guarantee is not established for these items; acceptance does not constitute proof.";
}
function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function reportHtml(report: {
  job: unknown;
  sections: ReportSection[];
  disclosures: string[];
  rows: unknown[];
  findings: unknown[];
  acceptedExceptions: unknown[];
  checks: unknown[];
  plan: unknown;
  approval: unknown;
  verification: unknown;
}): string {
  const section = (title: string, value: unknown) =>
    `<section><h2>${escapeHtml(title)}</h2><pre>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre></section>`;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Migmate evidence report</title></head><body><h1>Migmate evidence report</h1>${section("Job", report.job)}${section("Standing disclosures", report.disclosures.join("\n"))}${section("Plan and approval", { plan: report.plan, approval: report.approval })}${report.sections.map((s) => section(s.title, s.body)).join("")}${section("Preflight evidence", report.checks)}${section("Verification", report.verification)}${section("All item and conversation rows", report.rows)}${section("Complete findings", report.findings)}${section("Accepted exceptions, affected items and consequences", report.acceptedExceptions)}</body></html>\n`;
}
