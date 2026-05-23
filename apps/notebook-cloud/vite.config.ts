import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { isolatedRendererPlugin } from "../notebook/vite-plugin-isolated-renderer";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");

export default defineConfig({
  plugins: [isolatedRendererPlugin()],
  resolve: {
    alias: {
      "@/": path.join(repoRoot, "src") + "/",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: path.join(appDir, "viewer/index.ts"),
      formats: ["es"],
      fileName: () => "assets/notebook-cloud-viewer.js",
    },
    rolldownOptions: {
      output: {
        entryFileNames: "assets/notebook-cloud-viewer.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
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
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
