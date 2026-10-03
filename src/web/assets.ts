// Strings are compiled into the installed artifact; no working-directory asset reads.
export const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Migmate · Job lifecycle</title><link rel="stylesheet" href="/style.css"><script src="/client.js" defer></script></head>
<body><div id="root"><p role="status">Opening the job's durable read model…</p></div><p id="connection" role="alert" hidden></p></body></html>`;

export const CSS = `
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;background:#111820;color:#e8edf2;--muted:#a8bac8;--line:#354454;--panel:#19232e;--accent:#9addc8}
*{box-sizing:border-box}body{margin:0}button,input,select,textarea{font:inherit}button{cursor:pointer;color:inherit;background:#263746;border:1px solid #516575;border-radius:5px;padding:.65rem .85rem}button:hover:not(:disabled){border-color:var(--accent)}button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
header{position:sticky;top:0;z-index:2;background:#111820;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:2rem;padding:1rem 1.5rem}header h1{font-size:1.25rem;overflow-wrap:anywhere;margin:.4rem 0}.eyebrow{color:var(--accent);font-size:.75rem;letter-spacing:.1em}header p{max-width:28rem;font-size:.85rem}.layout{display:grid;grid-template-columns:150px minmax(400px,1fr) 270px;align-items:start}nav,aside{position:sticky;top:100px;max-height:calc(100vh - 110px);overflow:auto}nav{padding:1rem .5rem}nav ol{list-style:none;margin:0;padding:0}nav li{margin:0 0 .4rem}nav button{display:flex;justify-content:space-between;gap:.4rem;width:100%;text-align:left;background:none;border-color:transparent}nav button[aria-current]{border-color:var(--accent);background:#203b3b}nav small{color:var(--muted);font-size:.72rem}main{border-left:1px solid var(--line);border-right:1px solid var(--line);min-height:calc(100vh - 110px);padding:1.5rem;min-width:0}h2{font-size:1.4rem;margin:0 0 1rem}h3{font-size:1.05rem;margin:1.6rem 0 .6rem}h4{font-size:1rem}p,li{line-height:1.6}aside{padding:1.4rem;font-size:.86rem}aside h2{font-size:1rem}aside code{font-size:.8rem}dl{margin:1rem 0}dt{font-size:.8rem;color:var(--muted);margin-top:.8rem}dd{margin:.25rem 0;overflow-wrap:anywhere}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.85rem;overflow-wrap:anywhere}pre{white-space:pre-wrap;max-height:35rem;overflow:auto;background:#111820;padding:1rem;border-radius:4px}label{display:block;margin:.8rem 0;color:var(--muted)}input:not([type=checkbox]),select,textarea{display:block;width:100%;color:inherit;background:#111820;border:1px solid var(--line);padding:.6rem;margin-top:.4rem;border-radius:4px}input[readonly]{color:var(--accent)}input[type=checkbox]{margin-right:.6rem;accent-color:#7fd8b9}textarea{resize:vertical;font-family:ui-monospace,monospace;font-size:.85rem}.confirmation{color:inherit;line-height:1.5}fieldset{border:0;margin:0;padding:0}.refusal{border:1px solid #e6ab70;background:#342a22;padding:1rem;margin-bottom:1.5rem}.refusal h2{font-size:1.15rem}.running{background:#243c42;border-left:4px solid var(--accent);padding:1rem}.review{display:grid;grid-template-columns:minmax(170px,1fr) minmax(0,3fr);gap:1rem;margin:1.5rem 0}.review>form{background:#111820;padding:.8rem;align-self:start}.review label{font-size:.85rem}.facets{margin-top:1rem}.facets legend{color:var(--muted);font-size:.8rem}.facets label{display:grid;grid-template-columns:auto 1fr auto;align-items:start;gap:.25rem;overflow-wrap:anywhere}.facets code{font-size:.75rem}.facets strong{color:var(--accent)}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:.8rem;text-align:left}th{font-weight:500;color:var(--muted);background:#111820}td,th{padding:.8rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}td small{display:block;color:var(--muted);margin-top:.5rem;overflow-wrap:anywhere}td code{font-size:.75rem}td strong{font-weight:500;overflow-wrap:anywhere}.paging{display:flex;justify-content:space-between;gap:1rem;margin-top:1rem}.check,.artifacts li{border-top:1px solid var(--line);padding-top:.7rem}.artifacts{padding-left:1.2rem}.artifacts code{word-break:break-all}details{margin-top:1.5rem}#connection{background:#342a22;padding:1rem;margin:0;position:sticky;bottom:0}#root>p{padding:2rem}
@media(max-width:1100px){.layout{grid-template-columns:125px minmax(300px,1fr) 220px}.review{grid-template-columns:1fr}.facets{display:flex;flex-wrap:wrap;gap:.5rem}.facets label{max-width:24rem;margin:0}main{padding:1rem}}
@media(prefers-color-scheme:light){:root{color-scheme:light;background:#f5f7f8;color:#182934;--muted:#465e6e;--line:#bac9d2;--panel:#fff;--accent:#086647}header{background:#f5f7f8}button{background:#e6edef;color:#182934}nav button[aria-current]{background:#d8eee5}pre,input:not([type=checkbox]),select,textarea,.review>form,th{background:#fff}input[readonly]{color:#086647}.refusal,#connection{background:#fff1df}.running{background:#dceeed}}
`;

