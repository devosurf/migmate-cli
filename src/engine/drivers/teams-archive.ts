import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, statfs, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CheckResult, CodeKind, RowPhase } from "../types.ts";
import type { CommitFinding, ConversationCommitRow } from "../commit.ts";
import type { ReportSection } from "./types.ts";
import { hasRetryAfter } from "../providers/port.ts";
import {
  ArchiveEffectError,
  type ArchiveAssetRequest, type ArchiveCollectionEvidence, type ArchiveCommit,
  type ArchiveConfig, type ArchiveConversation, type ArchiveDriverContext,
  type ArchiveDurableAsset, type ArchivePlan, type ArchiveProvider,
  type ArchiveRecord, type ArchiveRoute, type ArchiveScopeBinding,
} from "../providers/archive.ts";
import { parseArchiveConfig } from "../archive/config.ts";
import { analyzeRecord, assetPath, buildArchivePackage, verifyArchivePackage } from "../archive/package.ts";
import { canonicalJson } from "../store/digest.ts";

export { parseArchiveConfig } from "../archive/config.ts";
export type { ArchiveConfig } from "../providers/archive.ts";

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function provider(ctx: ArchiveDriverContext): ArchiveProvider {
  if (!ctx.provider.archive) throw new ArchiveEffectError("archive_provider_unavailable");
  return ctx.provider.archive;
}
function directory(ctx: ArchiveDriverContext): string {
  if (!ctx.jobDirectory) throw new Error("Archive driver requires engine-owned jobDirectory");
  return ctx.jobDirectory;
}
function checkAbort(ctx: ArchiveDriverContext): void { ctx.signal?.throwIfAborted(); }
function finding(ctx: ArchiveDriverContext, phase: RowPhase, code: string, subjectId: string, evidence: Record<string, unknown>, kind: CodeKind = "finding"): CommitFinding {
  return { rev: ctx.revision, phase, code, kind, subjectKind: "conversation", subjectId, evidence, at: ctx.now().toISOString() };
}
function row(ctx: ArchiveDriverContext, phase: RowPhase, conversation: ArchiveConversation, records: ArchiveRecord[], code = "collected"): ConversationCommitRow {
  const owned = records.filter((record) => record.conversationId === conversation.id);
  return { id: `${phase}:${digest(conversation.id)}`, rev: ctx.revision, phase, code, kind: "policy_outcome", jobType: "teams_archive", scopeEntryId: conversation.scopeEntryId, conversationId: conversation.id, title: conversation.title, records: owned.length, assets: new Set(owned.flatMap((record) => record.assets.map((asset) => asset.path))).size };
}
function commit(ctx: ArchiveDriverContext, phase: RowPhase, key: string): ArchiveCommit {
  return { rev: ctx.revision, phase, unitKey: `archive:${ctx.revision}:${phase}:${key}`, checkpoint: `archive:${phase}:${key}`, rows: [], findings: [] };
}
function routes(plan: ArchivePlan, scope: ArchiveScopeBinding): ArchiveRoute[] {
  const result: ArchiveRoute[] = ["messages"];
  const privateChannel = scope.kind === "channel" && plan.conversations.some((conversation) => conversation.channelId === scope.channelId && conversation.teamId === scope.teamId && conversation.membershipType === "private");
  if (plan.config.retainedHistory && !privateChannel) result.push("retained");
  if (plan.config.transcripts && scope.kind === "user-chats") result.push("transcripts");
  return result;
}
function watermarkKey(scope: ArchiveScopeBinding, route: ArchiveRoute): string { return `archive:${scope.id}:${route}`; }
async function expandPlan(ctx: ArchiveDriverContext): Promise<ArchivePlan> {
  const config = parseArchiveConfig(ctx.config);
  const window = { from: config.window.from, to: config.window.to ?? ctx.now().toISOString() };
  if (window.from >= window.to) throw new TypeError("Archive window must have from < to");
  const expanded = await provider(ctx).expand(config, ctx.signal);
  return { version: 1, window, timezone: config.timezone, config, ...expanded };
}
function approvedPlan(ctx: ArchiveDriverContext): ArchivePlan {
  const plan = ctx.resume.archivePlan;
  if (!plan || canonicalJson(plan.config) !== canonicalJson(parseArchiveConfig(ctx.config))) throw new ArchiveEffectError("plan_revision_required");
  return plan;
}
function omissions(plan: ArchivePlan, conversation: ArchiveConversation): string[] {
  const result: string[] = [];
  if (!plan.config.retainedHistory) result.push("retained_history_not_requested");
  else if (conversation.membershipType === "private") result.push("retained_history_unsupported_private_channel");
  if (!plan.config.attachmentBytes) result.push("attachment_metadata_only");
  if (plan.config.transcripts && conversation.kind === "channel") result.push("transcript_unsupported_channel_meeting");
  return result;
}
async function conversationFor(ctx: ArchiveDriverContext, plan: ArchivePlan, scope: ArchiveScopeBinding, route: ArchiveRoute, raw: Record<string, unknown>): Promise<ArchiveConversation | undefined> {
  if (route === "transcripts") {
    const id = await provider(ctx).transcriptConversationId(raw, scope, plan.conversations, ctx.signal);
    return plan.conversations.find((conversation) => conversation.id === id);
  }
  if (scope.kind === "channel") {
    const identity = raw.channelIdentity;
    if (typeof identity !== "object" || identity === null) throw new ArchiveEffectError("message_collection_incomplete");
    return plan.conversations.find((conversation) => conversation.teamId === Reflect.get(identity, "teamId") && conversation.channelId === Reflect.get(identity, "channelId") && conversation.scopeEntryId === scope.id);
  }
  if (typeof raw.chatId !== "string") throw new ArchiveEffectError("message_collection_incomplete");
  return plan.conversations.find((conversation) => conversation.kind === "chat" && conversation.raw.id === raw.chatId && conversation.scopeEntryId === scope.id);
}
function inWindow(raw: Record<string, unknown>, route: ArchiveRoute, plan: ArchivePlan): boolean {
  const value = route === "transcripts" ? raw.createdDateTime : raw.lastModifiedDateTime;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ArchiveEffectError(route === "transcripts" ? "transcript_unavailable" : "message_collection_incomplete");
  const time = Date.parse(value);
  return time >= Date.parse(plan.window.from) && time < Date.parse(plan.window.to);
}
function safeFailure(error: unknown, fallback: string): { code: string; evidence: Record<string, unknown> } {
  const codes: Record<string, true> = { message_collection_incomplete: true, hosted_content_unavailable_deleted_thread: true, hosted_content_unavailable_retained_message: true, attachment_content_unavailable: true, attachment_reference_unresolvable: true, transcript_unavailable: true };
  if (hasRetryAfter(error)) throw error;
  if (!(error instanceof ArchiveEffectError) && !(typeof error === "object" && error !== null && (Reflect.get(error, "name") === "ProviderFault" || typeof Reflect.get(error, "status") === "number"))) throw error;
  if (typeof error === "object" && error !== null) {
    if (Reflect.get(error, "transient") === true) throw error;
    const status = Reflect.get(error, "status");
    if (typeof status === "number" && (status === 408 || status === 429 || status >= 500)) throw error;
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && (code === "operation_aborted" || code === "aborted" || code === "retry_budget_exhausted" || code === "provider_request_failed")) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { code: typeof code === "string" && codes[code] ? code : fallback, evidence: { ...(typeof status === "number" ? { status } : {}), category: typeof code === "string" && codes[code] ? code : fallback } };
  }
  return { code: fallback, evidence: { category: fallback } };
}
async function stageAsset(ctx: ArchiveDriverContext, request: ArchiveAssetRequest): Promise<ArchiveDurableAsset> {
  const staging = join(directory(ctx), "assets", "staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const stagedPath = join(staging, `archive-${randomUUID()}`);
  const hash = createHash("sha256");
  let size = 0;
  const content = provider(ctx).openAsset(request, ctx.signal);
  async function* chunks() {
    for await (const chunk of content) { checkAbort(ctx); hash.update(chunk); size += chunk.byteLength; yield chunk; }
  }
  try {
    await pipeline(Readable.from(chunks()), createWriteStream(stagedPath, { flags: "wx", mode: 0o600 }), ctx.signal ? { signal: ctx.signal } : {});
    const sha256 = hash.digest("hex");
    return { id: digest(`${request.conversation.id}:${request.kind}:${request.id}:${sha256}`), conversationId: request.conversation.id, sourceKind: request.kind, stagedPath, sha256, size, retrievedAt: ctx.now().toISOString(), archivePath: assetPath(request.conversation, request.kind, request.id, sha256) };
  } catch (error) { await rm(stagedPath, { force: true }); throw error; }
}
async function prepareRecord(ctx: ArchiveDriverContext, plan: ArchivePlan, conversation: ArchiveConversation, raw: Record<string, unknown>, route: ArchiveRoute, assets: ArchiveDurableAsset[], knownAssets: Set<string>, outcomes: CommitFinding[]): Promise<ArchiveRecord> {
  if (typeof raw.id !== "string" || typeof raw.createdDateTime !== "string" || !Number.isFinite(Date.parse(raw.createdDateTime))) throw new ArchiveEffectError("message_collection_incomplete");
  const record: ArchiveRecord = { key: digest(`${conversation.id}:${canonicalJson(raw)}`), conversationId: conversation.id, messageId: raw.id, createdDateTime: new Date(raw.createdDateTime).toISOString(), route, raw, assets: [], findings: [] };
  try {
    for await (const request of provider(ctx).assetRequests(conversation, raw, route, plan.config, ctx.signal)) {
      try {
        const asset = await stageAsset(ctx, request);
        record.assets.push({ id: request.id, sourceKind: request.kind, name: request.name, ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {}), sha256: asset.sha256, size: asset.size, retrievedAt: asset.retrievedAt, path: asset.archivePath });
        const deduplicated = knownAssets.has(asset.archivePath);
        if (deduplicated) await rm(asset.stagedPath, { force: true });
        else { knownAssets.add(asset.archivePath); assets.push(asset); }
        outcomes.push({ ...finding(ctx, "execute", deduplicated ? "asset_deduplicated_within_conversation" : "asset_stored", record.key, { path: asset.archivePath, sha256: asset.sha256, size: asset.size }, "policy_outcome"), subjectKind: "asset" });
      } catch (error) {
        const fallback = request.kind === "attachment" ? "attachment_content_unavailable" : request.kind === "transcript" ? "transcript_unavailable" : route === "retained" ? "hosted_content_unavailable_retained_message" : raw.deletedDateTime ? "hosted_content_unavailable_deleted_thread" : "message_collection_incomplete";
        record.findings.push(safeFailure(error, fallback));
      }
    }
  } catch (error) { record.findings.push(safeFailure(error, route === "retained" ? "hosted_content_unavailable_retained_message" : route === "transcripts" ? "transcript_unavailable" : "message_collection_incomplete")); }
  record.findings.push(...analyzeRecord(record, plan.timezone));
  return record;
}

