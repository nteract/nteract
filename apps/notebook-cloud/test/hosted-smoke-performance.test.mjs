import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyPerformanceResource,
  summarizePerformanceResources,
  withTiming,
} from "../scripts/hosted-render-smoke-performance.mjs";

describe("hosted smoke performance diagnostics", () => {
  const origins = {
    targetOrigin: "https://preview.runt.run",
    rendererAssetOrigin: "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev",
    outputDocumentOrigin: "https://preview.runtusercontent.com",
  };

  it("classifies hosted notebook resources by load-path role", () => {
    assert.equal(
      classifyPerformanceResource("https://preview.runt.run/api/n/topic-viz", origins),
      "catalog_api",
    );
    assert.equal(
      classifyPerformanceResource(
        "https://preview.runt.run/api/n/topic-viz/snapshots/heads-a",
        origins,
      ),
      "notebook_snapshot",
    );
    assert.equal(
      classifyPerformanceResource(
        "https://preview.runt.run/api/n/topic-viz/runtime-snapshots/heads-b",
        origins,
      ),
      "runtime_snapshot",
    );
    assert.equal(
      classifyPerformanceResource("https://preview.runt.run/n/topic-viz", origins),
      "viewer_document",
    );
    assert.equal(
      classifyPerformanceResource(
        "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev/renderer-assets/runtimed_wasm_bg.wasm",
        origins,
      ),
      "runtimed_wasm_binary",
    );
    assert.equal(
      classifyPerformanceResource(
        "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev/renderer-assets/sift_wasm.wasm?v=abc",
        origins,
      ),
      "sift_wasm_binary",
    );
    assert.equal(
      classifyPerformanceResource(
        "https://preview.runtusercontent.com/frame/?nteract_theme=light",
        origins,
      ),
      "output_document_frame",
    );
  });

  it("summarizes first and latest timings by resource kind", () => {
    assert.deepEqual(
      summarizePerformanceResources(
        [
          {
            kind: "output_document_frame",
            url: "https://preview.runtusercontent.com/frame/",
            start_ms: 10,
            end_ms: 30,
            status: 200,
          },
          {
            kind: "output_document_frame",
            url: "https://preview.runtusercontent.com/frame/?two",
            start_ms: 20,
            end_ms: 50,
            status: 200,
          },
        ],
        { source_text: 42 },
      ),
      {
        milestones: { source_text: 42 },
        resources_by_kind: {
          output_document_frame: {
            count: 2,
            first_start_ms: 10,
            first_end_ms: 30,
            max_end_ms: 50,
            statuses: [200, 200],
            urls: [
              "https://preview.runtusercontent.com/frame/",
              "https://preview.runtusercontent.com/frame/?two",
            ],
          },
        },
      },
    );
  });

  it("attaches stable preflight timing without crashing on null checks", () => {
    assert.equal(withTiming(null, 10, 20), null);
    assert.deepEqual(withTiming({ status: 200 }, 10, 20), {
      status: 200,
      timing_ms: { start: 10, end: 20, duration: 10 },
    });
  });
});
