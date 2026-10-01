import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unsupportedNode } from "./versions.ts";

describe("supported Node runtimes", () => {
  it("admits Node from the version carrying the sqlite release candidate", () => {
    // The durable store is node:sqlite. It reaches stability 1.2 in 24.15.0, so
    // 24.14.x is a weaker tier than anything this release has evidence for.
    assert.equal(unsupportedNode("v24.15.0"), null);
    assert.equal(unsupportedNode("24.15.0"), null);
    assert.equal(unsupportedNode("v24.21.0"), null);
    assert.match(unsupportedNode("v24.14.9") ?? "", /below 24\.15\.0/);
    assert.match(unsupportedNode("v24.0.0") ?? "", /below 24\.15\.0/);
  });

  it("admits every later major and refuses every earlier one", () => {
    for (const version of ["v25.0.0", "v26.0.0", "v26.4.0", "v30.1.2"])
      assert.equal(unsupportedNode(version), null);
    for (const version of ["v22.13.0", "v22.20.0", "v23.11.0"])
      assert.match(unsupportedNode(version) ?? "", /below 24\.15\.0.*24\.15\.0 or later/);
  });

  it("reports a reason for an unreadable version instead of admitting it", () => {
    for (const version of ["", "banana", "vx.y.z"]) assert.notEqual(unsupportedNode(version), null);
  });
});
