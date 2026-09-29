import { expect, test, type Page } from "@playwright/test";
import { startHarness, blobBase, resourceBase } from "./harness.mjs";

let harness: Awaited<ReturnType<typeof startHarness>>;
let networkAttempts: string[];
let pageErrors: string[];
const sandbox = "allow-scripts allow-downloads allow-forms allow-pointer-lock";
const display = (mime: string, data: unknown) => ({
  output_type: "display_data",
  data: { [mime]: data },
});
function result(outputs: unknown[]) {
  return {
    content: [],
    structuredContent: {
      blob_base_url: blobBase,
      cell: {
        cell_id: "fixture",
        cell_type: "code",
        source: "SOURCE MUST STAY HIDDEN",
        execution_count: 1,
        status: "done",
        output_resource_base: resourceBase,
        outputs,
      },
    },
  };
}
async function send(page: Page, value: unknown) {
  await page.evaluate(
    (value) =>
      (window as unknown as { sendResult: (value: unknown) => Promise<void> }).sendResult(value),
    value,
  );
}
const widget = (page: Page) => page.frameLocator('iframe[title="Production MCP widget"]');
const output = (page: Page) => widget(page).frameLocator("iframe");

test.beforeAll(async () => {
  harness = await startHarness();
});
test.afterAll(async () => {
  await harness?.close();
});
test.beforeEach(async ({ page }) => {
  networkAttempts = [];
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  harness.reads.length = 0;
  harness.denied.clear();
  // No direct network access from either widget or nested output frame, even
  // if future code accidentally relaxes the CSP. Only the host loads HTTP.
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      request.frame() !== page.mainFrame() &&
      !(request.isNavigationRequest() && request.url() === `${harness.url}/widget`)
    ) {
      networkAttempts.push(request.url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.goto(harness.url);
  await page.waitForFunction(() => "sendResult" in window);
});

test.afterEach(async ({ page }, testInfo) => {
  await testInfo.attach("resource-reads", {
    body: JSON.stringify(harness.reads, null, 2),
    contentType: "application/json",
  });
  expect(networkAttempts).toEqual([]);
  expect(pageErrors).toEqual([]);
  if (!testInfo.title.startsWith("missing ")) {
    expect(
      await page.evaluate(() => (window as unknown as { diagnostics: unknown[] }).diagnostics),
    ).toEqual([]);
  }
});

test("Arrow bytes and plugins cross MCP; sorting and filtering work", async ({
  page,
}, testInfo) => {
  await send(page, result([display("application/vnd.apache.arrow.stream", harness.arrow)]));
  const frame = output(page);
  await expect(frame.locator(".sift-row:visible")).toHaveCount(3);
  const score = frame
    .locator(".sift-th")
    .filter({ has: frame.locator(".sift-th-label", { hasText: /^Score$/ }) });
  await score.locator(".sift-th-top").click();
  await expect(frame.locator('.sift-row[aria-rowindex="2"]:visible')).toContainText("Aster");
  await score.locator(".sift-th-top").click();
  await expect(frame.locator('.sift-row[aria-rowindex="2"]:visible')).toContainText("Cedar");
  await frame.locator(".sift-cat-row").filter({ hasText: "flower" }).click();
  await frame
    .locator(".sift-cat-popover-row")
    .filter({ hasText: "tree" })
    .getByRole("checkbox")
    .uncheck();
  await expect(frame.locator(".sift-row:visible")).toHaveCount(1);
  await expect(frame.locator('.sift-row[aria-rowindex="2"]:visible')).toContainText("Aster");
  await frame.locator(".sift-th-label").first().click();
  await frame.locator(".sift-filter-pill-x").click();
  await expect(frame.locator(".sift-row:visible")).toHaveCount(3);
  expect(harness.reads).toEqual(
    expect.arrayContaining([
      "nteract://renderer-assets/sift.js",
      "nteract://renderer-assets/sift.css",
      "nteract://renderer-assets/sift_wasm.wasm",
      resourceBase + harness.arrow.split("/").pop(),
    ]),
  );
  await page.screenshot({ path: testInfo.outputPath("arrow.png"), fullPage: true });
});

test("Plotly and Vega-Lite draw real marks", async ({ page }, testInfo) => {
  await send(
    page,
    result([
      display("application/vnd.plotly.v1+json", {
        data: [{ x: [1, 2, 3], y: [2, 4, 3], type: "scatter", mode: "markers" }],
        layout: { height: 260, autosize: true },
      }),
      display("application/vnd.vegalite.v5+json", {
        width: 220,
        height: 140,
        data: {
          values: [
            { x: "A", y: 2 },
            { x: "B", y: 5 },
          ],
        },
        mark: "bar",
        encoding: { x: { field: "x", type: "nominal" }, y: { field: "y", type: "quantitative" } },
      }),
    ]),
  );
  await expect(output(page).locator(".scatterlayer .point")).toHaveCount(3);
  await expect(output(page).locator(".vega-embed canvas")).toBeVisible();
  await expect
    .poll(() =>
      output(page)
        .locator(".vega-embed canvas")
        .evaluate((node) => {
          const canvas = node as HTMLCanvasElement;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let colored = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] > 0 && pixels[i + 2] > pixels[i] + 20) colored++;
          }
          return colored;
        }),
    )
    .toBeGreaterThan(100);
  expect(harness.reads).toEqual(
    expect.arrayContaining([
      "nteract://renderer-assets/plotly.js",
      "nteract://renderer-assets/vega.js",
    ]),
  );
  await page.screenshot({ path: testInfo.outputPath("plots.png"), fullPage: true });
});

