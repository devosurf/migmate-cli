import { createHash } from "node:crypto";
import type {
  ArchiveAssetReference,
  ArchiveCollectionEvidence,
  ArchiveConversation,
  ArchivePackageFile,
  ArchivePackageInput,
  ArchivePackageResult,
  ArchiveRecord,
  ArchiveVerificationFinding,
} from "../providers/archive.ts";
import { canonicalJson } from "../store/digest.ts";
import { escapeHtml, htmlPage, recordAnchor, renderRecord } from "./render.ts";
import { verifyPackageFiles } from "./verify.ts";

export { analyzeRecord } from "./render.ts";

const PART_RECORD_LIMIT = 10_000;
const PART_BYTE_LIMIT = 100 * 1024 * 1024;
const assetDirectories: Record<ArchiveAssetReference["sourceKind"], string> = {
  hosted_content: "hosted",
  attachment: "attachments",
  transcript: "transcripts",
};

export function conversationPath(conversation: ArchiveConversation): string {
  let title = conversation.title;
  for (const id of [conversation.id, conversation.teamId, conversation.channelId]) {
    if (id) title = title.replaceAll(id, "conversation");
  }
  const slug =
    title
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "conversation";
  const suffix = createHash("sha256")
    .update(canonicalJson([conversation.kind, conversation.teamId ?? null, conversation.id]))
    .digest("hex");
  return `conversations/${slug}-${suffix}`;
}

/** IDs remain in asset references, never paths. Equal bytes of the same kind
 * share one local file within this conversation, never across conversations. */
export function assetPath(
  conversation: ArchiveConversation,
  sourceKind: ArchiveAssetReference["sourceKind"],
  _id: string,
  sha256: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Object.hasOwn(assetDirectories, sourceKind))
    throw new TypeError("Invalid archive asset identity");
  return `${conversationPath(conversation)}/assets/${assetDirectories[sourceKind]}/${sha256}/content`;
}

export interface ManifestRecord {
  key: string;
  messageId: string;
  conversationId: string;
  route: ArchiveRecord["route"];
  createdDateTime: string;
  rawSha256: string;
  line: number;
  anchor: string;
  assets: ArchiveAssetReference[];
  findings: { code: string; evidence: Record<string, unknown> }[];
}

export interface PartManifest {
  month: string;
  number: number;
  count: number;
  jsonl: { path: string; sha256: string; size: number };
  html: { path: string; sha256: string; size: number };
  records: ManifestRecord[];
}

export interface ManifestAsset {
  path: string;
  sha256: string;
  size: number;
  references: { recordKey: string; asset: ArchiveAssetReference }[];
}

export interface ConversationManifest {
  version: 1;
  conversation: ArchiveConversation;
  path: string;
  window: ArchivePackageInput["plan"]["window"];
  timezone: string;
  recordCount: number;
  partCount: number;
  statement: "collected" | "empty_conversation";
  parts: PartManifest[];
  assets: ManifestAsset[];
  index: { path: string; sha256: string; size: number };
  csv: { path: string; sha256: string; size: number };
}

export interface PackageManifest {
  version: 1;
  plan: ArchivePackageInput["plan"];
  scopeCount: number;
  conversationCount: number;
  partCount: number;
  recordCount: number;
  assetCount: number;
  assetBytes: number;
  partition: {
    field: "createdDateTime";
    timezone: "UTC";
    maxRecords: number;
    maxBytes: number;
    byteMeasure: string;
  };
  statements: string[];
  omissions: { code: string; subjectId: string }[];
  findings: ArchivePackageResult["findings"];
  collection: ArchiveCollectionEvidence[];
  scopes: { id: string; conversationIds: string[]; recordCount: number; partCount: number }[];
  conversations: {
    id: string;
    scopeEntryId: string;
    path: string;
    manifest: { path: string; sha256: string; size: number };
    recordCount: number;
    partCount: number;
    assetCount: number;
    statement: string;
  }[];
  index: { path: string; sha256: string; size: number };
  csv: { path: string; sha256: string; size: number };
}

function csv(rows: (string | number)[][]): string {
  // Quote every field, including newlines and leading formula characters.
  // Values remain verbatim; CSV is a data artifact, not spreadsheet code.
  return (
    rows
      .map((row) => row.map((field) => `"${String(field).replaceAll('"', '""')}"`).join(","))
      .join("\r\n") + "\r\n"
  );
}

