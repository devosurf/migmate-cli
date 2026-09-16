import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { writeConversationContainer } from "../src/engine/archive/container.ts";

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "migmate-archive-container-"));
  t.after(async () => {
    for (const path of await readdir(root, { recursive: true })) {
      const absolute = join(root, path);
      if ((await lstat(absolute)).isDirectory()) await chmod(absolute, 0o755);
    }
    await rm(root, { recursive: true, force: true });
  });
  const conversation = join(root, "conversations", `planning-${"a".repeat(64)}`);
  const files = new Map<string, string | Buffer>([
    ["parts/2026-01-0001.html", '<img src="../assets/hosted/abc/content">'],
    ["manifest.json", '{"version":1}\n'],
    ["index.html", '<a href="parts/2026-01-0001.html">January</a>'],
    ["index.csv", "month,path\n2026-01,parts/2026-01-0001.html\n"],
    ["data/2026-01-0001.jsonl", '{"id":"message-a","body":{"content":"Hello"}}\n'],
    [
      "assets/hosted/abc/content",
      Buffer.alloc(256 * 1024 + 17, Buffer.from([0, 255, 1, 128, 13, 10])),
    ],
    ["data/empty.jsonl", ""],
  ]);
  for (const [path, content] of files) {
    await mkdir(dirname(join(conversation, path)), { recursive: true });
    await writeFile(join(conversation, path), content);
  }
  await mkdir(join(conversation, "assets", "attachments"));
  return { root, conversation };
}

async function tree(root: string): Promise<Map<string, Buffer | null>> {
  const result = new Map<string, Buffer | null>();
  for (const path of (await readdir(root, { recursive: true })).sort()) {
    const absolute = join(root, path);
    result.set(path, (await lstat(absolute)).isDirectory() ? null : await readFile(absolute));
  }
  return result;
}

it("a stock unzip restores every conversation path and byte, including extensionless hosted content", async (t) => {
  const { root, conversation } = await fixture(t);
  const destination = join(root, "conversation.zip");
  await writeConversationContainer(conversation, destination);
  const extracted = join(root, "extracted");
  await exec("unzip", ["-q", destination, "-d", extracted]);
  assert.deepEqual(await tree(extracted), await tree(conversation));
});

it("container digests ignore filesystem metadata and entries follow sorted artifact paths", async (t) => {
  const { root, conversation } = await fixture(t);
  // A directory walk alone puts data/ before data-summary.json, unlike artifact sorting.
  await writeFile(join(conversation, "data-summary.json"), "{}\n");
  const first = join(root, "first.zip");
  await writeConversationContainer(conversation, first);
  for (const path of ["", ...(await readdir(conversation, { recursive: true }))]) {
    const absolute = join(conversation, path);
    await utimes(absolute, new Date("2020-01-01T00:00:00Z"), new Date("2030-12-31T23:59:58Z"));
    await chmod(absolute, (await lstat(absolute)).isDirectory() ? 0o700 : 0o400);
  }
  const second = join(root, "second.zip");
  await writeConversationContainer(conversation, second);
  const digest = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  assert.equal(await digest(first), await digest(second));
  const { stdout } = await exec("unzip", ["-Z1", second]);
  const paths = stdout.trimEnd().split("\n");
  assert.deepEqual(paths, [...paths].sort());
});
