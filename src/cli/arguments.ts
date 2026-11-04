import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { VERBS, type JobType, type RowQuery, type Verb } from "../engine/types.ts";

export type OutputMode = "text" | "json" | "jsonl";
export type CommandName =
  | Verb
  | "creds init"
  | "creds dir"
  | "manifest load"
  | "discover"
  | "accept"
  | "acknowledge"
  | "reclaim"
  | "settings"
  | "web"
  | "stop"
  | "version";
export interface Invocation {
  command: CommandName;
  output: OutputMode;
  home: string;
  jobId?: string;
  type?: JobType;
  label?: string;
  config?: string;
  file?: string;
  approver?: string;
  planDigest?: string;
  /** ADR-0019 D3: approve the pool's added acting accounts rather than a plan. */
  accounts?: boolean;
  poolDigest?: string;
  final?: boolean;
  detach?: boolean;
  freeze?: { by: string; at: string; how: string };
  verificationDigest?: string;
  closeDigest?: string;
  goLiveDigest?: string;
  mappingIds: string[];
  codes: string[];
  /** ADR-0020 D3: discover's capacity target for all boundaries, and per boundary ID. */
  capacity?: { target?: number; targets: Record<string, number> };
  note?: string;
  reason?: string;
  confirm: boolean;
  stopWorker: boolean;
  from?: number;
  review: boolean;
  query: RowQuery;
  help: boolean;
}

export class UsageFailure extends Error {}

