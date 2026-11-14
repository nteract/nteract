// Local-only OIDC + real celld qualification for view embeds: an agent
// writes a source, a view and a view node through the real host, and the
// browser draws the chart from the source's Parquet data. Also measures the
// time from opening a Page to its first drawn chart, and the documents the
// Page's socket syncs, for one view and for ten.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { CHART_WORKER_CSP, CHUNK_PATH } from "../shared/chart-worker-csp.mjs";
import { decodeFrame } from "../sync/wire.mjs";
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
  const dir = await mkdtemp(path.join(tmpdir(), "pages-views-"));
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
  // One row past what a chart reads (vega-chart.mjs CHART_MAX_ROWS).
  await write("huge", "SELECT 'r' || (i % 7) AS region, i AS total FROM range(100001) t(i)");
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
  console.log(`[Views E2E] ${name}`);
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

/** Every sync frame the page's sockets carry, with its document. */
function watchFrames(page) {
  const frames = [];
  page.on("websocket", (ws) => {
    for (const event of ["framesent", "framereceived"])
      ws.on(event, ({ payload }) => {
        if (typeof payload === "string") return;
        const frame = decodeFrame(Buffer.from(payload));
        if (frame?.t === "sync") frames.push({ event, doc: frame.doc, at: Date.now() });
      });
  });
  return frames;
}

/** Evaluate `expression` in the running Worker whose script is `url`, over
 * a browser DevTools session, and return its value. */
async function evaluateInWorker(url, expression) {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const target = targetInfos.find((info) => info.type === "worker" && info.url === url);
    assert.ok(target, `no Worker target at ${url}`);
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    });
    const reply = new Promise((resolve) =>
      cdp.on("Target.receivedMessageFromTarget", (event) => {
        const message = JSON.parse(event.message);
        if (event.sessionId === sessionId && message.id === 1) resolve(message);
      }),
    );
    await cdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        // DevTools lets its own evaluations eval past a CSP unless told not to.
        params: { expression, returnByValue: true, allowUnsafeEvalBlockedByCSP: false },
      }),
    });
    const { result, error } = await reply;
    assert.equal(error, undefined, JSON.stringify(error));
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  } finally {
    await cdp.detach();
  }
}

async function signIn(email) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  people.set(`${email}-${people.size}`, page);
  page.on("pageerror", (error) => {
    report.errors.push(`${report.completed.length}: ${error.message}`);
    if (report.errors.length <= 3) (report.stacks ??= []).push(`${email}: ${error.stack}`);
  });
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) report.csp.push(message.text());
    else if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
      report.errors.push(`${report.completed.length}: console: ${message.text().slice(0, 500)}`);
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

