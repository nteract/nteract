import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "create-recovery.spec.ts",
  timeout: 45_000,
  workers: 1,
  use: {
    baseURL: process.env.NTERACT_CLOUD_URL ?? "http://127.0.0.1:45814",
    browserName: "chromium",
    trace: "retain-on-failure",
    viewport: { width: 375, height: 812 },
  },
});
