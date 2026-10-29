import type { CredentialSession } from "../credentials.ts";
import type { GraphTransport } from "../http.ts";
import type { ProviderPort, FilePassRoot } from "../port.ts";
import type { CheckResult } from "../../types.ts";

export interface DestinationRoot {
  destDriveId: string;
  destFolderId: string;
}

export interface Mapping {
  sourceDriveId: string;
  sourceItemId?: string;
  sourceSiteId?: string;
  destDriveId?: string;
  destFolderId?: string;
}

export interface SourceWorker {
  /** Path from the drive root, bound to the exact item ID by the adapter; null means no live worker. */
  read(input: { remote: string; driveId: string; path: string }): AsyncIterable<Uint8Array> | null;
}

export interface AdapterInput {
  mappings: Mapping[];
  destinationRoots: DestinationRoot[];
  session: CredentialSession;
  graph: GraphTransport;
  worker: SourceWorker;
}

export type FilePassInput = Parameters<ProviderPort["resolveFilePass"]>[0];

export interface FileAdapter
  extends
    Pick<
      ProviderPort,
      | "resolveSourceRoot"
      | "resolveSourceFolder"
      | "resolveDestinationFolder"
      | "resolveDestinationPath"
      | "listSourceChildren"
      | "listDestinationChildren"
      | "openSourceContent"
    >,
    Partial<
      Pick<
        ProviderPort,
        | "googleAbout"
        | "readSharedDrive"
        | "createSharedDrive"
        | "findSharedDrives"
        | "listDriveMembers"
        | "addDriveMember"
        | "reserveDestinationId"
        | "createDestinationFolder"
        | "uploadDestinationContent"
        | "readDestinationMarker"
        | "streamDestinationContent"
        | "discoverSharePoint"
      >
    > {
  readSourceItem: NonNullable<ProviderPort["readSourceItem"]>;
  readDestinationObject: NonNullable<ProviderPort["readDestinationObject"]>;
  resolveSourcePass(input: FilePassInput): Promise<FilePassRoot>;
  resolveDestinationPass(input: FilePassInput): Promise<FilePassRoot>;
  preflightSource(mapping: Mapping, signal?: AbortSignal): Promise<Record<string, unknown>>;
  preflightDestination(root: DestinationRoot, signal?: AbortSignal): Promise<void>;
  probeDestination?(
    root: DestinationRoot,
    mapping?: Mapping,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  quotaCheck?(): CheckResult;
}

/** Item IDs are unique only within their containing drive. */
export function sourceKey(driveId: string, itemId: string): string {
  return JSON.stringify([driveId, itemId]);
}
