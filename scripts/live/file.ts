import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openEngine, type Outcome, type JobRef } from "../../src/engine/index.ts";
import { createCredentialSession } from "../../src/engine/providers/credentials.ts";
import { createProductionProvider } from "../../src/engine/providers/production.ts";
import type { FileMappingConfig } from "../../src/engine/drivers/file-migration.ts";
import {
  fileProbeIds,
  sourceCapabilityKinds,
  weakerProofByKind,
  type ProbeCapture,
} from "./probes.ts";
import {
  LiveTestBlocked,
  liveAssertion,
  type LiveTestInput,
  type LiveTestResult,
} from "./common.ts";
import { FileFixtures, fixtureConfig, identifier, object } from "./file-fixtures.ts";
import { fileWorkerLiveTest } from "./file-worker.ts";
import { runReverseFileLiveTest } from "./file-reverse.ts";

/** Real providers through the production engine: no private driver durability adapter. */
export async function runFileLiveTest(input: LiveTestInput): Promise<LiveTestResult> {
  const jobConfig = object(input.config.jobConfig);
  if (jobConfig.route === "shared_drive_to_sharepoint_library")
    return runReverseFileLiveTest(input);
  if (!Array.isArray(jobConfig.mappings) || jobConfig.mappings.length !== 1)
    throw new LiveTestBlocked("file_one_disposable_mapping_required");
  const raw = object(jobConfig.mappings[0]);
  if (raw.exclusions !== undefined)
    throw new LiveTestBlocked("file_fixture_mapping_exclusions_forbidden");
  const root = {
    id: identifier(raw.id),
    sourceDriveId: identifier(raw.sourceDriveId),
    sourceItemId: identifier(raw.sourceItemId),
    destDriveId: identifier(raw.destDriveId),
    destFolderId: identifier(raw.destFolderId),
  } satisfies FileMappingConfig;
  const configured = fixtureConfig(input.config.fixtures, root);
  const factory = {
    jobType: "file_migration" as const,
    config: jobConfig,
    jobDirectory: input.jobDirectory,
  };
  const session = await createCredentialSession(factory);
  const fixtures = new FileFixtures(configured, session, input.jobDirectory, input.signal);
  const readback = createProductionProvider(factory);
  const home = join(input.jobDirectory, "engine");
  // Keep credentials bound to the acknowledged parent roots; the production
  // provider resolves disposable child mappings through normal overrides.
  let engine = openEngine({ home, provider: createProductionProvider(factory) });
  const copyRoots: string[] = [];
  let failed = false;
  function value<T>(outcome: Outcome<T>): T {
    if (!outcome.ok) throw new LiveTestBlocked(`file_live_${outcome.refusal.code}`);
    return outcome.value;
  }
  function capture(
    probeId: string,
    startedAt: string,
    assertions: ProbeCapture["assertions"],
    observations: Record<string, unknown> = {},
  ): void {
    input.capture({
      schemaVersion: 1,
      probeId,
      startedAt,
      completedAt: new Date().toISOString(),
      assertions,
      observations,
      codes: [],
    });
  }
  async function approved(mappings: FileMappingConfig[]): Promise<JobRef> {
    const ref = value(
      await engine.initJob({
        type: "file_migration",
        config: { ...jobConfig, mappings, options: { verificationMode: "hash" } },
      }),
    );
    value(
      await engine.withWriter(ref, async (writer) => {
        value(await writer.doctor());
        const plan = value(await writer.plan());
        value(
          await writer.approve({
            approver: "disposable-live-probe",
            mode: "unattended",
            planDigest: plan.planDigest,
          }),
        );
      }),
    );
    return ref;
  }
  try {
    await fixtures.initialize();
    const sourceRoot = await fixtures.sourceFolder(
      root.sourceItemId,
      `migmate-live-${fixtures.owner}`,
    );
    const destinationRoot = await fixtures.destinationObject(
      root.destFolderId,
      `migmate-live-${fixtures.owner}`,
    );
    async function pair(name: string): Promise<typeof root> {
      const destination = await fixtures.destinationObject(destinationRoot, name);
      copyRoots.push(destination);
      return {
        ...root,
        id: `live-${name}`,
        sourceItemId: await fixtures.sourceFolder(sourceRoot, name),
        destFolderId: destination,
      };
    }
    const mappings = [await pair("first"), await pair("second")];
    const bytes = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
    for (const mapping of mappings) {
      await fixtures.sourceFile(mapping.sourceItemId, "binary.bin", bytes);
      await fixtures.sourceFile(mapping.sourceItemId, "zero.bin", new Uint8Array());
      await fixtures.sourceFolder(mapping.sourceItemId, "empty");
    }
    const startedAt = new Date().toISOString();
    const ref = await approved(mappings);
    const result = value(
      await engine.withWriterResult(ref, (writer) => writer.execute({ signal: input.signal })),
    );
    const assertions = [
      liveAssertion("file_probe_", "copy_completed", "completed", result.outcome),
    ];
    const verification = value(await engine.withWriterResult(ref, (writer) => writer.verify()));
    assertions.push(
      liveAssertion("file_probe_", "hash_verification_clean", true, verification.clean),
    );
    const status = value(await engine.reader(ref).status());
    assertions.push(
      liveAssertion(
        "file_probe_",
        "both_mapping_passes_completed",
        mappings.map((m) => [m.id, "completed"]),
        status.mappingPasses.map((p) => [p.mappingId, p.status]),
      ),
    );
    for (const [index, mapping] of mappings.entries()) {
      const children = await readback.listDestinationChildren(mapping.destFolderId);
      assertions.push(
        liveAssertion(
          "file_probe_",
          `mapping_${index}_hierarchy`,
          ["binary.bin", "empty", "zero.bin"],
          children.map((c) => c.name).sort(),
        ),
      );
      const empty = children.find((c) => c.name === "empty");
      assertions.push(
        liveAssertion("file_probe_", `mapping_${index}_empty_folder`, "folder", empty?.kind),
      );
      const binary = children.find((c) => c.name === "binary.bin");
      if (!binary) throw new LiveTestBlocked("file_live_binary_missing");
      const hash = createHash("sha256");
      for await (const chunk of readback.streamDestinationContent(binary.id)) hash.update(chunk);
      assertions.push(
        liveAssertion(
          "file_probe_",
          `mapping_${index}_download_hash`,
          createHash("sha256").update(bytes).digest("hex"),
          hash.digest("hex"),
        ),
      );
    }
    const events = [];
    for await (const event of engine.reader(ref).events({})) events.push(event);
    assertions.push(
      liveAssertion(
        "file_probe_",
        "mapping_progress_observed",
        true,
        events.some((event) => event.kind === "mapping_progress"),
      ),
    );
    capture("rclone_mapping_copy_and_hash_verification", startedAt, assertions);

    // Abort on a durably running pass, not a timer or private driver hook. A tiny
    // mapping may finish first; require an observed interrupt rather than claiming it.
    const resumeStartedAt = new Date().toISOString();
    const resumeMapping = await pair("resume");
    await fixtures.sourceFile(
      resumeMapping.sourceItemId,
      "resume.bin",
      Buffer.alloc(8 * 1024 * 1024, 0x5a),
    );
    const resumeRef = await approved([resumeMapping]);
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    let finished = false;
    const execution = engine
      .withWriterResult(resumeRef, (writer) => writer.execute({ signal }))
      .finally(() => {
        finished = true;
      });
    try {
      while (!finished) {
        const current = value(await engine.reader(resumeRef).status());
        if (current.mappingPasses.some((pass) => pass.status === "running")) {
          controller.abort();
          break;
        }
        await delay(10, undefined, { signal: input.signal });
      }
    } catch (error) {
      controller.abort();
      await execution;
      throw error;
    }
    const interrupted = value(await execution);
    const resumeAssertions = [
      liveAssertion("file_probe_", "copy_interrupted", "interrupted", interrupted.outcome),
    ];
    engine.close();
    engine = openEngine({ home, provider: createProductionProvider(factory) });
    const resumed = value(
      await engine.withWriterResult(resumeRef, (writer) =>
        writer.execute({ signal: input.signal }),
      ),
    );
    resumeAssertions.push(
      liveAssertion("file_probe_", "resumed_completed", "completed", resumed.outcome),
    );
    resumeAssertions.push(
      liveAssertion(
        "file_probe_",
        "resumed_hash_verification_clean",
        true,
        value(await engine.withWriterResult(resumeRef, (writer) => writer.verify())).clean,
      ),
    );
    resumeAssertions.push(
      liveAssertion(
        "file_probe_",
        "resume_no_duplicate_files",
        ["resume.bin"],
        (await readback.listDestinationChildren(resumeMapping.destFolderId)).map((c) => c.name),
      ),
    );
    const beforeReplay = value(await engine.reader(resumeRef).status()).mappingPasses;
    value(
      await engine.withWriterResult(resumeRef, (writer) =>
        writer.execute({ signal: input.signal }),
      ),
    );
    resumeAssertions.push(
      liveAssertion(
        "file_probe_",
        "completed_pass_skipped",
        beforeReplay,
        value(await engine.reader(resumeRef).status()).mappingPasses,
      ),
    );
    capture("mapping_interrupt_and_resume", resumeStartedAt, resumeAssertions);

    const routeStartedAt = new Date().toISOString();
    const children = await readback.listSourceChildren({
      driveId: root.sourceDriveId,
      itemId: root.sourceItemId,
    });
    const kinds: Record<string, number> = {
      file: 0,
      folder: 0,
      package: 0,
      reference: 0,
      undownloadable: 0,
    };
    for (const child of children) {
      const kind = child.kind === "file" && !child.downloadable ? "undownloadable" : child.kind;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    const specialIds = configured.specialSources;
    const selected = Object.values(specialIds);
    const specialDestination = await fixtures.destinationObject(destinationRoot, "source-limits");
    const specialRef = value(
      await engine.initJob({
        type: "file_migration",
        config: {
          ...jobConfig,
          mappings: [
            {
              ...root,
              destFolderId: specialDestination,
              exclusions: children
                .filter((c) => !selected.includes(c.id))
                .map((c) => ({ sourceItemId: c.id, reason: "Outside capability sample" })),
            },
          ],
        },
      }),
    );
    value(await engine.withWriterResult(specialRef, (writer) => writer.plan()));
    const rows = value(await engine.reader(specialRef).rows({ phase: "plan", limit: 1000 })).rows;
    const routeAssertions: ProbeCapture["assertions"] = [];
    const proofs: Record<string, string> = {};
    const refusedReference = specialIds.referenceId
      ? null
      : await fixtures.rejectedReferenceItem(sourceRoot);
    const omissionCodes = {
      package: "source_package_omitted",
      reference: "source_reference_omitted",
      undownloadable: "source_content_unavailable",
    };
    for (const kind of sourceCapabilityKinds) {
      const id = specialIds[`${kind}Id`];
      if (id) {
        const omitted = rows.some(
          (row) =>
            row.jobType === "file_migration" &&
            row.sourceItemId === id &&
            row.code === omissionCodes[kind],
        );
        routeAssertions.push(liveAssertion("file_probe_", `${kind}_omission`, true, omitted));
        proofs[kind] = "live_source_entry";
      } else if (
        kinds[kind] === 0 &&
        weakerProofByKind[kind] &&
        (kind !== "reference" || refusedReference === 400)
      )
        proofs[kind] = weakerProofByKind[kind]!;
      else throw new LiveTestBlocked(`file_live_${kind}_fixture_unavailable`);
    }
    const evidence = await readback.binaryEvidence!();
    const binaryProof = {
      path: String(evidence.path),
      sha256: String(evidence.sha256),
      version: String(evidence.version),
      provenance: String(evidence.provenance),
      versionJson: object(evidence.versionJson),
    };
    const worker = await fileWorkerLiveTest({
      jobDirectory: input.jobDirectory,
      configPath: session.rcloneConfigPath,
      binary: binaryProof,
      signal: input.signal,
    });
    routeAssertions.push(...worker.assertions);
    capture("route_limits_and_version_gate", routeStartedAt, routeAssertions, {
      capabilityProofs: proofs,
      sourceRefusedReferenceStatus: refusedReference,
      sourceKindCensus: {
        scope: "mapping_source_root_children",
        itemsScanned: children.length,
        kinds,
      },
      worker: worker.observations,
    });
    return { requiredProbes: [...fileProbeIds] };
  } catch (error) {
    failed = true;
    if (error instanceof LiveTestBlocked) throw error;
    throw new LiveTestBlocked(
      input.signal.aborted ? "operator_interrupted" : "file_live_effect_or_observation_failed",
    );
  } finally {
    engine.close();
    let cleanup: unknown;
    try {
      await readback.close?.();
    } catch (error) {
      cleanup = error;
    }
    for (const root of copyRoots) {
      try {
        await fixtures.collectCopyOutputs(root);
      } catch (error) {
        cleanup ??= error;
      }
    }
    try {
      await fixtures.cleanup();
    } catch (error) {
      cleanup ??= error;
    }
    session.dispose();
    if (cleanup && !failed) throw new LiveTestBlocked("file_fixture_cleanup_incomplete");
  }
}
