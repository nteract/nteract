import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedRendererPlugin } from "../notebook/vite-plugin-isolated-renderer";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
const rendererPluginDir = path.join(repoRoot, "apps/notebook/src/renderer-plugins");
const siftWasmPath = path.join(repoRoot, "crates/sift-wasm/pkg/sift_wasm_bg.wasm");
const daemonPluginAssets = [
  "markdown.js",
  "markdown.css",
  "plotly.js",
  "vega.js",
  "leaflet.js",
  "leaflet.css",
  "sift.js",
  "sift.css",
] as const;

function hashFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 16);
}

function daemonPluginAssetHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const asset of daemonPluginAssets) {
    const hash = hashFile(path.join(rendererPluginDir, asset));
    if (hash) hashes[asset] = hash;
  }

  const wasmHash = hashFile(siftWasmPath);
  if (wasmHash) hashes["sift_wasm.wasm"] = wasmHash;
  return hashes;
}

export default defineConfig(({ command }) => {
  const define = {
    __DAEMON_PLUGIN_ASSET_HASHES__: JSON.stringify(daemonPluginAssetHashes()),
    "process.env.NODE_ENV": JSON.stringify("production"),
  };

  if (command === "serve") {
    return {
      root: "src",
      plugins: [tailwindcss(), isolatedRendererPlugin({ prebuiltPluginNames: [] })],
      define,
      resolve: {
        alias: {
          "@": path.join(repoRoot, "src"),
        },
      },
      server: {
        open: "/dev/index.html",
      },
    };
  }

  return {
    plugins: [tailwindcss(), isolatedRendererPlugin({ prebuiltPluginNames: [] })],
    resolve: {
      alias: {
        "@": path.join(repoRoot, "src"),
      },
    },
    esbuild: {
      jsx: "automatic",
      jsxImportSource: "react",
      jsxDev: false,
    },
    build: {
      outDir: "dist",
      emptyDirBefore: true,
      lib: {
        entry: "src/mcp-app.tsx",
        formats: ["es"],
        fileName: () => "mcp-app.js",
      },
      rolldownOptions: {
        output: {
          codeSplitting: false,
        },
        onwarn(warning, warn) {
          if (
            warning.code === "MODULE_LEVEL_DIRECTIVE" &&
            warning.message?.includes('"use client"')
          ) {
            return;
          }
          warn(warning);
        },
      },
      minify: true,
      sourcemap: false,
    },
    run: {
      tasks: {
        build: {
          command: "vp build && node build-html.js",
        },
        "build:plugins": {
          command: "node build-plugins.ts",
        },
        "build:all": {
          command: "echo 'MCP app build complete'",
          dependsOn: ["build", "build:plugins"],
        },
      },
    },
    define,
    logLevel: "warn",
  };
});
