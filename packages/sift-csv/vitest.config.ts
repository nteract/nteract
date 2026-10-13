import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "sift-csv-wasm/sift_csv_wasm.js": resolve(
        __dirname,
        "../../crates/sift-csv-wasm/pkg/sift_csv_wasm.js",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
