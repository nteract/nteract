import { defineConfig } from "@playwright/test";
import { videoRecordingUse } from "@nteract/e2e-record/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notebookCloudDevPorts, notebookCloudWorkspaceRoot } from "../../scripts/local-dev.mjs";

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
    // Wider framing than the desktop app: the cloud list/dashboard chrome
    // (search box, header title) clips at a compact size.
    ...videoRecordingUse({ width: 1200, height: 800 }),
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