export function defaultHome(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  cwd = process.cwd(),
): string {
  if (environment.MIGMATE_HOME) return resolve(cwd, environment.MIGMATE_HOME);
  if (platform !== "darwin" && platform !== "linux")
    throw new UsageFailure("Unsupported platform.");
  let directory = resolve(cwd);
  for (;;) {
    const candidate = join(directory, ".migmate");
    let entry;
    try {
      entry = lstatSync(candidate, { throwIfNoEntry: false });
    } catch {
      throw new UsageFailure(`Cannot inspect workspace ${candidate}; use --home explicitly.`);
    }
    if (entry !== undefined) {
      if (!entry.isDirectory())
        throw new UsageFailure(
          `Workspace ${candidate} must be a directory, not a file or symlink.`,
        );
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return platform === "darwin"
    ? posix.join(home, "Library", "Application Support", "Migmate")
    : posix.join(
        environment.XDG_STATE_HOME && posix.isAbsolute(environment.XDG_STATE_HOME)
          ? environment.XDG_STATE_HOME
          : posix.join(home, ".local", "state"),
        "migmate",
      );
}

// Output must be initialized even when another argument is malformed.
export function outputMode(argv: string[]): OutputMode {
  for (let index = argv.length - 1; index >= 0; index--) {
    const token = argv[index];
    const value =
      token === "--output"
        ? argv[index + 1]
        : token?.startsWith("--output=")
          ? token.slice(9)
          : undefined;
    if (value === "json" || value === "jsonl" || value === "text") return value;
  }
  return "text";
}

export function commandLabel(argv: string[]): string {
  const first = argv[0];
  return (first === "creds" && (argv[1] === "init" || argv[1] === "dir")) ||
    (first === "manifest" && argv[1] === "load")
    ? `${first} ${argv[1]}`
    : first && !first.startsWith("-")
      ? first
      : argv.includes("--version") && !argv.includes("--help") && !argv.includes("-h")
        ? "version"
        : "help";
}

export function parseInvocation(argv: string[]): Invocation {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const words: string[] = [];
  const flags = [
    "--output",
    "--home",
    "--job",
    "--type",
    "--label",
    "--config",
    "--file",
    "--approver",
    "--plan-digest",
    "--pool-digest",
    "--freeze-by",
    "--freeze-at",
    "--freeze-how",
    "--verification-digest",
    "--close-digest",
    "--go-live-digest",
    "--code",
    "--note",
    "--reason",
    "--from",
    "--phase",
    "--cursor",
    "--limit",
    "--search",
    "--sort",
    "--revision",
    "--view",
    "--mapping",
    "--schema-version",
    "--capacity-target",
  ];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("-")) {
      words.push(token);
      continue;
    }
    if (
      [
        "--help",
        "-h",
        "--version",
        "--review",
        "--confirm",
        "--stop-worker",
        "--final",
        "--detach",
        "--accounts",
      ].includes(token)
    ) {
      if (switches.has(token)) throw new UsageFailure("A switch was supplied more than once.");
      switches.add(token);
      continue;
    }
    const equal = token.indexOf("=");
    const flag = equal === -1 ? token : token.slice(0, equal);
    if (!flags.includes(flag)) throw new UsageFailure("Unknown option.");
    const value = equal === -1 ? argv[++index] : token.slice(equal + 1);
    if (!value || value.startsWith("--") || /[\u0000]/u.test(value))
      throw new UsageFailure("An option needs a non-empty value.");
    if (
      values.has(flag) &&
      flag !== "--code" &&
      flag !== "--mapping" &&
      flag !== "--capacity-target"
    )
      throw new UsageFailure("An option was supplied more than once.");
    const prior = values.get(flag);
    if (prior) prior.push(value);
    else values.set(flag, [value]);
  }
  const help = switches.has("--help") || switches.has("-h");
  // --help wins over --version, as it does over every other option.
  const version = !help && switches.has("--version");
  const command = words.join(" ");
  if (
    !VERBS.includes(command as Verb) &&
    ![
      "creds init",
      "creds dir",
      "manifest load",
      "discover",
      "accept",
      "acknowledge",
      "reclaim",
      "settings",
      "stop",
      "web",
    ].includes(command) &&
    !((help || version) && words.length === 0)
  ) {
    throw new UsageFailure(
      "Supply a lifecycle command, creds init, creds dir, manifest load, discover, accept, acknowledge, reclaim, settings, or web.",
    );
  }
  if (version && words.length > 0) throw new UsageFailure("--version takes no command.");
  const get = (flag: string) => values.get(flag)?.[0];
  const output = get("--output") ?? "text";
  if (!["text", "json", "jsonl"].includes(output))
    throw new UsageFailure("Unsupported output mode.");
  if (get("--schema-version") !== undefined && get("--schema-version") !== "1")
    throw new UsageFailure("Unsupported output schema version.");
  const type = get("--type");
  if (type !== undefined && type !== "file_migration" && type !== "teams_archive")
    throw new UsageFailure("Unsupported job type.");
  const jobId = get("--job");
  if (jobId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(jobId))
    throw new UsageFailure("Job ids must be single safe identifiers, not paths.");
  const integer = (flag: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const raw = get(flag);
    if (raw === undefined) return undefined;
    if (
      !/^\d+$/u.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < minimum ||
      Number(raw) > maximum
    )
      throw new UsageFailure("Invalid numeric option.");
    return Number(raw);
  };
  const phase = get("--phase") ?? (command === "verify" ? "verify" : "plan");
  if (!["plan", "execute", "verify"].includes(phase))
    throw new UsageFailure("Unsupported review phase.");
  const sort = get("--sort");
  if (sort !== undefined && sort !== "natural" && sort !== "path" && sort !== "size")
    throw new UsageFailure("Unsupported row ordering.");
  const query: RowQuery = {
    phase: phase as RowQuery["phase"],
    limit: integer("--limit", 1, 1000) ?? 200,
  };
  const codes = values.get("--code") ?? [];
  if (codes.length) query.codes = codes;
  const cursor = get("--cursor");
  const search = get("--search");
  const revision = integer("--revision", 1);
  if (cursor !== undefined) query.cursor = cursor;
  if (search !== undefined) query.search = search;
  if (revision !== undefined) query.revision = revision;
  if (sort !== undefined) query.sort = sort;
  const view = get("--view");
  if (view !== undefined && view !== "items" && view !== "mappings")
    throw new UsageFailure("Unsupported review view.");
  if (view !== undefined) query.view = view;
  if (view === "mappings" && sort !== undefined && sort !== "natural")
    throw new UsageFailure("Mapping rows are ordered by mapping id; use --sort natural.");
  const mappingIds = values.get("--mapping") ?? [];
  if (command !== "acknowledge" && mappingIds.length > 1)
    throw new UsageFailure("Review accepts only one --mapping.");
  const mapping = mappingIds[0];
  if (mapping !== undefined && command !== "acknowledge") query.mappingId = mapping;
  const invocation: Invocation = {
    command: (version ? "version" : command || "status") as CommandName,
    output: output as OutputMode,
    // Help, version and creds dir never open a store and must remain available with a
    // broken workspace.
    home: resolve(
      get("--home") ?? (help || version || command === "creds dir" ? "." : defaultHome()),
    ),
    codes,
    mappingIds,
    ...(get("--note") === undefined ? {} : { note: get("--note")! }),
    confirm: switches.has("--confirm"),
    stopWorker: switches.has("--stop-worker"),
    review: switches.has("--review") || cursor !== undefined || revision !== undefined,
    query,
    help,
  };
  if (switches.has("--detach")) invocation.detach = true;
  if (jobId !== undefined) invocation.jobId = jobId;
  if (type !== undefined) invocation.type = type as JobType;
  const strings = {
    label: "--label",
    config: "--config",
    file: "--file",
    approver: "--approver",
    planDigest: "--plan-digest",
    poolDigest: "--pool-digest",
    verificationDigest: "--verification-digest",
    closeDigest: "--close-digest",
    goLiveDigest: "--go-live-digest",
    reason: "--reason",
  } as const;
  for (const [key, flag] of Object.entries(strings)) {
    const value = get(flag);
    if (value !== undefined) Object.assign(invocation, { [key]: value });
  }
  const from = integer("--from", 0);
  if (from !== undefined) invocation.from = from;
  if (help || version) return invocation;
  if (command === "creds dir") {
    if (
      switches.size ||
      [...values.keys()].some((flag) => !["--output", "--home", "--schema-version"].includes(flag))
    )
      throw new UsageFailure("creds dir takes no job or other options.");
    return invocation;
  }
  if (command === "init") {
    if (!type) throw new UsageFailure("init requires an explicit --type.");
    if (jobId) throw new UsageFailure("init generates its job id.");
  } else if (!jobId) throw new UsageFailure("This command requires --job.");
  if (command === "creds init" && !invocation.config)
    throw new UsageFailure("creds init requires --config with typed file references.");
  if (command === "settings" && !invocation.config)
    throw new UsageFailure("settings requires --config with the job's full configuration.");
  if (command === "manifest load" && !invocation.file)
    throw new UsageFailure("manifest load requires --file manifest.json|manifest.csv.");
  const only = (flag: string, allowed: string[]) => {
    if ((values.has(flag) || switches.has(flag)) && !allowed.includes(command))
      throw new UsageFailure("Option is not valid for this command.");
  };
  if (invocation.detach && (command !== "execute" || output === "jsonl"))
    throw new UsageFailure(
      "--detach is only available for execute with text or JSON output; tail the attempt log and use status to follow progress.",
    );
  for (const flag of ["--type", "--label"]) only(flag, ["init"]);
  only("--config", ["init", "creds init", "settings"]);
  only("--file", ["manifest load", "discover"]);
  only("--capacity-target", ["discover"]);
  const capacity = values.get("--capacity-target");
  if (capacity) {
    const parsed: NonNullable<Invocation["capacity"]> = { targets: {} };
    for (const raw of capacity) {
      // N for every boundary, or BOUNDARY=N for one; the boundary ID may contain "=".
      const equal = raw.lastIndexOf("=");
      const id = equal === -1 ? undefined : raw.slice(0, equal);
      const count = equal === -1 ? raw : raw.slice(equal + 1);
      if (!/^[1-9]\d*$/u.test(count) || !Number.isSafeInteger(Number(count)) || id === "")
        throw new UsageFailure("--capacity-target takes ITEMS or BOUNDARY_ID=ITEMS.");
      if (id === undefined) {
        if (parsed.target !== undefined)
          throw new UsageFailure("Give one job-wide --capacity-target.");
        parsed.target = Number(count);
      } else {
        if (Object.hasOwn(parsed.targets, id))
          throw new UsageFailure("A boundary's --capacity-target was supplied more than once.");
        parsed.targets[id] = Number(count);
      }
    }
    invocation.capacity = parsed;
  }
  only("--approver", ["approve", "accept", "close", "acknowledge"]);
  only("--plan-digest", ["approve"]);
  only("--pool-digest", ["approve"]);
  only("--accounts", ["approve"]);
  if (switches.has("--accounts")) invocation.accounts = true;
  if (invocation.poolDigest !== undefined) invocation.accounts = true;
  if (invocation.accounts && (invocation.planDigest !== undefined || values.has("--freeze-by")))
    throw new UsageFailure("Approve either a plan or the pool's added accounts, not both.");
  only("--close-digest", ["close"]);
  only("--go-live-digest", ["acknowledge"]);
  only("--final", ["plan"]);
  for (const flag of ["--freeze-by", "--freeze-at", "--freeze-how"]) only(flag, ["approve"]);
  if (switches.has("--final")) {
    if (invocation.review)
      throw new UsageFailure("--final makes a new plan; it cannot review an existing revision.");
    invocation.final = true;
  }
  const freezeBy = get("--freeze-by");
  const freezeAt = get("--freeze-at");
  const freezeHow = get("--freeze-how");
  if (freezeBy !== undefined || freezeAt !== undefined || freezeHow !== undefined) {
    if (
      !freezeBy?.trim() ||
      !freezeAt?.trim() ||
      !freezeHow?.trim() ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(freezeAt) ||
      !Number.isFinite(Date.parse(freezeAt))
    )
      throw new UsageFailure(
        "Freeze attestation requires --freeze-by, --freeze-at (timestamp with timezone), and --freeze-how.",
      );
    invocation.freeze = { by: freezeBy, at: freezeAt, how: freezeHow };
  }
  only("--verification-digest", ["accept"]);
  only("--reason", ["cancel"]);
  only("--note", ["accept", "acknowledge"]);
  only("--confirm", ["reclaim"]);
  only("--stop-worker", ["reclaim"]);
  only("--code", ["plan", "status", "verify", "accept"]);
  only("--mapping", ["plan", "status", "verify", "acknowledge"]);
  for (const flag of [
    "--review",
    "--view",
    "--phase",
    "--search",
    "--cursor",
    "--limit",
    "--sort",
    "--revision",
  ])
    only(flag, ["plan", "status", "verify"]);
  if (from !== undefined && output !== "jsonl")
    throw new UsageFailure("--from requires JSONL output.");
  if (command === "reclaim" && !invocation.confirm)
    throw new UsageFailure("reclaim requires --confirm after reviewing recovery facts.");
  return invocation;
}
