import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite-plus";
import { siftWasmCacheKey } from "../../../../src/build/renderer-plugin-builder";
import { isolatedRendererPlugin } from "../../../notebook/vite-plugin-isolated-renderer";

const appDir = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(appDir, "../..");
const harnessRoot = path.join(appDir, "test/render-parity");
const frameHtmlPath = path.join(repoRoot, "src/components/isolated/frame.html");
const siftWasmPath = path.join(repoRoot, "crates/sift-wasm/pkg/sift_wasm_bg.wasm");
const siftArrowPath = path.join(
  repoRoot,
  "packages/runtimed/tests/fixtures/sift_arrow_output/blobs/sha256-10bda18795f19e46bee92a2bb34606f89f089868c6b121b7f0526761c913b77f.arrow",
);

function cloudRendererParityFixtureServer(): Plugin {
  return {
    name: "notebook-cloud-renderer-parity-fixtures",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
        if (parsed.pathname === "/output-document/frame.html") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(fs.readFileSync(frameHtmlPath, "utf8"));
          return;
        }

        if (parsed.pathname === "/renderer-assets/sift_wasm.wasm") {
          res.setHeader("access-control-allow-origin", "*");
          res.setHeader("content-type", "application/wasm");
          res.setHeader("cache-control", "no-store");
          fs.createReadStream(siftWasmPath).pipe(res);
          return;
        }

        if (parsed.pathname === "/fixture-blobs/sift.arrow") {
          res.setHeader("access-control-allow-origin", "*");
          res.setHeader("content-type", "application/vnd.apache.arrow.stream");
          res.setHeader("cache-control", "no-store");
          fs.createReadStream(siftArrowPath).pipe(res);
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  root: harnessRoot,
  plugins: [react(), tailwindcss(), isolatedRendererPlugin(), cloudRendererParityFixtureServer()],
  resolve: {
    alias: {
      "@/": path.join(repoRoot, "src") + "/",
      "~/": path.join(repoRoot, "apps/notebook/src") + "/",
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5182,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
  },
  define: {
    __SIFT_WASM_CACHE_KEY__: JSON.stringify(siftWasmCacheKey()),
    "process.env.NODE_ENV": JSON.stringify("development"),
  },
});
