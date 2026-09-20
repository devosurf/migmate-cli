import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArchiveConfig } from "../../src/engine/archive/config.ts";
import { buildArchivePackage, verifyArchivePackage } from "../../src/engine/archive/package.ts";
import { archiveQualificationRequirements } from "../../src/engine/providers/archive-graph.ts";
import { createProductionProvider } from "../../src/engine/providers/production.ts";
import { createTransferSupervisor } from "../../src/engine/providers/transfer-worker.ts";
import type {
  ArchiveAssetReference,
  ArchiveCollectionEvidence,
  ArchivePlan,
  ArchiveRecord,
  ArchiveRoute,
} from "../../src/engine/providers/archive.ts";
import type { CheckResult } from "../../src/engine/types.ts";
import { canonicalJson } from "../../src/engine/store/digest.ts";
import type { ProbeCapture } from "../../src/qualification/bundle.ts";
import { TRANSFER_VERSION } from "../../src/versions.ts";
import {
  ArchiveJournal,
  archiveFileProof,
  type ArchiveFileProof,
  type ArchiveJournalUnit,
} from "./archive-journal.ts";
import {
  QualificationBlocked,
  same,
  qualificationAssertion,
  registeredCodes,
  type QualificationInput,
  type QualificationResult,
} from "./common.ts";
import { qualifyArchiveDestination } from "./archive-destination.ts";
import { qualifyArchiveDestinationSafety } from "./archive-destination-safety.ts";

type ScopeKind = "channel" | "chat";
type Assertion = ProbeCapture["assertions"][number];
type Sample = {
  scopeKind: ScopeKind;
  messageKind: "root" | "reply" | "chat";
  route: ArchiveRoute;
  sourceKind: ArchiveAssetReference["sourceKind"];
  bytes: number;
  sha256: string;
};

