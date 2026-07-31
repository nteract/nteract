import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notebookCloudDevPorts, notebookCloudWorkspaceRoot } from "../../scripts/local-dev.mjs";

function truthyEnv(name: string) {
  const value = String(process.env[name] ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// Recording is opt-in via NTERACT_E2E_RECORD=1 so normal/CI runs pay nothing.
// Playwright's recorder captures the viewport at CSS-pixel size and ignores
// deviceScaleFactor, so recording 1:1 at 1200x800 yields a 1200x800-pixel
// (non-retina) video. Record at 2400x1600 instead; helpers.ts CSS-zooms the
// page 2x so the *effective* CSS layout is still 1200x800 — enough room for
// the cloud list/dashboard chrome (search box, header title) to not clip —
// while the captured pixels are full retina density.
const recordVideo = truthyEnv("NTERACT_E2E_RECORD");
const videoSize = { width: 2400, height: 1600 };

const ports = notebookCloudDevPorts({ workspaceRoot: notebookCloudWorkspaceRoot() });
const baseURL = process.env.NTERACT_CLOUD_URL ?? `http://${ports.host}:${ports.port}`;
const e2eDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: ".",
  // Explicit, not Playwright's config-relative default: the runner invokes
  // this config from the app root (pnpm --dir apps/notebook-cloud exec
  // playwright ...), and outputDir otherwise resolves relative to cwd, not
  // this file. test-results.mjs (show-video.mjs/show-frames.mjs) reads from
  // this same path.
  outputDir: path.join(e2eDir, "test-results"),
  timeout: 120_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(recordVideo
      ? { viewport: videoSize, video: { mode: "on" as const, size: videoSize } }
      : {}),
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
