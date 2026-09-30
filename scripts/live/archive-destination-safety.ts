import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ArchiveDestinationState } from "../../src/engine/archive/destination.ts";
import { verifyArchivePackage } from "../../src/engine/archive/package.ts";
import { hashStream, markerMatches } from "../../src/engine/drivers/file-state.ts";
import type { ArchiveConfig, ArchiveDriverContext } from "../../src/engine/providers/archive.ts";
import {
  createCredentialSession,
  type CredentialSession,
} from "../../src/engine/providers/credentials.ts";
import {
  fetchProvider,
  googleUrl,
  HttpProviderFault,
  requireSuccess,
  responseBytes,
  responseJson,
} from "../../src/engine/providers/http.ts";
import {
  createProductionProvider,
  type ProductionProvider,
} from "../../src/engine/providers/production.ts";
import { digestJson } from "../../src/engine/store/digest.ts";
import type { ProbeCapture } from "./probes.ts";
import { ArchiveJournal, archiveFileProof } from "./archive-journal.ts";
import {
  LiveTestBlocked,
  privatePathOwned,
  liveAssertion,
  registeredCodes,
  type LiveTestInput,
} from "./common.ts";

const folderMime = "application/vnd.google-apps.folder";
const metadataFields =
  "id,name,driveId,parents,mimeType,appProperties,createdTime,modifiedTime,headRevisionId,trashed,size,md5Checksum,sha256Checksum";
interface GoogleItem {
  id: string;
  name: string;
  driveId?: string;
  parents?: string[];
  mimeType: string;
  appProperties?: Record<string, string>;
  modifiedTime?: string;
  headRevisionId?: string;
  trashed?: boolean;
}
interface Snapshot {
  item: GoogleItem;
  bytes: { sha256: string; size: number } | null;
}
function requireFact(value: unknown, gate: string): asserts value {
  if (!value) throw new LiveTestBlocked(`archive_destination_safety_${gate}`);
}
function identifier(value: unknown): string {
  requireFact(typeof value === "string" && /^[A-Za-z0-9_!.,@-]{1,512}$/.test(value), "invalid_id");
  return value;
}
function states(resume: ArchiveDriverContext["resume"]) {
  return new Map<string, ArchiveDestinationState>(
    (resume.rows ?? []).flatMap((row) =>
      row.jobType === "teams_archive" && row.phase === "execute" && row.archiveDestination
        ? [[row.archiveDestination.path, row.archiveDestination] as const]
        : [],
    ),
  );
}

