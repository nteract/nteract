import { expect, test } from "@playwright/test";

test.describe("Category filter editor", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?dataset=polars-utf8view");
    await page.waitForSelector(".sift-table-container");
    await page.waitForSelector(".sift-row");
  });

  test("opens from a top category row without applying a filter", async ({ page }) => {
    const nameColumn = page.locator(".sift-th", { hasText: "NAME" });

    await expect(page.locator(".sift-filter-pill")).toHaveCount(0);
    await nameColumn.locator(".sift-cat-row").first().click();

    const search = page.locator(".sift-cat-popover-search");
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    await expect(page.locator(".sift-filter-pill")).toHaveCount(0);
  });

  test("keeps category search focused after toggling a value", async ({ page }) => {
    const nameColumn = page.locator(".sift-th", { hasText: "NAME" });
    await nameColumn.locator(".sift-cat-summary-trigger").click();

    const search = page.locator(".sift-cat-popover-search");
    await search.fill("a");

    await page.locator(".sift-cat-popover-row").first().click();

    await expect(search).toHaveValue("a");
    await expect(search).toBeFocused();
    await expect(page.locator(".sift-filter-pill")).toHaveCount(1);
  });
});
