import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

const root = resolve(__dirname, "src/ui");
const wasmPkg = resolve(__dirname, "../../crates/sift-wasm/pkg");

export default defineConfig({
  root,
  base: "./",
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "sift-wasm": wasmPkg,
    },
  },
  build: {
    assetsInlineLimit: 10_000_000,
    chunkSizeWarningLimit: 10_000,
    emptyOutDir: false,
    outDir: resolve(__dirname, "dist/ui-build"),
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
});
