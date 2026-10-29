import type { CredentialSession } from "./credentials.ts";
import { ProviderFault } from "./fault.ts";
import type { GraphTransport } from "./http.ts";
import type { CheckResult } from "../types.ts";
import type { ProviderPort } from "./port.ts";
import { fileProviderPair } from "./adapters/capabilities.ts";
import { createFileAdapters } from "./adapters/registry.ts";
import type { DestinationRoot, Mapping, SourceWorker, FileAdapter } from "./adapters/effects.ts";

function readMappings(config: unknown): Mapping[] {
  if (!config || typeof config !== "object")
    throw new ProviderFault("preflight_failed", "The file mapping configuration is invalid.");
  if (!("mappings" in config) || config.mappings === undefined) return [];
  if (!Array.isArray(config.mappings))
    throw new ProviderFault("preflight_failed", "The file mapping configuration is invalid.");
  return config.mappings.map((raw: unknown) => {
    if (!raw || typeof raw !== "object")
      throw new ProviderFault("preflight_failed", "A file mapping is invalid.");
    const record = raw as Record<string, unknown>;
    const hasDestination = record.createDrive === undefined || record.destDriveId !== undefined;
    // A destination path resolves to its folder ID while the manifest loads.
    const required = [
      "sourceDriveId",
      ...(hasDestination ? ["destDriveId"] : []),
      ...(hasDestination && typeof record.destFolderPath !== "string" ? ["destFolderId"] : []),
    ];
    for (const field of required) {
      if (
        typeof record[field] !== "string" ||
        !record[field] ||
        /[\u0000-\u001f]/u.test(record[field])
      ) {
        throw new ProviderFault("preflight_failed", "A file mapping needs stable identifiers.");
      }
    }
    return {
      sourceDriveId: String(record.sourceDriveId),
      ...(typeof record.sourceItemId === "string" ? { sourceItemId: record.sourceItemId } : {}),
      ...(typeof record.destDriveId === "string" ? { destDriveId: record.destDriveId } : {}),
      ...(typeof record.destFolderId === "string" ? { destFolderId: record.destFolderId } : {}),
      ...(typeof record.sourceSiteId === "string" ? { sourceSiteId: record.sourceSiteId } : {}),
    };
  });
}

/** Compose provider effects without owning provider implementation or lifecycle decisions. */
export class FileEffects {
  readonly mappings: Mapping[];
  readonly #destinationRoots: DestinationRoot[];
  readonly #source: FileAdapter;
  readonly #destination: FileAdapter;
  readonly #sourceProvider: string;

  constructor(input: {
    config: unknown;
    destination?: DestinationRoot;
    session: CredentialSession;
    graph: GraphTransport;
    worker: SourceWorker;
  }) {
    this.mappings = input.destination ? [] : readMappings(input.config);
    this.#destinationRoots = input.destination
      ? [input.destination]
      : this.mappings.flatMap((m) =>
          m.destDriveId && m.destFolderId
            ? [{ destDriveId: m.destDriveId, destFolderId: m.destFolderId }]
            : [],
        );
    const adapters = createFileAdapters(input.config, {
      ...input,
      mappings: this.mappings,
      destinationRoots: this.#destinationRoots,
    });
    this.#source = adapters.source;
    this.#destination = adapters.destination;
    this.#sourceProvider = fileProviderPair(input.config).source.id;
  }

