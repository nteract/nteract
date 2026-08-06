/**
 * Video/screenshot recording primitives shared by every app's Playwright e2e
 * suite (apps/notebook, apps/notebook-cloud). App suites re-export these from
 * their own `e2e/helpers.ts` and add app-specific readiness marks on top.
 *
 * Recording is opt-in via NTERACT_E2E_RECORD=1: a normal suite run produces no
 * video, no PNGs, and no pacing delay.
 */

import fs from "node:fs";
import path from "node:path";
import { type Page, test, type TestInfo } from "@playwright/test";

/**
 * CSS zoom applied to the page while recording, and the factor by which
 * `videoRecordingUse()` inflates the requested framing to get the capture
 * viewport. Playwright's recorder captures the viewport at CSS-pixel size and
 * ignores `deviceScaleFactor`, so CSS zoom is the only way to record above 1x —
 * and the two numbers have to agree or the video is mis-framed. They agree
 * because both read this constant.
 */
export const VIDEO_ZOOM = 2;

/** True when running under NTERACT_E2E_RECORD=1. */
export const recording = /^(1|true|yes|on)$/i.test(process.env.NTERACT_E2E_RECORD ?? "");

// Wall-clock time (ms) at which each test's video effectively began recording,
// keyed by testId. Playwright starts recording at context creation and offers no
// pause/resume, so we capture navigation start here and later write the elapsed
// time to a sidecar file so show-video.mjs can trim the boring load prefix.
const recordingStarts = new Map<string, number>();

/**
 * Stamp "the video starts about here" for the current test. Call from the
 * app's navigation helper, immediately before `page.goto()`.
 */
export function markRecordingStart(): void {
  recordingStarts.set(test.info().testId, Date.now());
}

/**
 * Zoom the UI by {@link VIDEO_ZOOM} so the video frames the content that the
 * app's requested (smaller) CSS viewport would, at full retina density. Call
 * from the app's navigation helper before `page.goto()`, and only while
 * recording.
 */
export async function applyVideoZoom(page: Page): Promise<void> {
  await page.addInitScript((zoom) => {
    const applyZoom = () => {
      document.documentElement.style.setProperty("zoom", String(zoom));
    };
    if (document.documentElement) applyZoom();
    else document.addEventListener("DOMContentLoaded", applyZoom);
  }, VIDEO_ZOOM);
}

/**
 * Navigate-and-zoom preamble every app's "open the app" helper needs: stamp the
 * recording start, then install the zoom init script when recording. Does not
 * navigate — call this immediately before `page.goto()`.
 */
export async function beginRecordedNavigation(page: Page): Promise<void> {
  markRecordingStart();
  if (recording) await applyVideoZoom(page);
}

function slug(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Where show-video.mjs should archive this test's clip, as path segments:
 * spec file, then each describe/test title. Playwright's own output dir flattens
 * all of this into one dash-joined string, which is unreadable when a describe
 * restates the filename ("add-cell-add-cell-..."); nesting keeps the structure
 * and groups a spec's before/after clips in one folder.
 */
function archiveSegments(info: TestInfo) {
  const specFile = path.basename(info.file);
  const spec = specFile.replace(/\.spec\.[jt]s$/, "");
  // titlePath leads with the spec filename (and, per the docs, possibly the
  // project name) before the describe/test titles. Drop those by identity rather
  // than by a fixed count, so we neither keep a duplicate nor eat a real title.
  const titles = info.titlePath.filter((part) => part !== specFile && part !== info.project.name);
  return [spec, ...titles].map(slug).filter(Boolean);
}

/**
 * Low-level primitive: record "the trimmed clip starts *now*." Writes the trim
 * offset (seconds, relative to navigation start) plus the archive path to
 * `video-meta.json` in the test's output dir, next to `video.webm`;
 * show-video.mjs seeks past the offset before the 2x speed-up. Called again
 * later, the latest offset wins. A no-op when not recording.
 *
 * Prefer the app's named `mark*Ready` helper: each waits for a specific
 * readiness signal *before* stamping the clip start, so the mark's meaning is
 * verified rather than implied by whatever happened to be awaited on the lines
 * above it. Reach for this raw primitive only for a surface that has no named
 * helper yet.
 *
 * `navigationHint` names the app's navigation helpers, for the warning shown
 * when a test marked a clip start without ever going through one.
 */
export async function markClipStart(navigationHint: string): Promise<void> {
  if (!recording) return;

  const info = test.info();
  const start = recordingStarts.get(info.testId);
  if (start == null) {
    console.warn(
      `markClipStart: no recording start for this test — navigate via ${navigationHint}. ` +
        "Video will not be trimmed.",
    );
    return;
  }
  // Small safety margin so we never cut into the first interaction.
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
 * Sleep only while recording, to pace the video (let a state be readable before
 * the next interaction). A no-op otherwise, so pacing never slows real runs.
 */
export async function pauseForVideo(page: Page, ms = 1_000): Promise<void> {
  if (!recording) return;
  await page.waitForTimeout(ms);
}

// Monotonic counter per test so unlabeled screenshots still sort in call order.
const screenshotSeq = new Map<string, number>();

/**
 * Capture a screenshot at the current moment for agent inspection. Only writes
 * in recording mode (NTERACT_E2E_RECORD=1) — a normal suite run produces no
 * PNGs, so specs can keep their marks without every run littering artifacts.
 *
 * The video (video.webm) records the whole flow for humans; these PNGs are the
 * artifact an agent can actually Read. Drop a `screenshot("label")` call at each
 * point of interest in the flow:
 *
 *   await doA();
 *   await screenshot(page, "01-at-A");
 *   await doB();
 *   await screenshot(page, "02-at-B");
 *
 * Files land in the test's output dir (gitignored test-results/<test>/) as
 * `frame-<label>.png`, so they never collide across worktrees and never commit.
 * The label is sanitized; if omitted, an auto-incrementing index is used.
 * Returns the absolute path, or "" when not recording.
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
