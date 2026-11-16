// Real local host, OIDC, source writes and view replicas. No live Page is used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { ANYWIDGET_MEDIA_TYPE } from "../shared/anywidget-view.mjs";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN ?? "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS ?? "test-results/sources-panel";
const keep = process.env.PAGES_PANEL_KEEP === "1";
const keys = process.env.PAGES_E2E_KEY_FILE
  ? JSON.parse(await readFile(process.env.PAGES_E2E_KEY_FILE, "utf8"))
  : null;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let pageId;
const report = { cleaned: false, passed: false, errors, anywidget: !!keys };
const nonce = () => crypto.randomUUID();
async function tool(operation, args = {}) {
  const response = await context.request.post(`${origin}/api/tools`, {
    headers: { Origin: origin },
    data: { operation, arguments: args },
  });
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  return body;
}
async function edit(operations) {
  // View writes own a separate document and must be alone in a request.
  if (operations.length > 1) {
    for (const operation of operations) await edit([operation]);
    return;
  }
  const read = await tool("read_page", { page_id: pageId });
  return tool("edit_page", {
    page_id: pageId,
    revision: read.revision,
    nonce: nonce(),
    operations,
  });
}
async function upload(bytes, contentType) {
  if (keys && contentType !== "application/vnd.apache.parquet") {
    const cap = await context.request.post(`${origin}/api/tools`, {
      headers: { Authorization: `Bearer ${keys.owner}` },
      data: {
        operation: "create_page_asset_upload",
        arguments: { page_id: pageId, content_type: contentType, size: bytes.length },
      },
    });
    assert.ok(cap.ok(), await cap.text());
    const bound = await cap.json();
    const uploaded = await context.request.post(bound.upload_url, {
      headers: bound.headers,
      data: bytes,
    });
    assert.ok(uploaded.ok(), await uploaded.text());
    return (await uploaded.json()).asset_id;
  }
  const result = await context.request.post(`${origin}/api/pages/${pageId}/assets`, {
    data: bytes,
    headers: { "Content-Type": contentType, Origin: origin },
  });
  assert.ok(result.ok(), await result.text());
  return (await result.json()).asset_id;
}
async function parquet() {
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
  const dir = await mkdtemp(path.join(tmpdir(), "sources-panel-"));
  try {
    connection.query(
      `COPY (SELECT * FROM (VALUES ('Platform', 8420), ('Research', 6180), ('Product', 3820)) t(team, calls)) TO '${dir}/usage.parquet' (FORMAT PARQUET)`,
    );
    return await readFile(`${dir}/usage.parquet`);
  } finally {
    connection.close();
    await rm(dir, { recursive: true, force: true });
  }
}
try {
  const login = await context.request.get(origin + "/api/auth/login", { maxRedirects: 0 });
  assert.equal(login.status(), 302);
  await page.goto(login.headers().location);
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 30000,
  });
  const made = await tool("create_page", {
    title: "Sources panel — live demo",
    markdown:
      "# Workspace usage\n\nA local Page for trying the Sources inspector. Open a source below the title, or use Sources in the … menu.\n\n## The data",
    nonce: nonce(),
  });
  pageId = made.page_id;
  await page.goto(`${origin}/p/${pageId}`);
  const toggle = page.locator(
    'summary[aria-label="Document actions"], button[aria-label="More page actions"]',
  );
  const openSources = async () => {
    await toggle.click();
    await page
      .getByRole("button", { name: "Sources", exact: true })
      .or(page.getByRole("menuitem", { name: "Sources", exact: true }))
      .click();
  };
  const panel = page.getByRole("dialog", { name: "Sources", exact: true });
  await expect(toggle).toBeVisible({ timeout: 30000 });
  await openSources();
  await expect(panel).toContainText("No sources yet", { timeout: 30000 });
  await expect(panel.getByRole("textbox", { name: "Find a source" })).toHaveCount(0);
  await expect(panel.locator(".sources-intro")).toHaveCount(0);
  const asset = await upload(await parquet(), "application/vnd.apache.parquet");
  await edit([
    {
      op: "set_source",
      source_id: "usage",
      name: "Workspace usage",
      asset_id: asset,
      source_revision: null,
    },
  ]);
  await expect(panel.getByRole("button", { name: /Workspace usage Parquet/ })).toBeVisible({
    timeout: 90000,
  });
  await edit([
    {
      op: "insert_node",
      node: {
        type: "dataframe",
        attrs: {
          title: "Usage table",
          binding: { source_id: "usage" },
          media_type: "application/vnd.apache.parquet",
        },
      },
    },
    {
      op: "insert_node",
      node: {
        type: "dataframe",
        attrs: {
          title: "Pinned baseline",
          binding: { source_id: "usage", revision: "1" },
          media_type: "application/vnd.apache.parquet",
        },
      },
    },
    {
      op: "set_view",
      view_id: "activity",
      title: "Tool activity",
      media_type: "application/vnd.vegalite.v6+json",
      view_revision: null,
      spec: {
        data: { name: "rows" },
        mark: "bar",
        encoding: {
          x: { field: "team", type: "nominal" },
          y: { field: "calls", type: "quantitative" },
        },
      },
      data: { rows: { source_id: "usage" } },
    },
    { op: "insert_node", node: { type: "view", attrs: { view_id: "activity" } } },
  ]);
  await panel.getByRole("button", { name: /Workspace usage Parquet/ }).click();
  await expect(panel).toContainText("Used on this Page · 3", { timeout: 30000 });
  await expect(panel.getByRole("region", { name: "Table schema" })).toBeVisible();
  await expect(panel.locator(".source-schema")).toContainText("3 rows · 2 columns");
  await expect(panel.locator(".source-schema")).toContainText("team");
  await expect(panel.locator(".source-preview .sift-root")).toHaveCount(0);
  await expect(panel.locator(".source-preview [data-source-revision]")).toHaveAttribute(
    "data-source-revision",
    "1",
  );
  await expect(panel.getByRole("textbox", { name: "Find a source" })).toHaveCount(0);
  await expect(panel).toContainText("Pinned · revision 1");
  await panel.getByRole("button", { name: /Tool activity Vega-Lite/ }).click();
  await expect(page.locator(".wordgard-view-embed.source-revealed")).toBeVisible();
  await expect(page.locator(".wordgard-view-embed.source-revealed")).toBeFocused();
  await panel.getByRole("button", { name: "Close sources panel" }).click();
  await expect(toggle).toBeFocused();
  const line = page
    .locator(".sources-line")
    .getByRole("button", { name: "Workspace usage", exact: true });
  await line.click();
  await expect(panel).toContainText("Set by");
  await page.screenshot({ path: `${output}/sources-panel-wide.png` });
  await edit([
    {
      op: "set_source",
      source_id: "usage",
      name: "Workspace usage",
      asset_id: asset,
      source_revision: "1",
    },
  ]);
  await expect(panel.locator(".source-preview [data-source-revision] ")).toHaveAttribute(
    "data-source-revision",
    "2",
    { timeout: 30000 },
  );
  await panel.getByRole("button", { name: "Expand sources" }).click();
  await expect(panel.locator(".source-preview .sift-root")).toBeVisible();
  await expect(panel.locator(".source-preview")).toContainText("Platform");
  const preview = await panel.locator(".source-table-preview").elementHandle();
  const previewBox = await preview.boundingBox();
  await panel.getByRole("button", { name: "Revisions", exact: true }).click();
  await expect(panel).toContainText("Revision 1");
  await expect(panel).toContainText("A connection is pinned here");
  await expect(panel.locator(".source-preview .sift-root")).toBeVisible();
  assert.equal(
    await panel
      .locator(".source-table-preview")
      .evaluate((el, original) => el === original, preview),
    true,
  );
  assert.equal((await preview.boundingBox()).y, previewBox.y);
  await panel.getByRole("button", { name: "Connections", exact: true }).click();
  assert.equal(
    await panel
      .locator(".source-table-preview")
      .evaluate((el, original) => el === original, preview),
    true,
  );
  // Sift owns the first Escape while filtering. The pane owns the next two:
  // detail -> list -> closed, matching Comments.
  const grid = panel.locator(".source-preview .sift-root");
  const histogram = grid.locator(".sift-th", { hasText: "CALLS" }).locator(".sift-th-summary");
  const box = await histogram.boundingBox();
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up();
  await expect(grid.locator(".sift-filter-pill")).toHaveCount(1);
  await grid.locator(".sift-viewport").focus();
  await page.keyboard.press("Escape");
  await expect(grid.locator(".sift-filter-pill")).toHaveCount(0);
  await expect(panel.locator(".source-inspector")).toBeVisible();
  await panel.getByRole("button", { name: "Narrow sources" }).click();
  await expect(panel.locator(".source-schema")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.locator(".source-inspector")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /Workspace usage Parquet/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(line).toBeFocused();

  // Asset types introduced with anywidget. No execution is needed to inspect.
  if (keys) {
    const js = await upload(
      Buffer.from('export default { render({el}) { el.textContent = "Local widget"; } };'),
      "text/javascript",
    );
    const css = await upload(Buffer.from(".widget { color: teal; }"), "text/css");
    const binary = await upload(Buffer.from([1, 2, 3, 4]), "application/octet-stream");
    await edit([
      {
        op: "set_source",
        source_id: "renderer",
        name: "Widget renderer",
        asset_id: js,
        source_revision: null,
      },
      {
        op: "set_source",
        source_id: "styles",
        name: "Widget styles",
        asset_id: css,
        source_revision: null,
      },
      {
        op: "set_source",
        source_id: "bytes",
        name: "Binary sample",
        asset_id: binary,
        source_revision: null,
      },
      {
        op: "set_view",
        view_id: "widget",
        title: "Custom widget",
        media_type: ANYWIDGET_MEDIA_TYPE,
        view_revision: null,
        spec: {
          module: { source_id: "renderer" },
          stylesheet: { source_id: "styles" },
          buffers: [{ source: { source_id: "bytes" }, path: ["buffer"] }],
          models: { child: { module: { source_id: "renderer", revision: "1" } } },
        },
      },
      {
        op: "insert_markdown",
        markdown: "## Custom view\n\nThis view reads JavaScript, CSS and a binary asset.",
      },
      { op: "insert_node", node: { type: "view", attrs: { view_id: "widget" } } },
    ]);
    await openSources();
    await panel.getByRole("button", { name: /Widget renderer JavaScript/ }).click();
    await expect(panel).toContainText("Used on this Page · 2");
    await expect(panel).toContainText("Anywidget · module");
    await expect(panel).toContainText("Anywidget · models.child.module");
    await expect(panel).toContainText("Pinned · revision 1");
    await panel
      .getByRole("button", { name: /Custom widget Anywidget · module Follows latest/ })
      .click();
    await expect(page.locator(".wordgard-view-embed.source-revealed")).toBeFocused();
    await edit([
      {
        op: "set_source",
        source_id: "renderer",
        name: "Widget renderer",
        asset_id: js,
        source_revision: "1",
      },
    ]);
    await panel.getByRole("button", { name: "Revisions", exact: true }).click();
    await expect(panel).toContainText("Revision 2");
    await expect(panel).toContainText("A connection is pinned here");
    await panel.getByRole("button", { name: "Connections", exact: true }).click();
    await page.screenshot({ path: `${output}/anywidget-sources-wide.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Anywidget · models.child.module");
    await page.screenshot({ path: `${output}/anywidget-sources-phone.png` });
    await panel
      .getByRole("button", { name: /Custom widget Anywidget · models.child.module/ })
      .click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".wordgard-view-embed.source-revealed")).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSources();
    await panel.getByRole("button", { name: /Widget styles CSS/ }).click();
    await expect(panel).toContainText("Anywidget · stylesheet", { timeout: 30000 });
    const dockWidth = (await panel.boundingBox()).width;
    await panel.getByRole("button", { name: "Expand sources" }).click();
    assert.ok((await panel.boundingBox()).width > dockWidth);
    await panel.getByRole("button", { name: "Narrow sources" }).click();
    await panel.getByRole("button", { name: "Next source" }).click();
    await expect(panel.locator(".source-inspector h3")).toHaveText("Workspace usage");
    await panel.getByRole("button", { name: "Previous source" }).click();
    await expect(panel.locator(".source-inspector h3")).toHaveText("Widget styles");
    await expect(panel.getByRole("button", { name: "Previous source" })).toBeFocused();
    await panel.getByRole("button", { name: "All sources" }).click();
    await expect(panel.locator(".source-inspector")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /Widget styles CSS/ })).toBeFocused();
    await panel.getByRole("button", { name: /Binary sample Binary/ }).click();
    await expect(panel).toContainText("Anywidget · buffers[0].source");
  } else await openSources();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("#page-comments")).toHaveAttribute("open", "");
  await openSources();
  await expect(page.locator("#page-comments")).not.toHaveAttribute("open", "");
  await panel.getByRole("button", { name: /Workspace usage Parquet/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  assert.equal(await panel.evaluate((el) => el.matches(":modal")), true);
  await page.screenshot({ path: `${output}/sources-panel-phone.png` });
  await page.keyboard.press("Escape");
  await expect(panel.locator(".source-inspector")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /Workspace usage Parquet/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await openSources();
  await panel.getByRole("button", { name: /Workspace usage Parquet/ }).click();
  await panel.getByRole("button", { name: /Usage table Table Follows latest/ }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".wordgard-dataframe-table.source-revealed")).toBeFocused();
  await openSources();
  if (keys) {
    await panel.getByRole("textbox", { name: "Find a source" }).fill("not a source");
    await expect(panel).toContainText("No matching sources.");
    await panel.getByRole("textbox", { name: "Find a source" }).fill("");
    await panel.getByRole("button", { name: /Widget styles CSS/ }).click();
    await edit([{ op: "delete_source", source_id: "styles", source_revision: "1" }]);
    await expect(panel).toContainText("This source isn't available on this Page", {
      timeout: 30000,
    });
    await expect(panel).toContainText("Anywidget · stylesheet");
    if (keep) {
      // Keep the demo readable: bind the widget to a new name after deletion.
      const cssReplacement = await upload(Buffer.from(".widget { color: teal; }"), "text/css");
      await edit([
        {
          op: "set_source",
          source_id: "theme",
          name: "Widget theme",
          asset_id: cssReplacement,
          source_revision: null,
        },
        {
          op: "set_view",
          view_id: "widget",
          title: "Custom widget",
          media_type: ANYWIDGET_MEDIA_TYPE,
          view_revision: "1",
          spec: {
            module: { source_id: "renderer" },
            stylesheet: { source_id: "theme" },
            buffers: [{ source: { source_id: "bytes" }, path: ["buffer"] }],
            models: { child: { module: { source_id: "renderer", revision: "1" } } },
          },
        },
      ]);
    }
  }
  assert.deepEqual(errors, []);
  Object.assign(report, { pageId, url: `${origin}/p/${pageId}`, passed: true });
  console.log(`Sources panel passed. ${origin}/p/${pageId}`);
} catch (error) {
  report.failure = String(error);
  await writeFile(`${output}/failure.html`, await page.content()).catch(() => {});
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  try {
    if (pageId && !keep) {
      await tool("delete_page", { page_id: pageId, nonce: nonce() });
      await purgeTrashedFixture(tool, pageId);
    }
    report.cleaned = !keep;
  } finally {
    await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
    await browser.close();
  }
}
