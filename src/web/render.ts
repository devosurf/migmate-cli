import { hostname, userInfo } from "node:os";
import { VERBS, type Row, type RowPage } from "../engine/index.ts";
import { isAcceptable } from "../engine/codes.ts";
import type { ViewQuery, WebSnapshot } from "./session.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function actionForm(action: string, label: string, disabled: boolean, fields = ""): string {
  return `<form data-action="${action}"><fieldset${disabled ? " disabled" : ""}>${fields}<button type="submit">${escapeHtml(label)}</button></fieldset></form>`;
}

function sourceLink(value: string | null): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `<small><a href="${escapeHtml(value)}" rel="noopener noreferrer">Open source notebook</a></small>`;
  } catch {
    return "";
  }
}

/** Both row variants have one paging/filtering surface; only cells differ. */
function reviewTable(page: RowPage | null, query: ViewQuery): string {
  if (!page) return "<p>No row evidence is available yet.</p>";
  const selected = query.codes ?? [];
  const cells = (row: Row): string => {
    const identity =
      row.jobType === "file_migration"
        ? `<strong>${escapeHtml(row.relativePath)}</strong><small>Mapping ${escapeHtml(row.mappingId)} · Source ${escapeHtml(row.sourceItemId)}<br>Destination ${escapeHtml(row.destinationFileId ?? "not committed")}</small>${row.sourcePackageSections !== null && row.kind === "planned_omission" ? sourceLink(row.sourceWebUrl) : ""}`
        : `<strong>${escapeHtml(row.conversationId)}</strong><small>Scope entry ${escapeHtml(row.scopeEntryId)}</small>`;
    const evidence =
      row.jobType === "file_migration"
        ? `${row.size === null ? "size unknown" : `${escapeHtml(row.size)} bytes`}<small>Provenance: ${escapeHtml(row.provenanceState)}</small>${row.sourcePackageSections !== null ? `<small>${escapeHtml(row.sourcePackageSections)} sections</small>` : ""}${row.omissionReason ? `<small>${escapeHtml(row.omissionReason)}</small>` : ""}${row.nextStep ? `<small>Next step: ${escapeHtml(row.nextStep)}</small>` : ""}`
        : `${escapeHtml(row.records)} records · ${escapeHtml(row.assets)} assets<small>Watermark: ${escapeHtml(row.watermark ?? "not collected")}</small>`;
    return `<tr data-code="${escapeHtml(row.code)}"><td>${identity}</td><td><code>${escapeHtml(row.code)}</code><small>${escapeHtml(row.kind)}</small></td><td>${evidence}</td><td>${row.accepted ? "Accepted exception — still disclosed" : "Not accepted"}</td></tr>`;
  };
  return `<section class="review" aria-label="Paged evidence review">
    <form data-filter><label>Search stable identity or path<input name="search" value="${escapeHtml(query.search ?? "")}" type="search"></label>
    <label>Order<select name="sort">${["natural", "path", "size"].map((sort) => `<option${query.sort === sort ? " selected" : ""}>${sort}</option>`).join("")}</select></label>
    <label>Page size<select name="limit">${[25, 50, 100].map((limit) => `<option${(query.limit ?? 50) === limit ? " selected" : ""}>${limit}</option>`).join("")}</select></label>
    <fieldset class="facets"><legend>Outcome codes · whole matching set</legend>${page.facets.map((facet) => `<label><input type="checkbox" name="codes" value="${escapeHtml(facet.code)}"${selected.includes(facet.code) ? " checked" : ""}><code>${escapeHtml(facet.code)}</code><strong>${escapeHtml(facet.count)}</strong></label>`).join("") || "<p>No matching codes.</p>"}</fieldset><button type="submit">Apply filters</button><button type="button" data-reset-filters>Clear filters</button></form>
    <div class="row-page"><p><strong>${escapeHtml(page.totalRows)}</strong> matching rows. Facet counts cover the whole matching set, not this page.</p>
    <div class="table-scroll"><table><thead><tr><th>Item / conversation</th><th>Outcome</th><th>Evidence</th><th>Acceptance</th></tr></thead><tbody>${page.rows.map(cells).join("") || '<tr><td colspan="4">No rows match these filters.</td></tr>'}</tbody></table></div>
    <div class="paging"><button type="button" data-first-page${query.cursor ? "" : " disabled"}>First page</button><button type="button" data-next-cursor="${escapeHtml(page.nextCursor ?? "")}"${page.nextCursor ? "" : " disabled"}>Next page</button></div></div></section>`;
}

