import { Application } from "@webviewjs/webview";
import { randomBytes } from "node:crypto";
import type { ProbeCapture } from "../../src/qualification/bundle.ts";

// This child must complete a real native-document -> custom-protocol round trip.
// It is not the ten-verb web parity gate and never substitutes a browser/listener.
const startedAt = new Date().toISOString();
const app = new Application();
const nonce = randomBytes(24).toString("base64");
let timer: NodeJS.Timeout | undefined;
try {
  await app.whenReady();
  const window = app.createBrowserWindow({ title: "Migmate live route qualification", width: 720, height: 220, visible: true });
  const ready = Promise.withResolvers<void>();
  app.once("application-close-requested", () => ready.reject(new Error("desktop_runtime_unavailable")));
  timer = setTimeout(() => ready.reject(new Error("desktop_runtime_unavailable")), 30_000);
  window.registerProtocol("qualification", (request: Request) => {
    const url = new URL(request.url);
    const allowedOrigin = url.origin === "http://qualification.localhost" || url.origin === "https://qualification.localhost" || (url.protocol === "qualification:" && url.hostname === "localhost");
    if (!allowedOrigin || request.method !== "GET" || url.search) return new Response("Not found", { status: 404 });
    if (url.pathname === "/") return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Migmate route qualification</title><h1>Native desktop route probe</h1><p>This proves a native custom-protocol round trip only. Full lifecycle web parity is a separate gate.</p><script nonce="${nonce}">fetch('/roundtrip').then(r=>{if(r.ok)document.body.dataset.ready='true'})</script></html>`, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
        "Cache-Control": "no-store",
      },
    });
    if (url.pathname === "/roundtrip") {
      ready.resolve();
      return new Response("ready", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    }
    return new Response("Not found", { status: 404 });
  });
  const webview = window.createWebview({ url: "qualification://localhost/" });
  await ready.promise;
  const capture: ProbeCapture = {
    schemaVersion: 1, probeId: "desktop_runtime", startedAt, completedAt: new Date().toISOString(), codes: [],
    assertions: [{ id: "native_custom_protocol_roundtrip", expected: true, observed: true }],
    observations: { runtime: "@webviewjs/webview", version: "0.4.5", desktopCell: `${process.platform}-${process.arch}`, fullLifecycleParity: "separate_required_gate" },
  };
  process.stdout.write(`${JSON.stringify(capture)}\n`);
  // Keep the wrapper live until after its request callback has completed.
  void webview;
} finally {
  if (timer) clearTimeout(timer);
  app.exit();
}
