import { expect, test } from "@playwright/test";
import { ensureCodeCell, openNotebookRoom } from "./helpers";

test.describe("code cell placeholder layout", () => {
  test("keeps the empty placeholder aligned in a compact viewport", async ({ page }) => {
    await page.setViewportSize({ width: 624, height: 540 });
    await openNotebookRoom(page, crypto.randomUUID());

    const cell = await ensureCodeCell(page);
    const metrics = await cell.evaluate((cellElement) => {
      const rectFor = (selector: string) => {
        const element = cellElement.querySelector(selector);
        if (!element) throw new Error(`Missing ${selector}`);

        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          centerY: (rect.top + rect.bottom) / 2,
          height: rect.height,
          marginTop: style.marginTop,
        };
      };

      const row = rectFor('[data-slot="cell-code-row"]');
      const placeholder = rectFor(".cm-placeholder");
      const executeButton = rectFor('[data-testid="execute-button"]');
      const editor = rectFor(".cm-editor");

      return {
        editorMarginTop: editor.marginTop,
        placeholderToRowCenter: placeholder.centerY - row.centerY,
        placeholderToExecuteCenter: placeholder.centerY - executeButton.centerY,
        rowHeight: row.height,
      };
    });

    expect(metrics.editorMarginTop).toBe("0px");
    expect(Math.abs(metrics.placeholderToRowCenter)).toBeLessThanOrEqual(4);
    expect(Math.abs(metrics.placeholderToExecuteCenter)).toBeLessThanOrEqual(2);
    expect(metrics.rowHeight).toBeGreaterThan(50);
  });
});