function progress(snapshot: WebSnapshot): string {
  const status = snapshot.status;
  const value = status?.progress;
  const archive = status?.archiveProgress;
  const passes = status?.mappingPasses ?? [];
  return `<dl class="progress"><dt>Durable state</dt><dd>${escapeHtml(status?.state ?? "unavailable")}</dd>
    <dt>Terminal outcome</dt><dd>${escapeHtml(status?.terminalState ?? "not terminal")}</dd><dt>Resumable</dt><dd>${status?.resumable ? "Yes — re-invoke execute" : "No"}</dd>
    ${value ? `<dt>${escapeHtml(value.unit)}</dt><dd>${escapeHtml(value.done)}${value.total === null ? " · total not known" : ` of ${escapeHtml(value.total)}`}</dd>` : passes.length ? "" : "<dt>Progress</dt><dd>No committed progress yet</dd>"}
    ${archive ? `<dt>Conversations</dt><dd>${archive.conversations} of ${archive.totalConversations}</dd><dt>Records</dt><dd>${archive.records}${archive.totalRecords === null ? " · total not known" : ` of ${archive.totalRecords}`}</dd><dt>Assets</dt><dd>${archive.assets}</dd><dt>Bytes</dt><dd>${archive.bytes}</dd>` : ""}</dl>
    ${passes.length ? `<section aria-label="Mapping copy progress"><h3>Mapping passes</h3><div class="table-scroll"><table><thead><tr><th>Mapping</th><th>Pass</th><th>State</th><th>Bytes</th><th>Files</th><th>Speed</th><th>Errors</th><th>Failure</th></tr></thead><tbody>${passes.map((pass) => `<tr><td>${escapeHtml(pass.mappingId)}</td><td>${escapeHtml(pass.passNumber)}</td><td>${escapeHtml(pass.status)}</td><td>${escapeHtml(pass.lastStats?.bytes ?? "—")}</td><td>${escapeHtml(pass.lastStats?.files ?? "—")}</td><td>${pass.lastStats ? `${escapeHtml(pass.lastStats.speed)} bytes/s` : "—"}</td><td>${escapeHtml(pass.lastStats?.errors ?? "—")}</td><td>${escapeHtml(pass.error ?? "—")}</td></tr>`).join("")}</tbody></table></div></section>` : ""}`;
}

function planReview(snapshot: WebSnapshot): string {
  const plan = snapshot.plan;
  return `<section aria-label="Exact plan review"><h3>Exact plan review</h3><p>Plan digest <code>${escapeHtml(snapshot.status?.planDigest ?? "not planned")}</code></p>
    ${
      plan
        ? `<p>Revision ${plan.revision}${plan.stage ? ` · ${escapeHtml(plan.stage)}` : ""} · source evidence ${escapeHtml(plan.sourceInventoryAt)} · inventory age ${Math.max(0, Math.floor((Date.now() - Date.parse(plan.sourceInventoryAt)) / 1000))} seconds</p>
    <ul>${(plan.disclosures ?? []).map((disclosure) => `<li>${escapeHtml(disclosure)}</li>`).join("")}</ul>
    ${(plan.sections ?? []).map((section) => `<section><h4>${escapeHtml(section.title)}</h4><pre>${escapeHtml(section.body)}</pre></section>`).join("")}`
        : "<p>The persisted plan review is not available. Make a plan before approval.</p>"
    }</section>`;
}

function declaredIdentity(snapshot: WebSnapshot): string {
  const identity =
    snapshot.status?.lastInteractiveIdentity ?? `${userInfo().username}@${hostname()}`;
  return `<p>This is a recorded local attestation, not authentication or proof that a human acted. Shell or browser automation can submit the same action.</p><label>Unverified declared identity<input name="approver" value="${escapeHtml(identity)}" required autocomplete="username"></label>`;
}

