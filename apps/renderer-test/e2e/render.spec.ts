import { test, expect } from "@playwright/test";
import { fixtures } from "../src/fixtures";

const FIXTURE_COUNT = fixtures.length;

test.describe("Renderer plugin fixtures", () => {
  let consoleProblems: string[];

  test.beforeEach(async ({ page }) => {
    consoleProblems = [];
    page.on("console", (message) => {
      const type = message.type();
      if (type !== "error" && type !== "warning") return;
      const text = message.text();
      if (text === "Allow attribute will take precedence over 'allowfullscreen'.") return;
      consoleProblems.push(`[${type}] ${text}`);
    });
    await page.goto("/");
  });

  test.afterEach(() => {
    expect(consoleProblems).toEqual([]);
  });

  test("all fixtures render without errors", async ({ page }) => {
    for (let i = 0; i < FIXTURE_COUNT; i++) {
      const status = page.locator(`[data-testid="fixture-status-${i}"]`);
      await expect(status).toBeVisible({ timeout: 30_000 });
      await expect(status).toHaveAttribute("data-ready", "true", {
        timeout: 30_000,
      });
    }
  });

  test("iframes have non-zero height", async ({ page }) => {
    // Wait for all to be ready first
    for (let i = 0; i < FIXTURE_COUNT; i++) {
      const status = page.locator(`[data-testid="fixture-status-${i}"]`);
      await expect(status).toHaveAttribute("data-ready", "true", {
        timeout: 30_000,
      });
    }

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

  test("iframes contain rendered output DOM", async ({ page }) => {
    for (let i = 0; i < FIXTURE_COUNT; i++) {
      const status = page.locator(`[data-testid="fixture-status-${i}"]`);
      await expect(status).toHaveAttribute("data-ready", "true", {
        timeout: 30_000,
      });

      const root = page.frameLocator(`[data-testid="fixture-frame-${i}"] iframe`).locator("#root");
      await expect(root).toBeAttached();
      const snapshot = await root.evaluate((node) => ({
        childCount: node.childElementCount,
        htmlLength: node.innerHTML.length,
      }));

      expect(snapshot.childCount).toBeGreaterThan(0);
      expect(snapshot.htmlLength).toBeGreaterThan(20);
    }
  });
});
