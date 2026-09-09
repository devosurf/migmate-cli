/**
 * The commit vocabulary: the one shape a job-type driver yields and the store
 * writes. It lives here rather than in either module because both sides must
 * agree on it exactly — two near-identical copies drifted apart once already,
 * and the divergence only surfaced at integration.
 *
 * A driver yields; the engine writes. Nothing here can hold a preauthenticated
 * URL: a `DurableAsset` is a local path plus a digest, so a resumed run
 * re-resolves by identity rather than replaying a link that has already expired.
 */

import type { CodeKind, ProgressUnit, RowPhase } from "./types.ts";
import type { FileState, FileSourceEvidence, FileScope } from "./drivers/file-state.ts";
import type {
  ArchivePlan,
  ArchiveRecord,
  ArchiveCollectionEvidence,
  ArchivePackageFile,
} from "./providers/archive.ts";

export interface CommitRowBase {
  id: string;
  rev: number;
  phase: RowPhase;
  code: string;
  kind: CodeKind;
  accepted?: boolean;
}

export interface FileCommitRow extends CommitRowBase {
  jobType: "file_migration";
  mappingId: string;
  sourceDriveId: string;
  sourceItemId: string;
  relativePath: string;
  itemType: "file" | "folder";
  size: number | null;
  sourceEtag?: string | null;
  sourceFingerprint?: string | null;
  destinationDriveId?: string | null;
  destinationFileId?: string | null;
  destinationFingerprint?: string | null;
  provenanceState?: "none" | "marked" | "verified" | "drifted";
  fileState?: FileState;
  sourceEvidence?: FileSourceEvidence;
  fileScope?: FileScope;
}

export interface ConversationCommitRow extends CommitRowBase {
  jobType: "teams_archive";
  scopeEntryId: string;
  conversationId: string;
  title?: string | null;
  records: number;
  assets: number;
  watermark?: string | null;
}

export type CommitRow = FileCommitRow | ConversationCommitRow;

export interface CommitFinding {
  rev: number;
  phase: RowPhase;
  code: string;
  kind: CodeKind;
  subjectKind: string;
  subjectId: string;
  evidence: Record<string, unknown>;
  at: string;
}

/** A local path plus digest. Bytes are durable before the transaction opens. */
export interface DurableAsset {
  id: string;
  conversationId: string | null;
  sourceKind: "hosted_content" | "attachment" | "transcript";
  stagedPath: string;
  sha256: string;
  size: number;
  retrievedAt: string;
  archivePath?: string;
}

export interface CommitUnit {
  rev: number;
  phase: RowPhase;
  /**
   * Stable across restarts, which is what makes replay free. File migration:
   * `${mappingId}:${sourceItemId}:${attemptClass}`. Archive:
   * `${scopeEntryId}:${route}:${pageCursor}`.
   */
  unitKey: string;
  checkpoint: string;
  rows: CommitRow[];
  findings: CommitFinding[];
  assets?: DurableAsset[];
  watermark?: { unitKey: string; value: string };
  progress?: { unit: ProgressUnit; done: number; total: number | null };
  /** Verification idempotence is scoped to a fresh durable run, not just a plan. */
  verificationRun?: number;
  archivePlan?: ArchivePlan;
  archiveRecords?: ArchiveRecord[];
  archiveEvidence?: ArchiveCollectionEvidence;
  archiveFiles?: ArchivePackageFile[];
  archiveManifestDigest?: string;
}

export interface CommitReceipt {
  /** False when the unit key was already present: the commit was a durable no-op. */
  applied: boolean;
}