  #effect<K extends keyof FileAdapter>(adapter: FileAdapter, key: K): NonNullable<FileAdapter[K]> {
    const effect = adapter[key];
    if (typeof effect !== "function")
      throw new ProviderFault(
        "unsupported_route",
        "The selected provider does not support this operation.",
      );
    return effect as NonNullable<FileAdapter[K]>;
  }

  async resolveFilePass(input: Parameters<ProviderPort["resolveFilePass"]>[0]) {
    if (input.sourceType !== undefined && input.sourceType !== this.#sourceProvider)
      throw new ProviderFault("unsupported_route", "The pass direction differs from its mapping.");
    return {
      source: await this.#source.resolveSourcePass(input),
      destination: await this.#destination.resolveDestinationPass(input),
    };
  }

  async readSharedDrive(...input: Parameters<ProviderPort["readSharedDrive"]>) {
    const adapter = this.#source.readSharedDrive ? this.#source : this.#destination;
    return this.#effect(adapter, "readSharedDrive").call(adapter, ...input);
  }

  async discoverSharePoint() {
    return this.#effect(this.#source, "discoverSharePoint").call(this.#source);
  }

  async resolveSourceFolder(
    ...input: Parameters<NonNullable<ProviderPort["resolveSourceFolder"]>>
  ) {
    return this.#effect(this.#source, "resolveSourceFolder").call(this.#source, ...input);
  }

  async resolveSourceRoot(...input: Parameters<NonNullable<ProviderPort["resolveSourceRoot"]>>) {
    return this.#effect(this.#source, "resolveSourceRoot").call(this.#source, ...input);
  }

  async readSourceItem(...input: Parameters<NonNullable<ProviderPort["readSourceItem"]>>) {
    return this.#effect(this.#source, "readSourceItem").call(this.#source, ...input);
  }

  async listSourceChildren(...input: Parameters<NonNullable<ProviderPort["listSourceChildren"]>>) {
    return this.#effect(this.#source, "listSourceChildren").call(this.#source, ...input);
  }

  async resolveDestinationPath(
    ...input: Parameters<NonNullable<ProviderPort["resolveDestinationPath"]>>
  ) {
    return this.#effect(this.#destination, "resolveDestinationPath").call(
      this.#destination,
      ...input,
    );
  }

  async resolveDestinationFolder(
    ...input: Parameters<NonNullable<ProviderPort["resolveDestinationFolder"]>>
  ) {
    return this.#effect(this.#destination, "resolveDestinationFolder").call(
      this.#destination,
      ...input,
    );
  }

  async readDestinationObject(
    ...input: Parameters<NonNullable<ProviderPort["readDestinationObject"]>>
  ) {
    return this.#effect(this.#destination, "readDestinationObject").call(
      this.#destination,
      ...input,
    );
  }

  async listDestinationChildren(
    ...input: Parameters<NonNullable<ProviderPort["listDestinationChildren"]>>
  ) {
    return this.#effect(this.#destination, "listDestinationChildren").call(
      this.#destination,
      ...input,
    );
  }

  async reserveDestinationId(
    ...input: Parameters<NonNullable<ProviderPort["reserveDestinationId"]>>
  ) {
    return this.#effect(this.#destination, "reserveDestinationId").call(
      this.#destination,
      ...input,
    );
  }

  async createDestinationFolder(
    ...input: Parameters<NonNullable<ProviderPort["createDestinationFolder"]>>
  ) {
    return this.#effect(this.#destination, "createDestinationFolder").call(
      this.#destination,
      ...input,
    );
  }

  async uploadDestinationContent(
    ...input: Parameters<NonNullable<ProviderPort["uploadDestinationContent"]>>
  ) {
    return this.#effect(this.#destination, "uploadDestinationContent").call(
      this.#destination,
      ...input,
    );
  }

  async readDestinationMarker(
    ...input: Parameters<NonNullable<ProviderPort["readDestinationMarker"]>>
  ) {
    return this.#effect(this.#destination, "readDestinationMarker").call(
      this.#destination,
      ...input,
    );
  }

  async googleAbout(...input: Parameters<NonNullable<ProviderPort["googleAbout"]>>) {
    const adapter = this.#source.googleAbout ? this.#source : this.#destination;
    return this.#effect(adapter, "googleAbout").call(adapter, ...input);
  }

  async createSharedDrive(...input: Parameters<NonNullable<ProviderPort["createSharedDrive"]>>) {
    return this.#effect(this.#destination, "createSharedDrive").call(this.#destination, ...input);
  }

  async findSharedDrives(...input: Parameters<NonNullable<ProviderPort["findSharedDrives"]>>) {
    return this.#effect(this.#destination, "findSharedDrives").call(this.#destination, ...input);
  }

  async listDriveMembers(...input: Parameters<NonNullable<ProviderPort["listDriveMembers"]>>) {
    return this.#effect(this.#destination, "listDriveMembers").call(this.#destination, ...input);
  }

  async addDriveMember(...input: Parameters<NonNullable<ProviderPort["addDriveMember"]>>) {
    return this.#effect(this.#destination, "addDriveMember").call(this.#destination, ...input);
  }

  async *openSourceContent(...input: Parameters<ProviderPort["openSourceContent"]>) {
    yield* this.#effect(this.#source, "openSourceContent").call(this.#source, ...input);
  }

  async *streamDestinationContent(...input: Parameters<ProviderPort["streamDestinationContent"]>) {
    yield* this.#effect(this.#destination, "streamDestinationContent").call(
      this.#destination,
      ...input,
    );
  }

  async *preflight(signal?: AbortSignal): AsyncIterable<CheckResult> {
    for (const root of this.mappings.length ? this.mappings : this.#destinationRoots) {
      signal?.throwIfAborted();
      const mapping = "sourceDriveId" in root ? root : undefined;
      const evidence = {
        ...(mapping
          ? { sourceDriveId: mapping.sourceDriveId, sourceItemId: mapping.sourceItemId }
          : {}),
        destDriveId: root.destDriveId,
        destFolderId: root.destFolderId,
        probedAt: new Date().toISOString(),
      };
      const checkId = mapping
        ? `provider.roots.${mapping.sourceDriveId}.${mapping.sourceItemId}`
        : `provider.roots.${root.destDriveId}.${root.destFolderId}`;
      const title = mapping ? "Exact source and destination access" : "Exact destination access";
      try {
        const sourceEvidence = mapping ? await this.#source.preflightSource(mapping, signal) : {};
        if (!root.destDriveId || !root.destFolderId) {
          yield {
            id: checkId,
            title: "Exact source access before provisioning",
            status: "pass",
            evidence: { ...evidence, ...sourceEvidence },
          };
          continue;
        }
        await this.#destination.preflightDestination(
          {
            destDriveId: root.destDriveId,
            destFolderId: root.destFolderId,
          },
          signal,
        );
        yield {
          id: checkId,
          title,
          status: "pass",
          evidence: { ...evidence, ...sourceEvidence },
        };
      } catch (error) {
        signal?.throwIfAborted();
        yield failedCheck(checkId, title, error, evidence);
        continue;
      }
      if (!this.#destination.probeDestination) continue;
      try {
        const result = await this.#destination.probeDestination(
          {
            destDriveId: root.destDriveId!,
            destFolderId: root.destFolderId!,
          },
          mapping,
          signal,
        );
        yield {
          id: `provider.probe.${root.destFolderId}`,
          title: "Disposable destination capability probe",
          status: "pass",
          evidence: { ...evidence, ...result },
        };
      } catch (error) {
        signal?.throwIfAborted();
        yield failedCheck(
          `provider.probe.${root.destFolderId}`,
          "Disposable destination capability probe",
          error,
          evidence,
        );
      }
    }
    const quotaAdapter = this.#destination.quotaCheck ? this.#destination : this.#source;
    if (quotaAdapter.quotaCheck) yield quotaAdapter.quotaCheck();
  }
}

export function failedCheck(
  id: string,
  title: string,
  error: unknown,
  evidence: Record<string, unknown>,
): CheckResult {
  return {
    id,
    title,
    status: "fail",
    code:
      error instanceof ProviderFault &&
      ["unsupported_route", "plan_revision_required"].includes(error.code)
        ? error.code
        : "preflight_failed",
    evidence: {
      ...evidence,
      ...(error instanceof ProviderFault ? error.evidence : {}),
      failure: error instanceof ProviderFault ? error.code : "provider_failure",
    },
  };
}
