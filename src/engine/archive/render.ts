import { createHash } from "node:crypto";
import { posix } from "node:path";
import { defaultTreeAdapter, parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { ArchiveRecord } from "../providers/archive.ts";
import { canonicalJson } from "../store/digest.ts";

export interface RenderFinding {
  code: string;
  evidence: Record<string, unknown>;
}

export function escapeHtml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

export function recordAnchor(key: string): string {
  return `record-${createHash("sha256").update(key).digest("hex")}`;
}

export type HtmlNode =
  | { kind: "text"; value: string; offset: number }
  | { kind: "comment"; value: string; offset: number }
  | { kind: "doctype"; value: string; offset: number }
  | { kind: "element"; name: string; attributes: { name: string; value: string }[]; children: HtmlNode[]; offset: number };

const voidElements: Record<string, true> = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, param: true, source: true, track: true, wbr: true };

/** Parse with the HTML5 tree builder, retaining diagnostics and source coverage.
 * A fragment that needs error recovery or loses source tokens is escaped as a
 * whole. Browser repairs therefore cannot silently remove evidence. */
export function parseHtml(source: string, document = false): { nodes: HtmlNode[]; errors: { offset: number; reason: string }[] } {
  const errors: { offset: number; reason: string }[] = [];
  const options = {
    sourceCodeLocationInfo: true,
    onParseError: (error: { code: string; startOffset: number }): void => {
      errors.push({ offset: error.startOffset, reason: error.code });
    },
  };
  const tree = document ? parse(source, options) : parseFragment(source, options);
  const covered: { start: number; end: number }[] = [];
  const convert = (node: DefaultTreeAdapterTypes.ChildNode, depth: number): HtmlNode => {
    const location = node.sourceCodeLocation;
    const offset = location?.startOffset ?? -1;
    if (defaultTreeAdapter.isElementNode(node)) {
      const elementLocation = node.sourceCodeLocation;
      if (depth > 256) {
        errors.push({ offset, reason: "nesting_limit" });
        return { kind: "text", value: "", offset };
      }
      if (elementLocation?.startTag) covered.push({ start: elementLocation.startTag.startOffset, end: elementLocation.startTag.endOffset });
      if (elementLocation?.endTag) covered.push({ start: elementLocation.endTag.startOffset, end: elementLocation.endTag.endOffset });
      if (!elementLocation) errors.push({ offset, reason: `implicit_element:${node.tagName}` });
      else if (!elementLocation.endTag && !Object.hasOwn(voidElements, node.tagName)) errors.push({ offset, reason: `implicit_close:${node.tagName}` });
      const children = node.tagName === "template" ? defaultTreeAdapter.getTemplateContent(node as DefaultTreeAdapterTypes.Template).childNodes : node.childNodes;
      return {
        kind: "element",
        name: node.namespaceURI === "http://www.w3.org/1999/xhtml" ? node.tagName : `foreign:${node.tagName}`,
        attributes: node.attrs.map((attribute) => ({ name: attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name, value: attribute.value })),
        children: children.map((child) => convert(child, depth + 1)),
        offset,
      };
    }
    if (location) covered.push({ start: location.startOffset, end: location.endOffset });
    if (defaultTreeAdapter.isTextNode(node)) return { kind: "text", value: node.value, offset };
    if (defaultTreeAdapter.isCommentNode(node)) return { kind: "comment", value: node.data, offset };
    return { kind: "doctype", value: source.slice(location?.startOffset ?? 0, location?.endOffset ?? 0), offset };
  };
  const nodes = tree.childNodes.map((node) => convert(node, 0));
  covered.sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  for (const span of covered) {
    if (span.start > cursor && source.slice(cursor, span.start).trim()) errors.push({ offset: cursor, reason: "discarded_source_markup" });
    cursor = Math.max(cursor, span.end);
  }
  if (source.slice(cursor).trim()) errors.push({ offset: cursor, reason: "discarded_source_markup" });
  return { nodes, errors };
}

