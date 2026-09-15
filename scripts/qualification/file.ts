import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  createCredentialSession,
  ProviderFault,
  type CredentialSession,
} from "../../src/engine/providers/credentials.ts";
import { createProductionProvider } from "../../src/engine/providers/production.ts";
import { FileEffects } from "../../src/engine/providers/file-effects.ts";
import { createGraphTransport } from "../../src/engine/providers/http.ts";
import type { BinaryProof } from "../../src/engine/providers/transfer-worker.ts";
import type { DestinationEntry, SourceEntry } from "../../src/engine/providers/port.ts";
import type {
  FileMappingConfig,
  FileMigrationConfig,
} from "../../src/engine/drivers/file-migration.ts";
import {
  hashStream,
  second,
  type FileEvidenceRow,
  type FileState,
} from "../../src/engine/drivers/file-state.ts";
import type { CommitUnit } from "../../src/engine/drivers/types.ts";
import { collisionCodes, fileProbeIds } from "../../src/qualification/bundle.ts";
import type { ProbeCapture } from "../../src/qualification/bundle.ts";
import { canonicalJson, digestJson } from "../../src/engine/store/digest.ts";
import {
  QualificationBlocked,
  qualificationAssertion,
  type QualificationInput,
  type QualificationResult,
} from "./common.ts";
import { FileFixtures, fixtureConfig, identifier, object } from "./file-fixtures.ts";
import { FileJournal, observedCodes } from "./file-journal.ts";
import { fileWorkerQualification } from "./file-worker.ts";

class Facts {
  readonly assertions: ProbeCapture["assertions"] = [];
  expect(id: string, expected: unknown, observed: unknown): void {
    this.assertions.push(qualificationAssertion("file_probe_", id, expected, observed));
  }
}

