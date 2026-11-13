// Local-only OIDC + real celld qualification for a Page's layout while its
// charts draw: a Page with two view embeds and text below them is opened,
// then reloaded, and the layout shift the browser reports (layout-shift
// entries without recent input) is summed for each. The reload reserves each
// chart's remembered height, so its sum stays under SHIFT_BOUND. The first
// open reserves the default; a chart with no height in its spec draws at
// exactly that default, and the open's shift is reported, not gated. Then
// Maximize must leave the column in place and record no height, and a
// reload at phone width is reported. Chromium runs without
// --hide-scrollbars, so where the platform draws classic scrollbars (Linux)
// the scrollbar gutter counts too; macOS draws overlay scrollbars.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN;
assert.equal(new URL(origin).origin, origin);
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS;
const keys = JSON.parse(await readFile(process.env.PAGES_E2E_KEY_FILE, "utf8"));
await mkdir(output, { recursive: true });

const PARQUET = "application/vnd.apache.parquet";
const VEGA_LITE = "application/vnd.vegalite.v6+json";
/** The most layout shift a reload of a Page with drawn charts may report. */
const SHIFT_BOUND = 0.02;
/** wordgard.css's default reserve for a chart embed. */
const DEFAULT_RESERVE = 387;

async function writeParquet() {
  const require = createRequire(import.meta.url);
  const duck = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
  const dist = path.dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"));
  const db = await duck.createDuckDB(
    {
      mvp: { mainModule: `${dist}/duckdb-mvp.wasm`, mainWorker: "" },
      eh: { mainModule: `${dist}/duckdb-eh.wasm`, mainWorker: "" },
    },
    new duck.VoidLogger(),
    duck.NODE_RUNTIME,
  );
  await db.instantiate();
  const connection = db.connect();
  const dir = await mkdtemp(path.join(tmpdir(), "pages-views-layout-"));
  const file = path.join(dir, "sales.parquet");
  connection.query(
    `COPY (SELECT * FROM (VALUES ('east', 3), ('west', 5), ('north', 2)) t(region, total)) TO '${file}' (FORMAT PARQUET)`,
  );
  const bytes = await readFile(file);
  connection.close();
  await rm(dir, { recursive: true, force: true });
  return bytes;
}
const parquet = await writeParquet();

const browser = await chromium.launch({
  headless: true,
  // Scrollbars as the platform draws them, so where they're classic a
  // scrollbar appearing would move the column.
  ignoreDefaultArgs: ["--hide-scrollbars"],
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
const report = { completed: [], errors: [], measurements: {} };
const created = [];
let owner;
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Views layout E2E] ${name}`);
};
const retry = () => ({ nonce: crypto.randomUUID() });
async function api(page, url, body) {
  return page.evaluate(
    async ({ url, body }) => {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    { url, body },
  );
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });

async function signIn(context, email) {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  const begin = await context.request.get(origin + "/api/auth/login", { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", email);
  await page.goto(authorize.href, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 30000,
  });
  return page;
}

async function editOk(pageId, operations) {
  const read = (await tool(owner, "read_page", { page_id: pageId })).body;
  const result = await tool(owner, "edit_page", {
    page_id: pageId,
    revision: read.revision,
    ...retry(),
    operations,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

/** Sum of the layout-shift entries without recent input since navigation. */
const layoutShift = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        let total = 0;
        const entries = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            total += entry.value;
            entries.push({
              value: Number(entry.value.toFixed(4)),
              at: Math.round(entry.startTime),
              sources: (entry.sources ?? []).map((source) => {
                const node = source.node;
                const element = node?.nodeType === 1 ? node : node?.parentElement;
                const name = element
                  ? `${element.nodeName.toLowerCase()}.${String(element.getAttribute("class") ?? "")
                      .trim()
                      .replaceAll(/\s+/g, ".")}`
                  : "?";
                const rect = (r) =>
                  `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
                return `${node?.nodeType === 3 ? "text in " : ""}${name.slice(0, 80)} ${rect(source.previousRect)}->${rect(source.currentRect)}`;
              }),
            });
          }
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(() => resolve({ total: Number(total.toFixed(4)), entries }), 0);
      }),
  );

const embeds = (page) => page.locator("wg-content section.wordgard-view-embed");
const rendered = (page) =>
  page.locator(
    "section.wordgard-view-embed figure.pages-chart:not(.pages-view-placeholder)[data-chart-status=rendered]",
  );

/** Open `url` in `page`, or reload it without one, and wait for the first
 * chart and a settle; returns the shift and each embed's height. */
