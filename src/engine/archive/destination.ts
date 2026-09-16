import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ConversationCommitRow } from "../commit.ts";
import { CODE_BY_NAME } from "../codes.ts";
import type { ArchiveCommit, ArchiveDriverContext, ArchivePlan } from "../providers/archive.ts";
import type { DestinationEntry, ProvenanceRecord } from "../providers/port.ts";
import {
  hashStream,
  markerMatches,
  observe,
  outputFindings,
  readObject,
  type FileOutput,
} from "../drivers/file-state.ts";
import { canonicalJson } from "../store/digest.ts";
import { conversationPath } from "./package.ts";
import { writeConversationContainer } from "./container.ts";

/** Persisted before the create. A lost response is recovered by ID and marker,
 * never by a path match. Verified copies are immutable: this step only creates. */
export interface ArchiveDestinationState {
  version: 1;
  status: "prepared" | "verified";
  path: string;
  output: FileOutput;
  marker: ProvenanceRecord;
  revision: string | null;
}
interface Payload {
  path: string;
  name: string;
  mimeType: string;
  conversationId: string;
  scopeEntryId: string;
  container: boolean;
}
function payloads(plan: ArchivePlan): Payload[] {
  return [
    ...["index.html", "index.csv", "manifest.json"].map((path, index) => ({
      path,
      name: path,
      mimeType: ["text/html", "text/csv", "application/json"][index]!,
      conversationId: "archive",
      scopeEntryId: "",
      container: false,
    })),
    ...plan.conversations.map((conversation) => {
      const path = conversationPath(conversation);
      return {
        path,
        name: `${basename(path)}.zip`,
        mimeType: "application/zip",
        conversationId: conversation.id,
        scopeEntryId: conversation.scopeEntryId,
        container: true,
      };
    }),
  ];
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function states(ctx: ArchiveDriverContext): Map<string, ArchiveDestinationState> {
  return new Map(
    (ctx.resume.rows ?? []).flatMap((row) =>
      row.jobType === "teams_archive" && row.phase === "execute" && row.archiveDestination
        ? [[row.archiveDestination.path, row.archiveDestination] as const]
        : [],
    ),
  );
}
function unit(
  ctx: ArchiveDriverContext,
  phase: "execute" | "verify",
  payload: Payload,
  state: ArchiveDestinationState | undefined,
  codes: string[] = [],
): ArchiveCommit {
  const id = `archive-destination:${digest(payload.path)}`;
  const row: ConversationCommitRow = {
    id,
    rev: ctx.revision,
    phase,
    jobType: "teams_archive",
    code: "collected",
    kind: "policy_outcome",
    scopeEntryId: payload.scopeEntryId,
    conversationId: payload.conversationId,
    archiveObjectPath: payload.path,
    title: payload.name,
    records: 0,
    assets: 0,
    ...(state ? { archiveDestination: state } : {}),
  };
  const { archiveDestination: _state, ...findingRow } = row;
  const findings = codes.map((code) => {
    const definition = CODE_BY_NAME[code];
    if (!definition) throw new Error(`Unregistered archive destination outcome: ${code}`);
    return {
      rev: ctx.revision,
      phase,
      code,
      kind: definition.kind,
      subjectKind: "archive_object",
      subjectId: payload.path,
      evidence: { path: payload.path, destinationId: state?.output.id ?? null },
      at: ctx.now().toISOString(),
    };
  });
  return {
    rev: ctx.revision,
    phase,
    unitKey: `${id}:${phase}:${digest([state ?? null, codes])}`,
    checkpoint: `archive:destination:${payload.name}`,
    rows: [
      row,
      ...findings.map(({ code, kind }) => ({ ...findingRow, id: `${id}:${code}`, code, kind })),
    ],
    findings,
  };
}
function marker(
  ctx: ArchiveDriverContext,
  payload: Payload,
  output: FileOutput,
  manifestDigest: string,
): ProvenanceRecord {
  return {
    mappingId: `archive:${basename(ctx.jobDirectory)}`,
    sourceDriveId: "local_archive_package",
    sourceItemId: payload.path,
    sourceIdentity: manifestDigest,
    sourceKind: "file",
    sourceRelativePath: payload.path,
    sourceFingerprint: output.sha256,
    verifiedFingerprint: output.sha256,
    createdAt: output.createdAt,
    modifiedAt: output.modifiedAt,
    mimeType: output.mimeType,
    stateRevision: digest([manifestDigest, payload.path, output]),
  };
}
async function checkCopy(ctx: ArchiveDriverContext, state: ArchiveDestinationState) {
  const entry = await readObject(ctx.provider, state.output.driveId, state.output.id);
  if (!entry) return { codes: ["destination_missing"], revision: null };
  const actual = await observe(ctx, entry);
  const codes = outputFindings(actual, state.output);
  if (
    !actual.entry.revision ||
    (state.revision !== null && actual.entry.revision !== state.revision)
  )
    codes.push("prior_copy_drift");
  if (!markerMatches(actual.entry.provenance, state.marker)) codes.push("provenance_mismatch");
  return { codes, revision: actual.entry.revision };
}
function boundState(
  ctx: ArchiveDriverContext,
  plan: ArchivePlan,
  payload: Payload,
  state: ArchiveDestinationState,
  manifestDigest: string,
): boolean {
  return (
    state.version === 1 &&
    state.output.driveId === plan.config.destination!.destDriveId &&
    state.output.parentId === plan.config.destination!.destFolderId &&
    state.output.name === payload.name &&
    state.output.mimeType === payload.mimeType &&
    markerMatches(state.marker, marker(ctx, payload, state.output, manifestDigest))
  );
}

async function childrenByName(ctx: ArchiveDriverContext, folderId: string) {
  const byName = new Map<string, DestinationEntry[]>();
  for (const entry of await ctx.provider.listDestinationChildren(folderId)) {
    const entries = byName.get(entry.name) ?? [];
    entries.push(entry);
    byName.set(entry.name, entries);
  }
  return byName;
}

/** Called only after the on-disk package has passed self-verification. */
export async function* uploadArchiveDestination(
  ctx: ArchiveDriverContext,
  plan: ArchivePlan,
  manifestDigest: string,
): AsyncGenerator<ArchiveCommit> {
  const destination = plan.config.destination!;
  const root = await ctx.provider.resolveDestinationFolder(destination);
  if (!root || root.kind !== "folder" || root.driveId !== destination.destDriveId)
    throw Object.assign(new Error("Archive destination root is unavailable"), {
      code: "destination_missing",
    });
  const saved = states(ctx);
  const staging = join(ctx.jobDirectory, "assets", ".staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(staging, "archive-"));
  try {
    const prepared = [];
    // Finish containerization before any upload. Staging is outside the
    // immutable package, and replay regenerates exactly the same bytes.
    for (const payload of payloads(plan)) {
      ctx.signal?.throwIfAborted();
      const path = payload.container
        ? join(temporary, payload.name)
        : join(ctx.jobDirectory, "archive", payload.path);
      if (payload.container)
        await writeConversationContainer(join(ctx.jobDirectory, "archive", payload.path), path);
      prepared.push({ payload, path, ...(await hashStream(createReadStream(path), ctx.signal)) });
    }
    const byName = await childrenByName(ctx, destination.destFolderId);
    for (const { payload, path, sha256, size } of prepared) {
      ctx.signal?.throwIfAborted();
      let state = saved.get(payload.path);
      if (state && !boundState(ctx, plan, payload, state, manifestDigest)) {
        yield unit(ctx, "execute", payload, state, ["provenance_mismatch"]);
        continue;
      }
      if (state && (state.output.sha256 !== sha256 || state.output.size !== size)) {
        yield unit(ctx, "execute", payload, state, ["manifest_digest_mismatch"]);
        continue;
      }
      const children = byName.get(payload.name) ?? [];
      const collision =
        children.length > 1
          ? "destination_duplicate_name"
          : children.some((entry) => entry.id !== state?.output.id)
            ? children[0]!.kind === "file"
              ? "unowned_path_collision"
              : "destination_type_conflict"
            : null;
      if (collision) {
        yield unit(ctx, "execute", payload, state, [collision]);
        continue;
      }
      if (state) {
        const existing = await readObject(ctx.provider, destination.destDriveId, state.output.id);
        if (existing || state.status === "verified") {
          const checked = await checkCopy(ctx, state);
          if (!checked.codes.length)
            state = { ...state, status: "verified", revision: checked.revision };
          yield unit(ctx, "execute", payload, state, checked.codes);
          continue;
        }
      }
      if (!state) {
        if (!ctx.provider.reserveDestinationId)
          throw new Error("Archive destination requires reservable identities");
        const output: FileOutput = {
          id: await ctx.provider.reserveDestinationId(),
          driveId: destination.destDriveId,
          parentId: destination.destFolderId,
          name: payload.name,
          kind: "file",
          size,
          sha256,
          mimeType: payload.mimeType,
          createdAt: plan.window.to,
          modifiedAt: plan.window.to,
        };
        state = {
          version: 1,
          status: "prepared",
          path: payload.path,
          output,
          marker: marker(ctx, payload, output, manifestDigest),
          revision: null,
        };
        yield unit(ctx, "execute", payload, state);
      }
      ctx.signal?.throwIfAborted();
      const uploaded = await ctx.provider.uploadDestinationContent({
        destinationId: state.output.id,
        create: true,
        marker: state.marker,
        parentFolderId: destination.destFolderId,
        name: payload.name,
        content: createReadStream(path),
        createdAt: state.output.createdAt,
        modifiedAt: state.output.modifiedAt,
        mimeType: payload.mimeType,
      });
      if (uploaded.id !== state.output.id)
        throw Object.assign(new Error("Destination ignored reserved identity"), {
          code: "provenance_mismatch",
        });
      const checked = await checkCopy(ctx, state);
      state = {
        ...state,
        status: checked.codes.length ? "prepared" : "verified",
        revision: checked.revision,
      };
      yield unit(ctx, "execute", payload, state, checked.codes);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function* verifyArchiveDestination(
  ctx: ArchiveDriverContext,
  plan: ArchivePlan,
  manifestDigest: string,
): AsyncGenerator<ArchiveCommit> {
  const saved = states(ctx);
  const byName = await childrenByName(ctx, plan.config.destination!.destFolderId);
  for (const payload of payloads(plan)) {
    ctx.signal?.throwIfAborted();
    const state = saved.get(payload.path);
    const codes = !state
      ? ["destination_missing"]
      : !boundState(ctx, plan, payload, state, manifestDigest)
        ? ["provenance_mismatch"]
        : (await checkCopy(ctx, state)).codes;
    const sameName = byName.get(payload.name) ?? [];
    if (!state && sameName.length === 1)
      codes.push(
        sameName[0]!.kind === "file" ? "unowned_path_collision" : "destination_type_conflict",
      );
    if (sameName.length > 1) codes.push("destination_duplicate_name");
    yield unit(ctx, "verify", payload, state, codes);
  }
}