test("mixed output keeps source hidden, images decoded, errors visible, and isolation intact", async ({
  page,
}, testInfo) => {
  await send(
    page,
    result([
      { output_type: "stream", name: "stdout", text: harness.text },
      display("text/html", "<h2>HTML smoke</h2>"),
      display(
        "image/svg+xml",
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"><text x="0" y="25">SVG smoke</text></svg>',
      ),
      display("image/png", harness.png),
      {
        output_type: "error",
        ename: "ValueError",
        evalue: "visible smoke failure",
        traceback: ["ValueError: visible smoke failure"],
      },
    ]),
  );
  const frame = output(page);
  await expect(frame.locator("body")).toContainText("stdout through an MCP blob");
  await expect(frame.getByRole("heading", { name: "HTML smoke" })).toBeVisible();
  await expect(frame.locator("svg").filter({ hasText: "SVG smoke" })).toBeVisible();
  await expect(frame.locator("body")).toContainText("ValueError: visible smoke failure");
  await expect
    .poll(() =>
      frame
        .locator("img")
        .evaluateAll(
          (images) =>
            images.every((image) => (image as HTMLImageElement).naturalWidth > 0) &&
            images.length > 0,
        ),
    )
    .toBe(true);
  await expect(widget(page).locator("body")).not.toContainText("SOURCE MUST STAY HIDDEN");
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", sandbox);
  await expect(widget(page).locator("iframe")).toHaveAttribute("sandbox", sandbox);
  expect(
    await frame.locator("body").evaluate(() => {
      try {
        return { parentAccessible: !!window.parent.document, origin: window.origin };
      } catch {
        return { parentAccessible: false, origin: window.origin };
      }
    }),
  ).toEqual({ parentAccessible: false, origin: "null" });
  const bounds = await widget(page).locator("iframe").boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: testInfo.outputPath("mixed.png"), fullPage: true });
});

test("Markdown produces semantic HTML", async ({ page }) => {
  await send(
    page,
    result([
      display("text/markdown", "# Markdown smoke\n\nA **bold** result.\n\n- first\n- second"),
    ]),
  );
  await expect(output(page).getByRole("heading", { name: "Markdown smoke" })).toBeVisible();
  await expect(output(page).locator("strong")).toHaveText("bold");
  await expect(output(page).locator("li")).toHaveCount(2);
});

for (const missing of ["sift_wasm.wasm", "plotly.js", "sift.css", "blob"]) {
  test(`missing ${missing} is a visible failure`, async ({ page }) => {
    const uri =
      missing === "blob"
        ? resourceBase + harness.text.split("/").pop()
        : `nteract://renderer-assets/${missing}`;
    harness.denied.add(uri);
    const outputs =
      missing === "sift_wasm.wasm" || missing === "sift.css"
        ? [display("application/vnd.apache.arrow.stream", harness.arrow)]
        : missing === "plotly.js"
          ? [display("application/vnd.plotly.v1+json", { data: [] })]
          : [{ output_type: "stream", name: "stdout", text: harness.text }];
    await send(page, result(outputs));
    await expect(widget(page).getByRole("alert")).toContainText("Unable to render output");
    expect(harness.reads).toContain(uri);
  });
}

test("empty and unstructured results clear stale output and collapse; later output recovers", async ({
  page,
}) => {
  for (const empty of [result([]), { content: [{ type: "text", text: "No structured result" }] }]) {
    await send(page, result([{ output_type: "stream", name: "stdout", text: "temporary output" }]));
    await expect(output(page).locator("body")).toContainText("temporary output");
    await send(page, empty);
    await expect(widget(page).locator("#root")).toBeEmpty();
    await expect(page.locator("iframe")).toHaveCSS("height", "0px");
  }
  await send(page, result([{ output_type: "stream", name: "stdout", text: "recovered output" }]));
  await expect(output(page).locator("body")).toContainText("recovered output");
});
