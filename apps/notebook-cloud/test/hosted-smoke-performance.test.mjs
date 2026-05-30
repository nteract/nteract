import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyPerformanceResource,
  refinePerformanceResourceKind,
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
            kind: "catalog_api",
            url: "https://preview.runt.run/api/n/topic-viz",
            start_ms: 1,
            end_ms: 6,
            status: 200,
          },
          {
            kind: "notebook_snapshot",
            url: "https://preview.runt.run/api/n/topic-viz/snapshots/heads-a",
            start_ms: 5,
            end_ms: 15,
            status: 200,
          },
          {
            kind: "runtime_snapshot",
            url: "https://preview.runt.run/api/n/topic-viz/runtime-snapshots/heads-b",
            start_ms: 6,
            end_ms: 18,
            status: 200,
          },
          {
            kind: "viewer_js",
            url: "https://preview.runt.run/assets/notebook-cloud-viewer.js",
            start_ms: 2,
            end_ms: 12,
            status: 200,
          },
          {
            kind: "runtimed_wasm_binary",
            url: "https://preview.runt.run/renderer-assets/runtimed_wasm_bg.wasm",
            start_ms: 8,
            end_ms: 44,
            status: 200,
          },
          {
            kind: "arrow_stream_blob",
            url: "https://preview.runt.run/api/n/topic-viz/blobs/arrow",
            start_ms: 24,
            end_ms: 70,
            status: 200,
          },
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
        { live_sync_websocket: 11, source_text: 42, rendered_cell_marker: 55, frame_texts: 80 },
      ),
      {
        milestones: {
          live_sync_websocket: 11,
          source_text: 42,
          rendered_cell_marker: 55,
          frame_texts: 80,
        },
        live_path: {
          catalog_api_ms: 6,
          notebook_snapshot_ms: 15,
          runtime_snapshot_ms: 18,
          snapshot_pair_complete_ms: 18,
          live_sync_websocket_ms: 11,
          source_text_ms: 42,
          rendered_cell_marker_ms: 55,
          first_output_iframe_ms: null,
          frame_texts_ms: 80,
          first_useful_render_ms: 80,
          snapshot_pair_to_rendered_cell_ms: 37,
          snapshot_pair_to_frame_texts_ms: 62,
        },
        sidecar_assets: {
          viewer_shell_complete_ms: 12,
          runtimed_wasm_complete_ms: 44,
          isolated_renderer_complete_ms: null,
          output_document_complete_ms: 50,
          sift_wasm_complete_ms: null,
          arrow_data_complete_ms: 70,
        },
        resources_by_kind: {
          catalog_api: {
            count: 1,
            first_start_ms: 1,
            first_end_ms: 6,
            max_end_ms: 6,
            max_duration_ms: 5,
            statuses: [200],
            urls: ["https://preview.runt.run/api/n/topic-viz"],
            slowest: [
              {
                url: "https://preview.runt.run/api/n/topic-viz",
                start_ms: 1,
                end_ms: 6,
                duration_ms: 5,
                status: 200,
                failure: null,
              },
            ],
          },
          notebook_snapshot: {
            count: 1,
            first_start_ms: 5,
            first_end_ms: 15,
            max_end_ms: 15,
            max_duration_ms: 10,
            statuses: [200],
            urls: ["https://preview.runt.run/api/n/topic-viz/snapshots/heads-a"],
            slowest: [
              {
                url: "https://preview.runt.run/api/n/topic-viz/snapshots/heads-a",
                start_ms: 5,
                end_ms: 15,
                duration_ms: 10,
                status: 200,
                failure: null,
              },
            ],
          },
          runtime_snapshot: {
            count: 1,
            first_start_ms: 6,
            first_end_ms: 18,
            max_end_ms: 18,
            max_duration_ms: 12,
            statuses: [200],
            urls: ["https://preview.runt.run/api/n/topic-viz/runtime-snapshots/heads-b"],
            slowest: [
              {
                url: "https://preview.runt.run/api/n/topic-viz/runtime-snapshots/heads-b",
                start_ms: 6,
                end_ms: 18,
                duration_ms: 12,
                status: 200,
                failure: null,
              },
            ],
          },
          viewer_js: {
            count: 1,
            first_start_ms: 2,
            first_end_ms: 12,
            max_end_ms: 12,
            max_duration_ms: 10,
            statuses: [200],
            urls: ["https://preview.runt.run/assets/notebook-cloud-viewer.js"],
            slowest: [
              {
                url: "https://preview.runt.run/assets/notebook-cloud-viewer.js",
                start_ms: 2,
                end_ms: 12,
                duration_ms: 10,
                status: 200,
                failure: null,
              },
            ],
          },
          runtimed_wasm_binary: {
            count: 1,
            first_start_ms: 8,
            first_end_ms: 44,
            max_end_ms: 44,
            max_duration_ms: 36,
            statuses: [200],
            urls: ["https://preview.runt.run/renderer-assets/runtimed_wasm_bg.wasm"],
            slowest: [
              {
                url: "https://preview.runt.run/renderer-assets/runtimed_wasm_bg.wasm",
                start_ms: 8,
                end_ms: 44,
                duration_ms: 36,
                status: 200,
                failure: null,
              },
            ],
          },
          arrow_stream_blob: {
            count: 1,
            first_start_ms: 24,
            first_end_ms: 70,
            max_end_ms: 70,
            max_duration_ms: 46,
            statuses: [200],
            urls: ["https://preview.runt.run/api/n/topic-viz/blobs/arrow"],
            slowest: [
              {
                url: "https://preview.runt.run/api/n/topic-viz/blobs/arrow",
                start_ms: 24,
                end_ms: 70,
                duration_ms: 46,
                status: 200,
                failure: null,
              },
            ],
          },
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
});
