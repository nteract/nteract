import { expect, test } from "@playwright/test";
import {
  executeCell,
  markKernelReady,
  openNotebookRoom,
  screenshot,
  waitForOutputContaining,
} from "./helpers";

// Playwright's video recorder captures the viewport at its CSS pixel size and
// ignores deviceScaleFactor, so a 600px viewport yields a 600px-wide video that
// looks blurry upscaled on retina. Instead record at a real 1200x800 viewport
// (crisp, full-resolution) and CSS-zoom the page 2x below, so the framing still
// reads as the compact 600-wide layout while the video keeps 1200x800 pixels.
test.use({
  viewport: { width: 1200, height: 800 },
  video: { mode: "on", size: { width: 1200, height: 800 } },
});

test.describe("add cell", () => {
  test("add a code cell via the toolbar", async ({ page }) => {
    test.setTimeout(180_000);

    // Zoom the UI 2x so the 1200x800 recording frames the same content a compact
    // 600x400 window would, without sacrificing pixel resolution.
    await page.addInitScript(() => {
      const applyZoom = () => {
        document.documentElement.style.setProperty("zoom", "2");
      };
      if (document.documentElement) applyZoom();
      else document.addEventListener("DOMContentLoaded", applyZoom);
    });

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);

    // This flow runs a cell, so the clip should start once the kernel is idle.
    // markKernelReady asserts that state, then stamps the trim point.
    await markKernelReady(page);

    // Count cells before adding.
    const cells = page.locator("[data-cell-type]");
    const before = await cells.count();

    // Let the empty notebook be visible for a moment.
    await page.waitForTimeout(1_000);
    await screenshot(page, "01-empty-notebook");

    // Add a code cell via the toolbar.
    await page.getByTestId("add-code-cell-button").click();

    // Wait for the new cell to appear.
    await expect(cells).toHaveCount(before + 1, { timeout: 30_000 });
    await screenshot(page, "02-cell-added");

    // Type some source into the freshly added cell so the video shows content.
    const newCell = page.locator('[data-cell-type="code"]').last();
    await expect(newCell).toBeVisible({ timeout: 10_000 });
    const editor = newCell.locator('.cm-content[contenteditable="true"]');
    await editor.click();
    await page.keyboard.insertText("print('hello from a new cell')");
    await expect(editor).toContainText("hello from a new cell");

    // Run the cell and wait for its output to appear.
    await page.waitForTimeout(500);
    await executeCell(newCell);
    await waitForOutputContaining(newCell, "hello from a new cell", 60_000);
    await screenshot(page, "03-output-rendered");

    await page.waitForTimeout(1_500); // let the recording settle
  });
});
