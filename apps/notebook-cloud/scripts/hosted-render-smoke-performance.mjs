export function classifyPerformanceResource(
  url,
  {
    targetOrigin,
    rendererAssetOrigin = null,
    runtimeWasmOrigin = null,
    outputDocumentOrigin = null,
  } = {},
) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (targetOrigin && parsed.origin === targetOrigin) {
    if (/^\/api\/n\/[^/]+\/?$/.test(parsed.pathname)) {
      return "catalog_api";
    }
    if (/^\/api\/n\/[^/]+\/snapshots\/[^/]+\/?$/.test(parsed.pathname)) {
      return "notebook_snapshot";
    }
    if (/^\/api\/n\/[^/]+\/runtime-snapshots\/[^/]+\/?$/.test(parsed.pathname)) {
      return "runtime_snapshot";
    }
    if (/^\/api\/n\/[^/]+\/blobs\/[^/]+\/?$/.test(parsed.pathname)) {
      return "notebook_blob";
    }
    if (/^\/n\/[^/]+(?:\/[^/]+|\/r\/[^/]+)?\/?$/.test(parsed.pathname)) {
      return "viewer_document";
    }
    if (parsed.pathname === "/assets/notebook-cloud-viewer.js") {
      return "viewer_js";
    }
    if (parsed.pathname === "/assets/notebook-cloud-viewer.css") {
      return "viewer_css";
    }
  }

  const isRendererAsset = rendererAssetOrigin && parsed.origin === rendererAssetOrigin;
  const isTargetRendererAsset =
    targetOrigin &&
    parsed.origin === targetOrigin &&
    parsed.pathname.startsWith("/renderer-assets/");
  const isTargetRuntimeWasmAsset =
    targetOrigin && parsed.origin === targetOrigin && parsed.pathname.startsWith("/assets/");
  const isRuntimeWasmAsset =
    isTargetRuntimeWasmAsset ||
    (runtimeWasmOrigin && parsed.origin === runtimeWasmOrigin) ||
    isRendererAsset ||
    isTargetRendererAsset;
  if (isRuntimeWasmAsset) {
    if (runtimeWasmPathnameMatches(parsed.pathname, "js")) {
      return "runtimed_wasm_js";
    }
    if (runtimeWasmPathnameMatches(parsed.pathname, "wasm")) {
      return "runtimed_wasm_binary";
    }
  }
  if (isRendererAsset || isTargetRendererAsset) {
    if (parsed.pathname.endsWith("/sift_wasm.wasm")) {
      return "sift_wasm_binary";
    }
    if (parsed.pathname.endsWith(".js")) {
      return "renderer_asset_js";
    }
    if (parsed.pathname.endsWith(".css")) {
      return "renderer_asset_css";
    }
  }

  if (outputDocumentOrigin && parsed.origin === outputDocumentOrigin) {
    if (parsed.pathname.startsWith("/frame/")) {
      return "output_document_frame";
    }
    if (parsed.pathname.endsWith(".js")) {
      return "output_document_js";
    }
    if (parsed.pathname.endsWith(".css")) {
      return "output_document_css";
    }
    return "output_document_asset";
  }

  return null;
}

function runtimeWasmPathnameMatches(pathname, extension) {
  const name = pathname.split("/").pop() ?? "";
  if (extension === "js") {
    return /^runtimed_wasm(?:\.[a-f0-9]{12,64})?\.js$/.test(name);
  }
  return /^runtimed_wasm_bg(?:\.[a-f0-9]{12,64})?\.wasm$/.test(name);
}

export function refinePerformanceResourceKind(resource) {
  if (resource.kind !== "notebook_blob") {
    return resource;
  }
  const contentType = resource.contentType ?? "";
  if (contentType.includes("application/vnd.apache.arrow.stream")) {
    return { ...resource, kind: "arrow_stream_blob" };
  }
  if (contentType.includes("application/vnd.nteract.arrow-stream-manifest+json")) {
    return { ...resource, kind: "arrow_manifest_blob" };
  }
  return resource;
}

