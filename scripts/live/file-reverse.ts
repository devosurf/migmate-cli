import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openEngine, type Outcome } from "../../src/engine/index.ts";
import {
  createCredentialSession,
  type CredentialSession,
} from "../../src/engine/providers/credentials.ts";
import { createProductionProvider } from "../../src/engine/providers/production.ts";
import {
  fetchProvider,
  googleUrl,
  graphUrl,
  HttpProviderFault,
  requireSuccess,
  responseJson,
} from "../../src/engine/providers/http.ts";
import {
  LiveTestBlocked,
  liveAssertion,
  type LiveTestInput,
  type LiveTestResult,
} from "./common.ts";
import { identifier, object } from "./file-fixtures.ts";
import { reverseFileProbeIds, type ProbeCapture } from "./probes.ts";

const folderMime = "application/vnd.google-apps.folder";

/** SharePoint's quickXorHash (base64), computed here independently of the engine. */
export function quickXorHash(bytes: Uint8Array): string {
  const hash = Buffer.alloc(20);
  for (let i = 0; i < bytes.length; i++) {
    const bit = (i * 11) % 160;
    const index = Math.floor(bit / 8);
    const shift = bit % 8;
    hash[index] = hash[index]! ^ (bytes[i]! << shift);
    const next = (index + 1) % 20;
    hash[next] = hash[next]! ^ (bytes[i]! >>> (8 - shift));
  }
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(bytes.length));
  for (let i = 0; i < 8; i++) hash[12 + i] = hash[12 + i]! ^ size[i]!;
  return hash.toString("base64");
}

interface ReverseRoots {
  sourceDriveId: string;
  sourceItemId: string;
  destDriveId: string;
  destFolderPath: string;
}
interface GraphItem {
  id: string;
  name: string;
  eTag?: string;
  folder?: unknown;
  file?: { hashes?: { quickXorHash?: string } };
  parentReference?: { id?: string; driveId?: string };
}
interface GoogleItem {
  id: string;
  driveId?: string;
  mimeType: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

function folderPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    (value !== "" && value.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw new LiveTestBlocked("file_reverse_destination_path_invalid");
  return value;
}

/**
 * Disposable Google source folders written as the acting account and one disposable
 * SharePoint folder written by the destination app. Only tool-created ids are mutated.
 */
class ReverseFixtures {
  readonly owner = randomUUID();
  readonly #roots: ReverseRoots;
  readonly #session: CredentialSession;
  readonly #signal: AbortSignal;
  /** Google items in creation order; deleted in reverse. */
  readonly #sources: string[] = [];
  #destinationParent: string | undefined;
  #destinationFolder: string | undefined;

  constructor(roots: ReverseRoots, session: CredentialSession, signal: AbortSignal) {
    this.#roots = roots;
    this.#session = session;
    this.#signal = signal;
  }

  async #google(path: string, init: RequestInit = {}, cleanup = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.#session.googleToken()}`);
    if (typeof init.body === "string" && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    return fetchProvider(googleUrl(path), {
      ...init,
      headers,
      signal: cleanup ? AbortSignal.timeout(60_000) : this.#signal,
    });
  }
  async #graph<T>(path: string, init: RequestInit = {}, cleanup = false): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.#session.graphDestinationToken()}`);
    if (typeof init.body === "string" && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    return responseJson<T>(
      await fetchProvider(graphUrl(path), {
        ...init,
        headers,
        signal: cleanup ? AbortSignal.timeout(60_000) : this.#signal,
      }),
    );
  }
  #item(id: string): string {
    return `/v1.0/drives/${encodeURIComponent(this.#roots.destDriveId)}/items/${encodeURIComponent(identifier(id))}`;
  }

