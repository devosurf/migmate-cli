/**
 * The two versions this release's guarantees are bound to, in one place.
 *
 * - Node is an open floor. The durable store is `node:sqlite`, a release candidate
 *   (stability 1.2) from `24.15.0`; earlier 24.x releases carry 1.1. Every later
 *   release, including later majors, is admitted.
 * - The transfer binary is an exact pin, and widening it is a decision carrying
 *   evidence, not a dependency bump. Its behaviour is observed, not documented:
 *   rclone's `onedrive` backend ignores `root_folder_id` on object lookup, and below
 *   v1.69.0 a unix-socket RC connection skipped its configured authentication.
 *   Migmate's read path is built around what the pinned version does, and v1.75.0
 *   has no `version --json`, for one.
 *
 * Tests assert the literals independently on purpose. A test that imported these
 * constants would agree with any value they were changed to.
 */

/** The minimum Node version, the first carrying the `node:sqlite` release-candidate API. */
export const NODE_FLOOR = "24.15.0";

/** Transfer binary versions whose observed behaviour Migmate's read path rests on. */
export const TESTED_TRANSFER_VERSIONS: Readonly<Record<string, true>> = { "v1.75.0": true };

/** The single transfer binary version vendored in this artifact. */
export const TRANSFER_VERSION = "v1.75.0";

function ordered(version: string): number[] {
  return version.replace(/^v/, "").split(".").map(Number);
}

/**
 * Why this Node runtime is unsupported, or `null` when it is supported. Returns a
 * reason rather than a boolean so every caller reports the same sentence.
 */
export function unsupportedNode(version: string = process.versions.node): string | null {
  const parts = ordered(version);
  const major = parts[0];
  if (major === undefined || !Number.isFinite(major))
    return `Node reported an unreadable version. Migmate supports Node ${NODE_FLOOR} or later.`;
  const floor = ordered(NODE_FLOOR);
  for (let index = 0; index < floor.length; index++) {
    const actual = parts[index] ?? 0;
    const required = floor[index] ?? 0;
    if (actual > required) return null;
    if (actual < required)
      return `Node ${version} is below ${NODE_FLOOR}, the minimum carrying a release-candidate node:sqlite. Migmate supports Node ${NODE_FLOOR} or later.`;
  }
  return null;
}
