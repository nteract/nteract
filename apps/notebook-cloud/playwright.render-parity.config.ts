import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/render-parity",
  timeout: 90_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://127.0.0.1:5182",
    browserName: "chromium",
    deviceScaleFactor: 1,
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: "pnpm exec vp dev -c test/render-parity/vite.config.ts",
    port: 5182,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [{ name: "chromium" }],
});
