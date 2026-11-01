import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { collectDestinationConstraints } from "../src/engine/providers/destination-constraints.ts";
import { sharepointCapabilities } from "../src/engine/providers/adapters/sharepoint-capabilities.ts";
import { googleCapabilities } from "../src/engine/providers/adapters/google-capabilities.ts";
import type { DestinationConstraintRoot } from "../src/engine/providers/adapters/capabilities.ts";
import type { SourceEntry } from "../src/engine/providers/port.ts";
import { DiskListing, ListingScratch, disposeListing } from "../src/engine/providers/listing.ts";
import { isAcceptable } from "../src/engine/codes.ts";

function entry(
  id: string,
  name: string,
  kind: SourceEntry["kind"] = "file",
  parentId = "root",
): SourceEntry {
  return {
    id,
    name,
    kind,
    parentId,
    driveId: "source-drive",
    size: kind === "folder" ? null : 1,
    etag: null,
    createdAt: "2026-10-30T00:00:00Z",
    modifiedAt: "2026-10-30T00:00:00Z",
    mimeType: null,
    identity: id,
    downloadable: kind === "file",
    webUrl: null,
    packageSections: null,
  };
}

const library: DestinationConstraintRoot = {
  webUrl: "https://tenant.sharepoint.com/sites/team/Shared%20Documents",
  folderDepth: 0,
};

async function collect(
  entries: SourceEntry[],
  root: DestinationConstraintRoot | undefined = library,
  checkPaths = true,
) {
  using findings = await collectDestinationConstraints({
    provider: {
      async listSourceChildren({ itemId }) {
        return entries.filter((item) => item.parentId === itemId);
      },
    },
    destination: sharepointCapabilities,
    source: googleCapabilities,
    checkPaths,
    sourceDriveId: "source-drive",
    sourceItemId: "root",
    root,
  });
  return [...findings];
}

for (const name of [
  "",
  "\ud800.txt",
  ".lock",
  "CON",
  "pRn",
  "AUX",
  "nul",
  "COM0",
  "com9",
  "LPT0",
  "lpt9",
  "desktop.INI",
  "prefix_VTI_suffix",
  "~$Office.docx",
]) {
  test(`blocks reserved or unrepresentable source name ${JSON.stringify(name)}`, async () => {
    const findings = await collect([entry("source-object", name)]);
    assert.deepEqual(
      findings
        .filter((finding) => finding.blocking)
        .map(({ code, path, sourceId }) => ({
          code,
          path,
          sourceId,
        })),
      [{ code: "destination_invalid_name", path: name, sourceId: "source-object" }],
    );
  });
}

for (const [name, encodedName] of [
  ['quote".txt', "quote＂.txt"],
  ["star*.txt", "star＊.txt"],
  ["colon:.txt", "colon：.txt"],
  ["less<.txt", "less＜.txt"],
  ["more>.txt", "more＞.txt"],
  ["what?.txt", "what？.txt"],
  ["literal/slash.txt", "literal／slash.txt"],
  ["back\\slash.txt", "back＼slash.txt"],
  ["pipe|.txt", "pipe｜.txt"],
  ["\u0000.txt", "␀.txt"],
  ["\u001f.txt", "␟.txt"],
  ["\u007f.txt", "␡.txt"],
  [" leading", "␠leading"],
  ["trailing ", "trailing␠"],
  ["trailing.", "trailing．"],
  [".", "．"],
  ["..", "．．"],
  ["fullwidth／.txt", "fullwidth‛／.txt"],
  ["literal‛quote.txt", "literal‛‛quote.txt"],
  ["literal‛41.txt", "literalA.txt"],
  ["~report.txt", "～report.txt"],
  ["＂＊：＜＞？＼｜.txt", "‛＂‛＊‛：‛＜‛＞‛？‛＼‛｜.txt"],
  ["␠leading", "‛␠leading"],
  ["trailing␠", "trailing‛␠"],
  ["trailing．", "trailing‛．"],
  ["～leading", "‛～leading"],
  ["symbol␁␟␡.txt", "symbol‛␁‛␟‛␡.txt"],
]) {
  test(`discloses encoded source name ${JSON.stringify(name)} without blocking`, async () => {
    const findings = await collect([entry("source-object", name!)]);
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0], {
      code: "destination_name_encoded",
      blocking: false,
      path: name,
      sourceId: "source-object",
      kind: "file",
      detail: {
        message: "The transfer backend encodes this source path for the destination.",
        originalName: name,
        encodedName,
        originalPath: name,
        encodedPath: encodedName,
      },
    });
  });
}

