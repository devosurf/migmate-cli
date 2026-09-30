import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { writeConversationContainer } from "../../src/engine/archive/container.ts";
import type { ArchiveDestinationState } from "../../src/engine/archive/destination.ts";
import { conversationPath, verifyArchivePackage } from "../../src/engine/archive/package.ts";
import { markerMatches } from "../../src/engine/drivers/file-state.ts";
import type {
  ArchiveConfig,
  ArchivePackageInput,
  ArchiveRecord,
} from "../../src/engine/providers/archive.ts";
import { createProductionProvider } from "../../src/engine/providers/production.ts";
import { digestJson } from "../../src/engine/store/digest.ts";
import type { ProbeCapture } from "./probes.ts";
import { ArchiveJournal, archiveFileProof } from "./archive-journal.ts";
import { LiveTestBlocked, liveAssertion, type LiveTestInput } from "./common.ts";

const exec = promisify(execFile);

interface RetainedVersionProof {
  kind: "standard" | "private" | "chat";
  matchedMessages: number;
  currentVersions: number;
  retainedVersions: number;
  versionsDigest: string;
}

/** Match changed text bodies, not merely route metadata differences, within one message identity. */
function changedRetainedVersions(input: ArchivePackageInput) {
  const classes = ["standard", "private", "chat"] as const;
  const conversations = new Map(
    input.plan.conversations.map((conversation) => [conversation.id, conversation]),
  );
  const groups = new Map<
    string,
    { kind: RetainedVersionProof["kind"]; current: ArchiveRecord[]; retained: ArchiveRecord[] }
  >();
  const bodyDigest = (record: ArchiveRecord): string | null => {
    const body = record.raw.body;
    if (!body || typeof body !== "object" || !("content" in body)) return null;
    if (typeof body.content !== "string" || !body.content.trim()) return null;
    return digestJson(body.content);
  };
  for (const record of input.records) {
    if (record.route !== "messages" && record.route !== "retained") continue;
    const conversation = conversations.get(record.conversationId);
    if (!conversation) continue;
    const kind =
      conversation.kind === "chat"
        ? "chat"
        : conversation.membershipType === "private"
          ? "private"
          : conversation.membershipType === "standard"
            ? "standard"
            : null;
    if (!kind) continue;
    const identity = digestJson([record.conversationId, record.messageId]);
    let group = groups.get(identity);
    if (!group) {
      group = { kind, current: [], retained: [] };
      groups.set(identity, group);
    }
    group[record.route === "messages" ? "current" : "retained"].push(record);
  }
  return classes.map((kind) => {
    let matchedMessages = 0;
    const current = new Map<string, ArchiveRecord>();
    const retained = new Map<string, ArchiveRecord>();
    for (const group of groups.values()) {
      if (group.kind !== kind) continue;
      let matched = false;
      for (const present of group.current) {
        const presentBody = bodyDigest(present);
        if (presentBody === null) continue;
        for (const prior of group.retained) {
          const priorBody = bodyDigest(prior);
          if (priorBody === null || presentBody === priorBody) continue;
          current.set(present.key, present);
          retained.set(prior.key, prior);
          matched = true;
        }
      }
      if (matched) matchedMessages++;
    }
    return {
      kind,
      matchedMessages,
      currentVersions: current.size,
      retainedVersions: retained.size,
      versionsDigest: digestJson(
        [...current.values(), ...retained.values()]
          .map((record) => digestJson([record.route, record.raw]))
          .sort(),
      ),
    };
  });
}