export const CLIENT = `"use strict";
(() => {
  const root = document.getElementById("root");
  const connection = document.getElementById("connection");
  let query = new URLSearchParams({stage:"status",limit:"50",sort:"natural"});
  let serial = Promise.resolve();
  let pending = 0;
  let stopped = false;
  let renderedQuery = "";

  function showFailure() {
    // Never leave stale ownership claims or active mutation controls on a failed refresh.
    root.querySelectorAll("[data-ownership]").forEach(node => { node.textContent = "Read-only — the current writer state could not be read"; });
    root.querySelectorAll("form[data-action] fieldset").forEach(node => { node.disabled = true; });
    const workspace = root.querySelector("#workspace");
    if (workspace) workspace.dataset.access = "read-only";
    connection.textContent = "The native request could not complete. This view is read-only until the durable state can be refreshed. No alternate connection was opened.";
    connection.hidden = false;
  }

  function install(html,responseQuery) {
    const old = root.querySelector("#workspace");
    const plan = old?.dataset.planDigest;
    const verification = old?.dataset.verificationDigest;
    const preserveFilters = renderedQuery === responseQuery;
    const drafts = [];
    const active = document.activeElement;
    root.querySelectorAll("form input[name],form textarea[name],form select[name]").forEach(field => {
      if (field.type === "hidden" || field.readOnly) return;
      const action = field.closest("form").dataset.action ?? "filter";
      if (action === "filter" && !preserveFilters) return;
      drafts.push({action,name:field.name,value:field.value,checked:field.checked,type:field.type,focus:field === active,start:field.selectionStart,end:field.selectionEnd});
    });
    // A single DOM replacement updates stage, header, and ownership column together.
    root.innerHTML = html;
    renderedQuery = responseQuery;
    const current = root.querySelector("#workspace");
    for (const draft of drafts) {
      const changed = draft.action === "approve" && plan !== current?.dataset.planDigest || draft.action === "accept" && verification !== current?.dataset.verificationDigest;
      for (const field of root.querySelectorAll("form input[name],form textarea[name],form select[name]")) {
        if ((field.closest("form").dataset.action ?? "filter") !== draft.action || field.name !== draft.name || field.type !== draft.type || (field.type === "checkbox" && field.value !== draft.value)) continue;
        if (field.type === "checkbox") { if (!changed) field.checked = draft.checked; }
        else field.value = draft.value;
        if (draft.focus && !field.disabled) {
          field.focus({preventScroll:true});
          if (draft.start !== null && draft.start !== undefined && typeof field.setSelectionRange === "function") {
            try { field.setSelectionRange(draft.start,draft.end); } catch { /* Search/input types may not support selection. */ }
          }
        }
      }
    }
    connection.hidden = true;
  }

  async function refresh() {
    const requestQuery = query.toString();
    const response = await fetch("/view?" + requestQuery, {cache:"no-store"});
    if (!response.ok) throw new Error("Read refused");
    install(await response.text(),requestQuery);
  }

  function enqueue(work) {
    pending++;
    serial = serial.then(work).catch(showFailure).finally(() => { pending--; });
    return serial;
  }

  async function command(action,input) {
    const requestQuery = query.toString();
    const response = await fetch("/command?" + requestQuery, {
      method:"POST",headers:{"Content-Type":"application/json","X-Migmate-Action":"1"},
      body:JSON.stringify({action,input})
    });
    if (response.status !== 202 && response.status !== 409) throw new Error("Native command failed");
    install(await response.text(),requestQuery);
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.stage) {
      query = new URLSearchParams({stage:button.dataset.stage,limit:"50",sort:"natural"});
      enqueue(refresh);
    } else if (button.hasAttribute("data-refresh")) enqueue(refresh);
    else if (button.hasAttribute("data-reset-filters")) {
      query = new URLSearchParams({stage:query.get("stage"),limit:"50",sort:"natural"});
      enqueue(refresh);
    } else if (button.hasAttribute("data-first-page")) { query.delete("cursor"); enqueue(refresh); }
    else if (button.dataset.nextCursor) { query.set("cursor",button.dataset.nextCursor); enqueue(refresh); }
  });

  document.addEventListener("submit", event => {
    const form = event.target;
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    if (form.hasAttribute("data-filter")) {
      const next = new URLSearchParams({stage:query.get("stage")});
      for (const [name,value] of data) next.append(name,String(value));
      query = next;
      enqueue(refresh);
      return;
    }
    const action = form.dataset.action;
    if (!action) return;
    let input = {};
    if (action === "onboard") {
      try { input.config = JSON.parse(String(data.get("config"))); }
      catch { connection.textContent = "Configuration must be valid JSON containing typed references, never secret values."; connection.hidden = false; return; }
    } else if (action === "plan") input = data.has("final") ? {final:true} : {};
    else if (action === "approve") input = {approver:data.get("approver"),planDigest:data.get("planDigest"),confirm:data.has("confirm"),...(data.has("freezeBy") ? {freezeBy:data.get("freezeBy"),freezeAt:data.get("freezeAt"),freezeHow:data.get("freezeHow")} : {})};
    else if (action === "accept") input = {approver:data.get("approver"),verificationDigest:data.get("verificationDigest"),codes:data.getAll("codes").map(code => ({code,...(data.get("note:"+code) ? {note:data.get("note:"+code)} : {})}))};
    else if (action === "cancel") input = {reason:data.get("reason"),confirm:data.has("confirm")};
    else if (action === "close") input = {confirm:data.has("confirm")};
    else if (action === "reclaim") input = {confirm:data.has("confirm"),stopWorker:data.has("stopWorker")};
    form.querySelector("fieldset").disabled = true;
    enqueue(async () => {
      if (action !== "quit") return command(action,input);
      const response = await fetch("/quit", {method:"POST",headers:{"Content-Type":"application/json","X-Migmate-Action":"1"},body:"{}"});
      if (!response.ok) throw new Error("Quit request refused");
      stopped = true;
    });
  });

  document.addEventListener("change", event => {
    const field = event.target;
    if (!field.hasAttribute("data-config-file") || !field.files?.[0]) return;
    const file = field.files[0];
    if (file.size > 1024 * 1024) { connection.textContent = "Job configuration exceeds the 1 MiB limit."; connection.hidden = false; return; }
    file.text().then(text => { field.closest("form").querySelector("textarea[name=config]").value = text; }).catch(showFailure);
  });

  enqueue(refresh);
  setInterval(() => { if (!pending && !stopped) enqueue(refresh); }, 1000);
})();`;
