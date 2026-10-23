import { expect, test, type Page } from "@playwright/test";
import { openNotebookRoom, waitForCellCount } from "./helpers";

/**
 * Pins the vertical geometry of the run button against the first editor line.
 *
 * The button lives in the absolutely positioned state lane; the line lives in
 * CodeMirror. They are laid out independently, so this spec measures both
 * from the top of the code row and asserts the numbers nteract ships with.
 * All values are px, measured in headless Chromium at deviceScaleFactor 1.
 */

interface RowGeometry {
  lanePaddingTop: number;
  buttonCenter: number;
  lineCenter: number;
  rowHeight: number;
}

const TOLERANCE = 0.25;

// Default nteract geometry. `sm:` flips at 640px (40rem).
const COMPACT: RowGeometry = {
  lanePaddingTop: 16,
  buttonCenter: 28,
  lineCenter: 27.8,
  rowHeight: 61.6,
};
const WIDE: RowGeometry = {
  lanePaddingTop: 14,
  buttonCenter: 24,
  lineCenter: 25.8,
  rowHeight: 51.6,
};

const DEFAULT_CASES: Array<{ width: number; expected: RowGeometry }> = [
  { width: 480, expected: COMPACT },
  { width: 639, expected: COMPACT },
  // Exactly 40rem: the lane (`sm:`) and the editor's compact media query must
  // agree, or the button takes wide values while the line takes compact ones.
  { width: 640, expected: WIDE },
  { width: 641, expected: WIDE },
  { width: 900, expected: WIDE },
];

async function measureFirstCodeCell(page: Page): Promise<RowGeometry> {
  const cell = page.locator('[data-cell-type="code"]').first();
  await expect(cell.locator(".cm-line").first()).toBeVisible();
  return await cell.evaluate((cellElement) => {
    const query = (selector: string) => {
      const element = cellElement.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      return element;
    };
    const row = query('[data-slot="cell-code-row"]').getBoundingClientRect();
    const lane = query('[data-slot="cell-state-lane"]');
    const button = query('[data-testid="execute-button"]').getBoundingClientRect();
    const line = query(".cm-line").getBoundingClientRect();
    const centerOf = (rect: DOMRect) => (rect.top + rect.bottom) / 2 - row.top;

    return {
      lanePaddingTop: Number.parseFloat(getComputedStyle(lane).paddingTop),
      buttonCenter: centerOf(button),
      lineCenter: centerOf(line),
      rowHeight: row.height,
    };
  });
}

function expectGeometry(actual: RowGeometry, expected: RowGeometry, label: string) {
  for (const key of Object.keys(expected) as Array<keyof RowGeometry>) {
    expect(Math.abs(actual[key] - expected[key]), `${label} ${key}`).toBeLessThanOrEqual(TOLERANCE);
  }
}

test.describe("code cell run button geometry", () => {
  test("matches the shipped geometry at the default editor font size", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 540 });
    await openNotebookRoom(page, crypto.randomUUID());
    await waitForCellCount(page, 1);

    for (const { width, expected } of DEFAULT_CASES) {
      await page.setViewportSize({ width, height: 540 });
      const actual = await measureFirstCodeCell(page);
      expectGeometry(actual, expected, `${width}px`);
    }
  });

  test("keeps the button on the first line when a host shrinks the editor font", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 540 });
    await openNotebookRoom(page, crypto.randomUUID());
    await waitForCellCount(page, 1);

    const defaults = new Map<number, RowGeometry>();
    for (const { width } of DEFAULT_CASES) {
      await page.setViewportSize({ width, height: 540 });
      defaults.set(width, await measureFirstCodeCell(page));
    }

    // A 12px editor has a 16.8px line box instead of 19.6px. The lane must
    // move with it so the button-to-line offset is unchanged per breakpoint.
    await page.addStyleTag({ content: ":root { --nteract-editor-font-size: 12px; }" });

    for (const { width } of DEFAULT_CASES) {
      await page.setViewportSize({ width, height: 540 });
      const actual = await measureFirstCodeCell(page);
      const base = defaults.get(width)!;
      const lineBoxShrink = 19.6 - 16.8;

      expect(actual.rowHeight, `${width}px row height`).toBeLessThan(base.rowHeight);
      expect(
        Math.abs(actual.lanePaddingTop - (base.lanePaddingTop - lineBoxShrink / 2)),
        `${width}px lane padding`,
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(
        Math.abs(actual.lineCenter - actual.buttonCenter - (base.lineCenter - base.buttonCenter)),
        `${width}px line-to-button delta`,
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});
