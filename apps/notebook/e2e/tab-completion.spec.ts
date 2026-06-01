import { expect, test } from "@playwright/test";
import {
  ensureCodeCell,
  getCellSource,
  openNotebookRoom,
  setCellSource,
  waitForKernelStatus,
} from "./helpers";

test.describe("code cell Tab behavior", () => {
  test("indents blank lines and accepts completions without leaving the editor", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await openNotebookRoom(page, crypto.randomUUID());
    await waitForKernelStatus(page, "idle", 120_000);

    const cell = await ensureCodeCell(page);

    await setCellSource(cell, "");
    await page.keyboard.press("Tab");

    await expect.poll(() => getCellSource(cell)).toMatch(/^\s+$/);
    await expect(page.locator(".cm-editor.cm-focused")).toBeVisible();

    await setCellSource(cell, "prin");
    await page.keyboard.press("Tab");

    await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press("Tab");

    await expect.poll(() => getCellSource(cell), { timeout: 15_000 }).toMatch(/^print\b/);
    await expect(page.locator(".cm-editor.cm-focused")).toBeVisible();
  });
});
