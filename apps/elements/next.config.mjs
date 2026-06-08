import { createMDX } from "fumadocs-mdx/next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const siftWasmAdapterPath = path.join(dirname, "lib/sift-wasm-module.ts");
const siftWasmAdapterImport = "./lib/sift-wasm-module.ts";
const frameConfigSourcePath = path.join(dirname, "../../src/components/isolated/frame-config.ts");
const frameConfigAdapterPath = path.join(dirname, "components/isolated/frame-config-adapter.ts");
const frameConfigAdapterImport = "./components/isolated/frame-config-adapter.ts";

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1", "**.nteract-elements.localhost"],
  output: "export",
  images: {
    unoptimized: true,
  },
  transpilePackages: ["@nteract/sift"],
  turbopack: {
    root: path.join(dirname, "../.."),
    resolveAlias: {
      "./frame-config": frameConfigAdapterImport,
      [frameConfigSourcePath]: frameConfigAdapterImport,
      "sift-wasm/sift_wasm.js": siftWasmAdapterImport,
    },
  },
  webpack(nextConfig) {
    nextConfig.resolve.alias = {
      ...nextConfig.resolve.alias,
      "./frame-config": frameConfigAdapterPath,
      [frameConfigSourcePath]: frameConfigAdapterPath,
      "sift-wasm/sift_wasm.js": siftWasmAdapterPath,
    };
    return nextConfig;
  },
};

const withMDX = createMDX();

export default withMDX(config);
