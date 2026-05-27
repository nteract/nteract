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

    const naturalSize = await viewerImg.evaluate(
      (img) =>
        new Promise<{ width: number; height: number }>((resolve) => {
          const finish = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          if (img.complete && img.naturalWidth > 0) {
            finish();
          } else {
            img.addEventListener("load", finish, { once: true });
          }
        }),
    );

    const viewerBox = await viewerImg.boundingBox();
    expect(viewerBox).not.toBeNull();
    expect(viewerBox!.width).toBeGreaterThan(thumbBox!.width);
    expect(viewerBox!.height).toBeGreaterThan(thumbBox!.height);
    expect(viewerBox!.width).toBeLessThanOrEqual(naturalSize.width + 1);
    expect(viewerBox!.height).toBeLessThanOrEqual(naturalSize.height + 1);

    const meta = viewer.locator(".sift-image-viewer-meta");
    await expect(meta).toContainText(/^Image 1 of \d+/);
    const initialMeta = (await meta.textContent()) ?? "";
    const imageTotal = Number(initialMeta.match(/Image 1 of (\d+)/)?.[1] ?? 0);
    expect(imageTotal).toBeGreaterThan(1);

    const nextButton = viewer.locator(".sift-image-viewer-next");
    await expect(nextButton).toBeVisible();
    await nextButton.click();
    await expect(viewerImg).toHaveAttribute("data-sift-image-viewer-index", "1");
    await expect(meta).toContainText(`Image 2 of ${imageTotal}`);

    await page.keyboard.press("ArrowLeft");
    await expect(viewerImg).toHaveAttribute("data-sift-image-viewer-index", "0");
    await expect(meta).toContainText(`Image 1 of ${imageTotal}`);

    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  });
});
