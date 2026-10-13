import { defineConfig } from "vite-plus";
import type { Plugin } from "vite";
import { resolve } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import tailwindcss from "@tailwindcss/vite";
import { writeThirdPartyNotices } from "./scripts/third-party-notices.mjs";

const wasmPkg = resolve(__dirname, "../../crates/sift-wasm/pkg");

/** Writes lib/THIRD_PARTY_NOTICES.md from the modules this build actually inlined. */
function thirdPartyNotices(): Plugin {
  const moduleIds = new Set<string>();
  let rendered = false;
  return {
    name: "sift-third-party-notices",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, module] of Object.entries(output.modules)) {
          // Tree-shaking can leave a module in the graph with no shipped code.
          if (module.renderedLength > 0) moduleIds.add(id);
        }
      }
      rendered = true;
    },
    async closeBundle() {
      if (!rendered) return;
      await writeThirdPartyNotices({
        moduleIds,
        output: resolve(__dirname, "lib/THIRD_PARTY_NOTICES.md"),
      });
    },
  };
}

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
    thirdPartyNotices(),
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
