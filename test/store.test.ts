import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import os from "node:os";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { digestJson } from "../src/engine/store/digest.ts";
import {
  openStore,
  type CommitUnit,
  type FileCommitRow,
  type JobRecord,
  type PlanRevisionRecord,
  type Store,
} from "../src/engine/store/store.ts";
import { type RowPage, type RowQuery } from "../src/engine/types.ts";

type TestStore = Store & {
  commit(unit: CommitUnit): { applied: boolean };
  rows(query: RowQuery): RowPage;
};

function tempDir(): string {
  return mkdtempSync(join(os.tmpdir(), "migmate-store-"));
}

function mustOpen(dir: string): TestStore {
  const outcome = openStore(dir, {
    migmateVersion: "1.0.0-test",
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  if (!outcome.ok) {
    throw new Error(outcome.refusal.message);
  }

  return outcome.value as TestStore;
}

function closeStore(store: TestStore): void {
  store.close();
}

function rawDb(dbPath: string, readOnly = false): DatabaseSync {
  return new DatabaseSync(dbPath, { open: true, readOnly, enableForeignKeyConstraints: true });
}

function scalarNumber(dbPath: string, sql: string, params: SQLInputValue[] = []): number {
  const db = rawDb(dbPath, true);
  try {
    const row = db.prepare(sql).get(...params) as { value?: number; count?: number } | undefined;
    return Number(row?.value ?? row?.count ?? 0);
  } finally {
    db.close();
  }
}

function tableCount(dbPath: string, table: string): number {
  return scalarNumber(dbPath, `SELECT COUNT(*) AS count FROM ${table}`);
}

function rowPath(dbPath: string, assetSha: string): string {
  return join(dbPath, "assets", assetSha);
}

function fileRow(
  overrides: Partial<FileCommitRow> &
    Pick<
      FileCommitRow,
      "id" | "rev" | "code" | "relativePath" | "sourceDriveId" | "sourceItemId" | "mappingId"
    >,
): FileCommitRow {
  return {
    jobType: "file_migration",
    phase: "execute",
    kind: "policy_outcome",
    accepted: false,
    itemType: "file",
    size: 1,
    destinationDriveId: null,
    destinationFileId: null,
    destinationFingerprint: null,
    provenanceState: "none",
    sourceEtag: null,
    sourceFingerprint: null,
    ...overrides,
  };
}

function baseCommit(
  overrides: Partial<CommitUnit> & Pick<CommitUnit, "rev" | "phase" | "unitKey" | "checkpoint">,
): CommitUnit {
  return {
    rows: [],
    findings: [],
    ...overrides,
  };
}

function seedJob(
  store: TestStore,
  job: Partial<JobRecord> &
    Pick<JobRecord, "id" | "type" | "state" | "schemaVersion" | "migmateVersion" | "createdAt">,
): void {
  store.writeJob({
    label: null,
    planRevision: null,
    verificationRevision: null,
    lastCheckpoint: null,
    ...job,
  });
}

afterEach(() => {
  // Per-test cleanup is handled inline so failures still leave a readable temp dir path.
});

describe("store", () => {
  it("applies the same commit unit once and replays the second time", () => {
    const dir = tempDir();
    try {
      const store = mustOpen(dir);
      const commit = baseCommit({
        rev: 1,
        phase: "execute",
        unitKey: "mapping-1:item-1:attempt-1",
        checkpoint: "checkpoint-1",
        rows: [
          fileRow({
            id: "row-1",
            rev: 1,
            code: "created",
            mappingId: "mapping-1",
            sourceDriveId: "drive-1",
            sourceItemId: "item-1",
            relativePath: "docs/a.txt",
          }),
        ],
      });

      const first = store.commit(commit);
      const second = store.commit(commit);
      assert.equal(first.applied, true);
      assert.equal(second.applied, false);
      const dbPath = join(dir, "state.db");
      assert.equal(tableCount(dbPath, "item"), 1);
      assert.equal(tableCount(dbPath, "event"), 1);
      assert.equal(tableCount(dbPath, "commit_log"), 1);
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a failed commit without leaving durable traces", () => {
    const dir = tempDir();
    try {
      const store = mustOpen(dir);
      const failing = baseCommit({
        rev: 2,
        phase: "execute",
        unitKey: "mapping-1:item-2:attempt-1",
        checkpoint: "checkpoint-fail",
        rows: [
          fileRow({
            id: "row-ok",
            rev: 2,
            code: "created",
            mappingId: "mapping-1",
            sourceDriveId: "drive-1",
            sourceItemId: "item-2",
            relativePath: "docs/ok.txt",
          }),
          fileRow({
            id: "row-bad",
            rev: 2,
            code: "created",
            mappingId: "mapping-1",
            sourceDriveId: "drive-1",
            sourceItemId: "item-2",
            relativePath: "docs/bad.txt",
            provenanceState: "invalid" as never,
          }),
        ],
        watermark: { unitKey: "mapping-1:item-2:attempt-1", value: "watermark-1" },
      });

      assert.throws(() => store.commit(failing));
      const dbPath = join(dir, "state.db");
      assert.equal(tableCount(dbPath, "item"), 0);
      assert.equal(tableCount(dbPath, "event"), 0);
      assert.equal(tableCount(dbPath, "commit_log"), 0);
      assert.equal(tableCount(dbPath, "watermark"), 0);
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores assets at the content-addressed path and never references staging in committed rows", () => {
    const dir = tempDir();
    try {
      const store = mustOpen(dir);
      const stagedDir = join(dir, "assets", ".staging");
      const bytes = Buffer.from("asset-bytes-1", "utf8");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const stagedPath = join(stagedDir, "asset-1.bin");
      writeFileSync(stagedPath, bytes);

      const commit = baseCommit({
        rev: 3,
        phase: "execute",
        unitKey: "mapping-2:item-3:attempt-1",
        checkpoint: "checkpoint-asset",
        rows: [
          fileRow({
            id: "row-asset",
            rev: 3,
            code: "created",
            mappingId: "mapping-2",
            sourceDriveId: "drive-2",
            sourceItemId: "item-3",
            relativePath: "docs/asset.txt",
          }),
        ],
        assets: [
          {
            id: "asset-1",
            conversationId: null,
            sourceKind: "attachment",
            stagedPath,
            sha256,
            size: bytes.length,
            retrievedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      });

      const receipt = store.commit(commit);
      assert.equal(receipt.applied, true);
      const assetDbPath = join(dir, "state.db");
      const db = rawDb(assetDbPath, true);
      try {
        const asset = db
          .prepare("SELECT path, sha256, size FROM asset WHERE id = ?")
          .get("asset-1") as { path: string; sha256: string; size: number } | undefined;
        assert.ok(asset);
        assert.equal(asset.sha256, sha256);
        assert.equal(asset.size, bytes.length);
        assert.equal(asset.path, `assets/${sha256}`);
        assert.equal(asset.path.includes(".staging"), false);
      } finally {
        db.close();
      }
      const finalPath = join(dir, "assets", sha256);
      assert.equal(existsSync(finalPath), true);
      assert.equal(existsSync(stagedPath), false);
      assert.equal(createHash("sha256").update(readFileSync(finalPath)).digest("hex"), sha256);
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps facets stable across pages for filtered queries", () => {
    const dir = tempDir();
    try {
      const store = mustOpen(dir);
      seedJob(store, {
        id: "job-facets",
        type: "file_migration",
        state: "executing",
        schemaVersion: 1,
        migmateVersion: "1.0.0-test",
        createdAt: "2026-09-01T00:00:00.000Z",
        planRevision: 4,
        verificationRevision: null,
        lastCheckpoint: null,
      });
      const commit = baseCommit({
        rev: 4,
        phase: "execute",
        unitKey: "mapping-3:item-facets:attempt-1",
        checkpoint: "checkpoint-facets",
        rows: [
          fileRow({
            id: "row-a",
            rev: 4,
            code: "created",
            mappingId: "mapping-3",
            sourceDriveId: "drive-3",
            sourceItemId: "a",
            relativePath: "a.txt",
          }),
          fileRow({
            id: "row-b",
            rev: 4,
            code: "updated",
            mappingId: "mapping-3",
            sourceDriveId: "drive-3",
            sourceItemId: "b",
            relativePath: "b.txt",
          }),
          fileRow({
            id: "row-c",
            rev: 4,
            code: "created",
            mappingId: "mapping-3",
            sourceDriveId: "drive-3",
            sourceItemId: "c",
            relativePath: "c.txt",
          }),
        ],
      });
      store.commit(commit);

      const page1 = store.rows({
        phase: "execute",
        revision: 4,
        codes: ["created", "updated"],
        sort: "natural",
        limit: 1,
      });
      assert.equal(page1.totalRows, 3);
      assert.deepEqual(page1.facets, [
        { code: "created", kind: "policy_outcome", count: 2 },
        { code: "updated", kind: "policy_outcome", count: 1 },
      ]);
      assert.equal(page1.rows.length, 1);
      assert.ok(page1.nextCursor);
      const nextCursor = page1.nextCursor;
      assert.ok(nextCursor);
      const page2 = store.rows({
        phase: "execute",
        revision: 4,
        codes: ["created", "updated"],
        sort: "natural",
        limit: 1,
        cursor: nextCursor,
      });
      assert.deepEqual(page2.facets, page1.facets);
      assert.equal(page2.totalRows, 3);
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pages every row exactly once with the returned cursor", () => {
    const dir = tempDir();
    try {
      const store = mustOpen(dir);
      seedJob(store, {
        id: "job-page",
        type: "file_migration",
        state: "executing",
        schemaVersion: 1,
        migmateVersion: "1.0.0-test",
        createdAt: "2026-09-01T00:00:00.000Z",
        planRevision: 5,
        verificationRevision: null,
        lastCheckpoint: null,
      });
      const rows = ["a", "b", "c", "d", "e"].map((letter, index) =>
        fileRow({
          id: `row-${letter}`,
          rev: 5,
          code: "created",
          mappingId: "mapping-4",
          sourceDriveId: "drive-4",
          sourceItemId: letter,
          relativePath: `${letter}.txt`,
          size: index + 1,
        }),
      );
      store.commit(
        baseCommit({
          rev: 5,
          phase: "execute",
          unitKey: "mapping-4:item-page:attempt-1",
          checkpoint: "checkpoint-page",
          rows,
        }),
      );

      const seen = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const page =
          cursor === undefined
            ? store.rows({ phase: "execute", revision: 5, sort: "natural", limit: 2 })
            : store.rows({ phase: "execute", revision: 5, sort: "natural", limit: 2, cursor });
        for (const row of page.rows) {
          assert.equal(seen.has(row.id), false);
          seen.add(row.id);
        }
        if (page.nextCursor === null) {
          assert.equal(seen.size, 5);
          break;
        }
        cursor = page.nextCursor;
      }
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a read-only connection to read while a writer transaction is open", () => {
    const dir = tempDir();
    try {
      const store = mustOpen(dir);
      seedJob(store, {
        id: "job-1",
        type: "file_migration",
        state: "executing",
        schemaVersion: 1,
        migmateVersion: "1.0.0-test",
        createdAt: "2026-09-01T00:00:00.000Z",
        planRevision: 6,
        verificationRevision: null,
        lastCheckpoint: "checkpoint-live",
      });
      store.commit(
        baseCommit({
          rev: 6,
          phase: "execute",
          unitKey: "mapping-5:item-live:attempt-1",
          checkpoint: "checkpoint-live",
          rows: [
            fileRow({
              id: "row-live",
              rev: 6,
              code: "created",
              mappingId: "mapping-5",
              sourceDriveId: "drive-5",
              sourceItemId: "live",
              relativePath: "live.txt",
            }),
          ],
          progress: { unit: "items", done: 1, total: 1 },
        }),
      );
      closeStore(store);

      const dbPath = join(dir, "state.db");
      const writer = rawDb(dbPath, false);
      writer.exec("BEGIN IMMEDIATE;");
      writer.exec("UPDATE job SET last_checkpoint = 'writer-hold' WHERE id = 'job-1';");

      const reader = rawDb(dbPath, true);
      try {
        const progress = reader
          .prepare("SELECT unit, done, total FROM projection_progress WHERE unit = ?")
          .get("items") as { unit: string; done: number; total: number | null } | undefined;
        assert.ok(progress);
        assert.equal(progress.done, 1);
        const row = reader
          .prepare("SELECT relative_path FROM item WHERE rev = ? AND phase = ?")
          .get(6, "execute") as { relative_path: string } | undefined;
        assert.ok(row);
        assert.equal(row.relative_path, "live.txt");
      } finally {
        reader.close();
        writer.exec("ROLLBACK;");
        writer.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streams event cursors in order and resumes exclusively", async () => {
    const dir = tempDir();
    try {
      const store = mustOpen(dir);
      store.commit(
        baseCommit({
          rev: 7,
          phase: "execute",
          unitKey: "mapping-6:item-events-1",
          checkpoint: "checkpoint-events-1",
          rows: [
            fileRow({
              id: "row-events-1",
              rev: 7,
              code: "created",
              mappingId: "mapping-6",
              sourceDriveId: "drive-6",
              sourceItemId: "events-1",
              relativePath: "events-1.txt",
            }),
          ],
        }),
      );
      store.commit(
        baseCommit({
          rev: 7,
          phase: "execute",
          unitKey: "mapping-6:item-events-2",
          checkpoint: "checkpoint-events-2",
          rows: [
            fileRow({
              id: "row-events-2",
              rev: 7,
              code: "updated",
              mappingId: "mapping-6",
              sourceDriveId: "drive-6",
              sourceItemId: "events-2",
              relativePath: "events-2.txt",
            }),
          ],
        }),
      );

      const firstPass: number[] = [];
      for await (const event of store.events({ from: 0 })) {
        firstPass.push(event.cursor);
      }
      assert.deepEqual(firstPass, [1, 2]);
      const secondCursor = firstPass[0];
      if (secondCursor === undefined) {
        throw new Error("missing second cursor");
      }

      const secondPass: number[] = [];
      for await (const event of store.events({ from: secondCursor })) {
        secondPass.push(event.cursor);
      }
      assert.deepEqual(secondPass, [2]);
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("appends events for lease-free readers and keeps cursor order around commits", async () => {
    const dir = tempDir();
    try {
      const store = mustOpen(dir);
      const firstCursor = store.appendEvent({
        verb: "plan",
        phase: "plan",
        kind: "phase_started",
        payload: { step: "before-commit" },
      });

      const reader = rawDb(join(dir, "state.db"), true);
      try {
        const firstRow = reader
          .prepare("SELECT cursor, verb, phase, kind FROM event WHERE cursor = ?")
          .get(firstCursor) as
          { cursor: number; verb: string; phase: string; kind: string } | undefined;
        assert.ok(firstRow);
        assert.equal(firstRow.cursor, firstCursor);
        assert.equal(firstRow.verb, "plan");
        assert.equal(firstRow.phase, "plan");
      } finally {
        reader.close();
      }

      const commit = store.commit(
        baseCommit({
          rev: 8,
          phase: "execute",
          unitKey: "mapping-7:item-events:attempt-1",
          checkpoint: "checkpoint-events",
        }),
      );
      assert.equal(commit.applied, true);

      const secondCursor = store.appendEvent({
        verb: "execute",
        phase: "execute",
        kind: "terminal",
        payload: { state: "completed" },
      });

      const cursors: number[] = [];
      for await (const event of store.events({ from: 0 })) {
        cursors.push(event.cursor);
      }
      assert.equal(cursors.length, 3);
      const firstEventCursor = cursors[0];
      const middleEventCursor = cursors[1];
      const thirdEventCursor = cursors[2];
      if (
        firstEventCursor === undefined ||
        middleEventCursor === undefined ||
        thirdEventCursor === undefined
      ) {
        throw new Error("missing event cursor");
      }

      assert.equal(firstEventCursor, firstCursor);
      assert.equal(thirdEventCursor, secondCursor);
      assert.ok(firstEventCursor < middleEventCursor && middleEventCursor < thirdEventCursor);
      closeStore(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to open a newer schema version", () => {
    const dir = tempDir();
    try {
      const store = mustOpen(dir);
      seedJob(store, {
        id: "job-newer",
        type: "file_migration",
        state: "new",
        schemaVersion: 2,
        migmateVersion: "2.0.0-test",
        createdAt: "2026-09-01T00:00:00.000Z",
        planRevision: null,
        verificationRevision: null,
        lastCheckpoint: null,
      });
      closeStore(store);

      const reopened = openStore(dir, {
        migmateVersion: "1.0.0-test",
        now: () => new Date("2026-09-01T00:00:00.000Z"),
      });
      assert.equal(reopened.ok, false);
      if (reopened.ok) {
        throw new Error("expected state_version_unsupported refusal");
      }
      assert.equal(reopened.refusal.code, "state_version_unsupported");
      const dbPath = join(dir, "state.db");
      assert.equal(scalarNumber(dbPath, "SELECT schema_version AS value FROM job LIMIT 1"), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces the same plan digest for the same inputs across store instances", () => {
    const dir1 = tempDir();
    const dir2 = tempDir();
    const dir3 = tempDir();
    try {
      const inputsA = { b: "2", a: "1" };
      const inputsB = { a: "1", b: "2" };
      const changed = { a: "1", b: "3" };
      const expected = digestJson(inputsA);

      const store1 = mustOpen(dir1);
      const store2 = mustOpen(dir2);
      const store3 = mustOpen(dir3);
      const record1: PlanRevisionRecord = {
        revision: 1,
        planDigest: digestJson({ plan: inputsA }),
        inputsDigest: expected,
        createdAt: "2026-09-01T00:00:00.000Z",
        sourceInventoryAt: "2026-09-01T00:00:00.000Z",
        rowCount: 0,
        inputs: inputsA,
        evidence: { source: "store-1" },
      };
      const record2: PlanRevisionRecord = {
        revision: 1,
        planDigest: digestJson({ plan: inputsB }),
        inputsDigest: digestJson(inputsB),
        createdAt: "2026-09-01T00:00:00.000Z",
        sourceInventoryAt: "2026-09-01T00:00:00.000Z",
        rowCount: 0,
        inputs: inputsB,
        evidence: { source: "store-2" },
      };
      const record3: PlanRevisionRecord = {
        revision: 1,
        planDigest: digestJson({ plan: changed }),
        inputsDigest: digestJson(changed),
        createdAt: "2026-09-01T00:00:00.000Z",
        sourceInventoryAt: "2026-09-01T00:00:00.000Z",
        rowCount: 0,
        inputs: changed,
        evidence: { source: "store-3" },
      };

      store1.writePlanRevision(record1);
      store2.writePlanRevision(record2);
      store3.writePlanRevision(record3);

      assert.equal(
        store1.readPlanRevision(1)?.inputsDigest,
        store2.readPlanRevision(1)?.inputsDigest,
      );
      assert.equal(store1.readPlanRevision(1)?.inputsDigest, expected);
      assert.notEqual(
        store1.readPlanRevision(1)?.inputsDigest,
        store3.readPlanRevision(1)?.inputsDigest,
      );

      closeStore(store1);
      closeStore(store2);
      closeStore(store3);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
      rmSync(dir3, { recursive: true, force: true });
    }
  });
});
