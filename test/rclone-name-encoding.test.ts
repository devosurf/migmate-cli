import assert from "node:assert/strict";
import { test } from "node:test";
import {
  googleDestinationName,
  googleSourceName,
  SHAREPOINT_DESTINATION_ENCODING,
  sharepointDestinationName,
  sharepointDestinationNameToStandard,
  sharepointSourceName,
} from "../src/engine/providers/adapters/rclone-name-encoding.ts";

// Golden cases derived from the pinned encoder's Encode/Decode branches, not from
// a second implementation of the algorithm under test.
// https://github.com/rclone/rclone/blob/v1.75.0/lib/encoder/encoder.go
// https://github.com/rclone/rclone/blob/v1.75.0/lib/encoder/standard.go
function googleToSharePoint(nativeName: string): string {
  const standard = googleSourceName(nativeName);
  assert.notEqual(standard, null);
  return sharepointDestinationName(standard!);
}

test("pins every OneDrive default flag without adding unrelated substitutions", () => {
  assert.equal(
    SHAREPOINT_DESTINATION_ENCODING,
    "Slash,LtGt,DoubleQuote,Colon,Question,Asterisk,Pipe,BackSlash,Del,Ctl,LeftSpace,LeftTilde,RightSpace,RightPeriod,InvalidUtf8,Dot",
  );
  assert.equal(googleToSharePoint("#%[];'`$!&.txt"), "#%[];'`$!&.txt");
});

for (const [native, encoded] of [
  ['a/<>":?*|\\z', "a／＜＞＂：？＊｜＼z"],
  ["a／＜＞＂：？＊｜＼z", "a‛／‛＜‛＞‛＂‛：‛？‛＊‛｜‛＼z"],
  ["a\0\x01\x1f\x7fz", "a␀␁␟␡z"],
  ["a␀␁␟␡z", "a␀‛␁‛␟‛␡z"],
  [" leading", "␠leading"],
  ["~leading", "～leading"],
  ["␠leading", "‛␠leading"],
  ["～leading", "‛～leading"],
  ["trailing ", "trailing␠"],
  ["trailing.", "trailing．"],
  ["trailing␠", "trailing‛␠"],
  ["trailing．", "trailing‛．"],
  ["   ", "␠ ␠"],
  [" ", "␠"],
  ["␠", "‛␠"],
  [".", "．"],
  ["..", "．．"],
  ["...", "..．"],
  ["．", "‛．"],
  ["．．", "‛．‛．"],
  ["．inside．period.txt", "．inside．period.txt"],
  ["inside～tilde␠space.txt", "inside～tilde␠space.txt"],
  ["literal‛quote.txt", "literal‛‛quote.txt"],
  ["trailing‛", "trailing‛‛"],
  ["literal‛‛quote.txt", "literal‛‛quote.txt"],
  ["literal‛‛‛quote.txt", "literal‛‛‛‛quote.txt"],
  ["literal‛␀.txt", "literal‛␀.txt"],
  ["literal‛／.txt", "literal‛‛‛／.txt"],
  ["literal‛41.txt", "literalA.txt"],
  ["literal‛2F.txt", "literal／.txt"],
  ["literal‛C3‛A9.txt", "literalé.txt"],
  ["résumé-日本語-😀.txt", "résumé-日本語-😀.txt"],
]) {
  test(`Google to OneDrive encoding ${JSON.stringify(native)}`, () => {
    assert.equal(googleToSharePoint(native!), encoded);
  });
}

test("source names use STANDARD rather than destination or native syntax", () => {
  assert.equal(googleSourceName("literal/slash"), "literal／slash");
  assert.equal(googleSourceName("literal／slash"), "literal‛／slash");
  assert.equal(googleSourceName("a?b"), "a?b");
  assert.equal(googleSourceName("a\x01b"), "a␁b");
  assert.equal(googleSourceName("a␁b"), "a‛␁b");
  assert.equal(googleSourceName("‛EF‛BB‛BFname"), "\ufeffname");
  assert.equal(googleSourceName("‛F0‛9F‛98‛80"), "😀");
  assert.equal(googleSourceName("\ufffd"), "\ufffd");
});

