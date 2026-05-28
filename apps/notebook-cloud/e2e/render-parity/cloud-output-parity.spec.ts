import { expect, test, type Frame, type Locator, type Page } from "@playwright/test";
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
      "11",
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
    await expect(siftCell).not.toContainText("Cloud Sift widget progress marker");
    await expect(siftCell.locator('iframe[data-slot="isolated-frame"]')).toHaveCount(2, {
      timeout: 60_000,
    });
    const widgetFrame = await findFrameContaining(
      page,
      siftCell,
      'iframe[data-slot="isolated-frame"]',
      '[data-widget-type="IntProgress"]',
    );
    await expect(widgetFrame.locator('[data-widget-type="IntProgress"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(siftCell.locator('[data-sift-output="true"]')).toBeVisible({ timeout: 60_000 });
    await expect(siftCell.locator('[data-sift-output="true"] iframe')).toHaveCSS(
      "pointer-events",
      "none",
    );
    await expect(siftCell.locator('[data-sift-output="true"] iframe')).toHaveAttribute(
      "src",
      /\/output-document\/frame\.html\?nteract_theme=light$/,
    );
    await expect(
      page
        .frameLocator('[data-cell-id="sift-arrow-output"] [data-sift-output="true"] iframe')
        .locator("body"),
    ).toContainText(cloudOutputParityExpectedMarkers.siftColumn, { timeout: 90_000 });
  });

  test("renders multiple progress widget views without falling back to plain text", async ({
    page,
  }) => {
    await openParityHarness(page);

    const progressCell = page.locator('[data-cell-id="widget-progress-output"]');
    await expect(progressCell).not.toContainText("Cloud IntProgress fallback marker");
    await expect(progressCell).not.toContainText("Cloud FloatProgress fallback marker");
    await expect(progressCell.locator('iframe[data-slot="isolated-frame"]')).toHaveCount(1, {
      timeout: 30_000,
    });

    const frame = await findFrameContaining(
      page,
      progressCell,
      'iframe[data-slot="isolated-frame"]',
      '[data-widget-type="FloatProgress"]',
    );
    await expect(frame.locator('[data-widget-type="IntProgress"]')).toContainText(
      cloudOutputParityExpectedMarkers.intProgress,
    );
    await expect(frame.locator('[data-widget-type="FloatProgress"]')).toContainText(
      cloudOutputParityExpectedMarkers.floatProgress,
    );
    await expect(
      frame.locator('[data-widget-type="IntProgress"] [role="progressbar"]'),
    ).toHaveAttribute("aria-valuenow", "100");
    await expect(
      frame.locator('[data-widget-type="FloatProgress"] [role="progressbar"]'),
    ).toHaveAttribute("aria-valuenow", "62.5");
    await expect(
      frame.locator('[data-widget-type="FloatProgress"] [role="progressbar"]'),
    ).toHaveAttribute("style", /--progress-bar-color:\s*#f97316/);
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

  test("keeps Sift in a standalone iframe for forced and collapsible boundaries", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openParityHarness(page);

    const forced = page.getByTestId("forced-sift-boundary");
    await expect(forced).toContainText(cloudOutputParityExpectedMarkers.boundaryStream);
    await expect(forced.locator('iframe[data-slot="isolated-frame"]')).toHaveCount(2, {
      timeout: 60_000,
    });
    await expect(forced.locator('[data-sift-output="true"]')).toHaveCount(1);

    const forcedFrameHandles = await forced
      .locator('iframe[data-slot="isolated-frame"]')
      .elementHandles();
    const forcedHtmlFrame = await forcedFrameHandles[0]?.contentFrame();
    const forcedSiftFrame = await forcedFrameHandles[1]?.contentFrame();
    if (!forcedHtmlFrame || !forcedSiftFrame) {
      throw new Error("forced Sift boundary frames did not attach");
    }
    await expect(forcedHtmlFrame.locator("body")).toContainText(
      cloudOutputParityExpectedMarkers.boundaryHtml,
      { timeout: 30_000 },
    );
    await expect(forcedSiftFrame.locator("body")).toContainText(
      cloudOutputParityExpectedMarkers.siftColumn,
      { timeout: 90_000 },
    );

    const collapsible = page.getByTestId("collapsible-sift-boundary");
    await expect(collapsible.getByRole("button", { name: "Hide outputs" })).toHaveCount(1);
    await expect(collapsible).toContainText(cloudOutputParityExpectedMarkers.boundaryStream);
    await expect(collapsible.locator('iframe[data-slot="isolated-frame"]')).toHaveCount(2, {
      timeout: 60_000,
    });
    await expect(collapsible.locator('[data-sift-output="true"]')).toHaveCount(1);
  });

  test("locks wheel scroll inside engaged Sift frames at table boundaries", async ({ page }) => {
    test.setTimeout(120_000);
    await openParityHarness(page);

    const siftCell = page.locator('[data-cell-id="sift-arrow-output"]');
    await expect(
      page
        .frameLocator('[data-cell-id="sift-arrow-output"] [data-sift-output="true"] iframe')
        .locator("body"),
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
      .frameLocator('[data-cell-id="sift-arrow-output"] [data-sift-output="true"] iframe')
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

async function findFrameContaining(
  page: Page,
  root: Locator,
  frameSelector: string,
  innerSelector: string,
  timeoutMs = 30_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  let frameCount = 0;

  while (Date.now() < deadline) {
    const frameHandles = await root.locator(frameSelector).elementHandles();
    frameCount = frameHandles.length;
    for (const handle of frameHandles) {
      const frame = await handle.contentFrame();
      if (!frame) continue;
      if ((await frame.locator(innerSelector).count()) > 0) {
        return frame;
      }
    }
    await page.waitForTimeout(100);
  }

  throw new Error(`No iframe containing ${innerSelector} found among ${frameCount} frames`);
}
