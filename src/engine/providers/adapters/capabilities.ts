import { ProviderFault } from "../fault.ts";
import { googleCapabilities } from "./google-capabilities.ts";
import { sharepointCapabilities } from "./sharepoint-capabilities.ts";
import type { DriveMember } from "../port.ts";
import type { googlePreflight, unreadableSourceDrives } from "./google-preflight.ts";
import type { FileContext } from "../../drivers/file-state.ts";
import type { UploadQuotaStop } from "../../types.ts";

export type FileProviderId = "sharepoint" | "google_shared_drive";
export interface FileProviderCapabilities {
  id: FileProviderId;
  rcloneBackend: string;
  rootField: "folderId" | "folderPath";
  preflight?: typeof googlePreflight;
  unreadableSources?: typeof unreadableSourceDrives;
  hashType: "quickxor" | "sha256";
  ignoreSizeAndChecksum: boolean;
  uploadQuota: boolean;
  quotaStop?(ctx: FileContext, error: string | null): UploadQuotaStop | undefined;
  creatorRole: DriveMember["role"];
  memberRole(role: unknown): DriveMember["role"] | undefined;
  rewritesPath(path: string): boolean;
}

const providers: Record<FileProviderId, FileProviderCapabilities> = {
  sharepoint: sharepointCapabilities,
  google_shared_drive: googleCapabilities,
};

export function fileProvider(id: unknown): FileProviderCapabilities {
  if (typeof id !== "string" || !Object.hasOwn(providers, id))
    throw new ProviderFault(
      "unsupported_route",
      "No shipped adapter supports the requested provider.",
      { provider: id },
    );
  return providers[id as FileProviderId];
}

/** Internal mapping fixtures and pre-provider-pair evidence use the original implicit source. */
export function mappingSourceProvider(mapping: { sourceType?: string }): FileProviderCapabilities {
  return fileProvider(mapping.sourceType ?? "sharepoint");
}

export function fileProviderPair(config: unknown): {
  source: FileProviderCapabilities;
  destination: FileProviderCapabilities;
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
  if (source.id === destination.id)
    throw new ProviderFault(
      "unsupported_route",
      "Same-provider file migrations are not implemented.",
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
