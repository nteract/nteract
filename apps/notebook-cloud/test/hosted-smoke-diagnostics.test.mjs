import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  consoleMessageLevel,
  isolatedDiagnosticFailure,
  isFatalIsolatedDiagnostic,
  matchesSiftLoadMilestone,
  parseIsolatedDiagnosticText,
  siftLoadMilestoneTimingName,
} from "../scripts/hosted-render-smoke-diagnostics.mjs";

describe("hosted render smoke diagnostics", () => {
  it("parses isolated renderer diagnostic console messages", () => {
    assert.deepEqual(
      parseIsolatedDiagnosticText("[isolated-renderer] renderer-plugin-install-failed Object"),
      {
        source: "isolated-renderer",
        phase: "renderer-plugin-install-failed",
      },
    );
    assert.equal(parseIsolatedDiagnosticText("[sift-renderer] render Object"), null);
  });

  it("treats renderer install failures as fatal smoke diagnostics", () => {
    const diagnostic = {
      source: "isolated-renderer",
      phase: "renderer-plugin-install-failed",
      level: "debug",
      text: "[isolated-renderer] renderer-plugin-install-failed Object",
      details: { message: "subscribeHostContext is not a function" },
    };

    assert.equal(isFatalIsolatedDiagnostic(diagnostic), true);
    assert.deepEqual(isolatedDiagnosticFailure(diagnostic), {
      kind: "isolated-diagnostic",
      source: "isolated-renderer",
      phase: "renderer-plugin-install-failed",
      level: "debug",
      text: "subscribeHostContext is not a function",
      details: { message: "subscribeHostContext is not a function" },
    });
  });

  it("maps Playwright console message types to diagnostic levels", () => {
    assert.equal(consoleMessageLevel("error"), "error");
    assert.equal(consoleMessageLevel("warning"), "warn");
    assert.equal(consoleMessageLevel("info"), "info");
    assert.equal(consoleMessageLevel("log"), "debug");
  });

  it("matches Sift load milestones from parsed console details", () => {
    const diagnostic = {
      source: "isolated-renderer",
      phase: "sift-load-milestone",
      level: "debug",
      text: "[isolated-renderer] sift-load-milestone Object",
      details: {
        source: "arrow-stream-manifest",
        phase: "engine-mounted",
      },
    };

    assert.equal(matchesSiftLoadMilestone(diagnostic, { phase: "engine-mounted" }), true);
    assert.equal(matchesSiftLoadMilestone(diagnostic, { phase: "streaming-complete" }), false);
    assert.equal(
      matchesSiftLoadMilestone(diagnostic, { source: "url", phase: "engine-mounted" }),
      false,
    );
    assert.equal(siftLoadMilestoneTimingName("engine-mounted"), "sift_engine_mounted");
    assert.equal(siftLoadMilestoneTimingName("first chunk fetched"), "sift_first_chunk_fetched");
  });
});
