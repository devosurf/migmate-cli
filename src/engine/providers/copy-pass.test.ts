import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTransferSupervisor, type TransferSupervisor } from "./transfer-worker.ts";
import type { CopyPassReference } from "./port.ts";

async function finish(supervisor: TransferSupervisor, reference: CopyPassReference) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = await supervisor.copyPassStatus(reference);
    if (status.state !== "running") return status;
    await delay(20);
  }
  assert.fail("copy pass did not finish");
}

const enabled = Boolean(
  process.env.MIGMATE_TEST_RCLONE_BINARY &&
  process.env.MIGMATE_TEST_RCLONE_SHA256 &&
  process.env.MIGMATE_TEST_RCLONE_PROVENANCE,
);

function suppliedBinary() {
  const path = process.env.MIGMATE_TEST_RCLONE_BINARY;
  const sha256 = process.env.MIGMATE_TEST_RCLONE_SHA256;
  const provenance = process.env.MIGMATE_TEST_RCLONE_PROVENANCE;
  assert.ok(path && sha256 && provenance);
  return { path: resolve(path), sha256, provenance };
}

it(
  "copies asynchronously with a durable handle, isolated stats and retained completion",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-copy-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
      jobExpiry: "1h",
    });
    try {
      const source = join(directory, "source");
      const destination = join(directory, "destination");
      await mkdir(join(source, "empty"), { recursive: true });
      await mkdir(destination);
      await writeFile(join(source, "hello.txt"), "hello");
      const modified = new Date("2020-01-02T03:04:05Z");
      await utimes(join(source, "hello.txt"), modified, modified);
      await writeFile(join(destination, "retained.txt"), "not deleted");
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      const pass = await supervisor.startCopyPass({
        socketPath: worker.socketPath,
        source: { fs: source, kind: "local" },
        destination: { fs: destination, kind: "local" },
        mode: "copy",
        transfers: 2,
      });
      assert.equal(typeof pass.executeId, "string");
      assert.equal(typeof pass.jobid, "number");
      assert.ok(pass.group);
      const restored = JSON.parse(JSON.stringify(pass));
      let status = await supervisor.copyPassStatus({
        socketPath: worker.socketPath,
        pass: restored,
      });
      const deadline = Date.now() + 10_000;
      while (status.state === "running" && Date.now() < deadline) {
        await delay(20);
        status = await supervisor.copyPassStatus({ socketPath: worker.socketPath, pass: restored });
      }
      assert.deepEqual(status, { state: "completed", error: null });
      assert.equal(await readFile(join(destination, "hello.txt"), "utf8"), "hello");
      assert.equal((await stat(join(destination, "empty"))).isDirectory(), true);
      assert.equal(
        (await stat(join(destination, "hello.txt"))).mtime.toISOString(),
        modified.toISOString(),
      );
      assert.equal(await readFile(join(destination, "retained.txt"), "utf8"), "not deleted");
      assert.deepEqual(await supervisor.copyPassStats({ socketPath: worker.socketPath, pass }), {
        bytes: 5,
        files: 1,
        errors: 0,
        transferring: [],
        speed: 0,
      });
      await delay(1_100);
      assert.deepEqual(
        await supervisor.copyPassStatus({ socketPath: worker.socketPath, pass }),
        status,
      );
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "previews disjoint-hash copies and mirror deletions at the exact modify-window boundary",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-preview-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    try {
      const source = join(directory, "source");
      const destination = join(directory, "destination");
      await mkdir(source);
      await mkdir(destination);
      const base = 1_700_000_000;
      const fixtures = [
        { path: "new.txt", source: "new", destination: null, delta: 0 },
        { path: "size.txt", source: "longer", destination: "old", delta: 0 },
        { path: "same-size.txt", source: "BBBB", destination: "AAAA", delta: 10 },
        { path: "boundary.txt", source: "BBBB", destination: "AAAA", delta: 1 },
        { path: "same.txt", source: "same", destination: "same", delta: 0 },
        // These straddle a second but differ by less than one second. Truncating
        // either timestamp to milliseconds incorrectly predicts a transfer.
        { path: "within-window.txt", source: "BBBB", destination: "AAAA", delta: 1 },
        { path: "deleted.txt", source: null, destination: "gone", delta: 0 },
        { path: "excluded[1].txt", source: null, destination: "keep", delta: 0 },
      ];
      for (const fixture of fixtures) {
        for (const [root, content, time] of [
          [source, fixture.source, base + fixture.delta],
          [
            destination,
            fixture.destination,
            base + (fixture.path === "within-window.txt" ? 0.0005 : 0),
          ],
        ] as const) {
          if (content === null) continue;
          await writeFile(join(root, fixture.path), content);
          await utimes(join(root, fixture.path), time, time);
        }
      }
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      await supervisor.call(worker.socketPath, "options/set", { main: { ModifyWindow: "1s" } });
      const input = {
        socketPath: worker.socketPath,
        source: { fs: `:local,hashes=quickxor:${source}`, kind: "local" as const },
        destination: { fs: `:local,hashes=md5:${destination}`, kind: "local" as const },
        excludePaths: ["excluded[1].txt"],
      };
      const preview = await supervisor.previewCopyPass({ ...input, mode: "mirror" });
      assert.deepEqual(preview, {
        new: [{ path: "new.txt", size: 3 }],
        changed: [
          { path: "boundary.txt", size: 4 },
          { path: "same-size.txt", size: 4 },
          { path: "size.txt", size: 6 },
        ],
        unchanged: [
          { path: "same.txt", size: 4 },
          { path: "within-window.txt", size: 4 },
        ],
        deleted: [{ path: "deleted.txt", size: 4 }],
        retained: [],
        timestampOnly: [],
        modifyWindowNs: "1000000000",
      });
      const copyPreview = await supervisor.previewCopyPass({ ...input, mode: "copy" });
      assert.deepEqual(copyPreview.deleted, []);
      assert.deepEqual(copyPreview.retained, [{ path: "deleted.txt", size: 4 }]);
      const emptyPreview = await supervisor.previewCopyPass({
        socketPath: worker.socketPath,
        source: input.source,
        excludePaths: ["same.txt"],
        mode: "copy",
      });
      assert.deepEqual(emptyPreview, {
        new: [
          { path: "boundary.txt", size: 4 },
          { path: "new.txt", size: 3 },
          { path: "same-size.txt", size: 4 },
          { path: "size.txt", size: 6 },
          { path: "within-window.txt", size: 4 },
        ],
        changed: [],
        unchanged: [],
        deleted: [],
        retained: [],
        timestampOnly: [],
        modifyWindowNs: "1000000000",
      });
      // Preview has no write effects, including timestamp changes.
      assert.equal(await readFile(join(destination, "same-size.txt"), "utf8"), "AAAA");
      assert.equal(await readFile(join(destination, "deleted.txt"), "utf8"), "gone");
      const pass = await supervisor.startCopyPass({
        ...input,
        mode: "mirror",
        deleteLimit: 1,
        transfers: 2,
      });
      assert.deepEqual(await finish(supervisor, { socketPath: worker.socketPath, pass }), {
        state: "completed",
        error: null,
      });
      const stats = await supervisor.copyPassStats({ socketPath: worker.socketPath, pass });
      assert.equal(stats.files, 4);
      assert.equal(stats.bytes, 17);
      for (const file of [...preview.new, ...preview.changed]) {
        assert.equal(
          await readFile(join(destination, file.path), "utf8"),
          await readFile(join(source, file.path), "utf8"),
        );
      }
      assert.equal(await readFile(join(destination, "within-window.txt"), "utf8"), "AAAA");
      await assert.rejects(stat(join(destination, "deleted.txt")), { code: "ENOENT" });
      assert.equal(await readFile(join(destination, "excluded[1].txt"), "utf8"), "keep");
      // One nanosecond beyond the exact boundary must skip, without rounding
      // the configured window down to whole milliseconds or seconds.
      await writeFile(join(destination, "boundary.txt"), "AAAA");
      await utimes(join(destination, "boundary.txt"), base, base);
      await supervisor.call(worker.socketPath, "options/set", {
        main: { ModifyWindow: "1000000001ns" },
      });
      const precise = await supervisor.previewCopyPass({ ...input, mode: "copy" });
      assert.equal(precise.modifyWindowNs, "1000000001");
      assert.deepEqual(precise.changed, []);
      assert.deepEqual(precise.timestampOnly, []);
      const skipped = await supervisor.startCopyPass({ ...input, mode: "copy", transfers: 1 });
      assert.deepEqual(await finish(supervisor, { socketPath: worker.socketPath, pass: skipped }), {
        state: "completed",
        error: null,
      });
      assert.equal(await readFile(join(destination, "boundary.txt"), "utf8"), "AAAA");
      assert.equal(
        (await supervisor.copyPassStats({ socketPath: worker.socketPath, pass: skipped })).files,
        0,
      );
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "previews common-hash timestamp-only work without counting it as copied bytes",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-preview-hash-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    try {
      const source = join(directory, "source");
      const destination = join(directory, "destination");
      await mkdir(source);
      await mkdir(destination);
      for (const path of ["timestamp.txt", "different.txt", "skipped.txt"]) {
        await writeFile(join(source, path), "BBBB");
        await writeFile(join(destination, path), path === "timestamp.txt" ? "BBBB" : "AAAA");
        await utimes(join(source, path), 1_700_000_010, 1_700_000_010);
        const time = path === "skipped.txt" ? 1_700_000_010 : 1_700_000_000;
        await utimes(join(destination, path), time, time);
      }
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      const input = {
        socketPath: worker.socketPath,
        source: { fs: source, kind: "local" as const },
        destination: { fs: destination, kind: "local" as const },
        mode: "copy" as const,
      };
      const preview = await supervisor.previewCopyPass(input);
      assert.deepEqual(preview, {
        new: [],
        changed: [{ path: "different.txt", size: 4 }],
        unchanged: [{ path: "skipped.txt", size: 4 }],
        deleted: [],
        retained: [],
        timestampOnly: [{ path: "timestamp.txt", size: 4 }],
        modifyWindowNs: "1",
      });
      assert.equal((await stat(join(destination, "timestamp.txt"))).mtimeMs, 1_700_000_000_000);
      const pass = await supervisor.startCopyPass({ ...input, transfers: 2 });
      assert.deepEqual(await finish(supervisor, { socketPath: worker.socketPath, pass }), {
        state: "completed",
        error: null,
      });
      const stats = await supervisor.copyPassStats({ socketPath: worker.socketPath, pass });
      assert.equal(stats.files, 1);
      assert.equal(stats.bytes, 4);
      assert.equal(await readFile(join(destination, "different.txt"), "utf8"), "BBBB");
      assert.equal(await readFile(join(destination, "skipped.txt"), "utf8"), "AAAA");
      assert.equal((await stat(join(destination, "timestamp.txt"))).mtimeMs, 1_700_000_010_000);
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "creates destination folders with modification times only, never source folder metadata",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-dirs-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    try {
      // rclone v1.75.0's Drive backend applies a folder's `content-type` metadata
      // (OneDrive reports `inode/directory`) to the folder it creates, which turns
      // it into a 0-byte file and fails the pass. Folder metadata must never reach
      // a destination; the local backend makes that observable through `mode`.
      const source = join(directory, "source");
      const destination = join(directory, "destination");
      await mkdir(join(source, "full"), { recursive: true });
      await mkdir(join(source, "empty"));
      await mkdir(destination);
      await writeFile(join(source, "full", "a.txt"), "a");
      await chmod(join(source, "full", "a.txt"), 0o600);
      const modified = new Date("2020-01-02T03:04:05Z");
      for (const folder of ["full", "empty"]) {
        await chmod(join(source, folder), 0o700);
        await utimes(join(source, folder), modified, modified);
      }
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      // A cached listing of the destination must not restore folder metadata.
      await supervisor.listFileHashes({
        socketPath: worker.socketPath,
        root: { fs: destination, kind: "google_drive" },
        hashType: "sha256",
        download: false,
      });
      const pass = await supervisor.startCopyPass({
        socketPath: worker.socketPath,
        source: { fs: source, kind: "sharepoint" },
        destination: { fs: destination, kind: "google_drive" },
        mode: "copy",
        transfers: 2,
      });
      assert.deepEqual(await finish(supervisor, { socketPath: worker.socketPath, pass }), {
        state: "completed",
        error: null,
      });
      for (const folder of ["full", "empty"]) {
        const copied = await stat(join(destination, folder));
        assert.equal(copied.isDirectory(), true);
        assert.equal(copied.mtime.toISOString(), modified.toISOString());
        assert.notEqual(copied.mode & 0o777, 0o700, `${folder} received source folder metadata`);
      }
      // File metadata still applies.
      assert.equal((await stat(join(destination, "full", "a.txt"))).mode & 0o777, 0o600);
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "runs two independent passes in one worker with per-pass transfer limits",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-parallel-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    try {
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      await supervisor.call(worker.socketPath, "core/bwlimit", { rate: "1M" });
      const references: CopyPassReference[] = [];
      for (const [index, transfers] of [1, 3].entries()) {
        const source = join(directory, `source-${index}`);
        const destination = join(directory, `destination-${index}`);
        await mkdir(source);
        const content = Buffer.alloc(4 * 1024 * 1024, index + 37);
        for (let file = 0; file < 4; file++) await writeFile(join(source, `${file}.bin`), content);
        const pass = await supervisor.startCopyPass({
          socketPath: worker.socketPath,
          source: { fs: `:local,no_clone=true:${source}`, kind: "local" },
          destination: { fs: `:local,no_clone=true:${destination}`, kind: "local" },
          mode: "copy",
          transfers,
        });
        references.push({ socketPath: worker.socketPath, pass });
      }
      assert.equal(references[0]!.pass.executeId, references[1]!.pass.executeId);
      assert.notEqual(references[0]!.pass.jobid, references[1]!.pass.jobid);
      const deadline = Date.now() + 10000;
      let counts: number[] = [];
      do {
        counts = await Promise.all(
          references.map(async (reference) => {
            const stats = await supervisor.copyPassStats(reference);
            for (const file of stats.transferring) {
              assert.equal(file.size, 4 * 1024 * 1024);
              assert.ok(file.bytes >= 0 && file.bytes <= file.size);
            }
            return stats.transferring.length;
          }),
        );
        if (counts[0] === 1 && counts[1] === 3) break;
        await delay(20);
      } while (Date.now() < deadline);
      // These are live rclone transfers, not just accepted RC configuration.
      assert.deepEqual(counts, [1, 3]);
      assert.deepEqual(
        await Promise.all(
          references.map(async (reference) => (await supervisor.copyPassStatus(reference)).state),
        ),
        ["running", "running"],
      );
      await supervisor.call(worker.socketPath, "core/bwlimit", { rate: "off" });
      for (const [index, reference] of references.entries()) {
        assert.deepEqual(await finish(supervisor, reference), { state: "completed", error: null });
        const stats = await supervisor.copyPassStats(reference);
        assert.equal(stats.files, 4);
        assert.equal(stats.bytes, 16 * 1024 * 1024);
        assert.equal(stats.errors, 0);
        for (let file = 0; file < 4; file++) {
          assert.deepEqual(
            await readFile(join(directory, `destination-${index}`, `${file}.bin`)),
            Buffer.alloc(4 * 1024 * 1024, index + 37),
          );
        }
      }
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "excludes literal mapping paths and subtrees without filtering similarly named files",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-filter-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    try {
      const source = join(directory, "source");
      const destination = join(directory, "destination");
      await mkdir(join(source, "folder[1]"), { recursive: true });
      await mkdir(join(source, "nested"), { recursive: true });
      await mkdir(destination);
      const excludedFiles = [
        "brace{a,b}.txt",
        ...(process.platform === "win32"
          ? []
          : ["secret*.txt", "question?.txt", "slash\\name.txt", "trailing "]),
      ];
      const excluded = [...excludedFiles, "folder[1]"];
      const retained = ["secret-other.txt", "questionX.txt", "bracea.txt", "nested/brace{a,b}.txt"];
      for (const path of [...excludedFiles, ...retained, "folder[1]/hidden.txt"]) {
        await writeFile(join(source, path), path);
      }
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      const input = {
        socketPath: worker.socketPath,
        source: { fs: source, kind: "local" as const },
        destination: { fs: destination, kind: "local" as const },
        mode: "copy" as const,
        transfers: 2,
      };
      const pass = await supervisor.startCopyPass({ ...input, excludePaths: excluded });
      assert.deepEqual(await finish(supervisor, { socketPath: worker.socketPath, pass }), {
        state: "completed",
        error: null,
      });
      for (const path of excluded)
        await assert.rejects(
          stat(join(destination, path)),
          { code: "ENOENT" },
          JSON.stringify(path),
        );
      for (const path of retained) {
        assert.equal(await readFile(join(destination, path), "utf8"), path);
      }
      const unfiltered = await supervisor.startCopyPass(input);
      assert.deepEqual(
        await finish(supervisor, { socketPath: worker.socketPath, pass: unfiltered }),
        { state: "completed", error: null },
      );
      assert.equal(
        await readFile(join(destination, "folder[1]/hidden.txt"), "utf8"),
        "folder[1]/hidden.txt",
      );
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "passes into SharePoint skip size and checksum, comparing modification times only",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-sp-dest-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    try {
      const source = join(directory, "source");
      const destination = join(directory, "destination");
      await mkdir(source);
      await mkdir(destination);
      // SharePoint rewrites Office/PDF/HTML bytes, so its size and hash never match the
      // source: a pass into SharePoint must not re-copy such a file on every repeat.
      await writeFile(join(source, "report.docx"), "source bytes");
      await writeFile(join(destination, "report.docx"), "rewritten by SharePoint");
      const modified = new Date("2020-01-02T03:04:05Z");
      for (const root of [source, destination])
        await utimes(join(root, "report.docx"), modified, modified);
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      const input = {
        socketPath: worker.socketPath,
        source: { fs: source, kind: "google_drive" as const },
        mode: "copy" as const,
        transfers: 1,
      };
      const preview = await supervisor.previewCopyPass({
        ...input,
        destination: { fs: destination, kind: "sharepoint" },
      });
      assert.deepEqual(preview.unchanged, [{ path: "report.docx", size: 12 }]);
      assert.deepEqual(preview.changed, []);
      assert.deepEqual(preview.timestampOnly, []);
      const intoSharePoint = await supervisor.startCopyPass({
        ...input,
        destination: { fs: destination, kind: "sharepoint" },
      });
      assert.deepEqual(
        await finish(supervisor, { socketPath: worker.socketPath, pass: intoSharePoint }),
        { state: "completed", error: null },
      );
      assert.equal(
        await readFile(join(destination, "report.docx"), "utf8"),
        "rewritten by SharePoint",
      );
      const elsewhere = await supervisor.startCopyPass({
        ...input,
        destination: { fs: destination, kind: "local" },
      });
      assert.deepEqual(
        await finish(supervisor, { socketPath: worker.socketPath, pass: elsewhere }),
        { state: "completed", error: null },
      );
      assert.equal(await readFile(join(destination, "report.docx"), "utf8"), "source bytes");
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "lists nested and empty folders without files or the mapping root",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-folders-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    try {
      const root = join(directory, "tree");
      await mkdir(join(root, "a", "b"), { recursive: true });
      await mkdir(join(root, "e"));
      await writeFile(join(root, "a", "f.txt"), "file");
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      assert.deepEqual(
        await supervisor.listFolders({
          socketPath: worker.socketPath,
          root: { fs: root, kind: "local" },
        }),
        ["a", "a/b", "e"],
      );
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "hashes only selected literal relative paths without downloading unselected content",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-hash-selection-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    const downloaded: string[] = [];
    const content: Record<string, string> = {
      "/nested/literal[1].txt": "hello",
      "/nested/literal1.txt": "unselected nested bytes",
      "/other.txt": "unselected root bytes",
    };
    const listings: Record<string, string> = {
      "/": '<a href="nested/">nested</a><a href="other.txt">other</a>',
      "/nested/": '<a href="literal%5B1%5D.txt">literal</a><a href="literal1.txt">other</a>',
    };
    const server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url!, "http://localhost").pathname);
      const body = content[path] ?? listings[path];
      if (body === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("Content-Type", listings[path] === undefined ? "text/plain" : "text/html");
      response.setHeader("Content-Length", Buffer.byteLength(body));
      response.setHeader("Last-Modified", "Tue, 14 Nov 2023 22:13:20 GMT");
      if (request.method === "HEAD") response.end();
      else {
        if (content[path] !== undefined) downloaded.push(path);
        response.end(body);
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      const input = {
        socketPath: worker.socketPath,
        root: { fs: `:http,url='http://127.0.0.1:${address.port}/':`, kind: "local" as const },
        hashType: "sha256" as const,
        download: true,
      };
      assert.deepEqual(
        await supervisor.listFileHashes({ ...input, paths: ["nested/literal[1].txt"] }),
        [
          {
            path: "nested/literal[1].txt",
            size: 5,
            hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          },
        ],
      );
      assert.deepEqual(downloaded, ["/nested/literal[1].txt"]);
      assert.deepEqual(await supervisor.listFileHashes({ ...input, paths: [] }), []);
      assert.deepEqual(downloaded, ["/nested/literal[1].txt"]);
    } finally {
      await supervisor.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "stops a listing with no deadline when its signal aborts, and rclone drops the upstream request",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-list-abort-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    const upstreamClosed = Promise.withResolvers<void>();
    // A listing the backend never answers: only cancellation can end it.
    const server = createServer((request) => request.socket.once("close", upstreamClosed.resolve));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      const controller = new AbortController();
      const listing = supervisor.listFolders({
        socketPath: worker.socketPath,
        root: { fs: `:http,url='http://127.0.0.1:${address.port}/':`, kind: "local" },
        signal: controller.signal,
      });
      await delay(500);
      controller.abort();
      await assert.rejects(listing, { name: "AbortError" });
      await Promise.race([
        upstreamClosed.promise,
        delay(5_000).then(() => assert.fail("rclone kept the cancelled listing running")),
      ]);
      const local = join(directory, "local");
      await mkdir(join(local, "still-served"), { recursive: true });
      assert.deepEqual(
        await supervisor.listFolders({
          socketPath: worker.socketPath,
          root: { fs: local, kind: "local" },
        }),
        ["still-served"],
      );
    } finally {
      await supervisor.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "previews with backend precision when it exceeds the configured modify window",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-preview-precision-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    let downloads = 0;
    const server = createServer((request, response) => {
      const listing = request.url === "/";
      const body = listing ? '<a href="file.txt">file</a>' : "BBBB";
      response.setHeader("Content-Type", listing ? "text/html" : "text/plain");
      response.setHeader("Content-Length", Buffer.byteLength(body));
      response.setHeader("Last-Modified", "Tue, 14 Nov 2023 22:13:20 GMT");
      if (request.method === "HEAD") response.end();
      else {
        if (!listing) downloads++;
        response.end(body);
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const destination = join(directory, "destination");
      await mkdir(destination);
      await writeFile(join(destination, "file.txt"), "AAAA");
      await utimes(join(destination, "file.txt"), 1_700_000_000.5, 1_700_000_000.5);
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      const input = {
        socketPath: worker.socketPath,
        source: { fs: `:http,url='http://127.0.0.1:${address.port}/':`, kind: "local" as const },
        destination: { fs: destination, kind: "local" as const },
        mode: "copy" as const,
      };
      const preview = await supervisor.previewCopyPass(input);
      assert.equal(preview.modifyWindowNs, "1000000000");
      assert.deepEqual(preview.unchanged, [{ path: "file.txt", size: 4 }]);
      assert.deepEqual(preview.changed, []);
      assert.equal(downloads, 0);
      const skipped = await supervisor.startCopyPass({ ...input, transfers: 1 });
      assert.deepEqual(await finish(supervisor, { socketPath: worker.socketPath, pass: skipped }), {
        state: "completed",
        error: null,
      });
      assert.equal(await readFile(join(destination, "file.txt"), "utf8"), "AAAA");
      assert.equal(downloads, 0);
      await utimes(join(destination, "file.txt"), 1_700_000_001, 1_700_000_001);
      const boundary = await supervisor.previewCopyPass(input);
      assert.deepEqual(boundary.changed, [{ path: "file.txt", size: 4 }]);
      const copied = await supervisor.startCopyPass({ ...input, transfers: 1 });
      assert.deepEqual(await finish(supervisor, { socketPath: worker.socketPath, pass: copied }), {
        state: "completed",
        error: null,
      });
      assert.equal(await readFile(join(destination, "file.txt"), "utf8"), "BBBB");
      assert.equal(downloads, 1);
    } finally {
      await supervisor.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "lists relative paths, sizes and requested hashes, downloading hashes absent from the remote",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-hash-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    try {
      const source = join(directory, "source");
      await mkdir(join(source, "nested"), { recursive: true });
      await writeFile(join(source, "nested", "hello world.txt"), "hello");
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      const input = {
        socketPath: worker.socketPath,
        root: { fs: source, kind: "local" as const },
        hashType: "sha256" as const,
      };
      assert.deepEqual(await supervisor.listFileHashes({ ...input, download: true }), [
        {
          path: "nested/hello world.txt",
          size: 5,
          hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        },
      ]);
      assert.deepEqual(
        await supervisor.listFileHashes({ ...input, hashType: "md5", download: false }),
        [
          {
            path: "nested/hello world.txt",
            size: 5,
            hash: "5d41402abc4b2a76b9719d911017c592",
          },
        ],
      );
      const { obscured } = await supervisor.call<{ obscured: string }>(
        worker.socketPath,
        "core/obscure",
        { clear: "hermetic-test-only" },
      );
      const encrypted = {
        fs: `:crypt,remote=${join(directory, "encrypted")},password=${obscured}:`,
        kind: "local" as const,
      };
      const pass = await supervisor.startCopyPass({
        socketPath: worker.socketPath,
        source: input.root,
        destination: encrypted,
        mode: "copy",
        transfers: 1,
      });
      assert.deepEqual(await finish(supervisor, { socketPath: worker.socketPath, pass }), {
        state: "completed",
        error: null,
      });
      assert.deepEqual(
        await supervisor.listFileHashes({ ...input, root: encrypted, download: false }),
        [{ path: "nested/hello world.txt", size: 5, hash: null }],
      );
      assert.deepEqual(
        await supervisor.listFileHashes({ ...input, root: encrypted, download: true }),
        [
          {
            path: "nested/hello world.txt",
            size: 5,
            hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          },
        ],
      );
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "mirrors destination-only files within the delete limit and refuses unsafe limits",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-mirror-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    try {
      const source = join(directory, "source");
      const destination = join(directory, "destination");
      await mkdir(source);
      await mkdir(destination);
      await writeFile(join(source, "keep"), "keep");
      await writeFile(join(destination, "extra-one"), "one");
      await writeFile(join(destination, "extra-two"), "two");
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      const input = {
        socketPath: worker.socketPath,
        source: { fs: source, kind: "local" as const },
        destination: { fs: destination, kind: "local" as const },
        transfers: 1,
        mode: "mirror" as const,
      };
      await assert.rejects(supervisor.startCopyPass({ ...input, deleteLimit: -1 }));
      const limited = await supervisor.startCopyPass({ ...input, deleteLimit: 0 });
      const failed = await finish(supervisor, { socketPath: worker.socketPath, pass: limited });
      assert.equal(failed.state, "failed");
      assert.match(failed.error!, /delete/i);
      assert.equal(await readFile(join(destination, "extra-one"), "utf8"), "one");
      assert.equal(await readFile(join(destination, "extra-two"), "utf8"), "two");
      assert.ok(
        (await supervisor.copyPassStats({ socketPath: worker.socketPath, pass: limited })).errors >
          0,
      );
      const permitted = await supervisor.startCopyPass({ ...input, deleteLimit: 2 });
      assert.deepEqual(
        await finish(supervisor, { socketPath: worker.socketPath, pass: permitted }),
        { state: "completed", error: null },
      );
      await assert.rejects(readFile(join(destination, "extra-one")), { code: "ENOENT" });
      await assert.rejects(readFile(join(destination, "extra-two")), { code: "ENOENT" });
      assert.equal(await readFile(join(destination, "keep"), "utf8"), "keep");
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it(
  "stops only the selected running pass and resumes without copying completed files again",
  { skip: !enabled },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-stop-"));
    const supervisor = createTransferSupervisor({
      configPath: null,
      jobDirectory: directory,
      binary: suppliedBinary(),
    });
    try {
      const source = join(directory, "source");
      const destination = join(directory, "destination");
      await mkdir(source);
      await mkdir(destination);
      const content = Buffer.alloc(8 * 1024 * 1024, 37);
      for (const name of ["one", "two", "three"]) await writeFile(join(source, name), content);
      const worker = await supervisor.startTransferWorker({ runDirectory: "run" });
      await supervisor.call(worker.socketPath, "core/bwlimit", { rate: "4M" });
      const input = {
        socketPath: worker.socketPath,
        source: { fs: `:local,no_clone=true:${source}`, kind: "local" as const },
        destination: { fs: `:local,no_clone=true:${destination}`, kind: "local" as const },
        transfers: 1,
        mode: "copy" as const,
      };
      const pass = await supervisor.startCopyPass(input);
      const reference = { socketPath: worker.socketPath, pass };
      assert.equal((await supervisor.copyPassStatus(reference)).state, "running");
      const deadline = Date.now() + 15_000;
      let stats = await supervisor.copyPassStats(reference);
      while ((stats.files < 1 || stats.transferring.length === 0) && Date.now() < deadline) {
        await delay(20);
        stats = await supervisor.copyPassStats(reference);
      }
      assert.ok(stats.files >= 1 && stats.files < 3);
      assert.ok(stats.bytes >= content.length);
      assert.equal(stats.errors, 0);
      assert.equal(stats.transferring.length, 1);
      assert.equal(stats.transferring[0]!.size, content.length);
      assert.ok(["one", "two", "three"].includes(stats.transferring[0]!.path));
      const independent = await supervisor.startCopyPass({
        ...input,
        destination: {
          fs: `:local,no_clone=true:${join(directory, "independent")}`,
          kind: "local",
        },
      });
      const independentReference = { socketPath: worker.socketPath, pass: independent };
      await supervisor.stopCopyPass(reference);
      assert.equal((await finish(supervisor, reference)).state, "failed");
      assert.equal((await supervisor.copyPassStatus(independentReference)).state, "running");
      const already = await supervisor.listFileHashes({
        socketPath: worker.socketPath,
        root: input.destination,
        hashType: "md5",
        download: false,
      });
      assert.ok(already.length >= 1 && already.length < 3);
      await supervisor.call(worker.socketPath, "core/bwlimit", { rate: "off" });
      const resumed = await supervisor.startCopyPass(input);
      assert.notEqual(resumed.group, pass.group);
      assert.equal(resumed.executeId, pass.executeId);
      assert.notEqual(resumed.jobid, pass.jobid);
      assert.deepEqual(await finish(supervisor, { socketPath: worker.socketPath, pass: resumed }), {
        state: "completed",
        error: null,
      });
      assert.deepEqual(await finish(supervisor, independentReference), {
        state: "completed",
        error: null,
      });
      assert.equal((await supervisor.copyPassStats(independentReference)).files, 3);
      const resumedStats = await supervisor.copyPassStats({
        socketPath: worker.socketPath,
        pass: resumed,
      });
      assert.equal(resumedStats.files, 3 - already.length);
      assert.equal(resumedStats.bytes, (3 - already.length) * content.length);
      for (const name of ["one", "two", "three"])
        assert.deepEqual(await readFile(join(destination, name)), content);
      const stale = {
        socketPath: worker.socketPath,
        pass: { ...resumed, executeId: "another-worker" },
      };
      await assert.rejects(supervisor.copyPassStatus(stale));
      await assert.rejects(supervisor.copyPassStats(stale));
      await assert.rejects(supervisor.stopCopyPass(stale));
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
