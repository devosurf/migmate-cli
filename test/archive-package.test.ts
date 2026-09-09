import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { defaultTreeAdapter, parse, type DefaultTreeAdapterTypes } from "parse5";
import {
  analyzeRecord,
  assetPath,
  buildArchivePackage,
  conversationPath,
  verifyArchivePackage,
  type ConversationManifest,
  type PackageManifest,
} from "../src/engine/archive/package.ts";
import type {
  ArchiveConversation,
  ArchivePackageInput,
  ArchivePackageResult,
  ArchiveRecord,
} from "../src/engine/providers/archive.ts";

const conversation: ArchiveConversation = {
  id: "channel:team/full-id:thread/full-id",
  kind: "channel",
  title: 'Planning / "Q3"',
  scopeEntryId: "channel-scope",
  participantScopeIds: ["channel-scope"],
  teamId: "team/full-id",
  channelId: "thread/full-id",
  membershipType: "standard",
  raw: { id: "thread/full-id", displayName: 'Planning / "Q3"' },
};
const emptyConversation: ArchiveConversation = {
  id: "chat:empty/full-id",
  kind: "chat",
  title: "Empty conversation",
  scopeEntryId: "user-scope",
  participantScopeIds: ["user-scope"],
  ownerUserId: "user/full-id",
  raw: { id: "empty/full-id" },
};

function record(
  id: string,
  createdDateTime = "2026-01-15T12:00:00Z",
  raw: Record<string, unknown> = {},
): ArchiveRecord {
  return {
    key: `durable:${id}`,
    conversationId: conversation.id,
    messageId: id,
    createdDateTime,
    route: "messages",
    raw: {
      id,
      createdDateTime,
      from: {
        user: {
          id: "aad-user-id",
          userPrincipalName: "person@example.test",
          displayName: "Original Person",
        },
      },
      body: { contentType: "html", content: "<p>Original message</p>" },
      ...raw,
    },
    assets: [],
    findings: [],
  };
}

