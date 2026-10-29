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

/** Restore the public evidence shape while path pages remain on disk. */
export function readReportSettlement(
  db: DatabaseSync,
  revision: number,
  mappingId: string,
): unknown {
  const query =
    "SELECT value AS document FROM watermark WHERE rev=? AND unit_key=? AND json_extract(value,'$.revision')=?";
  const params = [revision, `file-settle:${mappingId}`, revision];
  const state = readReportJson(db, query, params) as Record<string, unknown> | undefined;
  if (!state) return state;
  if (state.observations === undefined) return state;
  return {
    ...state,
    observations: new ReportArray(function* () {
      for (const row of db
        .prepare(`SELECT key FROM json_each((SELECT document FROM (${query})),'$.observations')`)
        .iterate(...params)) {
        const index = Number(row.key);
        const observation = readReportJson(
          db,
          `SELECT json_extract(document,?) AS document FROM (${query})`,
          [`$.observations[${index}]`, ...params],
        ) as Record<string, unknown>;
        const { changedPathPages, ...evidence } = observation;
        if (typeof changedPathPages === "number") {
          evidence.changedPaths = new ReportArray(function* () {
            for (let page = 0; page < changedPathPages; page++) {
              for (const path of db
                .prepare(
                  "SELECT j.value FROM watermark w,json_each(w.value) j WHERE w.rev=? AND w.unit_key=? ORDER BY j.key",
                )
                .iterate(revision, `file-settle-paths:${mappingId}:${index}:${page}`))
                yield String(path.value);
            }
          });
        }
        yield evidence;
      }
    }),
  };
}

/** One mapping entry, whether coverage was stored in one legacy row or bounded pages. */
export function reportCoverage(db: DatabaseSync, revision: number): ReportArray {
  return new ReportArray(function* () {
    for (const row of db
      .prepare(
        "SELECT mapping_id,MIN(id) AS id FROM item WHERE rev=? AND phase='verify' AND json_type(payload,'$.fileScope.verification') IS NOT NULL GROUP BY mapping_id ORDER BY MIN(id)",
      )
      .iterate(revision)) {
      const mappingId = String(row.mapping_id);
      const verification = readReportJson(
        db,
        "SELECT json_remove(json_extract(payload,'$.fileScope.verification'),'$.sourceInventory') AS document FROM item WHERE rev=? AND phase='verify' AND id=?",
        [revision, String(row.id)],
      ) as Record<string, unknown>;
      yield {
        mappingId,
        ...verification,
        ...(verification.coveredPaths === undefined
          ? {}
          : {
              coveredPaths: new ReportArray(function* () {
                for (const page of db
                  .prepare(
                    "SELECT id FROM item WHERE rev=? AND phase='verify' AND mapping_id=? AND json_type(payload,'$.fileScope.verification') IS NOT NULL ORDER BY CASE WHEN json_valid(id) THEN COALESCE(json_extract(id,'$[4]'),0) ELSE 0 END,id",
                  )
                  .iterate(revision, mappingId)) {
                  for (const path of db
                    .prepare(
                      "SELECT j.value FROM item i,json_each(i.payload,'$.fileScope.verification.coveredPaths') j WHERE i.rev=? AND i.phase='verify' AND i.id=? ORDER BY j.key",
                    )
                    .iterate(revision, String(page.id)))
                    yield String(path.value);
                }
              }),
            }),
      };
    }
  });
}
