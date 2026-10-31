import assert from "node:assert/strict";
import { it } from "node:test";
import { parseListingJson } from "./listing-json.ts";

async function* chunks(text: string, size = 1): AsyncIterable<Uint8Array> {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}

it("parses arbitrary byte boundaries, UTF-8, escapes, nested values and ignored fields", async () => {
  const entries = [
    { Path: 'é/日本/😀\\"\n', Size: 1, extra: [true, null, { x: -1.2e3 }] },
    { Path: "é", Size: 0 },
  ];
  const json = JSON.stringify({ before: { ignored: [1, 2, 3] }, list: entries, after: "ok" });
  for (const size of [1, 2, 3, 7, 4096]) {
    const received: unknown[] = [];
    await parseListingJson(chunks(json, size), "list", (value) => received.push(value));
    assert.deepEqual(received, entries);
  }
});

it("emits complete records before the response finishes", async () => {
  const received: unknown[] = [];
  async function* response() {
    yield Buffer.from('{"list":[{"Path":"one","Size":1},');
    assert.deepEqual(received, [{ Path: "one", Size: 1 }]);
    yield Buffer.from('{"Path":"two","Size":2}]}');
  }
  await parseListingJson(response(), "list", (value) => received.push(value));
  assert.equal(received.length, 2);
});

it("streams hash lines without changing whitespace or escaped path contents", async () => {
  const expected = ["ABCD  a\nb", "  no hash", "deadbeef  é/😀", "  "];
  const received: unknown[] = [];
  await parseListingJson(chunks(JSON.stringify({ hashsum: expected })), "hashsum", (value) =>
    received.push(value),
  );
  assert.deepEqual(received, expected);
});

it("rejects malformed, truncated, ambiguous and non-object responses", async () => {
  for (const json of [
    "",
    "[]",
    "null",
    "{}",
    '{"list":null}',
    '{"list":{}}',
    '{"list":[}',
    '{"list":[1,]}',
    '{"list":[,1]}',
    '{"list":[1 2]}',
    '{"list":[01]}',
    '{"list":[truefalse]}',
    '{"list":[NaN]}',
    '{"list":["\\q"]}',
    '{"list":["raw\nnewline"]}',
    '{"list":["unterminated]}',
    '{"list":[{"Path":"a"}]',
    '{"list":[]}{"list":[]}',
    '{"list":[],}',
    '{"list":[],"list":[]}',
    '{"list":[],"other":[1,]}',
    '{"list":[],"other":{"x" 1}}',
    '{"list":[] trailing}',
    '{"list":[]}x',
  ]) {
    await assert.rejects(
      parseListingJson(chunks(json), "list", () => {}),
      SyntaxError,
      json,
    );
  }
});

it("rejects invalid and truncated UTF-8 instead of changing path identities", async () => {
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xf0, 0x9f])]) {
    async function* response() {
      yield Buffer.from('{"list":["');
      yield bytes;
    }
    await assert.rejects(parseListingJson(response(), "list", () => {}));
  }
});

it("propagates stream and consumer failures without retaining a partial result", async () => {
  const error = new Error("interrupted");
  async function* broken() {
    yield Buffer.from('{"list":[1,');
    throw error;
  }
  await assert.rejects(
    parseListingJson(broken(), "list", () => {}),
    (actual) => actual === error,
  );
  await assert.rejects(
    parseListingJson(chunks('{"list":[1]}'), "list", () => {
      throw error;
    }),
    (actual) => actual === error,
  );
});
