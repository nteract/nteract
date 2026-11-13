// Browser check for the Vega-Lite renderer (viewer/vega-chart.mjs), with no
// Page and no stored shape. Builds scripts/fixtures/chart-fixture.mjs with
// esbuild, serves it from loopback under the viewer's own CSP, and draws a
// stacked horizontal bar chart in Chromium: hover shows Vega's tooltip, the
// theme switches light and dark, Maximize opens the diagram viewer, and a
// phone width keeps the chart inside its frame. Reports the renderer chunk's
// size and writes light and dark screenshots.
//
//   node scripts/chart-smoke.mjs        # or: node scripts/e2e.mjs chart
//
// Output goes to PAGES_E2E_OUTPUT (set by scripts/e2e.mjs) or
// test-results/chart-smoke.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { VIEWER_CSP } from "./viewer-chunks.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.PAGES_E2E_OUTPUT ?? path.join(app, "test-results/chart-smoke");
const site = path.join(output, "site");
await mkdir(site, { recursive: true });
const report = { completed: [], errors: [], csp: [], requests: [] };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Chart E2E] ${name}`);
};

// The same esbuild settings as the viewer (scripts/viewer-chunks.mjs): ESM,
// split chunks, minified, so the renderer's chunk is the one a Page would load.
const built = await build({
  entryPoints: { fixture: path.join(app, "scripts/fixtures/chart-fixture.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  splitting: true,
  outdir: site,
  chunkNames: "chunks/[hash]",
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
});
const rendererInput = "viewer/vega-chart.mjs";
const [chunk] = Object.entries(built.metafile.outputs).filter(
  ([file, meta]) => file.includes("/chunks/") && meta.entryPoint?.endsWith(rendererInput),
);
assert.ok(chunk, "the renderer builds as its own chunk");
const chunkBytes = await readFile(path.resolve(chunk[0]));
report.chunk = {
  file: path.relative(output, path.resolve(chunk[0])),
  bytes: chunkBytes.byteLength,
  gzip: gzipSync(chunkBytes, { level: 9 }).byteLength,
};
const entryBytes = await readFile(path.join(site, "fixture.js"));
assert.ok(entryBytes.byteLength < 20_000, "Vega stays out of the page that loads the renderer");
console.log(
  `[Chart E2E] renderer chunk ${(report.chunk.bytes / 1024).toFixed(1)} KiB, ` +
    `${(report.chunk.gzip / 1024).toFixed(1)} KiB gzip`,
);
await writeFile(
  path.join(site, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Chart fixture</title>
    <link rel="stylesheet" href="/fixture.css" />
  </head>
  <body>
    <main style="box-sizing: border-box; max-width: 760px; margin: 0 auto; padding: 32px 16px">
      <p>A Page paragraph before the chart, in the Page's own type.</p>
      <div id="chart"></div>
    </main>
    <script type="module" src="/fixture.js"></script>
  </body>
</html>
`,
);

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname;
  const file = path.join(site, name === "/" ? "index.html" : name);
  try {
    if (!file.startsWith(site)) throw new Error("outside the fixture");
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
      "Content-Security-Policy": VIEWER_CSP,
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
page.on("console", (message) => {
  if (/Content Security Policy|Refused to/i.test(message.text())) report.csp.push(message.text());
  else if (message.type() === "error") report.errors.push(`console: ${message.text()}`);
});
page.on("request", (request) => report.requests.push(request.url()));

const figure = page.locator("figure.pages-chart");
const frame = figure.locator(".pages-chart-frame");
const bars = frame.locator("path[role='graphics-symbol']");
const tooltip = page.locator(".vg-tooltip.visible");
const barFills = () => bars.evaluateAll((paths) => paths.map((p) => p.getAttribute("fill")));

async function hoverBar(index) {
  const box = await bars.nth(index).boundingBox();
  await page.mouse.move(0, 0);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await expect(tooltip).toBeVisible();
}

try {
  await page.goto(origin, { waitUntil: "load" });
  await expect(page.locator("body[data-fixture=ready]")).toBeAttached();
  await expect(figure).toHaveAttribute("data-chart-status", "rendered");
  await expect(figure.locator(".pages-chart-title")).toHaveText("Tool calls by client");
  // Four tools, three clients; move_page has no Codex row: eleven segments.
  await expect(bars).toHaveCount(11);
  // Vega-Lite's own axes and legend.
  const drawn = (await frame.innerText()).split("\n");
  for (const label of ["Tool", "Calls", "Client", "ChatGPT", "Claude", "Codex", "read_page"])
    assert.ok(drawn.includes(label), `${label} in ${drawn}`);
  const border = await frame.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.borderTopWidth, radius: style.borderTopLeftRadius };
  });
  assert.deepEqual(border, { width: "1px", radius: "6px" });
  complete("Draws a stacked horizontal bar chart with its title above one thin rounded frame");

  await hoverBar(0);
  const tip = await tooltip.innerText();
  for (const field of ["Tool", "Client", "Calls"]) assert.match(tip, new RegExp(field));
  await page.screenshot({ path: path.join(output, "chart-light.png") });
  complete("Hovering a bar shows Vega's tooltip with the bar's fields (chart-light.png)");

  const lightFills = new Set(await barFills());
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  });
  await expect
    .poll(async () => (await barFills()).some((fill) => !lightFills.has(fill)))
    .toBe(true);
  await expect(figure).toHaveAttribute("data-chart-status", "rendered");
  await hoverBar(0);
  await page.screenshot({ path: path.join(output, "chart-dark.png") });
  complete("The dark theme redraws from the Page's tokens and keeps the tooltip (chart-dark.png)");

  await page.mouse.move(0, 0);
  await figure.locator(".wordgard-diagram-maximize").click();
  const dialog = page.locator("dialog.diagram-viewer");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".diagram-viewer-title")).toHaveText("Tool calls by client");
  await expect(dialog.locator("path[role='graphics-symbol']")).toHaveCount(11);
  await page.screenshot({ path: path.join(output, "chart-maximized-dark.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  complete("Maximize opens the chart in the diagram viewer, and Escape closes it");

  await page.setViewportSize({ width: 375, height: 760 });
  await expect
    .poll(() =>
      frame.evaluate((element) => {
        const svg = element.querySelector(".pages-chart-canvas svg");
        return svg.getBoundingClientRect().right <= element.getBoundingClientRect().right;
      }),
    )
    .toBe(true);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  assert.equal(overflow, false, "the page doesn't scroll sideways at phone width");
  await page.screenshot({ path: path.join(output, "chart-narrow-dark.png"), fullPage: true });
  complete("At phone width the chart redraws inside its frame (chart-narrow-dark.png)");

  const foreign = report.requests.filter((url) => !url.startsWith(origin));
  assert.deepEqual(foreign, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.csp, []);
  complete("No page errors, Content-Security-Policy refusals or requests off the fixture origin");
} catch (error) {
  report.failure = error.stack || error.message;
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
}
