import { expect, test, type Page } from "@playwright/test";
import { cloudOutputParityExpectedMarkers } from "../../test/fixtures/cloud-output-parity";

test.describe("cloud renderer parity harness", () => {
  let consoleProblems: string[];

  test.beforeEach(async ({ page }) => {
    consoleProblems = [];
    page.on("console", (message) => {
      const type = message.type();
      if (type !== "error" && type !== "warning") return;
      const text = message.text();
      consoleProblems.push(`[${type}] ${text}`);
    });
  });

  test.afterEach(() => {
    expect(consoleProblems).toEqual([]);
  });

  test("renders the canonical cloud output fixture through shared notebook components", async ({
    page,
  }) => {
    await openParityHarness(page);

    await expect(page.locator('[data-slot="read-only-notebook"]')).toHaveAttribute(
      "data-cell-count",
      "9",
    );
    await expect(page.locator('[data-cell-id="code-streams"]')).toContainText(
      cloudOutputParityExpectedMarkers.stdout,
    );
    await expect(page.locator('[data-cell-id="code-streams"]')).toContainText(
      cloudOutputParityExpectedMarkers.stderr,
    );
    await expect(page.locator('[data-cell-id="traceback-cell"]')).toContainText(
      cloudOutputParityExpectedMarkers.traceback,
    );
    await expect(page.locator('[data-cell-id="image-json-output"]')).toContainText(
      cloudOutputParityExpectedMarkers.json,
    );
    await expect(page.locator('[data-cell-id="rich-mime-fallback"]')).toContainText(
      cloudOutputParityExpectedMarkers.fallback,
    );

    await expect(
      page.frameLocator('[data-cell-id="markdown-intro"] iframe').locator("body"),
    ).toContainText(cloudOutputParityExpectedMarkers.markdown, { timeout: 30_000 });
    await expect(
      page.frameLocator('[data-cell-id="html-output"] iframe').locator("body"),
    ).toContainText(cloudOutputParityExpectedMarkers.html, { timeout: 30_000 });
    await expect(
      page.frameLocator('[data-cell-id="svg-output"] iframe').locator("body"),
    ).toContainText(cloudOutputParityExpectedMarkers.svg, { timeout: 30_000 });
  });

  test("uses output document URLs for isolated frames without weakening the sandbox", async ({
    page,
  }) => {
    await openParityHarness(page);

    const iframes = page.locator('iframe[data-slot="isolated-frame"]');
    await expect(iframes.first()).toBeAttached({ timeout: 30_000 });
    const count = await iframes.count();
    expect(count).toBeGreaterThanOrEqual(4);

    for (let index = 0; index < count; index++) {
      const iframe = iframes.nth(index);
      await expect(iframe).toHaveAttribute(
        "src",
        /\/output-document\/frame\.html\?nteract_theme=light$/,
      );
      await expect(iframe).not.toHaveAttribute("srcdoc", /./);
      const sandbox = await iframe.getAttribute("sandbox");
      expect(sandbox?.split(/\s+/)).toContain("allow-scripts");
      expect(sandbox?.split(/\s+/)).not.toContain("allow-same-origin");
      await expect(iframe).toHaveAttribute("allow", "fullscreen *");
      await expect(iframe).not.toHaveAttribute("allowfullscreen", /./);
    }
  });

  test("propagates theme changes into cloud output document iframes", async ({ page }) => {
    await openParityHarness(page);

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(
      page.frameLocator('[data-cell-id="html-output"] iframe').locator("html"),
    ).toHaveAttribute("data-theme", "light", { timeout: 30_000 });

    await page.getByTitle("Dark theme").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      page.frameLocator('[data-cell-id="html-output"] iframe').locator("html"),
    ).toHaveAttribute("data-theme", "dark", { timeout: 30_000 });
  });

  test("resolves system theme through the shared cloud theme toggle", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openParityHarness(page);

    await expect(page.getByTestId("cloud-render-parity")).toHaveAttribute(
      "data-theme-mode",
      "system",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      page.frameLocator('[data-cell-id="html-output"] iframe').locator("html"),
    ).toHaveAttribute("data-theme", "dark", { timeout: 30_000 });

    await page.getByTitle("Light theme").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.getByTitle("System theme").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      page.frameLocator('[data-cell-id="html-output"] iframe').locator("html"),
    ).toHaveAttribute("data-theme", "dark", { timeout: 30_000 });
  });

  test("renders the Sift Arrow fixture through cloud-hosted renderer assets", async ({ page }) => {
    test.setTimeout(120_000);
    await openParityHarness(page);

    const siftCell = page.locator('[data-cell-id="sift-arrow-output"]');
    await expect(siftCell).toContainText(cloudOutputParityExpectedMarkers.siftStream);
    await expect(siftCell).toContainText("Cloud Sift widget progress marker");
    await expect(siftCell.locator('[data-sift-output="true"]')).toBeVisible({ timeout: 60_000 });
    await expect(siftCell.locator('iframe[data-slot="isolated-frame"]')).toHaveCount(1);
    await expect(siftCell.locator('[data-sift-output="true"] iframe')).toHaveCSS(
      "pointer-events",
      "none",
    );
    await expect(siftCell.locator('[data-sift-output="true"] iframe')).toHaveAttribute(
      "src",
      /\/output-document\/frame\.html\?nteract_theme=light$/,
    );
    await expect(
      page.frameLocator('[data-cell-id="sift-arrow-output"] iframe').locator("body"),
    ).toContainText(cloudOutputParityExpectedMarkers.siftColumn, { timeout: 90_000 });
  });

  test("segments DOM output, interactive plugins, and Sift into separate lanes", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openParityHarness(page);

    const mixedCell = page.locator('[data-cell-id="mixed-interactive-sift-output"]');
    await expect(mixedCell).toContainText(cloudOutputParityExpectedMarkers.mixedStream);
    await expect(mixedCell.locator('iframe[data-slot="isolated-frame"]')).toHaveCount(2, {
      timeout: 60_000,
    });
    await expect(mixedCell.locator('[data-sift-output="true"]')).toHaveCount(1);
    await expect(mixedCell.locator('[data-sift-output="true"] iframe')).toHaveCSS(
      "pointer-events",
      "none",
    );

    const frameHandles = await mixedCell
      .locator('iframe[data-slot="isolated-frame"]')
      .elementHandles();
    const plotlyFrame = await frameHandles[0]?.contentFrame();
    const siftFrame = await frameHandles[1]?.contentFrame();
    if (!plotlyFrame || !siftFrame) {
      throw new Error("mixed output segmentation frames did not attach");
    }

    await expect(plotlyFrame.locator('[data-slot="plotly-output"]')).toBeVisible({
      timeout: 60_000,
    });
    await expect(plotlyFrame.locator(".js-plotly-plot")).toBeVisible({ timeout: 60_000 });
    await expect(siftFrame.locator("body")).toContainText(
      cloudOutputParityExpectedMarkers.siftColumn,
      { timeout: 90_000 },
    );
  });

  test("locks wheel scroll inside engaged Sift frames at table boundaries", async ({ page }) => {
    test.setTimeout(120_000);
    await openParityHarness(page);

    const siftCell = page.locator('[data-cell-id="sift-arrow-output"]');
    await expect(
      page.frameLocator('[data-cell-id="sift-arrow-output"] iframe').locator("body"),
    ).toContainText(cloudOutputParityExpectedMarkers.siftColumn, { timeout: 90_000 });

    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.dataset.testid = "scroll-boundary-spacer";
      spacer.style.height = "2400px";
      document.body.appendChild(spacer);
    });
    await siftCell.scrollIntoViewIfNeeded();

    await siftCell.getByRole("button", { name: "Click inside the table to scroll" }).click({
      force: true,
    });
    await expect(siftCell.locator('[data-sift-output="true"] iframe')).toHaveCSS(
      "pointer-events",
      "auto",
    );

    const viewport = page
      .frameLocator('[data-cell-id="sift-arrow-output"] iframe')
      .locator(".sift-viewport");
    await viewport.waitFor({ timeout: 30_000 });
    await expect(viewport).toHaveCSS("overscroll-behavior-y", "auto");
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight;
    });

    const before = await page.evaluate(() => window.scrollY);
    await viewport.dispatchEvent("wheel", { deltaY: 500, bubbles: true, cancelable: true });
    await page.waitForTimeout(250);
    await expect(page.evaluate(() => window.scrollY)).resolves.toBe(before);
  });
});

async function openParityHarness(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("cloud-render-parity")).toHaveAttribute("data-ready", "true", {
    timeout: 60_000,
  });
}
