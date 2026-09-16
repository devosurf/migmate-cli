import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { writeConversationContainer } from "../../src/engine/archive/container.ts";
import type { ArchiveDestinationState } from "../../src/engine/archive/destination.ts";
import { hashStream, markerMatches } from "../../src/engine/drivers/file-state.ts";
import type { ArchiveConfig } from "../../src/engine/providers/archive.ts";
import { createProductionProvider } from "../../src/engine/providers/production.ts";
import { digestJson } from "../../src/engine/store/digest.ts";
import type { ProbeCapture } from "../../src/qualification/bundle.ts";
import { ArchiveJournal, archiveFileProof } from "./archive-journal.ts";
import { QualificationBlocked, qualificationAssertion, type QualificationInput } from "./common.ts";

/** Real driver, durable restart and live Drive reads; captures contain no object identities. */
export async function qualifyArchiveDestination(
  input: QualificationInput,
  config: ArchiveConfig,
): Promise<ProbeCapture> {
  const startedAt = new Date().toISOString();
  const assertions: ProbeCapture["assertions"] = [];
  const expect = (id: string, expected: unknown, observed: unknown) => {
    assertions.push(qualificationAssertion("archive_destination_", id, expected, observed));
  };
  if (!config.destination) throw new QualificationBlocked("archive_destination_required");
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
    if (!durable.archivePlan) throw new QualificationBlocked("archive_destination_plan_missing");
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
    const temporary = await mkdtemp(join(input.jobDirectory, "container-proof-"));
    try {
      for (const state of states.values()) {
        input.signal.throwIfAborted();
        const entry = await provider.readDestinationObject!({
          driveId: destination.destDriveId,
          objectId: state.output.id,
        });
        if (!entry || !entry.revision || !markerMatches(entry.provenance, state.marker))
          throw new QualificationBlocked("archive_destination_live_identity_or_marker_mismatch");
        const downloaded = await hashStream(
          provider.streamDestinationContent(entry.id),
          input.signal,
        );
        if (downloaded.sha256 !== state.output.sha256 || downloaded.size !== state.output.size)
          throw new QualificationBlocked("archive_destination_downloaded_bytes_mismatch");
        const container = state.path.startsWith("conversations/");
        outputs.push({ kind: container ? "container" : "root", ...downloaded });
        if (!container) continue;
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
          throw new QualificationBlocked("archive_destination_live_container_not_deterministic");
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
    await journal.run("execute", config, provider);
    inventoryDigest = digestJson(before);
    expect(
      "rerun_preserves_object_ids_revisions_and_markers",
      inventoryDigest,
      digestJson(await inventory()),
    );
    await provider.close!();
    provider = createProductionProvider({
      jobType: "teams_archive",
      config: input.config.jobConfig,
      jobDirectory: input.jobDirectory,
      mode: "archive_verification",
    });
    journal = await ArchiveJournal.reopen(input.jobDirectory, input.signal);
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
    },
  };
}
