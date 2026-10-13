import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ReportArray, ReportText } from "../report.ts";

/** Large nested inventories stay repeatable database-backed arrays, not resume objects. */
export function readReportJson(db: DatabaseSync, query: string, params: SQLInputValue[]): unknown {
  function read(path: string): unknown {
    const value = db
      .prepare(
        `SELECT json_type(document,?) AS type, CASE WHEN length(json_extract(document,?)) < 65536 OR json_type(document,?) NOT IN ('array','object','text') THEN json_extract(document,?) END AS value FROM (${query})`,
      )
      .get(path, path, path, path, ...params);
    if (!value || value.type === null) return undefined;
    if (value.type === "true") return true;
    if (value.type === "false") return false;
    if (value.type === "text" && value.value === null)
      return new ReportText(function* () {
        const statement = db.prepare(
          `SELECT substr(json_extract(document,?),?,16384) AS chunk FROM (${query})`,
        );
        for (let offset = 1; ; offset += 16384) {
          const chunk = String(statement.get(path, offset, ...params)?.chunk ?? "");
          if (!chunk) return;
          yield chunk;
        }
      });
    if (value.type !== "array" && value.type !== "object") return value.value;
    if (typeof value.value === "string") return JSON.parse(value.value);
    if (value.type === "array")
      return new ReportArray(function* () {
        for (const entry of db
          .prepare(
            `SELECT key,type,CASE WHEN type NOT IN ('array','object','text') OR length(value)<65536 THEN value END AS value FROM json_each((SELECT document FROM (${query})),?)`,
          )
          .iterate(...params, path)) {
          if (entry.type === "true") yield true;
          else if (entry.type === "false") yield false;
          else if (entry.type === "array" || entry.type === "object")
            yield typeof entry.value === "string"
              ? JSON.parse(entry.value)
              : read(`${path}[${entry.key}]`);
          else if (entry.type === "text" && entry.value === null)
            yield read(`${path}[${entry.key}]`);
          else yield entry.value;
        }
      });
    const result: Record<string, unknown> = {};
    for (const entry of db
      .prepare(`SELECT key FROM json_each((SELECT document FROM (${query})),?)`)
      .iterate(...params, path)) {
      const key = String(entry.key);
      result[key] = read(`${path}.${JSON.stringify(key)}`);
    }
    return result;
  }
  return read("$");
}
