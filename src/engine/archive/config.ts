import type { ArchiveConfig, ArchiveScope } from "../providers/archive.ts";

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function id(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${name} must be a stable identifier`);
  return value;
}
function utc(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be a UTC timestamp`);
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) throw new TypeError(`${name} is not a calendar date`);
  return normalized;
}
function flag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}
export function parseArchiveConfig(value: unknown): ArchiveConfig {
  const input = object(value, "archive config");
  if (input.cloud !== undefined && input.cloud !== "Global") throw new TypeError("Teams archive supports Global only");
  if (!Array.isArray(input.scopes) || input.scopes.length === 0) throw new TypeError("scopes must explicitly select channels, teams, or users by stable ID");
  const scopes: ArchiveScope[] = input.scopes.map((value, index) => {
    const scope = object(value, `scopes[${index}]`);
    switch (scope.kind) {
      case "channel": return { kind: "channel", teamId: id(scope.teamId, "teamId"), channelId: id(scope.channelId, "channelId") };
      case "team": return { kind: "team", teamId: id(scope.teamId, "teamId") };
      case "user-chats": return { kind: "user-chats", userId: id(scope.userId, "userId") };
      default: throw new TypeError("Unknown archive scope kind");
    }
  });
  const keys = scopes.map((scope) => JSON.stringify(scope));
  if (new Set(keys).size !== keys.length) throw new TypeError("Duplicate archive scope");
  scopes.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  const timezone = input.timezone === undefined ? "UTC" : id(input.timezone, "timezone");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0); } catch { throw new TypeError("timezone must be an IANA timezone"); }
  const requestedWindow = input.window === undefined ? {} : object(input.window, "window");
  const window: ArchiveConfig["window"] = { from: requestedWindow.from === undefined ? "0001-01-01T00:00:00.000Z" : utc(requestedWindow.from, "window.from") };
  if (requestedWindow.to !== undefined) window.to = utc(requestedWindow.to, "window.to");
  if (window.to !== undefined && window.from >= window.to) throw new TypeError("window must have from < to");
  const config: ArchiveConfig = { scopes, cloud: "Global", timezone, window, retainedHistory: flag(input.retainedHistory, "retainedHistory"), transcripts: flag(input.transcripts, "transcripts"), attachmentBytes: flag(input.attachmentBytes, "attachmentBytes") };
  if (config.transcripts && !scopes.some((scope) => scope.kind === "user-chats")) throw new TypeError("transcripts require at least one explicitly scoped organizer user");
  if (input.lineage !== undefined) {
    const lineage = object(input.lineage, "lineage");
    if (typeof lineage.reportDigest !== "string" || !/^[a-f0-9]{64}$/u.test(lineage.reportDigest)) throw new TypeError("lineage.reportDigest must be SHA-256");
    config.lineage = { jobId: id(lineage.jobId, "lineage.jobId"), reportDigest: lineage.reportDigest, to: utc(lineage.to, "lineage.to") };
  }
  return config;
}