export function summarizePerformanceResources(resources, milestones = {}) {
  const byKind = {};

  for (const resource of resources) {
    const summary = (byKind[resource.kind] ??= {
      count: 0,
      first_start_ms: null,
      first_end_ms: null,
      max_end_ms: null,
      max_duration_ms: null,
      total_bytes: 0,
      max_bytes: null,
      unknown_byte_count: 0,
      statuses: [],
      urls: [],
      slowest: [],
    });
    summary.count += 1;
    summary.first_start_ms = minDefined(summary.first_start_ms, resource.start_ms);
    summary.first_end_ms = minDefined(summary.first_end_ms, resource.end_ms);
    summary.max_end_ms = maxDefined(summary.max_end_ms, resource.end_ms);
    const duration = resourceDuration(resource);
    summary.max_duration_ms = maxDefined(summary.max_duration_ms, duration);
    if (typeof resource.contentLength === "number") {
      summary.total_bytes += resource.contentLength;
      summary.max_bytes = maxDefined(summary.max_bytes, resource.contentLength);
    } else {
      summary.unknown_byte_count += 1;
    }
    if (resource.status !== null && resource.status !== undefined) {
      summary.statuses.push(resource.status);
    }
    if (summary.urls.length < 5 && !summary.urls.includes(resource.url)) {
      summary.urls.push(resource.url);
    }
    if (duration !== null) {
      trackSlowResource(summary.slowest, resource, duration);
    }
  }

  return {
    milestones,
    live_path: summarizeLivePath(byKind, milestones),
    sidecar_assets: summarizeSidecarAssets(byKind),
    resources_by_kind: byKind,
  };
}

export const VIEWER_MILESTONE_PREFIX = "nteract:notebook-cloud:";

export function summarizeViewerMilestones(entries) {
  const milestones = {};

  for (const entry of entries ?? []) {
    if (!entry || typeof entry.name !== "string") {
      continue;
    }
    if (!entry.name.startsWith(VIEWER_MILESTONE_PREFIX)) {
      continue;
    }

    const name = entry.name
      .slice(VIEWER_MILESTONE_PREFIX.length)
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
    if (!name) {
      continue;
    }

    const startTime = Number(entry.startTime);
    if (!Number.isFinite(startTime)) {
      continue;
    }

    milestones[name] ??= Math.round(startTime);
  }

  return milestones;
}

export function performanceBudgetFailures(diagnostics, budgets = {}) {
  const failures = [];
  for (const [metric, budget] of Object.entries(budgets)) {
    if (budget === null || budget === undefined) {
      continue;
    }
    const spec = PERFORMANCE_BUDGET_METRICS[metric];
    if (!spec) {
      throw new Error(`Unknown performance budget metric: ${metric}`);
    }
    const value = diagnostics?.[spec.group]?.[metric] ?? null;
    if (value === null) {
      const unit = budgetUnit(spec);
      failures.push({
        kind: "performance-budget",
        metric,
        text: `${spec.label} ${missingBudgetNoun(spec)} was missing; expected <= ${budget} ${budgetUnit(spec)}`,
        expected_value: budget,
        actual_value: null,
        unit,
      });
      continue;
    }
    if (value > budget) {
      const unit = budgetUnit(spec);
      failures.push({
        kind: "performance-budget",
        metric,
        text: `${spec.label} ${budgetVerb(spec)} ${value} ${budgetUnit(spec)}, expected <= ${budget} ${budgetUnit(spec)}`,
        expected_value: budget,
        actual_value: value,
        unit,
      });
    }
  }
  return failures;
}

export function withTiming(result, started, ended) {
  if (!result) {
    return result;
  }
  return {
    ...result,
    timing_ms: {
      start: started,
      end: ended,
      duration: ended - started,
    },
  };
}

export function applyResourceTimingSizes(resources, resourceTimings) {
  const timingsByUrl = new Map();
  for (const timing of resourceTimings) {
    const encodedBodySize =
      typeof timing.encodedBodySize === "number" && timing.encodedBodySize > 0
        ? timing.encodedBodySize
        : null;
    if (encodedBodySize === null) {
      continue;
    }
    const timings = timingsByUrl.get(timing.name) ?? [];
    timings.push(encodedBodySize);
    timingsByUrl.set(timing.name, timings);
  }
  for (const resource of resources) {
    if (typeof resource.contentLength === "number") {
      continue;
    }
    // Playwright response events and browser Resource Timing entries arrive in
    // fetch order for this smoke page, so duplicate URLs consume timing entries
    // FIFO. Keep the original response header size when it exists.
    const timings = timingsByUrl.get(resource.url);
    const encodedBodySize = timings?.shift();
    if (encodedBodySize !== undefined) {
      resource.contentLength = encodedBodySize;
    }
  }
}

