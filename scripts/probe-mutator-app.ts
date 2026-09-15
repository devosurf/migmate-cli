#!/usr/bin/env node
//
// Records and proves the second Entra app the live file-route qualification
// needs: the source-write fixture mutator. The route credential stays
// read-only, and scripts/qualification/file-fixtures.ts refuses a mutator that
// shares the route's client id, so this is a separate app in the same tenant
// holding Sites.Selected plus the `write` role on exactly the source site.
//
//   node scripts/probe-mutator-app.ts --env <env-file> --client-id <app-id>
//
// Prompts for the app's client secret, stores it 0600 outside the repository,
// then proves the grant by creating and deleting a real folder under the
// source root. Pass --grant-instructions to print the site-permission request
// without doing anything.
//
// The site grant itself is a human step: it needs a delegated
// Sites.FullControl.All token, and Microsoft's first-party preauthorization
// refuses that scope to the device-code clients a script could use
// (AADSTS65002), so there is no unattended path to it.
//
// https://learn.microsoft.com/en-us/graph/api/site-post-permissions?view=graph-rest-1.0
// https://learn.microsoft.com/en-us/graph/permissions-selected-overview

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

const DISPLAY_NAME = "Migmate probe mutator";
const SECRET_NAME = "probe-mutator-client-secret.txt";

class Blocked extends Error {}

function say(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function envFile(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

async function writeEnv(path: string, updates: Record<string, string>): Promise<void> {
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0 && !Object.hasOwn(updates, line.slice(0, line.indexOf("="))));
  for (const [key, value] of Object.entries(updates)) lines.push(`${key}=${value}`);
  const staging = `${path}.${randomUUID()}`;
  await writeFile(staging, `${lines.join("\n")}\n`, { mode: 0o600 });
  await rename(staging, path);
}

/** Reads one line without echoing it, so the secret never reaches the scrollback. */
async function askSecret(prompt: string): Promise<string> {
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

async function json(response: Response): Promise<Record<string, unknown>> {
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

async function applicationToken(
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

const graphRequest =
  (token: string) =>
  async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> =>
    json(
      await fetch(`https://graph.microsoft.com${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
      }),
    );

function grantInstructions(siteId: string, clientId: string): void {
  const body = JSON.stringify(
    {
      roles: ["write"],
      grantedToIdentities: [{ application: { id: clientId, displayName: DISPLAY_NAME } }],
    },
    null,
    2,
  );
  say();
  say("Grant the write role on the source site, as an administrator:");
  say();
  say("  1. Open https://developer.microsoft.com/graph/graph-explorer and sign in.");
  say("  2. In the permissions panel, consent Sites.FullControl.All.");
  say("  3. Method POST, and this URL:");
  say();
  say(`     https://graph.microsoft.com/v1.0/sites/${siteId}/permissions`);
  say();
  say("  4. Request body:");
  say();
  for (const line of body.split("\n")) say(`     ${line}`);
  say();
  say("  5. Require HTTP 201. Then unconsent Sites.FullControl.All.");
  say();
}

const environmentPath = argument("env");
const clientId = argument("client-id");
if (!environmentPath || !clientId) {
  say("Usage: node scripts/probe-mutator-app.ts --env <env-file> --client-id <app-id>");
  say("       [--secret-file <path>] [--grant-instructions]");
  process.exit(2);
}

try {
  const environment = await envFile(environmentPath);
  const tenantId = environment.MIGMATE_TENANT_ID;
  const siteId = environment.MIGMATE_SOURCE_SITE_ID;
  const sourceDriveId = environment.MIGMATE_SOURCE_DRIVE_ID;
  const sourceItemId =
    environment.MIGMATE_PROBE_SOURCE_ITEM_ID ?? environment.MIGMATE_MAPPING_ROOT_ITEM_ID;
  const prerequisiteDirectory = environment.MIGMATE_PREREQ_DIR;
  if (!tenantId || !siteId || !sourceDriveId || !sourceItemId || !prerequisiteDirectory) {
    throw new Blocked(
      "the env file must record MIGMATE_TENANT_ID, MIGMATE_SOURCE_SITE_ID, MIGMATE_SOURCE_DRIVE_ID, a source root, and MIGMATE_PREREQ_DIR",
    );
  }
  if (clientId === environment.MIGMATE_CLIENT_ID) {
    throw new Blocked(
      "the mutator must be a different app from the read-only route app; the qualification suite refuses a shared client id",
    );
  }
  if (process.argv.includes("--grant-instructions")) {
    grantInstructions(siteId, clientId);
    process.exit(0);
  }

  const secretPath = argument("secret-file") ?? join(prerequisiteDirectory, "entra", SECRET_NAME);
  let secret = await readFile(secretPath, "utf8").then(
    (contents) => contents.replace(/\r?\n$/, ""),
    () => "",
  );
  if (secret) {
    say(`  reusing the client secret already stored at ${secretPath}`);
  } else {
    secret = await askSecret(`  Paste the ${DISPLAY_NAME} client secret value: `);
    if (!secret) throw new Blocked("no client secret was supplied");
    await mkdir(dirname(secretPath), { recursive: true, mode: 0o700 });
    await writeFile(secretPath, secret, { mode: 0o600 });
    await chmod(secretPath, 0o600);
    say(`  stored the client secret at ${secretPath}`);
  }
  if (((await stat(secretPath)).mode & 0o177) !== 0) {
    throw new Blocked(`${secretPath} must be owner-readable only (0600)`);
  }

  const token = await applicationToken(tenantId, clientId, secret).catch((error: unknown) => {
    throw new Blocked(
      `the app could not authenticate, so the secret or client id is wrong: ${String(error instanceof Error ? error.message : error)}`,
    );
  });
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  const roles = (claims.roles as string[] | undefined) ?? [];
  say(`  authenticated; granted roles: ${roles.join(", ") || "none"}`);
  if (!roles.includes("Sites.Selected")) {
    throw new Blocked(
      "the app needs the Sites.Selected application permission with admin consent before a site grant can apply",
    );
  }

  // Prove the grant instead of trusting a 201: a real folder created and
  // deleted under the source root the fixtures will use.
  const graph = graphRequest(token);
  let proven = false;
  for (let attempt = 0; attempt < 10 && !proven; attempt++) {
    if (attempt > 0) await sleep(6000);
    try {
      const folder = await graph(`/v1.0/drives/${sourceDriveId}/items/${sourceItemId}/children`, {
        method: "POST",
        body: JSON.stringify({
          name: `migmate-grant-check-${randomUUID()}`,
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      });
      await graph(`/v1.0/drives/${sourceDriveId}/items/${String(folder.id)}`, { method: "DELETE" });
      proven = true;
    } catch (error) {
      if (attempt === 9) {
        say(`  write refused: ${String(error instanceof Error ? error.message : error)}`);
        grantInstructions(siteId, clientId);
        throw new Blocked("the write role on the source site is not in effect");
      }
    }
  }
  say("  write proven: created and deleted a folder under the source root");

  await writeEnv(environmentPath, {
    MIGMATE_PROBE_MUTATOR_CLIENT_ID: clientId,
    MIGMATE_PROBE_MUTATOR_SECRET_FILE: secretPath,
  });
  say();
  say(`Recorded MIGMATE_PROBE_MUTATOR_* in ${environmentPath}.`);
  say(`Next: scripts/stage1-prereqs.sh --resume ${environmentPath}`);
} catch (error) {
  if (!(error instanceof Blocked)) throw error;
  process.stderr.write(`Blocked: ${error.message}\n`);
  process.exit(1);
}