test("representable Unicode and supported punctuation are not renamed or rejected", async () => {
  assert.deepEqual(
    await collect([
      entry("unicode", "résumé-日本語-😀.txt"),
      entry("punctuation", "100% #tag; [draft] & final.txt"),
      entry("inner", "inner~tilde. period.txt"),
      entry("symbol", "inner～tilde．period.txt"),
      entry("null-picture", "symbol␀.txt"),
      entry("escaped-quote", "literal‛‛quote.txt"),
      entry("escaped-null-picture", "literal‛␀.txt"),
      entry("escaped-quote-and-null-picture", "literal‛‛‛␀.txt"),
    ]),
    [],
  );
});

test("an encoded slash basename discloses every descendant's actual path without blockers", async () => {
  const findings = await collect([
    entry("folder", "invalid/folder", "folder"),
    entry("nested", "nested", "folder", "folder"),
    entry("leaf", "valid.txt", "file", "nested"),
  ]);
  assert.deepEqual(
    findings.map(({ path, sourceId, blocking, detail }) => ({
      path,
      sourceId,
      blocking,
      encodedPath: detail.encodedPath,
    })),
    [
      {
        path: "invalid/folder",
        sourceId: "folder",
        blocking: false,
        encodedPath: "invalid／folder",
      },
      {
        path: "invalid/folder/nested",
        sourceId: "nested",
        blocking: false,
        encodedPath: "invalid／folder/nested",
      },
      {
        path: "invalid/folder/nested/valid.txt",
        sourceId: "leaf",
        blocking: false,
        encodedPath: "invalid／folder/nested/valid.txt",
      },
    ],
  );
  assert.equal(findings[2]?.detail.originalName, "valid.txt");
  assert.equal(findings[2]?.detail.encodedName, "valid.txt");
  assert.equal(findings[2]?.detail.ancestorSourceId, undefined);
});

test("SharePoint's special leading characters restrict folders, not files", async () => {
  const findings = await collect([
    entry("folder-a", "\u309bname", "folder"),
    entry("folder-b", "\u1027name", "folder"),
    entry("file-a", "\u309bfile.txt"),
    entry("file-b", "\u1027file.txt"),
  ]);
  assert.deepEqual(
    findings.map((finding) => finding.sourceId),
    ["folder-a", "folder-b"],
  );
});

test("Forms is reserved only at the library root, including case variants", async () => {
  const entries = [entry("forms", "FoRmS", "folder"), entry("file", "a.txt", "file", "forms")];
  const findings = await collect(entries);
  assert.deepEqual(
    findings.map(({ path, sourceId }) => ({ path, sourceId })),
    [
      { path: "FoRmS", sourceId: "forms" },
      { path: "FoRmS/a.txt", sourceId: "file" },
    ],
  );
  assert.deepEqual(
    await collect(entries, {
      webUrl: `${library.webUrl}/wrapper`,
      folderDepth: 1,
    }),
    [],
  );
  const unproven = await collect([entry("forms", "Forms")], { webUrl: library.webUrl! });
  assert.equal(unproven[0]?.code, "destination_invalid_name");
  assert.match(unproven[0]!.detail.message, /depth is unproven/u);
});

