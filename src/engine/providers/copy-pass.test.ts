import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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