function normalizeFindings(
  findings: ArchivePackageResult["findings"],
): ArchivePackageResult["findings"] {
  const unique = new Map<string, ArchivePackageResult["findings"][number]>();
  for (const finding of findings) unique.set(canonicalJson(finding), finding);
  return [...unique].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, finding]) => finding);
}

function collectionFindings(input: ArchivePackageInput): ArchivePackageResult["findings"] {
  const findings: ArchivePackageResult["findings"] = [];
  const records = new Map(input.records.map((record) => [record.key, record]));
  const conversations = new Map(
    input.plan.conversations.map((conversation) => [conversation.id, conversation]),
  );
  const witnessed = new Set<string>();
  const incomplete = (subjectId: string, evidence: Record<string, unknown>): void => {
    findings.push({ code: "message_collection_incomplete", subjectId, evidence });
  };
  for (const scope of input.plan.scopes) {
    const routes: ArchiveRecord["route"][] = ["messages"];
    const privateChannel =
      scope.kind === "channel" &&
      scope.conversationIds.length > 0 &&
      scope.conversationIds.every((id) => conversations.get(id)?.membershipType === "private");
    if (input.plan.config.retainedHistory && !privateChannel) routes.push("retained");
    if (input.plan.config.transcripts && scope.kind === "user-chats") routes.push("transcripts");
    for (const route of routes) {
      const pages = input.evidence.filter(
        (page) => page.scopeEntryId === scope.id && page.route === route,
      );
      const byCursor = new Map<string | null, ArchiveCollectionEvidence>();
      for (const page of pages) {
        if (byCursor.has(page.cursor))
          incomplete(scope.id, { route, reason: "duplicate_page_cursor", cursor: page.cursor });
        byCursor.set(page.cursor, page);
      }
      const visited = new Set<string | null>();
      let cursor: string | null = null;
      let complete = false;
      while (!visited.has(cursor)) {
        visited.add(cursor);
        const page = byCursor.get(cursor);
        if (!page) break;
        if (page.complete && page.nextLink === null) {
          complete = true;
          break;
        }
        if (page.complete || page.nextLink === null) break;
        cursor = page.nextLink;
      }
      if (!complete || visited.size !== pages.length)
        incomplete(scope.id, {
          route,
          reason: "paging_not_exhausted",
          pages: pages.length,
          reachablePages: [...visited].filter((key) => byCursor.has(key)).length,
          terminalPage: complete,
        });
    }
  }
  const scopeById = new Map(input.plan.scopes.map((scope) => [scope.id, scope]));
  for (const page of input.evidence) {
    const scope = scopeById.get(page.scopeEntryId);
    if (!scope)
      incomplete(page.scopeEntryId, {
        route: page.route,
        reason: "evidence_outside_approved_scope",
      });
    for (const key of page.recordKeys) {
      const record = records.get(key);
      const organizer = record?.raw.meetingOrganizer;
      const organizerUser =
        organizer && typeof organizer === "object" && "user" in organizer
          ? organizer.user
          : undefined;
      const organizerId =
        organizerUser && typeof organizerUser === "object" && "id" in organizerUser
          ? organizerUser.id
          : undefined;
      const transcriptScope =
        record?.route === "transcripts" &&
        scope?.kind === "user-chats" &&
        organizerId === scope.userId;
      if (
        !record ||
        record.route !== page.route ||
        (record.route === "transcripts"
          ? !transcriptScope
          : conversations.get(record.conversationId)?.scopeEntryId !== page.scopeEntryId)
      ) {
        incomplete(key, {
          scopeEntryId: page.scopeEntryId,
          route: page.route,
          reason: "evidence_record_not_collected_in_scope",
        });
      } else witnessed.add(key);
    }
    if (page.findingCodes.includes("message_collection_incomplete"))
      incomplete(page.scopeEntryId, {
        route: page.route,
        cursor: page.cursor,
        reason: "collection_reported_incomplete",
        findingCodes: [...page.findingCodes].sort(),
      });
  }
  for (const record of input.records)
    if (!witnessed.has(record.key))
      incomplete(record.key, {
        reason: "collected_record_without_page_evidence",
        route: record.route,
      });
  return findings;
}

