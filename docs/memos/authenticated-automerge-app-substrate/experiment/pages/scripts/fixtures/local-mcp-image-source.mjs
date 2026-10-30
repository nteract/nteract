// Node-only image source for the MCP import smoke. It owns the download counts
// so they survive celld's isolate pool and generation swaps. The fixture Worker
// forwards each synthetic download here with its build identity.
import { createServer } from "node:http";
import { imagePng, parseImageToken } from "./local-mcp-images.mjs";

export async function startImageSource({ identity, port = 0 }) {
  const downloads = new Map(),
    isolates = new Set(),
    errors = [];
  const server = createServer((request, response) => {
    const match = /^\/download\/([^/?#]+)$/.exec(request.url);
    const parsed = match && parseImageToken(match[1]);
    const fixture = request.headers["x-pages-e2e-fixture"];
    if (request.method !== "GET" || !parsed || fixture !== identity) {
      errors.push(
        `Unexpected image request ${request.method} ${request.url} from fixture ${fixture ?? "none"}`,
      );
      response.writeHead(400).end();
      return;
    }
    downloads.set(parsed.token, (downloads.get(parsed.token) ?? 0) + 1);
    isolates.add(String(request.headers["x-pages-e2e-isolate"]));
    if (parsed.behavior === "expired") {
      response.writeHead(403, { "Content-Type": "text/plain" }).end("Expired fixture");
      return;
    }
    response.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.from(imagePng()));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    downloads: (token) => downloads.get(token) ?? 0,
    total: () => [...downloads.values()].reduce((sum, count) => sum + count, 0),
    isolates: () => isolates.size,
    errors,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
