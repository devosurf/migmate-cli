import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../../src/engine/store/digest.ts";
import { teamsArchiveDriver } from "../../src/engine/drivers/teams-archive.ts";
import type {
  ArchiveCommit,
  ArchiveConfig,
  ArchiveDriverContext,
  ArchiveDurableAsset,
  ArchivePackageFile,
  ArchiveResumeState,
} from "../../src/engine/providers/archive.ts";
import { QualificationBlocked, privatePathOwned } from "./common.ts";

export interface ArchiveFileProof {
  sha256: string;
  size: number;
}

export type ArchiveJournalUnit = Omit<ArchiveCommit, "assets" | "archiveFiles"> & {
  archiveFileProofs?: { path: string; sha256: string; size: number }[];
};

type Resume = ArchiveDriverContext["resume"] & ArchiveResumeState;

function requireFact(value: unknown, gate: string): asserts value {
  if (!value) throw new QualificationBlocked(gate);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  requireFact(privatePathOwned(info, "directory"), "archive_private_directory_required");
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  await directory(path);
}

async function archiveTarget(root: string, path: string): Promise<string> {
  requireFact(
    path.length > 0 &&
      !isAbsolute(path) &&
      !/[\\\u0000-\u001f\u007f:%?#]/u.test(path) &&
      path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "archive_path_unconfined",
  );
  let parent = root;
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    await ensureDirectory(parent);
  }
  return join(root, path);
}

