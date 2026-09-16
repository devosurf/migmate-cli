import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProductionProvider } from "./production.ts";
import { ProviderFault } from "./credentials.ts";
import { digestJson } from "../store/digest.ts";

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

test(
  "the published local archive bundle still validates but cannot qualify a Shared Drive destination",
  { skip: process.platform !== "darwin" || process.arch !== "arm64" },
  async (t) => {
    const jobDirectory = await mkdtemp(join(tmpdir(), "migmate-archive-route-"));
    t.after(() => rm(jobDirectory, { recursive: true, force: true }));
    const tupleDigest = "6aa55648a2a150d62bd7f7abbf1d2599c93b5c069d905b1df82ab14a95e1f103";
    const digest = "e6a5d2d8fa14fc6e5c65b119105fa27555594831abf3c97476c553f3508e71a9";
    const config = {
      scopes: [
        { kind: "team", teamId: "team-id" },
        { kind: "user-chats", userId: "user-id" },
      ],
      qualification: { bundle: `qualification/${tupleDigest}/${digest}`, digest },
    };
    const local = createProductionProvider({ jobType: "teams_archive", jobDirectory, config });
    t.after(() => local.close?.());
    const evidence = await local.qualificationEvidence!();
    assert.equal(digestJson(evidence.tuple), tupleDigest);
    assert.equal(evidence.digest, digest);
    const remote = createProductionProvider({
      jobType: "teams_archive",
      jobDirectory,
      config: {
        ...config,
        destination: { destDriveId: "0ABCsharedDrive", destFolderId: "1XYZarchiveFolder" },
      },
    });
    t.after(() => remote.close?.());
    await assert.rejects(remote.qualificationEvidence!(), {
      code: "unqualified_route",
    });
  },
);
