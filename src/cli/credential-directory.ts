import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { UsageFailure } from "./arguments.ts";

/**
 * The operator's credential directory: Migmate's one default home for credential
 * files, outside every engine home, job folder and repository. The same path on
 * macOS and Linux, so operators and agents never have to choose one.
 */
export function credentialDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const override = environment.MIGMATE_CREDENTIALS_DIR;
  if (override) {
    if (!posix.isAbsolute(override))
      throw new UsageFailure("MIGMATE_CREDENTIALS_DIR must be an absolute path.");
    return posix.resolve(override);
  }
  const config =
    environment.XDG_CONFIG_HOME && posix.isAbsolute(environment.XDG_CONFIG_HOME)
      ? environment.XDG_CONFIG_HOME
      : posix.join(home, ".config");
  return posix.join(config, "migmate", "credentials");
}

/** Create the directory owner-only, or tighten an existing one the operator owns. */
export async function ensureCredentialDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.uid !== process.getuid?.())
    throw new UsageFailure(
      `Credential directory ${path} must be a directory you own, not a file or symlink.`,
    );
  if ((entry.mode & 0o777) !== 0o700) await chmod(path, 0o700);
  return path;
}

// A credential name is a relative path of plain segments: no `..`, no hidden or
// shell-expanded parts, so it can only ever name a file inside the directory.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;

function isReference(value: unknown): value is { resolver: "file"; path: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).resolver === "file" &&
    typeof (value as Record<string, unknown>).path === "string"
  );
}

function named(value: unknown): boolean {
  if (isReference(value)) return NAME.test(value.path) && value.path.length <= 1024;
  if (Array.isArray(value)) return value.some(named);
  if (typeof value === "object" && value !== null) return Object.values(value).some(named);
  return false;
}

function expand(value: unknown, directory: string): unknown {
  if (isReference(value) && NAME.test(value.path))
    return { ...value, path: posix.join(directory, value.path) };
  if (Array.isArray(value)) return value.map((entry) => expand(entry, directory));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expand(entry, directory)]),
    );
  return value;
}

/**
 * A file reference may name a credential by a short relative name, such as
 * `rclone.conf`, instead of an absolute path. Expand those names into the credential
 * directory before the engine sees the config, so the job folder records only
 * absolute paths and resolves the same file on every later command. Any other
 * relative path is left for the engine to refuse as before.
 */
export async function expandCredentialNames(
  config: unknown,
  directory: () => string = () => credentialDirectory(),
): Promise<unknown> {
  if (!named(config)) return config;
  return expand(config, await ensureCredentialDirectory(directory()));
}
