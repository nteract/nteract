import { defineConfig } from "@playwright/test";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

function worktreeVitePort() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const hash = crypto.createHash("sha256").update(repoRoot).digest("hex");
  return 5100 + (Number.parseInt(hash.slice(0, 4), 16) % 4900);
}

const port = Number(
  process.env.RUNTIMED_VITE_PORT ?? process.env.CONDUCTOR_PORT ?? worktreeVitePort(),
);
const baseURL = process.env.NTERACT_BROWSER_E2E_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(process.env.NTERACT_BROWSER_E2E_CHANNEL
          ? { channel: process.env.NTERACT_BROWSER_E2E_CHANNEL }
          : {}),
      },
    },
  ],
});
