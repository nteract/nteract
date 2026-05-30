import { createMDX } from "fumadocs-mdx/next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const siftWasmMockPath = path.join(
  dirname,
  "../../packages/sift/src/__mocks__/sift-wasm/sift_wasm.js",
);
const siftWasmMockImport = "../../packages/sift/src/__mocks__/sift-wasm/sift_wasm.js";

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  output: "export",
  images: {
    unoptimized: true,
  },
  transpilePackages: ["@nteract/sift"],
  turbopack: {
    resolveAlias: {
      "sift-wasm/sift_wasm.js": siftWasmMockImport,
    },
  },
  webpack(nextConfig) {
    nextConfig.resolve.alias = {
      ...nextConfig.resolve.alias,
      "sift-wasm/sift_wasm.js": siftWasmMockPath,
    };
    return nextConfig;
  },
};

const withMDX = createMDX();

export default withMDX(config);
