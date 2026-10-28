import { expect, test } from "@playwright/test";

/**
 * The query seam over the fake in-memory session (`?dataset=query-fake`):
 * a 10k-row head of the 100k generated rows, a local brush, Apply to the
 * whole dataset, a committed pill, and clearing it.
 */
test.describe("Query session (fake)", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("/?dataset=query-fake");
    await page.waitForSelector(".sift-table-container");
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute(
      "data-value",
      "100,000 rows in whole dataset · 10,000 rows shown",
      { timeout: 30_000 },
    );
  });

  test("brush stays local, Apply re-queries, clearing the committed pill restores", async ({
    page,
  }) => {
    await expect(page.locator(".sift-apply-query")).toHaveCount(0);

    // Brush the Score histogram: a local filter over the shown rows.
    const scoreTh = page.locator(".sift-th", { hasText: "SCORE" });
    const summary = scoreTh.locator(".sift-th-summary");
    const box = await summary.boundingBox();
    if (!box) throw new Error("No summary bounding box");
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    const localPill = page.locator(".sift-filter-pill:not(.sift-filter-pill--committed)");
    await expect(localPill).toHaveCount(1);
    await expect(localPill).toContainText("Score");
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute(
      "data-value",
      "100,000 rows in whole dataset · 10,000 rows shown",
    );
    await expect(page.locator(".sift-stat-local")).toContainText(
      /of 10,000 shown rows · Filters use shown rows/,
    );
    const apply = page.locator(".sift-apply-query");
    await expect(apply).toHaveText("Apply filters to whole dataset");
    await expect(apply).toBeEnabled();

    // Apply: one query over the whole dataset replaces the resident rows.
    await apply.click();
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute(
      "data-value",
      /^[\d,]+ whole-dataset matches · [\d,]+ rows shown$/,
      { timeout: 15_000 },
    );
    const footer = await page.locator(".sift-stat-rows").getAttribute("data-value");
    const [, matches, shown] = footer!.match(
      /^([\d,]+) whole-dataset matches · ([\d,]+) rows shown$/,
    )!;
    const matched = Number(matches.replaceAll(",", ""));
    expect(matched).toBeGreaterThan(10_000);
    expect(matched).toBeLessThan(100_000);
    expect(Number(shown.replaceAll(",", ""))).toBe(10_000);

    const committed = page.locator(".sift-filter-pill--committed");
    await expect(committed).toHaveCount(1);
    await expect(committed).toHaveAttribute("title", "Applied to the whole dataset");
    await expect(committed).toContainText("score is between");
    await expect(page.locator(".sift-filter-pill")).toHaveCount(1);
    await expect(page.locator(".sift-apply-query")).toHaveCount(0);
    await expect(page.locator(".sift-stat-local")).toBeHidden();

    // Clearing the committed pill queries the source again, not the result.
    await committed.locator(".sift-filter-pill-x").click();
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute(
      "data-value",
      "100,000 rows in whole dataset · 10,000 rows shown",
      { timeout: 15_000 },
    );
    await expect(page.locator(".sift-filter-pill")).toHaveCount(0);
  });
});
