import type { CheckResult, JobType } from "../types.ts";
import type { ProviderPort, TransferWorkerHandle } from "./port.ts";
import { createCredentialSession, ProviderFault, type CredentialSession } from "./credentials.ts";
import { createGraphTransport, type GraphTransport } from "./http.ts";
import { FileEffects, failedCheck } from "./file-effects.ts";
import {
  createTransferSupervisor,
  type BinaryProof,
  type TransferSupervisor,
} from "./transfer-worker.ts";
import { createArchiveProvider, archiveQualificationRequirements } from "./archive-graph.ts";
import type { ArchiveProvider } from "./archive.ts";
import { parseArchiveConfig } from "../archive/config.ts";
import { readQualifiedBundle } from "../../qualification/bundle.ts";

export interface ProductionProviderInput {
  jobType: JobType;
  config: unknown;
  jobDirectory: string;
}
export interface ProductionProvider extends ProviderPort {
  archive?: ArchiveProvider;
}
interface ProviderState {
  session: CredentialSession;
  graph: GraphTransport;
  worker: TransferSupervisor;
  files?: FileEffects;
}
interface QualificationEvidence {
  digest: string;
  tuple: Record<string, unknown>;
  bundle: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Construction is effect-free. The engine gates every real mutation with preflight and approval. */
export function createProductionProvider(input: ProductionProviderInput): ProductionProvider {
  const config = object(input.config);
  let pending: Promise<ProviderState> | undefined;
  let current: TransferWorkerHandle | null = null;
  let closed = false;

  function supervisor(configPath: string | null): TransferSupervisor {
    const supplied = config.transferBinary;
    let binary: { path: string; sha256: string; provenance: string } | undefined;
    if (supplied !== undefined) {
      const value = object(supplied);
      if (
        typeof value.path !== "string" ||
        typeof value.sha256 !== "string" ||
        typeof value.provenance !== "string"
      )
        throw new ProviderFault(
          "preflight_failed",
          "A supplied transfer binary requires its path, digest, and provenance.",
        );
      binary = { path: value.path, sha256: value.sha256, provenance: value.provenance };
    }
    return createTransferSupervisor({
      configPath,
      jobDirectory: input.jobDirectory,
      ...(binary ? { binary } : {}),
    });
  }

  async function state(): Promise<ProviderState> {
    if (closed)
      throw new ProviderFault("preflight_failed", "The provider session has been closed.");
    if (!pending) {
      pending = (async () => {
        const session = await createCredentialSession(input);
        try {
          const graph = createGraphTransport(session);
          const worker = supervisor(session.rcloneConfigPath);
          const result: ProviderState = { session, graph, worker };
          if (input.jobType === "file_migration") {
            result.files = new FileEffects({
              config: input.config,
              session,
              graph,
              worker: {
                async *read(item) {
                  if (current) yield* worker.openSource(current.socketPath, item);
                  else
                    yield* graph.stream(
                      `/v1.0/drives/${encodeURIComponent(item.driveId)}/items/${encodeURIComponent(item.parentId)}:/${encodeURIComponent(item.name)}:/content`,
                    );
                },
              },
            });
          }
          return result;
        } catch (error) {
          session.dispose();
          throw error;
        }
      })();
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  }

  async function files(): Promise<FileEffects> {
    const effects = (await state()).files;
    if (!effects)
      throw new ProviderFault(
        "preflight_failed",
        "A Teams archive has no remote file destination.",
      );
    return effects;
  }

  async function qualificationEvidence(): Promise<QualificationEvidence> {
    const reference = object(config.qualification);
    if (
      typeof reference.bundle !== "string" ||
      typeof reference.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(reference.digest)
    )
      throw new ProviderFault(
        "unqualified_route",
        "No immutable captured evidence bundle is bound to this route.",
      );
    const common = {
      jobType: input.jobType,
      transferVersion: "v1.75.0",
      guaranteeSetId: typeof config.guarantees === "string" ? config.guarantees : "default",
      desktopCell: `${process.platform}-${process.arch}`,
    };
    let tuple: Record<string, unknown>;
    let requiredProbes: string[];
    if (input.jobType === "file_migration") {
      tuple = {
        ...common,
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
      };
      requiredProbes = [
        "zero_byte_and_empty_folder_copy",
        "stable_id_additive_rerun_and_move",
        "metadata_round_trip",
        "provenance_marker_round_trip",
        "checksum_fresh_upload",
        "collision_matrix",
        "route_limits_and_version_gate",
      ];
    } else {
      const requirements = archiveQualificationRequirements(parseArchiveConfig(input.config));
      tuple = {
        ...common,
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
        destination: { system: "local_archive_package" },
      };
      requiredProbes = [
        "graph_route_matrix",
        "hosted_content_bytes",
        "package_self_consistency",
        ...(requirements.options.retainedHistory ? ["retained_history"] : []),
        ...(requirements.options.transcripts ? ["transcripts"] : []),
        ...(requirements.options.attachmentBytes ? ["attachment_bytes"] : []),
      ];
    }
    try {
      return await readQualifiedBundle({
        bundle: reference.bundle,
        digest: reference.digest,
        tuple,
        requiredProbes,
      });
    } catch {
      throw new ProviderFault(
        "unqualified_route",
        "The immutable captured route evidence does not match the requested runtime guarantees.",
      );
    }
  }

  async function binaryProof(): Promise<BinaryProof> {
    if (pending) return (await pending).worker.proveBinary();
    const probe = supervisor(null);
    try {
      return await probe.proveBinary();
    } finally {
      await probe.close();
    }
  }

  const archiveTransport: GraphTransport = {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      return (await state()).graph.request<T>(path, init);
    },
    async *stream(path: string) {
      yield* (await state()).graph.stream(path);
    },
    async evidence() {
      return (await state()).graph.evidence();
    },
  };

  return {
    ...(input.jobType === "teams_archive"
      ? { archive: createArchiveProvider(archiveTransport) }
      : {}),
    async *preflight(): AsyncIterable<CheckResult> {
      let loaded: ProviderState | undefined;
      try {
        loaded = await state();
        const evidence = await loaded.session.evidence();
        yield {
          id: "provider.credentials",
          title: "File-backed application credentials",
          status: "pass",
          evidence,
        };
      } catch (error) {
        yield failedCheck("provider.credentials", "File-backed application credentials", error, {});
      }
      if (input.jobType === "file_migration") {
        try {
          const proof = await binaryProof();
          yield {
            id: "provider.transfer_binary",
            title: "Exact managed transfer binary",
            status: "pass",
            evidence: { ...proof, proofCommand: "rc --loopback core/version" },
          };
        } catch (error) {
          yield failedCheck("provider.transfer_binary", "Exact managed transfer binary", error, {});
        }
        if (loaded) yield* loaded.files!.preflight();
      }
      try {
        const route = await qualificationEvidence();
        yield {
          id: "provider.qualified_route",
          title: "Immutable exact-route qualification",
          status: "pass",
          evidence: { ...route },
        };
      } catch (error) {
        yield failedCheck(
          "provider.qualified_route",
          "Immutable exact-route qualification",
          error,
          {},
        );
      }
    },
    async applicationIdentity() {
      return (await state()).session.identity();
    },
    qualificationEvidence,
    async binaryEvidence() {
      return { ...(await binaryProof()) };
    },
    async assertExecutionEvidence(expected) {
      const fresh = await createCredentialSession(input);
      try {
        if ((await fresh.identity()) !== expected.applicationIdentity)
          throw new ProviderFault(
            "plan_revision_required",
            "The application identity differs from the approved evidence.",
          );
      } finally {
        fresh.dispose();
      }
      const qualification = await qualificationEvidence();
      if (qualification.digest !== expected.qualificationDigest)
        throw new ProviderFault(
          "plan_revision_required",
          "The route evidence differs from the approved evidence.",
        );
      if (input.jobType === "file_migration") {
        const proof = await binaryProof();
        if (proof.sha256 !== expected.binarySha256 || proof.version !== expected.binaryVersion)
          throw new ProviderFault(
            "plan_revision_required",
            "The transfer binary differs from the approved evidence.",
          );
        if (
          current &&
          (await (await state()).worker.transferWorkerVersion(current)) !== expected.binaryVersion
        )
          throw new ProviderFault(
            "plan_revision_required",
            "The live transfer worker differs from the approved evidence.",
          );
      }
    },
    async resolveSourceRoot(value) {
      return (await files()).resolveSourceRoot(value);
    },
    async readSourceItem(value) {
      return (await files()).readSourceItem(value);
    },
    async listSourceChildren(id) {
      return (await files()).listSourceChildren(id);
    },
    async *openSourceContent(id) {
      yield* (await files()).openSourceContent(id);
    },
    async resolveDestinationFolder(value) {
      return (await files()).resolveDestinationFolder(value);
    },
    async readDestinationObject(value) {
      return (await files()).readDestinationObject(value);
    },
    async listDestinationChildren(id) {
      return (await files()).listDestinationChildren(id);
    },
    async reserveDestinationId() {
      return (await files()).reserveDestinationId();
    },
    async createDestinationFolder(value) {
      return (await files()).createDestinationFolder(value);
    },
    async uploadDestinationContent(value) {
      return (await files()).uploadDestinationContent(value);
    },
    async moveDestinationObject(value) {
      return (await files()).moveDestinationObject(value);
    },
    async readDestinationMarker(id) {
      return (await files()).readDestinationMarker(id);
    },
    async writeDestinationMarker(value) {
      return (await files()).writeDestinationMarker(value);
    },
    async *streamDestinationContent(id) {
      yield* (await files()).streamDestinationContent(id);
    },
    async startTransferWorker(value) {
      if (input.jobType !== "file_migration" || current)
        throw new ProviderFault(
          "preflight_failed",
          "Only a file run without an existing worker can start a transfer worker.",
        );
      current = await (await state()).worker.startTransferWorker(value);
      return current;
    },
    async probeTransferWorker(value) {
      const worker = pending ? (await pending).worker : supervisor(null);
      return worker.probeTransferWorker(value);
    },
    async stopTransferWorker(value) {
      await (await state()).worker.stopTransferWorker(value);
    },
    async terminateTransferWorker(value) {
      await (await state()).worker.terminateTransferWorker(value);
      if (current?.socketPath === value.socketPath) current = null;
    },
    async transferWorkerVersion(value) {
      return (await state()).worker.transferWorkerVersion(value);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (pending) {
        let loaded: ProviderState;
        try {
          loaded = await pending;
        } catch {
          return;
        }
        try {
          await loaded.worker.close();
        } finally {
          loaded.session.dispose();
          current = null;
        }
      }
    },
  };
}