function authorityConfirmations(snapshot: WebSnapshot): string {
  const authority = snapshot.status?.approvalAuthority;
  const mirror = authority?.mirrorChanges ?? [];
  const access = authority?.accessChanges ?? [];
  return `${mirror.length ? `<section><h3>Changed mirror deletion authority</h3><ul>${mirror.map((change) => `<li>${escapeHtml(change.mappingId)}: ${escapeHtml(change.source)} → ${escapeHtml(change.destination)}; delete limit ${change.deleteLimit} (previous ${change.previousDeleteLimit ?? "none"})</li>`).join("")}</ul><p>These are authority limits, not predicted deletions. Actual deletions remain unknown until execution.</p><label class="confirmation"><input type="checkbox" name="confirmMirror" required>I confirm this changed set of mirror deletion authority and limits.</label></section>` : ""}
    ${access.length ? `<section><h3>Changed access authority</h3><ul>${access.map((change) => `<li>${escapeHtml(change.mappingId)}: ${escapeHtml(change.email)} (${escapeHtml(change.type)}), ${escapeHtml(change.previousRole ?? "no approved role")} → ${escapeHtml(change.role)}; grant timing: ${escapeHtml(change.timing)}</li>`).join("")}</ul><p>These identities have no verified internal/external classification.</p><label class="confirmation"><input type="checkbox" name="confirmAccess" required>I confirm this changed set of member grants and roles.</label></section>` : ""}`;
}

function decisionRecords(snapshot: WebSnapshot): string {
  const status = snapshot.status;
  const records = [
    { title: "Current plan approval", value: status?.currentApproval },
    {
      title: "Current verification exceptions",
      value: status?.acceptedExceptions?.length ? status.acceptedExceptions : null,
    },
    { title: "Go-live authorization", value: status?.closeAuthorization },
  ].filter((record) => record.value);
  return records.length
    ? `<section aria-label="Recorded local attestations"><h3>Recorded local attestations · identities unverified</h3>${records.map((record) => `<details open><summary>${record.title}</summary><pre>${escapeHtml(JSON.stringify(record.value, null, 2))}</pre></details>`).join("")}</section>`
    : "";
}

