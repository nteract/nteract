import { expect, test } from "@playwright/test";
import {
  executeCell,
  openNotebookRoom,
  waitForKernelStatus,
  waitForOutputContaining,
} from "./helpers";

test.use({
  viewport: { width: 1440, height: 900 },
  video: { mode: "on", size: { width: 1440, height: 900 } },
});

test.describe("add cell", () => {
  test("add a code cell via the toolbar", async ({ page }) => {
    test.setTimeout(180_000);

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    // Count cells before adding.
    const cells = page.locator("[data-cell-type]");
    const before = await cells.count();

    // Let the empty notebook be visible for a moment.
    await page.waitForTimeout(1_000);

    // Add a code cell via the toolbar.
    await page.getByTestId("add-code-cell-button").click();

    // Wait for the new cell to appear.
    await expect(cells).toHaveCount(before + 1, { timeout: 30_000 });

    // Type some source into the freshly added cell so the video shows content.
    const newCell = page.locator('[data-cell-type="code"]').last();
    await expect(newCell).toBeVisible({ timeout: 10_000 });
    const editor = newCell.locator('.cm-content[contenteditable="true"]');
    await editor.click();
    await editor.pressSequentially("print('hello from a new cell')", { delay: 40 });

    // Run the cell and wait for its output to appear.
    await page.waitForTimeout(500);
    await executeCell(newCell);
    await waitForOutputContaining(newCell, "hello from a new cell", 60_000);

    await page.waitForTimeout(1_500); // let the recording settle
  });
});
