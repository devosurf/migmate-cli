import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProductionProvider } from "./production.ts";
import { ProviderFault } from "./credentials.ts";

test("production never manufactures route qualification when captured evidence is absent", async (t) => {
  const jobDirectory = await mkdtemp(join(tmpdir(), "migmate-unqualified-"));
  t.after(() => rm(jobDirectory, { recursive: true, force: true }));
  const provider = createProductionProvider({
    jobType: "file_migration",
    jobDirectory,
    config: {
      mappings: [
        {
          id: "mapping",
          sourceDriveId: "library",
          sourceItemId: "root",
          destDriveId: "shared-drive",
          destFolderId: "folder",
        },
      ],
    },
  });
  t.after(() => provider.close?.());
  await assert.rejects(
    provider.qualificationEvidence!(),
    (error: unknown) => error instanceof ProviderFault && error.code === "unqualified_route",
  );
});

test("an operator-supplied successful-looking route claim is not an immutable evidence bundle", async (t) => {
  const jobDirectory = await mkdtemp(join(tmpdir(), "migmate-forged-route-"));
  t.after(() => rm(jobDirectory, { recursive: true, force: true }));
  const provider = createProductionProvider({
    jobType: "file_migration",
    jobDirectory,
    config: {
      qualification: {
        bundle: "../../operator-claim.json",
        digest: "a".repeat(64),
        passed: true,
        probes: { collision_matrix: "pass" },
      },
    },
  });
  t.after(() => provider.close?.());
  await assert.rejects(
    provider.qualificationEvidence!(),
    (error: unknown) => error instanceof ProviderFault && error.code === "unqualified_route",
  );
});
