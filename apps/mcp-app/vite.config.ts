import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactInputs, writeIfChanged } from "../../src/build/artifact-inputs.ts";
import { isolatedRendererPlugin } from "../notebook/vite-plugin-isolated-renderer";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
const rendererPluginDir = path.join(repoRoot, "apps/notebook/src/renderer-plugins");
const siftWasmPath = path.join(repoRoot, "crates/sift-wasm/pkg/sift_wasm_bg.wasm");
const daemonPluginAssets = [
  "markdown.js",
  "markdown.css",
  "bokeh.js",
  "panel.js",
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
  const inputs = artifactInputs(repoRoot, [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "src/components/isolated",
    "apps/mcp-app/package.json",
    "apps/mcp-app/vite.config.ts",
    "apps/mcp-app/build-html.js",
    "apps/mcp-app/src/style.css",
    "apps/notebook/vite-plugin-isolated-renderer.ts",
    "src/build/artifact-inputs.ts",
    "src/components/isolated/frame.html",
    "apps/notebook/src/renderer-plugins/isolated-renderer.js",
    "apps/notebook/src/renderer-plugins/isolated-renderer.css",
    ...daemonPluginAssets.map((asset) => `apps/notebook/src/renderer-plugins/${asset}`),
    "crates/sift-wasm/pkg/sift_wasm_bg.wasm",
  ]);
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
    plugins: [
      tailwindcss(),
      isolatedRendererPlugin({ prebuiltPluginNames: [] }),
      inputs.plugin,
      {
        name: "widget-input-receipt",
        closeBundle() {
          writeIfChanged(path.join(appDir, "dist/inputs.json"), JSON.stringify(inputs.snapshot()));
        },
      },
    ],
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
      },
    },
    define,
    logLevel: "warn",
  };
});
