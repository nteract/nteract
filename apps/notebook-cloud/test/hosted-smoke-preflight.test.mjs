import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasPreflightFailures } from "../scripts/hosted-render-smoke-preflight.mjs";

describe("hosted render smoke preflight", () => {
  it("fails fast for route-level render, catalog API, and viewer CSS failures", () => {
    assert.equal(hasPreflightFailures([{ kind: "render-api" }]), true);
    assert.equal(hasPreflightFailures([{ kind: "catalog-api" }]), true);
    assert.equal(hasPreflightFailures([{ kind: "viewer-css" }]), true);
  });

  it("does not treat later browser-render failures as preflight failures", () => {
    assert.equal(hasPreflightFailures([{ kind: "console-error" }]), false);
    assert.equal(hasPreflightFailures([{ kind: "sift-wasm" }]), false);
    assert.equal(hasPreflightFailures([]), false);
  });
});
