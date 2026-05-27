import { expect, test } from "@playwright/test";

test.describe("Image Viewer", () => {
  test.setTimeout(120_000);

  test("opens a larger viewer from a MathNet image-list thumbnail", async ({ page }) => {
    await page.goto("/?dataset=mathnet-image-sample");
    await page.waitForSelector(".sift-table-container", { timeout: 90_000 });
    await page.waitForSelector(".sift-cell-image-thumb-button", { timeout: 90_000 });

    const multiImageCellIndex = await page
      .locator(".sift-cell-image")
      .evaluateAll((cells) =>
        cells.findIndex(
          (cell) => cell.querySelectorAll(".sift-cell-image-thumb-button").length > 1,
        ),
      );
    expect(multiImageCellIndex).toBeGreaterThanOrEqual(0);

    const imageCell = page.locator(".sift-cell-image").nth(multiImageCellIndex);
    await expect
      .poll(() => imageCell.locator(".sift-cell-image-thumb-button").count(), {
        timeout: 30_000,
      })
      .toBeGreaterThan(1);

    const thumbButton = imageCell.locator(".sift-cell-image-thumb-button").first();
    const thumb = thumbButton.locator(".sift-cell-image-thumb");
    const thumbBox = await thumb.boundingBox();
    expect(thumbBox).not.toBeNull();

    await thumbButton.click();

    const viewer = page.locator(".sift-image-viewer");
    await expect(viewer).toBeVisible();

    const viewerImg = viewer.locator(".sift-image-viewer-img");
    await expect(viewerImg).toBeVisible();

    const viewerBox = await viewerImg.boundingBox();
    expect(viewerBox).not.toBeNull();
    expect(viewerBox!.width).toBeGreaterThan(thumbBox!.width);
    expect(viewerBox!.height).toBeGreaterThan(thumbBox!.height);

    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  });
});
