import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyPerformanceResource,
  refinePerformanceResourceKind,
  summarizePerformanceResources,
  summarizeViewerMilestones,
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
      classifyPerformanceResource(
        "https://preview.runt.run/api/n/topic-viz/blobs/sha256-abc",
        origins,
      ),
      "notebook_blob",
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
        "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev/renderer-assets/isolated-renderer.js",
        origins,
      ),
      "renderer_asset_js",
    );
    assert.equal(
      classifyPerformanceResource(
        "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev/renderer-assets/isolated-renderer.css",
        origins,
      ),
      "renderer_asset_css",
    );
    assert.equal(
      classifyPerformanceResource(
        "https://preview.runt.run/renderer-assets/isolated-renderer.js",
        origins,
      ),
      "renderer_asset_js",
    );
    assert.equal(
      classifyPerformanceResource(
        "https://preview.runtusercontent.com/frame/?nteract_theme=light",
        origins,
      ),
      "output_document_frame",
    );
    assert.equal(
      classifyPerformanceResource("https://preview.runtusercontent.com/assets/frame.js", origins),
      "output_document_js",
    );
    assert.equal(
      classifyPerformanceResource("https://preview.runtusercontent.com/assets/frame.css", origins),
      "output_document_css",
    );
  });

  it("refines notebook blobs by response content type", () => {
    assert.deepEqual(
      refinePerformanceResourceKind({
        kind: "notebook_blob",
        url: "https://preview.runt.run/api/n/topic-viz/blobs/arrow",
        contentType: "application/vnd.apache.arrow.stream",
      }),
      {
        kind: "arrow_stream_blob",
        url: "https://preview.runt.run/api/n/topic-viz/blobs/arrow",
        contentType: "application/vnd.apache.arrow.stream",
      },
    );
    assert.deepEqual(
      refinePerformanceResourceKind({
        kind: "notebook_blob",
        url: "https://preview.runt.run/api/n/topic-viz/blobs/manifest",
        contentType: "application/vnd.nteract.arrow-stream-manifest+json",
      }),
      {
        kind: "arrow_manifest_blob",
        url: "https://preview.runt.run/api/n/topic-viz/blobs/manifest",
        contentType: "application/vnd.nteract.arrow-stream-manifest+json",
      },
    );
    assert.equal(
      refinePerformanceResourceKind({ kind: "notebook_blob", contentType: "text/plain" }).kind,
      "notebook_blob",
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
            max_duration_ms: 30,
            statuses: [200, 200],
            urls: [
              "https://preview.runtusercontent.com/frame/",
              "https://preview.runtusercontent.com/frame/?two",
            ],
            slowest: [
              {
                url: "https://preview.runtusercontent.com/frame/?two",
                start_ms: 20,
                end_ms: 50,
                duration_ms: 30,
                status: 200,
                failure: null,
              },
              {
                url: "https://preview.runtusercontent.com/frame/",
                start_ms: 10,
                end_ms: 30,
                duration_ms: 20,
                status: 200,
                failure: null,
              },
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

  it("summarizes viewer load marks by milestone name", () => {
    assert.deepEqual(
      summarizeViewerMilestones([
        { name: "nteract:notebook-cloud:viewer-start", startTime: 3.4 },
        { name: "nteract:notebook-cloud:live-room-ready", startTime: 24.6 },
        { name: "nteract:notebook-cloud:live-room-ready", startTime: 99 },
        { name: "other:mark", startTime: 12 },
        { name: "nteract:notebook-cloud:snapshot-ready", startTime: Number.NaN },
      ]),
      {
        viewer_start: 3,
        live_room_ready: 25,
      },
    );
  });
});
