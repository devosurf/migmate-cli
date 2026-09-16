import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TESTED_NODE, unsupportedNode } from "./versions.ts";

describe("supported Node runtimes", () => {
  it("admits a tested major only from the version carrying the sqlite release candidate", () => {
    // The durable store is node:sqlite. It reaches stability 1.2 in 24.15.0, so
    // 24.14.x is a weaker tier than anything this release has evidence for.
    assert.equal(unsupportedNode("v24.15.0"), null);
    assert.equal(unsupportedNode("24.15.0"), null);
    assert.equal(unsupportedNode("v24.21.0"), null);
    assert.match(unsupportedNode("v24.14.9") ?? "", /below 24\.15\.0/);
    assert.match(unsupportedNode("v24.0.0") ?? "", /below 24\.15\.0/);
  });

  it("refuses an untested major in either direction rather than assuming compatibility", () => {
    // 22 carries node:sqlite at the weaker stability 1.1; 26 is simply unproven
    // here. Both are refused until a cell actually runs against them.
    for (const version of ["v22.13.0", "v22.20.0", "v26.0.0", "v26.4.0"])
      assert.match(unsupportedNode(version) ?? "", /is untested/);
  });

  it("reports a reason for an unreadable version instead of admitting it", () => {
    for (const version of ["", "banana", "vx.y.z"]) assert.notEqual(unsupportedNode(version), null);
  });

  it("names every supported major in the refusal, so the message stays true when the set grows", () => {
    const reason = unsupportedNode("v22.13.0") ?? "";
    for (const major of Object.keys(TESTED_NODE)) assert.ok(reason.includes(major));
  });
});
