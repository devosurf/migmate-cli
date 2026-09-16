/**
 * The two versions this release's guarantees are bound to, in one place.
 *
 * Both are deliberately narrow rather than open ranges, and widening either one is a
 * decision carrying evidence, not a dependency bump:
 *
 * - The durable store is `node:sqlite`. That module is a release candidate (stability
 *   1.2), never stable, so its behaviour is only claimed for majors actually tested.
 *   `24.15.0` is where it reached 1.2; earlier 24.x releases carry 1.1.
 * - The transfer binary version is an element of the qualified route tuple, so a
 *   captured bundle is evidence about that exact executable. Accepting a later rclone
 *   would leave published evidence describing a binary no longer in use, and the
 *   differences are real: v1.75.0 has no `version --json`, for one.
 *
 * Tests assert the literals independently on purpose. A test that imported these
 * constants would agree with any value they were changed to.
 */

/** Tested Node majors, each with the minimum version carrying the `node:sqlite` RC API. */
export const TESTED_NODE: Readonly<Record<string, string>> = { "24": "24.15.0" };

/** Transfer binary versions whose observed behaviour a qualified route may rest on. */
export const TESTED_TRANSFER_VERSIONS: Readonly<Record<string, true>> = { "v1.75.0": true };

/** The single transfer binary version vendored in this artifact. */
export const TRANSFER_VERSION = "v1.75.0";

function ordered(version: string): number[] {
  return version.replace(/^v/, "").split(".").map(Number);
}

/** The supported Node majors, ascending, for operator-facing messages. */
export function supportedNodeMajors(): string {
  return Object.keys(TESTED_NODE)
    .sort((left, right) => Number(left) - Number(right))
    .join(", ");
}

/**
 * Why this Node runtime is unsupported, or `null` when it is supported. Returns a
 * reason rather than a boolean so every caller reports the same sentence.
 */
export function unsupportedNode(version: string = process.versions.node): string | null {
  const parts = ordered(version);
  const major = parts[0];
  if (major === undefined || !Number.isFinite(major))
    return `Node reported an unreadable version. Migmate supports Node ${supportedNodeMajors()}.`;
  const minimum = TESTED_NODE[String(major)];
  if (minimum === undefined)
    return `Node ${version} is untested. Migmate supports Node ${supportedNodeMajors()}.`;
  const floor = ordered(minimum);
  for (let index = 0; index < floor.length; index++) {
    const actual = parts[index] ?? 0;
    const required = floor[index] ?? 0;
    if (actual > required) return null;
    if (actual < required)
      return `Node ${version} is below ${minimum}, the minimum carrying a release-candidate node:sqlite.`;
  }
  return null;
}
