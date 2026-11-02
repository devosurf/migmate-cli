import { createHash } from "node:crypto";
import { canonicalJson } from "./store/digest.ts";

/**
 * ADR-0019: acting-account pools. A file job's plan binds the pool configured when it
 * was planned; later additions need their own approval (D3), removals need none, and
 * each pass writes as exactly one approved, still-configured account (D1).
 */

/** Large enough for Google's guidance of many impersonated users, small enough to review. */
export const MAX_POOL_ACCOUNTS = 100;

const EMAIL = /^[^\s@]+@[^\s@]+$/u;

export function normalizeAccount(account: string): string {
  return account.trim().toLowerCase();
}

/** Validated, normalized and in configured order; duplicates are one account named twice. */
export function parseActingAccounts(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_POOL_ACCOUNTS) return null;
  const accounts: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.length > 320) return null;
    const account = normalizeAccount(value);
    if (!EMAIL.test(account) || accounts.includes(account)) return null;
    accounts.push(account);
  }
  return accounts;
}

export interface AccountApproval {
  revision: number;
  planDigest: string;
  /** The reviewed additions, sorted. */
  accounts: string[];
  /** Binds the reviewed proposal; the human never transcribes it (ADR-0016). */
  poolDigest: string;
  approver: string;
  mode: "interactive" | "unattended";
  identityAssurance: "declared_unverified";
  at: string;
}

/** The pool as the job holds it now: what may write, what waits, what left. */
export interface ActingAccountPool {
  /** Configured and approved, in configured order: the accounts passes may write as. */
  active: string[];
  /** Configured but not yet approved: they receive no work. */
  pending: string[];
  /** Approved for this plan but no longer configured: they receive no new pass. */
  removed: string[];
  /** Everything approved for the current plan, sorted. */
  approved: string[];
  /** Binds a review of `pending`; null when nothing waits. */
  poolDigest: string | null;
}

export function poolDigest(revision: number, planDigest: string, additions: string[]): string {
  return createHash("sha256")
    .update(canonicalJson({ revision, planDigest, additions: [...additions].sort() }))
    .digest("hex");
}

export function actingAccountPool(input: {
  configured: string[] | undefined;
  planned: string[] | undefined;
  approvals: AccountApproval[];
  revision: number;
  planDigest: string;
}): ActingAccountPool {
  const approved = new Set([
    ...(input.planned ?? []),
    ...input.approvals
      .filter(
        (approval) =>
          approval.revision === input.revision && approval.planDigest === input.planDigest,
      )
      .flatMap((approval) => approval.accounts),
  ]);
  const configured = input.configured ?? [];
  const pending = configured.filter((account) => !approved.has(account));
  return {
    active: configured.filter((account) => approved.has(account)),
    pending,
    removed: [...approved].filter((account) => !configured.includes(account)).sort(),
    approved: [...approved].sort(),
    poolDigest: pending.length ? poolDigest(input.revision, input.planDigest, pending) : null,
  };
}

/**
 * Live settings each pass admission reads (D3): copy concurrency and the pool, both
 * changeable while a job runs. Null `accounts` is a job without a pool: every pass
 * writes as the job's own identity, as before pools existed.
 */
export interface LiveSettings {
  mappingsInFlight: number;
  transfersPerMapping: number;
  accounts: string[] | null;
}
