import { createMDX } from "fumadocs-mdx/next";

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  output: "export",
  images: {
    unoptimized: true,
  },
};

const withMDX = createMDX();

export default withMDX(config);