function stagePanel(snapshot: WebSnapshot, query: ViewQuery): string {
  const disabled = snapshot.readonly || snapshot.busy !== null;
  const status = snapshot.status;
  switch (query.stage) {
    case "init":
      return `<h2>init · Job setup</h2><p>This page is bound to initialized job <code>${escapeHtml(snapshot.job.id)}</code> (${escapeHtml(status?.jobType ?? "unavailable")}). No other job is addressable from this window.</p>
      <p>Import or enter your JSON job configuration: stable source and destination IDs for a file mapping, or stable team/channel/user IDs for archive scope. Include typed file credential references only. Never paste a client secret, token, service-account key, or transfer-config contents.</p>
      <p>File mappings place source-root contents directly inside pre-existing destination folders. Archive scope expansion, retained-history/transcript/attachment-byte options, and the closed UTC modification window are frozen at plan time for review.</p>
      ${actionForm("onboard", "Save references and probe", disabled, '<label>Load a job configuration file<input type="file" data-config-file accept="application/json,.json"></label><label>Configuration (JSON references and job options)<textarea name="config" rows="18" required spellcheck="false" autocomplete="off"></textarea></label>')}
      <p>The writer validates and persists configuration as job.toml, probes references immediately, and records redacted preflight evidence. This adapter never writes job state or credential files.</p>`;
    case "doctor":
      return `<h2>doctor · Prove prerequisites</h2><p>The same checks gate planning. Failed consent, route, version, licensing, or runtime prerequisites are refusals, not retry loops.</p>${actionForm("doctor", "Run doctor", disabled)}
      ${snapshot.preflight ? `<h3>${snapshot.preflight.passed ? "Preflight passed" : "Preflight refused"}</h3>${snapshot.preflight.checks.map((check) => `<section class="check"><h4>${escapeHtml(check.title)} · ${escapeHtml(check.status)}</h4>${check.code ? `<code>${escapeHtml(check.code)}</code>` : ""}<pre>${escapeHtml(JSON.stringify(check.evidence, null, 2))}</pre></section>`).join("")}` : "<p>Run doctor or onboarding to record current preflight evidence.</p>"}`;
    case "plan":
      return `<h2>plan · Review proposed outcomes</h2>${actionForm("plan", "Make plan", disabled)}${status?.jobType === "file_migration" ? actionForm("plan", "Make final cutover plan", disabled, '<input type="hidden" name="final" value="true"><p>For a staged job: final execution settles the approved source content before full verification. Freeze the source before approving.</p>') : ""}${planReview(snapshot)}<p>Collisions must be resolved outside Migmate, or excluded by stable item identity in configuration followed by a new plan. There are no destructive remediation controls.</p>${reviewTable(snapshot.rows, query)}`;
    case "approve":
      return `<h2>approve · Bind your decision</h2>${planReview(snapshot)}${reviewTable(snapshot.rows, query)}
      ${actionForm("approve", "Approve this exact plan", disabled || !status?.planDigest || !snapshot.plan, `${declaredIdentity(snapshot)}<input type="hidden" name="planDigest" value="${escapeHtml(status?.planDigest ?? "")}">${authorityConfirmations(snapshot)}${snapshot.plan?.stage === "final" ? '<fieldset><legend>Source freeze attestation</legend><label>Who froze the source<input name="freezeBy" required></label><label>When (timestamp with timezone)<input name="freezeAt" placeholder="2026-10-04T12:00:00Z" required></label><label>How the source was frozen<textarea name="freezeHow" required></textarea></label><p>This is your attestation, not an automatic tenant lock or a claim of exact parity.</p></fieldset>' : ""}<label class="confirmation"><input type="checkbox" name="confirm" required>I approve the reviewed plan, scope, omissions, options and standing disclosures.</label>`)}<p>Approval does not execute the job. The displayed digest is captured automatically; changing the plan invalidates approval.</p>`;
    case "execute":
      return `<h2>execute · Foreground, checkpointed work</h2><p>Closing this window does not stop an active run. Quitting this process interrupts at the safest checkpoint; re-invoking execute resumes. Only cancel is a terminal stop, and it never rolls back destination writes.</p>${actionForm("execute", status?.resumable ? "Execute from last checkpoint" : "Execute approved plan", disabled)}${progress(snapshot)}${reviewTable(snapshot.rows, query)}`;
    case "status":
      return `<h2>status · Durable facts</h2><p>Status and row evidence remain readable while another process owns the job. Refreshes never acquire a lease.</p><button type="button" data-refresh>Refresh status</button>${progress(snapshot)}`;
    case "verify": {
      const groups = status?.exceptionGroups ?? [];
      const selectable = groups.filter(
        (group) => group.acceptable && !group.accepted && isAcceptable(group.code),
      );
      return `<h2>verify · Proof and exceptions</h2><p>File content proof is separate from structural and metadata proof. <code>content_verification_degraded</code> is not clean byte-level verification. Archive verification proves the local package against itself; it does not re-query the tenant.</p>${actionForm("verify", "Run verification again", disabled)}<p>Verification digest <code>${escapeHtml(status?.verificationDigest ?? "not verified")}</code>. Every re-verification invalidates prior acceptances.</p>${reviewTable(snapshot.rows, query)}
        <h3>Accept named exception groups</h3><p>Groups cover the entire verification, regardless of row filters. Counts are per group and may overlap; their sum is not a distinct-item count. Acceptance never relabels findings as success.</p>
        ${actionForm("accept", "Accept selected groups", disabled || !status?.verificationDigest || selectable.length === 0, `<input type="hidden" name="verificationDigest" value="${escapeHtml(status?.verificationDigest ?? "")}">${declaredIdentity(snapshot)}${groups.map((group) => `<section data-exception-code="${escapeHtml(group.code)}"><h4><code>${escapeHtml(group.code)}</code> · ${group.count} affected items</h4><p>${escapeHtml(group.consequence)}</p><ul>${group.examples.map((example) => `<li>${escapeHtml(example)}</li>`).join("")}</ul>${group.accepted ? "<p>Accepted exception — still disclosed</p>" : group.acceptable && isAcceptable(group.code) ? `<label class="confirmation"><input type="checkbox" name="codes" value="${escapeHtml(group.code)}">Select this group</label>` : "<p>This finding cannot be accepted.</p>"}</section>`).join("")}<label>Common rationale for the selected groups<textarea name="rationale" required rows="3"></textarea></label><p>No groups are selected by default. Changing the selection clears its confirmation.</p><label class="confirmation"><input type="checkbox" name="confirm" required><span data-group-confirmation>I confirm acceptance of 0 selected groups with this rationale.</span></label>`)}`;
    }
    case "report":
      return `<h2>report · Digest-bound artifacts</h2>${actionForm("report", "Generate report artifacts", disabled)}<p>Report digest <code>${escapeHtml(snapshot.artifacts?.reportDigest ?? "not generated")}</code></p>
      <ul class="artifacts">${(snapshot.artifacts?.artifacts ?? []).map((artifact) => `<li><strong>${escapeHtml(artifact.name)}</strong> · ${escapeHtml(artifact.format)}<br><code>${escapeHtml(artifact.path)}</code><br>Digest <code>${escapeHtml(artifact.digest)}</code></li>`).join("")}</ul><p>Open these artifacts from their job folder. A Teams archive is its own self-contained, JavaScript-free package; this window is not the archive reader.</p>`;
    case "close": {
      const review = status?.closeReview;
      const recovery =
        review?.authorized === true &&
        status?.closeAuthorization?.evidenceDigest === review.evidenceDigest;
      return `<h2>close · Authorize go-live</h2><p>Plan approval and a completed copy are not go-live authorization. Closure refuses while required verification gaps remain unaccepted. Exceptions remain in the completed report.</p><p>Reviewed evidence <code>${escapeHtml(review?.evidenceDigest ?? "not ready")}</code></p><ul>${(review?.consequences ?? []).map((consequence) => `<li>${escapeHtml(consequence)}</li>`).join("")}</ul><p>Pre-close report <code>${escapeHtml(snapshot.artifacts?.reportDigest ?? "not generated yet; readiness is required before authorization")}</code></p><ul>${(snapshot.artifacts?.artifacts ?? []).map((artifact) => `<li>${escapeHtml(artifact.name)}: <code>${escapeHtml(artifact.path)}</code> · ${escapeHtml(artifact.digest)}</li>`).join("")}</ul>${
        recovery
          ? actionForm(
              "close",
              "Resume authorized close",
              disabled || status?.state === "closed",
              '<p>Matching durable authorization is recorded below. Resume unfinished close work without a new go-live decision; the engine rechecks its binding.</p><input type="hidden" name="recovery" value="true">',
            )
          : actionForm(
              "close",
              "Authorize go-live and close",
              disabled || !review || status?.state === "closed",
              `${declaredIdentity(snapshot)}<input type="hidden" name="evidenceDigest" value="${escapeHtml(review?.evidenceDigest ?? "")}"><label class="confirmation"><input type="checkbox" name="confirmGoLive" required>I have reviewed the pre-close report and exceptions and authorize the listed go-live access consequences.</label>`,
            )
      }${progress(snapshot)}`;
    }
    case "cancel":
      return `<h2>cancel · Terminal stop</h2><p>Cancellation is irreversible for this job and never rolls back or deletes destination writes. To interrupt a run resumably, quit the owning process instead.</p>${actionForm("cancel", "Cancel job permanently", disabled, '<label>Reason<textarea name="reason" required rows="3"></textarea></label><label class="confirmation"><input type="checkbox" name="confirm" required>I understand this is a terminal cancellation, not an interruption or undo.</label>')}`;
  }
}

