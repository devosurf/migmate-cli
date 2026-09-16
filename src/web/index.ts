import { release } from "node:os";
import type { Application } from "@webviewjs/webview";
import type { Engine, JobRef, Outcome } from "../engine/index.ts";
import { allowedNavigation, createProtocolHandler } from "./protocol.ts";
import { WebSession } from "./session.ts";

export { createProtocolHandler, allowedNavigation } from "./protocol.ts";
export { WebSession } from "./session.ts";

export interface WebExit {
  job: JobRef;
  reason: "window_closed" | "process_quit";
  interrupted: boolean;
}
export type WebOutcome<T> =
  | Outcome<T>
  | {
      ok: false;
      refusal: {
        code: "web_runtime_unavailable";
        message: string;
        detail: { platform: string; arch: string; requirement: string };
      };
    };

function unavailable(requirement: string): WebOutcome<never> {
  return {
    ok: false,
    refusal: {
      code: "web_runtime_unavailable",
      message:
        "The required native webview runtime is unavailable. Use the complete CLI surface; no alternate transport was opened.",
      detail: { platform: process.platform, arch: process.arch, requirement },
    },
  };
}

/** Same Engine, same accountable Node PID; no engine service or browser bridge. */
export async function launchWeb(options: {
  engine: Engine;
  job: JobRef;
}): Promise<WebOutcome<WebExit>> {
  if (!["darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    return unavailable("macOS 13.5+ or a Linux desktop on x64/arm64 with Node 24");
  }
  if (process.platform === "darwin") {
    const [major, minor] = release().split(".").map(Number);
    if (major! < 22 || (major === 22 && minor! < 6))
      return unavailable("macOS 13.5 or later (Node 24 runtime floor)");
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return unavailable("A real X11 or Wayland desktop session, WebKitGTK 4.1, and libxdo");
  }
  let app: Application | undefined;
  try {
    // Lazy loading keeps every CLI command usable without Linux GUI libraries.
    const runtime = await import("@webviewjs/webview");
    app = new runtime.Application();
    await app.whenReady(); // Runs the nonblocking native pump, never runSync().
  } catch {
    app?.exit();
    return unavailable(
      process.platform === "linux"
        ? "WebKitGTK 4.1 and libxdo, plus the matching @webviewjs/webview 0.4.5 binding"
        : "WKWebView and the matching @webviewjs/webview 0.4.5 binding",
    );
  }

  const session = new WebSession(options);
  // A Promise does not keep Node alive. The window may disappear while execute
  // remains accountable here; this reference lasts through checkpoint and release.
  const keepAlive = setInterval(() => {}, 1000);
  let reason: WebExit["reason"] = "window_closed";
  let finishing: Promise<void> | null = null;
  let finished!: () => void;
  let failed!: (error: unknown) => void;
  const lifetime = new Promise<void>((resolve, reject) => {
    finished = resolve;
    failed = reject;
  });
  const finish = (interrupt: boolean) => {
    if (interrupt) {
      reason = "process_quit";
      session.abort.abort();
    }
    if (finishing) return;
    finishing = session.close(interrupt).then(finished, failed);
  };
  const quit = () => {
    finish(true);
  };
  const windowClosed = () => {
    finish(false);
  };
  const menu = (event: { customMenuEvent?: { id: string } }) => {
    if (event.customMenuEvent?.id === "migmate-quit") quit();
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  app.on("application-close-requested", windowClosed);
  app.on("custom-menu-click", menu);
  try {
    await session.open();
    if (session.abort.signal.aborted) {
      await lifetime;
      return { ok: true, value: { job: options.job, reason, interrupted: session.interrupted } };
    }
    try {
      // Custom quit, never the native quit role: checkpoint before process exit.
      app.setMenu({
        items: [
          {
            label: "Migmate",
            submenu: {
              items: [
                { id: "migmate-quit", label: "Quit Migmate safely", accelerator: "CmdOrCtrl+Q" },
              ],
            },
          },
          {
            label: "Edit",
            submenu: {
              items: [
                { role: "undo" },
                { role: "redo" },
                { role: "cut" },
                { role: "copy" },
                { role: "paste" },
                { role: "selectall" },
              ],
            },
          },
        ],
      });
      const window = app.createBrowserWindow({
        title: `Migmate · ${options.job.id}`,
        width: 1440,
        height: 960,
      });
      window.registerProtocol("migmate", createProtocolHandler({ session, onQuit: quit }));
      window.createWebview({
        url: "migmate://localhost/",
        enableDevtools: false,
        incognito: true,
        autoplay: false,
        backForwardNavigationGestures: false,
        navigationHandler: (url) => allowedNavigation(url),
      });
    } catch {
      await session.close(true);
      return unavailable(
        "A working native desktop webview: WKWebView or WebKitGTK 4.1 with libxdo",
      );
    }
    await lifetime;
    return { ok: true, value: { job: options.job, reason, interrupted: session.interrupted } };
  } finally {
    process.off("SIGINT", quit);
    process.off("SIGTERM", quit);
    app.off("application-close-requested", windowClosed);
    app.off("custom-menu-click", menu);
    try {
      await session.close();
    } finally {
      app.exit();
      clearInterval(keepAlive);
    }
  }
}