/** Pure packaging: callers install returned text files at the engine's durable
 * commit boundary. Asset bytes have already been installed by that boundary. */
export function buildArchivePackage(input: ArchivePackageInput): ArchivePackageResult {
  new Intl.DateTimeFormat("en-GB", { timeZone: input.plan.timezone }).format(0);
  const files: ArchivePackageFile[] = [];
  const findings = collectionFindings(input);
  const filePaths = new Set<string>();
  const add = (path: string, content: string): { path: string; sha256: string; size: number } => {
    if (filePaths.has(path)) throw new TypeError(`Duplicate archive file: ${path}`);
    filePaths.add(path);
    const sha256 = createHash("sha256").update(content).digest("hex");
    files.push({ path, content, sha256 });
    return { path, sha256, size: Buffer.byteLength(content) };
  };
  const conversations = [...input.plan.conversations]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((conversation) => ({
      ...conversation,
      participantScopeIds: [...conversation.participantScopeIds].sort(),
    }));
  const scopes = [...input.plan.scopes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((scope) => ({ ...scope, conversationIds: [...scope.conversationIds].sort() }));
  if (
    new Set(conversations.map((conversation) => conversation.id)).size !== conversations.length ||
    new Set(scopes.map((scope) => scope.id)).size !== scopes.length
  )
    throw new TypeError("Duplicate frozen archive scope or conversation");
  const byConversation = new Map<string, ArchiveRecord[]>();
  const scopeById = new Map(scopes.map((scope) => [scope.id, scope]));
  for (const conversation of conversations) {
    byConversation.set(conversation.id, []);
    if (!scopeById.get(conversation.scopeEntryId)?.conversationIds.includes(conversation.id))
      throw new TypeError("Conversation owner absent from frozen scope");
    for (const participant of conversation.participantScopeIds)
      if (!scopeById.has(participant))
        throw new TypeError("Conversation participant absent from frozen scope");
  }
  for (const scope of scopes) {
    if (
      new Set(scope.conversationIds).size !== scope.conversationIds.length ||
      scope.conversationIds.some((id) => !byConversation.has(id))
    )
      throw new TypeError("Frozen scope does not reconcile with conversations");
  }
  const recordKeys = new Set<string>();
  for (const record of input.records) {
    if (!record.key || recordKeys.has(record.key))
      throw new TypeError("Duplicate or empty durable archive record key");
    recordKeys.add(record.key);
    const bucket = byConversation.get(record.conversationId);
    if (!bucket) throw new TypeError("Collected record is outside the frozen conversation list");
    if (
      !Number.isFinite(Date.parse(record.createdDateTime)) ||
      !/^\d{4}-/.test(new Date(record.createdDateTime).toISOString())
    )
      throw new TypeError("Collected record has no partitionable creation timestamp");
    if (record.raw.id !== record.messageId)
      throw new TypeError("Durable message identity differs from canonical Graph record");
    if (
      typeof record.raw.createdDateTime === "string" &&
      Date.parse(record.raw.createdDateTime) !== Date.parse(record.createdDateTime)
    )
      throw new TypeError("Durable creation time differs from canonical Graph record");
    bucket.push(record);
  }
  const manifests: ConversationManifest[] = [];
  const rootConversations: PackageManifest["conversations"] = [];
  for (const conversation of conversations) {
    const path = conversationPath(conversation);
    const records = byConversation.get(conversation.id)!;
    records.sort(
      (a, b) =>
        Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime) ||
        (a.messageId < b.messageId
          ? -1
          : a.messageId > b.messageId
            ? 1
            : a.key < b.key
              ? -1
              : a.key > b.key
                ? 1
                : 0),
    );
    const parts: PartManifest[] = [];
    const assets = new Map<string, ManifestAsset>();
    let month = "";
    let partNumber = 0;
    let partRecords: ManifestRecord[] = [];
    let jsonLines: string[] = [];
    let articles: string[] = [];
    let jsonBytes = 0;
    let htmlBytes = 0;
    const navigation = `<nav><a href="../index.html">Conversation index</a> | <a href="../../../index.html">Archive index</a></nav>`;
    const finishPart = (): void => {
      if (!partRecords.length) return;
      const name = `${month}-${String(partNumber).padStart(3, "0")}`;
      const title = `${conversation.title} — ${name}`;
      const jsonl = add(`${path}/data/${name}.jsonl`, jsonLines.join(""));
      const html = add(
        `${path}/parts/${name}.html`,
        htmlPage(title, navigation + articles.join("\n")),
      );
      parts.push({
        month,
        number: partNumber,
        count: partRecords.length,
        jsonl,
        html,
        records: partRecords,
      });
      partRecords = [];
      jsonLines = [];
      articles = [];
      jsonBytes = 0;
      htmlBytes = 0;
    };
    for (const record of records) {
      const recordMonth = new Date(record.createdDateTime).toISOString().slice(0, 7);
      if (recordMonth !== month) {
        finishPart();
        month = recordMonth;
        partNumber = 1;
      }
      for (const asset of record.assets) {
        if (
          asset.path !== assetPath(conversation, asset.sourceKind, asset.id, asset.sha256) ||
          !Number.isSafeInteger(asset.size) ||
          asset.size < 0 ||
          !Number.isFinite(Date.parse(asset.retrievedAt))
        )
          throw new TypeError("Invalid or unconfined durable archive asset reference");
        const existing = assets.get(asset.path);
        if (existing && (existing.sha256 !== asset.sha256 || existing.size !== asset.size))
          throw new TypeError("Conflicting content-addressed archive asset");
        const entry = existing ?? {
          path: asset.path,
          sha256: asset.sha256,
          size: asset.size,
          references: [],
        };
        entry.references.push({ recordKey: record.key, asset });
        assets.set(asset.path, entry);
      }
      const raw = canonicalJson(record.raw);
      const rawSha256 = createHash("sha256").update(raw).digest("hex");
      const line = raw + "\n";
      const rendered = renderRecord(record, input.plan.timezone, rawSha256);
      const recordFindings = normalizeFindings(
        [...record.findings, ...rendered.findings].map((finding) => ({
          ...finding,
          subjectId: record.key,
        })),
      );
      findings.push(...recordFindings);
      const lineBytes = Buffer.byteLength(line);
      const articleBytes = Buffer.byteLength(rendered.html) + 1;
      const overhead = Buffer.byteLength(
        htmlPage(
          `${conversation.title} — ${month}-${String(partNumber).padStart(3, "0")}`,
          navigation,
        ),
      );
      if (
        partRecords.length &&
        (partRecords.length >= PART_RECORD_LIMIT ||
          jsonBytes + lineBytes > PART_BYTE_LIMIT ||
          htmlBytes + articleBytes + overhead > PART_BYTE_LIMIT)
      ) {
        finishPart();
        partNumber += 1;
      }
      partRecords.push({
        key: record.key,
        messageId: record.messageId,
        conversationId: record.conversationId,
        route: record.route,
        createdDateTime: record.createdDateTime,
        rawSha256,
        line: partRecords.length + 1,
        anchor: recordAnchor(record.key),
        assets: [...record.assets].sort((a, b) =>
          canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0,
        ),
        findings: recordFindings.map(({ code, evidence }) => ({ code, evidence })),
      });
      jsonLines.push(line);
      articles.push(rendered.html);
      jsonBytes += lineBytes;
      htmlBytes += articleBytes;
    }
    finishPart();
    const statement = records.length ? "collected" : "empty_conversation";
    const rows: (string | number)[][] = [
      ["conversationId", "scopeEntryId", "part", "jsonl", "records", "statement"],
    ];
    if (!parts.length)
      rows.push([conversation.id, conversation.scopeEntryId, "", "", 0, statement]);
    for (const part of parts)
      rows.push([
        conversation.id,
        conversation.scopeEntryId,
        part.html.path,
        part.jsonl.path,
        part.count,
        statement,
      ]);
    const indexBody = `<nav><a href="../../index.html">Archive index</a></nav><div>Conversation ID: <code>${escapeHtml(conversation.id)}</code></div><div>Owning scope: <code>${escapeHtml(conversation.scopeEntryId)}</code></div><div data-record-count="${records.length}" data-part-count="${parts.length}">${records.length} records; ${parts.length} parts; ${statement}</div><div>Displayed timezone: ${escapeHtml(input.plan.timezone)}; partitions: UTC. Modification window [${escapeHtml(input.plan.window.from)}, ${escapeHtml(input.plan.window.to)}).</div><pre>${escapeHtml(canonicalJson(conversation))}</pre><ul>${parts.map((part) => `<li data-part="${escapeHtml(part.html.path)}" data-record-count="${part.count}"><a href="${escapeHtml(part.html.path.slice(path.length + 1))}">${part.month}-${String(part.number).padStart(3, "0")}</a>: ${part.count} records; <a href="${escapeHtml(part.jsonl.path.slice(path.length + 1))}">Canonical JSONL</a></li>`).join("")}</ul>`;
    const index = add(`${path}/index.html`, htmlPage(conversation.title, indexBody));
    const csvFile = add(`${path}/index.csv`, csv(rows));
    const manifest: ConversationManifest = {
      version: 1,
      conversation,
      path,
      window: input.plan.window,
      timezone: input.plan.timezone,
      recordCount: records.length,
      partCount: parts.length,
      statement,
      parts,
      assets: [...assets.values()]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((asset) => ({
          ...asset,
          references: asset.references.sort((a, b) =>
            canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0,
          ),
        })),
      index,
      csv: csvFile,
    };
    manifests.push(manifest);
    const descriptor = add(`${path}/manifest.json`, canonicalJson(manifest) + "\n");
    rootConversations.push({
      id: conversation.id,
      scopeEntryId: conversation.scopeEntryId,
      path,
      manifest: descriptor,
      recordCount: records.length,
      partCount: parts.length,
      assetCount: assets.size,
      statement,
    });
  }
  const rootRows: (string | number)[][] = [
    [
      "scopeEntryId",
      "conversationId",
      "ownerScopeEntryId",
      "conversation",
      "part",
      "records",
      "statement",
    ],
  ];
  const rootScopes = scopes.map((scope) => {
    const included = manifests.filter((manifest) =>
      manifest.conversation.participantScopeIds.includes(scope.id),
    );
    if (!included.length) rootRows.push([scope.id, "", "", "", "", 0, "empty_scope"]);
    for (const manifest of included) {
      if (!manifest.parts.length)
        rootRows.push([
          scope.id,
          manifest.conversation.id,
          manifest.conversation.scopeEntryId,
          manifest.path,
          "",
          0,
          manifest.statement,
        ]);
      for (const part of manifest.parts)
        rootRows.push([
          scope.id,
          manifest.conversation.id,
          manifest.conversation.scopeEntryId,
          manifest.path,
          part.html.path,
          part.count,
          manifest.statement,
        ]);
    }
    return {
      id: scope.id,
      conversationIds: included.map((manifest) => manifest.conversation.id),
      recordCount: included.reduce((sum, manifest) => sum + manifest.recordCount, 0),
      partCount: included.reduce((sum, manifest) => sum + manifest.partCount, 0),
    };
  });
  const rootBody = `<div data-scope-count="${scopes.length}" data-conversation-count="${conversations.length}" data-record-count="${input.records.length}">${scopes.length} scopes; ${conversations.length} unique conversations; ${input.records.length} records.</div><div>Modification window [${escapeHtml(input.plan.window.from)}, ${escapeHtml(input.plan.window.to)}); displayed timezone ${escapeHtml(input.plan.timezone)}; partition timezone UTC.</div>${rootScopes
    .map(
      (scope) =>
        `<section data-scope="${escapeHtml(scope.id)}"><h2>${escapeHtml(scope.id)}</h2><div>${scope.recordCount} records; ${scope.partCount} parts across participating conversations (shared conversations counted only once in archive totals).</div><ul>${scope.conversationIds
          .map((id) => {
            const conversation = rootConversations.find((entry) => entry.id === id)!;
            return `<li data-conversation="${escapeHtml(id)}" data-record-count="${conversation.recordCount}" data-part-count="${conversation.partCount}"><a href="${escapeHtml(conversation.path)}/index.html">${escapeHtml(conversations.find((entry) => entry.id === id)!.title)}</a>: ${conversation.recordCount} records; ${conversation.partCount} parts; ${conversation.statement}</li>`;
          })
          .join("")}</ul></section>`,
    )
    .join("")}`;
  const index = add("index.html", htmlPage("Teams conversation archive", rootBody));
  const csvFile = add("index.csv", csv(rootRows));
  const finalFindings = normalizeFindings(findings);
  const omissions: PackageManifest["omissions"] = [];
  if (!input.plan.config.retainedHistory)
    omissions.push({ code: "retained_history_not_requested", subjectId: "archive" });
  if (!input.plan.config.attachmentBytes)
    omissions.push({ code: "attachment_metadata_only", subjectId: "archive" });
  for (const conversation of conversations) {
    if (input.plan.config.retainedHistory && conversation.membershipType === "private")
      omissions.push({
        code: "retained_history_unsupported_private_channel",
        subjectId: conversation.id,
      });
    if (input.plan.config.transcripts && conversation.kind === "channel")
      omissions.push({
        code: "transcript_unsupported_channel_meeting",
        subjectId: conversation.id,
      });
  }
  const manifest: PackageManifest = {
    version: 1,
    plan: { ...input.plan, scopes, conversations },
    scopeCount: scopes.length,
    conversationCount: conversations.length,
    partCount: manifests.reduce((sum, entry) => sum + entry.partCount, 0),
    recordCount: input.records.length,
    assetCount: manifests.reduce((sum, entry) => sum + entry.assets.length, 0),
    assetBytes: manifests.reduce(
      (sum, entry) => sum + entry.assets.reduce((bytes, asset) => bytes + asset.size, 0),
      0,
    ),
    partition: {
      field: "createdDateTime",
      timezone: "UTC",
      maxRecords: PART_RECORD_LIMIT,
      maxBytes: PART_BYTE_LIMIT,
      byteMeasure:
        "Maximum of canonical JSONL and rendered HTML UTF-8 bytes; an indivisible oversized record occupies its own part",
    },
    statements: [
      input.plan.config.retainedHistory
        ? "Retained history was requested; completeness and route gaps are recorded in collection evidence and findings."
        : "Current message state only; edit and deletion history is not preserved.",
      "Messages deleted beyond 21 days, teams or channels deleted beyond 30 days, and users deleted or inactive beyond roughly 30 days are unrecoverable.",
      "Meeting recordings and targeted messages are not collected.",
      "Attachment bytes are as-retrieved with a retrieval timestamp, never as-sent.",
      "Identities are preserved verbatim, never translated.",
      "Verification proves package self-consistency at a point in time, not a live tenant comparison.",
      "This archive is an admin and legal reference, not chain of custody; protection of local disk remains the operator's responsibility.",
      ...(input.plan.config.lineage &&
      Date.parse(input.plan.window.from) < Date.parse(input.plan.config.lineage.to)
        ? [
            "This modification window overlaps its lineage predecessor; this is an independent archive with no cross-job assets.",
          ]
        : []),
    ],
    omissions,
    findings: finalFindings,
    collection: input.evidence
      .map((page) => ({
        ...page,
        recordKeys: [...page.recordKeys].sort(),
        findingCodes: [...page.findingCodes].sort(),
      }))
      .sort((a, b) => {
        const left = canonicalJson(a);
        const right = canonicalJson(b);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    scopes: rootScopes,
    conversations: rootConversations,
    index,
    csv: csvFile,
  };
  const rootManifest = add("manifest.json", canonicalJson(manifest) + "\n");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, manifestDigest: rootManifest.sha256, findings: finalFindings };
}

export async function verifyArchivePackage(
  root: string,
  input: ArchivePackageInput & { manifestDigest: string },
): Promise<ArchiveVerificationFinding[]> {
  // The immutable collection input, not a possibly-corrupted manifest, is the
  // authority for expected record identities, counts, scope and asset paths.
  let expected: ArchivePackageResult;
  try {
    expected = buildArchivePackage(input);
  } catch (error) {
    return [
      {
        code: "record_count_mismatch",
        subjectId: "archive",
        evidence: {
          reason: "invalid_durable_collection",
          detail: error instanceof Error ? error.message : String(error),
        },
      },
    ];
  }
  return verifyPackageFiles(root, input, expected);
}