export const teamsArchiveDriver = {
  async *preflight(ctx: ArchiveDriverContext): AsyncGenerator<CheckResult> {
    let plan: ArchivePlan;
    try { plan = await expandPlan(ctx); }
    catch (error) { checkAbort(ctx); yield { id: "archive_scope", title: "Resolve explicit archive scope", status: "fail", code: "preflight_failed", evidence: safeFailure(error, "message_collection_incomplete").evidence }; return; }
    yield* provider(ctx).preflight(plan.config, plan, ctx.signal);
    try {
      const root = directory(ctx);
      await access(root, constants.W_OK);
      const space = await statfs(root);
      const availableBytes = Number(space.bavail) * Number(space.bsize);
      yield { id: "archive_local_root", title: "Writable local archive root", status: availableBytes > 0 ? "pass" : "fail", ...(availableBytes > 0 ? {} : { code: "preflight_failed" }), evidence: { availableBytes, estimate: null } };
    } catch { yield { id: "archive_local_root", title: "Writable local archive root", status: "fail", code: "preflight_failed", evidence: { writable: false } }; }
  },
  async *collect(ctx: ArchiveDriverContext): AsyncGenerator<ArchiveCommit> {
    const plan = await expandPlan(ctx);
    const frozen = commit(ctx, "plan", "scope");
    frozen.archivePlan = plan;
    yield frozen;
    const counts = new Map<string, Set<string>>();
    for (const scope of plan.scopes) {
      for (const route of routes(plan, scope)) {
        let cursor: string | null = null;
        const visited = new Set<string>();
        do {
          checkAbort(ctx);
          const page = await provider(ctx).page({ scope, route, window: plan.window, cursor, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          for (const raw of page.records) {
            if (!inWindow(raw, route, plan)) continue;
            const conversation = await conversationFor(ctx, plan, scope, route, raw);
            if (!conversation) continue;
            let keys = counts.get(conversation.id);
            if (!keys) { keys = new Set(); counts.set(conversation.id, keys); }
            keys.add(digest(canonicalJson(raw)));
          }
          cursor = page.nextLink;
          if (cursor && visited.has(cursor)) throw new ArchiveEffectError("message_collection_incomplete");
          if (cursor) visited.add(cursor);
        } while (cursor);
      }
    }
    for (const conversation of plan.conversations) {
      const unit = commit(ctx, "plan", digest(conversation.id));
      const records = counts.get(conversation.id)?.size ?? 0;
      unit.rows = [{ ...row(ctx, "plan", conversation, [], records ? "collected" : "empty_conversation"), records }];
      unit.findings = omissions(plan, conversation).map((code) => finding(ctx, "plan", code, conversation.id, { window: plan.window, modificationWindow: true }, "planned_omission"));
      yield unit;
    }
  },
  async *execute(ctx: ArchiveDriverContext): AsyncGenerator<ArchiveCommit> {
    const plan = approvedPlan(ctx);
    const records = new Map((ctx.resume.archiveRecords ?? []).map((record) => [record.key, record]));
    const evidence = [...(ctx.resume.archiveEvidence ?? [])];
    const knownAssets = new Set([...records.values()].flatMap((record) => record.assets.map((asset) => asset.path)));
    for (const scope of plan.scopes) {
      for (const route of routes(plan, scope)) {
        const watermark = watermarkKey(scope, route);
        const saved = ctx.resume.watermarks[watermark];
        if (saved === "complete") continue;
        let cursor: string | null = saved && saved !== "incomplete" ? saved : null;
        const visited = new Set<string>();
        do {
          checkAbort(ctx);
          const pageKey = digest(`${scope.id}:${route}:${cursor ?? "first"}`);
          const unit = commit(ctx, "execute", pageKey);
          const assets: ArchiveDurableAsset[] = [];
          const pageRecords: ArchiveRecord[] = [];
          let nextLink: string | null = null;
          let complete = false;
          try {
            const page = await provider(ctx).page({ scope, route, window: plan.window, cursor, ...(ctx.signal ? { signal: ctx.signal } : {}) });
            nextLink = page.nextLink;
            if (nextLink && (nextLink === cursor || visited.has(nextLink))) throw new ArchiveEffectError("message_collection_incomplete");
            for (const raw of page.records) {
              checkAbort(ctx);
              try {
                if (!inWindow(raw, route, plan)) continue;
                const conversation = await conversationFor(ctx, plan, scope, route, raw);
                if (!conversation) continue;
                const key = digest(`${conversation.id}:${canonicalJson(raw)}`);
                if (records.has(key)) continue;
                const record = await prepareRecord(ctx, plan, conversation, raw, route, assets, knownAssets, unit.findings);
                records.set(record.key, record);
                pageRecords.push(record);
                unit.findings.push(...record.findings.map((gap) => finding(ctx, "execute", gap.code, record.key, gap.evidence)));
              } catch (error) {
                const gap = safeFailure(error, route === "transcripts" ? "transcript_unavailable" : "message_collection_incomplete");
                unit.findings.push(finding(ctx, "execute", gap.code, scope.id, gap.evidence));
              }
            }
            complete = nextLink === null;
          } catch (error) {
            let gap;
            try { gap = safeFailure(error, route === "transcripts" ? "transcript_unavailable" : "message_collection_incomplete"); }
            catch (retry) { for (const asset of assets) await rm(asset.stagedPath, { force: true }); throw retry; }
            unit.findings.push(finding(ctx, "execute", "message_collection_incomplete", scope.id, { route, ...gap.evidence }));
            nextLink = null;
            complete = false;
          }
          const pageEvidence: ArchiveCollectionEvidence = { scopeEntryId: scope.id, route, cursor, nextLink, complete, recordKeys: pageRecords.map((record) => record.key), findingCodes: [...new Set(unit.findings.filter((gap) => gap.kind === "finding").map((gap) => gap.code))] };
          unit.archiveRecords = pageRecords;
          unit.archiveEvidence = pageEvidence;
          unit.assets = assets;
          unit.watermark = { unitKey: watermark, value: complete ? "complete" : nextLink ?? "incomplete" };
          unit.rows = plan.conversations.filter((conversation) => scope.conversationIds.includes(conversation.id) || pageRecords.some((record) => record.conversationId === conversation.id)).map((conversation) => row(ctx, "execute", conversation, [...records.values()]));
          unit.progress = { unit: "records", done: records.size, total: null };
          evidence.push(pageEvidence);
          yield unit;
          cursor = nextLink;
          if (cursor) visited.add(cursor);
        } while (cursor);
      }
    }
    const allRecords = [...records.values()];
    const result = buildArchivePackage({ plan, records: allRecords, evidence });
    const packageUnit = commit(ctx, "execute", "package");
    packageUnit.archiveFiles = result.files;
    packageUnit.archiveManifestDigest = result.manifestDigest;
    packageUnit.findings = result.findings.map((gap) => finding(ctx, "execute", gap.code, gap.subjectId, gap.evidence));
    packageUnit.rows = plan.conversations.map((conversation) => row(ctx, "execute", conversation, allRecords, allRecords.some((record) => record.conversationId === conversation.id) ? "collected" : "empty_conversation"));
    packageUnit.progress = { unit: "conversations", done: plan.conversations.length, total: plan.conversations.length };
    yield packageUnit;
  },
  async *verify(ctx: ArchiveDriverContext): AsyncGenerator<ArchiveCommit> {
    const plan = approvedPlan(ctx);
    const records = ctx.resume.archiveRecords ?? [];
    const unit = commit(ctx, "verify", "package");
    const results = ctx.resume.archiveManifestDigest ? await verifyArchivePackage(join(directory(ctx), "archive"), { plan, records, evidence: ctx.resume.archiveEvidence ?? [], manifestDigest: ctx.resume.archiveManifestDigest }) : [{ code: "manifest_digest_mismatch", subjectId: "archive", evidence: { reason: "missing_durable_manifest_digest" } }];
    unit.findings = results.map((gap) => finding(ctx, "verify", gap.code, gap.subjectId, gap.evidence));
    unit.rows = plan.conversations.map((conversation) => row(ctx, "verify", conversation, records, records.some((record) => record.conversationId === conversation.id) ? "collected" : "empty_conversation"));
    yield unit;
  },
  async *reportSections(ctx: ArchiveDriverContext): AsyncGenerator<ReportSection> {
    const plan = approvedPlan(ctx);
    const statements = [
      `Modification window [${plan.window.from}, ${plan.window.to}); partitions UTC, displayed timezone ${plan.timezone}.`,
      plan.config.retainedHistory ? "Retained history requested; collection evidence and private-channel omissions delimit retrievable history." : "Current message state only; retained_history_not_requested: edit and deletion history is not preserved.",
      "Messages deleted beyond 21 days, teams or channels deleted beyond 30 days, and users deleted or inactive beyond roughly 30 days are unrecoverable.",
      "Meeting recordings and beta targeted messages are not collected. Meeting control-message fidelity is limited to what the supported export routes return.",
      "Attachment bytes are as-retrieved with a retrieval timestamp, never as-sent; no message-time version is claimed.",
      "Identities are preserved verbatim, never translated. This local archive is an admin and legal reference, not chain of custody.",
      "Verification proves package self-consistency at a point in time, not a live tenant comparison. No Graph requests are made during verification.",
      "Incomplete collections and accepted exceptions retain their codes, items, evidence, and consequences. Host protection of local archive content is the operator's responsibility.",
    ];
    if (plan.config.lineage) statements.push(`Sibling lineage: ${canonicalJson(plan.config.lineage)}. Window overlap: ${plan.window.from < plan.config.lineage.to ? "yes" : "no"}. No assets or state reused from the sibling job.`);
    yield { title: "Teams archive scope and fidelity", body: statements.join("\n\n"), format: "text" };
  },
};