function fixture(records: ArchiveRecord[] = [record("message-a")]): ArchivePackageInput {
  return {
    plan: {
      version: 1,
      timezone: "America/New_York",
      window: { from: "0001-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
      conversations: [conversation, emptyConversation],
      scopes: [
        {
          id: "channel-scope",
          kind: "channel",
          teamId: "team/full-id",
          channelId: "thread/full-id",
          conversationIds: [conversation.id],
        },
        {
          id: "user-scope",
          kind: "user-chats",
          userId: "user/full-id",
          conversationIds: [emptyConversation.id],
        },
      ],
      config: {
        scopes: [
          { kind: "channel", teamId: "team/full-id", channelId: "thread/full-id" },
          { kind: "user-chats", userId: "user/full-id" },
        ],
        cloud: "Global",
        retainedHistory: false,
        transcripts: false,
        attachmentBytes: false,
        timezone: "America/New_York",
        window: { from: "0001-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
      },
    },
    records,
    evidence: [
      {
        scopeEntryId: "channel-scope",
        route: "messages",
        cursor: null,
        nextLink: null,
        complete: true,
        recordKeys: records
          .filter((entry) => entry.conversationId === conversation.id)
          .map((entry) => entry.key),
        findingCodes: [],
      },
      {
        scopeEntryId: "user-scope",
        route: "messages",
        cursor: null,
        nextLink: null,
        complete: true,
        recordKeys: [],
        findingCodes: [],
      },
    ],
  };
}

async function install(
  t: TestContext,
  input: ArchivePackageInput,
  assets: Map<string, Uint8Array> = new Map(),
): Promise<{ root: string; package: ArchivePackageResult }> {
  const root = await mkdtemp(join(tmpdir(), "migmate-archive-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = buildArchivePackage(input);
  for (const file of result.files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.content);
  }
  for (const [path, bytes] of assets) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  return { root, package: result };
}

function documentElements(content: string): DefaultTreeAdapterTypes.Element[] {
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  const document = parse(content);
  const walk = (nodes: DefaultTreeAdapterTypes.ChildNode[]): void => {
    for (const node of nodes) {
      if (!defaultTreeAdapter.isElementNode(node)) continue;
      elements.push(node);
      walk(node.childNodes);
    }
  };
  walk(document.childNodes);
  return elements;
}

function conversationManifest(
  result: ArchivePackageResult,
  value = conversation,
): ConversationManifest {
  const file = result.files.find(
    (entry) => entry.path === `${conversationPath(value)}/manifest.json`,
  );
  assert.ok(file);
  return JSON.parse(file.content);
}

describe("archive whole-artifact contract", () => {
  it("regenerates deterministic raw JSONL and reconciles UTC months, identities, indices and an empty conversation", async (t) => {
    const records = [
      record("b", "2026-02-01T00:00:00Z"),
      record("z", "2026-01-31T23:30:00Z"),
      record("a", "2026-02-01T00:00:00Z"),
    ];
    const input = fixture(records);
    const result = buildArchivePackage(input);
    const reordered = {
      ...input,
      records: [...records].reverse(),
      evidence: [...input.evidence].reverse(),
      plan: {
        ...input.plan,
        conversations: [...input.plan.conversations].reverse(),
        scopes: [...input.plan.scopes].reverse(),
      },
    };
    assert.deepEqual(buildArchivePackage(reordered), result);
    const manifest = conversationManifest(result);
    assert.deepEqual(
      manifest.parts.map((part) => [part.month, part.count]),
      [
        ["2026-01", 1],
        ["2026-02", 2],
      ],
    );
    const raw = result.files
      .filter((file) => file.path.endsWith(".jsonl"))
      .flatMap((file) =>
        file.content
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    assert.deepEqual(raw, [records[1]!.raw, records[2]!.raw, records[0]!.raw]);
    assert.ok(raw.every((entry) => !Object.hasOwn(entry, "raw") && !Object.hasOwn(entry, "key")));
    const rendered = result.files
      .filter((file) => file.path.includes("/parts/"))
      .map((file) => file.content)
      .join("");
    assert.ok(rendered.includes("2026-02-01T00:00:00.000Z"));
    assert.ok(rendered.includes("31/01/2026, 19:00:00 America/New_York"));
    assert.ok(rendered.includes("aad-user-id") && rendered.includes("person@example.test"));
    const empty = conversationManifest(result, emptyConversation);
    assert.equal(empty.statement, "empty_conversation");
    assert.deepEqual(empty.parts, []);
    const root = JSON.parse(
      result.files.find((file) => file.path === "manifest.json")!.content,
    ) as PackageManifest;
    assert.deepEqual(
      [root.scopeCount, root.conversationCount, root.partCount, root.recordCount],
      [2, 2, 2, 3],
    );
    for (const file of result.files) {
      assert.equal(file.sha256, createHash("sha256").update(file.content).digest("hex"));
      assert.ok(
        !file.path.includes(conversation.id) &&
          !file.path.includes(conversation.teamId!) &&
          !file.path.includes(conversation.channelId!),
      );
    }
    const installed = await install(t, input);
    assert.deepEqual(
      await verifyArchivePackage(installed.root, {
        ...input,
        manifestDigest: result.manifestDigest,
      }),
      [],
    );
  });

  it("reconciles a shared chat with one collecting owner and all participating scopes", async (t) => {
    const input = fixture([]);
    input.plan.conversations = [
      conversation,
      { ...emptyConversation, participantScopeIds: ["user-scope", "user-second"] },
    ];
    input.plan.scopes.push({
      id: "user-second",
      kind: "user-chats",
      userId: "second-user",
      conversationIds: [],
    });
    input.plan.config.scopes.push({ kind: "user-chats", userId: "second-user" });
    input.evidence.push({
      scopeEntryId: "user-second",
      route: "messages",
      cursor: null,
      nextLink: null,
      complete: true,
      recordKeys: [],
      findingCodes: [],
    });
    const installed = await install(t, input);
    const root: PackageManifest = JSON.parse(
      installed.package.files.find((file) => file.path === "manifest.json")!.content,
    );
    assert.equal(root.conversationCount, 2);
    assert.deepEqual(root.scopes.find((scope) => scope.id === "user-second")!.conversationIds, [
      emptyConversation.id,
    ]);
    assert.deepEqual(
      await verifyArchivePackage(installed.root, {
        ...input,
        manifestDigest: installed.package.manifestDigest,
      }),
      [],
    );
  });

  it("splits at ten thousand records without duplicating the boundary record", () => {
    const input = fixture(
      Array.from({ length: 10_001 }, (_, index) =>
        record(`message-${String(index).padStart(5, "0")}`),
      ),
    );
    const manifest = conversationManifest(buildArchivePackage(input));
    assert.deepEqual(
      manifest.parts.map((part) => part.count),
      [10_000, 1],
    );
    assert.equal(manifest.parts[0]!.records.at(-1)!.messageId, "message-09999");
    assert.equal(manifest.parts[1]!.records[0]!.messageId, "message-10000");
  });

  it("splits at the UTF-8 byte limit, not JavaScript character count", () => {
    const padding = "é".repeat(25 * 1024 * 1024);
    const input = fixture([
      record("large-a", undefined, { padding }),
      record("large-b", undefined, { padding }),
    ]);
    const manifest = conversationManifest(buildArchivePackage(input));
    assert.deepEqual(
      manifest.parts.map((part) => part.count),
      [1, 1],
    );
    assert.ok(manifest.parts.every((part) => part.jsonl.size <= 100 * 1024 * 1024));
  });

  it("preserves unsafe and malformed Graph bodies canonically while every removed construct leaves evidence", async (t) => {
    const unsafe = record("unsafe", undefined, {
      body: {
        contentType: "html",
        content:
          '<p style="background:url(https://remote.test)" onclick="evil()">Safe<!--comment--><script>evil()</script><img src="https://remote.test/image" onerror="evil()"><a href="javascript&#58;evil()">bad</a><a href="https://example.test/a?x=1&amp;y=2">good</a><at id="9">@Missing</at></p>',
      },
      mentions: [{ id: 9, mentionText: "@Missing", mentioned: { user: { id: "deleted-user" } } }],
      from: { user: { id: "deleted-sender" } },
      lastEditedDateTime: "2026-01-16T01:00:00Z",
      deletedDateTime: "2026-01-17T01:00:00Z",
      messageHistory: [
        {
          modifiedDateTime: "2026-01-16T01:00:00Z",
          body: { contentType: "html", content: '<p onmouseover="evil()">Earlier</p>' },
        },
      ],
      attachments: [
        {
          id: "card",
          contentType: "application/vnd.microsoft.card.adaptive",
          content: '{"text":"<script>evil()</script>"}',
        },
      ],
    });
    const malformed = record("malformed", undefined, {
      body: { contentType: "html", content: '<!doctype html><p><b>unclosed<a href="' },
    });
    const nullCharacter = record("null", undefined, {
      body: { contentType: "html", content: "<p>before\u0000after</p>" },
    });
    const input = fixture([unsafe, malformed, nullCharacter]);
    const installed = await install(t, input);
    const analyzed = analyzeRecord(unsafe, input.plan.timezone);
    for (const attribute of ["style", "onclick", "onerror", "onmouseover"])
      assert.ok(
        analyzed.some(
          (finding) =>
            finding.code === "render_downgraded" && finding.evidence.attribute === attribute,
        ),
      );
    for (const reason of [
      "comment_removed",
      "element_escaped",
      "remote_or_unavailable_image_removed",
      "unsafe_link_removed",
    ])
      assert.ok(analyzed.some((finding) => finding.evidence.reason === reason));
    assert.ok(analyzed.some((finding) => finding.code === "identity_unresolved"));
    assert.ok(
      analyzeRecord(malformed, input.plan.timezone).some(
        (finding) =>
          finding.code === "render_downgraded" && finding.evidence.action === "escaped_entire_body",
      ),
    );
    for (const file of installed.package.files.filter((file) => file.path.endsWith(".html"))) {
      const elements = documentElements(file.content);
      assert.ok(
        !elements.some((element) =>
          ["script", "iframe", "style", "object", "svg"].includes(element.tagName),
        ),
      );
      assert.ok(
        !elements.some((element) =>
          element.attrs.some(
            (attribute) => attribute.name.startsWith("on") || attribute.name === "style",
          ),
        ),
      );
      assert.ok(
        !elements.some(
          (element) =>
            element.tagName === "img" &&
            element.attrs.some(
              (attribute) => attribute.name === "src" && attribute.value.startsWith("http"),
            ),
        ),
      );
    }
    const part = installed.package.files.find((file) => file.path.includes("/parts/"))!;
    assert.ok(
      documentElements(part.content).some(
        (element) =>
          element.tagName === "a" &&
          element.attrs.some(
            (attribute) =>
              attribute.name === "href" && attribute.value === "https://example.test/a?x=1&y=2",
          ),
      ),
    );
    const actualRaw = installed.package.files
      .filter((file) => file.path.endsWith(".jsonl"))
      .flatMap((file) =>
        file.content
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    assert.deepEqual(
      actualRaw.find((entry) => entry.id === "unsafe"),
      unsafe.raw,
    );
    assert.deepEqual(
      await verifyArchivePackage(installed.root, {
        ...input,
        manifestDigest: installed.package.manifestDigest,
      }),
      [],
    );
  });

  it("rejects HTML corruption in every index and detects duplicated or missing record anchors", async (t) => {
    const input = fixture();
    const installed = await install(t, input);
    const expectedDigest = installed.package.manifestDigest;
    for (const index of installed.package.files.filter((file) =>
      file.path.endsWith("index.html"),
    )) {
      await writeFile(join(installed.root, index.path), index.content + "<script>");
      const findings = await verifyArchivePackage(installed.root, {
        ...input,
        manifestDigest: expectedDigest,
      });
      assert.ok(
        findings.some(
          (finding) => finding.code === "page_parse_failed" && finding.subjectId === index.path,
        ),
      );
      await writeFile(join(installed.root, index.path), index.content);
    }
    const part = installed.package.files.find((file) => file.path.includes("/parts/"))!;
    const article = documentElements(part.content).find(
      (element) => element.tagName === "article",
    )!;
    const anchor = article.attrs.find((attribute) => attribute.name === "id")!.value;
    const digest = article.attrs.find(
      (attribute) => attribute.name === "data-record-digest",
    )!.value;
    await writeFile(
      join(installed.root, part.path),
      part.content.replace(
        "</body>",
        `<article id="${anchor}" data-record-digest="${digest}"></article></body>`,
      ),
    );
    assert.ok(
      (
        await verifyArchivePackage(installed.root, { ...input, manifestDigest: expectedDigest })
      ).some(
        (finding) =>
          finding.code === "record_duplicated" && finding.subjectId === input.records[0]!.key,
      ),
    );
    await writeFile(
      join(installed.root, part.path),
      part.content.replace(`id="${anchor}"`, 'id="removed-anchor"'),
    );
    assert.ok(
      (
        await verifyArchivePackage(installed.root, { ...input, manifestDigest: expectedDigest })
      ).some(
        (finding) =>
          finding.code === "record_unrendered" && finding.subjectId === input.records[0]!.key,
      ),
    );
  });

  it("rejects forged manifest bijections, altered raw identities, added records and changed indices", async (t) => {
    const input = fixture([record("first"), record("second")]);
    const installed = await install(t, input);
    const manifestPath = `${conversationPath(conversation)}/manifest.json`;
    const original = installed.package.files.find((file) => file.path === manifestPath)!;
    const manifest = conversationManifest(installed.package);
    manifest.parts[0]!.records[1]!.key = manifest.parts[0]!.records[0]!.key;
    manifest.parts[0]!.records[1]!.line = 1;
    await writeFile(join(installed.root, manifestPath), JSON.stringify(manifest));
    let findings = await verifyArchivePackage(installed.root, {
      ...input,
      manifestDigest: installed.package.manifestDigest,
    });
    assert.ok(findings.some((finding) => finding.code === "record_duplicated"));
    assert.ok(findings.some((finding) => finding.code === "record_count_mismatch"));
    await writeFile(join(installed.root, manifestPath), original.content);
    const jsonl = installed.package.files.find((file) => file.path.endsWith(".jsonl"))!;
    const lines = jsonl.content.trimEnd().split("\n");
    const changed = JSON.parse(lines[0]!);
    changed.id = "not-collected";
    await writeFile(
      join(installed.root, jsonl.path),
      JSON.stringify(changed) + "\n" + lines[1] + "\n" + lines[1] + "\n",
    );
    findings = await verifyArchivePackage(installed.root, {
      ...input,
      manifestDigest: installed.package.manifestDigest,
    });
    assert.ok(
      findings.some(
        (finding) =>
          finding.code === "record_count_mismatch" &&
          finding.evidence.reason === "canonical_record_identity_mismatch",
      ),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.code === "record_count_mismatch" &&
          finding.evidence.reason === "uncollected_jsonl_record",
      ),
    );
    await writeFile(join(installed.root, jsonl.path), jsonl.content);
    await writeFile(join(installed.root, "index.csv"), '"false count"\r\n');
    assert.ok(
      (
        await verifyArchivePackage(installed.root, {
          ...input,
          manifestDigest: installed.package.manifestDigest,
        })
      ).some(
        (finding) =>
          finding.code === "manifest_digest_mismatch" && finding.subjectId === "index.csv",
      ),
    );
  });

  it("requires local byte-preserved assets with correct digests and sizes, without orphan files or directories", async (t) => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = assetPath(conversation, "hosted_content", "hosted/full-id", sha256);
    assert.equal(path, assetPath(conversation, "hosted_content", "a-different-id", sha256));
    const message = record("with-asset", undefined, {
      body: {
        contentType: "html",
        content:
          '<p><img src="../hostedContents/hosted%2Ffull-id/$value" alt="Original image"></p>',
      },
    });
    message.assets = [
      {
        id: "hosted/full-id",
        sourceKind: "hosted_content",
        name: "image.png",
        sha256,
        size: bytes.length,
        retrievedAt: "2026-02-20T00:00:00Z",
        path,
      },
    ];
    const input = fixture([message]);
    const installed = await install(t, input, new Map([[path, bytes]]));
    assert.deepEqual(
      await verifyArchivePackage(installed.root, {
        ...input,
        manifestDigest: installed.package.manifestDigest,
      }),
      [],
    );
    const rendered = installed.package.files.find((file) => file.path.includes("/parts/"))!;
    assert.ok(
      documentElements(rendered.content).some(
        (element) =>
          element.tagName === "img" &&
          element.attrs.some(
            (attribute) =>
              attribute.name === "src" && attribute.value.startsWith("../assets/hosted/"),
          ),
      ),
    );
    await writeFile(join(installed.root, path), Buffer.from([0, 1, 2, 254]));
    assert.ok(
      (
        await verifyArchivePackage(installed.root, {
          ...input,
          manifestDigest: installed.package.manifestDigest,
        })
      ).some((finding) => finding.code === "asset_digest_mismatch"),
    );
    await rm(join(installed.root, path));
    assert.ok(
      (
        await verifyArchivePackage(installed.root, {
          ...input,
          manifestDigest: installed.package.manifestDigest,
        })
      ).some((finding) => finding.code === "asset_missing"),
    );
    await writeFile(join(installed.root, path), bytes);
    const orphan = `${conversationPath(conversation)}/assets/hosted/orphan`;
    await mkdir(join(installed.root, orphan));
    await writeFile(join(installed.root, orphan, "unreferenced"), bytes);
    const findings = await verifyArchivePackage(installed.root, {
      ...input,
      manifestDigest: installed.package.manifestDigest,
    });
    assert.ok(findings.some((finding) => finding.evidence.reason === "orphan_asset"));
    assert.ok(findings.some((finding) => finding.evidence.reason === "orphan_directory"));
  });

  it("refuses symlink traversal and manifest path traversal without following external files", async (t) => {
    const input = fixture();
    const installed = await install(t, input);
    const outside = await mkdtemp(join(tmpdir(), "migmate-archive-outside-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const sentinel = join(outside, "outside.html");
    await writeFile(sentinel, "untouched outside package");
    const part = installed.package.files.find((file) => file.path.includes("/parts/"))!;
    await rm(join(installed.root, part.path));
    await symlink(sentinel, join(installed.root, part.path));
    const manifestPath = `${conversationPath(conversation)}/manifest.json`;
    const manifest = conversationManifest(installed.package);
    manifest.parts[0]!.jsonl.path = "../../outside.jsonl";
    await writeFile(join(installed.root, manifestPath), JSON.stringify(manifest));
    const findings = await verifyArchivePackage(installed.root, {
      ...input,
      manifestDigest: installed.package.manifestDigest,
    });
    assert.ok(findings.some((finding) => finding.evidence.reason === "unconfined_or_symlink_path"));
    assert.ok(
      findings.some(
        (finding) => finding.evidence.reason === "invalid_or_unconfined_part_descriptor",
      ),
    );
    assert.equal(await readFile(sentinel, "utf8"), "untouched outside package");
  });

  it("keeps an empty package verifiable but never hides absent terminal collection evidence", async (t) => {
    const input = fixture([]);
    const installed = await install(t, input);
    assert.deepEqual(
      await verifyArchivePackage(installed.root, {
        ...input,
        manifestDigest: installed.package.manifestDigest,
      }),
      [],
    );
    assert.ok(
      installed.package.files.every(
        (file) => !file.path.includes("/parts/") && !file.path.endsWith(".jsonl"),
      ),
    );
    const incomplete = fixture([]);
    incomplete.evidence[0]!.complete = false;
    const unfinished = await install(t, incomplete);
    assert.ok(
      unfinished.package.findings.some(
        (finding) => finding.code === "message_collection_incomplete",
      ),
    );
    assert.ok(
      (
        await verifyArchivePackage(unfinished.root, {
          ...incomplete,
          manifestDigest: unfinished.package.manifestDigest,
        })
      ).some((finding) => finding.code === "message_collection_incomplete"),
    );
    assert.ok(
      (
        await verifyArchivePackage(installed.root, { ...input, manifestDigest: "0".repeat(64) })
      ).some((finding) => finding.code === "manifest_digest_mismatch"),
    );
  });

  it("binds meeting transcripts to their organizer's collection scope, not the conversation owner", async (t) => {
    const shared: ArchiveConversation = {
      ...emptyConversation,
      participantScopeIds: ["organizer-scope", "user-scope"],
    };
    const transcript = record("transcript-id", undefined, {
      from: null,
      meetingId: "meeting-id",
      meetingOrganizer: { user: { id: "organizer-id", displayName: "Meeting Organizer" } },
    });
    transcript.route = "transcripts";
    transcript.conversationId = shared.id;
    const input = fixture([transcript]);
    input.plan.config.transcripts = true;
    input.plan.conversations = [conversation, shared];
    input.plan.scopes.push({
      id: "organizer-scope",
      kind: "user-chats",
      userId: "organizer-id",
      conversationIds: [shared.id],
    });
    input.evidence.push(
      {
        scopeEntryId: "user-scope",
        route: "transcripts",
        cursor: null,
        nextLink: null,
        complete: true,
        recordKeys: [],
        findingCodes: [],
      },
      {
        scopeEntryId: "organizer-scope",
        route: "messages",
        cursor: null,
        nextLink: null,
        complete: true,
        recordKeys: [],
        findingCodes: [],
      },
      {
        scopeEntryId: "organizer-scope",
        route: "transcripts",
        cursor: null,
        nextLink: null,
        complete: true,
        recordKeys: [transcript.key],
        findingCodes: [],
      },
    );
    const installed = await install(t, input);
    assert.deepEqual(
      await verifyArchivePackage(installed.root, {
        ...input,
        manifestDigest: installed.package.manifestDigest,
      }),
      [],
    );
    assert.ok(
      !analyzeRecord(transcript, input.plan.timezone).some(
        (finding) => finding.code === "identity_unresolved",
      ),
    );
  });
});
