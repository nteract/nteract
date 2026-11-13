// Local-only OIDC + real celld qualification for a Page's layout while its
// charts draw: a Page with two view embeds and text below them is opened,
// then reloaded, and the layout shift the browser reports (layout-shift
// entries without recent input) is summed for each. The reload reserves each
// chart's remembered height, so its sum stays under SHIFT_BOUND. The first
// open reserves the default; a chart with no height in its spec draws
// within a few px of it (fonts differ by platform), and the open's shift is
// reported, not gated. Each embed that drew away from the default is
// remembered at the height it drew. Then Maximize must record no height, and
// a reload at phone width is reported.
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
/** How far another platform's fonts may move a default chart's height. */
const DEFAULT_TOLERANCE = 4;

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

/**
 * Collect every layout-shift entry without recent input from the start of
 * each document `page` loads, into `window.__layoutShifts`. It runs as an
 * init script, so the observer is in place before anything paints and no
 * entry depends on the buffer or on when a late observer's callback runs.
 */
const recordLayoutShifts = (page) =>
  page.addInitScript(() => {
    const shifts = { total: 0, entries: [] };
    window.__layoutShifts = shifts;
    const describe = (source) => {
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
    };
    const take = (entries) => {
      for (const entry of entries) {
        if (entry.hadRecentInput) continue;
        shifts.total += entry.value;
        shifts.entries.push({
          value: Number(entry.value.toFixed(4)),
          at: Math.round(entry.startTime),
          sources: (entry.sources ?? []).map(describe),
        });
      }
    };
    const observer = new PerformanceObserver((list) => take(list.getEntries()));
    observer.observe({ type: "layout-shift", buffered: true });
    shifts.drain = () => take(observer.takeRecords());
  });

/** The layout shift the current document has reported so far. */
const layoutShift = (page) =>
  page.evaluate(() => {
    const shifts = window.__layoutShifts;
    shifts.drain();
    return { total: Number(shifts.total.toFixed(4)), entries: shifts.entries };
  });

const embeds = (page) => page.locator("wg-content section.wordgard-view-embed");
/** The chart Vega has finished in each embed. */
const rendered = (page) =>
  embeds(page).locator(
    "figure.pages-chart:not(.pages-view-placeholder)[data-chart-status=rendered]",
  );
const storedHeights = (page) =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem("nteract.pages.view-heights") ?? "null")?.heights ?? [],
  );

/** Open `url` in `page`, or reload it without one, and wait until both
 * charts are rendered (both embeds are inside the lifecycle's preload margin,
 * so both load without scrolling) and, when `stored` is given, until
 * localStorage holds exactly those `[viewId, px]` rows. Then a short settle,
 * so a late shift still counts; returns the shift and each embed's height. */
async function openAndMeasure(page, url = null, { stored = null } = {}) {
  if (url) await page.goto(url);
  else await page.reload();
  await expect(embeds(page)).toHaveCount(2, { timeout: 30000 });
  await expect(rendered(page)).toHaveCount(2, { timeout: 30000 });
  for (let i = 0; i < 2; i++)
    await expect(
      embeds(page).nth(i).locator(".pages-chart[data-chart-status=rendered]"),
    ).toHaveCount(1);
  const heights = () =>
    embeds(page).evaluateAll((sections) =>
      sections.map((section) => Math.round(section.getBoundingClientRect().height)),
    );
  if (stored) {
    const byView = (rows) => rows.toSorted(([a], [b]) => a.localeCompare(b));
    const expected = byView(stored(await heights()));
    await expect
      .poll(async () => byView((await storedHeights(page)).map((row) => [row[2], row[3]])), {
        timeout: 10000,
      })
      .toEqual(expected);
  }
  await page.waitForTimeout(750);
  const shift = await layoutShift(page);
  return { ...shift, heights: await heights() };
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
  await recordLayoutShifts(reader);
  // A chart that drew at the default needs no memory; each other one is
  // remembered at the height it drew.
  const stored = (heights) =>
    ["first", "second"]
      .map((viewId, i) => [viewId, heights[i]])
      .filter(([, px]) => px !== DEFAULT_RESERVE);
  const first = await openAndMeasure(reader, `${origin}/p/${pageId}`, { stored });
  report.measurements.firstOpen = first;
  assert.ok(
    Math.abs(first.heights[0] - DEFAULT_RESERVE) <= DEFAULT_TOLERANCE,
    `a default chart draws within ${DEFAULT_TOLERANCE}px of the default reserve (${first.heights[0]})`,
  );
  report.measurements.remembered = await storedHeights(reader);
  assert.ok(
    report.measurements.remembered.every((row) => row[1] === pageId),
    "rows are keyed by this Page",
  );
  complete(`first open (default reserve): layout shift ${first.total}`);

  const again = await openAndMeasure(reader, null, { stored });
  report.measurements.reload = again;
  await reader.screenshot({ path: `${output}/views-layout.png`, fullPage: true });
  assert.ok(
    again.total < SHIFT_BOUND,
    `a reload shifts the layout by ${again.total}: ${JSON.stringify(again.entries)}`,
  );
  complete(`reload (remembered heights): layout shift ${again.total}`);

  // A maximized chart writes no height, whatever the Page behind it does.
  const before = await storedHeights(reader);
  const firstEmbed = embeds(reader).first();
  await firstEmbed.hover();
  await firstEmbed.locator(".wordgard-diagram-maximize").click();
  const dialog = reader.locator("dialog.diagram-viewer");
  await expect(dialog).toBeVisible();
  await reader.waitForTimeout(500);
  assert.deepEqual(await storedHeights(reader), before, "a maximized chart records nothing");
  await reader.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  complete("Maximize records no height");

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
