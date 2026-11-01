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
  /** Observed URL of the actual target folder, including any mapping wrapper. */
  webUrl?: string;
  /** Decoded server-relative path; never a mapping-relative path or an encoded URL. */
  serverRelativePath?: string;
  /** Number of folders between the container root and the actual target folder. */
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
  creationParent?: "siteId";
  /** True only when replaying the durable request ID cannot create a second container. */
  idempotentCreation: boolean;
  /** Empty member manifests leave site access outside Migmate's go-live lifecycle. */
  inheritsSiteAccess?: boolean;
  /** Native basename to rclone STANDARD; null means no lossless JSON representation. */
  sourceName?(nativeName: string): string | null;
  /** rclone STANDARD basename to the actual native destination basename. */
  destinationName?(standardName: string): string;
  /** Comparison key for siblings the destination cannot hold together; absent allows duplicates. */
  destinationSiblingKey?(name: string): string;
  destinationNameFindings?(
    name: string,
    kind: "file" | "folder",
  ): readonly DestinationPathFinding[];
  /** Empty path checks root proof; nonempty paths contain projected destination segments. */
  destinationPathFindings?(
    path: string,
    kind: "file" | "folder",
    root?: DestinationConstraintRoot,
    options?: { checkPaths?: boolean },
  ): readonly DestinationPathFinding[];
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
    // Dropbox is source-only today; team-folder creation has no replay-safe request key.
    idempotentCreation: false,
    hashType: "sha256",
    ignoreSizeAndChecksum: false,
    uploadQuota: false,
    ledgerAccountedUploads: false,
    creatorRole: "owner",
    memberRole: () => undefined,
    rewritesPath: () => false,
    sourceDisclosures: [
      "Dropbox Paper documents export as .html when available; pinned rclone falls back to Markdown (.md) when HTML is unavailable. Visible files without either supported export raise blocking findings. .web files copy as pointers, not their Google-hosted targets.",
      "Pinned rclone v1.75.0 has no Dropbox ListR; recursive listing walks folders individually.",
    ],
    sourceEntryFindings: (entry) => {
      const code = {
        paper_html: "source_paper_html",
        document_export: "source_document_export",
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
