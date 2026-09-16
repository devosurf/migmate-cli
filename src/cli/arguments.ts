import { homedir } from "node:os";
import { isAbsolute, posix, resolve } from "node:path";
import { VERBS, type JobType, type RowQuery, type Verb } from "../engine/types.ts";

export type OutputMode = "text" | "json" | "jsonl";
export type CommandName = Verb | "creds init" | "accept" | "reclaim" | "web";
export interface Invocation {
  command: CommandName;
  output: OutputMode;
  home: string;
  jobId?: string;
  type?: JobType;
  label?: string;
  config?: string;
  approver?: string;
  planDigest?: string;
  verificationDigest?: string;
  codes: string[];
  notes: string[];
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
): string {
  if (environment.MIGMATE_HOME) return resolve(environment.MIGMATE_HOME);
  switch (platform) {
    case "darwin":
      return posix.join(home, "Library", "Application Support", "Migmate");
    case "linux":
      return posix.join(
        environment.XDG_STATE_HOME && posix.isAbsolute(environment.XDG_STATE_HOME)
          ? environment.XDG_STATE_HOME
          : posix.join(home, ".local", "state"),
        "migmate",
      );
    default:
      throw new UsageFailure("Unsupported platform.");
  }
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
  return first === "creds" && argv[1] === "init"
    ? "creds init"
    : first && !first.startsWith("-")
      ? first
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
    "--approver",
    "--plan-digest",
    "--verification-digest",
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
    "--schema-version",
  ];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("-")) {
      words.push(token);
      continue;
    }
    if (["--help", "-h", "--review", "--confirm", "--stop-worker"].includes(token)) {
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
    if (values.has(flag) && flag !== "--code" && flag !== "--note")
      throw new UsageFailure("An option was supplied more than once.");
    const prior = values.get(flag);
    if (prior) prior.push(value);
    else values.set(flag, [value]);
  }
  const help = switches.has("--help") || switches.has("-h");
  const command = words.join(" ");
  if (
    !VERBS.includes(command as Verb) &&
    !["creds init", "accept", "reclaim", "web"].includes(command) &&
    !(help && words.length === 0)
  ) {
    throw new UsageFailure("Supply a lifecycle command or creds init, accept, reclaim, or web.");
  }
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
  const invocation: Invocation = {
    command: (command || "status") as CommandName,
    output: output as OutputMode,
    home: resolve(get("--home") ?? defaultHome()),
    codes,
    notes: values.get("--note") ?? [],
    confirm: switches.has("--confirm"),
    stopWorker: switches.has("--stop-worker"),
    review: switches.has("--review") || cursor !== undefined || revision !== undefined,
    query,
    help,
  };
  if (jobId !== undefined) invocation.jobId = jobId;
  if (type !== undefined) invocation.type = type as JobType;
  const strings = {
    label: "--label",
    config: "--config",
    approver: "--approver",
    planDigest: "--plan-digest",
    verificationDigest: "--verification-digest",
    reason: "--reason",
  } as const;
  for (const [key, flag] of Object.entries(strings)) {
    const value = get(flag);
    if (value !== undefined) Object.assign(invocation, { [key]: value });
  }
  const from = integer("--from", 0);
  if (from !== undefined) invocation.from = from;
  if (help) return invocation;
  if (command === "init") {
    if (!type) throw new UsageFailure("init requires an explicit --type.");
    if (jobId) throw new UsageFailure("init generates its job id.");
  } else if (!jobId) throw new UsageFailure("This command requires --job.");
  if (command === "creds init" && !invocation.config)
    throw new UsageFailure("creds init requires --config with typed file references.");
  const only = (flag: string, allowed: string[]) => {
    if ((values.has(flag) || switches.has(flag)) && !allowed.includes(command))
      throw new UsageFailure("Option is not valid for this command.");
  };
  for (const flag of ["--type", "--label"]) only(flag, ["init"]);
  only("--config", ["init", "creds init"]);
  only("--approver", ["approve", "accept"]);
  only("--plan-digest", ["approve"]);
  only("--verification-digest", ["accept"]);
  only("--reason", ["cancel"]);
  only("--note", ["accept"]);
  only("--confirm", ["reclaim"]);
  only("--stop-worker", ["reclaim"]);
  only("--code", ["plan", "status", "verify", "accept"]);
  for (const flag of [
    "--review",
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
  if (invocation.notes.length > codes.length)
    throw new UsageFailure("Each --note needs a corresponding --code.");
  if (command === "reclaim" && !invocation.confirm)
    throw new UsageFailure("reclaim requires --confirm after reviewing recovery facts.");
  return invocation;
}