  async initialize(): Promise<void> {
    const source = await responseJson<GoogleItem>(
      await this.#google(
        `/drive/v3/files/${encodeURIComponent(this.#roots.sourceItemId)}?supportsAllDrives=true&fields=id,driveId,mimeType`,
      ),
    );
    if (source.mimeType !== folderMime || source.driveId !== this.#roots.sourceDriveId)
      throw new LiveTestBlocked("file_reverse_source_root_unavailable");
    const drive = await this.#graph<{ id: string; driveType: string }>(
      `/v1.0/drives/${encodeURIComponent(this.#roots.destDriveId)}`,
    );
    if (drive.id !== this.#roots.destDriveId || drive.driveType !== "documentLibrary")
      throw new LiveTestBlocked("file_reverse_destination_must_be_sharepoint_library");
    const path = this.#roots.destFolderPath;
    const parent = await this.#graph<GraphItem>(
      `/v1.0/drives/${encodeURIComponent(this.#roots.destDriveId)}/${
        path ? `root:/${path.split("/").map(encodeURIComponent).join("/")}` : "root"
      }`,
    );
    if (!parent.folder) throw new LiveTestBlocked("file_reverse_destination_root_unavailable");
    this.#destinationParent = identifier(parent.id);
  }

  async sourceFolder(parent: string, name: string): Promise<string> {
    if (parent !== this.#roots.sourceItemId && !this.#sources.includes(parent))
      throw new LiveTestBlocked("file_reverse_source_mutation_outside_owned_folder");
    const item = await responseJson<{ id: string }>(
      await this.#google("/drive/v3/files?supportsAllDrives=true&fields=id", {
        method: "POST",
        body: JSON.stringify({
          name,
          parents: [parent],
          mimeType: folderMime,
          appProperties: { qowner: this.owner },
        }),
      }),
    );
    this.#sources.push(identifier(item.id));
    return item.id;
  }

  async sourceFile(parent: string, name: string, bytes: Uint8Array): Promise<void> {
    if (!this.#sources.includes(parent))
      throw new LiveTestBlocked("file_reverse_source_file_requires_owned_parent");
    const created = await responseJson<{ id: string }>(
      await this.#google("/drive/v3/files?supportsAllDrives=true&fields=id", {
        method: "POST",
        body: JSON.stringify({
          name,
          parents: [parent],
          mimeType: "application/octet-stream",
          appProperties: { qowner: this.owner },
        }),
      }),
    );
    const id = identifier(created.id);
    this.#sources.push(id);
    const uploaded = await this.#google(
      `/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&supportsAllDrives=true`,
      { method: "PATCH", headers: { "Content-Type": "application/octet-stream" }, body: bytes },
    );
    await requireSuccess(uploaded);
    await uploaded.body?.cancel();
  }

  /** The copy root lives directly under the acknowledged destination folder. */
  async destinationFolder(name: string): Promise<string> {
    if (!this.#destinationParent || this.#destinationFolder)
      throw new LiveTestBlocked("file_reverse_destination_folder_unavailable");
    const item = await this.#graph<GraphItem>(`${this.#item(this.#destinationParent)}/children`, {
      method: "POST",
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    this.#destinationFolder = identifier(item.id);
    return this.#destinationFolder;
  }

  async destinationChildren(): Promise<GraphItem[]> {
    if (!this.#destinationFolder) throw new LiveTestBlocked("file_reverse_destination_missing");
    const page = await this.#graph<{ value: GraphItem[]; "@odata.nextLink"?: string }>(
      `${this.#item(this.#destinationFolder)}/children?$top=200&$select=id,name,eTag,folder,file,parentReference`,
    );
    if (page["@odata.nextLink"]) throw new LiveTestBlocked("file_reverse_destination_unpaged");
    return page.value;
  }

  /** Stand-in for a SharePoint-side rewrite: replace copied bytes through the write app. */
  async replaceDestination(item: GraphItem, bytes: Uint8Array): Promise<void> {
    if (item.parentReference?.id !== this.#destinationFolder || !item.eTag)
      throw new LiveTestBlocked("file_reverse_destination_mutation_outside_copy_root");
    await this.#graph(`${this.#item(item.id)}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "If-Match": item.eTag },
      body: bytes,
    });
  }

  async cleanup(): Promise<void> {
    let failed = false;
    if (this.#destinationFolder) {
      try {
        const folder = await this.#graph<GraphItem>(this.#item(this.#destinationFolder), {}, true);
        if (folder.parentReference?.id !== this.#destinationParent || !folder.eTag)
          throw new LiveTestBlocked("file_reverse_cleanup_destination_moved");
        await this.#graph(
          this.#item(this.#destinationFolder),
          { method: "DELETE", headers: { "If-Match": folder.eTag } },
          true,
        );
        this.#destinationFolder = undefined;
      } catch (error) {
        if (error instanceof HttpProviderFault && error.status === 404)
          this.#destinationFolder = undefined;
        else failed = true;
      }
    }
    for (const id of [...this.#sources].reverse()) {
      try {
        const response = await this.#google(
          `/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
          { method: "DELETE" },
          true,
        );
        await requireSuccess(response);
        await response.body?.cancel();
        this.#sources.splice(this.#sources.indexOf(id), 1);
      } catch (error) {
        if (error instanceof HttpProviderFault && error.status === 404)
          this.#sources.splice(this.#sources.indexOf(id), 1);
        else failed = true;
      }
    }
    if (failed || this.#sources.length || this.#destinationFolder)
      throw new LiveTestBlocked("file_fixture_cleanup_incomplete", {
        remaining: {
          sources: this.#sources.length,
          destinations: this.#destinationFolder ? 1 : 0,
        },
      });
  }
}

/**
 * Google Shared Drive → SharePoint through the production engine: copy, quickXorHash
 * verification, and the rewrite/corruption split after replacing copied bytes.
 */
export async function runReverseFileLiveTest(input: LiveTestInput): Promise<LiveTestResult> {
  const jobConfig = object(input.config.jobConfig);
  if (!Array.isArray(jobConfig.mappings) || jobConfig.mappings.length !== 1)
    throw new LiveTestBlocked("file_one_disposable_mapping_required");
  const raw = object(jobConfig.mappings[0]);
  if (raw.sourceType !== "google_shared_drive")
    throw new LiveTestBlocked("file_reverse_mapping_required");
  const roots: ReverseRoots = {
    sourceDriveId: identifier(raw.sourceDriveId),
    sourceItemId: identifier(raw.sourceItemId),
    destDriveId: identifier(raw.destDriveId),
    destFolderPath: folderPath(raw.destFolderPath),
  };
  const disposable = object(object(input.config.fixtures).disposableRoots);
  if (
    disposable.acknowledged !== true ||
    disposable.sourceDriveId !== roots.sourceDriveId ||
    disposable.sourceItemId !== roots.sourceItemId ||
    disposable.destDriveId !== roots.destDriveId ||
    disposable.destFolderPath !== roots.destFolderPath
  )
    throw new LiveTestBlocked("file_fixture_roots_must_match_mapping");
  const factory = {
    jobType: "file_migration" as const,
    config: jobConfig,
    jobDirectory: input.jobDirectory,
  };
  const session = await createCredentialSession(factory);
  const fixtures = new ReverseFixtures(roots, session, input.signal);
  const engine = openEngine({
    home: join(input.jobDirectory, "engine"),
    provider: createProductionProvider(factory),
  });
  let failed = false;
  function value<T>(outcome: Outcome<T>): T {
    if (!outcome.ok) throw new LiveTestBlocked(`file_live_${outcome.refusal.code}`);
    return outcome.value;
  }
  try {
    await fixtures.initialize();
    const startedAt = new Date().toISOString();
    const name = `migmate-live-${fixtures.owner}`;
    const sourceFolder = await fixtures.sourceFolder(roots.sourceItemId, name);
    const binary = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
    const notes = Buffer.from("plain text that SharePoint stores unchanged\n");
    // Not a valid package: SharePoint may or may not rewrite it on upload.
    const office = Buffer.from(`PK\u0003\u0004 migmate live ${fixtures.owner}`);
    await fixtures.sourceFile(sourceFolder, "binary.bin", binary);
    await fixtures.sourceFile(sourceFolder, "notes.txt", notes);
    await fixtures.sourceFile(sourceFolder, "report.docx", office);
    await fixtures.sourceFolder(sourceFolder, "empty");
    await fixtures.destinationFolder(name);
    const { mappings: _parent, ...settings } = jobConfig;
    const ref = value(
      await engine.initJob({
        type: "file_migration",
        config: { ...settings, options: { verificationMode: "hash" } },
      }),
    );
    value(
      await engine.withWriterResult(ref, (writer) =>
        writer.loadManifest({
          format: "json",
          content: JSON.stringify({
            version: 1,
            mappings: [
              {
                id: "live-reverse",
                source: {
                  type: "google_shared_drive",
                  driveId: roots.sourceDriveId,
                  folderId: sourceFolder,
                },
                destination: {
                  type: "sharepoint",
                  driveId: roots.destDriveId,
                  folderPath: roots.destFolderPath ? `${roots.destFolderPath}/${name}` : name,
                },
              },
            ],
          }),
        }),
      ),
    );
    value(
      await engine.withWriter(ref, async (writer) => {
        value(await writer.doctor());
        const plan = value(await writer.plan());
        value(
          await writer.approve({
            approver: "disposable-live-probe",
            mode: "unattended",
            planDigest: plan.planDigest,
          }),
        );
      }),
    );
    const assertions: ProbeCapture["assertions"] = [];
    const executed = value(
      await engine.withWriterResult(ref, (writer) => writer.execute({ signal: input.signal })),
    );
    assertions.push(
      liveAssertion("file_reverse_", "copy_completed", "completed", executed.outcome),
    );
    const first = value(await engine.withWriterResult(ref, (writer) => writer.verify()));
    const firstCodes = first.findings.map((finding) => finding.code).sort();
    // SharePoint may rewrite the Office file on upload; nothing else may differ.
    assertions.push(
      liveAssertion(
        "file_reverse_",
        "only_rewrites_after_copy",
        true,
        firstCodes.every((code) => code === "destination_rewrote_file"),
      ),
    );
    const copied = await fixtures.destinationChildren();
    assertions.push(
      liveAssertion(
        "file_reverse_",
        "hierarchy",
        ["binary.bin", "empty", "notes.txt", "report.docx"],
        copied.map((item) => item.name).sort(),
      ),
    );
    const byName = (entry: string): GraphItem => {
      const item = copied.find((candidate) => candidate.name === entry);
      if (!item) throw new LiveTestBlocked("file_reverse_copy_missing");
      return item;
    };
    assertions.push(
      liveAssertion(
        "file_reverse_",
        "sharepoint_quickxor_matches_source",
        quickXorHash(binary),
        byName("binary.bin").file?.hashes?.quickXorHash,
      ),
    );
    await fixtures.replaceDestination(byName("report.docx"), Buffer.from("rewritten office"));
    await fixtures.replaceDestination(byName("notes.txt"), Buffer.from("corrupted plain text\n"));
    const second = value(await engine.withWriterResult(ref, (writer) => writer.verify()));
    assertions.push(
      liveAssertion(
        "file_reverse_",
        "rewrite_and_corruption_findings",
        ["content_mismatch", "destination_rewrote_file"],
        second.findings.map((finding) => finding.code).sort(),
      ),
    );
    input.capture({
      schemaVersion: 1,
      probeId: "shared_drive_to_sharepoint_copy_and_verification",
      startedAt,
      completedAt: new Date().toISOString(),
      assertions,
      observations: { rewrittenOnUpload: firstCodes.length > 0 },
      codes: [],
    });
    return { requiredProbes: [...reverseFileProbeIds] };
  } catch (error) {
    failed = true;
    if (error instanceof LiveTestBlocked) throw error;
    throw new LiveTestBlocked(
      input.signal.aborted ? "operator_interrupted" : "file_live_effect_or_observation_failed",
    );
  } finally {
    engine.close();
    let cleanup: unknown;
    try {
      await fixtures.cleanup();
    } catch (error) {
      cleanup = error;
    }
    session.dispose();
    if (cleanup && !failed) throw new LiveTestBlocked("file_fixture_cleanup_incomplete");
  }
}
