import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { siftWasmCacheKey } from "../../src/build/renderer-plugin-builder";
import { isolatedRendererPlugin } from "../notebook/vite-plugin-isolated-renderer";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");

export default defineConfig({
  plugins: [react(), tailwindcss(), isolatedRendererPlugin()],
  resolve: {
    alias: {
      "@/": path.join(repoRoot, "src") + "/",
      "~/": path.join(repoRoot, "apps/notebook/src") + "/",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: true,
    sourcemap: false,
    lib: {
      entry: path.join(appDir, "viewer/index.tsx"),
      formats: ["es"],
      fileName: () => "assets/notebook-cloud-viewer.js",
      cssFileName: "notebook-cloud-viewer",
    },
    rolldownOptions: {
      output: {
        entryFileNames: "assets/notebook-cloud-viewer.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          if (!assetInfo.name?.endsWith(".css")) return "assets/[name]-[hash].[ext]";
          if (assetInfo.name === "index.css" || assetInfo.name === "notebook-cloud-viewer.css") {
            return "assets/notebook-cloud-viewer.css";
          }
          return "assets/[name]-[hash].[ext]";
        },
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
  },
  define: {
    __SIFT_WASM_CACHE_KEY__: JSON.stringify(siftWasmCacheKey()),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
