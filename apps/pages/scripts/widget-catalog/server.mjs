import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FRAME_HTML } from "../../.output-dist/frame-html.mjs";
import worker from "../../output/worker.mjs";
import { FRAME_CSP } from "../../output/policy.mjs";
import { OUTPUT_FRAME_PATH } from "../../shared/output-frame-paths.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function startCatalogServer({ dir, pin, origin, port }) {
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
        const file = path.join(dir, revision, name);
        const compressed = /(?:^|,)\s*br\s*(?:,|$)/i.test(req.headers["accept-encoding"] ?? "")
          ? await readFile(file + ".br").catch(() => null)
          : null;
        const data = compressed ?? (await readFile(file));
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
            Vary: "Accept-Encoding",
            ...(compressed && { "Content-Encoding": "br" }),
            "Content-Length": data.byteLength,
            "Cache-Control": asset ? "public, max-age=31536000, immutable" : "no-store",
          },
        );
      }
      const revision = url.searchParams.get("catalog");
      if (url.pathname === OUTPUT_FRAME_PATH && revision) {
        if (!/^[0-9a-f]{64}$/.test(revision))
          return send(400, "text/plain", "Invalid catalog revision");
        const saved = await readFile(path.join(dir, revision, "manifest.json"));
        if (hash(saved) !== revision) throw Error("Unknown revision");
        const { imports, stylesheet } = JSON.parse(saved);
        const base = `${origin}/catalog/${revision}/`;
        const map = {
          imports: Object.fromEntries(
            Object.entries(imports).map(([id, file]) => [id, base + file]),
          ),
        };
        return send(
          200,
          "text/html; charset=utf-8",
          FRAME_HTML.replace(
            "</head>",
            `${stylesheet ? `<link rel="stylesheet" href="${base}${stylesheet}">` : ""}<script type="application/json" id="widget-catalog-map">${JSON.stringify(map)}</script></head>`,
          ),
          {
            "Content-Security-Policy": FRAME_CSP.replace(
              "https: blob:",
              `https: blob: ${origin}`,
            ).replace(
              "style-src 'unsafe-inline' https:",
              `style-src 'unsafe-inline' https: ${origin}`,
            ),
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        );
      }
      const response = await worker.fetch(new Request(url, { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch {
      send(404, "text/plain", "Catalog revision or asset unavailable");
    }
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Output ${origin}${OUTPUT_FRAME_PATH}\nCatalog ${origin}/catalog.json\nRevision ${pin}`,
    ),
  );
}
