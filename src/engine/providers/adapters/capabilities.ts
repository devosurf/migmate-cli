import { ProviderFault } from "../fault.ts";
import { googleCapabilities } from "./google-capabilities.ts";
import { sharepointCapabilities } from "./sharepoint-capabilities.ts";
import type { DriveMember, SourceEntry } from "../port.ts";
import type { googlePreflight, unreadableSourceDrives } from "./google-preflight.ts";
import type { FileContext } from "../../drivers/file-state.ts";
import type { UploadQuotaStop } from "../../types.ts";
import { GoogleAdapter } from "./google.ts";
import { SharePointAdapter } from "./sharepoint.ts";
import { googleCredentialAdapter } from "./credentials/google.ts";
import { sharepointCredentialAdapter } from "./credentials/sharepoint.ts";
import type { FileCredentialAdapter } from "./credentials/shared.ts";
import type { AdapterInput, FileAdapter } from "./effects.ts";
import { DropboxAdapter } from "./dropbox.ts";
import { dropboxCredentialAdapter } from "./credentials/dropbox.ts";

export type FileProviderId = "sharepoint" | "google_shared_drive" | "dropbox";
export interface DestinationConstraintRoot {
  webUrl?: string;
  serverRelativePath?: string;
  folderDepth?: number;
}
export interface DestinationPathFinding {
  code: string;
  message: string;
}
export interface FileProviderCapabilities {
  id: FileProviderId;
  rcloneBackend: string;
  rootField: "folderId" | "folderPath";
  containerField?: "namespaceId";
  sourceDisclosures?: readonly string[];
  sourceEntryFindings?(entry: SourceEntry): readonly string[];
  preflight?: typeof googlePreflight;
  unreadableSources?: typeof unreadableSourceDrives;
  hashType: "quickxor" | "sha256";
  ignoreSizeAndChecksum: boolean;
  uploadQuota: boolean;
  /** Whether observed destination uploads contribute to the engine-home account ledger. */
  ledgerAccountedUploads: boolean;
  quotaStop?(ctx: FileContext, error: string | null): UploadQuotaStop | undefined;
  creatorRole: DriveMember["role"];
  memberRole(role: unknown): DriveMember["role"] | undefined;
  rewritesPath(path: string): boolean;
  destinationPathFindings?(
    path: string,
    kind: "file" | "folder",
    root?: DestinationConstraintRoot,
  ): readonly DestinationPathFinding[];
}

interface FileProviderAdapter extends FileProviderCapabilities {
  credentials: FileCredentialAdapter;
  createEffects(input: AdapterInput): FileAdapter;
}

/** Register each provider once: policy, credential proof, and effects travel together. */
const providers: Record<FileProviderId, FileProviderAdapter> = {
  sharepoint: {
    ...sharepointCapabilities,
    credentials: sharepointCredentialAdapter,
    createEffects: (input) => new SharePointAdapter(input),
  },
  google_shared_drive: {
    ...googleCapabilities,
    credentials: googleCredentialAdapter,
    createEffects: (input) => new GoogleAdapter(input),
  },
  dropbox: {
    id: "dropbox",
    rcloneBackend: "dropbox",
    rootField: "folderPath",
    containerField: "namespaceId",
    hashType: "sha256",
    ignoreSizeAndChecksum: false,
    uploadQuota: false,
    creatorRole: "owner",
    memberRole: () => undefined,
    rewritesPath: () => false,
    sourceDisclosures: [
      "Dropbox Paper documents export as .html; legacy Paper and unsupported exports are blocking findings. .web files copy as pointers, not their Google-hosted targets.",
      "Legacy Paper namespace coverage is unproven for every Dropbox-source job, regardless of the selected admin's paper_as_files feature. One blocking job finding requires explicit exception acceptance; no Paper parity is claimed.",
      "Pinned rclone v1.75.0 has no Dropbox ListR; recursive listing walks folders individually.",
    ],
    sourceEntryFindings: (entry) => {
      const code = {
        paper_html: "source_paper_html",
        legacy_paper: "source_legacy_paper",
        unsupported_export: "source_unsupported_export",
        web_pointer: "source_web_pointer",
      }[String(entry.metadata?.contentDisposition)];
      return code ? [code] : [];
    },
    credentials: dropboxCredentialAdapter,
    createEffects: (input) => new DropboxAdapter(input),
  },
};
export const credentialBindings = Object.values(providers).flatMap(
  (adapter) => adapter.credentials.bindings,
);

export function fileProvider(id: unknown): FileProviderAdapter {
  if (typeof id !== "string" || !Object.hasOwn(providers, id))
    throw new ProviderFault(
      "unsupported_route",
      "No shipped adapter supports the requested provider.",
      { provider: id },
    );
  return providers[id as FileProviderId];
}

/** Internal mapping fixtures and pre-provider-pair evidence use the original implicit source. */
export function mappingSourceProvider(mapping: { sourceType?: string }): FileProviderAdapter {
  return fileProvider(mapping.sourceType ?? "sharepoint");
}

export function fileProviderPair(config: unknown): {
  source: FileProviderAdapter;
  destination: FileProviderAdapter;
} {
  const input = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const mappings = Array.isArray(input.mappings) ? input.mappings : [];
  const inferredSource = mappings.find(
    (mapping) => mapping && typeof mapping === "object" && "sourceType" in mapping,
  )?.sourceType;
  const source = fileProvider(input.sourceProvider ?? inferredSource ?? "sharepoint");
  const destination = fileProvider(
    input.destinationProvider ??
      (source.id === "sharepoint" ? "google_shared_drive" : "sharepoint"),
  );
  if (
    source.id === destination.id ||
    destination.id === "dropbox" ||
    (source.id === "dropbox" && destination.id !== "google_shared_drive")
  )
    throw new ProviderFault(
      "unsupported_route",
      "The requested provider pair is not implemented.",
      { sourceProvider: source.id, destinationProvider: destination.id },
    );
  return { source, destination };
}

/** Decode historical stores only. New operator configurations must not name a route. */
export function historicalProviderPair(
  route: unknown,
): { sourceProvider: FileProviderId; destinationProvider: FileProviderId } | undefined {
  if (route === "sharepoint_library_to_shared_drive")
    return { sourceProvider: "sharepoint", destinationProvider: "google_shared_drive" };
  if (route === "shared_drive_to_sharepoint_library")
    return { sourceProvider: "google_shared_drive", destinationProvider: "sharepoint" };
  return undefined;
}