export async function archiveFileProof(path: string): Promise<ArchiveFileProof> {
  const before = await lstat(path);
  requireFact(before.isFile() && !before.isSymbolicLink(), "archive_regular_file_required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    requireFact(
      opened.isFile() && opened.ino === before.ino && opened.dev === before.dev,
      "archive_file_changed",
    );
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    const after = await handle.stat();
    requireFact(
      after.size === size &&
        opened.size === size &&
        opened.mtimeMs === after.mtimeMs &&
        opened.ctimeMs === after.ctimeMs,
      "archive_file_changed",
    );
    return { sha256: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
}

/** Private disposable driver durability boundary. Provider effects are never replaced. */
export class ArchiveJournal {
  readonly path: string;
  readonly archiveRoot: string;
  readonly #jobDirectory: string;
  readonly #signal: AbortSignal;

  private constructor(jobDirectory: string, signal: AbortSignal) {
    this.#jobDirectory = resolve(jobDirectory);
    this.#signal = signal;
    this.path = join(this.#jobDirectory, "archive-qualification.jsonl");
    this.archiveRoot = join(this.#jobDirectory, "archive");
  }

  static async create(jobDirectory: string, signal: AbortSignal): Promise<ArchiveJournal> {
    const journal = new ArchiveJournal(jobDirectory, signal);
    await directory(journal.#jobDirectory);
    await ensureDirectory(journal.archiveRoot);
    const handle = await open(journal.path, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(journal.#jobDirectory);
    return journal;
  }

  static async reopen(jobDirectory: string, signal: AbortSignal): Promise<ArchiveJournal> {
    const journal = new ArchiveJournal(jobDirectory, signal);
    await directory(journal.#jobDirectory);
    await directory(journal.archiveRoot);
    await journal.units();
    return journal;
  }

  async units(): Promise<ArchiveJournalUnit[]> {
    this.#signal.throwIfAborted();
    const info = await lstat(this.path);
    requireFact(info.isFile() && !info.isSymbolicLink(), "archive_journal_unavailable");
    const text = await readFile(this.path, "utf8");
    requireFact(!text || text.endsWith("\n"), "archive_journal_torn_commit");
    const units: ArchiveJournalUnit[] = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ArchiveJournalUnit);
    requireFact(
      new Set(units.map((unit) => unit.unitKey)).size === units.length,
      "archive_journal_duplicate_commit",
    );
    return units;
  }

  async resume(): Promise<Resume> {
    const units = await this.units();
    const state: Resume = {
      checkpoint: units.at(-1)?.checkpoint ?? null,
      watermarks: {},
      archiveRecords: [],
      archiveEvidence: [],
      committedUnits: [],
    };
    const records = new Map<string, NonNullable<ArchiveResumeState["archiveRecords"]>[number]>();
    for (const unit of units) {
      if (unit.archivePlan) state.archivePlan = unit.archivePlan;
      for (const record of unit.archiveRecords ?? []) {
        const prior = records.get(record.key);
        requireFact(
          !prior || canonicalJson(prior) === canonicalJson(record),
          "archive_journal_record_conflict",
        );
        if (!prior) records.set(record.key, record);
      }
      if (unit.archiveEvidence) state.archiveEvidence!.push(unit.archiveEvidence);
      if (unit.archiveManifestDigest) state.archiveManifestDigest = unit.archiveManifestDigest;
      if (unit.watermark) state.watermarks[unit.watermark.unitKey] = unit.watermark.value;
      state.committedUnits!.push(unit.unitKey);
    }
    state.archiveRecords = [...records.values()];
    return state;
  }

  async #installAsset(asset: ArchiveDurableAsset): Promise<void> {
    const staging = join(this.#jobDirectory, "assets", "staging");
    await directory(join(this.#jobDirectory, "assets"));
    await directory(staging);
    const location = relative(staging, resolve(asset.stagedPath));
    requireFact(
      location.length > 0 &&
        !location.startsWith(`..${sep}`) &&
        location !== ".." &&
        !isAbsolute(location) &&
        !location.includes(sep),
      "archive_staging_unconfined",
    );
    const proof = await archiveFileProof(asset.stagedPath);
    requireFact(
      proof.sha256 === asset.sha256 && proof.size === asset.size,
      "archive_staged_asset_mismatch",
    );
    const staged = await open(asset.stagedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await staged.sync();
    } finally {
      await staged.close();
    }
    const target = await archiveTarget(this.archiveRoot, asset.archivePath);
    let existing = false;
    try {
      const current = await archiveFileProof(target);
      requireFact(
        current.sha256 === asset.sha256 && current.size === asset.size,
        "archive_asset_replay_mismatch",
      );
      existing = true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    if (existing) await rm(asset.stagedPath);
    else await rename(asset.stagedPath, target);
    await syncDirectory(dirname(target));
    await syncDirectory(staging);
  }

  async #installFile(
    file: ArchivePackageFile,
  ): Promise<{ path: string; sha256: string; size: number }> {
    const sha256 = createHash("sha256").update(file.content).digest("hex");
    requireFact(sha256 === file.sha256, "archive_package_file_digest_mismatch");
    const target = await archiveTarget(this.archiveRoot, file.path);
    const temporary = join(dirname(target), `.qualification-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(file.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
      await syncDirectory(dirname(target));
    } finally {
      await rm(temporary, { force: true });
    }
    return { path: file.path, sha256, size: Buffer.byteLength(file.content) };
  }

  async #commit(unit: ArchiveCommit): Promise<void> {
    this.#signal.throwIfAborted();
    for (const asset of unit.assets ?? []) await this.#installAsset(asset);
    // Resolve every reference before the watermark can become durable, including
    // content-addressed assets reused from an earlier committed page.
    for (const record of unit.archiveRecords ?? []) {
      for (const asset of record.assets) {
        const target = await archiveTarget(this.archiveRoot, asset.path);
        const proof = await archiveFileProof(target);
        requireFact(
          proof.sha256 === asset.sha256 && proof.size === asset.size,
          "archive_asset_reference_not_durable",
        );
      }
    }
    const archiveFileProofs = [];
    for (const file of unit.archiveFiles ?? [])
      archiveFileProofs.push(await this.#installFile(file));
    if (unit.archiveManifestDigest) {
      requireFact(
        archiveFileProofs.some(
          (file) => file.path === "manifest.json" && file.sha256 === unit.archiveManifestDigest,
        ),
        "archive_manifest_not_durable",
      );
    }
    const { assets: _assets, archiveFiles: _files, ...durable } = unit;
    const saved: ArchiveJournalUnit = {
      ...durable,
      ...(archiveFileProofs.length ? { archiveFileProofs } : {}),
    };
    const handle = await open(this.path, "a");
    try {
      await handle.writeFile(`${JSON.stringify(saved)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async run(
    phase: "plan" | "execute",
    config: ArchiveConfig,
    provider: ArchiveDriverContext["provider"],
    stopAfterPage = false,
  ): Promise<boolean> {
    // Every invocation, especially restart, reconstructs the approved plan,
    // records, page evidence and watermarks from the actual fsynced journal.
    const resume = await this.resume();
    const committed = new Set(resume.committedUnits);
    const context: ArchiveDriverContext = {
      config,
      provider,
      resume,
      revision: 1,
      jobDirectory: this.#jobDirectory,
      signal: this.#signal,
      now: () => new Date(),
    };
    const iterator =
      phase === "plan" ? teamsArchiveDriver.collect(context) : teamsArchiveDriver.execute(context);
    try {
      for (;;) {
        this.#signal.throwIfAborted();
        const next = await iterator.next();
        if (next.done) return false;
        requireFact(!committed.has(next.value.unitKey), "archive_driver_replayed_committed_unit");
        await this.#commit(next.value);
        committed.add(next.value.unitKey);
        // No generator.next() is reachable until assets, package files and the
        // complete yielded unit have all crossed the durability boundary.
        if (stopAfterPage && next.value.archiveEvidence) return true;
      }
    } finally {
      await iterator.return(undefined);
    }
  }
}
