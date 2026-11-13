// The Content-Security-Policy a chart Worker script is served with. A
// dedicated Worker runs under the policy delivered with its own script, not
// the page's, so the chart Worker (viewer/chart-worker.mjs) gets one that
// allows nothing: no fetch, XMLHttpRequest, WebSocket, EventSource,
// importScripts, nested Worker, font or image load, and no code from strings.
// The Pages Worker (worker/index.mjs) sends it with every /chunks/ script;
// the page's own chunks are module scripts, which a response CSP doesn't
// govern.
export const CHART_WORKER_CSP = "default-src 'none'";

/** A hashed viewer chunk's path, as scripts/viewer-chunks.mjs names it. */
export const CHUNK_PATH = /^\/chunks\/[A-Z2-7]{8}\.js$/;
