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
import { join } from "node:path";
import {
  applicationToken,
  argument,
  Blocked,
  envFile,
  graphRequest,
  say,
  sleep,
  storedSecret,
  tokenClaims,
  writeEnv,
} from "./prereq-lib.ts";

const DISPLAY_NAME = "Migmate probe mutator";
const SECRET_NAME = "probe-mutator-client-secret.txt";

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

  const { secret, secretPath } = await storedSecret(
    argument("secret-file") ?? join(prerequisiteDirectory, "entra", SECRET_NAME),
    `  Paste the ${DISPLAY_NAME} client secret value: `,
  );
  const token = await applicationToken(tenantId, clientId, secret).catch((error: unknown) => {
    throw new Blocked(
      `the app could not authenticate, so the secret or client id is wrong: ${String(error instanceof Error ? error.message : error)}`,
    );
  });
  const { roles } = tokenClaims(token);
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
