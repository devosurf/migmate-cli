import { chmod, lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ProviderFault } from "./credentials.ts";

/**
 * sockaddr_un limits the spelling passed to connect, not the target inode's path.
 * A temporary owner-only alias keeps the real socket inside its private run dir.
 * The alias disappears after connection establishment; an open socket needs no path.
 */
export async function withSocketPath<T>(
  socketPath: string,
  connect: (path: string) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(socketPath))
    throw new ProviderFault(
      "recovery_required",
      "A worker socket requires an absolute recorded identity.",
    );
  const limit = process.platform === "darwin" ? 103 : 107;
  if (Buffer.byteLength(socketPath) <= limit) return connect(socketPath);
  let alias: string | undefined;
  try {
    const parent = await realpath(dirname(socketPath));
    const metadata = await lstat(parent);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      typeof process.getuid !== "function" ||
      metadata.uid !== process.getuid() ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new ProviderFault(
        "recovery_required",
        "The worker socket directory is not private to this operator.",
      );
    }
    // os.tmpdir() itself can exceed sun_path on macOS. /tmp is the Unix short
    // namespace; mkdtemp plus 0700 protects the alias from other local users.
    const temporaryRoot = await lstat(await realpath("/tmp"));
    if (
      !temporaryRoot.isDirectory() ||
      ((temporaryRoot.mode & 0o077) !== 0 && (temporaryRoot.mode & 0o1000) === 0)
    ) {
      throw new ProviderFault(
        "recovery_required",
        "The short Unix temporary namespace is not protected.",
      );
    }
    alias = await mkdtemp("/tmp/migmate-socket-");
    await chmod(alias, 0o700);
    const aliasInfo = await lstat(alias);
    if (
      aliasInfo.uid !== process.getuid() ||
      (aliasInfo.mode & 0o077) !== 0 ||
      !aliasInfo.isDirectory() ||
      aliasInfo.isSymbolicLink()
    ) {
      throw new ProviderFault(
        "recovery_required",
        "A private worker socket alias could not be established.",
      );
    }
    await symlink(parent, join(alias, "run"), "dir");
    const short = join(alias, "run", basename(socketPath));
    if (Buffer.byteLength(short) > limit)
      throw new ProviderFault(
        "recovery_required",
        "The worker socket name cannot be represented without truncation.",
      );
    return await connect(short);
  } catch (error) {
    if (error instanceof ProviderFault) throw error;
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new ProviderFault("provider_failed", "The worker socket is absent.", {
        reason: "worker_unreachable",
      });
    }
    throw new ProviderFault(
      "recovery_required",
      "The private worker socket connection could not be established.",
    );
  } finally {
    if (alias)
      await rm(alias, { recursive: true, force: true }).catch(() => {
        throw new ProviderFault(
          "recovery_required",
          "The private worker socket alias could not be removed.",
        );
      });
  }
}
