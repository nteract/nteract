import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import worker from "../../output/worker.mjs";
import { localFrameCsp } from "../local-frame-csp.mjs";
import { OUTPUT_FRAME_PATH } from "../../shared/output-frame-paths.mjs";

// An output host on `origin`: the output Worker's answers (the frame
// bootstrap and /health) and the catalog files under `dir`, by revision.
// The bootstrap is the output Worker's bytes. With `pagesOrigin` a local http
// Pages origin, the frame CSP also admits that origin's library modules.
export function startCatalogServer({ dir, pin, origin, port, pagesOrigin }) {
  const frameCsp = pagesOrigin ? localFrameCsp(pagesOrigin) : undefined;
  const server = createServer(async (req, res) => {
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        ...headers,
      });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (!["GET", "HEAD"].includes(req.method)) return send(405, "text/plain", "Use GET");
    try {
      const url = new URL(req.url, origin);
      const asset = /^\/catalog\/([a-f0-9]{64})\/([\w-]+\.(?:js|css|json|wasm))$/.exec(
        url.pathname,
      );
      if (asset || url.pathname === "/catalog.json") {
        const [, revision, name] = asset ?? [null, pin, "manifest.json"];
        const data = await readFile(path.join(dir, revision, name));
        return send(
          200,
          name.endsWith(".js")
            ? "text/javascript"
            : name.endsWith(".css")
              ? "text/css"
              : name.endsWith(".wasm")
                ? "application/wasm"
                : "application/json",
          data,
          {
            "Access-Control-Allow-Origin": "*",
            "Content-Length": data.byteLength,
            "Cache-Control": asset ? "public, max-age=31536000, immutable" : "no-store",
          },
        );
      }
      const response = await worker.fetch(new Request(url, { method: req.method }));
      const headers = Object.fromEntries(response.headers);
      if (frameCsp && response.headers.has("content-security-policy"))
        headers["content-security-policy"] = frameCsp;
      res.writeHead(response.status, headers);
      res.end(await response.text());
    } catch {
      send(404, "text/plain", "Catalog revision or asset unavailable");
    }
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Output ${origin}${OUTPUT_FRAME_PATH}\nCatalog ${origin}/catalog.json\nRevision ${pin}` +
        (pagesOrigin ? `\nLibraries from ${pagesOrigin}` : ""),
    ),
  );
}