/** Real driver, durable restart and live Drive reads; captures contain no object identities. */
export async function testArchiveDestination(
  input: LiveTestInput,
  config: ArchiveConfig,
): Promise<ProbeCapture> {
  const startedAt = new Date().toISOString();
  const assertions: ProbeCapture["assertions"] = [];
  const expect = (id: string, expected: unknown, observed: unknown) => {
    assertions.push(liveAssertion("archive_destination_", id, expected, observed));
  };
  if (!config.destination) throw new LiveTestBlocked("archive_destination_required");
  const destination = config.destination;
  let journal = await ArchiveJournal.reopen(input.jobDirectory, input.signal);
  const openProvider = () =>
    createProductionProvider({
      jobType: "teams_archive",
      config: input.config.jobConfig,
      jobDirectory: input.jobDirectory,
    });
  let provider = openProvider();
  const outputs: { kind: "root" | "container"; sha256: string; size: number }[] = [];
  let recoveredIdentityDigest = "";
  let inventoryDigest = "";
  let containerCount = 0;
  let restoredManifestDigest = "";
  let restoredCollectionDigest = "";
  let restoredRecords = 0;
  let restoredAssets = 0;
  let retainedVersions: RetainedVersionProof[] = [];
  try {
    expect(
      "empty_disposable_destination",
      0,
      (await provider.listDestinationChildren(destination.destFolderId)).length,
    );
    await provider.startTransferWorker({ runDirectory: join(input.jobDirectory, "w") });
    expect(
      "interrupted_after_live_upload",
      true,
      await journal.run("execute", config, provider, "destination_upload"),
    );
    const checkpoint = await journal.resume();
    const prepared =
      checkpoint.rows?.flatMap((row) =>
        row.jobType === "teams_archive" && row.archiveDestination ? [row.archiveDestination] : [],
      ) ?? [];
    expect(
      "only_prepared_identity_durable",
      ["prepared"],
      prepared.map((state) => state.status),
    );
    const reserved = prepared[0]!;
    const uploaded = await provider.readDestinationObject!({
      driveId: destination.destDriveId,
      objectId: reserved.output.id,
    });
    expect("reserved_identity_already_uploaded", true, uploaded?.id === reserved.output.id);
    expect(
      "prepared_marker_on_live_copy",
      true,
      markerMatches(uploaded?.provenance ?? null, reserved.marker),
    );
    const checkpointDigest = digestJson(checkpoint);
    await provider.close!();
    journal = await ArchiveJournal.reopen(input.jobDirectory, input.signal);
    expect(
      "restart_preserves_durable_checkpoint",
      checkpointDigest,
      digestJson(await journal.resume()),
    );
    provider = openProvider();
    await provider.startTransferWorker({ runDirectory: join(input.jobDirectory, "w") });
    await journal.run("execute", config, provider);
    const durable = await journal.resume();
    const states = new Map<string, ArchiveDestinationState>();
    for (const row of durable.rows ?? []) {
      if (row.jobType === "teams_archive" && row.phase === "execute" && row.archiveDestination)
        states.set(row.archiveDestination.path, row.archiveDestination);
    }
    if (!durable.archivePlan) throw new LiveTestBlocked("archive_destination_plan_missing");
    containerCount = durable.archivePlan.conversations.length;
    expect(
      "three_root_objects_and_one_container_per_conversation",
      3 + containerCount,
      states.size,
    );
    expect(
      "all_uploads_byte_verified",
      true,
      [...states.values()].every((state) => state.status === "verified"),
    );
    expect(
      "lost_acknowledgement_recovers_same_identity",
      true,
      states.get(reserved.path)?.output.id === reserved.output.id,
    );
    recoveredIdentityDigest = digestJson(reserved.output.id);
    const inventory = async () =>
      (await provider.listDestinationChildren(destination.destFolderId)).sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
    const before = await inventory();
    expect("no_extra_destination_objects", states.size, before.length);
    expect(
      "root_index_shape",
      ["index.csv", "index.html", "manifest.json"],
      [...states.keys()].filter((path) => !path.startsWith("conversations/")).sort(),
    );
    await journal.run("execute", config, provider);
    inventoryDigest = digestJson(before);
    expect(
      "rerun_preserves_object_ids_revisions_and_markers",
      inventoryDigest,
      digestJson(await inventory()),
    );
    await provider.close!();
    const verificationConfig = structuredClone(input.config.jobConfig) as Record<string, unknown>;
    const secrets = { ...(verificationConfig.secrets as Record<string, unknown>) };
    delete secrets.teams_graph_client_secret;
    verificationConfig.secrets = secrets;
    provider = createProductionProvider({
      jobType: "teams_archive",
      config: verificationConfig,
      jobDirectory: input.jobDirectory,
      mode: "archive_verification",
    });
    expect(
      "verification_graph_credential_reference_absent",
      false,
      "teams_graph_client_secret" in secrets,
    );
    journal = await ArchiveJournal.reopen(input.jobDirectory, input.signal);
    const collection = await journal.resume();
    if (
      !collection.archivePlan ||
      !collection.archiveRecords ||
      !collection.archiveEvidence ||
      !collection.archiveManifestDigest
    )
      throw new LiveTestBlocked("archive_destination_completed_collection_missing");
    const packageInput = {
      plan: collection.archivePlan,
      records: collection.archiveRecords,
      evidence: collection.archiveEvidence,
      manifestDigest: collection.archiveManifestDigest,
    };
    const proofDirectory = join(input.jobDirectory, "restored-archive");
    const restoredRoot = join(proofDirectory, "package");
    const downloads = join(proofDirectory, "downloads");
    await mkdir(proofDirectory, { mode: 0o700 });
    await mkdir(restoredRoot, { mode: 0o700 });
    await mkdir(downloads, { mode: 0o700 });
    const expectedPaths = [
      "index.csv",
      "index.html",
      "manifest.json",
      ...packageInput.plan.conversations.map(conversationPath),
    ].sort();
    expect(
      "downloaded_archive_path_inventory",
      digestJson(expectedPaths),
      digestJson([...states.keys()].sort()),
    );
    const temporary = await mkdtemp(join(input.jobDirectory, "container-proof-"));
    try {
      for (const state of states.values()) {
        input.signal.throwIfAborted();
        const entry = await provider.readDestinationObject!({
          driveId: destination.destDriveId,
          objectId: state.output.id,
        });
        if (
          !entry ||
          entry.id !== state.output.id ||
          !entry.revision ||
          entry.revision !== state.revision ||
          !markerMatches(entry.provenance, state.marker)
        )
          throw new LiveTestBlocked("archive_destination_live_identity_or_marker_mismatch");
        const download = join(downloads, `${digestJson(state.path)}.download`);
        await pipeline(
          Readable.from(provider.streamDestinationContent(entry.id)),
          createWriteStream(download, { mode: 0o600, flags: "wx" }),
          { signal: input.signal },
        );
        const downloaded = await archiveFileProof(download);
        if (downloaded.sha256 !== state.output.sha256 || downloaded.size !== state.output.size)
          throw new LiveTestBlocked("archive_destination_downloaded_bytes_mismatch");
        const container = state.path.startsWith("conversations/");
        outputs.push({ kind: container ? "container" : "root", ...downloaded });
        if (!container) {
          await copyFile(download, join(restoredRoot, state.path));
          continue;
        }
        const directory = join(journal.archiveRoot, state.path);
        const first = join(temporary, "first.zip");
        const second = join(temporary, "second.zip");
        await writeConversationContainer(directory, first);
        const firstProof = await archiveFileProof(first);
        for (const path of ["", ...(await readdir(directory, { recursive: true }))])
          await utimes(
            join(directory, path),
            new Date("2000-01-01T00:00:00Z"),
            new Date("2030-12-31T23:59:58Z"),
          );
        await writeConversationContainer(directory, second);
        const secondProof = await archiveFileProof(second);
        if (
          firstProof.sha256 !== downloaded.sha256 ||
          firstProof.size !== downloaded.size ||
          digestJson(firstProof) !== digestJson(secondProof)
        )
          throw new LiveTestBlocked("archive_destination_live_container_not_deterministic");
        const extracted = join(restoredRoot, state.path);
        await mkdir(extracted, { recursive: true, mode: 0o700 });
        try {
          await exec("unzip", ["-q", download, "-d", extracted], { signal: input.signal });
        } catch {
          input.signal.throwIfAborted();
          throw new LiveTestBlocked("archive_destination_container_extraction_failed");
        }
        await rm(first);
        await rm(second);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    expect(
      "live_containers_regenerated_after_metadata_change",
      containerCount,
      outputs.filter((output) => output.kind === "container").length,
    );
    const restoredFindings = await verifyArchivePackage(restoredRoot, packageInput);
    expect(
      "restored_package_verification_findings",
      [],
      restoredFindings.map((finding) => finding.code),
    );
    restoredManifestDigest = packageInput.manifestDigest;
    restoredCollectionDigest = digestJson(packageInput);
    restoredRecords = packageInput.records.length;
    restoredAssets = new Set(
      packageInput.records.flatMap((record) => record.assets.map((asset) => asset.path)),
    ).size;
    expect("all_downloads_restored_from_verified_bytes", states.size, outputs.length);
    if (config.retainedHistory) {
      retainedVersions = changedRetainedVersions(packageInput);
      for (const versions of retainedVersions)
        expect(`${versions.kind}_changed_retained_versions`, true, versions.matchedMessages > 0);
    }
    await journal.run("verify", config, provider);
    const findings = (await journal.units())
      .filter((unit) => unit.phase === "verify")
      .flatMap((unit) => unit.findings);
    expect(
      "local_and_destination_verification_findings",
      [],
      findings.map((finding) => finding.code),
    );
  } finally {
    await provider.close!();
  }
  return {
    schemaVersion: 1,
    probeId: "archive_destination",
    startedAt,
    completedAt: new Date().toISOString(),
    codes: [],
    assertions,
    observations: {
      rootObjects: 3,
      containers: containerCount,
      outputs,
      recoveredIdentityDigest,
      inventoryDigest,
      byteVerification: "download_sha256_and_size",
      containerDeterminism: "live_package_regenerated_with_changed_filesystem_timestamps",
      restart: "live_upload_before_verified_commit",
      verification: "local_package_and_drive_without_graph_credentials",
      sourceSessionClosedBeforeRetrieval: true,
      graphCredentialReferenceRemoved: true,
      reconstruction: "downloaded_roots_and_stock_unzip_at_exact_archive_relative_paths",
      restoredVerificationApi: "verifyArchivePackage(root, reopenedDurableCollection)",
      restoredVerificationFindings: 0,
      restoredManifestDigest,
      restoredCollectionDigest,
      restoredRecords,
      restoredAssets,
      retainedVersions,
    },
  };
}