// Input from the HTML parser is already entity-decoded. Raw Graph link values
// are not decoded a second time, so visible targets retain their exact value.
export function visibleUrl(value: string): string | undefined {
  if (/[\u0000-\u0020\u007f\\]/.test(value) || !/^(https?:\/\/|mailto:)/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:")) return undefined;
    return value;
  } catch { return undefined; }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function identity(value: unknown): { html: string; unresolved: boolean } {
  const raw = object(value);
  const entries = Object.entries(raw).filter(([, entry]) => entry !== null && typeof entry === "object");
  const identities = entries.length ? entries.map(([, entry]) => object(entry)) : [raw];
  const unresolved = !identities.some((entry) => typeof entry.id === "string" && [entry.displayName, entry.userPrincipalName, entry.email].some((field) => typeof field === "string" && field.length > 0));
  return { html: `${unresolved ? '<strong class="identity-unresolved">identity_unresolved</strong> ' : ""}<code>${escapeHtml(canonicalJson(value ?? null))}</code>`, unresolved };
}

const timestampFormatters = new Map<string, Intl.DateTimeFormat>();

function timestamp(value: unknown, timezone: string): string {
  if (typeof value !== "string") return escapeHtml(canonicalJson(value ?? null));
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return `${escapeHtml(value)} (invalid timestamp)`;
  let formatter = timestampFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    timestampFormatters.set(timezone, formatter);
  }
  const local = formatter.format(date);
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(local)} ${escapeHtml(timezone)} | ${escapeHtml(date.toISOString())} UTC</time>`;
}

const inlineTags: Record<string, true> = { span: true, b: true, strong: true, i: true, em: true, u: true, s: true, strike: true, del: true, ins: true, code: true, kbd: true, samp: true, sub: true, sup: true, small: true, mark: true };
const blockTags: Record<string, true> = { div: true, p: true, pre: true, blockquote: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, ul: true, ol: true, li: true, table: true, thead: true, tbody: true, tfoot: true, tr: true, td: true, th: true };

function localAsset(record: ArchiveRecord, reference: string): string | undefined {
  let hostedId: string | undefined;
  try {
    const pieces = new URL(reference, "https://archive.invalid/").pathname.split("/");
    const index = pieces.lastIndexOf("hostedContents");
    if (index !== -1 && pieces[index + 2] === "$value") hostedId = decodeURIComponent(pieces[index + 1] ?? "");
  } catch { /* Not a Graph hosted-content reference. */ }
  const asset = record.assets.find((entry) => entry.sourceUrl === reference || (hostedId !== undefined && entry.sourceKind === "hosted_content" && entry.id === hostedId));
  if (!asset || !/^conversations\/[a-z0-9-]+\/assets\/(hosted|attachments|transcripts)\/[a-f0-9]{64}\/content$/.test(asset.path)) return undefined;
  const conversationRoot = asset.path.slice(0, asset.path.indexOf("/assets/"));
  return posix.relative(`${conversationRoot}/parts`, asset.path);
}

function renderBody(body: Record<string, unknown>, record: ArchiveRecord, findings: RenderFinding[], field: string): string {
  const source = typeof body.content === "string" ? body.content : canonicalJson(body.content ?? "");
  if (body.contentType === "text") {
    for (const match of source.matchAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g)) findings.push({ code: "render_downgraded", evidence: { field, offset: match.index, reason: "control_character_escaped", codePoint: match[0].charCodeAt(0) } });
  }
  if (body.contentType === "text") return `<div class="body-text">${escapeHtml(source)}</div>`;
  if (body.contentType !== "html" && body.contentType !== undefined) {
    findings.push({ code: "render_downgraded", evidence: { field, reason: "unsupported_content_type", contentType: body.contentType } });
    return `<pre>${escapeHtml(source)}</pre>`;
  }
  const parsed = parseHtml(source);
  if (parsed.errors.length) {
    for (const error of parsed.errors) findings.push({ code: "render_downgraded", evidence: { field, ...error, action: "escaped_entire_body" } });
    return `<pre class="unparsed-body">${escapeHtml(source)}</pre>`;
  }
  const removed = (node: HtmlNode, reason: string, details: Record<string, unknown> = {}): void => {
    findings.push({ code: "render_downgraded", evidence: { field, offset: node.offset, reason, ...details } });
  };
  const render = (node: HtmlNode): string => {
    if (node.kind === "text") return escapeHtml(node.value);
    if (node.kind !== "element") { removed(node, `${node.kind}_removed`); return ""; }
    const attribute = (name: string): string | undefined => node.attributes.find((entry) => entry.name === name)?.value;
    const supported = Object.hasOwn(inlineTags, node.name) || Object.hasOwn(blockTags, node.name) || ["a", "img", "br", "hr", "at"].includes(node.name);
    if (!supported) removed(node, "element_escaped", { tag: node.name });
    for (const entry of node.attributes) {
      const retained = supported && ((node.name === "a" && entry.name === "href") || (node.name === "img" && ["src", "alt"].includes(entry.name)) || (node.name === "at" && entry.name === "id"));
      if (!retained) removed(node, "attribute_removed", { tag: node.name, attribute: entry.name, value: entry.value });
    }
    const children = node.children.map(render).join("");
    if (!supported) return `<span class="unsupported-markup">${escapeHtml(`<${node.name}>`)}${children}${escapeHtml(`</${node.name}>`)}</span>`;
    if (node.name === "br" || node.name === "hr") return `<${node.name}>`;
    if (node.name === "a") {
      const href = attribute("href");
      const local = href === undefined ? undefined : localAsset(record, href);
      const target = local ?? (href === undefined ? undefined : visibleUrl(href));
      if (href !== undefined && !target) removed(node, "unsafe_link_removed", { attribute: "href", value: href });
      return `<span class="link">${children}${target ? ` <a href="${escapeHtml(target)}" rel="noreferrer noopener">${escapeHtml(local ? "Local asset" : target)}</a>` : ""}</span>`;
    }
    if (node.name === "img") {
      const src = attribute("src");
      const local = src === undefined ? undefined : localAsset(record, src);
      if (!local) {
        removed(node, "remote_or_unavailable_image_removed", { attribute: "src", value: src ?? null });
        return `<span class="image-unavailable">[Image unavailable: ${escapeHtml(attribute("alt") ?? "")}]</span>`;
      }
      return `<img src="${escapeHtml(local)}" alt="${escapeHtml(attribute("alt") ?? "")}">`;
    }
    if (node.name === "at") {
      const mentionId = attribute("id") ?? "";
      const mention = Array.isArray(record.raw.mentions) ? record.raw.mentions.map(object).find((entry) => String(entry.id) === mentionId) : undefined;
      const resolved = identity(mention?.mentioned);
      if (!mention) findings.push({ code: "identity_unresolved", evidence: { field, mentionId, reason: "mention_metadata_missing" } });
      return `<span class="mention">${children} [${resolved.html}]</span>`;
    }
    return `<${node.name}>${children}</${node.name}>`;
  };
  return parsed.nodes.map(render).join("");
}

export function renderRecord(record: ArchiveRecord, timezone: string, rawSha256 = createHash("sha256").update(canonicalJson(record.raw)).digest("hex")): { html: string; findings: RenderFinding[] } {
  const findings: RenderFinding[] = [];
  const rawSender = record.raw.from ?? record.raw.meetingOrganizer ?? record.raw.organizer;
  const sender = identity(rawSender);
  if (sender.unresolved) findings.push({ code: "identity_unresolved", evidence: { field: record.route === "transcripts" ? "meetingOrganizer" : "from", identity: rawSender ?? null } });
  const sections = [
    `<header><h2>${escapeHtml(record.messageId)}</h2><div>Created: ${timestamp(record.createdDateTime, timezone)}</div><div class="sender">${sender.html}</div></header>`,
  ];
  if (record.raw.replyToId !== undefined && record.raw.replyToId !== null) sections.push(`<div>Reply to: <code>${escapeHtml(String(record.raw.replyToId))}</code></div>`);
  if (record.raw.subject) sections.push(`<h3>${escapeHtml(String(record.raw.subject))}</h3>`);
  for (const [field, label] of [["lastEditedDateTime", "Edited"], ["deletedDateTime", "Deleted"], ["lastModifiedDateTime", "Last modified"]]) {
    if (field && record.raw[field]) sections.push(`<div>${label}: ${timestamp(record.raw[field], timezone)}</div>`);
  }
  if (record.raw.body !== undefined) sections.push(`<div class="body">${renderBody(object(record.raw.body), record, findings, "body")}</div>`);
  if (record.route === "transcripts") {
    sections.push(`<section class="transcript"><h3>Transcript</h3><pre>${escapeHtml(canonicalJson(record.raw))}</pre></section>`);
  }
  if (Array.isArray(record.raw.mentions)) {
    sections.push('<section class="mentions"><h3>Mentions (original identities)</h3>');
    for (const [index, value] of record.raw.mentions.entries()) {
      const mention = object(value);
      const resolved = identity(mention.mentioned);
      if (resolved.unresolved) findings.push({ code: "identity_unresolved", evidence: { field: `mentions[${index}]`, mentionId: mention.id ?? null, identity: mention.mentioned ?? null } });
      sections.push(`<div>${escapeHtml(String(mention.mentionText ?? ""))}: ${resolved.html}<pre>${escapeHtml(canonicalJson(mention))}</pre></div>`);
    }
    sections.push("</section>");
  }
  if (Array.isArray(record.raw.messageHistory)) {
    sections.push('<section class="history"><h3>Retrievable message history</h3>');
    for (const [index, value] of record.raw.messageHistory.entries()) {
      const entry = object(value);
      sections.push(`<div>${timestamp(entry.modifiedDateTime ?? entry.createdDateTime, timezone)}<pre>${escapeHtml(canonicalJson(entry))}</pre>${entry.body ? renderBody(object(entry.body), record, findings, `messageHistory[${index}].body`) : ""}</div>`);
    }
    sections.push("</section>");
  }
  if (Array.isArray(record.raw.attachments)) {
    sections.push('<section class="attachments"><h3>Attachments and card payloads</h3>');
    for (const value of record.raw.attachments) {
      const entry = object(value);
      const url = typeof entry.contentUrl === "string" ? entry.contentUrl : undefined;
      const local = url === undefined ? undefined : localAsset(record, url);
      const target = local ?? (url === undefined ? undefined : visibleUrl(url));
      if (url !== undefined && target === undefined) findings.push({ code: "render_downgraded", evidence: { field: "attachments.contentUrl", attachmentId: entry.id ?? null, reason: "unsafe_link_removed", value: url } });
      sections.push(`<div><h4>${escapeHtml(String(entry.name ?? entry.contentType ?? entry.id ?? "Attachment"))}</h4><pre>${escapeHtml(canonicalJson(entry))}</pre>${target ? `<a href="${escapeHtml(target)}" rel="noreferrer noopener">${escapeHtml(local ? "Local asset" : target)}</a>` : ""}</div>`);
    }
    sections.push("</section>");
  }
  if (record.assets.length) {
    sections.push('<section class="assets"><h3>Byte-preserved assets</h3>');
    for (const asset of [...record.assets].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      const local = posix.relative(`${asset.path.slice(0, asset.path.indexOf("/assets/"))}/parts`, asset.path);
      sections.push(`<div><a href="${escapeHtml(local)}" download="">${escapeHtml(asset.name)}</a> <code>${escapeHtml(asset.id)}</code> (${asset.size} bytes; SHA-256 ${escapeHtml(asset.sha256)}); as retrieved ${timestamp(asset.retrievedAt, timezone)}</div>`);
    }
    sections.push("</section>");
  }
  for (const field of ["reactions", "eventDetail"]) {
    if (record.raw[field] !== undefined && record.raw[field] !== null) sections.push(`<section><h3>${escapeHtml(field)}</h3><pre>${escapeHtml(canonicalJson(record.raw[field]))}</pre></section>`);
  }
  const uniqueFindings = new Map([...record.findings, ...findings].map((finding) => [canonicalJson(finding), finding]));
  const allFindings = [...uniqueFindings].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, finding]) => finding);
  if (allFindings.length) sections.push(`<section class="findings"><h3>Collection and rendering findings</h3><pre>${escapeHtml(canonicalJson(allFindings))}</pre></section>`);
  return { html: `<article id="${recordAnchor(record.key)}" data-record-digest="${rawSha256}">${sections.join("\n")}</article>`, findings };
}

export function analyzeRecord(record: ArchiveRecord, timezone: string): RenderFinding[] {
  return renderRecord(record, timezone).findings;
}

export function htmlPage(title: string, body: string): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'none'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>\n`;
}