/** Maintainer-only: real effects under separately acknowledged disposable roots, never a qualification bypass in production. */
export async function runFileQualification(
  input: QualificationInput,
): Promise<QualificationResult> {
  const jobConfig = object(input.config.jobConfig);
  if (!Array.isArray(jobConfig.mappings) || jobConfig.mappings.length !== 1)
    throw new QualificationBlocked("file_one_disposable_mapping_required");
  const rawMapping = object(jobConfig.mappings[0]);
  if (rawMapping.exclusions !== undefined)
    throw new QualificationBlocked("file_fixture_mapping_exclusions_forbidden");
  const rootMapping: FileMappingConfig = {
    id: identifier(rawMapping.id),
    sourceDriveId: identifier(rawMapping.sourceDriveId),
    sourceItemId: identifier(rawMapping.sourceItemId),
    destDriveId: identifier(rawMapping.destDriveId),
    destFolderId: identifier(rawMapping.destFolderId),
  };
  const configured = fixtureConfig(input.config.fixtures, rootMapping);
  const factoryInput = {
    jobType: "file_migration" as const,
    config: jobConfig,
    jobDirectory: input.jobDirectory,
  };
  let session: CredentialSession;
  try {
    session = await createCredentialSession(factoryInput);
  } catch {
    throw new QualificationBlocked("file_live_credential_prerequisites_unavailable");
  }
  const fixtures = new FileFixtures(configured, session, input.jobDirectory, input.signal);
  let provider = createProductionProvider(factoryInput);
  const readback = createProductionProvider(factoryInput);
  const intents = new Map<string, FileState[]>();
  const deferred: string[] = [];
  const suiteStartedAt = new Date().toISOString();
  let sequence = 0;

  async function tagOwned(state: FileState): Promise<void> {
    if (!state.output.id) return;
    const current = await readback.readDestinationObject!({
      driveId: state.output.driveId,
      objectId: state.output.id,
    });
    if (!current) return;
    const expected = (intents.get(state.output.id) ?? []).find(
      (candidate) => canonicalJson(candidate.marker) === canonicalJson(current.provenance),
    );
    if (!expected || !expected.marker.stateRevision || !current.etag)
      throw new QualificationBlocked("file_fixture_materialized_intent_ownership_unproven", {
        objectId: state.output.id,
        candidates: (intents.get(state.output.id) ?? []).length,
        provenanceOnObject: current.provenance === null ? "absent" : "present",
        matchedCandidate: expected !== undefined,
        hasStateRevision: expected?.marker.stateRevision !== undefined,
        hasEtag: current.etag !== null,
      });
    await fixtures.tagDestination(current.id, expected.marker.stateRevision, current.etag);
  }
  async function durable(unit: CommitUnit): Promise<void> {
    for (const row of unit.rows) {
      const state =
        row.jobType === "file_migration" ? (row as FileEvidenceRow).fileState : undefined;
      if (!state?.output.id) continue;
      fixtures.registerIntent(state);
      const records = intents.get(state.output.id) ?? [];
      if (!records.some((candidate) => candidate.attempt === state.attempt)) records.push(state);
      intents.set(state.output.id, records);
      await tagOwned(state);
    }
  }
  async function journal(name: string): Promise<FileJournal> {
    return FileJournal.create(input.jobDirectory, `${++sequence}-${name}`, input.signal, durable);
  }
  async function destination(id: string): Promise<DestinationEntry> {
    const entry = await readback.readDestinationObject!({
      driveId: rootMapping.destDriveId,
      objectId: id,
    });
    if (!entry) throw new QualificationBlocked("file_live_destination_disappeared");
    return entry;
  }
  async function source(id: string): Promise<SourceEntry> {
    const entry = await readback.readSourceItem!({
      driveId: rootMapping.sourceDriveId,
      itemId: id,
    });
    if (!entry) throw new QualificationBlocked("file_live_source_disappeared");
    return entry;
  }
  function emit(
    probeId: string,
    startedAt: string,
    units: readonly CommitUnit[],
    facts: Facts,
    observations: Record<string, unknown>,
    extraCodes: string[] = [],
  ): void {
    input.capture({
      schemaVersion: 1,
      probeId,
      startedAt,
      completedAt: new Date().toISOString(),
      codes: [...new Set([...observedCodes(units), ...extraCodes])].sort(),
      assertions: facts.assertions,
      observations,
    });
  }
  async function inventory(
    parentId: string,
  ): Promise<
    Array<{ id: string; etag: string | null; parentId: string | null; name: string; kind: string }>
  > {
    const result: Array<{
      id: string;
      etag: string | null;
      parentId: string | null;
      name: string;
      kind: string;
    }> = [];
    const parents = [parentId];
    for (const parent of parents) {
      for (const listed of await readback.listDestinationChildren(parent)) {
        const item = await destination(listed.id);
        result.push({
          id: item.id,
          etag: item.etag,
          parentId: item.parentId,
          name: item.name,
          kind: item.kind,
        });
        if (item.kind === "folder") parents.push(item.id);
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  let primary: QualificationBlocked | undefined;
  try {
    input.signal.throwIfAborted();
    await fixtures.initialize();
    const originalIdentity = await provider.applicationIdentity!();
    const rootSource = await fixtures.sourceFolder(
      rootMapping.sourceItemId,
      `migmate-qualification-${fixtures.owner}`,
    );
    const rootDestination = await fixtures.destinationObject(
      rootMapping.destFolderId,
      `migmate-qualification-${fixtures.owner}`,
    );
    async function pair(name: string): Promise<FileMappingConfig> {
      return {
        ...rootMapping,
        id: `qualification-${fixtures.owner}-${name}`,
        sourceItemId: await fixtures.sourceFolder(rootSource, name),
        destFolderId: await fixtures.destinationObject(rootDestination, name),
      };
    }
    const basic = await pair("copy");
    const config: FileMigrationConfig = { mappings: [basic] };
    const binaryBytes = Buffer.alloc(1024);
    for (let index = 0; index < binaryBytes.length; index++) binaryBytes[index] = index % 256;
    const binaryHash = createHash("sha256").update(binaryBytes).digest("hex");
    const binarySource = await fixtures.sourceFile(basic.sourceItemId, "binary.bin", binaryBytes);
    const zeroSource = await fixtures.sourceFile(basic.sourceItemId, "zero.bin", new Uint8Array(0));
    const emptySource = await fixtures.sourceFolder(basic.sourceItemId, "empty");
    const movedParent = await fixtures.sourceFolder(basic.sourceItemId, "moved");
    const retainedSource = await fixtures.sourceFile(
      basic.sourceItemId,
      "retained.bin",
      Buffer.from([0, 255, 0, 128]),
    );
    let main = await journal("copy");
    const firstWorker = await provider.startTransferWorker({
      runDirectory: join(input.jobDirectory, "r"),
    });
    const planned = await main.run("plan", config, provider);
    const interrupted = await main.run("execute", config, provider, binarySource);
    const prepared = await main.state(binarySource);
    const restartFacts = new Facts();
    restartFacts.expect(
      "prepared_intent_committed",
      true,
      interrupted.interrupted && prepared.status === "prepared" && prepared.output.id.length > 0,
    );
    restartFacts.expect(
      "prepared_create_not_materialized",
      null,
      await readback.readDestinationObject!({
        driveId: basic.destDriveId,
        objectId: prepared.output.id,
      }),
    );
    await provider.close!();
    const oldSocket = await lstat(firstWorker.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    restartFacts.expect("interrupted_provider_worker_closed", null, oldSocket);
    provider = createProductionProvider(factoryInput);
    restartFacts.expect(
      "restart_same_application",
      originalIdentity,
      await provider.applicationIdentity!(),
    );
    main = await FileJournal.reopen(main.path, input.jobDirectory, input.signal, durable);
    restartFacts.expect(
      "sqlite_reopened_prepared_intent",
      digestJson(prepared),
      digestJson(await main.state(binarySource)),
    );
    await provider.startTransferWorker({ runDirectory: join(input.jobDirectory, "r") });
    const copied = await main.run("execute", config, provider);
    const binaryState = await main.state(binarySource);
    const zeroState = await main.state(zeroSource);
    const emptyState = await main.state(emptySource);
    const retainedState = await main.state(retainedSource);
    restartFacts.expect("reserved_id_survives_restart", prepared.output.id, binaryState.output.id);
    const copyFacts = new Facts();
    for (const [name, state] of [
      ["binary", binaryState],
      ["zero", zeroState],
      ["empty", emptyState],
    ] as const) {
      copyFacts.expect(`${name}_verified`, "verified", state.status);
    }
    const zero = await destination(zeroState.output.id);
    const empty = await destination(emptyState.output.id);
    const binary = await destination(binaryState.output.id);
    copyFacts.expect("zero_file_size", 0, zero.size);
    copyFacts.expect("zero_file_kind", "file", zero.kind);
    copyFacts.expect(
      "zero_content",
      { sha256: createHash("sha256").digest("hex"), size: 0 },
      await hashStream(readback.streamDestinationContent(zero.id), input.signal),
    );
    copyFacts.expect("empty_folder_kind", "folder", empty.kind);
    copyFacts.expect("empty_folder_children", [], await fixtures.destinationChildren(empty.id));
    copyFacts.expect(
      "binary_bytes",
      { sha256: binaryHash, size: binaryBytes.length },
      await hashStream(readback.streamDestinationContent(binary.id), input.signal),
    );
    emit(
      "zero_byte_and_empty_folder_copy",
      suiteStartedAt,
      [...planned.units, ...interrupted.units, ...copied.units],
      copyFacts,
      {
        zeroByteFile: true,
        emptyFolder: true,
        binarySize: binaryBytes.length,
        binarySha256: binaryHash,
        managedTransferWorkerUsed: true,
      },
    );

    const metadataStartedAt = new Date().toISOString();
    const metadataFacts = new Facts();
    for (const [label, sourceId, state] of [
      ["binary", binarySource, binaryState],
      ["zero", zeroSource, zeroState],
    ] as const) {
      const observedSource = await source(sourceId);
      const observedDestination = await destination(state.output.id);
      metadataFacts.expect(
        `${label}_created_time`,
        Date.parse(observedSource.createdAt),
        Date.parse(observedDestination.createdAt),
      );
      metadataFacts.expect(
        `${label}_modified_time_seconds`,
        second(observedSource.modifiedAt),
        second(observedDestination.modifiedAt),
      );
      metadataFacts.expect(
        `${label}_mime_type`,
        observedSource.mimeType,
        observedDestination.mimeType,
      );
      metadataFacts.expect(`${label}_ordinary_binary`, "file", observedDestination.kind);
    }
    emit("metadata_round_trip", metadataStartedAt, copied.units, metadataFacts, {
      allowlist: ["btime", "mtime", "content-type"],
      modifiedTimePrecision: "seconds",
      nativeConversion: false,
    });

    const markerStartedAt = new Date().toISOString();
    const markerFacts = new Facts();
    markerFacts.expect(
      "fresh_session_same_app",
      originalIdentity,
      await readback.applicationIdentity!(),
    );
    for (const [label, state] of [
      ["file", binaryState],
      ["zero", zeroState],
      ["folder", emptyState],
    ] as const) {
      markerFacts.expect(
        `${label}_private_marker_round_trip`,
        digestJson(state.marker),
        digestJson(await readback.readDestinationMarker(state.output.id)),
      );
    }
    emit("provenance_marker_round_trip", markerStartedAt, copied.units, markerFacts, {
      privatePropertiesReadBySameApplication: true,
      freshProviderSession: true,
      stateRevisionRoundTrip: true,
    });

    const checksumStartedAt = new Date().toISOString();
    const checksumFacts = new Facts();
    const observedSourceHash = await hashStream(
      readback.openSourceContent(binarySource),
      input.signal,
    );
    const observedStreamHash = await hashStream(
      readback.streamDestinationContent(binary.id),
      input.signal,
    );
    checksumFacts.expect(
      "source_graph_sha256",
      { sha256: binaryHash, size: binaryBytes.length },
      observedSourceHash,
    );
    checksumFacts.expect("destination_stream_sha256", observedSourceHash, observedStreamHash);
    checksumFacts.expect("driver_staged_sha256", binaryHash, binaryState.sourceFingerprint);
    // The documented full destination-stream proof qualifies content when Google
    // withholds its SHA-256; absence is not a degraded or unqualified route by itself.
    if (binary.reportedChecksum !== null)
      checksumFacts.expect("google_reported_sha256", binaryHash, binary.reportedChecksum);
    const verified = await main.run("verify", config, readback);
    const verifiedBinary = verified.units
      .flatMap((unit) => unit.rows)
      .find((row) => row.jobType === "file_migration" && row.sourceItemId === binarySource);
    checksumFacts.expect(
      "driver_fresh_verification",
      "verified",
      verifiedBinary?.jobType === "file_migration" ? verifiedBinary.provenanceState : null,
    );
    emit("checksum_fresh_upload", checksumStartedAt, verified.units, checksumFacts, {
      sourceSha256: observedSourceHash.sha256,
      googleSha256: binary.reportedChecksum,
      destinationStreamSha256: observedStreamHash.sha256,
      destinationStreamFallbackExercisedDirectly: true,
      driverMissingChecksumBranchObserved: binary.reportedChecksum === null,
      sourceReadTransport: "graph_v1_content",
      destinationReadTransport: "google_drive_v3_alt_media",
    });

    const rerunUnits: CommitUnit[] = [...interrupted.units, ...copied.units];
    const beforeRerun = await inventory(basic.destFolderId);
    const rerun = await main.run("execute", config, provider);
    rerunUnits.push(...rerun.units);
    restartFacts.expect(
      "unchanged_rerun_no_destination_writes",
      digestJson(beforeRerun),
      digestJson(await inventory(basic.destFolderId)),
    );
    restartFacts.expect(
      "unchanged_rerun_code",
      true,
      observedCodes(rerun.units, binarySource).includes("unchanged"),
    );
    const updatedBytes = Buffer.from([255, 0, 0, 128, 17, 42, 1, 254]);
    await fixtures.updateSource(binarySource, updatedBytes);
    await main.run("plan", config, provider);
    const updated = await main.run("execute", config, provider);
    rerunUnits.push(...updated.units);
    const updatedState = await main.state(binarySource);
    restartFacts.expect("update_stable_source_id", binarySource, updatedState.source.id);
    restartFacts.expect(
      "update_stable_destination_id",
      binaryState.output.id,
      updatedState.output.id,
    );
    restartFacts.expect("update_verified", "verified", updatedState.status);
    restartFacts.expect(
      "update_code",
      true,
      observedCodes(updated.units, binarySource).includes("updated"),
    );
    restartFacts.expect(
      "updated_bytes",
      {
        sha256: createHash("sha256").update(updatedBytes).digest("hex"),
        size: updatedBytes.length,
      },
      await hashStream(readback.streamDestinationContent(updatedState.output.id), input.signal),
    );
    await fixtures.moveSource(binarySource, movedParent, "renamed.bin");
    await main.run("plan", config, provider);
    const moved = await main.run("execute", config, provider);
    rerunUnits.push(...moved.units);
    const movedState = await main.state(binarySource);
    const movedOutput = await destination(movedState.output.id);
    restartFacts.expect("move_stable_destination_id", binaryState.output.id, movedOutput.id);
    restartFacts.expect(
      "move_parent",
      (await main.state(movedParent)).output.id,
      movedOutput.parentId,
    );
    restartFacts.expect("move_name", "renamed.bin", movedOutput.name);
    restartFacts.expect(
      "move_code",
      true,
      observedCodes(moved.units, binarySource).includes("moved"),
    );
    restartFacts.expect(
      "move_marker_round_trip",
      digestJson(movedState.marker),
      digestJson(await readback.readDestinationMarker(movedOutput.id)),
    );
    await fixtures.deleteSource(retainedSource);
    const addedSource = await fixtures.sourceFile(
      basic.sourceItemId,
      "added.bin",
      Buffer.from([0, 1, 2, 255]),
    );
    const destinationOnly = await fixtures.destinationObject(
      basic.destFolderId,
      "destination-only.bin",
      "application/octet-stream",
    );
    const retainedBefore = await destination(retainedState.output.id);
    const destinationOnlyBefore = await destination(destinationOnly);
    await main.run("plan", config, provider);
    const additive = await main.run("execute", config, provider);
    rerunUnits.push(...additive.units);
    restartFacts.expect("added_file_verified", "verified", (await main.state(addedSource)).status);
    restartFacts.expect(
      "deleted_source_retained_code",
      true,
      observedCodes(additive.units, retainedSource).includes("source_deleted_destination_retained"),
    );
    restartFacts.expect(
      "deleted_source_destination_unchanged",
      digestJson(retainedBefore),
      digestJson(await destination(retainedState.output.id)),
    );
    restartFacts.expect(
      "destination_only_retained_code",
      true,
      observedCodes(additive.units).includes("destination_only_retained"),
    );
    restartFacts.expect(
      "destination_only_unchanged",
      digestJson(destinationOnlyBefore),
      digestJson(await destination(destinationOnly)),
    );
    emit("stable_id_additive_rerun_and_move", suiteStartedAt, rerunUnits, restartFacts, {
      journal: "sqlite_wal_synchronous_full",
      everyCommitClosedBeforeNextGeneratorStep: true,
      preparedIntentRestart: true,
      freshProductionProviderAfterRestart: true,
      reservedDestinationIdReused: true,
      additiveRetention: true,
    });

    const collisionStartedAt = new Date().toISOString();
    const collisionFacts = new Facts();
    const collisionUnits: CommitUnit[] = [];
    const collisionCases: Array<{
      case: string;
      expectedCode: string;
      observedCode: string;
      destinationUnchanged: boolean;
    }> = [];
    async function refusedCase(
      name: string,
      mapping: FileMappingConfig,
      sourceId: string,
      expectedCode: string,
      existing?: FileJournal,
    ): Promise<void> {
      const log = existing ?? (await journal(name));
      const before = await inventory(mapping.destFolderId);
      const plan = await log.run("plan", { mappings: [mapping] }, provider);
      const execute = await log.run("execute", { mappings: [mapping] }, provider);
      collisionUnits.push(...plan.units, ...execute.units);
      const codes = observedCodes(execute.units, sourceId);
      collisionFacts.expect(`${name}_refusal`, true, codes.includes(expectedCode));
      const unchanged = digestJson(before) === digestJson(await inventory(mapping.destFolderId));
      collisionFacts.expect(`${name}_no_mutation`, true, unchanged);
      collisionCases.push({
        case: name,
        expectedCode,
        observedCode: expectedCode,
        destinationUnchanged: unchanged,
      });
    }
    const duplicate = await pair("duplicate");
    const duplicateSource = await fixtures.sourceFile(
      duplicate.sourceItemId,
      "same.bin",
      binaryBytes,
    );
    await fixtures.destinationObject(
      duplicate.destFolderId,
      "same.bin",
      "application/octet-stream",
    );
    await fixtures.destinationObject(
      duplicate.destFolderId,
      "same.bin",
      "application/octet-stream",
    );
    await refusedCase("duplicate", duplicate, duplicateSource, "destination_duplicate_name");
    for (const [name, mime] of [
      ["folder_type", "application/vnd.google-apps.folder"],
      ["native_type", "application/vnd.google-apps.document"],
      ["shortcut_type", "application/vnd.google-apps.shortcut"],
    ] as const) {
      const mapping = await pair(name);
      const id = await fixtures.sourceFile(mapping.sourceItemId, "same.bin", binaryBytes);
      const target =
        name === "shortcut_type"
          ? await fixtures.destinationObject(
              mapping.destFolderId,
              "target.bin",
              "application/octet-stream",
            )
          : undefined;
      await fixtures.destinationObject(mapping.destFolderId, "same.bin", mime, target);
      await refusedCase(name, mapping, id, "destination_type_conflict");
    }
    const reverseType = await pair("file_type");
    const folderSource = await fixtures.sourceFolder(reverseType.sourceItemId, "same");
    await fixtures.destinationObject(reverseType.destFolderId, "same", "application/octet-stream");
    await refusedCase("file_type", reverseType, folderSource, "destination_type_conflict");
    const unowned = await pair("unowned");
    const unownedSource = await fixtures.sourceFile(unowned.sourceItemId, "same.bin", binaryBytes);
    await fixtures.destinationObject(unowned.destFolderId, "same.bin", "application/octet-stream");
    await refusedCase("unowned", unowned, unownedSource, "unowned_path_collision");
    for (const name of ["prior_drift", "identity_reuse"] as const) {
      const mapping = await pair(name);
      const oldSource = await fixtures.sourceFile(mapping.sourceItemId, "same.bin", binaryBytes);
      const log = await journal(name);
      await log.run("plan", { mappings: [mapping] }, provider);
      await log.run("execute", { mappings: [mapping] }, provider);
      const state = await log.state(oldSource);
      collisionFacts.expect(`${name}_initial_verified`, "verified", state.status);
      let liveSource = oldSource;
      if (name === "prior_drift")
        await fixtures.renameDestination(state.output.id, "operator-renamed.bin");
      else {
        await fixtures.deleteSource(oldSource);
        liveSource = await fixtures.sourceFile(mapping.sourceItemId, "same.bin", binaryBytes);
        collisionFacts.expect("replacement_source_new_identity", true, liveSource !== oldSource);
      }
      await refusedCase(
        name,
        mapping,
        liveSource,
        name === "prior_drift" ? "prior_copy_drift" : "source_identity_reuse_collision",
        log,
      );
    }
    for (const axis of ["source", "destination"] as const) {
      const left = await pair(`overlap-${axis}`);
      const right = await pair(`overlap-${axis}-other`);
      if (axis === "source")
        right.sourceItemId = await fixtures.sourceFolder(left.sourceItemId, "nested");
      else right.destFolderId = await fixtures.destinationObject(left.destFolderId, "nested");
      const log = await journal(`overlap-${axis}`);
      const before = digestJson(await inventory(rootDestination));
      const overlapConfig = { mappings: [left, right] };
      const plan = await log.run("plan", overlapConfig, provider);
      const execute = await log.run("execute", overlapConfig, provider);
      collisionUnits.push(...plan.units, ...execute.units);
      collisionFacts.expect(
        `${axis}_mapping_overlap`,
        true,
        execute.units.filter((unit) =>
          unit.findings.some((finding) => finding.code === "mapping_overlap"),
        ).length === 2,
      );
      collisionFacts.expect(
        `${axis}_mapping_overlap_no_mutation`,
        before,
        digestJson(await inventory(rootDestination)),
      );
    }
    // A separate real provider capacity refusal. It is NEVER substituted for the source-name guard below.
    const capacity = await pair("provenance-capacity");
    capacity.id = randomBytes(8192).toString("base64url");
    const capacitySource = await fixtures.sourceFile(
      capacity.sourceItemId,
      "valid-source-name.bin",
      binaryBytes,
    );
    await refusedCase(
      "private_provenance_capacity",
      capacity,
      capacitySource,
      "path_unrepresentable",
    );

    const specialStartedAt = new Date().toISOString();
    const routeFacts = new Facts();
    const routeUnits: CommitUnit[] = [];
    const omissionCases: Array<{ kind: string; code: string }> = [];
    const specialDestination = await fixtures.destinationObject(
      rootDestination,
      "source-route-limits",
    );
    const specialIds = configured.specialSources;
    let liveSourcePathProven = false;
    const selected = Object.values(specialIds);
    if (selected.length) {
      const liveChildren = await provider.listSourceChildren(rootMapping.sourceItemId);
      const specialMapping = {
        ...rootMapping,
        id: `qualification-${fixtures.owner}-source-limits`,
        destFolderId: specialDestination,
        exclusions: liveChildren
          .filter((child) => !selected.includes(child.id))
          .map((child) => ({
            sourceItemId: child.id,
            reason: "Not selected for read-only source route-limit observation",
          })),
      };
      const log = await journal("source-limits");
      const observed = await log.run("plan", { mappings: [specialMapping] }, provider);
      routeUnits.push(...observed.units);
      for (const [key, kind, expectedCode] of [
        ["packageId", "package", "source_package_omitted"],
        ["referenceId", "reference", "source_reference_omitted"],
        ["undownloadableId", "undownloadable", "source_content_unavailable"],
      ] as const) {
        const id = specialIds[key];
        if (!id) continue;
        const actual = await source(id);
        routeFacts.expect(`${kind}_source_kind`, kind, actual.kind);
        routeFacts.expect(
          `${kind}_omission`,
          true,
          observedCodes(observed.units, id).includes(expectedCode),
        );
        omissionCases.push({ kind, code: expectedCode });
      }
      if (specialIds.pathUnrepresentableId) {
        const actual = await source(specialIds.pathUnrepresentableId);
        const invalidName =
          actual.name.length === 0 ||
          actual.name === "." ||
          actual.name === ".." ||
          /[\/\\\u0000]/u.test(actual.name);
        liveSourcePathProven =
          invalidName && observedCodes(observed.units, actual.id).includes("path_unrepresentable");
        if (liveSourcePathProven) {
          collisionUnits.push(...observed.units);
          collisionFacts.expect(
            "live_source_path_refusal",
            "path_unrepresentable",
            observedCodes(observed.units, actual.id).find(
              (code) => code === "path_unrepresentable",
            ),
          );
        }
      }
    }
    const rejectedNameStatus = await fixtures.rejectedSourceName(rootSource);
    routeFacts.expect("sharepoint_illegal_name_rejection", 400, rejectedNameStatus);
    if (!liveSourcePathProven)
      deferred.unshift("file_live_path_unrepresentable_fixture_unavailable");
    for (const key of ["packageId", "referenceId", "undownloadableId"] as const) {
      if (!specialIds[key])
        deferred.push(
          `file_live_${key === "packageId" ? "package" : key === "referenceId" ? "reference" : "undownloadable"}_fixture_unavailable`,
        );
    }
    const allCollisionCodes = observedCodes(collisionUnits);
    collisionFacts.expect(
      "reachable_collision_codes",
      true,
      collisionCodes.every((code) => allCollisionCodes.includes(code)),
    );
    emit("collision_matrix", collisionStartedAt, collisionUnits, collisionFacts, {
      cases: collisionCases,
      mappingOverlapAxes: ["source", "destination"],
      sourcePathProof: liveSourcePathProven ? "live_source_entry" : "unavailable",
      fullLiveMatrix: liveSourcePathProven,
      privateProvenanceCapacityRefusal: {
        code: "path_unrepresentable",
        cause: "private_provenance_capacity",
        sourceNameValid: true,
      },
      sourceIllegalNameGraphStatus: rejectedNameStatus,
      graphRejectionIsNotDriverPathProof: true,
    });

    const graph = createGraphTransport(session);
    const effects = new FileEffects({
      config: jobConfig,
      session,
      graph,
      worker: {
        async *read(item) {
          yield* graph.stream(
            `/v1.0/drives/${encodeURIComponent(item.driveId)}/root:/${item.path
              .split("/")
              .map((segment) => encodeURIComponent(segment))
              .join("/")}:/content`,
          );
        },
      },
    });
    const providerChecks: Array<{
      status: string;
      code: string | null;
      capabilities?: Record<string, unknown>;
    }> = [];
    const providerCodes: string[] = [];
    for await (const check of effects.preflight()) {
      if (check.code) providerCodes.push(check.code);
      if (check.status === "fail")
        throw new QualificationBlocked("file_live_provider_capability_probe_failed");
      const evidence = check.evidence;
      const capabilities: Record<string, unknown> = {};
      for (const key of [
        "binaryUpload",
        "emptyFolder",
        "privateProperties",
        "createdTime",
        "modifiedTime",
        "mimeType",
        "checksumReported",
        "destinationStreamProof",
        "trustworthy",
        "limit",
        "usage",
      ]) {
        if (Object.hasOwn(evidence, key)) capabilities[key] = evidence[key];
      }
      providerChecks.push({ status: check.status, code: check.code ?? null, capabilities });
    }
    routeFacts.expect(
      "real_provider_capabilities",
      true,
      providerChecks.some((check) => check.capabilities?.destinationStreamProof === true),
    );
    const binaryProof = (await provider.binaryEvidence!()) as unknown as BinaryProof;
    if (!session.rcloneConfigPath)
      throw new QualificationBlocked("file_live_rclone_config_unavailable");
    const workerProof = await fileWorkerQualification({
      jobDirectory: input.jobDirectory,
      configPath: session.rcloneConfigPath,
      binary: binaryProof,
      signal: input.signal,
    });
    routeFacts.assertions.push(...workerProof.assertions);
    emit(
      "route_limits_and_version_gate",
      specialStartedAt,
      routeUnits,
      routeFacts,
      {
        providerChecks,
        omissions: omissionCases,
        sourceIllegalNameStatus: rejectedNameStatus,
        sourceMutationIdentitySeparate: true,
        routeSourceApplicationReadOnly: true,
        ...workerProof.observations,
      },
      [...providerCodes, ...workerProof.codes],
    );
    if (deferred.length) throw new QualificationBlocked(deferred[0]!);
    return {
      tuple: {
        jobType: "file_migration",
        source: {
          system: "sharepoint_document_library",
          backend: {
            type: "onedrive",
            driveType: "documentLibrary",
            authentication: "client_credentials",
            encoding: "Slash",
          },
        },
        destination: {
          system: "google_shared_drive",
          backend: {
            type: "drive",
            authentication: "service_account",
            importFormats: [],
            skipGdocs: true,
            skipShortcuts: true,
            metadata: ["btime", "mtime", "content-type"],
          },
        },
        transferVersion: binaryProof.version,
        guaranteeSetId: typeof jobConfig.guarantees === "string" ? jobConfig.guarantees : "default",
        desktopCell: `${process.platform}-${process.arch}`,
      },
      requiredProbes: [...fileProbeIds],
      binarySha256: binaryProof.sha256,
    };
  } catch (error) {
    primary =
      error instanceof QualificationBlocked
        ? error
        : input.signal.aborted
          ? new QualificationBlocked("file_live_qualification_aborted")
          : error instanceof ProviderFault
            ? new QualificationBlocked(`file_live_${error.code}`, { evidence: error.evidence })
            : new QualificationBlocked("file_live_effect_or_observation_failed", {
                reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
              });
    throw primary;
  } finally {
    let cleanup: unknown;
    const record = (error: unknown): void => {
      cleanup ??= error;
    };
    // A create may have succeeded before a lost response: claim only an exact durable marker at its reserved ID.
    for (const records of intents.values()) {
      try {
        await tagOwned(records.at(-1)!);
      } catch (error) {
        record(error);
      }
    }
    for (const close of [provider.close!, readback.close!, () => fixtures.cleanup()]) {
      try {
        await close();
      } catch (error) {
        record(error);
      }
    }
    session.dispose();
    // Throwing here would discard the failure that caused the teardown, which
    // is the one the operator needs. Report cleanup only when nothing else failed.
    if (cleanup !== undefined && !primary) {
      throw cleanup instanceof QualificationBlocked
        ? cleanup
        : new QualificationBlocked("file_fixture_cleanup_incomplete");
    }
  }
}
