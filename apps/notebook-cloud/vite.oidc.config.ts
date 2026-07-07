import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@/": path.join(repoRoot, "src") + "/",
      "~/": path.join(repoRoot, "apps/notebook/src") + "/",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    sourcemap: false,
    lib: {
      entry: path.join(appDir, "viewer/oidc-callback-main.ts"),
      formats: ["es"],
      fileName: () => "assets/notebook-cloud-oidc.js",
    },
    rolldownOptions: {
      output: {
        entryFileNames: "assets/notebook-cloud-oidc.js",
        inlineDynamicImports: true,
        assetFileNames: "assets/notebook-cloud-oidc.[ext]",
      },
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