function minDefined(current, candidate) {
  if (candidate === null || candidate === undefined) return current;
  if (current === null || current === undefined) return candidate;
  return Math.min(current, candidate);
}

function maxDefined(current, candidate) {
  if (candidate === null || candidate === undefined) return current;
  if (current === null || current === undefined) return candidate;
  return Math.max(current, candidate);
}

function resourceDuration(resource) {
  if (resource.start_ms === null || resource.start_ms === undefined) return null;
  if (resource.end_ms === null || resource.end_ms === undefined) return null;
  return resource.end_ms - resource.start_ms;
}

function trackSlowResource(slowest, resource, duration) {
  slowest.push({
    url: resource.url,
    start_ms: resource.start_ms,
    end_ms: resource.end_ms,
    duration_ms: duration,
    status: resource.status ?? null,
    failure: resource.failure ?? null,
  });
  slowest.sort((a, b) => b.duration_ms - a.duration_ms || a.start_ms - b.start_ms);
  slowest.splice(5);
}

function summarizeLivePath(byKind, milestones) {
  const notebookSnapshotEndMs = kindFirstEnd(byKind, "notebook_snapshot");
  const runtimeSnapshotEndMs = kindFirstEnd(byKind, "runtime_snapshot");
  const snapshotPairCompleteMs = maxDefined(notebookSnapshotEndMs, runtimeSnapshotEndMs);
  const renderedCellMarkerMs = timing(milestones, "rendered_cell_marker");
  const frameTextsMs = timing(milestones, "frame_texts");

  return {
    catalog_api_ms: kindFirstEnd(byKind, "catalog_api"),
    notebook_snapshot_ms: notebookSnapshotEndMs,
    runtime_snapshot_ms: runtimeSnapshotEndMs,
    snapshot_pair_complete_ms: snapshotPairCompleteMs,
    snapshot_pair_bytes: sumBytesOfKinds(byKind, ["notebook_snapshot", "runtime_snapshot"]),
    live_sync_websocket_ms: timing(milestones, "live_sync_websocket"),
    source_text_ms: timing(milestones, "source_text"),
    rendered_cell_marker_ms: renderedCellMarkerMs,
    first_output_iframe_ms: timing(milestones, "first_output_iframe"),
    frame_texts_ms: frameTextsMs,
    first_useful_render_ms: firstDefined(
      frameTextsMs,
      renderedCellMarkerMs,
      timing(milestones, "source_text"),
    ),
    snapshot_pair_to_rendered_cell_ms: delta(snapshotPairCompleteMs, renderedCellMarkerMs),
    snapshot_pair_to_frame_texts_ms: delta(snapshotPairCompleteMs, frameTextsMs),
  };
}

function summarizeSidecarAssets(byKind) {
  return {
    viewer_shell_complete_ms: maxOfKinds(byKind, ["viewer_document", "viewer_js", "viewer_css"]),
    viewer_shell_bytes: sumBytesOfKinds(byKind, ["viewer_js", "viewer_css"]),
    runtimed_wasm_complete_ms: maxOfKinds(byKind, ["runtimed_wasm_js", "runtimed_wasm_binary"]),
    runtimed_wasm_bytes: sumBytesOfKinds(byKind, ["runtimed_wasm_js", "runtimed_wasm_binary"]),
    isolated_renderer_complete_ms: maxOfKinds(byKind, ["renderer_asset_js", "renderer_asset_css"]),
    isolated_renderer_bytes: sumBytesOfKinds(byKind, ["renderer_asset_js", "renderer_asset_css"]),
    output_document_complete_ms: maxOfKinds(byKind, [
      "output_document_frame",
      "output_document_js",
      "output_document_css",
      "output_document_asset",
    ]),
    output_document_bytes: sumBytesOfKinds(byKind, [
      "output_document_frame",
      "output_document_js",
      "output_document_css",
      "output_document_asset",
    ]),
    sift_wasm_complete_ms: kindMaxEnd(byKind, "sift_wasm_binary"),
    sift_wasm_bytes: sumBytesOfKinds(byKind, ["sift_wasm_binary"]),
    arrow_data_complete_ms: maxOfKinds(byKind, ["arrow_manifest_blob", "arrow_stream_blob"]),
    arrow_data_bytes: sumBytesOfKinds(byKind, ["arrow_manifest_blob", "arrow_stream_blob"]),
  };
}

