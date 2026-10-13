import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

const wasmPkg = resolve(__dirname, "../../crates/sift-csv-wasm/pkg");

/**
 * Library build: lib/index.js plus the wasm-pack glue and binary under
 * lib/wasm/. The glue stays a separate file so its `import.meta.url` resolves
 * to the binary next to it.
 */
export default defineConfig({
  plugins: [
    {
      name: "sift-csv-wasm-assets",
      enforce: "pre",
      resolveId(source) {
        if (source === "sift-csv-wasm/sift_csv_wasm.js") {
          return { id: "./wasm/sift_csv_wasm.js", external: true };
        }
      },
      async closeBundle() {
        const destination = resolve(__dirname, "lib/wasm");
        await mkdir(destination, { recursive: true });
        for (const file of ["sift_csv_wasm.js", "sift_csv_wasm.d.ts", "sift_csv_wasm_bg.wasm"]) {
          await copyFile(resolve(wasmPkg, file), resolve(destination, file));
        }
        await copyFile(resolve(__dirname, "../../LICENSE"), resolve(__dirname, "lib/LICENSE"));
      },
    },
  ],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: "lib",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    target: "es2023",
    rolldownOptions: {
      // index.ts imports node:fs/promises lazily and only for file: URLs.
      // Leave it an import so Node resolves it and browsers never load it.
      external: (id) => id.startsWith("node:"),
    },
  },
});
