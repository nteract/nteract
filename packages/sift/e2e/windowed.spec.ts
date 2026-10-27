import { expect, test } from "@playwright/test";

/**
 * The engine over the resident windowed adapter (`?windowed=1`): cells and the
 * permutation arrive asynchronously, placeholders cover the gap, and nothing
 * is left unresolved once the view settles.
 */
test.describe("Windowed data (resident adapter)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?dataset=generated&windowed=1");
    await page.waitForSelector(".sift-table-container");
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute("data-value", /100,000/, {
      timeout: 15_000,
    });
  });

  // Released pooled rows are hidden, not cleared, so only shown rows count.
  async function settled(page: import("@playwright/test").Page) {
    await expect(page.locator(".sift-table-container")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".sift-row:visible .sift-cell-skeleton")).toHaveCount(0);
    await expect(page.locator(".sift-row-placeholder:visible")).toHaveCount(0);
  }

  test("loads, sorts, filters, and scrolls without leaving placeholders", async ({ page }) => {
    await settled(page);
    const firstCell = page.locator(".sift-row").first().locator(".sift-cell").first();
    await expect(firstCell).toHaveText("1");

    // Sort by Score descending: two header clicks.
    const scoreTh = page.locator(".sift-th").filter({
      has: page.locator(".sift-th-label", { hasText: /^Score$/ }),
    });
    await scoreTh.locator(".sift-th-top").click();
    await expect(scoreTh.locator(".sift-sort-arrow")).toContainText("↑");
    await scoreTh.locator(".sift-th-top").click();
    await expect(scoreTh.locator(".sift-sort-arrow")).toContainText("↓");
    await settled(page);
    const labels = await page.locator(".sift-th-label").allTextContents();
    const scoreCol = labels.indexOf("Score");
    const top = await page
      .locator(".sift-row")
      .first()
      .locator(".sift-cell")
      .nth(scoreCol)
      .textContent();
    const next = await page
      .locator(".sift-row")
      .nth(1)
      .locator(".sift-cell")
      .nth(scoreCol)
      .textContent();
    expect(Number.parseFloat(top ?? "0")).toBeGreaterThanOrEqual(Number.parseFloat(next ?? "0"));

    // Filter by the Verified boolean badge: the count drops, rows stay resolved.
    await page.locator(".sift-bool-true").first().click();
    await expect(page.locator(".sift-filter-pill")).toHaveCount(1);
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute(
      "data-value",
      / of 100,000 rows$/,
    );
    await settled(page);

    // Scroll deep into the result and let the window land.
    await page.locator(".sift-viewport").evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    await settled(page);
    await page.locator(".sift-viewport").evaluate((el) => {
      el.scrollTop = 0;
    });
    await settled(page);

    // Clearing the filter restores every row.
    await page.locator(".sift-filter-pill-x").click();
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute("data-value", "100,000 rows");
    await settled(page);
  });
});

test.describe("Windowed data: scrolling into unresolved rows", () => {
  test("holds the viewport and never repaints delivered rows as placeholders", async ({ page }) => {
    await page.goto("/?dataset=generated&windowed=1");
    await page.waitForSelector(".sift-table-container");
    await expect(page.locator(".sift-stat-rows")).toHaveAttribute("data-value", /100,000/, {
      timeout: 15_000,
    });
    await expect(page.locator(".sift-table-container")).toHaveAttribute("aria-busy", "false");

    // Jump deep into unresolved rows and sample every frame for two seconds:
    // windows land, measured heights replace estimates (rows above the viewport
    // too, which moves scrollTop), and the anchor keeps the same row at the top.
    const sample = await page.evaluate(
      () =>
        new Promise<{
          frames: number;
          topRows: number[];
          allPlaceholderAfterResolved: number;
        }>((resolve) => {
          const viewport = document.querySelector<HTMLElement>(".sift-viewport")!;
          viewport.scrollTop = 12_000;
          const start = performance.now();
          let frames = 0;
          let sawResolved = false;
          let allPlaceholderAfterResolved = 0;
          const topRows: number[] = [];
          const tick = () => {
            frames++;
            const vp = viewport.getBoundingClientRect();
            const header = document.querySelector<HTMLElement>(".sift-header")!.offsetHeight;
            const visible = [...document.querySelectorAll<HTMLElement>(".sift-row")].filter(
              (row) => {
                if (row.style.display === "none") return false;
                const r = row.getBoundingClientRect();
                return r.bottom > vp.top + header && r.top < vp.bottom;
              },
            );
            const placeholders = visible.filter((row) => row.querySelector(".sift-cell-skeleton"));
            if (visible.length > 0 && placeholders.length < visible.length) sawResolved = true;
            if (sawResolved && visible.length > 0) {
              if (placeholders.length === visible.length) allPlaceholderAfterResolved++;
              const top = visible.reduce((best, row) =>
                row.getBoundingClientRect().top < best.getBoundingClientRect().top ? row : best,
              );
              topRows.push(Number(top.getAttribute("aria-rowindex")));
            }
            if (performance.now() - start < 2000) requestAnimationFrame(tick);
            else resolve({ frames, topRows, allPlaceholderAfterResolved });
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(sample.frames).toBeGreaterThan(30);
    expect(sample.allPlaceholderAfterResolved).toBe(0);
    // The row at the top of the viewport stays put (±1 for a partially shown row).
    expect(sample.topRows.length).toBeGreaterThan(0);
    expect(Math.max(...sample.topRows) - Math.min(...sample.topRows)).toBeLessThanOrEqual(1);
    await expect(page.locator(".sift-row:visible .sift-cell-skeleton")).toHaveCount(0);
  });
});
