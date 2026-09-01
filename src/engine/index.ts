/**
 * Engine entry point. Internal: absent from `package.json` exports, imported by
 * the CLI and webview adapters by relative path in the same process.
 *
 * The concrete wiring of store, lease, and drivers lands here once those slices
 * exist; the seam itself is declared in `engine.ts`.
 */

export type { Engine, JobReader, JobWriter, EngineOptions, ReclaimDecision } from "./engine.ts";
export * from "./types.ts";

import type { Engine, EngineOptions } from "./engine.ts";

export function openEngine(_opts: EngineOptions): Engine {
  throw new Error("openEngine: wiring not yet assembled");
}
