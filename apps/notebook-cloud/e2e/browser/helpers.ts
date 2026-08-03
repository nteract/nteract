import { expect, type Page } from "@playwright/test";
import { beginRecordedNavigation, markClipStart as markClipStartShared } from "@nteract/e2e-record";

// Recording is opt-in via NTERACT_E2E_RECORD=1, which also flips on the video
// viewport/zoom in playwright.config.ts. Everything mechanical lives in
// @nteract/e2e-record and is shared with apps/notebook; only the cloud-specific
// navigation and readiness helpers below are ours.
export { pauseForVideo, screenshot } from "@nteract/e2e-record";

const NAVIGATION_HELPERS = "openHomePage/signInWithLocalAuth";

/**
 * Low-level primitive: record "the trimmed clip starts *now*." A no-op when
 * not recording. Prefer a named helper below.
 */
export function markClipStart(): Promise<void> {
  return markClipStartShared(NAVIGATION_HELPERS);
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

/** Navigate to the signed-out home page (`/n`). */
export async function openHomePage(page: Page): Promise<void> {
  await beginRecordedNavigation(page);
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
