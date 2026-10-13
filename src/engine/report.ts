import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { setImmediate } from "node:timers/promises";

/** Repeatable evidence collections: traversal never retains prior entries. */
export class ReportArray {
  readonly entries: () => Iterable<unknown>;
  constructor(entries: () => Iterable<unknown>) {
    this.entries = entries;
  }
}

/** A section remains a JSON string in the report, without constructing that string. */
export class ReportText {
  readonly chunks: () => Iterable<string>;
  constructor(chunks: () => Iterable<string>) {
    this.chunks = chunks;
  }
}

export function* reportJson(
  value: unknown,
  canonical = true,
  pretty = false,
  depth = 0,
  seen = new Set<object>(),
): Generator<string> {
  if (value instanceof ReportText) {
    yield '"';
    for (const chunk of value.chunks()) yield JSON.stringify(chunk).slice(1, -1);
    yield '"';
    return;
  }
  if (value === null || typeof value !== "object" || value instanceof Date) {
    const text =
      typeof value === "bigint" ? JSON.stringify(value.toString()) : JSON.stringify(value);
    if (text === undefined)
      throw new TypeError("Cannot serialize a value without a JSON representation");
    yield text;
    return;
  }
  if (seen.has(value)) throw new TypeError("Cannot serialize circular report data");
  seen.add(value);
  const array = Array.isArray(value) || value instanceof ReportArray;
  yield array ? "[" : "{";
  let first = true;
  const entries: Iterable<[string | undefined, unknown]> = array
    ? (function* () {
        for (const item of value instanceof ReportArray ? value.entries() : (value as unknown[]))
          yield [undefined, item] as [undefined, unknown];
      })()
    : (canonical ? Object.keys(value).sort() : Object.keys(value)).map((key) => [
        key,
        (value as Record<string, unknown>)[key],
      ]);
  for (const [key, item] of entries) {
    if (
      key !== undefined &&
      (item === undefined || typeof item === "function" || typeof item === "symbol")
    )
      continue;
    if (!first) yield ",";
    if (pretty) yield `\n${"  ".repeat(depth + 1)}`;
    if (key !== undefined) yield `${JSON.stringify(key)}:${pretty ? " " : ""}`;
    yield* reportJson(item === undefined ? null : item, canonical, pretty, depth + 1, seen);
    first = false;
  }
  if (pretty && !first) yield `\n${"  ".repeat(depth)}`;
  yield array ? "]" : "}";
  seen.delete(value);
}

export function* escapeReportHtml(chunks: Iterable<string>): Generator<string> {
  for (const chunk of chunks)
    yield chunk
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
}

/** Writes and hashes bounded buffers, including correct handling of short writes. */
export async function writeReportArtifact(path: string, chunks: Iterable<string>): Promise<string> {
  const fd = openSync(path, "wx", 0o600);
  const hash = createHash("sha256");
  let buffered = "";
  const flush = () => {
    const bytes = Buffer.from(buffered);
    for (let offset = 0; offset < bytes.length;)
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    hash.update(bytes);
    buffered = "";
  };
  try {
    for (const chunk of chunks) {
      buffered += chunk;
      if (buffered.length >= 64 * 1024) {
        flush();
        // Long reports must not starve the writer lease heartbeat.
        await setImmediate();
      }
    }
    if (buffered) flush();
    fsyncSync(fd);
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export function hashReportArtifact(path: string): string {
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const hash = createHash("sha256");
  try {
    for (;;) {
      const length = readSync(fd, buffer, 0, buffer.length, null);
      if (!length) return hash.digest("hex");
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(fd);
  }
}