async function openAndMeasure(page, url = null) {
  if (url) await page.goto(url);
  else await page.reload();
  await expect(embeds(page)).toHaveCount(2, { timeout: 30000 });
  await expect(rendered(page).first()).toBeVisible({ timeout: 30000 });
  // The second chart sits below the fold; it draws when scrolled to, which
  // is input, so only the first chart's draw and the gutter count here.
  await page.waitForTimeout(1500);
  const shift = await layoutShift(page);
  const heights = await embeds(page).evaluateAll((sections) =>
    sections.map((section) => section.getBoundingClientRect().height),
  );
  return { ...shift, heights };
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await signIn(context, "dev@localhost");
  const catalog = (await tool(owner, "list_pages")).body;
  const made = await tool(owner, "create_page", {
    title: "Views layout",
    markdown: "Two charts above text that would move if they grew late.",
    ...retry(catalog),
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const pageId = made.body.page_id;
  created.push(pageId);
  const uploaded = await fetch(`${origin}/api/pages/${pageId}/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.owner}`, "Content-Type": PARQUET },
    body: parquet,
  });
  assert.ok([200, 201].includes(uploaded.status), await uploaded.clone().text());
  const assetId = (await uploaded.json()).asset_id;
  await editOk(pageId, [
    {
      op: "set_source",
      source_id: "sales",
      name: "sales",
      asset_id: assetId,
      source_revision: null,
    },
  ]);
  // The first chart has no height in its spec: it draws at vega-chart.mjs's
  // default, the size the embed's default reserve is measured from. The
  // second is shorter, so the first open moves what's under it and the
  // reload reserves its remembered height.
  for (const [viewId, size] of [
    ["first", {}],
    ["second", { height: 160 }],
  ]) {
    await editOk(pageId, [
      {
        op: "set_view",
        view_id: viewId,
        title: `Sales ${viewId}`,
        media_type: VEGA_LITE,
        spec: {
          data: { name: "sales" },
          mark: "bar",
          ...size,
          encoding: {
            x: { field: "region", type: "nominal" },
            y: { field: "total", type: "quantitative" },
          },
        },
        data: { sales: { source_id: "sales" } },
        view_revision: null,
      },
    ]);
    await editOk(pageId, [
      { op: "insert_node", node: { type: "view", attrs: { view_id: viewId } } },
    ]);
  }
  const paragraphs = Array.from(
    { length: 12 },
    (_, i) => `Paragraph ${i + 1} under the charts, long enough to push the Page past the window.`,
  );
  await editOk(pageId, [{ op: "insert_markdown", markdown: paragraphs.join("\n\n") }]);
  complete("a Page with two views and text below them");

  const reader = await signIn(context, "dev@localhost");
  const first = await openAndMeasure(reader, `${origin}/p/${pageId}`);
  report.measurements.firstOpen = first;
  assert.equal(first.heights[0], DEFAULT_RESERVE, "a default chart draws at the default reserve");
  complete(`first open (default reserve): layout shift ${first.total}`);

  const remembered = await reader.evaluate(() =>
    JSON.parse(localStorage.getItem("nteract.pages.view-heights")),
  );
  report.measurements.remembered = remembered;
  // The default chart drew at the default and needs no memory; the short one
  // is remembered at the height it drew.
  assert.deepEqual(
    remembered?.heights.map((row) => [row[1], row[2], row[3]]),
    [[pageId, "second", Math.round(first.heights[1])]],
  );
  const again = await openAndMeasure(reader);
  report.measurements.reload = again;
  await reader.screenshot({ path: `${output}/views-layout.png`, fullPage: true });
  assert.ok(
    again.total < SHIFT_BOUND,
    `a reload shifts the layout by ${again.total}: ${JSON.stringify(again.entries)}`,
  );
  complete(`reload (remembered heights): layout shift ${again.total}`);

  // Maximize hides the root's overflow; the gutter stays as it was, so the
  // Page behind holds its column and no second gap opens.
  const layout = () =>
    reader.evaluate(() => ({
      width: document.documentElement.clientWidth,
      article: Math.round(document.querySelector("article").getBoundingClientRect().x),
    }));
  const before = await layout();
  const firstEmbed = embeds(reader).first();
  await firstEmbed.hover();
  await firstEmbed.locator(".wordgard-diagram-maximize").click();
  const dialog = reader.locator("dialog.diagram-viewer");
  await expect(dialog).toBeVisible();
  const during = await layout();
  report.measurements.maximize = { before, during };
  assert.deepEqual(during, before);
  await reader.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const recorded = await reader.evaluate(() =>
    JSON.parse(localStorage.getItem("nteract.pages.view-heights")),
  );
  assert.ok(
    !recorded.heights.some((row) => row[2] === "first"),
    "a maximized chart records nothing",
  );
  complete("Maximize keeps the gutter and the column, and records no height");

  // At phone width the chart is narrower; its height, and so the reserve,
  // hold. Reported, not gated.
  await reader.setViewportSize({ width: 390, height: 844 });
  await openAndMeasure(reader);
  report.measurements.phoneReload = await openAndMeasure(reader);
  await reader.screenshot({ path: `${output}/views-layout-phone.png`, fullPage: true });
  complete(`phone width reload: layout shift ${report.measurements.phoneReload.total}`);
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack ?? String(error);
  throw error;
} finally {
  report.cleaned = true;
  for (const id of created.reverse()) {
    try {
      const read = (await tool(owner, "read_page", { page_id: id })).body;
      const catalog = (await tool(owner, "list_pages")).body;
      const deleted = await tool(owner, "delete_page", {
        page_id: id,
        revision: read.revision,
        ...retry(catalog),
      });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      const invoke = async (operation, args) => {
        const result = await tool(owner, operation, args);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return result.body;
      };
      await purgeTrashedFixture(invoke, id, async () => retry(await invoke("list_pages")));
    } catch (error) {
      report.cleaned = false;
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
