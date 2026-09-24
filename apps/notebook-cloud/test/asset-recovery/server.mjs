import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

// Exercise the real production entrypoint and its lazy import graph. Faults
// live at the HTTP boundary, not in a synthetic vite:preloadError event.
const dist = resolve("dist");
const cases = new Map();
const config = Object.fromEntries(
  [
    "catalogEndpoint",
    "snapshotBasePath",
    "runtimeSnapshotBasePath",
    "commsSnapshotBasePath",
    "aclEndpoint",
    "invitesEndpoint",
    "accessRequestsEndpoint",
    "workstationsEndpoint",
    "workstationDefaultEndpoint",
    "workstationAttachEndpoint",
    "syncEndpoint",
    "blobBasePath",
    "rendererAssetsBasePath",
    "runtimedWasmModulePath",
    "runtimedWasmPath",
  ].map((key) => [key, `/api/fixture/${key}`]),
);

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Cache-Control", "no-store");
  const asset = /^\/__case\/([\w-]+)\/assets\/([\w.-]+)$/.exec(url.pathname);
  if (asset) {
    const [, id, name] = asset;
    const scenario = cases.get(id);
    const target =
      scenario?.asset === "markdown-text"
        ? /^MarkdownText-.*\.js$/
        : scenario?.asset === "workstations"
          ? /^workstations-view-.*\.js$/
          : /^notebook-route-.*\.js$/;
    if (scenario && target.test(name)) {
      scenario.requests += 1;
      if (scenario.requests <= scenario.failures) {
        res.setHeader("Content-Type", "text/javascript");
        if (scenario.status === "evaluation") {
          res.end('throw new TypeError("Application initialization failed");');
        } else {
          res.writeHead(Number(scenario.status));
          res.end("Simulated asset download failure");
        }
        return;
      }
    }
    try {
      const body = await readFile(resolve(dist, "assets", name));
      res.setHeader("Content-Type", extname(name) === ".css" ? "text/css" : "text/javascript");
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  if (url.pathname === "/__status") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(cases.get(url.searchParams.get("case")) ?? null));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(401).end(JSON.stringify({ error: "Sign in required" }));
    return;
  }
  const id = url.searchParams.get("case") ?? "manual";
  if (!/^[\w-]+$/.test(id)) {
    res.writeHead(400).end();
    return;
  }
  const scenario = cases.get(id) ?? {
    asset: url.searchParams.get("asset") ?? "notebook",
    failures: Number(url.searchParams.get("failures") ?? 1),
    status: url.searchParams.get("status") ?? "520",
    requests: 0,
    documents: 0,
  };
  scenario.documents += 1;
  cases.set(id, scenario);
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/__case/${id}/assets/notebook-cloud-viewer.css">
    </head><body><div id="root"></div>
    <script id="nteract-cloud-viewer-config" type="application/json">${JSON.stringify({ ...config, notebookId: "fixture" })}</script>
    <script type="module" src="/__case/${id}/assets/notebook-cloud-viewer.js"></script>
    </body></html>`);
}).listen(5187, "127.0.0.1", () => {
  console.log("Asset recovery fixture: http://127.0.0.1:5187/n/fixture");
});
