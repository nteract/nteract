import { expect, test } from "@playwright/test";

test.describe("Notebook Demo", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/notebook.html");
    // Wait for at least one table to mount
    await page.waitForSelector(".sift-table-container", { timeout: 10_000 });
  });

  test("renders multiple tables", async ({ page }) => {
    // beforeEach waits for the first table only; the others mount as their
    // copies of the file arrive, so poll instead of counting once.
    const tables = page.locator(".sift-table-container");
    await expect.poll(() => tables.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  });

  test("each table has its own status bar", async ({ page }) => {
    // Wait for data to load
    const statusBars = page.locator(".sift-stat-rows");
    await expect.poll(() => statusBars.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  });

  test("tables scroll independently", async ({ page }) => {
    // Wait for all data
    const firstStats = page.locator(".sift-stat-rows").first();
    await expect(firstStats).toHaveAttribute("data-value", /100,000/, {
      timeout: 10_000,
    });

    // Scroll the first table
    const firstViewport = page.locator(".sift-viewport").first();
    await firstViewport.evaluate((el) => (el.scrollTop = 3000));
    await page.waitForTimeout(200);

    // First table should have scrolled — its first visible row should not be row 0
    const firstRow = await firstViewport.evaluate((el) => el.scrollTop);
    expect(firstRow).toBeGreaterThan(0);

    // Second table should still be at top
    const secondViewport = page.locator(".sift-viewport").nth(1);
    const secondScroll = await secondViewport.evaluate((el) => el.scrollTop);
    expect(secondScroll).toBe(0);
  });

  test("page scrolls between tables", async ({ page }) => {
    // The page itself should be scrollable (multiple tables stacked)
    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(pageHeight).toBeGreaterThan(viewportHeight);
  });
});