/** One render replaces the whole root, including every ownership statement. */
export function renderView(snapshot: WebSnapshot, query: ViewQuery): string {
  const status = snapshot.status;
  const readOnly = snapshot.readonly || snapshot.refusal !== null;
  const view = readOnly === snapshot.readonly ? snapshot : { ...snapshot, readonly: readOnly };
  const ownership = readOnly
    ? "Read-only — this window does not claim writer access"
    : `Writer access held by this Node process (PID ${process.pid})`;
  const refusal = snapshot.refusal;
  const recovery = refusal?.recovery;
  const holder = status?.ownership;
  return `<div id="workspace" data-access="${readOnly ? "read-only" : "writer"}" data-busy="${escapeHtml(snapshot.busy ?? "")}" data-plan-digest="${escapeHtml(status?.planDigest ?? "")}" data-verification-digest="${escapeHtml(status?.verificationDigest ?? "")}" data-close-digest="${escapeHtml(status?.closeReview?.evidenceDigest ?? "")}">
    <header><div><span class="eyebrow">MIGMATE · ${escapeHtml(status?.jobType ?? "job")}</span><h1>${escapeHtml(snapshot.job.id)}</h1></div><p data-ownership>${escapeHtml(ownership)}</p></header>
    <div class="layout"><nav aria-label="Job lifecycle"><ol>${VERBS.map((verb) => `<li><button type="button" data-stage="${verb}"${query.stage === verb ? ' aria-current="step"' : ""}><span>${verb}</span><small>${escapeHtml(status?.rail.find((entry) => entry.verb === verb)?.state ?? "pending")}</small></button></li>`).join("")}</ol></nav>
    <main id="stage" aria-live="polite">${
      refusal
        ? `<section class="refusal" role="alert"><h2>Refused · <code>${escapeHtml(refusal.code)}</code></h2><p>${escapeHtml(refusal.message)}</p><p data-ownership>${escapeHtml(ownership)}</p>${refusal.detail ? `<pre>${escapeHtml(JSON.stringify(refusal.detail, null, 2))}</pre>` : ""}
      ${
        recovery
          ? `<h3>Recovery report</h3><dl><dt>Recorded host</dt><dd>${escapeHtml(recovery.recordedHostId)}</dd><dt>This host</dt><dd>${escapeHtml(recovery.thisHostId)}</dd><dt>Owner</dt><dd>${recovery.holder ? `${escapeHtml(recovery.holder.kind)} PID ${recovery.holder.pid} · ${escapeHtml(recovery.holder.ownerUuid)}` : "absent"}</dd><dt>Heartbeat</dt><dd>${escapeHtml(recovery.holder?.heartbeatAt ?? "none")} · age ${escapeHtml(recovery.holder?.heartbeatAgeMs ?? "unknown")} ms</dd><dt>Worker</dt><dd>${recovery.workerAlive ? "alive" : "not confirmed alive"} · group ${escapeHtml(recovery.workerGroup ?? "none")}</dd><dt>Last checkpoint</dt><dd>${escapeHtml(recovery.lastCheckpoint ?? "none")}</dd><dt>Reclaimable</dt><dd>${recovery.reclaimable ? "Yes" : "No — engine adjudication required"}</dd></dl>
      ${refusal.code !== "foreign_host" ? actionForm("reclaim", recovery.workerAlive ? "Stop recorded worker and reclaim" : "Reclaim recorded lease", snapshot.busy !== null, `<label class="confirmation"><input type="checkbox" name="confirm" required>I acknowledge this report and request explicit reclaim.</label>${recovery.workerAlive ? '<label class="confirmation"><input type="checkbox" name="stopWorker" required>Stop the recorded worker group, terminate safely, and re-read the last checkpoint.</label>' : ""}`) : "<p>Foreign-host job state cannot be reclaimed on this host.</p>"}`
          : ""
      }</section>`
        : ""
    }
      ${snapshot.busy ? `<p class="running" role="status">${escapeHtml(snapshot.busy)} is running in the owning process. Reading remains available.</p>` : ""}
      ${stagePanel(view, query)}
      ${decisionRecords(snapshot)}
      ${snapshot.result && snapshot.result.action === query.stage && !["plan", "status", "doctor", "report"].includes(query.stage) ? `<details><summary>Recorded ${escapeHtml(query.stage)} result</summary><pre>${escapeHtml(JSON.stringify(snapshot.result.value, null, 2))}</pre></details>` : ""}
    </main><aside aria-label="Ownership and trust facts"><h2>Process and evidence</h2><p data-ownership>${escapeHtml(ownership)}</p><dl><dt>Recorded lease holder</dt><dd>${holder?.held ? `${escapeHtml(holder.kind ?? "process")} PID ${escapeHtml(holder.pid)} · host ${escapeHtml(holder.hostId)}` : "No recorded writer"}</dd><dt>Heartbeat</dt><dd>${escapeHtml(holder?.heartbeatAt ?? "none")}</dd><dt>Run-scoped worker</dt><dd>${status?.worker?.active ? "Active" : "Inactive"}<br>Group ${escapeHtml(status?.worker?.group ?? "none")}</dd><dt>Plan digest</dt><dd><code>${escapeHtml(status?.planDigest ?? "not planned")}</code></dd><dt>Verification digest</dt><dd><code>${escapeHtml(status?.verificationDigest ?? "not verified")}</code></dd><dt>Checkpoint</dt><dd><code>${escapeHtml(status?.lastCheckpoint ?? "none")}</code></dd></dl>
      <h3>No listener</h3><p>Native custom protocol → same in-process engine. No TCP, loopback, unix listener, browser tab, or engine service.</p><p>Closing this window does not stop an active run. Quitting the process interrupts at a safe checkpoint.</p>
      ${readOnly ? actionForm("acquire", "Request writer access", snapshot.busy !== null) : ""}${actionForm("quit", "Quit process safely", false, '<label class="confirmation"><input type="checkbox" name="confirm" required>I understand that quitting interrupts an active run at a safe checkpoint.</label>')}<h3>Equivalent CLI verb</h3><code>migmate ${query.stage} --job ${escapeHtml(snapshot.job.id)}</code>
    </aside></div></div>`;
}