async function createPage(title, markdown) {
  const catalog = (await tool(owner, "list_pages")).body;
  const made = await tool(owner, "create_page", { title, markdown, ...retry(catalog) });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  created.push(made.body.page_id);
  return made.body.page_id;
}
async function edit(pageId, operations) {
  const read = (await tool(owner, "read_page", { page_id: pageId })).body;
  return tool(owner, "edit_page", {
    page_id: pageId,
    revision: read.revision,
    ...retry(),
    operations,
  });
}
async function editOk(pageId, operations) {
  const result = await edit(pageId, operations);
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
const setSource = (pageId, source_id, asset_id, source_revision = null) =>
  editOk(pageId, [{ op: "set_source", source_id, name: source_id, asset_id, source_revision }]);
const spec = (name = "sales") => ({
  data: { name },
  mark: "bar",
  encoding: {
    x: { field: "region", type: "nominal" },
    y: { field: "total", type: "quantitative" },
  },
});
const setView = (pageId, view_id, data, fields = {}) =>
  edit(pageId, [
    {
      op: "set_view",
      view_id,
      title: `Chart ${view_id}`,
      media_type: VEGA_LITE,
      spec: spec(),
      data: { sales: data },
      view_revision: null,
      ...fields,
    },
  ]);
async function setViewOk(...args) {
  const result = await setView(...args);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
const placeView = (pageId, view_id) =>
  editOk(pageId, [{ op: "insert_node", node: { type: "view", attrs: { view_id } } }]);

const embeds = (page) => page.locator("wg-content section.wordgard-view-embed");
const embed = (page, viewId) =>
  page.locator(`section.wordgard-view-embed[data-view-id="${viewId}"]`);
const chartOf = (locator) => locator.locator("figure.pages-chart:not(.pages-view-placeholder)");
const marks = (locator) =>
  chartOf(locator).locator(".pages-chart-canvas path[role='graphics-symbol']");
async function expectDrawn(locator, labels) {
  await locator.scrollIntoViewIfNeeded();
  await expect(chartOf(locator)).toHaveAttribute("data-chart-status", "rendered", {
    timeout: 30000,
  });
  await expect(marks(locator)).toHaveCount(labels.length);
  const axis = chartOf(locator).locator(".pages-chart-canvas svg");
  for (const label of labels) await expect(axis).toContainText(label);
}
const sentence = (locator) => locator.locator(".pages-view-placeholder .pages-chart-message");

/** Open `pageId` in a fresh tab and measure the time to its first drawn chart
 * and the documents its socket syncs. */
async function measureOpen(pageId, label, count) {
  const tab = await signIn("dev@localhost");
  const frames = watchFrames(tab);
  const started = Date.now();
  await tab.goto(`${origin}/p/${pageId}`);
  await expect(tab.locator("figure.pages-chart[data-chart-status=rendered]").first()).toBeVisible({
    timeout: 30000,
  });
  const firstChart = Date.now() - started;
  for (let i = 0; i < count; i++) await expectDrawn(embeds(tab).nth(i), ["east", "west", "north"]);
  const allCharts = Date.now() - started;
  // Let the sockets settle so the count holds every document the Page syncs.
  await tab.waitForTimeout(1500);
  const documents = new Set(frames.map((frame) => frame.doc));
  report.measurements[label] = {
    firstChartMs: firstChart,
    allChartsMs: allCharts,
    syncDocuments: documents.size,
    syncFrames: frames.length,
  };
  await tab.context().close();
  return report.measurements[label];
}

try {
  owner = await signIn("dev@localhost");

  // Metadata follows even unused sources, without entering the content tree.
  {
    const id = await createPage("Usage report", "Usage across the team.");
    const asset = await upload(id, parquet.first);
    const before = (await tool(owner, "read_page", { page_id: id })).body;
    const tab = await signIn("dev@localhost");
    await tab.goto(`${origin}/p/${id}`);
    await expect(tab.locator(".document-title")).toHaveText("Usage report");
    const line = tab.getByRole("group", { name: "Sources", exact: true });
    await expect(line).toHaveCount(0);
    const margin = await tab
      .locator(".document-title")
      .evaluate((el) => getComputedStyle(el).marginBottom);
    await tab.screenshot({ path: `${output}/sources-zero.png` });
    await editOk(id, [
      {
        op: "set_source",
        source_id: "usage",
        name: "Usage",
        asset_id: asset,
        source_revision: null,
      },
    ]);
    // Existing discovery retries an absent sources document while the title
    // subscribes; no table/chart is needed to trigger the lookup.
    await expect(line).toContainText("Usage", { timeout: 75000 });
    await expect(line).toContainText("added just now");
    await expect(line.locator("svg")).toHaveCount(1);
    const firstTime = await line.locator("time").getAttribute("datetime");
    await editOk(id, [
      {
        op: "set_source",
        source_id: "usage",
        name: "Usage",
        asset_id: asset,
        source_revision: "1",
      },
    ]);
    await expect(line).toContainText("refreshed just now");
    await expect(line.locator("time")).not.toHaveAttribute("datetime", firstTime);
    await expect(line.locator("time")).toHaveAttribute("title", /^Refreshed /);
    await tab.screenshot({ path: `${output}/sources-one.png` });
    await editOk(id, [
      {
        op: "set_source",
        source_id: "sales",
        name: "Sales",
        asset_id: asset,
        source_revision: null,
      },
    ]);
    await expect(line.locator("li")).toHaveCount(2);
    await tab.setViewportSize({ width: 390, height: 844 });
    await tab.screenshot({ path: `${output}/sources-two-phone.png` });
    await editOk(id, [
      {
        op: "set_source",
        source_id: "usage",
        name: "Usage across all production organizations and regions",
        asset_id: asset,
        source_revision: "2",
      },
      {
        op: "set_source",
        source_id: "sales",
        name: "Sales across all production organizations and regions",
        asset_id: asset,
        source_revision: "1",
      },
    ]);
    await expect(line).toContainText("Usage across all");
    assert.ok(await line.evaluate((el) => el.scrollWidth <= el.clientWidth));
    assert.ok((await line.boundingBox()).height <= 44);
    await tab.screenshot({ path: `${output}/sources-long-phone.png` });
    await editOk(id, [
      {
        op: "set_source",
        source_id: "usage",
        name: "Usage",
        asset_id: asset,
        source_revision: "3",
      },
      {
        op: "set_source",
        source_id: "sales",
        name: "Sales",
        asset_id: asset,
        source_revision: "2",
      },
    ]);
    await editOk(id, [
      {
        op: "set_source",
        source_id: "targets",
        name: "Targets",
        asset_id: asset,
        source_revision: null,
      },
    ]);
    await expect(line).toHaveAttribute("data-source-count", "3");
    await expect(line.locator(".sources-line-summary")).toBeVisible();
    await expect(line.locator("ul")).toBeHidden();
    await tab.screenshot({ path: `${output}/sources-three-phone.png` });
    await tab.setViewportSize({ width: 1280, height: 900 });
    await expect(line.locator("ul")).toBeVisible();
    assert.deepEqual(await line.locator("li .sources-line-name").allTextContents(), [
      "Sales",
      "Targets",
      "Usage",
    ]);
    await tab.screenshot({ path: `${output}/sources-three-desktop.png` });
    const more = Array.from({ length: 61 }, (_, i) => ({
      op: "set_source",
      source_id: `extra-${i}`,
      name: `An unusually long source name ${i}`,
      asset_id: asset,
      source_revision: null,
    }));
    await editOk(id, more.slice(0, 5));
    await expect(line).toContainText("8 sources");
    await tab.screenshot({ path: `${output}/sources-eight-desktop.png` });
    await editOk(id, more.slice(5));
    await expect(line).toContainText("64 sources");
    await expect(line.locator("li")).toHaveCount(0);
    for (const width of [1280, 390]) {
      await tab.setViewportSize({ width, height: 900 });
      assert.ok(await line.evaluate((el) => el.scrollWidth <= el.clientWidth));
      assert.ok((await line.boundingBox()).height <= 44);
    }
    await tab.screenshot({ path: `${output}/sources-many-phone.png` });
    const after = (await tool(owner, "read_page", { page_id: id })).body;
    assert.equal(after.revision, before.revision);
    assert.equal(after.markdown, before.markdown);
    await tab.context().setOffline(true);
    await expect(line).toContainText("64 sources");
    await tab.context().setOffline(false);
    const empty = await createPage("No sources", "A plain document.");
    await tab.goto(`${origin}/p/${empty}`);
    await expect(tab.locator(".document-title")).toHaveText("No sources");
    await expect(line).toHaveCount(0);
    assert.equal(
      await tab.locator(".document-title").evaluate((el) => getComputedStyle(el).marginBottom),
      margin,
    );
    await tab.context().close();
    complete(
      "sources line: zero/first/refresh/three/many, narrow layout, offline retention, unchanged content and Page navigation",
    );
  }

  // (a) An agent writes a source, a view and its node; the Page draws it.
  const pageA = await createPage("Views qualification", "Sales by region, drawn from a source.");
  const first = await upload(pageA, parquet.first);
  const second = await upload(pageA, parquet.second);
  await setSource(pageA, "sales", first);
  await setViewOk(pageA, "follows", { source_id: "sales" });
  await setViewOk(pageA, "pinned", { source_id: "sales", revision: "1" }, { title: "Pinned" });
  await placeView(pageA, "follows");
  await placeView(pageA, "pinned");
  const reader = await signIn("dev@localhost");
  await reader.goto(`${origin}/p/${pageA}`);
  await expect(embeds(reader)).toHaveCount(2, { timeout: 20000 });
  await expectDrawn(embed(reader, "follows"), ["east", "west", "north"]);
  await expect(chartOf(embed(reader, "follows")).locator(".pages-chart-title")).toHaveText(
    "Chart follows",
  );
  await expectDrawn(embed(reader, "pinned"), ["east", "west", "north"]);
  await reader.screenshot({ path: `${output}/views-drawn.png`, fullPage: true });
  complete("set_source, set_view and insert_node draw the chart from the source's rows");

  // The chart Worker this Page runs is the built chunk, served through the
  // Pages Worker (worker/index.mjs) with the chart Worker's own CSP. Inside
  // it, the lockdown (viewer/chart-lockdown.mjs) has removed fetch and
  // EventSource; code from a string is refused only by that CSP, since the
  // lockdown alone leaves a function's constructor (scripts/chart-smoke.mjs).
  {
    const workers = reader.workers().filter((worker) => {
      const url = new URL(worker.url());
      return url.origin === origin && CHUNK_PATH.test(url.pathname);
    });
    assert.equal(
      workers.length,
      1,
      reader
        .workers()
        .map((worker) => worker.url())
        .join(" "),
    );
    const [chartWorker] = workers;
    const response = await reader.request.get(chartWorker.url());
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["content-security-policy"], CHART_WORKER_CSP);
    const csp = report.csp.length;
    // Evaluated through the DevTools protocol, attached to the Worker's
    // target: Playwright's own worker.evaluate calls the global eval, which
    // the lockdown has replaced.
    const probed = await evaluateInWorker(
      chartWorker.url(),
      `(() => {
        const attempt = (run) => {
          try {
            run();
            return "open";
          } catch (error) {
            return error.name;
          }
        };
        return {
          fetch: typeof self.fetch,
          EventSource: typeof self.EventSource,
          "fetch()": attempt(() => self.fetch("/escape/fetch")),
          "new EventSource()": attempt(() => new self.EventSource("/escape/events")),
          "Function from a string": attempt(() => (() => {}).constructor("return 1")()),
        };
      })()`,
    );
    assert.deepEqual(probed, {
      fetch: "undefined",
      EventSource: "undefined",
      "fetch()": "TypeError",
      "new EventSource()": "TypeError",
      "Function from a string": "EvalError",
    });
    // The refused string may report itself as a CSP violation; it's this probe's.
    report.csp.splice(csp);
  }
  complete(
    "the Page's chart Worker is the built chunk with its own CSP: no fetch or EventSource, no code from strings",
  );

  // The Page's grid card draws each view as the node's figure and loads no
  // chart code. The chart chunk is the only bundle holding Vega-Lite.
  {
    const deadline = Date.now() + 30_000;
    while (!(await tool(owner, "page_cards", { page_ids: [pageA] })).body.cards?.[pageA]) {
      assert.ok(Date.now() < deadline, "page_cards never answered the Page's card");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const grid = await signIn("dev@localhost");
    const chunks = [];
    grid.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/chunks/"))
        chunks.push(response.text().catch(() => ""));
    });
    await grid.goto(`${origin}/?grid=1`);
    const card = grid
      .locator(".index-card-link")
      .filter({ has: grid.locator(`.index-card-title[title="Views qualification"]`) });
    const figures = card.locator(".page-card-preview [data-card-placeholder=view]");
    await expect(figures.first()).toContainText(/follows|pinned/, { timeout: 30000 });
    await expect(card.locator(".pages-chart, .wordgard-view-embed")).toHaveCount(0);
    const bodies = await Promise.all(chunks);
    assert.ok(bodies.length > 0, "the grid loads its chunks");
    assert.ok(!bodies.some((body) => body.includes("vega-lite")), "a card loads no chart code");
    await grid.context().close();
  }
  complete("a grid card shows each view as its figure and loads no chart code");

  // (c) A second source revision redraws the following view and leaves the
  // pinned one.
  await setSource(pageA, "sales", second, "1");
  await expectDrawn(embed(reader, "follows"), ["east", "west", "south"]);
  await expectDrawn(embed(reader, "pinned"), ["east", "west", "north"]);
  complete("a new source revision redraws a following view; a pinned one stays");

  // (g) Maximize opens the chart in the diagram viewer, and Escape closes it.
  await embed(reader, "follows").hover();
  await chartOf(embed(reader, "follows")).locator(".wordgard-diagram-maximize").click();
  const dialog = reader.locator("dialog.diagram-viewer");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("path[role='graphics-symbol']")).toHaveCount(3);
  await reader.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  complete("Maximize opens and closes");

  // (e) A pinned revision the source's history no longer holds draws its
  // data empty, with a sentence naming the source.
  const pageE = await createPage("Views with a lost pin", "A pin past the history.");
  const assets = [await upload(pageE, parquet.first), await upload(pageE, parquet.second)];
  await setSource(pageE, "sales", assets[0]);
  await setViewOk(pageE, "lost", { source_id: "sales", revision: "1" });
  await placeView(pageE, "lost");
  for (let revision = 1; revision <= 50; revision++)
    await setSource(pageE, "sales", assets[revision % 2], String(revision));
  await reader.goto(`${origin}/p/${pageE}`);
  const lost = embed(reader, "lost");
  await lost.scrollIntoViewIfNeeded();
  await expect(lost.locator(".pages-view-note")).toContainText("sales", { timeout: 30000 });
  await expect(lost.locator(".pages-view-note")).toBeVisible();
  complete("a pin the source's history no longer holds shows a sentence naming the source");

  // (b) The same three calls while the tab is open, on a Page that had no
  // sources document, draw with no reload.
  const pageB = await createPage("Views while open", "The chart arrives while this tab is open.");
  await reader.goto(`${origin}/p/${pageB}`);
  await expect(reader.locator("wg-content").first()).toContainText("The chart arrives");
  const live = await upload(pageB, parquet.first);
  await setSource(pageB, "sales", live);
  await setViewOk(pageB, "live", { source_id: "sales" });
  await placeView(pageB, "live");
  await expectDrawn(embed(reader, "live"), ["east", "west", "north"]);
  complete("a view written while the tab is open draws with no reload");

  // (d) A view node whose view isn't on this Page: a paste from another Page.
  await reader.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await reader.evaluate(async () => {
    const html =
      '<figure class="wordgard-view" data-pages-view="" data-view-id="ghost" aria-label="View ghost">ghost</figure>';
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob(["ghost"], { type: "text/plain" }),
      }),
    ]);
  });
  await reader.locator("wg-content").first().click();
  await reader.keyboard.press("ControlOrMeta+End");
  await reader.keyboard.press("ControlOrMeta+v");
  const ghost = embed(reader, "ghost");
  await expect(ghost).toHaveCount(1, { timeout: 10000 });
  await ghost.scrollIntoViewIfNeeded();
  await expect(sentence(ghost)).toHaveText("This chart isn't on this Page.", { timeout: 30000 });
  complete("a pasted view this Page doesn't hold says it isn't on this Page");

  // (f) A source the renderer refuses at draw shows its error state, and the
  // Page stays usable.
  const huge = await upload(pageB, parquet.huge);
  await setSource(pageB, "huge", huge);
  await setViewOk(pageB, "huge", { source_id: "huge" });
  await placeView(pageB, "huge");
  const refused = embed(reader, "huge");
  await refused.scrollIntoViewIfNeeded();
  await expect(chartOf(refused)).toHaveAttribute("data-chart-status", "error", { timeout: 30000 });
  await expect(chartOf(refused).locator(".pages-chart-message")).toContainText("100,000");
  const first0 = reader.locator("wg-content").first();
  await first0.click();
  await reader.keyboard.press("End");
  await reader.keyboard.type(" Still editing.");
  await expect(first0).toContainText("Still editing.");
  await expect(reader.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
    timeout: 30000,
  });
  complete("a chart the renderer refuses shows its error, and the Page stays editable");

  // (h) Ten views draw; an eleventh is refused by the host.
  const pageH = await createPage("Ten views", "Ten charts from one source.");
  const shared = await upload(pageH, parquet.first);
  await setSource(pageH, "sales", shared);
  const ten = Array.from({ length: 10 }, (_, i) => `chart-${i}`);
  for (const id of ten) {
    await setViewOk(pageH, id, { source_id: "sales" });
    await placeView(pageH, id);
  }
  const eleventh = await setView(pageH, "chart-10", { source_id: "sales" });
  assert.equal(eleventh.status, 400, JSON.stringify(eleventh.body));
  assert.equal(eleventh.body.error?.code ?? eleventh.body.code, "view_limit");
  complete("an eleventh view is refused by the host");

  // Measurements: one view, then ten.
  const pageOne = await createPage("One view", "One chart.");
  await setSource(pageOne, "sales", await upload(pageOne, parquet.first));
  await setViewOk(pageOne, "only", { source_id: "sales" });
  await placeView(pageOne, "only");
  const one = await measureOpen(pageOne, "oneView", 1);
  const tenOpen = await measureOpen(pageH, "tenViews", 10);
  assert.ok(tenOpen.syncDocuments - one.syncDocuments === 9, JSON.stringify(report.measurements));
  complete("ten embeds draw; open-to-first-chart and synced documents measured");

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
