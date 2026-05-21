import path from "node:path";
import { defineConfig } from "vite-plus";
import { browserDevRelayPlugin } from "../../apps/notebook/vite-plugin-browser-relay";
import { isolatedRendererPlugin } from "../../apps/notebook/vite-plugin-isolated-renderer";
import { createMathNetArrowIpc, MATHNET_ARROW_PATH } from "./data/mathnet-arrow";

const repoRoot = path.resolve(__dirname, "../..");
const mathnetArrowIpc = createMathNetArrowIpc();

function cacheDir(): string {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  if (process.platform === "darwin") return path.join(process.env.HOME ?? "", "Library", "Caches");
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? path.join(process.env.HOME ?? "", "AppData", "Local");
  }
  return path.join(process.env.HOME ?? "", ".cache");
}

async function readDaemonInfo() {
  const fs = await import("node:fs");
  const crypto = await import("node:crypto");
  const namespace = process.env.RUNTIMED_CACHE_NAMESPACE ?? "runt-nightly";
  const hash = crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  const daemonJson = path.join(cacheDir(), namespace, "worktrees", hash, "daemon.json");
  try {
    return JSON.parse(fs.readFileSync(daemonJson, "utf8")) as { blob_port?: number };
  } catch {
    return null;
  }
}

function sendBytes(
  res: {
    statusCode: number;
    setHeader(name: string, value: string | number): void;
    end(body?: Buffer): void;
  },
  statusCode: number,
  bytes: Uint8Array,
  contentType: string,
) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", bytes.byteLength);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.end(Buffer.from(bytes));
}

function sendText(
  res: {
    statusCode: number;
    setHeader(name: string, value: string | number): void;
    end(body?: string): void;
  },
  statusCode: number,
  body: string,
) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function mathnetArrowFixturePlugin() {
  return {
    name: "mathnet-arrow-fixture",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

        if (url.pathname === MATHNET_ARROW_PATH) {
          sendBytes(res, 200, mathnetArrowIpc, "application/vnd.apache.arrow.stream");
          return;
        }

        if (url.pathname === "/plugins/sift_wasm.wasm") {
          const daemonInfo = await readDaemonInfo();
          if (!daemonInfo?.blob_port) {
            sendText(
              res,
              503,
              "Start the worktree dev daemon with `cargo xtask dev-daemon` to load Sift WASM.",
            );
            return;
          }

          const wasmUrl = new URL(
            `/plugins/sift_wasm.wasm${url.search}`,
            `http://127.0.0.1:${daemonInfo.blob_port}`,
          );
          const response = await fetch(wasmUrl);
          if (!response.ok) {
            sendText(
              res,
              response.status,
              `Failed to load Sift WASM from dev daemon: ${response.status}`,
            );
            return;
          }

          sendBytes(
            res,
            200,
            new Uint8Array(await response.arrayBuffer()),
            response.headers.get("Content-Type") ?? "application/wasm",
          );
          return;
        }

        next();
      });
    },
  };
}

// Slidev consumes this config for its dev server and production build.
// The deck stays outside the workspace, but uses the same relay and isolated
// renderer virtual modules as apps/notebook and apps/renderer-test.
export default defineConfig({
  plugins: [
    mathnetArrowFixturePlugin(),
    browserDevRelayPlugin({ repoRoot }),
    isolatedRendererPlugin(),
  ],
  resolve: {
    alias: {
      "@/": `${path.resolve(repoRoot, "src")}/`,
    },
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
});