function requireFact(value: unknown, gate: string): asserts value {
  if (!value) throw new QualificationBlocked(gate);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
const assertion = qualificationAssertion.bind(null, "archive_");
function codes(values: Iterable<string>): string[] {
  return registeredCodes(values, "archive_unregistered_observed_code");
}
function requiredRoutes(plan: ArchivePlan, scope: ArchivePlan["scopes"][number]): ArchiveRoute[] {
  const routes: ArchiveRoute[] = ["messages"];
  if (plan.config.retainedHistory) routes.push("retained");
  if (plan.config.transcripts && scope.kind === "user-chats") routes.push("transcripts");
  return routes;
}

function pagingFacts(plan: ArchivePlan, evidence: ArchiveCollectionEvidence[]) {
  return plan.scopes.flatMap((scope) =>
    requiredRoutes(plan, scope).map((route) => {
      const pages = evidence.filter(
        (page) => page.scopeEntryId === scope.id && page.route === route,
      );
      const byCursor = new Map(pages.map((page) => [page.cursor, page]));
      requireFact(byCursor.size === pages.length, "archive_duplicate_paging_evidence");
      const visited = new Set<string | null>();
      let cursor: string | null = null;
      let exhausted = false;
      for (;;) {
        requireFact(!visited.has(cursor), "archive_paging_cycle");
        visited.add(cursor);
        const page = byCursor.get(cursor);
        requireFact(page, "archive_paging_evidence_missing");
        if (page.complete && page.nextLink === null) {
          exhausted = true;
          break;
        }
        requireFact(!page.complete && page.nextLink !== null, "archive_collection_incomplete");
        cursor = page.nextLink;
      }
      requireFact(exhausted && visited.size === pages.length, "archive_paging_not_exhausted");
      return {
        scopeKind: scope.kind === "channel" ? "channel" : "chat",
        conversationSubjects: plan.conversations
          .filter((conversation) => conversation.scopeEntryId === scope.id)
          .map((conversation) => hash(conversation.id))
          .sort(),
        route,
        pages: pages.length,
        continuationPages: pages.filter((page) => page.cursor !== null).length,
        records: pages.reduce((count, page) => count + page.recordKeys.length, 0),
        exhausted,
      };
    }),
  );
}

function sourceFindings(units: ArchiveJournalUnit[], records: ArchiveRecord[]): string[] {
  const findings = [
    ...units.flatMap((unit) =>
      unit.findings.filter((finding) => finding.kind === "finding").map((finding) => finding.code),
    ),
    ...records.flatMap((record) => record.findings.map((finding) => finding.code)),
  ];
  for (const code of findings) {
    requireFact(
      code === "identity_unresolved" || code === "render_downgraded",
      "archive_collection_or_bytes_incomplete",
    );
  }
  return codes(findings);
}

function samples(plan: ArchivePlan, records: ArchiveRecord[]): Sample[] {
  const conversations = new Map(
    plan.conversations.map((conversation) => [conversation.id, conversation]),
  );
  return records.flatMap((record) => {
    const conversation = conversations.get(record.conversationId);
    requireFact(conversation, "archive_record_outside_frozen_scope");
    const messageKind: Sample["messageKind"] =
      conversation.kind === "chat"
        ? "chat"
        : typeof record.raw.replyToId === "string" && record.raw.replyToId.length > 0
          ? "reply"
          : "root";
    return record.assets.map((asset): Sample => ({
      scopeKind: conversation.kind,
      messageKind,
      route: record.route,
      sourceKind: asset.sourceKind,
      bytes: asset.size,
      sha256: asset.sha256,
    }));
  });
}

function observedRouteTemplates(
  plan: ArchivePlan,
  records: ArchiveRecord[],
  collected: Sample[],
): string[] {
  const observed = new Set<string>();
  if (plan.scopes.some((scope) => scope.kind === "channel")) {
    observed.add("/v1.0/teams/{teamId}/channels");
    observed.add("/v1.0/teams/{teamId}/channels/getAllMessages");
  }
  if (plan.scopes.some((scope) => scope.kind === "user-chats")) {
    observed.add("/v1.0/users/{userId}/chats");
    observed.add("/v1.0/users/{userId}/chats/getAllMessages");
  }
  const conversations = new Map(
    plan.conversations.map((conversation) => [conversation.id, conversation]),
  );
  for (const record of records) {
    if (record.route === "retained") {
      const kind = conversations.get(record.conversationId)?.kind;
      if (kind === "channel") observed.add("/v1.0/teams/{teamId}/channels/getAllRetainedMessages");
      if (kind === "chat") observed.add("/v1.0/users/{userId}/chats/getAllRetainedMessages");
    }
  }
  for (const sample of collected) {
    if (sample.sourceKind === "hosted_content" && sample.bytes > 0) {
      const base =
        sample.scopeKind === "chat"
          ? "/v1.0/chats/{chatId}/messages/{messageId}"
          : sample.messageKind === "reply"
            ? "/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies/{replyId}"
            : "/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}";
      observed.add(`${base}/hostedContents`);
      observed.add(`${base}/hostedContents/{hostedContentId}/$value`);
    }
    if (sample.sourceKind === "attachment") {
      observed.add("/v1.0/shares/{encodedSharingUrl}/driveItem");
      observed.add("/v1.0/drives/{driveId}/items/{itemId}/content");
    }
    if (sample.sourceKind === "transcript" && sample.bytes > 0) {
      observed.add(
        "/v1.0/users/{userId}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='{userId}',startDateTime={from},endDateTime={to})",
      );
      observed.add("/v1.0/users/{userId}/onlineMeetings/{meetingId}");
      observed.add(
        "/v1.0/users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content",
      );
    }
  }
  return [...observed].sort();
}

async function run(input: QualificationInput): Promise<QualificationResult> {
  input.signal.throwIfAborted();
  const startedAt = new Date().toISOString();
  requireFact(
    input.config.schemaVersion === 1 &&
      input.config.jobType === "teams_archive" &&
      input.config.acknowledgement === "I authorize disposable live qualification probes" &&
      object(input.config.jobConfig),
    "archive_probe_configuration_required",
  );
  const jobConfig = input.config.jobConfig;
  const config = parseArchiveConfig(jobConfig);
  requireFact(
    jobConfig.guarantees === undefined ||
      (typeof jobConfig.guarantees === "string" && jobConfig.guarantees.length > 0),
    "archive_guarantee_set_invalid",
  );
  const requirements = archiveQualificationRequirements(config);
  const kinds = [
    ...new Set(
      config.scopes.map((scope): ScopeKind => (scope.kind === "user-chats" ? "chat" : "channel")),
    ),
  ].sort();
  // Pin the shipped binary for both tuples. Destination probes also start the
  // managed worker; the local-only route needs only its core/version proof.
  const supervisor = createTransferSupervisor({
    configPath: null,
    jobDirectory: input.jobDirectory,
  });
  let binary;
  try {
    binary = await supervisor.proveBinary();
  } finally {
    await supervisor.close();
  }
  requireFact(
    binary.version === TRANSFER_VERSION && /^[a-f0-9]{64}$/.test(binary.sha256),
    "archive_managed_binary_unqualified",
  );

  let journal = await ArchiveJournal.create(input.jobDirectory, input.signal);
  let provider = createProductionProvider({
    jobType: "teams_archive",
    config: jobConfig,
    jobDirectory: input.jobDirectory,
  });
  const checks: CheckResult[] = [];
  let restartCheckpointDigest = "";
  let restartJournalDigest = "";
  let restartEvidenceCount = 0;
  let resumedEvidenceCount = 0;
  let restartHadContinuation = false;
  try {
    requireFact(provider.archive, "archive_production_provider_required");
    await journal.run("plan", config, provider);
    const planned = await journal.resume();
    requireFact(
      planned.archivePlan &&
        planned.archivePlan.scopes.length > 0 &&
        planned.archivePlan.conversations.length > 0,
      "archive_scope_sample_unavailable",
    );
    const plan = planned.archivePlan;
    // Only production preflight's immutable-route gate is intentionally not
    // called: this maintainer tool is collecting the first real route evidence.
    // The archive capability performs all real app-role, license, scope, toggle,
    // hosted-byte and requested attachment/transcript probes itself.
    for await (const check of provider.archive.preflight(config, plan, input.signal)) {
      checks.push(check);
      const gate =
        check.id === "archive_application_permissions"
          ? "archive_application_permissions_unavailable"
          : check.id.startsWith("archive_hosted_content:")
            ? "archive_hosted_content_sample_unavailable"
            : check.id.startsWith("archive_transcript_toggle")
              ? "archive_transcript_consent_license_or_toggle_unavailable"
              : check.id === "archive_attachment_bytes"
                ? "archive_attachment_bytes_sample_unavailable"
                : check.id.startsWith("archive_retention:")
                  ? "archive_retained_history_route_unavailable"
                  : check.id === "archive_route_licensing"
                    ? "archive_requested_export_licensing_unavailable"
                    : "archive_live_scope_or_route_unavailable";
      requireFact(check.status === "pass", gate);
      if (check.id.startsWith("archive_transcript_toggle:")) {
        requireFact(
          check.evidence?.applicationAccessPolicyVerified === true,
          "archive_transcript_access_policy_sample_unavailable",
        );
      }
    }
    requireFact(
      checks.some(
        (check) => check.id === "archive_route_licensing" && check.evidence?.accepted === true,
      ),
      "archive_license_route_evidence_missing",
    );
    const permissionCheck = checks.find((check) => check.id === "archive_application_permissions");
    requireFact(
      permissionCheck &&
        same(permissionCheck.evidence?.requiredPermissions, requirements.permissions) &&
        same(permissionCheck.evidence?.missingPermissions, []),
      "archive_application_permission_evidence_missing",
    );

    // Stop after the first actual page has become durable, even when that page
    // exhausts its route. Continuations are reported only when Graph emits one.
    requireFact(
      await journal.run("execute", config, provider, "page"),
      "archive_restart_page_unavailable",
    );
    const checkpoint = await journal.resume();
    requireFact(
      checkpoint.archiveEvidence?.length && checkpoint.checkpoint,
      "archive_restart_checkpoint_missing",
    );
    restartEvidenceCount = checkpoint.archiveEvidence.length;
    restartHadContinuation = checkpoint.archiveEvidence.at(-1)!.nextLink !== null;
    restartCheckpointDigest = hash(checkpoint);
    restartJournalDigest = (await archiveFileProof(journal.path)).sha256;
    requireFact(provider.close, "archive_provider_close_required");
    await provider.close();
    journal = await ArchiveJournal.reopen(input.jobDirectory, input.signal);
    const reloaded = await journal.resume();
    requireFact(
      hash(reloaded) === restartCheckpointDigest &&
        (await archiveFileProof(journal.path)).sha256 === restartJournalDigest,
      "archive_restart_durable_state_changed",
    );
    if (config.destination) {
      const destinationCapture = await qualifyArchiveDestination(input, config);
      if (config.retainedHistory) {
        const safety = await qualifyArchiveDestinationSafety(input, config);
        destinationCapture.assertions.push(
          ...safety.assertions.map((assertion) => ({
            ...assertion,
            id: `safety_${assertion.id}`,
          })),
        );
        destinationCapture.codes = codes([...destinationCapture.codes, ...safety.codes]);
        destinationCapture.observations.safety = safety.observations;
        destinationCapture.completedAt = safety.completedAt;
      }
      input.capture(destinationCapture);
    } else {
      provider = createProductionProvider({
        jobType: "teams_archive",
        config: jobConfig,
        jobDirectory: input.jobDirectory,
      });
      await journal.run("execute", config, provider);
    }
    resumedEvidenceCount = (await journal.resume()).archiveEvidence!.length - restartEvidenceCount;
  } finally {
    requireFact(provider.close, "archive_provider_close_required");
    await provider.close();
  }

  // This API accepts only filesystem root and durable collection state. All
  // production credential sessions are closed before local-only verification.
  journal = await ArchiveJournal.reopen(input.jobDirectory, input.signal);
  const durable = await journal.resume();
  requireFact(
    durable.archivePlan &&
      durable.archiveRecords &&
      durable.archiveEvidence &&
      durable.archiveManifestDigest,
    "archive_completed_package_missing",
  );
  const packageInput = {
    plan: durable.archivePlan,
    records: durable.archiveRecords,
    evidence: durable.archiveEvidence,
    manifestDigest: durable.archiveManifestDigest,
  };
  const units = await journal.units();
  const fidelityCodes = sourceFindings(units, packageInput.records);
  const privateConversationIds = new Set(
    packageInput.plan.conversations
      .filter(
        (conversation) =>
          conversation.kind === "channel" && conversation.membershipType === "private",
      )
      .map((conversation) => conversation.id),
  );
  const privateChannels = [...privateConversationIds].map(hash).sort();
  const retainedRecords = packageInput.records.filter((record) => record.route === "retained");
  const privateRecordCounts = new Map<string, number>();
  for (const record of retainedRecords) {
    if (!privateConversationIds.has(record.conversationId)) continue;
    const subject = hash(record.conversationId);
    privateRecordCounts.set(subject, (privateRecordCounts.get(subject) ?? 0) + 1);
  }
  const privateRetainedSamples = [...privateRecordCounts]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([subject, records]) => ({ subject, records }));
  const paging = pagingFacts(packageInput.plan, packageInput.evidence);
  const collected = samples(packageInput.plan, packageInput.records);
  const allCodes = codes(
    units.flatMap((unit) => [
      ...unit.rows.map((row) => row.code),
      ...unit.findings.map((finding) => finding.code),
    ]),
  );
  for (const kind of kinds) {
    requireFact(
      collected.some(
        (sample) =>
          sample.scopeKind === kind &&
          sample.sourceKind === "hosted_content" &&
          sample.route === "messages" &&
          sample.bytes > 0,
      ),
      "archive_hosted_scope_kind_sample_unavailable",
    );
  }
  if (kinds.includes("channel")) {
    for (const messageKind of ["root", "reply"]) {
      requireFact(
        collected.some(
          (sample) =>
            sample.scopeKind === "channel" &&
            sample.messageKind === messageKind &&
            sample.sourceKind === "hosted_content" &&
            sample.bytes > 0,
        ),
        "archive_hosted_channel_reply_sample_unavailable",
      );
    }
  }
  if (config.retainedHistory) {
    for (const kind of kinds)
      requireFact(
        paging.some(
          (page) => page.scopeKind === kind && page.route === "retained" && page.records > 0,
        ),
        "archive_retained_history_sample_unavailable",
      );
    if (kinds.includes("channel"))
      requireFact(
        privateRetainedSamples.length > 0,
        "archive_private_retained_history_sample_unavailable",
      );
  }
  if (config.transcripts) {
    for (const scope of packageInput.plan.scopes.filter((scope) => scope.kind === "user-chats")) {
      const keys = new Set(
        packageInput.evidence
          .filter((page) => page.scopeEntryId === scope.id && page.route === "transcripts")
          .flatMap((page) => page.recordKeys),
      );
      requireFact(
        packageInput.records.some(
          (record) =>
            keys.has(record.key) &&
            record.assets.some((asset) => asset.sourceKind === "transcript" && asset.size > 0),
        ),
        "archive_transcript_scope_sample_unavailable",
      );
    }
  }
  if (config.attachmentBytes) {
    for (const kind of kinds)
      requireFact(
        collected.some((sample) => sample.scopeKind === kind && sample.sourceKind === "attachment"),
        "archive_attachment_scope_kind_sample_unavailable",
      );
  }
  const observedRoutes = observedRouteTemplates(packageInput.plan, packageInput.records, collected);
  requireFact(same(observedRoutes, requirements.routes), "archive_route_matrix_sample_incomplete");

  input.signal.throwIfAborted();
  const verificationStartedAt = new Date().toISOString();
  const verification = await verifyArchivePackage(journal.archiveRoot, packageInput);
  requireFact(verification.length === 0, "archive_local_package_verification_failed");
  const regenerated = buildArchivePackage(packageInput);
  requireFact(
    regenerated.findings.every(
      (finding) => finding.code === "identity_unresolved" || finding.code === "render_downgraded",
    ),
    "archive_package_collection_gap",
  );
  const installedFiles = units.flatMap((unit) => unit.archiveFileProofs ?? []);
  requireFact(
    installedFiles.length === regenerated.files.length,
    "archive_regenerated_file_count_mismatch",
  );
  const regeneratedProofs = [];
  for (const file of regenerated.files) {
    input.signal.throwIfAborted();
    const bytes = await readFile(join(journal.archiveRoot, file.path));
    requireFact(
      bytes.equals(Buffer.from(file.content, "utf8")),
      "archive_regenerated_bytes_mismatch",
    );
    regeneratedProofs.push({ path: file.path, sha256: file.sha256, size: bytes.length });
  }
  const assets = new Map(
    packageInput.records.flatMap((record) =>
      record.assets.map((asset) => [asset.path, asset] as const),
    ),
  );
  const assetProofs: ArchiveFileProof[] = [];
  for (const asset of assets.values()) {
    input.signal.throwIfAborted();
    const proof = await archiveFileProof(join(journal.archiveRoot, asset.path));
    requireFact(
      proof.sha256 === asset.sha256 && proof.size === asset.size,
      "archive_local_asset_digest_mismatch",
    );
    assetProofs.push(proof);
  }
  const manifest: unknown = JSON.parse(
    await readFile(join(journal.archiveRoot, "manifest.json"), "utf8"),
  );
  requireFact(object(manifest), "archive_manifest_invalid");
  const expectedCounts = {
    scopeCount: packageInput.plan.scopes.length,
    conversationCount: packageInput.plan.conversations.length,
    recordCount: packageInput.records.length,
    assetCount: assets.size,
    assetBytes: assetProofs.reduce((total, asset) => total + asset.size, 0),
  };
  const observedCounts = {
    scopeCount: manifest.scopeCount,
    conversationCount: manifest.conversationCount,
    recordCount: manifest.recordCount,
    assetCount: manifest.assetCount,
    assetBytes: manifest.assetBytes,
  };
  const completedAt = new Date().toISOString();
  const capture = (
    probeId: string,
    observedCodes: string[],
    assertions: Assertion[],
    observations: Record<string, unknown>,
    start = startedAt,
  ) => {
    input.capture({
      schemaVersion: 1,
      probeId,
      startedAt: start,
      completedAt,
      codes: observedCodes,
      assertions,
      observations,
    });
  };
  const tuple = {
    jobType: "teams_archive",
    source: {
      system: "microsoft_teams",
      backend: {
        cloud: "Global",
        apiVersion: "v1.0",
        routes: requirements.routes,
        permissions: requirements.permissions,
        options: requirements.options,
      },
    },
    destination: config.destination
      ? {
          system: "google_shared_drive",
          backend: { type: "drive", authentication: "service_account" },
        }
      : { system: "local_archive_package" },
    transferVersion: binary.version,
    guaranteeSetId: jobConfig.guarantees ?? "default",
    desktopCell: `${process.platform}-${process.arch}`,
  };

  capture(
    "graph_route_matrix",
    allCodes,
    [
      assertion("exact_route_templates", requirements.routes, observedRoutes),
      assertion(
        "required_application_permissions",
        requirements.permissions,
        checks.find((check) => check.id === "archive_application_permissions")!.evidence
          ?.requiredPermissions,
      ),
      assertion(
        "missing_application_permissions",
        [],
        checks.find((check) => check.id === "archive_application_permissions")!.evidence
          ?.missingPermissions,
      ),
      assertion(
        "requested_export_routes_accepted",
        true,
        checks.find((check) => check.id === "archive_route_licensing")!.evidence?.accepted,
      ),
      assertion(
        "all_collection_routes_exhausted",
        true,
        paging.every((page) => page.exhausted),
      ),
    ],
    {
      routes: observedRoutes,
      requiredPermissions: requirements.permissions,
      options: requirements.options,
      preflightPassed: checks.length,
      paging,
      fidelityCodes,
      restart: {
        checkpointDigest: restartCheckpointDigest,
        journalDigest: restartJournalDigest,
        committedPagesBeforeRestart: restartEvidenceCount,
        pagesAfterRestart: resumedEvidenceCount,
        checkpointHadContinuation: restartHadContinuation,
      },
      binary: {
        version: binary.version,
        sha256: binary.sha256,
        proofCommand: "rc --loopback core/version",
      },
    },
  );

  const assetCodes = allCodes.filter(
    (code) => code === "asset_stored" || code === "asset_deduplicated_within_conversation",
  );
  const hosted = collected.filter((sample) => sample.sourceKind === "hosted_content");
  capture(
    "hosted_content_bytes",
    assetCodes,
    [
      assertion(
        "hosted_scope_kind_coverage",
        kinds,
        [
          ...new Set(
            hosted
              .filter((sample) => sample.bytes > 0 && sample.route === "messages")
              .map((sample) => sample.scopeKind),
          ),
        ].sort(),
      ),
      assertion(
        "hosted_local_digests_match",
        true,
        hosted.every((sample) =>
          assetProofs.some(
            (proof) => proof.sha256 === sample.sha256 && proof.size === sample.bytes,
          ),
        ),
      ),
    ],
    { samples: hosted, totalReferences: hosted.length, fidelityCodes },
  );

  capture(
    "package_self_consistency",
    codes(verification.map((finding) => finding.code)),
    [
      assertion(
        "local_verification_findings",
        [],
        verification.map((finding) => finding.code),
      ),
      assertion(
        "manifest_digest_regenerated",
        durable.archiveManifestDigest,
        regenerated.manifestDigest,
      ),
      assertion("deterministic_package_file_bytes", hash(installedFiles), hash(regeneratedProofs)),
      assertion("complete_local_counts", expectedCounts, observedCounts),
    ],
    {
      verificationApi: "verifyArchivePackage(root, durableCollection)",
      providerSessionsClosed: true,
      manifestDigest: regenerated.manifestDigest,
      packageFileCount: regenerated.files.length,
      counts: observedCounts,
      packageFilesDigest: hash(regeneratedProofs),
      assetDigests: assetProofs,
      paging,
      fidelityCodes,
    },
    verificationStartedAt,
  );

  const requiredProbes = ["graph_route_matrix", "hosted_content_bytes", "package_self_consistency"];
  if (config.destination) requiredProbes.push("archive_destination");
  if (config.retainedHistory) {
    const retained = paging.filter((page) => page.route === "retained");
    capture(
      "retained_history",
      codes(retainedRecords.flatMap((record) => record.findings.map((finding) => finding.code))),
      [
        assertion(
          "retained_scope_kind_coverage",
          kinds,
          [
            ...new Set(retained.filter((page) => page.records > 0).map((page) => page.scopeKind)),
          ].sort(),
        ),
        assertion(
          "retained_paging_exhausted",
          true,
          retained.every((page) => page.exhausted),
        ),
        ...(kinds.includes("channel")
          ? [
              assertion(
                "private_retained_sample_collected",
                true,
                privateRetainedSamples.length > 0,
              ),
            ]
          : []),
      ],
      {
        paging: retained,
        privateChannels,
        privateRetainedSamples,
        records: retainedRecords.length,
        collectionDigest: hash(retainedRecords),
        fidelityCodes,
      },
    );
    requiredProbes.push("retained_history");
  }
  if (config.transcripts) {
    const transcriptSamples = collected.filter((sample) => sample.sourceKind === "transcript");
    const policies = checks.filter((check) => check.id.startsWith("archive_transcript_toggle:"));
    capture(
      "transcripts",
      assetCodes,
      [
        assertion(
          "transcript_access_policy_verified",
          true,
          policies.length > 0 &&
            policies.every((check) => check.evidence?.applicationAccessPolicyVerified === true),
        ),
        assertion(
          "transcript_bytes_collected",
          true,
          transcriptSamples.some((sample) => sample.bytes > 0),
        ),
      ],
      {
        samples: transcriptSamples,
        organizerScopes: policies.length,
        paging: paging.filter((page) => page.route === "transcripts"),
      },
    );
    requiredProbes.push("transcripts");
  }
  if (config.attachmentBytes) {
    const attachmentSamples = collected.filter((sample) => sample.sourceKind === "attachment");
    capture(
      "attachment_bytes",
      assetCodes,
      [
        assertion(
          "attachment_scope_kind_coverage",
          kinds,
          [...new Set(attachmentSamples.map((sample) => sample.scopeKind))].sort(),
        ),
        assertion(
          "attachment_local_digests_match",
          true,
          attachmentSamples.every((sample) =>
            assetProofs.some(
              (proof) => proof.sha256 === sample.sha256 && proof.size === sample.bytes,
            ),
          ),
        ),
      ],
      { samples: attachmentSamples, attachmentBytesAsRetrieved: true },
    );
    requiredProbes.push("attachment_bytes");
  }
  return { tuple, requiredProbes, binarySha256: binary.sha256 };
}

export async function runArchiveQualification(
  input: QualificationInput,
): Promise<QualificationResult> {
  try {
    return await run(input);
  } catch (error) {
    if (error instanceof QualificationBlocked) throw error;
    if (input.signal.aborted) throw new QualificationBlocked("archive_probe_aborted");
    if (object(error) && (error.status === 401 || error.status === 403)) {
      throw new QualificationBlocked("archive_consent_permission_or_license_unavailable");
    }
    // No tenant identifiers, raw upstream errors, token-bearing URLs or message
    // content may be serialized by the runner's refusal path.
    throw new QualificationBlocked("archive_live_prerequisite_or_provider_failed");
  }
}
