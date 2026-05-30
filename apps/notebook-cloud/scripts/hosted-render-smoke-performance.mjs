export function classifyPerformanceResource(
  url,
  { targetOrigin, rendererAssetOrigin = null, outputDocumentOrigin = null } = {},
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

  const isRendererAsset =
    rendererAssetOrigin && parsed.origin === rendererAssetOrigin && parsed.pathname.includes("/");
  const isTargetAsset = targetOrigin && parsed.origin === targetOrigin;
  if (isRendererAsset || isTargetAsset) {
    if (parsed.pathname.endsWith("/runtimed_wasm.js")) {
      return "runtimed_wasm_js";
    }
    if (parsed.pathname.endsWith("/runtimed_wasm_bg.wasm")) {
      return "runtimed_wasm_binary";
    }
    if (parsed.pathname.endsWith("/sift_wasm.wasm")) {
      return "sift_wasm_binary";
    }
  }

  if (
    outputDocumentOrigin &&
    parsed.origin === outputDocumentOrigin &&
    parsed.pathname.startsWith("/frame/")
  ) {
    return "output_document_frame";
  }

  return null;
}

export function summarizePerformanceResources(resources, milestones = {}) {
  const byKind = {};

  for (const resource of resources) {
    const summary = (byKind[resource.kind] ??= {
      count: 0,
      first_start_ms: null,
      first_end_ms: null,
      max_end_ms: null,
      statuses: [],
      urls: [],
    });
    summary.count += 1;
    summary.first_start_ms = minDefined(summary.first_start_ms, resource.start_ms);
    summary.first_end_ms = minDefined(summary.first_end_ms, resource.end_ms);
    summary.max_end_ms = maxDefined(summary.max_end_ms, resource.end_ms);
    if (resource.status !== null && resource.status !== undefined) {
      summary.statuses.push(resource.status);
    }
    if (summary.urls.length < 5 && !summary.urls.includes(resource.url)) {
      summary.urls.push(resource.url);
    }
  }

  return { milestones, resources_by_kind: byKind };
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
