// Test host only. The widget and renderer assets are unmodified production builds.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { build } from "vite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReadResourceRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const blobBase = "http://127.0.0.1:9";
export const resourceBase =
  "nteract://sessions/00000000-0000-4000-8000-000000000001/executions/00000000-0000-4000-8000-000000000002/blobs/";
const assetsBase = "nteract://renderer-assets/";

export async function startHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "nteract-mcp-smoke-"));
  const resources = new Map();
  const reads = [];
  const denied = new Set();
  const put = (bytes, mimeType) => {
    const buffer = Buffer.from(bytes);
    const hash = createHash("sha256").update(buffer).digest("hex");
    resources.set(resourceBase + hash, { blob: buffer.toString("base64"), mimeType });
    return `${blobBase}/blob/${hash}`;
  };
  const arrow = put(
    tableToIPC(
      tableFromArrays({
        Name: ["Cedar", "Aster", "Birch"],
        Score: new Int32Array([30, 10, 20]),
        Group: ["tree", "flower", "tree"],
      }),
      "stream",
    ),
    "application/vnd.apache.arrow.stream",
  );
  const png = put(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      "base64",
    ),
    "image/png",
  );
  const text = put("stdout through an MCP blob\n", "text/plain");
  const mcpServer = new Server(
    { name: "fixture-resources", version: "1" },
    { capabilities: { resources: {} } },
  );
  const client = new Client({ name: "smoke-host", version: "1" });
  mcpServer.setRequestHandler(ReadResourceRequestSchema, async ({ params: { uri } }) => {
    reads.push(uri);
    if (denied.has(uri))
      throw new McpError(ErrorCode.InvalidParams, `Missing smoke resource: ${uri}`);
    const resource = resources.get(uri);
    if (resource) return { contents: [{ uri, ...resource }] };
    throw new McpError(ErrorCode.InvalidParams, `Unknown smoke resource: ${uri}`);
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  let http;
  const close = async () => {
    if (http) {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    }
    await Promise.all([client.close(), mcpServer.close()]);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    // Only the host adapter is built here. Never substitute a dev widget bundle.
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: directory,
        lib: {
          entry: path.join(root, "apps/mcp-app/e2e/host.ts"),
          formats: ["es"],
          fileName: () => "host.js",
        },
      },
    });
    for (const name of [
      "markdown.js",
      "markdown.css",
      "plotly.js",
      "vega.js",
      "sift.js",
      "sift.css",
      "sift_wasm.wasm",
    ]) {
      const file =
        name === "sift_wasm.wasm"
          ? path.join(root, "crates/sift-wasm/pkg/sift_wasm_bg.wasm")
          : path.join(root, "apps/notebook/src/renderer-plugins", name);
      const bytes = await readFile(file);
      if (bytes.length < 200) throw new Error(`Missing production renderer asset: ${file}`);
      resources.set(assetsBase + name, {
        blob: bytes.toString("base64"),
        mimeType: name.endsWith(".wasm")
          ? "application/wasm"
          : name.endsWith(".css")
            ? "text/css"
            : "text/javascript",
      });
    }
    const widget = await readFile(path.join(root, "apps/mcp-app/dist/output.html"), "utf8");
    const host = await readFile(path.join(directory, "host.js"));
    resources.set("ui://smoke/output.html", {
      text: widget,
      mimeType: "text/html;profile=mcp-app",
    });
    http = createServer(async (req, res) => {
      try {
        if (req.url === "/resource" && req.method === "POST") {
          let body = "";
          for await (const chunk of req) body += chunk;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(await client.readResource(JSON.parse(body))));
        } else if (req.url === "/widget") {
          res.setHeader("Content-Type", "text/html");
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src blob: data:; worker-src blob:",
          );
          const result = await client.readResource({ uri: "ui://smoke/output.html" });
          res.end(result.contents[0].text);
        } else if (req.url === "/host.js") {
          res.setHeader("Content-Type", "text/javascript");
          res.end(host);
        } else if (req.url === "/") {
          res.setHeader("Content-Type", "text/html");
          res.end(
            '<!doctype html><meta charset="utf-8"><style>body{margin:0}</style><script type="module" src="/host.js"></script>',
          );
        } else {
          res.statusCode = 404;
          res.end();
        }
      } catch (error) {
        res.statusCode = 500;
        res.end(String(error));
      }
    });
    await new Promise((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
    return {
      url: `http://127.0.0.1:${http.address().port}`,
      reads,
      denied,
      arrow,
      png,
      text,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
