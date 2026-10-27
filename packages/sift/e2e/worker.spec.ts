import { expect, test } from "@playwright/test";

/**
 * The data side in a real module worker (`?worker=1`): the demo converts the
 * generated Arrow file to ten Parquet row groups, the worker decodes them, and
 * the engine renders over the message protocol.
 */
test.describe("Data worker", () => {
  test.setTimeout(60_000);

  // Released pooled rows are hidden, not cleared, so only shown rows count.
  async function settled(page: import("@playwright/test").Page) {
    await expect(page.locator(".sift-table-container")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".sift-row:visible .sift-cell-skeleton")).toHaveCount(0);
  }

  test("mounts, streams all row groups, sorts and filters", async ({ page }) => {
    await page.goto("/?dataset=generated&worker=1");
    await page.waitForSelector(".sift-table-container");
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute("data-value", "100,000 rows", {
      timeout: 30_000,
    });
    await expect(page.locator(".sift-status-ready")).toBeVisible();
    await settled(page);
    await expect(page.locator(".sift-row").first().locator(".sift-cell").first()).toHaveText("1");

    const scoreTh = page.locator(".sift-th").filter({
      has: page.locator(".sift-th-label", { hasText: /^Score$/ }),
    });
    await scoreTh.locator(".sift-th-top").click();
    await scoreTh.locator(".sift-th-top").click();
    await expect(scoreTh.locator(".sift-sort-arrow")).toContainText("↓");
    await settled(page);
    const labels = await page.locator(".sift-th-label").allTextContents();
    const scoreCol = labels.indexOf("Score");
    const top = Number.parseFloat(
      (await page.locator(".sift-row").first().locator(".sift-cell").nth(scoreCol).textContent()) ??
        "0",
    );
    const next = Number.parseFloat(
      (await page.locator(".sift-row").nth(1).locator(".sift-cell").nth(scoreCol).textContent()) ??
        "0",
    );
    expect(top).toBeGreaterThanOrEqual(next);

    await page.locator(".sift-bool-true").first().click();
    await expect(page.locator(".sift-filter-pill")).toHaveCount(1);
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute(
      "data-value",
      / of 100,000 rows$/,
    );
    await settled(page);
    await page.locator(".sift-filter-pill-x").click();
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute("data-value", "100,000 rows");
    await settled(page);
  });

  test("a tiny allocation cap stops the load and keeps the loaded rows", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    // Six megabytes: the first row groups fit, a later one trips the cap in Rust.
    await page.goto("/?dataset=generated&worker=1&cap=6000000");
    await page.waitForSelector(".sift-table-container");
    await expect(page.locator(".sift-load-failure")).toHaveText(
      /^Stopped loading: row group \d+ exceeded the worker memory limit .* · Showing loaded rows$/,
      { timeout: 30_000 },
    );
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    const footer = await page.locator(".sift-stat-rows").getAttribute("data-value");
    const rows = Number(footer!.replace(/[^\d]/g, ""));
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(100_000);
    await settled(page);
    // The rows still sort locally; the dead worker is not asked again for cells
    // that were already resolved, and nothing else on the page broke.
    await expect(page.locator(".sift-row").first().locator(".sift-cell").first()).toHaveText("1");
    expect(pageErrors).toEqual([]);
  });
});
