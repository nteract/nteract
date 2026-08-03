/**
 * Playwright config fragment for opt-in video recording, shared by every app's
 * `playwright.config.ts`.
 */

import { recording, VIDEO_ZOOM } from "./recording.js";

export interface VideoFraming {
  /** Effective CSS width the video should frame (before the recording zoom). */
  width: number;
  /** Effective CSS height the video should frame (before the recording zoom). */
  height: number;
}

/**
 * Spread into a Playwright `use` block to enable recording under
 * NTERACT_E2E_RECORD=1, and contribute nothing otherwise — so normal and CI
 * runs pay no cost:
 *
 *   use: { baseURL, headless: true, ...videoRecordingUse({ width: 600, height: 400 }) }
 *
 * `framing` is the *effective* CSS size the clip should show. The capture
 * viewport is that size scaled by {@link VIDEO_ZOOM}, which is the same factor
 * `applyVideoZoom()` zooms the page by, so the recorded frame shows exactly
 * `framing` worth of layout at full retina density. Recording 1:1 instead would
 * yield a video at CSS-pixel resolution, which looks soft on a retina display.
 */
export function videoRecordingUse(framing: VideoFraming) {
  if (!recording) return {};

  const size = { width: framing.width * VIDEO_ZOOM, height: framing.height * VIDEO_ZOOM };
  return { viewport: size, video: { mode: "on" as const, size } };
}
