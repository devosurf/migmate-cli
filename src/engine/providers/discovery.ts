import type { ManifestMapping } from "../manifest.ts";
import { ProviderFault } from "./credentials.ts";
import { cursorPages, graphUrl, HttpProviderFault, type GraphTransport } from "./http.ts";

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
  // Identity stays strict, and every refusal names the Graph object and field.
  function invalid(
    message: string,
    object: "page" | "site" | "drive",
    field: string,
    context: Record<string, string>,
  ): ProviderFault {
    return new ProviderFault("preflight_failed", message, {
      check: "discovery_response_invalid",
      object,
      field,
      ...context,
    });
  }
  function usable(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001f]/u.test(value);
  }
  function followable(link: string): boolean {
    try {
      graphUrl(link);
      return true;
    } catch {
      return false;
    }
  }
  async function* entries(
    route: string,
    context: Record<string, string> = {},
  ): AsyncIterable<Record<string, unknown>> {
    const where = { route, ...context };
    for await (const page of cursorPages(
      route,
      async (cursor) => {
        let page: { value?: unknown; "@odata.nextLink"?: unknown };
        try {
          page = await graph.request<typeof page>(cursor!);
        } catch (error) {
          // The transport never retries, so one throttled or denied request ends the
          // scan. Name it instead of surfacing an unattributed internal defect.
          if (
            error instanceof HttpProviderFault ||
            (error instanceof ProviderFault && error.code === "provider_request_failed")
          )
            throw new ProviderFault(
              "preflight_failed",
              "Graph did not complete a discovery request.",
              { ...error.evidence, ...where, check: "discovery_request_failed" },
            );
          throw error;
        }
        const next = page["@odata.nextLink"];
        if (!Array.isArray(page.value))
          throw invalid("Graph returned an invalid discovery page.", "page", "value", where);
        if (next !== undefined && (typeof next !== "string" || (next && !followable(next))))
          throw invalid(
            "Graph returned an invalid discovery page link.",
            "page",
            "@odata.nextLink",
            where,
          );
        return { value: page.value as Record<string, unknown>[], next };
      },
      () => invalid("Graph repeated a discovery page.", "page", "@odata.nextLink", where),
    ))
      yield* page;
  }
  const seenSites = new Set<string>();
  async function visit(rawSite: Record<string, unknown>): Promise<void> {
    const id = rawSite.id;
    if (!usable(id))
      throw invalid(
        "Graph omitted or returned an invalid site identifier.",
        "site",
        "id",
        usable(rawSite.webUrl) ? { webUrl: rawSite.webUrl } : {},
      );
    if (seenSites.has(id)) return;
    seenSites.add(id);
    // The site URL path distinguishes subsites sharing a display name and does not
    // depend on whether tenant enumeration or the parent's subsite list came first.
    const url = usable(rawSite.webUrl) ? URL.parse(rawSite.webUrl) : null;
    // A OneDrive site's own drive is `business`, never a library this route proposes.
    // Visiting one costs two requests per user and reads into private sites for nothing.
    if (rawSite.isPersonalSite === true || url?.hostname.endsWith("-my.sharepoint.com")) return;
    if (!url)
      throw invalid("Graph omitted or returned an invalid site URL.", "site", "webUrl", {
        siteId: id,
      });
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep Graph's encoded path when it is not valid percent-encoding.
    }
    // Labels only seed the proposed drive name a human reviews. Graph omits names on
    // system sites such as the classic Search Center, so a label never refuses.
    const siteLabel = [
      rawSite.displayName,
      rawSite.name,
      path.split("/").findLast(Boolean),
      url.hostname,
    ].find(usable);
    const site: SharePointDiscovery["sites"][number] = { id, name: siteLabel ?? id, libraries: [] };
    const siteName = `${site.name} (${url.hostname}${path})`;
    for await (const rawDrive of entries(`/v1.0/sites/${encodeURIComponent(id)}/drives`, {
      siteId: id,
    })) {
      if (rawDrive.driveType !== "documentLibrary") continue;
      const driveId = rawDrive.id;
      if (!usable(driveId))
        throw invalid("Graph omitted or returned an invalid library identifier.", "drive", "id", {
          siteId: id,
        });
      const library = { id: driveId, name: usable(rawDrive.name) ? rawDrive.name : driveId };
      site.libraries.push(library);
      result.manifest.mappings.push({
        id: library.id,
        source: { type: "sharepoint", driveId: library.id, folderPath: "" },
        destination: { type: "google_shared_drive", create: `${siteName} - ${library.name}` },
        members: [],
      });
    }
    result.sites.push(site);
    for await (const child of entries(`/v1.0/sites/${encodeURIComponent(id)}/sites`, {
      siteId: id,
    }))
      await visit(child);
  }
  for await (const rawSite of entries("/v1.0/sites/getAllSites")) await visit(rawSite);
  return result;
}
