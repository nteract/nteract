import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyResourceTimingSizes,
  classifyPerformanceResource,
  performanceBudgetFailures,
  refinePerformanceResourceKind,
  summarizePerformanceResources,
  summarizeViewerMilestones,
  withTiming,
} from "../scripts/hosted-render-smoke-performance.mjs";
import { summarizeCollabPerformanceTimings } from "../scripts/hosted-collab-smoke-performance.mjs";

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
      classifyPerformanceResource("https://preview.runt.run/n/topic-viz/topic-viz", origins),
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
    const summary = summarizePerformanceResources(
      [
        {
          kind: "catalog_api",
          url: "https://preview.runt.run/api/n/topic-viz",
          start_ms: 1,
          end_ms: 6,
          status: 200,
          contentLength: 128,
        },
        {
          kind: "notebook_snapshot",
          url: "https://preview.runt.run/api/n/topic-viz/snapshots/heads-a",
          start_ms: 5,
          end_ms: 15,
          status: 200,
          contentLength: 2_048,
        },
        {
          kind: "runtime_snapshot",
          url: "https://preview.runt.run/api/n/topic-viz/runtime-snapshots/heads-b",
          start_ms: 6,
          end_ms: 18,
          status: 200,
          contentLength: 1_024,
        },
        {
          kind: "viewer_js",
          url: "https://preview.runt.run/assets/notebook-cloud-viewer.js",
          start_ms: 2,
          end_ms: 12,
          status: 200,
          contentLength: 4_096,
        },
        {
          kind: "runtimed_wasm_binary",
          url: "https://preview.runt.run/renderer-assets/runtimed_wasm_bg.wasm",
          start_ms: 8,
          end_ms: 44,
          status: 200,
          contentLength: 512,
        },
        {
          kind: "arrow_stream_blob",
          url: "https://preview.runt.run/api/n/topic-viz/blobs/arrow",
          start_ms: 24,
          end_ms: 70,
          status: 200,
          contentLength: 8_192,
        },
        {
          kind: "output_document_frame",
          url: "https://preview.runtusercontent.com/frame/",
          start_ms: 10,
          end_ms: 30,
          status: 200,
          contentLength: 768,
        },
        {
          kind: "output_document_frame",
          url: "https://preview.runtusercontent.com/frame/?two",
          start_ms: 20,
          end_ms: 50,
          status: 200,
          contentLength: 1_024,
        },
      ],
      { live_sync_websocket: 11, source_text: 42, rendered_cell_marker: 55, frame_texts: 80 },
    );

    assert.deepEqual(summary.live_path, {
      catalog_api_ms: 6,
      notebook_snapshot_ms: 15,
      runtime_snapshot_ms: 18,
      snapshot_pair_complete_ms: 18,
      snapshot_pair_bytes: 3_072,
      live_sync_websocket_ms: 11,
      source_text_ms: 42,
      rendered_cell_marker_ms: 55,
      first_output_iframe_ms: null,
      frame_texts_ms: 80,
      first_useful_render_ms: 80,
      snapshot_pair_to_rendered_cell_ms: 37,
      snapshot_pair_to_frame_texts_ms: 62,
    });
    assert.deepEqual(summary.sidecar_assets, {
      viewer_shell_complete_ms: 12,
      viewer_shell_bytes: 4_096,
      runtimed_wasm_complete_ms: 44,
      runtimed_wasm_bytes: 512,
      isolated_renderer_complete_ms: null,
      isolated_renderer_bytes: null,
      output_document_complete_ms: 50,
      output_document_bytes: 1_792,
      sift_wasm_complete_ms: null,
      sift_wasm_bytes: null,
      arrow_data_complete_ms: 70,
      arrow_data_bytes: 8_192,
    });
    assert.deepEqual(summary.resources_by_kind.output_document_frame.slowest, [
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
    ]);
    assert.equal(summary.resources_by_kind.output_document_frame.total_bytes, 1_792);
    assert.equal(summary.resources_by_kind.output_document_frame.max_bytes, 1_024);
    assert.equal(summary.resources_by_kind.output_document_frame.unknown_byte_count, 0);
  });

  it("does not summarize byte budgets when any grouped response size is unknown", () => {
    const summary = summarizePerformanceResources([
      {
        kind: "viewer_js",
        url: "https://preview.runt.run/assets/notebook-cloud-viewer.js",
        start_ms: 1,
        end_ms: 2,
        status: 200,
        contentLength: 4_096,
      },
      {
        kind: "viewer_css",
        url: "https://preview.runt.run/assets/notebook-cloud-viewer.css",
        start_ms: 1,
        end_ms: 3,
        status: 200,
      },
    ]);

    assert.equal(summary.resources_by_kind.viewer_css.unknown_byte_count, 1);
    assert.equal(summary.sidecar_assets.viewer_shell_bytes, null);
  });

  it("fills missing response sizes from browser Resource Timing entries", () => {
    const resources = [
      {
        kind: "viewer_js",
        url: "https://preview.runt.run/assets/notebook-cloud-viewer.js",
        contentLength: 123,
      },
      {
        kind: "output_document_frame",
        url: "https://preview.runtusercontent.com/frame/",
        contentLength: null,
      },
      {
        kind: "output_document_frame",
        url: "https://preview.runtusercontent.com/frame/",
        contentLength: null,
      },
      {
        kind: "sift_wasm_binary",
        url: "https://assets.example/sift_wasm.wasm",
        contentLength: null,
      },
      {
        kind: "renderer_asset_js",
        url: "https://assets.example/isolated-renderer.js",
        contentLength: null,
      },
    ];

    applyResourceTimingSizes(resources, [
      {
        name: "https://preview.runt.run/assets/notebook-cloud-viewer.js",
        encodedBodySize: 999,
      },
      {
        name: "https://preview.runtusercontent.com/frame/",
        encodedBodySize: 512,
      },
      {
        name: "https://preview.runtusercontent.com/frame/",
        encodedBodySize: 768,
      },
      {
        name: "https://assets.example/sift_wasm.wasm",
        encodedBodySize: 0,
      },
    ]);

    assert.equal(resources[0].contentLength, 123);
    assert.equal(resources[1].contentLength, 512);
    assert.equal(resources[2].contentLength, 768);
    assert.equal(resources[3].contentLength, null);
    assert.equal(resources[4].contentLength, null);
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

  it("reports explicit hosted performance budget failures", () => {
    const diagnostics = {
      collab_path: {
        collab_anonymous_update_max_ms: 1_250,
      },
      live_path: {
        first_useful_render_ms: 5_025,
        live_sync_websocket_ms: 1_323,
        snapshot_pair_bytes: 4_500,
      },
      sidecar_assets: {
        sift_wasm_complete_ms: 3_025,
        arrow_data_complete_ms: null,
        viewer_shell_bytes: null,
      },
    };

    assert.deepEqual(
      performanceBudgetFailures(diagnostics, {
        first_useful_render_ms: 5_500,
        collab_anonymous_update_max_ms: 1_000,
        live_sync_websocket_ms: null,
        sift_wasm_complete_ms: 3_000,
        arrow_data_complete_ms: 8_000,
        snapshot_pair_bytes: 4_000,
        viewer_shell_bytes: 1_000,
      }),
      [
        {
          kind: "performance-budget",
          metric: "collab_anonymous_update_max_ms",
          text: "editor-to-anonymous viewer update propagation took 1250 ms, expected <= 1000 ms",
          expected_value: 1000,
          actual_value: 1250,
          unit: "ms",
        },
        {
          kind: "performance-budget",
          metric: "sift_wasm_complete_ms",
          text: "Sift WASM took 3025 ms, expected <= 3000 ms",
          expected_value: 3000,
          actual_value: 3025,
          unit: "ms",
        },
        {
          kind: "performance-budget",
          metric: "arrow_data_complete_ms",
          text: "Arrow data timing was missing; expected <= 8000 ms",
          expected_value: 8000,
          actual_value: null,
          unit: "ms",
        },
        {
          kind: "performance-budget",
          metric: "snapshot_pair_bytes",
          text: "snapshot pair payload was 4500 bytes, expected <= 4000 bytes",
          expected_value: 4000,
          actual_value: 4500,
          unit: "bytes",
        },
        {
          kind: "performance-budget",
          metric: "viewer_shell_bytes",
          text: "viewer shell payload size was missing; expected <= 1000 bytes",
          expected_value: 1000,
          actual_value: null,
          unit: "bytes",
        },
      ],
    );
  });

  it("rejects unknown hosted performance budget metrics", () => {
    assert.throws(
      () =>
        performanceBudgetFailures({ live_path: {}, sidecar_assets: {} }, { made_up_metric_ms: 1 }),
      /Unknown performance budget metric: made_up_metric_ms/,
    );
  });

  it("summarizes browser collaboration timings for live viewer budgets", () => {
    assert.deepEqual(
      summarizeCollabPerformanceTimings({
        alice_connected: 110,
        bob_connected: 125,
        anonymous_connected: 180,
        alice_to_bob: 55,
        alice_to_bob_editor: 65,
        alice_to_anonymous: 70,
        bob_to_alice: 45,
        bob_to_alice_editor: 75,
        bob_to_anonymous: 80,
        bob_to_alice_exact: 90,
        bob_to_bob_exact: 60,
        alice_ping_1_alice_exact: 100,
        alice_ping_1_bob_exact: 115,
        alice_ping_1_anonymous: 130,
        overlap_editors_converged: 140,
        overlap_anonymous: 150,
        total: 2_500,
      }),
      {
        collab_path: {
          collab_connected_ms: 180,
          collab_editor_update_max_ms: 115,
          collab_anonymous_update_max_ms: 150,
          collab_editor_convergence_max_ms: 140,
          collab_total_ms: 2500,
        },
      },
    );
  });
});
