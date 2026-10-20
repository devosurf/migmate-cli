# SharePoint Online egress feasibility for Migmate

> Context: wayfinding on [Decide live-only progress, replay semantics and historical event compaction](https://github.com/devosurf/migmate-cli/issues/88). The planned 17–25M-file / 80–120 TB job is Dropbox → Google Shared Drives, not SharePoint; these limits apply to future large SharePoint jobs. Throwaway research branch: never merged.

## Short answer

| Question | Answer | Primary source |
|---|---|---|
| Can one source app reliably feed the proposed Google capacity? | **Do not plan on it.** Microsoft publishes **400 GB/hour egress per app per tenant**, independent of license count. [INFERENCE] At uninterrupted utilization this is **9.6 TB/day**, using decimal GB/TB; it is a ceiling calculation, not sustainable-throughput guidance. The proposed Google capacity is a scenario assumption, not validated here. | [Microsoft throttling](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#application-throttling) |
| Are file counts another constraint? | Yes. App resource-unit budgets depend on purchased tenant licenses, ranging from **1,200,000 to 6,000,000 RU per 24 hours**; file download costs **1 RU**, before discovery/metadata/permissions/retries. | [Microsoft throttling](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online) |
| Can extra app registrations multiply capacity? | Apps have individual limits, but share tenant resources and tenant-wide throttles. Microsoft explicitly says **“Don't create separate AppIDs where the applications essentially perform the same operations.”** Do not use app sharding to circumvent throttling. | [Common throttling scenarios](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#common-throttling-scenarios-in-sharepoint-online) |
| Does the preauthenticated URL bypass limits? | `/content` redirects to a temporary, preauthenticated download URL. **[UNVERIFIED]** The reviewed primary documentation does not explain precise per-app byte attribution after this redirect or an exemption. Do not assume a bandwidth loophole. | [Graph download](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0), [Microsoft throttling](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online) |
| Does Migmate's `--fast-list` ensure efficient source scanning? | Not by itself: OneDrive recursive delta listing requires **`--onedrive-delta` / `delta = true`**, disabled by default. It scans from the drive root even when only a subfolder is requested. | [rclone fast-list](https://rclone.org/onedrive/#fast-list), [rclone delta](https://rclone.org/onedrive/#onedrive-delta) |
| What is sustainable throughput? | **[UNVERIFIED] No Microsoft guaranteed sustainable export TB/day figure found.** [INFERENCE] Plan below the calculated byte ceiling and below the license-tier/file-count ceiling, then measure a representative pilot across peak and off-peak windows. Nights/weekends help; more apps are not an endorsed workaround. | [Throttling guidance](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online), [Migration performance](https://learn.microsoft.com/en-us/sharepointmigration/sharepoint-online-and-onedrive-migration-speed) |

## Published limits and accounting

All figures in the following tables are quoted from [Microsoft's SharePoint Online throttling guidance](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online). Microsoft calls these default values, reserves the right to change them, warns actual experience can vary, and reserves the right to lower limits for unpaid/unlicensed use. These are simultaneous constraints, not additive allowances.

### Applications and tenant aggregate

| Purchased tenant license count, as printed by Microsoft | App/tenant RU per 24 H | App/tenant RU per 1 min | Tenant-wide RU per 5 min |
|---|---:|---:|---:|
| 0–1,000 | 1,200,000 | 1,250 | 18,750 |
| 1,001–5,000 | 2,400,000 | 2,500 | 37,500 |
| 5,001–15,000 | 3,600,000 | 3,750 | 56,250 |
| 15,001–50,000 | 4,800,000 | 5,000 | 75,000 |
| 50,000+ | 6,000,000 | 6,250 | 93,750 |

Source: [Application and tenant throttling tables](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online). The overlapping boundary at 50,000 is in Microsoft's table; do not silently resolve it when sizing an actual boundary-case tenant. Eligible purchased licenses are the plans linked from that page to [SharePoint limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/sharepoint-online-service-description/sharepoint-online-limits#limits-by-plan), not destination Google licenses.

| Scope | Direction | Interval | Published limit | License dependency |
|---|---|---|---:|---|
| Per app per tenant | Ingress | 1 H | 400 GB | None |
| Per app per tenant | Egress | 1 H | 400 GB | None |

Source: [Application throttling](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#application-throttling). **Exact documented unit is `GB`, not `GiB`**. [UNVERIFIED] This page does not define the underlying byte conversion or whether each interval is fixed, rolling, or token-bucket enforced. Calculations here explicitly assume decimal units. Do not combine ingress and egress into a larger download allowance.

Every app request across Graph, CSOM, and REST counts toward application usage. Apps in different tenants have independent app/tenant limits. Within a tenant, apps share resources and tenant-level limits. Microsoft documents separate usage measurement for each Multi-Geo geo, using the total tenant license count when determining license-based limits. [INFERENCE] A genuine pre-existing Multi-Geo footprint may therefore matter to capacity, but it does not justify treating sites or libraries in the same geo as independent app/tenant budgets. [Source](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online).

### User limits

| Per-user category | Interval | Limit |
|---|---|---:|
| Requests | 5 min | 3,000 |
| Ingress | 1 H | 50 GB |
| Egress | 1 H | 100 GB |
| Delegation token requests | 5 min | 50 |
| External sharing emails | 1 H | 200 |

Source: [User throttling](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#user-throttling). User throttles aggregate applications acting on behalf of that user. The stated source uses application credentials, not a delegated SharePoint user: application permissions associate the grant with the tenant/application, not the administrator who consented. Do not mistakenly apply the consenting admin's personal egress allowance to every app-only job. [Microsoft scanning authorization guidance](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/scan-guidance?view=odsp-graph-online#authorization-types-permission-scopes-and-users).

### Resource-unit costs

| Graph operation | RU/request |
|---|---:|
| Single-item query | 1 |
| Delta with a token | 1 |
| Download file from drive item | 1 |
| Multi-item query / list children / initial delta without token | 2 |
| Create, update, delete, upload | 2 |
| Permission-resource operations, including permission expansion | 5 |

Source: [Resource units and handling throttling](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online). These are request costs, not a promise that copying a file end-to-end costs only the download RU. Listings, metadata, range reopens, permission operations, and retries can increase total consumption. Microsoft explicitly says throttled requests still count; batch subrequests are evaluated individually. [Same source](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#how-to-handle-throttling).

## Download redirects: what is known and what is not

Graph `/drives/{drive-id}/items/{item-id}/content` returns **HTTP 302** to the same URL exposed as `@microsoft.graph.downloadUrl`. Follow `Location`; the download URL needs no Authorization header and may expire within minutes. Range headers must be sent to the actual download URL, not to `/content`. [Graph download documentation](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0).

**[UNVERIFIED]** Neither this download documentation nor the reviewed SharePoint throttling/scanning pages spells out how the redirected byte stream is attributed to the originating app, whether each range request adds a distinct RU, or whether any separate download-host allowance applies. The documented app egress limit and download operation cost remain the appropriate conservative planning inputs; absence of an Authorization header is not proof of an exemption. [Sources: Graph download](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0), [SharePoint throttling](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online).

The SharePoint page also publishes **per-site anonymous-link 3,000 requests per 5 minutes** and **anonymous egress 100 GB per 2 hours**. **[UNVERIFIED]** It does not equate preauthenticated Graph URLs with anonymous sharing links. Do not substitute those limits for authenticated app downloads without Microsoft confirmation. [Other limits](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#other-limits).

## Large-migration operational guidance

- Schedule heavy work for nights/weekends **in the tenant region's time zone**. Microsoft says background migration/DLP/backup applications get tighter throttling during weekday daytime. This helps attain available capacity; it does not document an increase to the published app egress allowance. [Throttling](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#peak-vs-off-peak-usage), [Migration performance](https://learn.microsoft.com/en-us/sharepointmigration/sharepoint-online-and-onedrive-migration-speed).
- Respect **429/503 `Retry-After`**, which is in seconds. Microsoft's scan guidance says pause **all further service requests** while recovering, especially across concurrent threads. Aggressive retries consume quota and prolong throttling; persistent abusive behavior can be blocked. [Scanning guidance](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/scan-guidance?view=odsp-graph-online#what-happens-when-you-get-throttled), [Throttling guidance](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#retry-after-header).
- The currently retrieved throttling article contains stale-looking introductory recommendations mentioning `RateLimit`, but its dedicated section explicitly says SharePoint **does not return/support IETF RateLimit headers** and applications should not depend on them. Use `Retry-After`; do not build a guaranteed remaining-budget dashboard around RateLimit headers. [Current dedicated section](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#ratelimit-headers).
- Decorate traffic with registered AppID/AppTitle and a User-Agent following **`ISV|CompanyName|AppName/Version`**, or **`NONISV|CompanyName|AppName/Version`** for an enterprise application. Microsoft says decorated traffic is prioritized over undecorated traffic. This is not permission to exceed quotas. rclone explicitly recommends its `--user-agent` flag for SharePoint throttling. [Microsoft decoration](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#how-to-decorate-your-http-traffic), [rclone troubleshooting](https://rclone.org/onedrive/#excessive-throttling-or-blocked-on-sharepoint).
- Use drive-root delta discovery, follow next links, and persist delta links when implementing actual incremental change tracking; Microsoft recommends this over repeated broad polling. **rclone delta listing should not be assumed to provide persisted cross-run incremental tokens just because it uses the delta API.** [Microsoft scan guidance](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/scan-guidance?view=odsp-graph-online#crawl-and-process-by-using-delta-query), [rclone delta option](https://rclone.org/onedrive/#onedrive-delta).

### Do not confuse import performance with export throughput

Microsoft's Migration API/SPMT/Migration Manager performance article publishes estimated maximum speeds of **10 TB/day** for light metadata/large files, **1 TB/day** for medium metadata/Office files around **1.5 MB**, and **250 GB/day** for heavy metadata/small files around **50 kb**, using Microsoft's capitalization. Its data path uploads to Azure and then imports into SharePoint. **Those figures are not a measured or promised Graph-download rate for SharePoint-to-Google migration.** [Migration performance guide](https://learn.microsoft.com/en-us/sharepointmigration/sharepoint-online-and-onedrive-migration-speed).

The same article provides a support-request procedure for migrations **over 100 TB occurring within the next 30 days**, in that import context. It explicitly says throttling cannot be disabled/suspended and opening a support ticket does not lift it. [INFERENCE] Discuss an unusually large export and precise download attribution with Microsoft support, but do not present that import procedure as a special export-quota grant. [Large migration section and FAQ](https://learn.microsoft.com/en-us/sharepointmigration/sharepoint-online-and-onedrive-migration-speed#large-migrations-over-100-tb).

## rclone OneDrive/SharePoint behavior

### Listing and relevant backend options

- **`--fast-list` alone is insufficient on OneDrive.** It requires `--onedrive-delta` or `delta = true` to advertise recursive `ListR` support. Default delta is false. Delta listing retrieves the drive efficiently but always starts at the drive root; many independently scheduled subfolder jobs can repeatedly scan the same entire drive. [rclone fast-list](https://rclone.org/onedrive/#fast-list), [delta option](https://rclone.org/onedrive/#onedrive-delta).
- **`--onedrive-list-chunk`** sets listing page size, default **1000**. This is not file-download concurrency or a quota increase. [rclone option](https://rclone.org/onedrive/#onedrive-list-chunk).
- **`--onedrive-chunk-size`** is an **upload** option, not a source-download throughput lever. [rclone option](https://rclone.org/onedrive/#onedrive-chunk-size).
- Use the already-provisioned own client ID rather than rclone's shared default identity; rclone documents that the default client ID is shared and a custom identity can help throttling. This is different from creating many IDs for the same migration to bypass limits, which Microsoft explicitly tells developers not to do. [rclone client ID](https://rclone.org/onedrive/#getting-your-own-client-id-and-key), [Microsoft prohibition/guidance](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#common-throttling-scenarios-in-sharepoint-online).
- OneNote files are hidden by default because ordinary open/update do not work; enabling `--onedrive-expose-onenote-files` makes them visible, not downloadable as ordinary files. This is a completeness caveat separate from throughput. [rclone OneNote option](https://rclone.org/onedrive/#onedrive-expose-onenote-files).

### Pacing and process coordination

The upstream OneDrive implementation has a backend pacer, retries transient HTTP errors, and parses `Retry-After` for throttling/service-busy responses into a pacer retry delay. Normal `Object.Open` uses Graph `/content` and redirect handling. These are **source observations**, not proof that the locally bundled release matches upstream master. [Official rclone source: `shouldRetry`, `NewFs`, `Object.Open`](https://github.com/rclone/rclone/blob/master/backend/onedrive/onedrive.go). No repository or installed-version checks were performed for this research.

For operator control, use documented generic options rather than inventing a OneDrive pacer CLI flag:

| Control | Purpose | Source |
|---|---|---|
| `--tpslimit`, `--tpslimit-burst` | Bound HTTP transactions and bursts; transactions are not RU-weighted budgets | [rclone TPS](https://rclone.org/docs/#tpslimit-float) |
| `--transfers` | Bound parallel file transfers | [rclone transfers](https://rclone.org/docs/#transfers-int) |
| `--checkers` | Bound checking and other backend parallelism | [rclone checkers](https://rclone.org/docs/#checkers-int) |
| `--bwlimit` | Limit transfer bandwidth; time-dependent schedules supported | [rclone bandwidth](https://rclone.org/docs/#bwlimit-bwtimetable) |
| `--low-level-retries`, `--retries`, `--retries-sleep` | Control request-level and whole-operation retries; not a replacement for honoring server delay | [rclone retry options](https://rclone.org/docs/#low-level-retries-int) |
| `--user-agent` | Apply Microsoft-compatible traffic decoration | [rclone SharePoint troubleshooting](https://rclone.org/onedrive/#excessive-throttling-or-blocked-on-sharepoint) |

**[INFERENCE]** Independent Migmate/rclone processes using the same app/tenant consume the same upstream budgets, but backend-local pacers do not constitute a tenant-wide scheduler. Aggregate concurrency, bandwidth and backoff need coordination across jobs; a per-process TPS/bandwidth setting multiplied across jobs can exceed the intended total. This follows from the documented app/tenant accounting, the backend-local pacer implementation, and Microsoft's instruction to pause concurrent requests on throttle. [Microsoft limits](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online), [Microsoft scan guidance](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/scan-guidance?view=odsp-graph-online#what-happens-when-you-get-throttled), [rclone source](https://github.com/rclone/rclone/blob/master/backend/onedrive/onedrive.go).

## Bottom line and sizing model

**[UNVERIFIED scenario inputs]** The requested migration envelope is **80–120 TB and 17–25 million files**, with a hypothetical destination **10–15 TB/day**. These are supplied planning assumptions, not Microsoft/rclone measured figures. All derived quantities below are **[INFERENCE]**, use decimal storage units, and derive from those inputs plus [Microsoft's published limits](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online).

- Byte ceiling for one app/tenant, assuming an entire day at the published hourly allowance: **400 GB/hour × 24 = 9.6 TB/day**. With only **12 hours/day** at that rate, the corresponding hypothetical maximum is **4.8 TB/day**. Neither is an attainable-throughput guarantee.
- Sustaining **10–15 TB/day** would require about **417–625 GB/hour**, exceeding the published **400 GB/hour** allowance under the same decimal interpretation. Thus the Google-side account multiplication cannot by itself deliver the proposed end-to-end speed.
- Cross-envelope mean file size is approximately **3.2–7.1 MB**. This is an envelope from dividing the independent extremes, not an observed file-size distribution.
- At the lowest license tier, even an idealized **1 RU/file download only** allows at most **1.2 million files/day**, or about **3.84–8.47 TB/day** across that mean-size envelope, before any metadata/listing/retry overhead. If total source consumption averages **2 RU/file**, these illustrative ceilings halve to approximately **1.92–4.24 TB/day**. Actual rclone RU/file is **[UNVERIFIED]** and must be measured/estimated from its request mix.
- Illustrative pure-download file-count minimum duration for the given envelope: **14.2–20.8 days** at **1.2 million RU/day** versus **2.8–4.2 days** at **6 million RU/day**. The byte ceiling alone gives **8.3–12.5 days**. Real duration is no less than the most restrictive applicable model and grows with overhead, retries, limited windows, user traffic, and validation/cutover work. These are arithmetic lower bounds, not project commitments.

A useful model is:

`payload/day <= min(400 GB × active hours, app RU/day × average payload/file ÷ measured RU/file, achievable network/client/destination throughput)`

Also enforce the per-minute app budget and tenant aggregate budget; a daily average does not make request bursts safe. [Published constraints](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online).

**Recommendation [INFERENCE]:** Do not promise a sustainable TB/day value until a representative pilot measures useful bytes/day, files/day, scan volume, throttle/retry time and the source license tier across peak/off-peak conditions. Size the initial plan below the smaller of byte and RU ceilings, use drive-aligned scheduling and delta listing where appropriate, coordinate all jobs sharing the source identity, and schedule bulk work off-peak. More eligible source licenses increase RU budgets **but not the published app bandwidth allowance**; legitimate existing Multi-Geo placement can affect separate resource budgets; extra AppIDs for the same work are explicitly discouraged/prohibited by Microsoft's technical guidance, not a supported scaling strategy. [Microsoft throttling](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online), [rclone delta](https://rclone.org/onedrive/#onedrive-delta).
