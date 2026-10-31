import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  createTransferSupervisor,
  type TransferSupervisor,
} from "../../src/engine/providers/transfer-worker.ts";
import { object } from "./file-fixtures.ts";
import {
  LiveTestBlocked,
  liveAssertion,
  type LiveTestInput,
  type LiveTestResult,
} from "./common.ts";
import { dropboxFileProbeIds, type ProbeCapture } from "./probes.ts";

export function dropboxProbeConfig(config: Record<string, unknown>) {
  const job = object(config.jobConfig);
  const rclone = object(job.rclone);
  const reference = object(rclone.config);
  const fixture = object(config.dropboxProbe);
  const text = (value: unknown, pattern: RegExp): string => {
    if (typeof value !== "string" || !pattern.test(value))
      throw new LiveTestBlocked("dropbox_probe_configuration_invalid");
    return value;
  };
  const path = (value: unknown): string => {
    const result = text(value, /^[^\x00-\x1f\\:]+$/);
    if (result.split("/").some((part) => !part || part === "." || part === ".."))
      throw new LiveTestBlocked("dropbox_probe_configuration_invalid");
    return result;
  };
  if (
    job.sourceProvider !== "dropbox" ||
    job.destinationProvider !== "google_shared_drive" ||
    reference.resolver !== "file"
  )
    throw new LiveTestBlocked("dropbox_probe_configuration_invalid");
  const paperPath = path(fixture.paperPath);
  if (!paperPath.endsWith(".paper"))
    throw new LiveTestBlocked("dropbox_probe_paper_sample_required");
  return {
    configPath: resolve(text(reference.path, /\S/)),
    sourceRemote: text(rclone.sourceRemote, /^[A-Za-z0-9_-]+$/),
    destinationRemote: text(rclone.destinationRemote, /^[A-Za-z0-9_-]+$/),
    adminMemberId: text(fixture.adminMemberId, /^dbmid:[A-Za-z0-9_-]+$/),
    namespaceId: text(fixture.namespaceId, /^[0-9]+$/),
    destDriveId: text(fixture.destDriveId, /^[A-Za-z0-9_-]+$/),
    destFolderId: text(fixture.destFolderId, /^[A-Za-z0-9_-]+$/),
    filePath: path(fixture.filePath),
    paperPath,
  };
}

/** Provider hashes are not interchangeable: Dropbox's block hash is never used here. */
export function dropboxHashMatch(
  source: { sha256: string; md5: string },
  hashes: Record<string, unknown>,
): "sha256" | "md5" {
  const sha256 = hashes["SHA-256"];
  const md5 = hashes.MD5;
  if (sha256 !== undefined && sha256 !== "") {
    if (
      typeof sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(sha256) &&
      sha256.toLowerCase() === source.sha256
    )
      return "sha256";
  } else if (
    typeof md5 === "string" &&
    /^[a-f0-9]{32}$/i.test(md5) &&
    md5.toLowerCase() === source.md5
  ) {
    return "md5";
  }
  throw new LiveTestBlocked("dropbox_probe_content_unverified");
}

