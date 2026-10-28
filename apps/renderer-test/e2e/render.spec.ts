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

  test("host Mermaid SVG admission blocks active markup and resource requests", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("example.invalid")) requests.push(request.url());
    });
    await page.goto("/?scenario=mermaid-host");
    await expect(page.locator("svg.pele")).toBeVisible();
    const admission = page.getByTestId("svg-admission");
    await expect(admission.locator("rect")).toBeAttached();
    await expect(page.getByRole("heading", { name: "Host SVG admission" })).toBeVisible();
    await expect(
      admission.locator("script,style,foreignObject,iframe,a,image,use,animate,[onload],[href]"),
    ).toHaveCount(0);
    await expect(admission.locator("path")).not.toHaveAttribute("marker-end");
    await expect(admission.locator("path")).not.toHaveAttribute("fill");
    await expect(admission.locator("rect")).toHaveCSS("position", "static");
    await expect(admission.locator("rect")).toHaveCSS("fill", "rgb(18, 52, 86)");
    await expect(page.locator("svg.pele a, svg.pele image")).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, "mermaidProbe"))).toBeUndefined();
    expect(requests).toEqual([]);
  });

  test("Mermaid survives the sandboxed plugin path, source toggles, and invalid edits", async ({
    page,
  }) => {
    const index = fixtures.findIndex((fixture) => fixture.label === "Mermaid (Markdown plugin)");
    await page.goto("/");
    const iframe = page.getByTestId(`fixture-frame-${index}`).locator("iframe");
    const frame = iframe.contentFrame();
    await expect(frame.locator("svg.pele")).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByRole("img", { name: "Notebook execution" })).toBeVisible();
    expect(await iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    await frame.getByRole("button", { name: "Show source" }).click();
    await expect(frame.locator("svg.pele")).toHaveCount(0);
    await expect(frame.locator("pre")).toContainText("A[Edit source] --> B[Display output]");
    await frame.getByRole("button", { name: "Show diagram" }).click();
    await expect(frame.locator("svg.pele")).toBeVisible();

    const replaceSource = async (source: string) => {
      await iframe.evaluate(
        (element, { source, index }) => {
          (element as HTMLIFrameElement).contentWindow?.postMessage(
            {
              type: "render",
              payload: {
                mimeType: "text/markdown",
                data: `\`\`\`mermaid\n${source}\n\`\`\``,
                outputId: `fixture-${index}-0`,
                replace: true,
              },
            },
            "*",
          );
        },
        { source, index },
      );
    };
    await replaceSource("flowchart LR\nA -->");
    await expect(frame.getByRole("status")).toContainText("Diagram unavailable:");
    await expect(frame.locator("pre")).toContainText("A -->");
    await replaceSource("sequenceDiagram\nAlice->>Bob: Hello café λ\nBob-->>Alice: Ready");
    await expect(frame.locator("svg.pele")).toContainText("Hello café λ");
    await expect(frame.getByText("Diagram unavailable:")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(frame.locator("svg.pele")).toBeVisible();
    await expect
      .poll(async () =>
        frame.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth),
      )
      .toBe(true);
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

  test("host context reaches the iframe and updates after mount", async ({ page }) => {
    await page.goto("/?scenario=host-context");
    await expect(page.getByTestId("host-context-status")).toHaveAttribute("data-ready", "true", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("host-context-status")).toHaveAttribute(
      "data-dark-mode",
      "true",
      {
        timeout: 30_000,
      },
    );

    const frame = page.frameLocator('[data-testid="host-context-frame"] iframe');
    await expect(frame.locator("#host-context-probe")).toContainText("Host context probe", {
      timeout: 30_000,
    });

    const contextDetails = await frame.locator("html").evaluate((html) => {
      const style = getComputedStyle(html);
      return {
        theme: html.getAttribute("data-theme"),
        probe: style.getPropertyValue("--nteract-host-context-probe").trim(),
        hostWidth: style.getPropertyValue("--nteract-host-width").trim(),
        hostMaxHeight: style.getPropertyValue("--nteract-host-max-height").trim(),
      };
    });

    expect(contextDetails).toMatchObject({
      theme: "dark",
      probe: "#123456",
      hostMaxHeight: "420px",
    });
    expect(contextDetails.hostWidth).toMatch(/^\d+px$/);
    expect(Number.parseInt(contextDetails.hostWidth, 10)).toBeGreaterThan(0);
  });

  test("vanilla output embed renders markdown, stream, and blob-backed HTML", async ({ page }) => {
    await page.goto("/?scenario=vanilla-embed");
    const status = page.getByTestId("vanilla-embed-status");
    await expect(status).toHaveAttribute("data-dark-mode", "true", { timeout: 30_000 });

    const iframe = page.frameLocator('[data-testid="vanilla-embed-frame"] iframe');
    const body = iframe.locator("body");
    await expect(body).toContainText("vanilla stream before", { timeout: 30_000 });
    await expect(body).toContainText("Vanilla Markdown", { timeout: 30_000 });
    await expect(body).toContainText("Rendered by the framework-agnostic embed API", {
      timeout: 30_000,
    });
    await expect(body).toContainText("a", { timeout: 30_000 });
    await expect(body).toContainText("4", { timeout: 30_000 });

    const root = iframe.locator("#root");
    const snapshot = await root.evaluate((node) => ({
      childCount: node.childElementCount,
      htmlLength: node.innerHTML.length,
    }));
    expect(snapshot.childCount).toBeGreaterThan(0);
    expect(snapshot.htmlLength).toBeGreaterThan(50);

    const box = await page.locator('[data-testid="vanilla-embed-frame"] iframe').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(20);

    const contextDetails = await iframe.locator("html").evaluate((html) => {
      const style = getComputedStyle(html);
      return {
        theme: html.getAttribute("data-theme"),
        probe: style.getPropertyValue("--vanilla-embed-probe").trim(),
      };
    });
    expect(contextDetails).toEqual({
      theme: "dark",
      probe: "#123456",
    });
  });

  test("vanilla output embed disposes and remounts cleanly", async ({ page }) => {
    await page.goto("/?scenario=vanilla-remount");
    await expect(page.getByTestId("vanilla-remount-status")).toHaveAttribute(
      "data-ready-count",
      "2",
      { timeout: 30_000 },
    );
    const body = page.frameLocator('[data-testid="vanilla-remount-frame"] iframe').locator("body");
    await expect(body).toContainText("vanilla remount 1", { timeout: 30_000 });
  });

  test("links inside shadow roots are forwarded instead of navigating the frame", async ({
    page,
  }) => {
    await page.goto("/?scenario=shadow-link");
    const status = page.getByTestId("shadow-link-status");
    await expect(status).toHaveAttribute("data-rendered", "true", { timeout: 30_000 });

    const frameNavigations: string[] = [];
    page.on("framenavigated", (navigated) => {
      if (navigated !== page.mainFrame()) frameNavigations.push(navigated.url());
    });

    const frame = page.frameLocator('[data-testid="shadow-link-frame"] iframe');
    const link = frame.locator("#shadow-link span");
    await expect(link).toBeVisible({ timeout: 30_000 });

    const url = "https://example.invalid/shadow-link";
    const linkClicks = (count: number) => Array(count).fill(url).join(" ");
    await link.click();
    await expect(status).toHaveAttribute("data-link-clicks", linkClicks(1));

    // Frame messages arrive in order, so a later link click acts as a barrier
    // proving no double-click was forwarded for the link itself.
    await link.dblclick();
    await frame.locator("#shadow-text").dblclick();
    await link.click();
    await expect(status).toHaveAttribute("data-link-clicks", linkClicks(4));
    await expect(status).toHaveAttribute("data-double-clicks", "1");
    await expect(link).toBeVisible();
    expect(frameNavigations).toEqual([]);
  });
});
