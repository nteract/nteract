import path from "node:path";
import { defineConfig } from "vite-plus";
import { browserDevRelayPlugin } from "../../apps/notebook/vite-plugin-browser-relay";
import { isolatedRendererPlugin } from "../../apps/notebook/vite-plugin-isolated-renderer";

const repoRoot = path.resolve(__dirname, "../..");

// Slidev consumes this config for its dev server and production build.
// The deck stays outside the workspace, but uses the same relay and isolated
// renderer virtual modules as apps/notebook and apps/renderer-test.
export default defineConfig({
  plugins: [browserDevRelayPlugin({ repoRoot }), isolatedRendererPlugin()],
  resolve: {
    alias: {
      "@/": `${path.resolve(repoRoot, "src")}/`,
    },
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
});