/** Pinned backend qualification only; does not claim production-engine or legacy Paper coverage. */
export async function runDropboxFileLiveTest(
  input: LiveTestInput,
  dependencies: {
    createSupervisor: (
      options: Parameters<typeof createTransferSupervisor>[0],
    ) => Pick<TransferSupervisor, "proveBinary" | "close">;
    spawn: (
      binary: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv; signal: AbortSignal; stdio: ["ignore", "pipe", "ignore"] },
    ) => Pick<ChildProcess, "once"> & { stdout: Readable };
  } = { createSupervisor: createTransferSupervisor, spawn },
): Promise<LiveTestResult> {
  const config = dropboxProbeConfig(input.config);
  const privateConfig = join(input.jobDirectory, "dropbox-rclone.conf");
  await copyFile(config.configPath, privateConfig);
  await chmod(privateConfig, 0o600);
  const supervisor = dependencies.createSupervisor({
    configPath: privateConfig,
    jobDirectory: input.jobDirectory,
  });
  const proof = await supervisor.proveBinary();
  const assertions: ProbeCapture["assertions"] = [];
  const expect = (id: string, expected: unknown, observed: unknown) =>
    assertions.push(liveAssertion("dropbox_probe_", id, expected, observed));
  expect("pinned_version", "v1.75.0", proof.version);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("RCLONE_")),
  );
  async function run(
    args: string[],
    signal = input.signal,
    consume?: (bytes: Buffer) => void,
  ): Promise<string> {
    const { promise, resolve: accept, reject } = Promise.withResolvers<string>();
    const child = dependencies.spawn(
      proof.path,
      [...args, "--config", privateConfig, "--ask-password=false", "--log-level", "ERROR"],
      {
        env,
        signal,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (bytes: Buffer) => (consume ? consume(bytes) : chunks.push(bytes)));
    child.once("error", () => reject(new LiveTestBlocked("dropbox_probe_command_failed")));
    child.once("close", (code) =>
      code === 0
        ? accept(Buffer.concat(chunks).toString("utf8"))
        : reject(new LiveTestBlocked("dropbox_probe_command_failed")),
    );
    return promise;
  }
  async function childEntry(
    parent: string,
    name: string,
    gate: string,
    signal = input.signal,
  ): Promise<Record<string, unknown>> {
    const listing: unknown = JSON.parse(await run(["lsjson", parent], signal));
    if (!Array.isArray(listing)) throw new LiveTestBlocked(gate);
    const matches = listing.map(object).filter((entry) => entry.Name === name);
    if (matches.length !== 1) throw new LiveTestBlocked(gate);
    return matches[0]!;
  }
  const source = `${config.sourceRemote},impersonate_admin="${config.adminMemberId}",impersonate=,root_namespace=${config.namespaceId},shared_folders=false,shared_files=false,export_formats=html,skip_exports=false,show_all_exports=false:`;
  const destination = `${config.destinationRemote},team_drive=${config.destDriveId},root_folder_id=${config.destFolderId}:`;
  const root = `migmate-live-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  let created = false;
  let rootId: unknown;
  try {
    const remotes = object(JSON.parse(await run(["config", "dump"])));
    expect("dropbox_backend", "dropbox", object(remotes[config.sourceRemote]).type);
    expect("drive_backend", "drive", object(remotes[config.destinationRemote]).type);
    // Exact stat cannot resolve non-downloadable originals in v1.75.0.
    // Listing their parent with show_all_exports exposes the original entry.
    const paperParts = config.paperPath.split("/");
    const paperName = paperParts.pop()!;
    const original = await childEntry(
      source.replace("show_all_exports=false", "show_all_exports=true") + paperParts.join("/"),
      paperName,
      "dropbox_probe_paper_original_ambiguous",
    );
    expect("paper_original_file", false, original.IsDir);
    expect("paper_is_export", -1, original.Size);
    expect("paper_original_name", config.paperPath.split("/").at(-1), original.Name);
    const ordinary = object(JSON.parse(await run(["lsjson", source + config.filePath, "--stat"])));
    expect(
      "ordinary_downloadable_file",
      true,
      ordinary.IsDir === false && typeof ordinary.Size === "number" && ordinary.Size >= 0,
    );
    const exported = object(
      JSON.parse(await run(["lsjson", source + config.paperPath.slice(0, -6) + ".html", "--stat"])),
    );
    expect("paper_html_export", true, exported.IsDir === false && exported.Size === -1);
    await run(["mkdir", destination + root]);
    created = true;
    const folder = await childEntry(
      destination,
      root,
      "dropbox_probe_destination_identity_missing",
    );
    rootId = folder.ID;
    if (folder.IsDir !== true || typeof rootId !== "string" || !rootId)
      throw new LiveTestBlocked("dropbox_probe_destination_identity_missing");
    const samples = [];
    for (const [kind, sourcePath, name] of [
      ["file", config.filePath, "ordinary.bin"],
      ["paper", config.paperPath.slice(0, -6) + ".html", "paper.html"],
    ] as const) {
      const target = `${destination}${root}/${name}`;
      await run(["copyto", source + sourcePath, target]);
      const sha256 = createHash("sha256");
      const md5 = createHash("md5");
      let size = 0;
      await run(["cat", source + sourcePath], input.signal, (bytes) => {
        sha256.update(bytes);
        md5.update(bytes);
        size += bytes.length;
      });
      const sourceHashes = { sha256: sha256.digest("hex"), md5: md5.digest("hex") };
      const copied = object(JSON.parse(await run(["lsjson", target, "--stat", "--hash"])));
      const algorithm = dropboxHashMatch(sourceHashes, object(copied.Hashes));
      expect(`${kind}_size`, size, copied.Size);
      expect(`${kind}_hash_verified`, true, true);
      if (kind === "paper") expect("paper_html_name", "paper.html", copied.Name);
      samples.push({ kind, algorithm, sourceSha256: sourceHashes.sha256, bytes: size });
    }
    input.capture({
      schemaVersion: 1,
      probeId: dropboxFileProbeIds[0],
      startedAt,
      completedAt: new Date().toISOString(),
      codes: [],
      assertions,
      observations: {
        version: proof.version,
        samples,
        sourceMode: "select_admin_namespace",
        sharedFolders: false,
      },
    });
    return { requiredProbes: [...dropboxFileProbeIds] };
  } finally {
    try {
      if (created) {
        const signal = AbortSignal.timeout(60_000);
        const current = await childEntry(
          destination,
          root,
          "dropbox_probe_cleanup_identity_changed",
          signal,
        );
        if (!rootId || current.IsDir !== true || current.ID !== rootId)
          throw new LiveTestBlocked("dropbox_probe_cleanup_identity_changed");
        await run(["purge", destination + root], signal);
      }
    } finally {
      await supervisor.close();
    }
  }
}
