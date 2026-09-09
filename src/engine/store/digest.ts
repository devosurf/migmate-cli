import { createHash } from "node:crypto";

function canonicalize(value: unknown, seen: WeakSet<object>): string | undefined {
  if (value === null) {
    return "null";
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "object": {
      if (seen.has(value)) {
        throw new TypeError("Cannot digest circular data");
      }
      seen.add(value);

      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const entry = canonicalize(value[index], seen);
          items.push(entry === undefined ? "null" : entry);
        }
        seen.delete(value);
        return `[${items.join(",")}]`;
      }

      const keys = Object.keys(value).sort();
      const entries: string[] = [];
      for (const key of keys) {
        const entry = canonicalize((value as Record<string, unknown>)[key], seen);
        if (entry !== undefined) {
          entries.push(`${JSON.stringify(key)}:${entry}`);
        }
      }
      seen.delete(value);
      return `{${entries.join(",")}}`;
    }
    default:
      return undefined;
  }
}

export function canonicalJson(value: unknown): string {
  const serialized = canonicalize(value, new WeakSet<object>());
  if (serialized === undefined) {
    throw new TypeError("Cannot digest a value without a JSON representation");
  }
  return serialized;
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
