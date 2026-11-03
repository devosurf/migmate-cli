import { constants } from "node:fs";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCredentialIni, readCredentialFile } from "../engine/providers/credentials.ts";
import {
  beginDropboxAuthorization,
  dropboxRemoteSettings,
  loadDropboxCredential,
  type DropboxRole,
} from "../engine/providers/adapters/credentials/dropbox.ts";
import {
  decodeUtf8,
  fileReference,
  record,
  refused,
  text,
} from "../engine/providers/adapters/credentials/shared.ts";
import type { Io } from "./io.ts";

/** Only the operator-owned credential file receives OAuth secrets, never the job config. */
export async function onboardDropboxCredentials(input: {
  config: unknown;
  storeDirectory: string;
  io: Io;
  signal: AbortSignal;
}): Promise<void> {
  const config = record(input.config);
  // Source first: a write app must never be mistaken for the read-only source.
  if (config.sourceProvider === "dropbox") await onboardDropboxRole(input, "source");
  if (config.destinationProvider === "dropbox") await onboardDropboxRole(input, "destination");
}

/**
 * ADR-0018 D4: one Dropbox app is either the read-only source or a write destination.
 * Every Dropbox grant passes through creds init, so this engine-home registry sees each
 * app key before its first authorization. Only app keys and roles are kept; no secret.
 */
export async function claimDropboxApp(
  home: string,
  clientId: string,
  role: DropboxRole,
): Promise<void> {
  const path = join(home, "dropbox-app-roles.json");
  let roles: Record<string, unknown> = {};
  try {
    roles = record(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw refused("credential_config_invalid", { provider: "dropbox" });
  }
  const claimed = Object.hasOwn(roles, clientId) ? roles[clientId] : undefined;
  if (claimed === role) return;
  if (claimed !== undefined)
    throw refused("credential_permissions_invalid", {
      provider: "dropbox",
      reason:
        role === "destination" ? "destination_reuses_source_app" : "source_reuses_destination_app",
    });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...roles, [clientId]: role }, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

async function onboardDropboxRole(
  input: { config: unknown; storeDirectory: string; io: Io; signal: AbortSignal },
  role: DropboxRole,
): Promise<void> {
  const config = record(input.config);
  const rclone = record(config.rclone);
  const remote = text(role === "source" ? rclone.dropboxRemote : rclone.dropboxDestinationRemote);
  const ref = fileReference(rclone.config);
  const loaded = await readCredentialFile(ref, input.storeDirectory);
  let sections: Map<string, Map<string, string>> | undefined;
  let replacement: Buffer | undefined;
  try {
    sections = parseCredentialIni(loaded.bytes);
    const section = sections.get(remote);
    if (!section) throw refused("credential_config_invalid");
    const settings = dropboxRemoteSettings(section);
    await claimDropboxApp(input.storeDirectory, settings.clientId, role);
    if (section.has("migmate_scope_proof")) {
      const credential = loadDropboxCredential(section, role);
      credential.refreshToken.fill(0);
      return;
    }
    if (!input.io.stdin.isTTY || !input.io.stderr.isTTY)
      throw refused("credential_interaction_required", { provider: "dropbox" });
    input.signal.throwIfAborted();
    // ADR-0019: pool passes act as members, which rclone resolves with members.read.
    const pool = role === "destination" && config.actingAccounts !== undefined;
    const authorization = beginDropboxAuthorization(
      settings.clientId,
      role,
      pool ? { pool } : undefined,
    );
    await input.io.stderr.write(
      `Open this Dropbox authorization URL in your browser and approve the ${role === "source" ? "read-only team app" : "destination write app"} as a team administrator:\n${authorization.url}\nPaste the authorization code (blank cancels): `,
    );
    const code = (await input.io.stdin.readLine(input.signal))?.trim();
    if (!code || input.signal.aborted)
      throw refused("credential_authentication_failed", { provider: "dropbox" });
    const fields = await authorization.exchange(code, input.signal);
    // Preserve comments and every other remote; only this source's OAuth fields change.
    let current: string | undefined;
    const lines: string[] = [];
    for (const line of decodeUtf8(loaded.bytes).split(/\r?\n/u)) {
      const header = /^\s*\[([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]\s*$/u.exec(line);
      if (header) current = header[1];
      if (current === remote && /^\s*(token|migmate_scope_proof)\s*=/u.test(line)) continue;
      lines.push(line);
      if (header && current === remote)
        for (const [key, value] of fields) lines.push(`${key} = ${value}`);
    }
    fields.clear();
    replacement = Buffer.from(lines.join("\n"));
    // Consent can take minutes. Do not overwrite a file changed while the browser was open.
    const fresh = await readCredentialFile(ref, input.storeDirectory);
    try {
      if (fresh.path !== loaded.path || !fresh.bytes.equals(loaded.bytes))
        throw refused("credential_file_changed");
    } finally {
      fresh.bytes.fill(0);
    }
    const file = await open(
      loaded.path,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7177) !== 0 ||
        (stat.mode & 0o600) !== 0o600 ||
        stat.size !== loaded.bytes.length
      )
        throw refused("credential_file_unsafe");
      const before = await file.readFile();
      try {
        if (!before.equals(loaded.bytes)) throw refused("credential_file_changed");
      } finally {
        before.fill(0);
      }
      input.signal.throwIfAborted();
      let offset = 0;
      while (offset < replacement.length) {
        const { bytesWritten } = await file.write(
          replacement,
          offset,
          replacement.length - offset,
          offset,
        );
        if (!bytesWritten) throw refused("credential_file_unwritable");
        offset += bytesWritten;
      }
      await file.truncate(replacement.length);
      await file.sync();
    } finally {
      await file.close();
    }
  } finally {
    loaded.bytes.fill(0);
    replacement?.fill(0);
    for (const section of sections?.values() ?? []) section.clear();
    sections?.clear();
  }
}
