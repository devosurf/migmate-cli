#!/usr/bin/env node
//
// Shared machinery for the live-test prerequisite probers.
//
// Both probers do the same four things against a real tenant — read an
// operator-owned env file, take a client secret without echoing it, acquire an
// application-only Graph token, and report a refusal an operator can act on —
// so those live here rather than in two copies that can drift.
//
// Nothing here writes a secret anywhere but the operator-chosen 0600 file the
// caller names, and `Blocked` carries an operator sentence, never a token.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

/** A prerequisite an operator must fix. Callers print the message and exit 1. */
export class Blocked extends Error {}

export function say(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

export function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Splits at the first `=` and never evaluates the file, so a value containing
 *  shell metacharacters is data rather than a command. */
export async function envFile(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

export async function writeEnv(path: string, updates: Record<string, string>): Promise<void> {
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0 && !Object.hasOwn(updates, line.slice(0, line.indexOf("="))));
  for (const [key, value] of Object.entries(updates)) lines.push(`${key}=${value}`);
  const staging = `${path}.${randomUUID()}`;
  await writeFile(staging, `${lines.join("\n")}\n`, { mode: 0o600 });
  await rename(staging, path);
}

/** Reads one line without echoing it, so the secret never reaches the scrollback. */
export async function askSecret(prompt: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const input = process.stdin;
  const reader = createInterface({ input, output: process.stdout, terminal: true });
  process.stdout.write(prompt);
  const muted = input.isTTY === true;
  if (muted) {
    // @ts-expect-error -- readline's output muting is not in the public types.
    reader.output.write = () => true;
  }
  reader.question("", (answer) => {
    if (muted) process.stdout.write("\n");
    reader.close();
    resolve(answer.trim());
  });
  return promise;
}

/**
 * Reuses an already-stored secret, otherwise prompts for one and stores it
 * 0600. Returns the secret and the path holding it. Refuses a file any other
 * user or a group could read, because the engine's credential loader does too.
 */
export async function storedSecret(
  secretPath: string,
  prompt: string,
): Promise<{ secret: string; secretPath: string }> {
  let secret = await readFile(secretPath, "utf8").then(
    (contents) => contents.replace(/\r?\n$/, ""),
    () => "",
  );
  if (secret) {
    say(`  reusing the client secret already stored at ${secretPath}`);
  } else {
    secret = await askSecret(prompt);
    if (!secret) throw new Blocked("no client secret was supplied");
    await mkdir(dirname(secretPath), { recursive: true, mode: 0o700 });
    await writeFile(secretPath, secret, { mode: 0o600 });
    await chmod(secretPath, 0o600);
    say(`  stored the client secret at ${secretPath}`);
  }
  if (((await stat(secretPath)).mode & 0o177) !== 0) {
    throw new Blocked(`${secretPath} must be owner-readable only (0600)`);
  }
  return { secret, secretPath };
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  const body = response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>);
  if (!response.ok) {
    const error = body.error as Record<string, unknown> | string | undefined;
    const message =
      typeof error === "string"
        ? `${error}: ${String(body.error_description).split("\n")[0]}`
        : String((error as Record<string, unknown>)?.message ?? response.statusText);
    throw new Blocked(`${response.status}: ${message}`);
  }
  return body;
}

export async function applicationToken(
  tenantId: string,
  clientId: string,
  secret: string,
): Promise<string> {
  const body = await json(
    await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: secret,
        scope: "https://graph.microsoft.com/.default",
      }),
    }),
  );
  return String(body.access_token);
}

/**
 * The granted roles and identity claims the token itself carries. This is
 * evidence from a fresh token response, exactly what the engine's credential
 * loader inspects, not a local authorization decision.
 */
export function tokenClaims(token: string): {
  roles: string[];
  applicationOnly: boolean;
} {
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  return {
    roles: [...new Set((claims.roles as string[] | undefined) ?? [])].sort(),
    applicationOnly: claims.idtyp === "app" && claims.scp === undefined,
  };
}

export const graphRequest =
  (token: string) =>
  async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> =>
    json(
      await fetch(path.startsWith("https://") ? path : `https://graph.microsoft.com${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
      }),
    );

/**
 * Follows `@odata.nextLink` to exhaustion, which is the completeness assertion
 * the collector makes. The Teams export routes return a continuation even on a
 * page that already holds every record, so a caller cannot stop at the first
 * page and call the scope collected.
 */
export async function pages(
  graph: (path: string, init?: RequestInit) => Promise<Record<string, unknown>>,
  first: string,
  limit = 50,
): Promise<{ records: Record<string, unknown>[]; pageCount: number }> {
  const records: Record<string, unknown>[] = [];
  let next: string | undefined = first;
  let pageCount = 0;
  while (next !== undefined) {
    const body = await graph(next);
    records.push(...((body.value as Record<string, unknown>[] | undefined) ?? []));
    pageCount += 1;
    const link = body["@odata.nextLink"];
    next = typeof link === "string" ? link : undefined;
    if (pageCount > limit) throw new Blocked(`the export page chain did not terminate: ${first}`);
  }
  return { records, pageCount };
}