test("duplicate IDs and every descendant survive findings even when paths coincide", async () => {
  const findings = await collect([
    entry("folder-a", "Reports", "folder"),
    entry("folder-b", "Reports", "folder"),
    entry("file-a", "a.txt", "file", "folder-a"),
    entry("file-b", "a.txt", "file", "folder-b"),
    entry("deep", "deep", "folder", "folder-a"),
    entry("deep-file", "b.txt", "file", "deep"),
    entry("safe", "safe.txt"),
  ]);
  assert.deepEqual(
    findings
      .map(({ code, path, sourceId }) => ({ code, path, sourceId }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    [
      { code: "destination_duplicate_name", path: "Reports/deep", sourceId: "deep" },
      { code: "destination_duplicate_name", path: "Reports/deep/b.txt", sourceId: "deep-file" },
      { code: "destination_duplicate_name", path: "Reports/a.txt", sourceId: "file-a" },
      { code: "destination_duplicate_name", path: "Reports/a.txt", sourceId: "file-b" },
      { code: "destination_duplicate_name", path: "Reports", sourceId: "folder-a" },
      { code: "destination_duplicate_name", path: "Reports", sourceId: "folder-b" },
    ],
  );
  for (const finding of findings)
    assert.deepEqual(finding.detail.siblingSourceIds, ["folder-a", "folder-b"]);
});

test("case-insensitive collisions include a file and folder but not names in different parents", async () => {
  const findings = await collect([
    entry("file", "Report"),
    entry("folder", "report", "folder"),
    entry("descendant", "child.txt", "file", "folder"),
    entry("other", "other", "folder"),
    entry("safe", "Report", "file", "other"),
  ]);
  assert.deepEqual(
    findings.map((finding) => finding.sourceId),
    ["file", "folder", "descendant"],
  );
});

test("uses 400 decoded full server-relative characters including the target wrapper", async () => {
  const root = { serverRelativePath: `/sites/${"s".repeat(180)}/Library/Wrapper`, folderDepth: 1 };
  const available = 400 - root.serverRelativePath.length - 1;
  assert.deepEqual(await collect([entry("boundary", "x".repeat(available))], root), []);
  const findings = await collect([entry("too-long", "x".repeat(available + 1))], root);
  assert.equal(findings[0]?.sourceId, "too-long");
  assert.equal(findings[0]?.path.length, available + 1);
  assert.equal(findings[0]?.code, "destination_path_too_long");
  assert.match(findings[0]!.detail.message, /401 characters/u);
});

test("decodes the observed URL once, never source names or a supplied decoded path", async () => {
  const prefix = `/sites/${"é ".repeat(80)}%20/Docs`;
  const name = "%20".repeat(Math.floor((400 - prefix.length - 1) / 3));
  assert.deepEqual(
    await collect([entry("encoded-looking-name", name)], {
      webUrl: `https://tenant.sharepoint.com${encodeURI(prefix)}`,
      folderDepth: 0,
    }),
    [],
  );
  const root = { serverRelativePath: prefix, folderDepth: 0 };
  const overflow = "x".repeat(401 - prefix.length - 1);
  assert.equal(
    (await collect([entry("overflow", overflow)], root))[0]?.code,
    "destination_path_too_long",
  );
});

test("does not mistake the desktop 255-character segment limit for a cloud restriction", async () => {
  assert.deepEqual(
    await collect([
      entry("at-255", "a".repeat(255), "folder"),
      entry("at-256", "b".repeat(256), "folder"),
    ]),
    [],
  );
});

test("does not claim complete path proof without usable root metadata", async () => {
  for (const root of [
    {},
    { webUrl: "not-a-url" },
    { webUrl: "https://tenant.sharepoint.com/%ZZ" },
    { serverRelativePath: "relative/Docs" },
    { webUrl: "https://tenant.sharepoint.com/Docs?view=all" },
  ]) {
    const findings = await collect([entry("file", "normal.txt")], root);
    assert.deepEqual(
      findings.map(({ code, path, sourceId }) => ({ code, path, sourceId })),
      [
        { code: "destination_path_unverified", path: "", sourceId: "root" },
        { code: "destination_path_unverified", path: "normal.txt", sourceId: "file" },
      ],
    );
    assert.equal((await collect([], root))[0]?.code, "destination_path_unverified");
  }
});

test("destination policy is reusable and does not apply SharePoint naming rules to Google", async () => {
  using findings = await collectDestinationConstraints({
    provider: {
      async listSourceChildren() {
        return [entry("first", "name?.txt"), entry("second", "name?.txt")];
      },
    },
    destination: googleCapabilities,
    sourceDriveId: "source-drive",
    sourceItemId: "root",
  });
  assert.ok(findings instanceof DiskListing);
  assert.deepEqual([...findings], []);
});

test("an unreadable subtree cannot become a clean constraint result", async () => {
  await assert.rejects(
    collectDestinationConstraints({
      provider: {
        async listSourceChildren({ itemId }) {
          if (itemId === "root") return [entry("folder", "folder", "folder")];
          throw new Error("source listing unavailable");
        },
      },
      destination: sharepointCapabilities,
      sourceDriveId: "source-drive",
      sourceItemId: "root",
      root: library,
    }),
    /source listing unavailable/u,
  );
});

test("constraint codes require source repair instead of accepting per-path exclusions", () => {
  for (const code of [
    "destination_invalid_name",
    "destination_path_too_long",
    "destination_path_unverified",
    "destination_duplicate_name",
  ]) {
    assert.equal(isAcceptable(code), false);
  }
});

test("effective encoded sibling collisions block every ID, not just duplicate native strings", async () => {
  const findings = await collect([
    entry("plain", "A.txt"),
    entry("hex", "‛41.txt"),
    entry("one-quote", "literal‛quote.txt"),
    entry("two-quotes", "literal‛‛quote.txt"),
  ]);
  const blockers = findings.filter((finding) => finding.blocking);
  assert.deepEqual(
    blockers.map((finding) => finding.sourceId),
    ["plain", "hex", "one-quote", "two-quotes"],
  );
  assert.ok(blockers.every((finding) => finding.code === "destination_duplicate_name"));
  assert.deepEqual(blockers[0]?.detail.siblingSourceIds, ["plain", "hex"]);
  assert.deepEqual(blockers[2]?.detail.siblingSourceIds, ["one-quote", "two-quotes"]);
  assert.deepEqual(
    findings.filter((finding) => !finding.blocking).map((finding) => finding.sourceId),
    ["hex", "one-quote"],
  );
});

test("escaped literal replacement glyphs do not collide with ordinary invalid characters", async () => {
  const findings = await collect([
    entry("slash", "literal/slash.txt"),
    entry("fullwidth-slash", "literal／slash.txt"),
    entry("question", "what?.txt"),
    entry("fullwidth-question", "what？.txt"),
  ]);
  assert.equal(findings.length, 4);
  assert.ok(findings.every((finding) => !finding.blocking));
  assert.deepEqual(
    findings.map((finding) => finding.detail.encodedPath),
    ["literal／slash.txt", "literal‛／slash.txt", "what？.txt", "what‛？.txt"],
  );
});

test("400-character limit counts escaped replacement characters after encoding", async () => {
  const root = { serverRelativePath: "/sites/team/Docs", folderDepth: 0 };
  const available = 400 - root.serverRelativePath.length - 1;
  const boundary = await collect([entry("boundary", `${"x".repeat(available - 2)}？`)], root);
  assert.equal(boundary.length, 1);
  assert.equal(boundary[0]?.blocking, false);
  assert.equal(String(boundary[0]?.detail.encodedPath).length, available);
  const original = `${"x".repeat(available - 1)}？`;
  const overflow = await collect([entry("overflow", original)], root);
  const blocker = overflow.find((finding) => finding.blocking);
  assert.equal(blocker?.code, "destination_path_too_long");
  assert.equal(blocker?.path, original);
  assert.match(blocker!.detail.message, /401 characters/u);
  assert.equal(
    overflow.find((finding) => !finding.blocking)?.detail.encodedPath,
    `${"x".repeat(available - 1)}‛？`,
  );
});

test("blocking ancestors propagate separately from per-descendant encoding notices", async () => {
  const findings = await collect([
    entry("folder", "~$reserved", "folder"),
    entry("leaf", "valid.txt", "file", "folder"),
  ]);
  const blockers = findings.filter((finding) => finding.blocking);
  assert.deepEqual(
    blockers.map((finding) => finding.sourceId),
    ["folder", "leaf"],
  );
  assert.equal(blockers[1]?.detail.ancestorSourceId, "folder");
  const notices = findings.filter((finding) => !finding.blocking);
  assert.deepEqual(
    notices.map((finding) => finding.detail.encodedPath),
    ["～$reserved", "～$reserved/valid.txt"],
  );
  assert.ok(notices.every((finding) => finding.detail.ancestorSourceId === undefined));
});

test("source decoding cannot hide a reserved effective name", async () => {
  const findings = await collect([entry("reserved", "‛43ON")]);
  assert.equal(findings.find((finding) => finding.blocking)?.code, "destination_invalid_name");
  assert.equal(findings.find((finding) => !finding.blocking)?.detail.encodedName, "CON");
});

test("unrepresentable source decoding blocks descendants without inventing encoded paths", async () => {
  const findings = await collect([
    entry("folder", "‛FF", "folder"),
    entry("leaf", "what?.txt", "file", "folder"),
  ]);
  assert.deepEqual(
    findings.map(({ code, sourceId, blocking }) => ({ code, sourceId, blocking })),
    [
      { code: "destination_invalid_name", sourceId: "folder", blocking: true },
      { code: "destination_invalid_name", sourceId: "leaf", blocking: true },
    ],
  );
  assert.match(findings[0]!.detail.message, /STANDARD.*losslessly/u);
  assert.equal(findings[1]?.detail.ancestorSourceId, "folder");
  assert.ok(findings.every((finding) => finding.detail.encodedPath === undefined));
});

test("duplicate original names still block when their decoded projection is unrepresentable", async () => {
  const findings = await collect([entry("first", "‛FF"), entry("second", "‛FF")]);
  assert.deepEqual(
    findings
      .filter((finding) => finding.code === "destination_duplicate_name")
      .map((finding) => finding.sourceId),
    ["first", "second"],
  );
  assert.ok(findings.every((finding) => finding.blocking));
});

test("uncreated-root planning walks names and collisions without claiming path proof", async () => {
  const entries = [
    entry("first", "Reports", "folder"),
    entry("second", "reports", "folder"),
    entry("long", `${"x".repeat(401)}?`),
    entry("nested", "what?.txt", "file", "first"),
  ];
  const findings = await collect(entries, {}, false);
  assert.ok(
    findings.every(
      (finding) =>
        finding.code !== "destination_path_unverified" &&
        finding.code !== "destination_path_too_long",
    ),
  );
  assert.deepEqual(
    findings.filter((finding) => finding.blocking).map((finding) => finding.sourceId),
    ["first", "second", "nested"],
  );
  assert.deepEqual(
    findings.filter((finding) => !finding.blocking).map((finding) => finding.sourceId),
    ["long", "nested"],
  );
  assert.deepEqual(await collect([], {}, false), []);
});

test("deferring length proof does not disable Forms or destination-depth policy", async () => {
  const entries = [entry("forms", "FoRmS", "folder")];
  const findings = await collect(entries, {}, false);
  assert.equal(findings[0]?.code, "destination_invalid_name");
  assert.equal(findings[0]?.blocking, true);
  assert.match(findings[0]!.detail.message, /depth is unproven/u);
  assert.deepEqual(await collect(entries, { folderDepth: 1 }, false), []);
});

test("the result remains caller-owned after native listings and indexes are disposed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "migmate-constraints-test-"));
  try {
    using scratch = new ListingScratch(directory);
    await scratch.run(async () => {
      let disposed = 0;
      const native = new DiskListing<SourceEntry>(
        (item) => item.id,
        () => {
          disposed++;
        },
      );
      native.add(entry("first", "what?.txt"));
      const findings = await collectDestinationConstraints({
        provider: {
          async listSourceChildren() {
            return native;
          },
        },
        destination: sharepointCapabilities,
        source: googleCapabilities,
        sourceDriveId: "source-drive",
        sourceItemId: "root",
        root: library,
      });
      try {
        assert.ok(findings instanceof DiskListing);
        assert.equal(disposed, 1);
        assert.throws(() => native.has("first"), /disposed/u);
        assert.equal(findings.size, 1);
        assert.deepEqual([...findings], [...findings]);
        const owner = readdirSync(directory);
        assert.equal(owner.length, 1);
        assert.equal(readdirSync(join(directory, owner[0]!)).length, 1);
      } finally {
        disposeListing(findings);
      }
      assert.throws(() => findings.has("what?.txt"), /disposed/u);
      for (const owner of readdirSync(directory))
        assert.deepEqual(readdirSync(join(directory, owner)), []);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const failure of [
  "iteration",
  "projection",
  "abort",
  "late-abort",
  "subtree",
  "cycle",
  "repeated-directory",
] as const) {
  test(`disposes native listings, partial results and scratch on ${failure}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "migmate-constraints-failure-"));
    const controller = new AbortController();
    let disposed = 0;
    let opened = 0;
    const expected = new Error(`injected ${failure}`);
    try {
      using scratch = new ListingScratch(directory);
      await scratch.run(async () => {
        await assert.rejects(
          collectDestinationConstraints({
            provider: {
              async listSourceChildren({ itemId }) {
                if (itemId !== "root" && failure === "subtree") throw expected;
                opened++;
                if (failure === "late-abort") controller.abort(expected);
                return {
                  *[Symbol.iterator]() {
                    if (itemId !== "root") {
                      yield entry("root", "back", "folder", itemId);
                      return;
                    }
                    yield entry("folder", "what?", "folder");
                    if (failure === "iteration") throw expected;
                    if (failure === "abort") controller.abort(expected);
                    yield entry(
                      failure === "repeated-directory" ? "folder" : "second",
                      "second",
                      failure === "repeated-directory" ? "folder" : "file",
                    );
                  },
                  [Symbol.dispose]() {
                    disposed++;
                  },
                };
              },
            },
            destination: {
              ...sharepointCapabilities,
              destinationName(name) {
                if (failure === "projection") throw expected;
                return sharepointCapabilities.destinationName!(name);
              },
            },
            sourceDriveId: "source-drive",
            sourceItemId: "root",
            root: library,
            signal: controller.signal,
          }),
          failure === "cycle" || failure === "repeated-directory"
            ? /repeated source directory identity/u
            : (error: unknown) => error === expected,
        );
        assert.equal(disposed, opened);
        assert.ok(opened > 0);
        // Inspect before disposing the owner: no sweep may hide leaked indexes.
        for (const owner of readdirSync(directory))
          assert.deepEqual(readdirSync(join(directory, owner)), []);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("duplicate witnesses count distinct identities without accumulating the group", async () => {
  const findings = await collect([
    entry("first", "REPORT"),
    entry("first", "REPORT"),
    entry("second", "report"),
    entry("third", "Report"),
  ]);
  assert.equal(findings.length, 4);
  for (const finding of findings) {
    assert.equal(finding.code, "destination_duplicate_name");
    assert.equal(finding.detail.siblingSourceCount, 3);
    assert.deepEqual(finding.detail.siblingSourceIds, ["first", "second"]);
  }
  assert.deepEqual(await collect([entry("only", "report"), entry("only", "report")]), []);
});

test("native malformed names retain distinct index keys and duplicate evidence", async () => {
  const findings = await collect([
    entry("high-a", "\ud800"),
    entry("high-b", "\ud800"),
    entry("low", "\udc00"),
    entry("replacement", "\ufffd"),
  ]);
  const duplicates = findings.filter((finding) => finding.code === "destination_duplicate_name");
  assert.deepEqual(
    duplicates.map((finding) => finding.sourceId),
    ["high-a", "high-b"],
  );
  assert.ok(duplicates.every((finding) => finding.detail.siblingSourceCount === 2));
});

test(
  "generated siblings, duplicate notices and a wide frontier stay within a fixed heap",
  {
    timeout: 180_000,
  },
  async (t) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--max-old-space-size=64",
        "--expose-gc",
        new URL("./destination-constraints-scale-fixture.ts", import.meta.url).pathname,
      ],
      { timeout: 170_000, maxBuffer: 1024 * 1024, signal: t.signal },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.flatItems, 8194);
    assert.equal(result.flatFindings, 12291);
    assert.equal(result.folders, 1025);
    assert.equal(result.frontierFindings, 1025);
    assert.ok(result.retainedHeap < 8 * 1024 * 1024);
  },
);

test("OneNote packages traverse section groups for folder and descendant path policy", async () => {
  const entries = [
    { ...entry("notebook", "Notebook", "package"), packageSections: 1 },
    entry("opaque-package", "Opaque", "package"),
    entry("section-group", "Group", "folder", "notebook"),
    entry("section", "Section.one", "file", "section-group"),
    entry("not-a-directory-child", "Hidden", "file", "opaque-package"),
  ];
  const visited: string[] = [];
  using findings = await collectDestinationConstraints({
    provider: {
      async listSourceChildren({ itemId }) {
        visited.push(itemId);
        return entries.filter((item) => item.parentId === itemId);
      },
    },
    destination: {
      destinationNameFindings(name, kind) {
        return name === "Notebook" && kind === "folder"
          ? [{ code: "notebook-folder-policy", message: "A folder-only restriction." }]
          : [];
      },
      destinationPathFindings(path) {
        return path === "Notebook/Group/Section.one"
          ? [
              {
                code: "destination_path_too_long",
                message: "The nested section exceeds destination depth.",
              },
            ]
          : [];
      },
    },
    sourceDriveId: "source-drive",
    sourceItemId: "root",
  });
  assert.deepEqual(visited, ["root", "notebook", "section-group"]);
  assert.deepEqual(
    [...findings].map(({ code, sourceId, kind }) => ({ code, sourceId, kind })),
    [
      { code: "notebook-folder-policy", sourceId: "notebook", kind: "folder" },
      { code: "notebook-folder-policy", sourceId: "section-group", kind: "folder" },
      { code: "notebook-folder-policy", sourceId: "section", kind: "file" },
      { code: "destination_path_too_long", sourceId: "section", kind: "file" },
    ],
  );
});
