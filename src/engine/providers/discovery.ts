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
  const seenSites = new Set<string>();
  async function visit(rawSite: Record<string, unknown>): Promise<void> {
    const id = text(rawSite.id);
    if (seenSites.has(id)) return;
    seenSites.add(id);
    const site: SharePointDiscovery["sites"][number] = {
      id,
      name: text(rawSite.displayName ?? rawSite.name),
      libraries: [],
    };
    // The site URL path distinguishes subsites sharing a display name and does not
    // depend on whether tenant enumeration or the parent's subsite list came first.
    let url: URL;
    try {
      url = new URL(text(rawSite.webUrl));
    } catch {
      throw new ProviderFault("preflight_failed", "Graph omitted or returned an invalid site URL.");
    }
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep Graph's encoded path when it is not valid percent-encoding.
    }
    const siteName = `${site.name} (${url.hostname}${path})`;
    for await (const rawDrive of entries(`/v1.0/sites/${encodeURIComponent(site.id)}/drives`)) {
      if (rawDrive.driveType !== "documentLibrary") continue;
      const library = { id: text(rawDrive.id), name: text(rawDrive.name) };
      site.libraries.push(library);
      result.manifest.mappings.push({
        id: library.id,
        source: { type: "sharepoint", driveId: library.id, folderPath: "" },
        destination: { type: "google_shared_drive", create: `${siteName} - ${library.name}` },
        members: [],
      });
    }
    result.sites.push(site);
    for await (const child of entries(`/v1.0/sites/${encodeURIComponent(site.id)}/sites`))
      await visit(child);
  }
  for await (const rawSite of entries("/v1.0/sites/getAllSites")) await visit(rawSite);
  return result;
}