/** Only a fresh child and a private replay of the completed source collection are mutated. */
export async function testArchiveDestinationSafety(
  input: LiveTestInput,
  config: ArchiveConfig,
): Promise<ProbeCapture> {
  const startedAt = new Date().toISOString();
  const assertions: ProbeCapture["assertions"] = [];
  const expect = (id: string, expected: unknown, observed: unknown) => {
    assertions.push(liveAssertion("archive_destination_safety_", id, expected, observed));
  };
  let session: CredentialSession | undefined;
  let provider: ProductionProvider | undefined;
  let journal: ArchiveJournal | undefined;
  let folderId: string | undefined;
  let sentinelId: string | undefined;
  let folderAttempted = false;
  let sentinelAttempted = false;
  let changedId: string | undefined;
  let changedProof: Snapshot | undefined;
  const ownedSnapshots = new Map<string, Snapshot>();
  let secondaryDirectory: string | undefined;
  const owner = randomUUID();
  const folderName = `archive-safety-${owner}`;
  const sentinelBytes = Buffer.from(`Unowned archive live test sentinel ${owner}\n`);
  const sentinelProof = {
    sha256: createHash("sha256").update(sentinelBytes).digest("hex"),
    size: sentinelBytes.length,
  };
  try {
    requireFact(config.destination, "destination_required");
    const destination = config.destination;
    requireFact(
      config.retainedHistory && !config.transcripts && !config.attachmentBytes,
      "option_combination_required",
    );
    const jobConfig = structuredClone(input.config.jobConfig) as Record<string, unknown>;
    requireFact(
      jobConfig && typeof jobConfig === "object" && !Array.isArray(jobConfig),
      "config_required",
    );
    const secrets = { ...(jobConfig.secrets as Record<string, unknown>) };
    delete secrets.teams_graph_client_secret;
    jobConfig.secrets = secrets;
    const primary = await ArchiveJournal.reopen(input.jobDirectory, input.signal);
    const primaryResume = await primary.resume();
    const primaryDigest = digestJson(primaryResume);
    const primaryPlan = primaryResume.archivePlan;
    requireFact(primaryPlan && primaryResume.archiveManifestDigest, "completed_primary_required");
    expect(
      "primary_config_matches",
      digestJson({
        ...config,
        window: { ...config.window, to: config.window.to ?? primaryPlan.window.to },
      }),
      digestJson(primaryPlan.config),
    );
    requireFact(
      states(primaryResume).size === primaryPlan.conversations.length + 3 &&
        [...states(primaryResume).values()].every((state) => state.status === "verified"),
      "verified_primary_required",
    );
    for (const scope of primaryPlan.scopes) {
      for (const route of ["messages", "retained"])
        requireFact(
          primaryResume.watermarks[`archive:${scope.id}:${route}`] === "complete",
          "completed_source_watermarks_required",
        );
    }
    secondaryDirectory = await mkdtemp(join(input.jobDirectory, "safety-"));
    requireFact(
      privatePathOwned(await lstat(secondaryDirectory), "directory"),
      "private_directory_required",
    );
    // Both sessions deliberately lack a Graph secret. A missing watermark cannot silently re-export.
    try {
      session = await createCredentialSession({
        jobType: "teams_archive",
        config: jobConfig,
        jobDirectory: secondaryDirectory,
        mode: "archive_verification",
      });
    } catch {
      throw new LiveTestBlocked("archive_destination_safety_destination_credentials_required");
    }
    const google = async (path: string, init: RequestInit = {}, cleanup = false) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${await session!.googleToken()}`);
      if (init.body && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      return fetchProvider(googleUrl(path), {
        ...init,
        headers,
        signal: cleanup ? AbortSignal.timeout(60_000) : input.signal,
      });
    };
    const readItem = async (id: string, cleanup = false): Promise<GoogleItem | null> => {
      try {
        const item = await responseJson<GoogleItem>(
          await google(
            `/drive/v3/files/${encodeURIComponent(identifier(id))}?supportsAllDrives=true&fields=${metadataFields}`,
            {},
            cleanup,
          ),
        );
        requireFact(item.id === id && !item.trashed, "live_identity_changed");
        return item;
      } catch (error) {
        if (error instanceof HttpProviderFault && error.status === 404) return null;
        throw error;
      }
    };
    const snapshot = async (id: string, cleanup = false): Promise<Snapshot> => {
      const item = await readItem(id, cleanup);
      requireFact(item, "live_object_missing");
      let bytes: Snapshot["bytes"] = null;
      if (item.mimeType !== folderMime) {
        const response = await google(
          `/drive/v3/files/${encodeURIComponent(identifier(id))}?alt=media&supportsAllDrives=true`,
          {},
          cleanup,
        );
        await requireSuccess(response);
        bytes = await hashStream(
          responseBytes(response),
          cleanup ? AbortSignal.timeout(60_000) : input.signal,
        );
      }
      requireFact(
        digestJson(item) === digestJson(await readItem(id, cleanup)),
        "object_changed_during_read",
      );
      return { item, bytes };
    };
    const children = async (parent: string, cleanup = false): Promise<string[]> => {
      const query = new URLSearchParams({
        q: `'${identifier(parent).replaceAll("'", "\\'")}' in parents and trashed=false`,
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: "drive",
        driveId: destination.destDriveId,
        fields: "files(id),nextPageToken,incompleteSearch",
        pageSize: "1000",
      });
      const result = await responseJson<{
        files: { id: string }[];
        nextPageToken?: string;
        incompleteSearch?: boolean;
      }>(await google(`/drive/v3/files?${query}`, {}, cleanup));
      requireFact(!result.nextPageToken && !result.incompleteSearch, "inventory_incomplete");
      const ids = result.files.map((item) => identifier(item.id)).sort();
      requireFact(new Set(ids).size === ids.length, "inventory_duplicate_id");
      return ids;
    };
    const inventory = async (parent: string): Promise<Snapshot[]> => {
      const result = [];
      for (const id of await children(parent)) result.push(await snapshot(id));
      return result;
    };
    const ownedFolder = async (cleanup = false): Promise<GoogleItem> => {
      requireFact(folderAttempted && folderId, "owned_folder_required");
      const item = await readItem(folderId, cleanup);
      requireFact(
        item &&
          item.driveId === destination.destDriveId &&
          item.mimeType === folderMime &&
          item.name === folderName &&
          digestJson(item.parents) === digestJson([destination.destFolderId]) &&
          digestJson(item.appProperties) === digestJson({ qowner: owner }) &&
          item.modifiedTime,
        "folder_ownership_changed",
      );
      return item;
    };
    const inSecondary = (item: GoogleItem) => {
      requireFact(
        item.driveId === destination.destDriveId &&
          digestJson(item.parents) === digestJson([folderId]) &&
          item.modifiedTime,
        "object_scope_changed",
      );
    };
    const removeKnown = async (proof: Snapshot, cleanup = false) => {
      await ownedFolder(cleanup);
      inSecondary(proof.item);
      requireFact(
        digestJson(await snapshot(proof.item.id, cleanup)) === digestJson(proof),
        "object_changed_before_cleanup",
      );
      // Drive has no atomic If-Match. Recheck scope, ownership and revision, never delete by name.
      const response = await google(
        `/drive/v3/files/${encodeURIComponent(proof.item.id)}?supportsAllDrives=true`,
        { method: "DELETE" },
        cleanup,
      );
      await requireSuccess(response);
      await response.body?.cancel();
      requireFact((await readItem(proof.item.id, cleanup)) === null, "cleanup_delete_not_observed");
    };
    const checkSentinel = (proof: Snapshot) => {
      inSecondary(proof.item);
      requireFact(
        proof.item.id === sentinelId &&
          proof.item.name === "index.html" &&
          proof.item.mimeType === "text/html" &&
          Object.keys(proof.item.appProperties ?? {}).length === 0 &&
          digestJson(proof.bytes) === digestJson(sentinelProof),
        "sentinel_ownership_changed",
      );
    };
    const reserve = async () => {
      const result = await responseJson<{ ids: string[] }>(
        await google("/drive/v3/files/generateIds?count=1&space=drive&type=files"),
      );
      requireFact(result.ids.length === 1, "reservable_identity_required");
      return identifier(result.ids[0]);
    };
    const primaryBefore = await inventory(destination.destFolderId);
    expect(
      "primary_inventory_matches_verified_states",
      states(primaryResume).size,
      primaryBefore.length,
    );
    const primaryInventoryDigest = digestJson(primaryBefore);
    let collisionCodes: string[] = [];
    let driftCodes: string[] = [];
    let verificationCodes: string[] = [];
    let collisionDigest = "";
    let driftDigest = "";
    let secondaryObjects = 0;
    let cleanedObjects = 0;
    try {
      folderId = await reserve();
      const secondaryConfig: ArchiveConfig = {
        ...primaryPlan.config,
        destination: { ...destination, destFolderId: folderId },
      };
      provider = createProductionProvider({
        jobType: "teams_archive",
        config: { ...jobConfig, destination: secondaryConfig.destination },
        jobDirectory: secondaryDirectory,
        mode: "archive_verification",
      });
      requireFact(
        provider.readDestinationObject && provider.reserveDestinationId && provider.close,
        "provider_capabilities_required",
      );
      const root = await provider.resolveDestinationFolder(destination);
      requireFact(
        root?.kind === "folder" && root.driveId === destination.destDriveId,
        "shared_drive_root_required",
      );
      folderAttempted = true;
      await responseJson(
        await google("/drive/v3/files?supportsAllDrives=true&fields=id", {
          method: "POST",
          body: JSON.stringify({
            id: folderId,
            name: folderName,
            mimeType: folderMime,
            parents: [destination.destFolderId],
            appProperties: { qowner: owner },
          }),
        }),
      );
      await ownedFolder();
      expect("new_child_is_empty", 0, (await children(folderId)).length);
      journal = await ArchiveJournal.create(secondaryDirectory, input.signal);
      const frozenUnits = (await primary.units())
        .filter((unit) => unit.archivePlan || unit.archiveEvidence)
        .map((unit) =>
          unit.archivePlan
            ? { ...unit, archivePlan: { ...unit.archivePlan, config: secondaryConfig } }
            : unit,
        );
      // Seed only the real frozen plan and committed source pages. No destination state or old package is copied.
      requireFact(
        frozenUnits.length > 1 &&
          frozenUnits.every(
            (unit) =>
              !unit.archiveManifestDigest &&
              !unit.archiveFileProofs &&
              unit.rows.every((row) => row.jobType !== "teams_archive" || !row.archiveDestination),
          ),
        "source_only_seed_required",
      );
      const assets = new Map(
        (primaryResume.archiveRecords ?? []).flatMap((record) =>
          record.assets.map((asset) => [asset.path, asset] as const),
        ),
      );
      for (const asset of assets.values()) {
        requireFact(
          asset.path.length > 0 &&
            !/[\\\u0000-\u001f\u007f:%?#]/u.test(asset.path) &&
            asset.path.split("/").every((part) => part && part !== "." && part !== ".."),
          "asset_path_unconfined",
        );
        let parent = primary.archiveRoot;
        for (const part of asset.path.split("/").slice(0, -1)) {
          parent = join(parent, part);
          const info = await lstat(parent);
          requireFact(info.isDirectory() && !info.isSymbolicLink(), "asset_parent_unconfined");
        }
        const source = join(primary.archiveRoot, asset.path);
        const target = join(journal.archiveRoot, asset.path);
        const expected = { sha256: asset.sha256, size: asset.size };
        requireFact(
          digestJson(await archiveFileProof(source)) === digestJson(expected),
          "primary_asset_mismatch",
        );
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(source, target, constants.COPYFILE_EXCL);
        requireFact(
          digestJson(await archiveFileProof(target)) === digestJson(expected),
          "secondary_asset_mismatch",
        );
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        let installed = dirname(target);
        for (;;) {
          const directory = await open(installed, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          if (installed === journal.archiveRoot) break;
          installed = dirname(installed);
        }
      }
      const seed = await open(journal.path, "a");
      try {
        for (const unit of frozenUnits) await seed.writeFile(`${JSON.stringify(unit)}\n`, "utf8");
        await seed.sync();
      } finally {
        await seed.close();
      }
      journal = await ArchiveJournal.reopen(secondaryDirectory, input.signal);
      const seeded = await journal.resume();
      expect(
        "source_records_reused",
        digestJson(primaryResume.archiveRecords),
        digestJson(seeded.archiveRecords),
      );
      expect(
        "source_evidence_reused",
        digestJson(primaryResume.archiveEvidence),
        digestJson(seeded.archiveEvidence),
      );
      expect(
        "source_watermarks_reused",
        digestJson(primaryResume.watermarks),
        digestJson(seeded.watermarks),
      );
      expect(
        "only_plan_destination_adapted",
        digestJson(primaryPlan),
        digestJson({
          ...seeded.archivePlan,
          config: { ...seeded.archivePlan!.config, destination },
        }),
      );
      sentinelId = await reserve();
      const boundary = `live_${randomUUID()}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({
            id: sentinelId,
            name: "index.html",
            parents: [folderId],
            mimeType: "text/html",
          })}\r\n--${boundary}\r\nContent-Type: text/html\r\n\r\n`,
        ),
        sentinelBytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      await ownedFolder();
      sentinelAttempted = true;
      await responseJson(
        await google(
          "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id",
          {
            method: "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body,
          },
        ),
      );
      const sentinelBefore = await snapshot(sentinelId);
      checkSentinel(sentinelBefore);
      expect(
        "sentinel_has_no_provenance",
        null,
        (
          await provider.readDestinationObject!({
            driveId: destination.destDriveId,
            objectId: sentinelId,
          })
        )?.provenance,
      );
      const collisionStart = (await journal.units()).length;
      await journal.run("execute", secondaryConfig, provider);
      const observedCodes = async (start: number) =>
        registeredCodes(
          (await journal!.units())
            .slice(start)
            .flatMap((unit) =>
              unit.findings
                .filter((finding) => finding.subjectKind === "archive_object")
                .map((finding) => finding.code),
            ),
          "archive_destination_safety_unregistered_code",
        );
      collisionCodes = await observedCodes(collisionStart);
      expect("real_unowned_collision_refused", ["unowned_path_collision"], collisionCodes);
      collisionDigest = digestJson(sentinelBefore);
      expect(
        "collision_preserves_sentinel_bytes_and_metadata",
        collisionDigest,
        digestJson(await snapshot(sentinelId)),
      );
      await removeKnown(sentinelBefore);
      sentinelAttempted = false;
      cleanedObjects++;
      const uploadStart = (await journal.units()).length;
      await journal.run("execute", secondaryConfig, provider);
      expect("secondary_upload_has_no_destination_findings", [], await observedCodes(uploadStart));
      const complete = await journal.resume();
      const uploaded = states(complete);
      secondaryObjects = uploaded.size;
      expect(
        "secondary_has_all_expected_objects",
        primaryPlan.conversations.length + 3,
        secondaryObjects,
      );
      expect(
        "secondary_upload_byte_verified",
        true,
        [...uploaded.values()].every((state) => state.status === "verified"),
      );
      requireFact(
        complete.archiveManifestDigest && complete.archivePlan,
        "secondary_manifest_required",
      );
      expect(
        "regenerated_package_self_verifies",
        [],
        (
          await verifyArchivePackage(journal.archiveRoot, {
            plan: complete.archivePlan,
            records: complete.archiveRecords ?? [],
            evidence: complete.archiveEvidence ?? [],
            manifestDigest: complete.archiveManifestDigest,
          })
        ).map((finding) => finding.code),
      );
      const verifyStart = (await journal.units()).length;
      await journal.run("verify", secondaryConfig, provider);
      expect("secondary_live_verification_succeeds", [], await observedCodes(verifyStart));
      for (const proof of await inventory(folderId)) ownedSnapshots.set(proof.item.id, proof);
      expect(
        "secondary_inventory_matches_owned_ids",
        digestJson([...uploaded.values()].map((state) => state.output.id).sort()),
        digestJson([...ownedSnapshots.keys()].sort()),
      );
      const target = uploaded.get("index.html");
      requireFact(target && target.status === "verified", "secondary_owned_target_required");
      const entry = await provider.readDestinationObject!({
        driveId: destination.destDriveId,
        objectId: target.output.id,
      });
      requireFact(
        entry &&
          entry.revision === target.revision &&
          markerMatches(entry.provenance, target.marker) &&
          target.marker.mappingId === `archive:${basename(secondaryDirectory)}` &&
          target.output.parentId === folderId,
        "drift_target_ownership_required",
      );
      const beforeChange = ownedSnapshots.get(target.output.id)!;
      inSecondary(beforeChange.item);
      requireFact(
        beforeChange.bytes?.sha256 === target.output.sha256 &&
          beforeChange.bytes.size === target.output.size,
        "drift_target_bytes_changed",
      );
      await ownedFolder();
      requireFact(
        digestJson(beforeChange) === digestJson(await snapshot(target.output.id)),
        "drift_target_changed_before_mutation",
      );
      const changedBytes = Buffer.from(`Independent archive live test drift ${owner}\n`);
      // A separate credential session and raw Drive media effect, not the archive driver, changes bytes only.
      changedId = target.output.id;
      await responseJson(
        await google(
          `/upload/drive/v3/files/${encodeURIComponent(changedId)}?uploadType=media&supportsAllDrives=true&fields=id`,
          {
            method: "PATCH",
            headers: { "Content-Type": "text/html" },
            body: changedBytes,
          },
        ),
      );
      changedProof = await snapshot(changedId);
      expect(
        "independent_bytes_written",
        {
          sha256: createHash("sha256").update(changedBytes).digest("hex"),
          size: changedBytes.length,
        },
        changedProof.bytes,
      );
      expect(
        "independent_effect_preserves_provenance",
        digestJson(beforeChange.item.appProperties),
        digestJson(changedProof.item.appProperties),
      );
      requireFact(changedProof.bytes?.sha256 !== target.output.sha256, "drift_bytes_must_differ");
      const driftBefore = await inventory(folderId);
      expect("no_extra_secondary_objects", secondaryObjects, driftBefore.length);
      expect(
        "independent_effect_changes_only_owned_target",
        digestJson(
          [...ownedSnapshots.values()].map((proof) =>
            proof.item.id === changedId ? changedProof : proof,
          ),
        ),
        digestJson(driftBefore),
      );
      const replayStart = (await journal.units()).length;
      await journal.run("execute", secondaryConfig, provider);
      driftCodes = await observedCodes(replayStart);
      expect(
        "replay_refuses_real_content_and_revision_drift",
        true,
        driftCodes.includes("content_mismatch") && driftCodes.includes("prior_copy_drift"),
      );
      const driftVerifyStart = (await journal.units()).length;
      await journal.run("verify", secondaryConfig, provider);
      verificationCodes = await observedCodes(driftVerifyStart);
      expect(
        "verification_reports_real_drift",
        true,
        verificationCodes.includes("content_mismatch") &&
          verificationCodes.includes("prior_copy_drift"),
      );
      expect("replay_and_verification_agree_on_drift", driftCodes, verificationCodes);
      const byteDriftCodes: Record<string, true> = {
        content_mismatch: true,
        size_mismatch: true,
        metadata_mismatch: true,
        prior_copy_drift: true,
      };
      expect(
        "no_unrelated_destination_failures",
        [],
        driftCodes.filter((code) => !Object.hasOwn(byteDriftCodes, code)),
      );
      driftDigest = digestJson(driftBefore);
      expect(
        "replay_and_verify_preserve_all_bytes_ids_and_provenance",
        driftDigest,
        digestJson(await inventory(folderId)),
      );
      expect("primary_journal_unchanged", primaryDigest, digestJson(await primary.resume()));
    } finally {
      // Validate the entire cleanup set first. An unknown child, changed scope or ownership leaves it untouched.
      if (folderAttempted && folderId) {
        try {
          const liveFolder = await readItem(folderId, true);
          if (liveFolder) {
            await ownedFolder(true);
            const cleanupJournal =
              journal && secondaryDirectory
                ? await ArchiveJournal.reopen(secondaryDirectory, AbortSignal.timeout(60_000))
                : undefined;
            const resume = await cleanupJournal?.resume();
            const intended = resume ? states(resume) : new Map<string, ArchiveDestinationState>();
            const byId = new Map([...intended.values()].map((state) => [state.output.id, state]));
            const liveIds = await children(folderId, true);
            const removable: Snapshot[] = [];
            for (const id of liveIds) {
              const proof = await snapshot(id, true);
              inSecondary(proof.item);
              if (sentinelAttempted && id === sentinelId) checkSentinel(proof);
              else {
                const state = byId.get(id);
                requireFact(
                  state &&
                    secondaryDirectory &&
                    resume?.archiveManifestDigest &&
                    state.output.driveId === destination.destDriveId &&
                    state.output.parentId === folderId &&
                    state.marker.mappingId === `archive:${basename(secondaryDirectory)}` &&
                    state.marker.sourceIdentity === resume.archiveManifestDigest,
                  "cleanup_unknown_object",
                );
                const entry = await provider!.readDestinationObject!({
                  driveId: destination.destDriveId,
                  objectId: id,
                });
                requireFact(
                  entry &&
                    markerMatches(entry.provenance, state.marker) &&
                    entry.name === state.output.name &&
                    entry.mimeType === state.output.mimeType,
                  "cleanup_provenance_changed",
                );
                if (id === changedId)
                  requireFact(
                    changedProof && digestJson(proof) === digestJson(changedProof),
                    "cleanup_drift_changed",
                  );
                else
                  requireFact(
                    proof.bytes?.sha256 === state.output.sha256 &&
                      proof.bytes.size === state.output.size &&
                      (state.revision === null || entry.revision === state.revision),
                    "cleanup_owned_copy_changed",
                  );
                const expectedSnapshot = ownedSnapshots.get(id);
                if (id !== changedId && expectedSnapshot)
                  requireFact(
                    digestJson(proof) === digestJson(expectedSnapshot),
                    "cleanup_metadata_changed",
                  );
              }
              removable.push(proof);
            }
            for (const proof of removable) {
              await removeKnown(proof, true);
              cleanedObjects++;
            }
            requireFact((await children(folderId, true)).length === 0, "cleanup_folder_not_empty");
            await ownedFolder(true);
            const response = await google(
              `/drive/v3/files/${encodeURIComponent(folderId)}?supportsAllDrives=true`,
              { method: "DELETE" },
              true,
            );
            await requireSuccess(response);
            await response.body?.cancel();
            requireFact(
              (await readItem(folderId, true)) === null,
              "cleanup_folder_delete_not_observed",
            );
            cleanedObjects++;
          }
        } catch {
          throw new LiveTestBlocked("archive_destination_safety_cleanup_scope_or_ownership_failed");
        }
      }
    }
    expect(
      "primary_outputs_unchanged_after_cleanup",
      primaryInventoryDigest,
      digestJson(await inventory(destination.destFolderId)),
    );
    expect("all_tool_created_objects_cleaned", secondaryObjects + 2, cleanedObjects);
    return {
      schemaVersion: 1,
      probeId: "archive_destination_safety",
      startedAt,
      completedAt: new Date().toISOString(),
      codes: registeredCodes(
        [...collisionCodes, ...driftCodes, ...verificationCodes],
        "archive_destination_safety_unregistered_code",
      ),
      assertions,
      observations: {
        collisionCodes,
        driftCodes,
        verificationCodes,
        secondaryObjects,
        cleanedObjects,
        collisionDigest,
        driftDigest,
        primaryInventoryDigest,
        records: primaryResume.archiveRecords?.length ?? 0,
        evidencePages: primaryResume.archiveEvidence?.length ?? 0,
      },
    };
  } catch (error) {
    // No provider response, URL, local path or object identity escapes this helper.
    throw new LiveTestBlocked(
      error instanceof LiveTestBlocked
        ? error.gate
        : "archive_destination_safety_live_effect_failed",
    );
  } finally {
    try {
      await provider?.close?.();
    } catch {
      throw new LiveTestBlocked("archive_destination_safety_provider_close_failed");
    } finally {
      session?.dispose();
    }
  }
}
