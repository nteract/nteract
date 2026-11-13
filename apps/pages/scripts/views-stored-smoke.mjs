// Local-only OIDC + real celld qualification for charts drawn from this tab's
// stored documents. A Page with a chart is opened once, so its view and
// sources documents land in the tab's replica database. On reload, with the
// connection discovery (/api/connect) held back, the chart draws from those
// stored documents. Released, the Page connects and an agent's later write
// redraws the chart. A new tab, which stored nothing, shows the chart pending
// (never missing or failed) until the connection answers. Measures the time
// from navigation to the drawn chart with the connection held.
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

/** Parquet files written by DuckDB, by name. */
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
  const dir = await mkdtemp(path.join(tmpdir(), "pages-views-stored-"));
  const files = {};
  const write = async (name, sql) => {
    const file = path.join(dir, `${name}.parquet`);
    connection.query(`COPY (${sql}) TO '${file}' (FORMAT PARQUET)`);
    files[name] = await readFile(file);
  };
  await write(
    "first",
    "SELECT * FROM (VALUES ('east', 3), ('west', 5), ('north', 2)) t(region, total)",
  );
  await write(
    "second",
    "SELECT * FROM (VALUES ('east', 9), ('west', 1), ('south', 4)) t(region, total)",
  );
  connection.close();
  await rm(dir, { recursive: true, force: true });
  return files;
}
const parquet = await writeParquet();

const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
const report = { completed: [], errors: [], csp: [], measurements: {} };
const people = new Map();
const created = [];
let owner;
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Views stored E2E] ${name}`);
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

async function signIn(email) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  people.set(`${email}-${people.size}`, page);
  page.on("pageerror", (error) => {
    report.errors.push(`${report.completed.length}: ${error.message}`);
  });
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) report.csp.push(message.text());
  });
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
async function upload(pageId, bytes) {
  const uploaded = await fetch(`${origin}/api/pages/${pageId}/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.owner}`, "Content-Type": PARQUET },
    body: bytes,
  });
  assert.ok([200, 201].includes(uploaded.status), await uploaded.clone().text());
  return (await uploaded.json()).asset_id;
}

/**
 * Hold every connection discovery `page` makes until `release()`, and record
 * whether a sync socket opened meanwhile. Released requests go through; the
 * route stays off after that.
 */
async function holdConnection(page) {
  const held = [];
  const sockets = [];
  let releasedAt;
  page.on("websocket", () => sockets.push(releasedAt === undefined ? "held" : "released"));
  const handler = (route) => held.push(route);
  await page.route("**/api/connect?*", handler);
  return {
    get requests() {
      return held.length;
    },
    socketsWhileHeld: () => sockets.filter((when) => when === "held").length,
    async release() {
      releasedAt = Date.now();
      await page.unroute("**/api/connect?*", handler);
      for (const route of held.splice(0)) await route.continue().catch(() => {});
    },
  };
}

const embed = (page, viewId) =>
  page.locator(`section.wordgard-view-embed[data-view-id="${viewId}"]`);
const chartOf = (locator) => locator.locator("figure.pages-chart:not(.pages-view-placeholder)");
const drawn = (locator) =>
  locator.locator("figure.pages-chart:not(.pages-view-placeholder)[data-chart-status=rendered]");
const sentence = (locator) => locator.locator(".pages-view-placeholder .pages-chart-message");
async function expectLabels(locator, labels) {
  const axis = chartOf(locator).locator(".pages-chart-canvas svg");
  for (const label of labels) await expect(axis).toContainText(label, { timeout: 30000 });
}

try {
  owner = await signIn("dev@localhost");

  const read = (await tool(owner, "list_pages")).body;
  const made = await tool(owner, "create_page", {
    title: "Charts from this tab",
    markdown: "Sales by region, drawn from this tab's stored documents.",
    ...retry(read),
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const pageId = made.body.page_id;
  created.push(pageId);
  const first = await upload(pageId, parquet.first);
  const second = await upload(pageId, parquet.second);
  await editOk(pageId, [
    { op: "set_source", source_id: "sales", name: "sales", asset_id: first, source_revision: null },
  ]);
  await editOk(pageId, [
    {
      op: "set_view",
      view_id: "sales",
      title: "Sales",
      media_type: VEGA_LITE,
      spec: {
        data: { name: "sales" },
        mark: "bar",
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
    { op: "insert_node", node: { type: "view", attrs: { view_id: "sales" } } },
  ]);

  // A first visit stores the Page, its sources document and its view.
  const reader = await signIn("dev@localhost");
  await reader.goto(`${origin}/p/${pageId}`);
  const chart = embed(reader, "sales");
  await chart.scrollIntoViewIfNeeded({ timeout: 30000 });
  await expect(drawn(chart)).toBeVisible({ timeout: 30000 });
  await expectLabels(chart, ["east", "west", "north"]);
  await expect(reader.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
    timeout: 30000,
  });
  // The replica writes received documents to IndexedDB after applying them.
  await reader.waitForTimeout(1500);
  complete("a first visit draws the chart and stores its documents");

  // Reload with the connection held back: the chart draws from storage.
  const connection = await holdConnection(reader);
  const started = Date.now();
  await reader.reload({ waitUntil: "commit" });
  await expect(reader.locator("wg-content").first()).toContainText("Sales by region", {
    timeout: 30000,
  });
  const bodyMs = Date.now() - started;
  await expect(drawn(embed(reader, "sales"))).toBeVisible({ timeout: 30000 });
  const chartMs = Date.now() - started;
  await expectLabels(embed(reader, "sales"), ["east", "west", "north"]);
  assert.ok(connection.requests > 0, "the Page asked for its connection");
  assert.equal(connection.socketsWhileHeld(), 0, "no sync socket opened while held");
  report.measurements.reloadHeld = { bodyMs, chartMs, heldRequests: connection.requests };
  await reader.screenshot({ path: `${output}/views-stored-held.png`, fullPage: true });
  complete(`with the connection held, the chart draws from storage in ${chartMs} ms`);

  // Released: the Page connects, and an agent's later write redraws.
  await connection.release();
  await expect(reader.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
    timeout: 30000,
  });
  await editOk(pageId, [
    {
      op: "set_source",
      source_id: "sales",
      name: "sales",
      asset_id: second,
      source_revision: "1",
    },
  ]);
  await expectLabels(embed(reader, "sales"), ["east", "west", "south"]);
  complete("released, the Page syncs: a new source revision redraws the chart");

  // A new tab stored nothing: the chart waits for the host, and never reads
  // as missing or failed meanwhile.
  const fresh = await signIn("dev@localhost");
  const freshConnection = await holdConnection(fresh);
  await fresh.goto(`${origin}/p/${pageId}`);
  // The Page itself needs the connection in a new tab: nothing renders.
  await fresh.waitForTimeout(3000);
  assert.equal(await drawn(embed(fresh, "sales")).count(), 0);
  assert.equal(await sentence(embed(fresh, "sales")).count(), 0, "no chart reads as missing");
  await freshConnection.release();
  const newTab = embed(fresh, "sales");
  await newTab.scrollIntoViewIfNeeded({ timeout: 30000 });
  await expect(drawn(newTab)).toBeVisible({ timeout: 30000 });
  await expectLabels(newTab, ["east", "west", "south"]);
  complete("a new tab waits for the connection and then draws");

  assert.deepEqual(report.csp, []);
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack ?? String(error);
  for (const [name, page] of people) {
    await page
      .screenshot({
        path: `${output}/failure-${name.replaceAll(/[^a-z0-9]/g, "-")}.png`,
        fullPage: true,
      })
      .catch(() => {});
  }
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
