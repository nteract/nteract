import { expect, test } from "@playwright/test";
import {
  executeCell,
  markKernelReady,
  openNotebookRoom,
  pauseForVideo,
  screenshot,
  waitForOutputContaining,
} from "./helpers";

test("via toolbar", async ({ page }) => {
  test.setTimeout(180_000);

  const notebookId = crypto.randomUUID();
  await openNotebookRoom(page, notebookId);
  await markKernelReady(page);

  const cells = page.locator("[data-cell-type]");
  const before = await cells.count();
  await pauseForVideo(page);
  await screenshot(page, "empty-notebook");

  await page.getByTestId("add-code-cell-button").click();
  await expect(cells).toHaveCount(before + 1, { timeout: 30_000 });
  await screenshot(page, "cell-added");

  const newCell = page.locator('[data-cell-type="code"]').last();
  await expect(newCell).toBeVisible({ timeout: 10_000 });
  const editor = newCell.locator('.cm-content[contenteditable="true"]');
  await editor.click();
  await page.keyboard.insertText("print('hello from a new cell')");
  await expect(editor).toContainText("hello from a new cell");

  await pauseForVideo(page, 500);
  await executeCell(newCell);
  await waitForOutputContaining(newCell, "hello from a new cell", 60_000);
  await screenshot(page, "output-rendered");

  await pauseForVideo(page, 1_500);
});
