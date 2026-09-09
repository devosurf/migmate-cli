import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, posix } from "node:path";
import type { ArchivePackageInput, ArchivePackageResult, ArchiveVerificationFinding } from "../providers/archive.ts";
import { canonicalJson } from "../store/digest.ts";
import type { ConversationManifest, ManifestAsset, ManifestRecord } from "./package.ts";
import { parseHtml, recordAnchor, visibleUrl, type HtmlNode } from "./render.ts";

function safePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !/[\\\u0000-\u001f\u007f:%?#]/.test(path) && path.split("/").every((piece) => piece !== "" && piece !== "." && piece !== "..");
}

/** Refuse symlinks at every package component. No untrusted manifest path is
 * opened. The handle/inode and realpath checks bracket open; O_NOFOLLOW also
 * refuses a leaf replacement. Same-user filesystem races are outside the
 * archive's accepted local-host threat model, but never intentionally followed. */
async function openConfined(root: string, path: string): Promise<FileHandle> {
  if (!safePath(path)) throw new Error("unconfined_path");
  let target = root;
  const pieces = path.split("/");
  for (const [index, piece] of pieces.entries()) {
    target = join(target, piece);
    const info = await lstat(target);
    if (info.isSymbolicLink() || (index < pieces.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error("symlink_or_nonregular_path");
  }
  const canonical = await realpath(target);
  const inside = relative(root, canonical);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("unconfined_realpath");
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const current = await lstat(target);
    if (!opened.isFile() || current.isSymbolicLink() || current.ino !== opened.ino || current.dev !== opened.dev || await realpath(target) !== canonical) throw new Error("path_changed_during_open");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function verifyPackageFiles(root: string, input: ArchivePackageInput & { manifestDigest: string }, expected: ArchivePackageResult): Promise<ArchiveVerificationFinding[]> {
  const findings: ArchiveVerificationFinding[] = [];
  const report = (code: string, subjectId: string, evidence: Record<string, unknown>): void => { findings.push({ code, subjectId, evidence }); };
  if (input.manifestDigest !== expected.manifestDigest) report("manifest_digest_mismatch", "manifest.json", { reason: "durable_manifest_digest_disagrees_with_collection", expected: expected.manifestDigest, durable: input.manifestDigest });
  let directory: string;
  try {
    const info = await lstat(resolve(root));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("archive_root_is_not_a_real_directory");
    directory = await realpath(root);
  } catch (error) {
    report("manifest_digest_mismatch", "archive", { reason: "archive_root_unavailable", detail: error instanceof Error ? error.message : String(error) });
    return findings;
  }
  const expectedFiles = new Map(expected.files.map((file) => [file.path, file]));
  const durableRecords = new Map(input.records.map((record) => [record.key, record]));
  const expectedAnchors = new Map(input.records.map((record) => [recordAnchor(record.key), record]));
  const expectedParts = new Map<string, ManifestRecord[]>();
  const expectedAssets = new Map<string, ManifestAsset>();
  const expectedRecordLocations = new Map<string, { path: string; digest: string; anchor: string }>();
  for (const file of expected.files) {
    if (file.path === "manifest.json" || !file.path.endsWith("/manifest.json")) continue;
    const manifest = JSON.parse(file.content) as ConversationManifest;
    for (const part of manifest.parts) {
      expectedParts.set(part.jsonl.path, part.records);
      for (const record of part.records) expectedRecordLocations.set(record.key, { path: part.html.path, digest: record.rawSha256, anchor: record.anchor });
    }
    for (const asset of manifest.assets) expectedAssets.set(asset.path, asset);
  }
  const expectedDirectories = new Set<string>();
  for (const path of [...expectedFiles.keys(), ...expectedAssets.keys()]) {
    let parent = posix.dirname(path);
    while (parent !== ".") { expectedDirectories.add(parent); parent = posix.dirname(parent); }
  }
  const encountered = new Set<string>();
  const readable = new Set<string>();
  const scan = async (path: string): Promise<void> => {
    const absolute = path ? join(directory, path) : directory;
    let entries;
    try {
      const info = await lstat(absolute);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("symlink_or_non_directory");
      const canonical = await realpath(absolute);
      const inside = relative(directory, canonical);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("unconfined_directory");
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      report("manifest_digest_mismatch", path || "archive", { reason: "directory_unreadable", detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (!safePath(child) || entry.isSymbolicLink()) {
        encountered.add(child);
        report(child.includes("/assets/") ? "asset_digest_mismatch" : "manifest_digest_mismatch", child, { reason: "unconfined_or_symlink_path" });
      } else if (entry.isDirectory()) {
        if (!expectedDirectories.has(child)) report(child.includes("/assets") ? "asset_digest_mismatch" : "manifest_digest_mismatch", child, { reason: "orphan_directory" });
        await scan(child);
      }
      else {
        encountered.add(child);
        if (entry.isFile()) readable.add(child);
        else report(child.includes("/assets/") ? "asset_digest_mismatch" : "manifest_digest_mismatch", child, { reason: "nonregular_package_file" });
      }
    }
  };
  await scan("");
  for (const path of encountered) {
    if (!expectedFiles.has(path) && !expectedAssets.has(path)) report(path.includes("/assets/") ? "asset_digest_mismatch" : "manifest_digest_mismatch", path, { reason: path.includes("/assets/") ? "orphan_asset" : "orphan_package_file" });
  }
  const jsonlCounts = new Map<string, number>();
  const htmlCounts = new Map<string, number>();
  const mappedCounts = new Map<string, number>();
  const actualLines = new Map<string, { raw: unknown; digest: string }[]>();
  const actualMappings: { path: string; line: number; key: string; rawSha256: unknown; anchor: unknown }[] = [];
  const inspectHtml = (path: string, content: string): void => {
    const parsed = parseHtml(content, true);
    if (parsed.errors.length) report("page_parse_failed", path, { reason: "html5_parse_errors", errors: parsed.errors });
    const ids = new Set<string>();
    const walk = (nodes: HtmlNode[]): void => {
      for (const node of nodes) {
        if (node.kind !== "element") continue;
        const attribute = (name: string): string | undefined => node.attributes.find((entry) => entry.name === name)?.value;
        const id = attribute("id");
        if (id !== undefined) {
          if (ids.has(id)) report("page_parse_failed", path, { reason: "duplicate_html_id", id });
          ids.add(id);
        }
        if (["script", "style", "iframe", "object", "embed", "base", "link", "form", "input", "button"].includes(node.name) || node.name.startsWith("foreign:")) report("page_parse_failed", path, { reason: "unsafe_html_element", tag: node.name, offset: node.offset });
        for (const entry of node.attributes) {
          if (entry.name.startsWith("on") || ["style", "srcdoc", "srcset", "action", "formaction", "background", "ping"].includes(entry.name)) report("page_parse_failed", path, { reason: "unsafe_html_attribute", tag: node.name, attribute: entry.name, offset: node.offset });
          if (entry.name === "href" || entry.name === "src") {
            if (entry.name === "href" && visibleUrl(entry.value)) continue;
            const hashIndex = entry.value.indexOf("#");
            const target = hashIndex === -1 ? entry.value : entry.value.slice(0, hashIndex);
            const resolved = posix.normalize(posix.join(posix.dirname(path), target));
            if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.includes("\\") || !safePath(resolved) || (!expectedFiles.has(resolved) && !expectedAssets.has(resolved))) report("page_parse_failed", path, { reason: "unsafe_or_unreconciled_local_link", attribute: entry.name, target: entry.value });
            if (entry.name === "src" && !expectedAssets.has(resolved)) report("page_parse_failed", path, { reason: "nonasset_load", target: entry.value });
          }
        }
        if (id?.startsWith("record-")) {
          const record = expectedAnchors.get(id);
          if (!record) report("record_count_mismatch", path, { reason: "uncollected_html_record", anchor: id });
          else {
            htmlCounts.set(record.key, (htmlCounts.get(record.key) ?? 0) + 1);
            const expectedDigest = expectedRecordLocations.get(record.key)?.digest;
            if (node.name !== "article" || attribute("data-record-digest") !== expectedDigest) report("record_unrendered", record.key, { reason: "record_anchor_identity_mismatch", path, expectedDigest, actualDigest: attribute("data-record-digest") ?? null });
            if (expectedRecordLocations.get(record.key)?.path !== path) report("record_unrendered", record.key, { reason: "record_anchor_in_wrong_page", path });
          }
        } else if (node.name === "article" || attribute("data-record-digest") !== undefined) report("record_count_mismatch", path, { reason: "html_record_without_collected_anchor", anchor: id ?? null });
        walk(node.children);
      }
    };
    walk(parsed.nodes);
  };
  const inspectManifest = (path: string, content: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch { report("manifest_digest_mismatch", path, { reason: "manifest_not_json" }); return; }
    const manifest = object(parsed);
    if (!manifest) { report("manifest_digest_mismatch", path, { reason: "manifest_not_object" }); return; }
    if (path === "manifest.json") return;
    if (!Array.isArray(manifest.parts)) { report("record_count_mismatch", path, { reason: "parts_missing_from_manifest" }); return; }
    for (const value of manifest.parts) {
      const part = object(value);
      const jsonl = object(part?.jsonl);
      const html = object(part?.html);
      if (!part || !jsonl || !html || typeof jsonl.path !== "string" || typeof html.path !== "string" || !safePath(jsonl.path) || !safePath(html.path) || !expectedParts.has(jsonl.path) || !expectedFiles.has(html.path) || !Array.isArray(part.records)) {
        report("manifest_digest_mismatch", path, { reason: "invalid_or_unconfined_part_descriptor" }); continue;
      }
      if (part.count !== part.records.length) report("record_count_mismatch", path, { reason: "manifest_part_count_disagrees", part: jsonl.path, count: part.count ?? null, mapped: part.records.length });
      for (const entry of part.records) {
        const record = object(entry);
        if (!record || typeof record.key !== "string" || !Number.isSafeInteger(record.line) || Number(record.line) < 1) { report("record_count_mismatch", path, { reason: "invalid_record_mapping" }); continue; }
        mappedCounts.set(record.key, (mappedCounts.get(record.key) ?? 0) + 1);
        if (!durableRecords.has(record.key)) report("record_count_mismatch", record.key, { reason: "manifest_key_not_collected", path });
        actualMappings.push({ path: jsonl.path, line: Number(record.line), key: record.key, rawSha256: record.rawSha256, anchor: record.anchor });
      }
    }
  };
  const paths = [...new Set([...expectedFiles.keys(), ...readable].filter((path) => !expectedAssets.has(path)))].sort();
  for (const path of paths) {
    const file = expectedFiles.get(path);
    if (!readable.has(path)) {
      if (file) report(path.endsWith(".html") ? "page_parse_failed" : path.endsWith(".jsonl") ? "record_count_mismatch" : "manifest_digest_mismatch", path, { reason: "package_file_missing_or_unsafe" });
      continue;
    }
    // Unknown asset bytes are never parsed as HTML/JSON and are never loaded.
    if (!file && path.includes("/assets/")) continue;
    if (!file && !path.endsWith(".html") && !path.endsWith(".jsonl")) continue;
    let content: string;
    let digest: string;
    try {
      const handle = await openConfined(directory, path);
      try {
        const bytes = await handle.readFile();
        digest = createHash("sha256").update(bytes).digest("hex");
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } finally { await handle.close(); }
    } catch (error) {
      report(path.endsWith(".html") ? "page_parse_failed" : "manifest_digest_mismatch", path, { reason: "package_file_unreadable", detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (file && digest !== file.sha256) report("manifest_digest_mismatch", path, { reason: "file_digest_disagrees_with_durable_collection", expected: file.sha256, actual: digest });
    if (path === "manifest.json" && digest !== input.manifestDigest) report("manifest_digest_mismatch", path, { reason: "root_manifest_digest_disagrees", expected: input.manifestDigest, actual: digest });
    if (path.endsWith(".html")) inspectHtml(path, content);
    else if (path.endsWith("/manifest.json") || path === "manifest.json") inspectManifest(path, content);
    else if (path.endsWith(".jsonl")) {
      const expectedRecords = expectedParts.get(path) ?? [];
      const lines = content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (lines.length !== expectedRecords.length || (content.length > 0 && !content.endsWith("\n"))) report("record_count_mismatch", path, { reason: "jsonl_count_or_termination_mismatch", expected: expectedRecords.length, actual: lines.length });
      const parsedLines: { raw: unknown; digest: string }[] = [];
      for (const [index, line] of lines.entries()) {
        let raw: unknown;
        try { raw = JSON.parse(line); }
        catch { report("record_count_mismatch", path, { reason: "invalid_jsonl_record", line: index + 1 }); parsedLines.push({ raw: null, digest: "" }); continue; }
        const canonical = canonicalJson(raw);
        const digest = createHash("sha256").update(canonical).digest("hex");
        parsedLines.push({ raw, digest });
        const record = expectedRecords[index];
        if (!record) report("record_count_mismatch", path, { reason: "uncollected_jsonl_record", line: index + 1 });
        else {
          jsonlCounts.set(record.key, (jsonlCounts.get(record.key) ?? 0) + 1);
          if (line !== canonical || digest !== record.rawSha256 || object(raw)?.id !== record.messageId) report("record_count_mismatch", record.key, { reason: "canonical_record_identity_mismatch", path, line: index + 1, expected: record.rawSha256, actual: digest });
        }
      }
      actualLines.set(path, parsedLines);
    }
  }
  const occupiedLines = new Set<string>();
  for (const mapping of actualMappings) {
    const identity = `${mapping.path}:${mapping.line}`;
    if (occupiedLines.has(identity)) report("record_duplicated", mapping.key, { reason: "multiple_keys_claim_same_jsonl_line", path: mapping.path, line: mapping.line });
    occupiedLines.add(identity);
    const line = actualLines.get(mapping.path)?.[mapping.line - 1];
    const record = durableRecords.get(mapping.key);
    const location = expectedRecordLocations.get(mapping.key);
    if (!line || !record || mapping.rawSha256 !== line.digest || line.digest !== location?.digest || object(line.raw)?.id !== record.messageId || mapping.anchor !== location?.anchor) report("record_count_mismatch", mapping.key, { reason: "durable_key_raw_record_mapping_mismatch", path: mapping.path, line: mapping.line });
  }
  for (const [path, lines] of actualLines) {
    for (const index of lines.keys()) if (!occupiedLines.has(`${path}:${index + 1}`)) report("record_count_mismatch", path, { reason: "jsonl_record_without_durable_key_mapping", line: index + 1 });
  }
  for (const record of input.records) {
    const rendered = htmlCounts.get(record.key) ?? 0;
    const structured = jsonlCounts.get(record.key) ?? 0;
    const mapped = mappedCounts.get(record.key) ?? 0;
    if (rendered === 0) report("record_unrendered", record.key, { reason: "missing_record_anchor" });
    if (structured !== 1 || mapped !== 1) report("record_count_mismatch", record.key, { jsonlOccurrences: structured, manifestMappings: mapped });
    if (rendered > 1 || structured > 1 || mapped > 1) report("record_duplicated", record.key, { htmlOccurrences: rendered, jsonlOccurrences: structured, manifestMappings: mapped });
  }
  for (const [path, asset] of expectedAssets) {
    if (!readable.has(path)) { report("asset_missing", path, { reason: "referenced_asset_missing_or_unsafe", expectedSize: asset.size, expectedSha256: asset.sha256 }); continue; }
    try {
      const handle = await openConfined(directory, path);
      try {
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); size += chunk.length; }
        const digest = hash.digest("hex");
        if (digest !== asset.sha256 || size !== asset.size) report("asset_digest_mismatch", path, { expectedSha256: asset.sha256, actualSha256: digest, expectedSize: asset.size, actualSize: size });
      } finally { await handle.close(); }
    } catch (error) { report("asset_missing", path, { reason: "asset_unreadable_or_unconfined", detail: error instanceof Error ? error.message : String(error) }); }
  }
  // Collection failures are not made clean by reproducing an incomplete
  // package. Their durable evidence survives independent local verification.
  for (const finding of expected.findings) if (finding.code === "message_collection_incomplete") findings.push(finding);
  const unique = new Map(findings.map((finding) => [canonicalJson(finding), finding]));
  return [...unique].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, finding]) => finding);
}