for (const native of ["‛FF", "‛C3", "‛C0‛AF", "‛ED‛A0‛80", "\ud800.txt"]) {
  test(`unrepresentable decoded UTF-8 is explicit for ${JSON.stringify(native)}`, () => {
    assert.equal(googleSourceName(native), null);
  });
}

test("SharePoint sources retain Slash mode and Google destinations retain InvalidUtf8", () => {
  assert.equal(sharepointSourceName("literal／slash"), "literal／slash");
  assert.equal(sharepointSourceName("literal‛／slash"), "literal‛／slash");
  assert.equal(googleDestinationName(sharepointSourceName("literal／slash")), "literal/slash");
  assert.equal(googleDestinationName(sharepointSourceName("literal‛／slash")), "literal／slash");
  assert.equal(googleDestinationName(sharepointSourceName("literal␁control")), "literal␁control");
  assert.equal(googleDestinationName(sharepointSourceName("what?.txt")), "what?.txt");
});

test("destination listings decode the full OneDrive encoding, not source Slash mode", () => {
  assert.equal(sharepointDestinationNameToStandard("what？.txt"), "what?.txt");
  assert.equal(sharepointSourceName("what？.txt"), "what？.txt");
  assert.equal(sharepointDestinationNameToStandard("what‛？.txt"), "what？.txt");
  assert.equal(sharepointDestinationNameToStandard("literal／slash"), "literal／slash");
  assert.equal(sharepointDestinationNameToStandard("literal‛／slash"), "literal‛／slash");
  assert.equal(sharepointDestinationNameToStandard("␠leading"), " leading");
  assert.equal(sharepointDestinationNameToStandard("‛␠leading"), "␠leading");
  assert.equal(sharepointDestinationNameToStandard("～leading"), "~leading");
  assert.equal(sharepointDestinationNameToStandard("‛～leading"), "～leading");
  assert.equal(sharepointDestinationNameToStandard("trailing␠"), "trailing ");
  assert.equal(sharepointDestinationNameToStandard("trailing‛␠"), "trailing␠");
  assert.equal(sharepointDestinationNameToStandard("trailing．"), "trailing.");
  assert.equal(sharepointDestinationNameToStandard("trailing‛．"), "trailing．");
  assert.equal(sharepointDestinationNameToStandard("␠ ␠"), "   ");
  assert.equal(sharepointDestinationNameToStandard("‛␠"), "␠");
  assert.equal(sharepointDestinationNameToStandard("a‛‛．"), "a‛‛．");
  assert.equal(sharepointDestinationNameToStandard("a␁␡z"), "a␁␡z");
  assert.equal(sharepointDestinationNameToStandard("a‛␁‛␡z"), "a‛␁‛␡z");
  assert.equal(sharepointDestinationNameToStandard("‛C3‛A9"), "é");
});

test("destination addressing round-trips canonical encoded native basenames", () => {
  for (const name of [
    'a/<>" :?*|\\z',
    "a／＜＞＂：？＊｜＼z",
    " leading.",
    "~leading ",
    "␠literal．",
    "～literal␠",
    ".",
    "..",
    "．",
    "．．",
    "literal‛quote",
    "literal‛‛quote",
    "\0\x01\x1f\x7f",
    "␀␁␟␡",
    "résumé-😀.txt",
  ]) {
    const standard = googleSourceName(name);
    assert.notEqual(standard, null);
    const native = sharepointDestinationName(standard!);
    assert.equal(sharepointDestinationNameToStandard(native), standard);
  }
});

test("destination decoding refuses unrepresentable UTF-8 instead of lossy root addressing", () => {
  for (const name of ["‛FF", "‛C3", "‛C0‛AF", "‛ED‛A0‛80", "\ud800.txt"]) {
    assert.equal(sharepointDestinationNameToStandard(name), null);
  }
});
