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
import { createArchiveProvider } from "./archive-graph.ts";
import type { ArchiveProvider } from "./archive.ts";
import { parseArchiveConfig } from "../archive/config.ts";
import { discoverSharePoint } from "./discovery.ts";

export interface ProductionProviderInput {
  jobType: JobType;
  config: unknown;
  jobDirectory: string;
  mode?: "archive_verification";
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

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Construction is effect-free. The engine gates every real mutation with preflight and approval. */
export function createProductionProvider(input: ProductionProviderInput): ProductionProvider {
  const config = object(input.config);
  const needsTransferWorker =
    input.jobType === "file_migration" || config.destination !== undefined;
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
          if (needsTransferWorker) {
            result.files = new FileEffects({
              config: input.config,
              ...(input.jobType === "teams_archive"
                ? { destination: parseArchiveConfig(input.config).destination! }
                : {}),
              session,
              graph,
              worker: {
                async *read(item) {
                  if (current) yield* worker.openSource(current.socketPath, item);
                  else
                    yield* graph.stream(
                      `/v1.0/drives/${encodeURIComponent(item.driveId)}/root:/${item.path
                        .split("/")
                        .map((segment) => encodeURIComponent(segment))
                        .join("/")}:/content`,
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
    async discoverSharePoint() {
      if (input.jobType !== "file_migration")
        throw new ProviderFault(
          "unsupported_route",
          "Discovery requires a SharePoint source file job.",
        );
      return discoverSharePoint((await state()).graph);
    },
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
      if (needsTransferWorker) {
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
    },
    async applicationIdentity() {
      return (await state()).session.identity();
    },
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
      if (needsTransferWorker) {
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
    async resolveSourceFolder(value) {
      return (await files()).resolveSourceFolder(value);
    },
    async resolveDestinationPath(value) {
      return (await files()).resolveDestinationPath(value);
    },
    async readSharedDrive(driveId) {
      return (await files()).readSharedDrive(driveId);
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
    async readDestinationMarker(id) {
      return (await files()).readDestinationMarker(id);
    },
    async *streamDestinationContent(id) {
      yield* (await files()).streamDestinationContent(id);
    },
    async previewCopyPass(value) {
      return (await state()).worker.previewCopyPass(value);
    },
    async startCopyPass(value) {
      return (await state()).worker.startCopyPass(value);
    },
    async copyPassStatus(value) {
      return (await state()).worker.copyPassStatus(value);
    },
    async copyPassStats(value) {
      return (await state()).worker.copyPassStats(value);
    },
    async stopCopyPass(value) {
      await (await state()).worker.stopCopyPass(value);
    },
    async googleAbout() {
      return (await files()).googleAbout();
    },
    async createSharedDrive(input) {
      return (await files()).createSharedDrive(input);
    },
    async findSharedDrives(name) {
      return (await files()).findSharedDrives(name);
    },
    async listDriveMembers(driveId) {
      return (await files()).listDriveMembers(driveId);
    },
    async addDriveMember(driveId, member) {
      return (await files()).addDriveMember(driveId, member);
    },
    async resolveFilePassSource(value) {
      if (!current) throw new ProviderFault("provider_failed", "The transfer worker is absent.");
      return {
        socketPath: current.socketPath,
        ...(await (await files()).resolveFilePassSource(value)),
      };
    },
    async resolveFilePass(value) {
      if (!current) throw new ProviderFault("provider_failed", "The transfer worker is absent.");
      return { socketPath: current.socketPath, ...(await (await files()).resolveFilePass(value)) };
    },
    async listFolders(value) {
      return (await state()).worker.listFolders(value);
    },
    async listFileHashes(value) {
      return (await state()).worker.listFileHashes(value);
    },
    async startTransferWorker(value) {
      if (!needsTransferWorker || current)
        throw new ProviderFault(
          "preflight_failed",
          "Only a remote-destination run without an existing worker can start a transfer worker.",
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
      if (current?.socketPath === value.socketPath) current = null;
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
