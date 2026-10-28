import { builtinModules } from "node:module";
import { resolve } from "node:path";

import { defineConfig } from "vite-plus";

/**
 * Main process and preload -> dist/main/{main,preload}.cjs, one entry per run
 * (`HARNESS_ENTRY=main|preload`). A sandboxed preload can only `require`
 * Electron's own modules, so it must be one self-contained CommonJS file; a
 * shared multi-entry build would hoist runtime helpers into a chunk it cannot
 * load. The main process is CommonJS too, so `__dirname` works.
 */
const entry = process.env.HARNESS_ENTRY === "preload" ? "preload" : "main";
const entries = {
  main: resolve(__dirname, "src/main/main.ts"),
  preload: resolve(__dirname, "src/preload/preload.ts"),
};

export default defineConfig({
  publicDir: false,
  build: {
    ssr: true,
    target: "node22",
    outDir: resolve(__dirname, "dist/main"),
    emptyOutDir: entry === "main",
    minify: false,
    rolldownOptions: {
      input: { [entry]: entries[entry] },
      external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: {
        format: "cjs",
        entryFileNames: "[name].cjs",
        chunkFileNames: "[name]-[hash].cjs",
      },
    },
  },
});
