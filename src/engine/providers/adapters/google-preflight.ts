import type { GoogleAbout, ProviderPort } from "../port.ts";
import type { CheckResult } from "../../types.ts";
import type { FileContext } from "../../drivers/file-state.ts";

/** Google source drives the acting account cannot read, checked as that account. */
export async function unreadableSourceDrives(
  provider: Pick<ProviderPort, "readSharedDrive">,
  mappings: { sourceType?: string; sourceDriveId: string }[],
  signal?: AbortSignal,
  side: "source" | "destination" = "source",
): Promise<string[]> {
  const unreadable: string[] = [];
  for (const driveId of new Set(
    mappings.filter((m) => m.sourceType === "google_shared_drive").map((m) => m.sourceDriveId),
  )) {
    try {
      if ((await provider.readSharedDrive(driveId, signal, side))?.id !== driveId)
        unreadable.push(driveId);
    } catch {
      signal?.throwIfAborted();
      unreadable.push(driveId);
    }
  }
  return unreadable;
}

function domain(subject: string | undefined): string | null {
  const at = subject?.lastIndexOf("@") ?? -1;
  return at > 0 ? subject!.slice(at + 1).toLowerCase() : null;
}

/**
 * Both providers are named explicitly on a Google → Google config: an omitted provider
 * never defaults to Google on both sides. Importing the capability table here would
 * form a module cycle through google-capabilities.ts.
 */
function isGoogleToGoogle(ctx: FileContext): boolean {
  return (
    ctx.config.sourceProvider === "google_shared_drive" &&
    ctx.config.destinationProvider === "google_shared_drive"
  );
}

export async function* googlePreflight(
  ctx: FileContext,
  destination: boolean,
): AsyncGenerator<CheckResult, boolean> {
  const provider = ctx.provider;
  // Google → Google reads with a separate read-only account (ADR-0018 D4).
  const googleToGoogle = isGoogleToGoogle(ctx);
  const separateSource = !destination && googleToGoogle;
  const side = destination ? "destination" : "source";
  const prefix = separateSource ? "google.source." : "google.";
  const impersonate = separateSource ? ctx.config.sourceImpersonate : ctx.config.impersonate;
  const subject = separateSource ? ctx.config.sourceSubject : ctx.config.subject;
  const scope = separateSource
    ? "https://www.googleapis.com/auth/drive.readonly"
    : "https://www.googleapis.com/auth/drive";
  let about: GoogleAbout | undefined;
  try {
    about = await provider.googleAbout(ctx.signal, side);
  } catch {
    ctx.signal?.throwIfAborted();
    // An inaccessible identity cannot be bound into the plan.
  }
  const actualSubject = about?.user.emailAddress ?? null;
  if (impersonate) {
    const pass = actualSubject === subject;
    yield {
      id: `${prefix}delegation`,
      title: separateSource
        ? "Google reads the source as the configured source subject"
        : "Google acts as the configured subject",
      status: pass ? "pass" : "fail",
      ...(pass ? {} : { code: "preflight_failed" }),
      evidence: {
        subject,
        actualSubject,
        ...(!pass
          ? {
              fix: `Authorize domain-wide delegation for the service account's numeric client id with only ${scope}, and use an ordinary non-admin subject.`,
            }
          : {}),
      },
    };
    if (!pass) return false;
  } else {
    const pass = Boolean(actualSubject);
    yield {
      id: `${prefix}actingAccount`,
      title: separateSource
        ? "Google identifies the read-only source service account"
        : "Google identifies the acting service account",
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
  // The writing account reads a Google source only when it copies it server side.
  if (destination && googleToGoogle)
    return ctx.config.options?.serverSideCopy === true ? yield* serverSideCopyCheck(ctx) : true;
  const unreadable = await unreadableSourceDrives(provider, ctx.config.mappings, ctx.signal);
  if (unreadable.length) {
    yield {
      id: "google.source_drives",
      title: separateSource
        ? "The read-only source account can read every source Shared Drive"
        : "Acting account can read every source Shared Drive",
      status: "fail",
      code: "preflight_failed",
      evidence: {
        unreadableSourceDrives: unreadable,
        subject: subject ?? null,
        fix: separateSource
          ? "Add the read-only source account as a member of every named source Shared Drive."
          : "Add the acting account as a member of every named source Shared Drive.",
      },
    };
    return false;
  }
  return true;
}

/**
 * ADR-0018 D10: a server-side copy runs as the destination's delegated account, so it is
 * allowed only inside one Workspace and only where that account already reads the source.
 * Migmate never grants it access; one email domain is how a single Workspace is proven.
 */
async function* serverSideCopyCheck(ctx: FileContext): AsyncGenerator<CheckResult, boolean> {
  const sourceDomain = ctx.config.sourceImpersonate ? domain(ctx.config.sourceSubject) : null;
  const destinationDomain = ctx.config.impersonate ? domain(ctx.config.subject) : null;
  const oneWorkspace = sourceDomain !== null && sourceDomain === destinationDomain;
  const unreadable = oneWorkspace
    ? await unreadableSourceDrives(ctx.provider, ctx.config.mappings, ctx.signal, "destination")
    : [];
  const pass = oneWorkspace && unreadable.length === 0;
  yield {
    id: "google.server_side_copy",
    title: "The destination account may copy the source server side inside one Workspace",
    status: pass ? "pass" : "fail",
    ...(pass ? {} : { code: "preflight_failed" }),
    evidence: {
      sourceSubject: ctx.config.sourceSubject ?? null,
      subject: ctx.config.subject ?? null,
      oneWorkspace,
      unreadableSourceDrives: unreadable,
      ...(!pass
        ? {
            fix: oneWorkspace
              ? "The destination acting account must already read every source Shared Drive, or set options.serverSideCopy = false to stream through this host."
              : "Server-side copy needs both sides to impersonate subjects in one Workspace domain; otherwise set options.serverSideCopy = false to stream through this host.",
          }
        : {}),
    },
  };
  return pass;
}
