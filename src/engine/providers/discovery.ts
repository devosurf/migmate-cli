import type { ManifestMapping } from "../manifest.ts";
import { ProviderFault } from "./credentials.ts";
import { cursorPages, graphUrl, type GraphTransport } from "./http.ts";

export interface SharePointDiscovery {
  sites: { id: string; name: string; libraries: { id: string; name: string }[] }[];
  manifest: { version: 1; mappings: ManifestMapping[] };
}

/** Read-only tenant enumeration. The returned manifest is a proposal, never job state. */
export async function discoverSharePoint(graph: GraphTransport): Promise<SharePointDiscovery> {
  const evidence = await graph.evidence();
  if (
    !Array.isArray(evidence.grantedPermissions) ||
    !evidence.grantedPermissions.includes("Sites.Read.All")
  )
    throw new ProviderFault(
      "preflight_failed",
      "SharePoint discovery requires Sites.Read.All instead of Sites.Selected.",
      {
        check: "discovery_requires_sites_read_all",
        requiredGrant: "Sites.Read.All",
      },
    );
  const result: SharePointDiscovery = { sites: [], manifest: { version: 1, mappings: [] } };
  async function* entries(path: string): AsyncIterable<Record<string, unknown>> {
    for await (const page of cursorPages(
      path,
      async (cursor) => {
        graphUrl(cursor!);
        const page = await graph.request<{
          value: Record<string, unknown>[];
          "@odata.nextLink"?: string;
        }>(cursor!);
        if (
          !Array.isArray(page.value) ||
          (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string")
        )
          throw new ProviderFault("preflight_failed", "Graph returned an invalid discovery page.");
        return { value: page.value, next: page["@odata.nextLink"] };
      },
      () => new ProviderFault("preflight_failed", "Graph repeated a discovery page."),
    ))
      yield* page;
  }
  function text(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f]/u.test(value))
      throw new ProviderFault("preflight_failed", "Graph omitted a discovery identifier or name.");
    return value;
  }
  for await (const rawSite of entries("/v1.0/sites/getAllSites")) {
    const site: SharePointDiscovery["sites"][number] = {
      id: text(rawSite.id),
      name: text(rawSite.displayName ?? rawSite.name),
      libraries: [],
    };
    for await (const rawDrive of entries(`/v1.0/sites/${encodeURIComponent(site.id)}/drives`)) {
      if (rawDrive.driveType !== "documentLibrary") continue;
      const library = { id: text(rawDrive.id), name: text(rawDrive.name) };
      site.libraries.push(library);
      result.manifest.mappings.push({
        id: library.id,
        source: { type: "sharepoint", driveId: library.id, folderPath: "" },
        destination: { type: "google_shared_drive", create: `${site.name} - ${library.name}` },
        members: [],
      });
    }
    result.sites.push(site);
  }
  return result;
}
