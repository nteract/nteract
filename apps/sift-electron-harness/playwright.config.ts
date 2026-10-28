import { defineConfig } from "@playwright/test";

// Each test launches its own Electron app from dist/ (built by `pretest:e2e`).
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
});
