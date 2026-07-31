import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test, type TestInfo } from "@playwright/test";

// Same recording pattern as apps/notebook/e2e/helpers.ts: opt-in via
// NTERACT_E2E_RECORD=1, which also flips on the video viewport/zoom in
// playwright.config.ts. A normal run produces no video, no PNGs, no pacing
// delay.
const recording = /^(1|true|yes|on)$/i.test(process.env.NTERACT_E2E_RECORD ?? "");

const recordingStarts = new Map<string, number>();

function markRecordingStart() {
  recordingStarts.set(test.info().testId, Date.now());
}

// Counterpart to the 2400x1600 recording viewport set in playwright.config.ts:
// zoom the UI 2x so the video frames the same content a 1200x800 CSS viewport
// would (enough room for the cloud list/dashboard chrome to not clip), at full
// retina density. Playwright's recorder ignores deviceScaleFactor, so CSS zoom
// is the only way to record above 1x.
async function applyVideoZoom(page: Page) {
  await page.addInitScript(() => {
    const applyZoom = () => {
      document.documentElement.style.setProperty("zoom", "2");
    };
    if (document.documentElement) applyZoom();
    else document.addEventListener("DOMContentLoaded", applyZoom);
  });
}

function slug(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function archiveSegments(info: TestInfo) {
  const specFile = path.basename(info.file);
  const spec = specFile.replace(/\.spec\.[jt]s$/, "");
  const titles = info.titlePath.filter((part) => part !== specFile && part !== info.project.name);
  return [spec, ...titles].map(slug).filter(Boolean);
}

/**
 * Low-level primitive: record "the trimmed clip starts *now*." A no-op when
 * not recording. Prefer a named `mark*Ready` helper below.
 */
export async function markClipStart(): Promise<void> {
  if (!recording) return;

  const info = test.info();
  const start = recordingStarts.get(info.testId);
  if (start == null) {
    console.warn(
      "markClipStart: no recording start for this test — navigate via " +
        "openHomePage/openNotebookListViaLocalAuth. Video will not be trimmed.",
    );
    return;
  }
  const trimSeconds = Math.max(0, (Date.now() - start) / 1000 - 0.25);
  await fs.promises.mkdir(info.outputDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(info.outputDir, "video-meta.json"),
    JSON.stringify(
      { trimSeconds: Number(trimSeconds.toFixed(3)), segments: archiveSegments(info) },
      null,
      2,
    ),
    "utf8",
  );
}

/**
 * Wait for the notebook toolbar to appear (kernel/session loaded). Does not
 * move the clip start — call markClipStart() explicitly wherever the flow's
 * interesting footage actually begins (usually right after the first
 * navigation, via openHomePage).
 */
export async function waitForNotebookToolbar(page: Page, timeout = 120_000): Promise<void> {
  await expect(page.getByTestId("notebook-toolbar")).toBeVisible({ timeout });
}

/**
 * Sleep only while recording, to pace the video. A no-op otherwise.
 */
export async function pauseForVideo(page: Page, ms = 1_000): Promise<void> {
  if (!recording) return;
  await page.waitForTimeout(ms);
}

const screenshotSeq = new Map<string, number>();

/**
 * Capture a screenshot at the current moment for agent inspection. Only writes
 * in recording mode. Mirrors apps/notebook/e2e/helpers.ts screenshot().
 */
export async function screenshot(page: Page, label?: string): Promise<string> {
  if (!recording) return "";

  const info = test.info();
  const seq = (screenshotSeq.get(info.testId) ?? 0) + 1;
  screenshotSeq.set(info.testId, seq);
  const index = String(seq).padStart(2, "0");
  const safeLabel = label ? label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") : "";
  const name = `frame-${index}${safeLabel ? `-${safeLabel}` : ""}.png`;
  await fs.promises.mkdir(info.outputDir, { recursive: true });
  const filePath = path.join(info.outputDir, name);
  await page.screenshot({ path: filePath, fullPage: false });
  await info.attach(safeLabel || `frame-${index}`, { path: filePath, contentType: "image/png" });
  return filePath;
}

/** Navigate to the signed-out home page (`/n`). */
export async function openHomePage(page: Page): Promise<void> {
  markRecordingStart();
  if (recording) await applyVideoZoom(page);
  await page.goto("/n");
  await expect(page.locator("main.cloud-notebook-list-page, main.cloud-home")).toBeVisible({
    timeout: 30_000,
  });
  // The home page render is the start of the interesting footage; trim only
  // the browser-launch/navigation dead time before it.
  await markClipStart();
}

/**
 * Drive the loopback `/local-auth` route (seeds the dev-token localStorage
 * keys and redirects to `next`), landing signed in on the notebook list.
 */
export async function signInWithLocalAuth(page: Page): Promise<void> {
  await page.getByRole("button", { name: /use local auth/i }).click();
  await expect(page.locator("header").getByRole("button", { name: /new notebook/i })).toBeVisible({
    timeout: 30_000,
  });
}
