import assert from "node:assert/strict";
import type { Engine, JobRef, Outcome } from "../src/engine/index.ts";
import type { FakeFileMigrationFixture } from "../src/engine/providers/fake.ts";
import type { FileMigrationConfig } from "../src/engine/drivers/file-migration.ts";

export function value<T>(outcome: Outcome<T>): T {
  assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.refusal.code);
  return outcome.value;
}

export function fileFixture(
  sourceItems: FakeFileMigrationFixture["sourceItems"] = [],
): FakeFileMigrationFixture {
  return {
    sourceDriveId: "source-drive",
    sourceRootId: "source-root",
    destinationDriveId: "destination-drive",
    destinationRootId: "destination-root",
    sourceItems: [
      { id: "source-root", parentId: null, name: "Do not wrap this root", kind: "folder" },
      ...sourceItems,
    ],
    destinationItems: [
      { id: "destination-root", parentId: null, name: "existing", kind: "folder" },
    ],
  };
}

export function fileConfig(
  exclusions: Array<{ sourceItemId: string; reason: string }> = [],
): FileMigrationConfig {
  return {
    mappings: [
      {
        id: "mapping",
        sourceDriveId: "source-drive",
        sourceItemId: "source-root",
        destDriveId: "destination-drive",
        destFolderId: "destination-root",
        exclusions,
      },
    ],
  };
}

export async function approve(h: { engine: Engine; ref: JobRef }): Promise<string> {
  return value(
    await h.engine.withWriter(h.ref, async (writer) => {
      const plan = value(await writer.plan());
      value(
        await writer.approve({
          approver: "engine-contract-test",
          mode: "unattended",
          planDigest: plan.planDigest,
        }),
      );
      return plan.planDigest;
    }),
  );
}

/** Capture current reviewed evidence once; recovery deliberately supplies no new decision. */
export async function closeDecision(h: { engine: Engine; ref: JobRef }) {
  const review = value(await h.engine.reader(h.ref).status()).closeReview;
  return review && !review.authorized
    ? {
        evidenceDigest: review.evidenceDigest,
        approver: "engine-contract-test",
        mode: "unattended" as const,
      }
    : undefined;
}
