import { expect, test } from "@playwright/test";

test.describe("host outside interaction dismissal", () => {
  test("closes the category filter popover when the notebook host releases interaction", async ({
    page,
  }) => {
    await page.goto("/?dataset=polars-utf8view");
    await page.waitForSelector(".sift-table-container", { timeout: 90_000 });

    await page
      .locator(".sift-cat-row", { hasText: /others/i })
      .first()
      .click();
    await expect(page.locator(".sift-cat-popover-search")).toBeVisible();

    await page.evaluate(() => {
      window.dispatchEvent(new Event("nteract:host-outside-interaction"));
    });

    await expect(page.locator(".sift-cat-popover-search")).toBeHidden();
  });

  test("closes the column context menu when the notebook host releases interaction", async ({
    page,
  }) => {
    await page.goto("/?dataset=polars-utf8view");
    await page.waitForSelector(".sift-table-container", { timeout: 90_000 });

    await page.locator(".sift-th").first().click({ button: "right" });
    await expect(page.getByText("Sort ascending")).toBeVisible();

    await page.evaluate(() => {
      window.dispatchEvent(new Event("nteract:host-outside-interaction"));
    });

    await expect(page.getByText("Sort ascending")).toBeHidden();
  });
});
