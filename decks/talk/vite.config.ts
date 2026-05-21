import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vite-plus";
import { browserDevRelayPlugin } from "../../apps/notebook/vite-plugin-browser-relay";
import { isolatedRendererPlugin } from "../../apps/notebook/vite-plugin-isolated-renderer";
import { createMathNetArrowIpc, MATHNET_ARROW_PATH } from "./data/mathnet-arrow";

const repoRoot = path.resolve(__dirname, "../..");
const mathnetArrowIpc = createMathNetArrowIpc();
const requireFromConfig = createRequire(import.meta.url);

interface RuntimedNodeDiscovery {
  defaultSocketPath?: () => string;
  socketPathForChannel?: (channel: string) => string;
}

interface DaemonInfo {
  blob_port?: number;
}

type PresentationDaemonMode = "dev" | "nightly";

function presentationDaemonMode(): PresentationDaemonMode {
  const mode = process.env.NTERACT_SLIDEV_DAEMON ?? process.env.RUNTIMED_PRESENTATION_DAEMON;
  return mode === "nightly" ? "nightly" : "dev";
}

function withRuntimedEnv<T>(overrides: Record<string, string | undefined>, callback: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function loadRuntimedNode(): RuntimedNodeDiscovery | null {
  const candidates = [
    "@runtimed/node",
    path.join(repoRoot, "packages/runtimed-node/src/index.cjs"),
  ];
  for (const candidate of candidates) {
    try {
      return requireFromConfig(candidate) as RuntimedNodeDiscovery;
    } catch {
      // The local worktree package often has no native N-API build. Keep the
      // Slidev harness usable and fall back to the same worktree cache path.
    }
  }
  return null;
}

function uniqueSocketPaths(paths: Array<string | null | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

function runtimedNodeSocketPaths(): string[] {
  const runtimedNode = loadRuntimedNode();
  if (!runtimedNode) return [];

  if (presentationDaemonMode() === "nightly") {
    return uniqueSocketPaths([
      withRuntimedEnv(
        { RUNTIMED_DEV: undefined, RUNTIMED_WORKSPACE_PATH: undefined },
        () => runtimedNode.socketPathForChannel?.("nightly") ?? runtimedNode.defaultSocketPath?.(),
      ),
      runtimedNode.defaultSocketPath?.(),
    ]);
  }

  return uniqueSocketPaths([
    // Explicit socket wins if the presenter wants to point the deck at an
    // installed Nightly or another daemon by hand.
    process.env.RUNTIMED_SOCKET_PATH ? runtimedNode.defaultSocketPath?.() : undefined,
    // The talk is local-first. Prefer the worktree dev daemon so Sift and blob
    // resources come from the same daemon used by `cargo xtask dev-daemon`.
    withRuntimedEnv({ RUNTIMED_DEV: "1", RUNTIMED_WORKSPACE_PATH: repoRoot }, () =>
      runtimedNode.defaultSocketPath?.(),
    ),
  ]);
}

function readDaemonInfoFile(fs: typeof import("node:fs"), daemonJson: string): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(daemonJson, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

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
  for (const socketPath of runtimedNodeSocketPaths()) {
    const daemonJson = path.join(path.dirname(socketPath), "daemon.json");
    const daemonInfo = readDaemonInfoFile(fs, daemonJson);
    if (daemonInfo) return daemonInfo;
  }

  const namespace = process.env.RUNTIMED_CACHE_NAMESPACE ?? "runt-nightly";
  const hash = crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  const daemonJson = path.join(cacheDir(), namespace, "worktrees", hash, "daemon.json");
  return readDaemonInfoFile(fs, daemonJson);
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
