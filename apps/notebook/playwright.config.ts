import { defineConfig } from "@playwright/test";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

function worktreeVitePort() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const hash = crypto.createHash("sha256").update(repoRoot).digest("hex");
  return 5100 + (Number.parseInt(hash.slice(0, 4), 16) % 4900);
}

function truthyEnv(name: string) {
  const value = String(process.env[name] ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// Recording is opt-in via NTERACT_E2E_RECORD=1 so normal/CI runs pay nothing.
// Playwright's recorder captures the viewport at CSS-pixel size and ignores
// deviceScaleFactor, so a compact 600x400 window would yield a blurry 600px
// video. Record at 1200x800 instead; helpers.ts CSS-zooms the page 2x so the
// framing reads as 600x400 at full retina density.
const recordVideo = truthyEnv("NTERACT_E2E_RECORD");
const videoSize = { width: 1200, height: 800 };

const port = Number(
  process.env.RUNTIMED_VITE_PORT ?? process.env.CONDUCTOR_PORT ?? worktreeVitePort(),
);
const baseURL = process.env.NTERACT_BROWSER_E2E_BASE_URL ?? `http://localhost:${port}`;
const ignoreHTTPSErrors =
  truthyEnv("NTERACT_BROWSER_E2E_IGNORE_HTTPS_ERRORS") ||
  (baseURL.startsWith("https://") &&
    truthyEnv("NTERACT_BROWSER_E2E_PORTLESS") &&
    process.env.NTERACT_BROWSER_E2E_IGNORE_HTTPS_ERRORS !== "0");

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL,
    ignoreHTTPSErrors,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(recordVideo
      ? { viewport: videoSize, video: { mode: "on" as const, size: videoSize } }
      : {}),
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