function timing(milestones, name) {
  const value = milestones[name];
  return typeof value === "number" ? value : null;
}

function kindFirstEnd(byKind, kind) {
  return byKind[kind]?.first_end_ms ?? null;
}

function kindMaxEnd(byKind, kind) {
  return byKind[kind]?.max_end_ms ?? null;
}

function maxOfKinds(byKind, kinds) {
  return kinds.reduce((current, kind) => maxDefined(current, kindMaxEnd(byKind, kind)), null);
}

function sumBytesOfKinds(byKind, kinds) {
  let total = 0;
  let sawResource = false;
  for (const kind of kinds) {
    const summary = byKind[kind];
    if (!summary) {
      continue;
    }
    sawResource = true;
    if (summary.unknown_byte_count > 0) {
      return null;
    }
    total += summary.total_bytes;
  }
  return sawResource ? total : null;
}

function delta(start, end) {
  if (start === null || start === undefined || end === null || end === undefined) {
    return null;
  }
  return end - start;
}

function firstDefined(...values) {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

function budgetUnit(spec) {
  return spec.unit ?? "ms";
}

function budgetVerb(spec) {
  return budgetUnit(spec) === "bytes" ? "was" : "took";
}

function missingBudgetNoun(spec) {
  return budgetUnit(spec) === "bytes" ? "size" : "timing";
}

const PERFORMANCE_BUDGET_METRICS = {
  collab_connected_ms: {
    group: "collab_path",
    label: "browser collaboration connections",
  },
  collab_editor_update_max_ms: {
    group: "collab_path",
    label: "editor-to-editor update propagation",
  },
  collab_anonymous_update_max_ms: {
    group: "collab_path",
    label: "editor-to-anonymous viewer update propagation",
  },
  collab_editor_convergence_max_ms: {
    group: "collab_path",
    label: "editor convergence",
  },
  collab_total_ms: {
    group: "collab_path",
    label: "browser collaboration smoke",
  },
  first_useful_render_ms: {
    group: "live_path",
    label: "first useful render",
  },
  live_sync_websocket_ms: {
    group: "live_path",
    label: "live sync WebSocket",
  },
  source_text_ms: {
    group: "live_path",
    label: "source text",
  },
  rendered_cell_marker_ms: {
    group: "live_path",
    label: "rendered cell marker",
  },
  first_output_iframe_ms: {
    group: "live_path",
    label: "first output iframe",
  },
  frame_texts_ms: {
    group: "live_path",
    label: "expected output frame text",
  },
  viewer_shell_complete_ms: {
    group: "sidecar_assets",
    label: "viewer shell assets",
  },
  runtimed_wasm_complete_ms: {
    group: "sidecar_assets",
    label: "runtimed WASM assets",
  },
  isolated_renderer_complete_ms: {
    group: "sidecar_assets",
    label: "isolated renderer assets",
  },
  output_document_complete_ms: {
    group: "sidecar_assets",
    label: "output document assets",
  },
  sift_wasm_complete_ms: {
    group: "sidecar_assets",
    label: "Sift WASM",
  },
  arrow_data_complete_ms: {
    group: "sidecar_assets",
    label: "Arrow data",
  },
  snapshot_pair_bytes: {
    group: "live_path",
    label: "snapshot pair payload",
    unit: "bytes",
  },
  viewer_shell_bytes: {
    group: "sidecar_assets",
    label: "viewer shell payload",
    unit: "bytes",
  },
  runtimed_wasm_bytes: {
    group: "sidecar_assets",
    label: "runtimed WASM payload",
    unit: "bytes",
  },
  isolated_renderer_bytes: {
    group: "sidecar_assets",
    label: "isolated renderer payload",
    unit: "bytes",
  },
  output_document_bytes: {
    group: "sidecar_assets",
    label: "output document payload",
    unit: "bytes",
  },
  sift_wasm_bytes: {
    group: "sidecar_assets",
    label: "Sift WASM payload",
    unit: "bytes",
  },
  arrow_data_bytes: {
    group: "sidecar_assets",
    label: "Arrow data payload",
    unit: "bytes",
  },
};
