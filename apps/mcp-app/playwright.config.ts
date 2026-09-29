import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "wide", use: { browserName: "chromium", viewport: { width: 1280, height: 900 } } },
    {
      name: "constrained",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 } },
    },
  ],
});
