import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFailureReport, SmokeFailure } from "../scripts/hosted-render-smoke.mjs";

describe("hosted render smoke failure reports", () => {
  it("builds ok:false reports for ordinary smoke errors", () => {
    const report = buildFailureReport(new Error("source text timed out"));

    assert.equal(report.ok, false);
    assert.equal(report.targetUrl, "https://preview.runt.run/n/topic-viz/topic-viz");
    assert.equal(report.error.name, "Error");
    assert.equal(report.error.message, "source text timed out");
    assert.deepEqual(report.failures, [{ kind: "smoke-error", text: "source text timed out" }]);
  });

  it("preserves structured SmokeFailure entries", () => {
    const failures = [{ kind: "page-text", text: "missing topic heading" }];
    const report = buildFailureReport(new SmokeFailure(failures));

    assert.equal(report.ok, false);
    assert.equal(report.error.name, "SmokeFailure");
    assert.equal(report.failures, failures);
  });
});
