import { test, expect, type Page } from "@playwright/test";
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
  });

  test.afterEach(() => {
    expect(consoleProblems).toEqual([]);
  });

  async function waitForDefaultFixtures(page: Page) {
    await page.goto("/");
    for (let i = 0; i < FIXTURE_COUNT; i++) {
      const status = page.locator(`[data-testid="fixture-status-${i}"]`);
      await expect(status).toBeVisible({ timeout: 30_000 });
      await expect(status).toHaveAttribute("data-ready", "true", {
        timeout: 30_000,
      });
    }
  }

  test("all fixtures render without errors", async ({ page }) => {
    await waitForDefaultFixtures(page);
  });

  test("iframes have non-zero height", async ({ page }) => {
    await waitForDefaultFixtures(page);

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
    await waitForDefaultFixtures(page);

    for (let i = 0; i < FIXTURE_COUNT; i++) {
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

  test("fixtures expose their expected rendered text", async ({ page }) => {
    await waitForDefaultFixtures(page);

    for (let i = 0; i < FIXTURE_COUNT; i++) {
      const expectedText = fixtures[i]?.expectedText ?? [];
      const body = page.frameLocator(`[data-testid="fixture-frame-${i}"] iframe`).locator("body");
      for (const text of expectedText) {
        await expect(body).toContainText(text, { timeout: 30_000 });
      }
    }
  });

  test("delayed renderer bundle still renders markdown", async ({ page }) => {
    await page.goto("/?scenario=delayed-bundle");
    await expect(page.getByTestId("fixture-status-0")).toHaveAttribute("data-ready", "true", {
      timeout: 30_000,
    });
    const body = page.frameLocator('[data-testid="fixture-frame-0"] iframe').locator("body");
    await expect(body).toContainText("Markdown Plugin", { timeout: 30_000 });
    await expect(body).toContainText("Item 1", { timeout: 30_000 });
  });

  test("empty renderer CSS is a valid loaded bundle", async ({ page }) => {
    await page.goto("/?scenario=empty-css");
    await expect(page.getByTestId("fixture-status-0")).toHaveAttribute("data-ready", "true", {
      timeout: 30_000,
    });
    const body = page.frameLocator('[data-testid="fixture-frame-0"] iframe').locator("body");
    await expect(body).toContainText("Hello from the renderer test app.", { timeout: 30_000 });
  });

  test("remounting a plugin-backed frame renders again", async ({ page }) => {
    await page.goto("/?scenario=remount");
    await expect(page.getByTestId("remount-status")).toHaveAttribute("data-ready-count", "2", {
      timeout: 30_000,
    });
    const body = page.frameLocator('[data-testid="remount-frame"] iframe').locator("body");
    await expect(body).toContainText("Markdown Plugin", { timeout: 30_000 });
  });
});
