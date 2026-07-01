import { defineConfig } from "vite-plus";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";

const wasmPkg = resolve(__dirname, "../../crates/sift-wasm/pkg");

/**
 * Library build config — produces ESM bundle + compiled CSS for npm consumers.
 * Run with: npm run build:lib
 *
 * The demo app uses the default vite.config.ts.
 */
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "sift-wasm": wasmPkg,
      // Share the app's literal UI primitives instead of vendoring copies.
      // Matches "@/…" only, not "@radix-ui/…". See ADR shared-ui-primitives.
      "@": resolve(__dirname, "../../src"),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        handoff: resolve(__dirname, "src/handoff.tsx"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "lib",
    rolldownOptions: {
      // Don't bundle peer dependencies
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "apache-arrow",
        "@chenglou/pretext",
        /^@radix-ui\//,
      ],
    },
  },
});
