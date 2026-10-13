import { defineConfig } from "vite-plus";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import tailwindcss from "@tailwindcss/vite";

const wasmPkg = resolve(__dirname, "../../crates/sift-wasm/pkg");

// Every declared dependency and peer stays an import, including subpaths such
// as react/jsx-runtime. Only first-party code and the private @nteract/odometer
// (a devDependency consumers cannot install) are inlined.
const manifest = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const externalPackages = Object.keys({
  ...manifest.dependencies,
  ...manifest.peerDependencies,
});
const external = (id: string) =>
  externalPackages.some((name) => id === name || id.startsWith(`${name}/`));

/**
 * Library build config — produces ESM bundle + compiled CSS for npm consumers.
 * Run with: npm run build:lib
 *
 * The demo app uses the default vite.config.ts.
 */
export default defineConfig({
  plugins: [
    tailwindcss(),
    {
      name: "sift-wasm-assets",
      enforce: "pre",
      resolveId(source) {
        if (source === "sift-wasm/sift_wasm.js") {
          // Keep wasm-bindgen's import.meta.url next to its matching binary.
          return { id: "./wasm/sift_wasm.js", external: true };
        }
      },
      async closeBundle() {
        const destination = resolve(__dirname, "lib/wasm");
        await mkdir(destination, { recursive: true });
        for (const file of ["sift_wasm.js", "sift_wasm.d.ts", "sift_wasm_bg.wasm"]) {
          await copyFile(resolve(wasmPkg, file), resolve(destination, file));
        }
        await copyFile(resolve(__dirname, "../../LICENSE"), resolve(__dirname, "lib/LICENSE"));
      },
    },
  ],
  // Demo datasets are not part of the embeddable library.
  publicDir: false,
  resolve: {
    alias: {
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
      external,
    },
  },
});
