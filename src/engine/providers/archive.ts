import type { CheckResult } from "../types.ts";
import type { CommitFinding, CommitUnit, DurableAsset } from "../commit.ts";
import type { DriverContext } from "../drivers/types.ts";

export type ArchiveScope =
  | { kind: "channel"; teamId: string; channelId: string }
  | { kind: "team"; teamId: string }
  | { kind: "user-chats"; userId: string };
export interface ArchiveConfig {
  scopes: ArchiveScope[];
  cloud: "Global";
  retainedHistory: boolean;
  transcripts: boolean;
  attachmentBytes: boolean;
  timezone: string;
  window: { from: string; to?: string };
  lineage?: { jobId: string; reportDigest: string; to: string };
}
export interface ArchiveConversation {
  id: string;
  kind: "channel" | "chat";
  title: string;
  scopeEntryId: string;
  participantScopeIds: string[];
  teamId?: string;
  channelId?: string;
  ownerUserId?: string;
  membershipType?: string;
  chatType?: string;
  /** Original Graph conversation metadata, without transport/download credentials. */
  raw: Record<string, unknown>;
}
export type ArchiveRoute = "messages" | "retained" | "transcripts";
export interface ArchiveScopeBinding {
  id: string;
  kind: "channel" | "user-chats";
  teamId?: string;
  channelId?: string;
  userId?: string;
  conversationIds: string[];
}
export interface ArchivePlan {
  version: 1;
  window: { from: string; to: string };
  timezone: string;
  scopes: ArchiveScopeBinding[];
  conversations: ArchiveConversation[];
  config: ArchiveConfig;
}
export interface ArchiveAssetReference {
  id: string;
  sourceKind: "hosted_content" | "attachment" | "transcript";
  name: string;
  /** Original stable reference URL only; never a download URL. */
  sourceUrl?: string;
  sha256: string;
  size: number;
  retrievedAt: string;
  /** Relative to archive/, including conversation directory. */
  path: string;
}
export interface ArchiveRecord {
  key: string;
  conversationId: string;
  messageId: string;
  createdDateTime: string;
  route: ArchiveRoute;
  raw: Record<string, unknown>;
  assets: ArchiveAssetReference[];
  findings: { code: string; evidence: Record<string, unknown> }[];
}
export interface ArchivePage {
  records: Record<string, unknown>[];
  nextLink: string | null;
  deltaLink?: string;
}
export interface ArchiveAssetRequest {
  conversation: ArchiveConversation;
  record: Record<string, unknown>;
  route: ArchiveRoute;
  kind: "hosted_content" | "attachment" | "transcript";
  id: string;
  name: string;
  sourceUrl?: string;
}
export interface ArchiveProvider {
  expand(config: ArchiveConfig, signal?: AbortSignal): Promise<{ scopes: ArchiveScopeBinding[]; conversations: ArchiveConversation[] }>;
  preflight(config: ArchiveConfig, plan: ArchivePlan, signal?: AbortSignal): AsyncIterable<CheckResult>;
  page(input: { scope: ArchiveScopeBinding; route: ArchiveRoute; window: ArchivePlan["window"]; cursor: string | null; signal?: AbortSignal }): Promise<ArchivePage>;
  transcriptConversationId(record: Record<string, unknown>, scope: ArchiveScopeBinding, conversations: ArchiveConversation[], signal?: AbortSignal): Promise<string | null>;
  assetRequests(conversation: ArchiveConversation, record: Record<string, unknown>, route: ArchiveRoute, config: ArchiveConfig, signal?: AbortSignal): AsyncIterable<ArchiveAssetRequest>;
  openAsset(request: ArchiveAssetRequest, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}
export interface ArchiveCollectionEvidence {
  scopeEntryId: string;
  route: ArchiveRoute;
  cursor: string | null;
  nextLink: string | null;
  complete: boolean;
  recordKeys: string[];
  findingCodes: string[];
}
export interface ArchivePackageFile {
  /** Safe relative path under archive/. Engine writes atomically, never driver. */
  path: string;
  content: string;
  sha256: string;
}
export interface ArchiveDurableAsset extends DurableAsset {
  /** Safe relative path under archive/. Engine durably installs before the transaction. */
  archivePath: string;
}
export interface ArchiveCommit extends CommitUnit {
  archivePlan?: ArchivePlan;
  archiveRecords?: ArchiveRecord[];
  archiveEvidence?: ArchiveCollectionEvidence;
  archiveFiles?: ArchivePackageFile[];
  archiveManifestDigest?: string;
  assets?: ArchiveDurableAsset[];
}
export interface ArchiveResumeState {
  archivePlan?: ArchivePlan;
  archiveRecords?: ArchiveRecord[];
  archiveEvidence?: ArchiveCollectionEvidence[];
  archiveManifestDigest?: string;
  committedUnits?: string[];
}
export type ArchiveDriverContext = DriverContext<ArchiveConfig> & {
  jobDirectory?: string;
  provider: DriverContext<ArchiveConfig>["provider"] & { archive?: ArchiveProvider };
  resume: DriverContext<ArchiveConfig>["resume"] & ArchiveResumeState;
};
export interface ArchivePackageInput {
  plan: ArchivePlan;
  records: ArchiveRecord[];
  evidence: ArchiveCollectionEvidence[];
}
export interface ArchivePackageResult {
  files: ArchivePackageFile[];
  manifestDigest: string;
  findings: { code: string; subjectId: string; evidence: Record<string, unknown> }[];
}
export type ArchiveVerificationFinding = Pick<CommitFinding, "code" | "subjectId" | "evidence">;

export class ArchiveEffectError extends Error {
  code: string;
  status: number | undefined;
  constructor(code: string, status?: number) {
    super(code);
    this.name = "ArchiveEffectError";
    this.code = code;
    this.status = status;
  }
}
