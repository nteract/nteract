import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/asset-recovery",
  timeout: 20_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5187",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vp build -c vite.config.ts && node test/asset-recovery/server.mjs",
    port: 5187,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
