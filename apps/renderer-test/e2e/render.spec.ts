import { test, expect } from "@playwright/test";
import { fixtures } from "../src/fixtures";

const FIXTURE_COUNT = fixtures.length;

test.describe("Renderer plugin fixtures", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("all fixtures render without errors", async ({ page }) => {
    for (let i = 0; i < FIXTURE_COUNT; i++) {
      const status = page.locator(`[data-testid="fixture-status-${i}"]`);
      await expect(status).toBeVisible({ timeout: 30_000 });
    }

    await expect(page.frameLocator("#fixture-0").locator("code")).toContainText(
      "Hello from the renderer test app.",
      { timeout: 30_000 },
    );
    await expect(page.frameLocator("#fixture-1").getByRole("heading", { name: "HTML Output" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.frameLocator("#fixture-2").getByText('"renderer-test"')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.frameLocator("#fixture-3").getByText("SVG Output")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.frameLocator("#fixture-4").getByRole("heading", { name: "Markdown Plugin" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.frameLocator("#fixture-5").getByRole("button", { name: "Zoom", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("iframes have non-zero height", async ({ page }) => {
    await expect(page.frameLocator("#fixture-4").getByRole("heading", { name: "Markdown Plugin" })).toBeVisible({
      timeout: 30_000,
    });

    const iframes = page.locator("iframe");
    const count = await iframes.count();
    expect(count).toBe(FIXTURE_COUNT);

    for (let i = 0; i < count; i++) {
      const iframe = iframes.nth(i);
      const box = await iframe.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThan(10);
    }
  });
});
