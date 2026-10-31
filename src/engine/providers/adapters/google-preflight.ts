import type { GoogleAbout, ProviderPort } from "../port.ts";
import type { CheckResult } from "../../types.ts";
import type { FileContext } from "../../drivers/file-state.ts";

/** Google source drives the acting account cannot read, checked as that account. */
export async function unreadableSourceDrives(
  provider: Pick<ProviderPort, "readSharedDrive">,
  mappings: { sourceType?: string; sourceDriveId: string }[],
  signal?: AbortSignal,
): Promise<string[]> {
  const unreadable: string[] = [];
  for (const driveId of new Set(
    mappings.filter((m) => m.sourceType === "google_shared_drive").map((m) => m.sourceDriveId),
  )) {
    try {
      if ((await provider.readSharedDrive(driveId, signal))?.id !== driveId)
        unreadable.push(driveId);
    } catch {
      signal?.throwIfAborted();
      unreadable.push(driveId);
    }
  }
  return unreadable;
}
export async function* googlePreflight(
  ctx: FileContext,
  destination: boolean,
): AsyncGenerator<CheckResult, boolean> {
  const provider = ctx.provider;
  let about: GoogleAbout | undefined;
  try {
    about = await provider.googleAbout(ctx.signal);
  } catch {
    ctx.signal?.throwIfAborted();
    // An inaccessible identity cannot be bound into the plan.
  }
  const actualSubject = about?.user.emailAddress ?? null;
  if (ctx.config.impersonate) {
    const pass = actualSubject === ctx.config.subject;
    yield {
      id: "google.delegation",
      title: "Google acts as the configured subject",
      status: pass ? "pass" : "fail",
      ...(pass ? {} : { code: "preflight_failed" }),
      evidence: {
        subject: ctx.config.subject,
        actualSubject,
        ...(!pass
          ? {
              fix: "Authorize domain-wide delegation for the service account's numeric client id with only https://www.googleapis.com/auth/drive, and use an ordinary non-admin subject.",
            }
          : {}),
      },
    };
    if (!pass) return false;
  } else {
    const pass = Boolean(actualSubject);
    yield {
      id: "google.actingAccount",
      title: "Google identifies the acting service account",
      status: pass ? "pass" : "fail",
      ...(pass ? {} : { code: "preflight_failed" }),
      evidence: { actualSubject },
    };
    if (!pass) return false;
  }
  if (destination && ctx.config.mappings.some((m) => m.createDrive)) {
    const canCreateDrives = about?.canCreateDrives ?? false;
    yield {
      id: "google.canCreateDrives",
      title: "Acting account may create Shared Drives",
      status: canCreateDrives ? "pass" : "fail",
      ...(canCreateDrives ? {} : { code: "preflight_failed" }),
      evidence: { canCreateDrives },
    };
    if (!canCreateDrives) return false;
  }
  const unreadable = await unreadableSourceDrives(provider, ctx.config.mappings, ctx.signal);
  if (unreadable.length) {
    yield {
      id: "google.source_drives",
      title: "Acting account can read every source Shared Drive",
      status: "fail",
      code: "preflight_failed",
      evidence: {
        unreadableSourceDrives: unreadable,
        subject: ctx.config.subject ?? null,
        fix: "Add the acting account as a member of every named source Shared Drive.",
      },
    };
    return false;
  }
  return true;
}
