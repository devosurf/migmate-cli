import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseCredentialIni, readCredentialFile } from "../engine/providers/credentials.ts";
import {
  beginDropboxAuthorization,
  dropboxRemoteSettings,
  loadDropboxCredential,
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
  if (config.sourceProvider !== "dropbox") return;
  const rclone = record(config.rclone);
  const remote = text(rclone.dropboxRemote);
  const ref = fileReference(rclone.config);
  const loaded = await readCredentialFile(ref, input.storeDirectory);
  let sections: Map<string, Map<string, string>> | undefined;
  let replacement: Buffer | undefined;
  try {
    sections = parseCredentialIni(loaded.bytes);
    const section = sections.get(remote);
    if (!section) throw refused("credential_config_invalid");
    const settings = dropboxRemoteSettings(section);
    if (section.has("migmate_scope_proof")) {
      const credential = loadDropboxCredential(section);
      credential.refreshToken.fill(0);
      return;
    }
    if (!input.io.stdin.isTTY || !input.io.stderr.isTTY)
      throw refused("credential_interaction_required", { provider: "dropbox" });
    input.signal.throwIfAborted();
    const authorization = beginDropboxAuthorization(settings.clientId);
    await input.io.stderr.write(
      `Open this Dropbox authorization URL in your browser and approve the read-only team app as a team administrator:\n${authorization.url}\nPaste the authorization code (blank cancels): `,
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
