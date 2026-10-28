import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

/**
 * Renderer build -> dist/renderer. Served by `harness://app` and
 * `harness://embedded`, so asset URLs are relative.
 *
 * `@nteract/sift` resolves to the built library (`packages/sift/lib`), the
 * artifact Kilo Desktop installs from npm, not the workspace's TypeScript
 * sources. The mapping is read from the package's `publishConfig.exports`, so
 * it is the published export map with the workspace path in front.
 * `pnpm --dir packages/sift build:lib` must have run.
 */
const siftDir = resolve(__dirname, "../../packages/sift");
const siftManifest = JSON.parse(readFileSync(resolve(siftDir, "package.json"), "utf8")) as {
  publishConfig: { exports: Record<string, string | { import: string }> };
};
const siftAliases = Object.entries(siftManifest.publishConfig.exports).map(([subpath, target]) => {
  const file = typeof target === "string" ? target : target.import;
  const specifier = `@nteract/sift${subpath.slice(1)}`.replace(/[./]/g, (c) => `\\${c}`);
  // Anchored at the start only, so `?url` and similar suffixes survive.
  return { find: new RegExp(`^${specifier}(?=$|\\?)`), replacement: resolve(siftDir, file) };
});

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  publicDir: false,
  plugins: [react()],
  resolve: { alias: siftAliases },
  worker: {
    // Sift's worker bundle code-splits (the WASM glue is a dynamic import),
    // which needs an ES module worker.
    format: "es",
  },
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    sourcemap: true,
    // Keep the .wasm a separate file served with application/wasm.
    assetsInlineLimit: 0,
  },
});
