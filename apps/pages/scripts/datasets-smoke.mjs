// Local-only OIDC + real celld R2 + Sift table qualification for dataframe nodes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN;
assert.equal(new URL(origin).origin, origin);
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS;
const keys = JSON.parse(await readFile(process.env.PAGES_E2E_KEY_FILE, "utf8"));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
const PARQUET = "application/vnd.apache.parquet";
// A real two-row, three-column table (day, surface, events) written by pyarrow.
const parquet =
  "UEFSMRUEFTgVOEwVBBUAEgAACgAAADIwMjYtMTEtMDEKAAAAMjAyNi0xMS0wMhUAFRIVEiwVBBUQFQYVBhw2ACgKMjAyNi0xMS0wMhgKMjAyNi0xMS0wMRERAAAAAgAAAAQBAQMCFQQVJBUkTBUEFQASAAADAAAAbWNwBwAAAGJyb3dzZXIVABUSFRIsFQQVEBUGFQYcNgAoA21jcBgHYnJvd3NlchERAAAAAgAAAAQBAQMCFQQVIBUgTBUEFQASAAAqAAAAAAAAAAcAAAAAAAAAFQAVEhUSLBUEFRAVBhUGHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERAAAAAgAAAAQBAQMCFQQZTDUAGAZzY2hlbWEVBgAVDCUCGANkYXklAEwcAAAAFQwlAhgHc3VyZmFjZSUATBwAAAAVBCUCGAZldmVudHMAFgQZHBk8JgAcFQwZNQAGEBkYA2RheRUAFgQWxAEWxAEmXCYIHDYAKAoyMDI2LTExLTAyGAoyMDI2LTExLTAxEREAGSwVBBUAFQIAFQAVEBUCADwWKBkGGSYABAAAACYAHBUMGTUABhAZGAdzdXJmYWNlFQAWBBacARacASaMAibMARw2ACgDbWNwGAdicm93c2VyEREAGSwVBBUAFQIAFQAVEBUCADwWFBkGGSYABAAAACYAHBUEGTUABhAZGAZldmVudHMVABYEFswBFswBJqQDJugCHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERABksFQQVABUCABUAFRAVAgA8KQYZJgAEAAAAFqwEFgQmCBasBAAZHBgMQVJST1c6c2NoZW1hGKwCLy8vLy85Z0FBQUFRQUFBQUFBQUtBQXdBQmdBRkFBZ0FDZ0FBQUFBQkJBQU1BQUFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQU1BQUFCOEFBQUFRQUFBQUFRQUFBQ2cvLy8vQUFBQkFoQUFBQUFnQUFBQUJBQUFBQUFBQUFBR0FBQUFaWFpsYm5SekFBQUlBQXdBQ0FBSEFBZ0FBQUFBQUFBQlFBQUFBTmovLy84QUFBRUZFQUFBQUJnQUFBQUVBQUFBQUFBQUFBY0FBQUJ6ZFhKbVlXTmxBTXovLy84UUFCUUFDQUFHQUFjQURBQUFBQkFBRUFBQUFBQUFBUVVRQUFBQUdBQUFBQVFBQUFBQUFBQUFBd0FBQUdSaGVRQUVBQVFBQkFBQUFBQUFBQUE9ABggcGFycXVldC1jcHAtYXJyb3cgdmVyc2lvbiAyNi4wLjAZPBwAABwAABwAAADYAgAAUEFSMQ==";
const parquetBytes = Buffer.from(parquet, "base64");
// The same table with its "browser" surface renamed "desktop": another asset
// with the same shape. The name is as long, and still sorts before "mcp", so
// every offset and statistic stays valid.
const refreshedBytes = Buffer.from(
  parquetBytes.toString("latin1").replaceAll("browser", "desktop"),
  "latin1",
);
const report = { completed: [], errors: [], csp: [] };
const people = new Map();
const created = [];
let owner, viewer, pageId;
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Datasets E2E] ${name}`);
};
const retry = (value) => ({
  nonce: crypto.randomUUID(),
});
async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });
async function signIn(email, contextOptions = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
    ...contextOptions,
  });
  const page = await context.newPage();
  people.set(email, page);
  page.on("pageerror", (error) => {
    report.errors.push(`${report.completed.length}: ${error.message}`);
    if (report.errors.length <= 3) (report.stacks ??= []).push(`${email}: ${error.stack}`);
  });
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) report.csp.push(message.text());
    // The smoke's own refused API calls log "Failed to load resource".
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
async function editPage(operations) {
  const read = (await tool(owner, "read_page", { page_id: pageId })).body;
  return tool(owner, "edit_page", {
    page_id: pageId,
    revision: read.revision,
    ...retry(read),
    operations,
  });
}
const dataframe = (asset_id, title) => ({
  op: "insert_node",
  node: { type: "dataframe", attrs: { asset_id, ...(title && { title }) } },
});
const content = (page) => page.locator("wg-content").first();
// Each block has its own editor, so a table is in a later wg-content.
const tables = (page) => page.locator("wg-content section.wordgard-dataframe-table");
const markdownOf = async () =>
  (await tool(owner, "read_page", { page_id: pageId })).body.blocks
    .map((block) => block.markdown)
    .join("\n");

try {
  owner = await signIn("dev@localhost");
  viewer = await signIn("bob@localhost");
  const catalog = (await tool(owner, "list_pages")).body;
  const createdPage = await tool(owner, "create_page", {
    title: "Datasets qualification",
    markdown: "Usage by day, as a table readers can sort and filter.",
    ...retry(catalog),
  });
  assert.equal(createdPage.status, 200, JSON.stringify(createdPage.body));
  pageId = createdPage.body.page_id;
  created.push(pageId);
  report.pageId = pageId;
  const current = await api(owner, `/api/access?page=${pageId}`);
  const invited = await api(owner, `/api/access?page=${pageId}`, {
    action: "invite",
    email: "bob@localhost",
    role: "viewer",
    expected_revision: current.body.access.revision,
    nonce: crypto.randomUUID(),
  });
  assert.equal(invited.status, 200, JSON.stringify(invited.body));
  complete("Owner and viewer sessions on a new Page");

  // An agent's path: raw bytes with an API key, then insert_node.
  const uploaded = await fetch(`${origin}/api/pages/${pageId}/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.owner}`, "Content-Type": PARQUET },
    body: parquetBytes,
  });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const dataset = await uploaded.json();
  assert.equal(dataset.mime_type, PARQUET);
  assert.equal(dataset.size, parquetBytes.length);
  const read = await fetch(origin + dataset.asset_url, {
    headers: { Authorization: `Bearer ${keys.viewer}` },
  });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("content-type"), PARQUET);
  assert.match(read.headers.get("content-disposition"), /^attachment;/);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), parquetBytes);
  const denied = await fetch(`${origin}/api/pages/${pageId}/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.viewer}`, "Content-Type": PARQUET },
    body: parquetBytes,
  });
  assert.equal(denied.status, 403);
  complete("API-key Parquet upload; viewer reads it as a download and cannot upload");

  const inserted = await editPage([dataframe(dataset.asset_id, "Usage by day")]);
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  const [node] = inserted.body.result.edits;
  assert.deepEqual(node.attrs, {
    asset_id: dataset.asset_id,
    src: dataset.asset_url,
    media_type: PARQUET,
    title: "Usage by day",
  });
  const blocks = (await tool(owner, "read_page", { page_id: pageId })).body.blocks;
  assert.equal(
    blocks.find((block) => block.node_id === node.node_id).markdown,
    `[Dataframe: Usage by day](${dataset.asset_url})`,
  );
  for (const page of [owner, viewer]) {
    await page.goto(`${origin}/p/${pageId}`);
    await expect(tables(page)).toHaveCount(1, { timeout: 15000 });
    const table = tables(page).first();
    await expect(table).toHaveAttribute("aria-label", "Usage by day");
    await expect(table.locator(".sift-root").first()).toBeVisible({ timeout: 20000 });
    for (const text of ["surface", "events", "browser", "mcp"])
      await expect(table).toContainText(text, { timeout: 20000 });
  }
  // Sift's summaries and selection use a chromatic accent, not the theme's
  // neutral --ring.
  const accent = await tables(owner)
    .first()
    .locator(".sift-root")
    .first()
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--sift-accent").trim());
  const chroma = Number(/oklch\(\s*[\d.]+%?\s+([\d.]+)/.exec(accent)?.[1]);
  assert.ok(chroma > 0.05, `Sift accent is achromatic: ${accent}`);
  await owner.screenshot({ path: `${output}/sift-table-owner.png`, fullPage: true });
  await viewer.screenshot({ path: `${output}/sift-table-viewer.png`, fullPage: true });
  complete("insert_node places a dataframe that renders as a Sift table for owner and viewer");

  // A table far below the fold waits: no renderer chunk, Sift WASM or
  // dataset until a reader scrolls near it. A fresh session, so nothing is
  // cached from the first Page.
  {
    const listing = (await tool(owner, "list_pages")).body;
    const long = await tool(owner, "create_page", {
      title: "Datasets below the fold",
      markdown: Array.from({ length: 120 }, (_, n) => `Paragraph ${n + 1} of a long Page.`).join(
        "\n\n",
      ),
      ...retry(listing),
    });
    assert.equal(long.status, 200, JSON.stringify(long.body));
    const longId = long.body.page_id;
    created.push(longId);
    const copy = await fetch(`${origin}/api/pages/${longId}/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.owner}`, "Content-Type": PARQUET },
      body: parquetBytes,
    });
    assert.ok([200, 201].includes(copy.status), await copy.clone().text());
    const asset = await copy.json();
    const before = (await tool(owner, "read_page", { page_id: longId })).body;
    const placed = await tool(owner, "edit_page", {
      page_id: longId,
      revision: before.revision,
      ...retry(before),
      operations: [dataframe(asset.asset_id, "Far below")],
    });
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    const reader = await signIn("dev@localhost");
    const fetched = { dataset: 0, sift: 0 };
    reader.on("request", (request) => {
      const url = request.url();
      if (url.includes(asset.asset_url)) fetched.dataset++;
      if (/\/sift-[A-Z0-9]+\.wasm/.test(url)) fetched.sift++;
    });
    await reader.goto(`${origin}/p/${longId}`);
    await expect(tables(reader)).toHaveCount(1, { timeout: 15000 });
    const far = tables(reader).first();
    await expect(far).toContainText("This table loads when you scroll to it.");
    // Long enough for an eager load to have fetched everything.
    await reader.waitForTimeout(1500);
    assert.deepEqual(fetched, { dataset: 0, sift: 0 }, "an offscreen table loaded");
    assert.equal(await far.locator(".sift-root").count(), 0);
    await far.scrollIntoViewIfNeeded();
    await expect(far.locator(".sift-root").first()).toBeVisible({ timeout: 20000 });
    await expect(far).toContainText("browser", { timeout: 20000 });
    assert.deepEqual(fetched, { dataset: 1, sift: 1 });
    await reader.context().close();
    // signIn filed the reader under the owner's email; failure screenshots
    // read this map.
    people.set("dev@localhost", owner);
  }
  complete("A table below the fold loads Sift and its dataset only when a reader scrolls near it");

  // On a phone, a tap on a table's title row selects it.
  {
    const phone = await signIn("dev@localhost", {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await phone.goto(`${origin}/p/${pageId}`);
    await expect(tables(phone)).toHaveCount(1, { timeout: 15000 });
    const table = tables(phone).first();
    await table.scrollIntoViewIfNeeded();
    await table.locator(".wordgard-dataframe-title").tap();
    await expect(
      table.locator("xpath=ancestor::*[contains(@class,'wg-selected-node')]"),
    ).toHaveCount(1);
    await phone.context().close();
    people.set("dev@localhost", owner);
  }
  complete("A tap on a table's title row selects it on a phone");

  // The usage Page case: the stored table and chart follow one source;
  // refreshing it edits no Page content and keeps every node address.
  {
    const listing = (await tool(owner, "list_pages")).body;
    const made = await tool(owner, "create_page", {
      title: "Datasets follow a source",
      markdown: "Usage, refreshed by an agent.",
      ...retry(listing),
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const followId = made.body.page_id;
    created.push(followId);
    const upload = async (bytes) => {
      const response = await fetch(`${origin}/api/pages/${followId}/assets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${keys.owner}`, "Content-Type": PARQUET },
        body: bytes,
      });
      assert.ok([200, 201].includes(response.status), await response.clone().text());
      return response.json();
    };
    const first = await upload(parquetBytes);
    const second = await upload(refreshedBytes);
    assert.notEqual(first.asset_id, second.asset_id);
    const edit = async (operations) => {
      const read = (await tool(owner, "read_page", { page_id: followId })).body;
      const result = await tool(owner, "edit_page", {
        page_id: followId,
        revision: read.revision,
        ...retry(read),
        operations,
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    };
    const setUsage = (asset_id, source_revision) =>
      edit([{ op: "set_source", source_id: "usage", name: "Usage", asset_id, source_revision }]);
    await setUsage(first.asset_id, null);
    const inserted = await edit([
      {
        op: "insert_node",
        node: {
          type: "dataframe",
          attrs: { binding: { source_id: "usage" }, title: "Follows usage" },
        },
      },
      dataframe(first.asset_id, "Pinned usage"),
      {
        op: "insert_node",
        node: {
          type: "dataframe",
          attrs: { binding: { source_id: "usage", revision: "1" }, title: "Pinned source" },
        },
      },
    ]);
    const nodeId = inserted.result.edits[0].nodes[0];
    await edit([
      {
        op: "set_view",
        view_id: "usage",
        title: "Usage chart",
        media_type: "application/vnd.vegalite.v6+json",
        spec: {
          data: { name: "usage" },
          mark: "bar",
          encoding: {
            x: { field: "surface", type: "nominal" },
            y: { field: "events", type: "quantitative" },
          },
        },
        data: { usage: { source_id: "usage" } },
        view_revision: null,
      },
    ]);
    await edit([{ op: "insert_node", node: { type: "view", attrs: { view_id: "usage" } } }]);
    const reader = await signIn("dev@localhost");
    await reader.addInitScript(() => {
      const measure = performance.measure.bind(performance);
      window.__cardTables = [];
      performance.measure = (name, ...rest) => {
        if (name === "pages-card-capture")
          for (const frame of document.querySelectorAll("iframe")) {
            const shell = frame.contentDocument?.querySelector(".card-shell");
            if (shell)
              window.__cardTables.push(
                ...[...shell.querySelectorAll(".wordgard-dataframe-canvas")].map((canvas) => ({
                  source: canvas.dataset.sourceId,
                  revision: canvas.dataset.sourceRevision,
                  text: canvas.textContent,
                })),
              );
          }
        return measure(name, ...rest);
      };
    });
    await reader.goto(`${origin}/p/${followId}`);
    await expect(tables(reader)).toHaveCount(3, { timeout: 15000 });
    const follows = tables(reader).filter({ hasText: "Follows usage" });
    const pinned = tables(reader).filter({ hasText: "Pinned usage" });
    const sourcePin = tables(reader).filter({ hasText: "Pinned source" });
    const chart = reader.locator('section.wordgard-view-embed[data-view-id="usage"]');
    await chart.scrollIntoViewIfNeeded();
    await expect(chart.locator(".pages-chart-canvas svg")).toContainText("browser", {
      timeout: 30000,
    });
    await follows.scrollIntoViewIfNeeded();
    const followsCanvas = follows.locator(".wordgard-dataframe-canvas");
    await expect(followsCanvas).toHaveAttribute("data-source-id", "usage");
    await expect(followsCanvas).toHaveAttribute("data-source-revision", "1", { timeout: 20000 });
    await expect(followsCanvas).toHaveAttribute("data-asset-id", first.asset_id);
    await expect(follows).toContainText("browser", { timeout: 20000 });
    await expect(pinned).toContainText("browser", { timeout: 20000 });
    await expect
      .poll(
        () =>
          reader.evaluate(() =>
            window.__cardTables.some(
              (table) =>
                table.source === "usage" &&
                table.revision === "1" &&
                table.text.includes("browser"),
            ),
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    complete("Page cards render the stored source binding through the source resolver");
    await reader.screenshot({ path: `${output}/source-follow-before.png`, fullPage: true });

    // An agent refreshes the source with a new asset. The followed table
    // redraws from it; the pinned one stays on its asset.
    await setUsage(second.asset_id, "1");
    await expect(followsCanvas).toHaveAttribute("data-source-revision", "2", { timeout: 20000 });
    await expect(followsCanvas).toHaveAttribute("data-asset-id", second.asset_id);
    await expect(follows).toContainText("desktop", { timeout: 20000 });
    await expect(follows).not.toContainText("browser");
    await expect(sourcePin).toContainText("browser");
    await chart.scrollIntoViewIfNeeded();
    await expect(chart.locator(".pages-chart-canvas svg")).toContainText("desktop", {
      timeout: 30000,
    });
    const readBack = (await tool(owner, "read_page", { page_id: followId, include_content: false }))
      .body;
    assert.equal(
      readBack.outline.entries.find((n) => n.attrs?.title === "Follows usage").node_id,
      nodeId,
    );
    await expect(pinned).toContainText("browser");
    assert.equal(
      await pinned.locator(".wordgard-dataframe-canvas").getAttribute("data-source-id"),
      null,
      "the pinned table follows nothing",
    );
    await reader.screenshot({ path: `${output}/source-follow-after.png`, fullPage: true });
    await reader.setViewportSize({ width: 390, height: 844 });
    await follows.scrollIntoViewIfNeeded();
    await reader.screenshot({ path: `${output}/source-follow-phone.png`, fullPage: true });
    await reader.setViewportSize({ width: 1280, height: 900 });
    await edit([
      {
        op: "set_node",
        node_id: nodeId,
        attrs: { binding: { source_id: "usage", revision: "1" } },
      },
    ]);
    await expect(followsCanvas).toHaveAttribute("data-source-revision", "1", { timeout: 20000 });
    await expect(follows).toContainText("browser");
    await edit([{ op: "set_node", node_id: nodeId, attrs: { binding: { source_id: "usage" } } }]);
    await expect(follows).toContainText("desktop");
    await edit([{ op: "delete_source", source_id: "usage", source_revision: "2" }]);
    await expect(follows).toContainText('Source "usage"');
    await expect(follows).not.toContainText("desktop");
    await expect(sourcePin).toContainText('Source "usage"');
    await chart.scrollIntoViewIfNeeded();
    await expect(chart).toContainText("usage");
    await expect(chart.locator(".pages-chart-canvas svg")).not.toContainText("desktop");
    await expect(pinned).toContainText("browser");
    await reader.screenshot({ path: `${output}/source-deleted.png`, fullPage: true });
    await edit([{ op: "set_node", node_id: nodeId, attrs: { asset_id: second.asset_id } }]);
    // The tool's answer can arrive before the reader's replica syncs the
    // edit, which redraws this table in a new frame. The frame that drew the
    // deleted source carries data-source-id; the asset-bound one never does.
    await expect(followsCanvas).not.toHaveAttribute("data-source-id");
    await follows.scrollIntoViewIfNeeded();
    await expect(follows).toContainText("desktop", { timeout: 20000 });
    await reader.context().close();
    people.set("dev@localhost", owner);
  }
  complete("A table bound to a source redraws when an agent refreshes it; a pinned one stays");

  const rewrite = await editPage([
    { op: "replace_block_markdown", node_id: node.node_id, markdown: "gone" },
  ]);
  assert.equal(rewrite.status, 400);
  assert.equal(rewrite.body.code, "markdownless_node", JSON.stringify(rewrite.body));
  const missing = await editPage([dataframe("0".repeat(64))]);
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body.code, "dataset_not_found");
  const line = `[Dataframe: Usage by day](${dataset.asset_url})`;
  const kept = await editPage([
    { op: "replace_block_markdown", node_id: node.node_id, markdown: `Intro\n\n${line}` },
  ]);
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  await expect(tables(viewer)).toHaveCount(1, { timeout: 15000 });
  await expect(tables(viewer).first()).toContainText("browser", { timeout: 20000 });
  const image = await fetch(`${origin}/api/pages/${pageId}/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.owner}`, "Content-Type": "image/png" },
    body: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  assert.ok([200, 201].includes(image.status), await image.clone().text());
  const notDataset = await editPage([dataframe((await image.json()).asset_id)]);
  assert.equal(notDataset.status, 415, JSON.stringify(notDataset.body));
  complete("A rewrite keeps a dataframe by its line; missing assets and images can't become one");

  // A person's path: drop a .parquet file into the editor.
  await content(owner).click();
  await owner.keyboard.press("ControlOrMeta+End");
  await content(owner).evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "dropped usage.parquet", { type: "" }));
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        clientX: rect.left + 20,
        clientY: rect.bottom - 10,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, parquet);
  await expect(tables(owner)).toHaveCount(2, { timeout: 20000 });
  await expect(tables(viewer)).toHaveCount(2, { timeout: 20000 });
  await expect(tables(viewer).filter({ hasText: "dropped usage" })).toContainText("browser", {
    timeout: 20000,
  });
  await expect.poll(async () => (await markdownOf()).match(/\[Dataframe/g)?.length ?? 0).toBe(2);
  assert.ok((await markdownOf()).includes(`[Dataframe: dropped usage](${dataset.asset_url})`));
  complete("Dropping a .parquet file uploads it and inserts a shared dataframe node");

  // Selection model: a click on the frame selects the table natively, as a
  // click selects an image. Arrows reach it from text. Enter enters Sift's
  // grid; Escape leaves it, then deselects. One table selected per Page.
  const dropped = tables(owner).filter({ hasText: "dropped usage" });
  const other = tables(owner).filter({ hasText: "Usage by day" });
  const selected = (table) =>
    table.locator("xpath=ancestor::*[contains(@class,'wg-selected-node')]");
  const drawnOutlines = () =>
    owner
      .locator(".wg-selected-node:has(section.wordgard-dataframe-table)")
      .evaluateAll(
        (nodes) =>
          nodes.filter((node) => getComputedStyle(node).outlineColor !== "rgba(0, 0, 0, 0)").length,
      );
  const siftRoot = await dropped.locator(".sift-root").first().elementHandle();

  await dropped.locator(".wordgard-dataframe-title").click();
  await expect(selected(dropped)).toHaveCount(1);
  await expect(owner.getByRole("toolbar", { name: "Text formatting" })).toBeHidden();
  await owner.screenshot({ path: `${output}/sift-table-selected.png`, fullPage: true });
  complete("A click on the title selects the table");

  // The dropped table ends its block, so Escape leaves the caret just
  // before it, and ArrowDown selects it again.
  await owner.keyboard.press("Escape");
  await expect(selected(dropped)).toHaveCount(0);
  await owner.keyboard.press("ArrowDown");
  await expect(selected(dropped)).toHaveCount(1);
  complete("Escape deselects; ArrowDown from the text above selects it again");

  await owner.keyboard.press("Enter");
  await expect
    .poll(() =>
      dropped.evaluate((frame) =>
        frame.querySelector(".wordgard-dataframe-canvas")?.contains(document.activeElement),
      ),
    )
    .toBe(true);
  await owner.keyboard.press("ArrowDown");
  // Sideways arrows stay in the grid: their default (moving the editor caret
  // in the contenteditable) is cancelled, focus doesn't leave the canvas, and
  // Escape below still returns to the table. This table fits its frame, so
  // nothing scrolls, and no header is shifted.
  await owner.evaluate(() => {
    window.__arrowDefaults = [];
    window.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight")
        window.__arrowDefaults.push(event.defaultPrevented);
    });
  });
  await owner.keyboard.press("ArrowRight");
  await owner.keyboard.press("ArrowLeft");
  assert.deepEqual(await owner.evaluate(() => window.__arrowDefaults), [true, true]);
  assert.deepEqual(
    await dropped.evaluate((frame) =>
      [...frame.querySelectorAll(".wordgard-dataframe-canvas *")]
        .filter((node) => node.scrollLeft !== 0)
        .map((node) => node.className),
    ),
    [],
    "an arrow scrolled something in a table that fits",
  );
  assert.equal(
    await dropped.evaluate((frame) =>
      frame.querySelector(".wordgard-dataframe-canvas")?.contains(document.activeElement),
    ),
    true,
    "ArrowLeft/ArrowRight left the grid",
  );
  await expect(selected(dropped)).toHaveCount(1);
  await owner.keyboard.press("Escape");
  await expect(selected(dropped)).toHaveCount(1);
  await expect
    .poll(() => dropped.evaluate((frame) => frame.closest("wg-content") === document.activeElement))
    .toBe(true);
  complete(
    "Enter enters the grid; sideways arrows stay in it; Escape returns to the table selected",
  );

  await other.locator(".wordgard-dataframe-title").click();
  await expect(selected(other)).toHaveCount(1);
  await expect(selected(dropped)).toHaveCount(0);
  await expect.poll(drawnOutlines).toBe(1);
  complete("Selecting another block's table deselects the first");

  await owner.waitForTimeout(1200);
  assert.equal(
    await siftRoot.evaluate((element) => element.isConnected),
    true,
    "selection reloaded the table",
  );

  await dropped.locator(".wordgard-dataframe-title").click();
  await expect(selected(dropped)).toHaveCount(1);
  await owner.keyboard.press("ControlOrMeta+X");
  await expect(tables(owner)).toHaveCount(1, { timeout: 10000 });
  await expect(tables(viewer)).toHaveCount(1, { timeout: 15000 });
  await content(owner).click();
  await owner.keyboard.press("ControlOrMeta+Home");
  await owner.keyboard.press("ControlOrMeta+V");
  await expect(tables(owner)).toHaveCount(2, { timeout: 10000 });
  await expect(tables(viewer).filter({ hasText: "dropped usage" })).toContainText("browser", {
    timeout: 20000,
  });
  await expect.poll(async () => (await markdownOf()).match(/\[Dataframe/g)?.length ?? 0).toBe(2);
  complete("Click, Cmd-X and paste move the table");

  // POSTs to an asset's own URL: the copy route. A page's requests count
  // from when it's watched.
  const watchCopies = (page) => {
    const seen = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/assets\/[0-9a-f]{64}$/.test(new URL(request.url()).pathname)
      )
        seen.push(request.url());
    });
    return seen;
  };
  // A paste event carrying `html`, as another site's clipboard would.
  const pasteHTML = (page, html) =>
    content(page).evaluate((element, value) => {
      const data = new DataTransfer();
      data.setData("text/html", value);
      data.setData("text/plain", "pasted");
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, html);
  const figure = (src, title) =>
    `<figure data-pages-dataframe='${JSON.stringify({ src, media_type: PARQUET, title })}'>${title}</figure>`;

  // Copy a table on one Page and paste it into another: the Page asks,
  // naming the source from this browser's copy record, and copies nothing
  // until the person says yes. Then the host copies the dataset onto the
  // second Page, the paste lands with its src there, and the table draws.
  {
    const listing = (await tool(owner, "list_pages")).body;
    const target = await tool(owner, "create_page", {
      title: "Datasets paste target",
      markdown: "Pasted from another Page:",
      ...retry(listing),
    });
    assert.equal(target.status, 200, JSON.stringify(target.body));
    const targetId = target.body.page_id;
    created.push(targetId);
    const local = `/api/pages/${targetId}/assets/${dataset.asset_id}`;
    const stored = () =>
      owner.evaluate(async (path) => (await fetch(path, { method: "HEAD" })).status, local);
    assert.equal(await stored(), 404);
    await other.locator(".wordgard-dataframe-title").click();
    await expect(selected(other)).toHaveCount(1);
    await owner.keyboard.press("ControlOrMeta+C");
    const second = await owner.context().newPage();
    second.on("pageerror", (error) => report.errors.push(`paste target: ${error.message}`));
    const copies = watchCopies(second);
    await second.goto(`${origin}/p/${targetId}`);
    await content(second).click();
    await second.keyboard.press("ControlOrMeta+End");
    await second.keyboard.press("ControlOrMeta+V");
    const ask = second
      .getByRole("status")
      .filter({ hasText: `Bring the data for 1 table from "Datasets qualification"` });
    await expect(ask).toBeVisible({ timeout: 10000 });
    await second.waitForTimeout(500);
    assert.deepEqual(copies, [], "a copy ran before the person said yes");
    await expect(tables(second)).toHaveCount(0);
    await ask.getByRole("button", { name: "Bring data" }).click();
    await expect(tables(second)).toHaveCount(1, { timeout: 20000 });
    assert.equal(copies.length, 1);
    const pasted = tables(second).first();
    await expect(pasted).toHaveAttribute("aria-label", "Usage by day");
    for (const text of ["surface", "browser", "mcp"])
      await expect(pasted).toContainText(text, { timeout: 20000 });
    await expect(second.locator(".image-upload-status")).toHaveCount(0);
    const markdownOn = async (id) =>
      (await tool(owner, "read_page", { page_id: id })).body.blocks
        .map((block) => block.markdown)
        .join("\n");
    const markdown = await markdownOn(targetId);
    assert.ok(markdown.includes(`[Dataframe: Usage by day](${local})`), markdown);
    assert.equal(markdown.includes(pageId), false, markdown);
    assert.equal(await stored(), 200);
    await second.screenshot({ path: `${output}/sift-table-pasted.png`, fullPage: true });
    complete(
      "A table copied from one Page and pasted into another asks, then arrives with its data",
    );

    // A replayed copy id: the id and reference came back inside some other
    // site's content, under that site's title. The Page still names the
    // record's source, and Paste titles only copies nothing.
    const id = await second.evaluate(
      () => JSON.parse(localStorage.getItem("pages.clipboard-copies.v1")).at(-1).id,
    );
    await content(second).click();
    await second.keyboard.press("ControlOrMeta+End");
    await pasteHTML(
      second,
      `<p>Totally ordinary notes</p>${figure(dataset.asset_url, "Lunch menu")}` +
        `<span hidden data-pages-copy='{"v":1,"id":"${id}"}'></span>`,
    );
    const replayed = second.getByRole("status").filter({ hasText: "Bring the data" });
    await expect(replayed).toContainText('"Datasets qualification"');
    await expect(replayed).not.toContainText("Lunch menu");
    await second.waitForTimeout(500);
    assert.equal(copies.length, 1, "a replayed id copied before the person said yes");
    // Answer with the keyboard; focus comes back to the Page, so typing
    // goes on after the paste.
    await replayed.getByRole("button", { name: "Paste titles only" }).focus();
    await second.keyboard.press("Enter");
    await expect.poll(() => markdownOn(targetId)).toContain("Lunch menu");
    assert.ok((await markdownOn(targetId)).includes("Totally ordinary notes"));
    await expect(content(second)).toBeFocused();
    await second.keyboard.type(" typed after");
    await expect.poll(() => markdownOn(targetId)).toContain("Lunch menu typed after");
    await expect(tables(second)).toHaveCount(1);
    assert.equal(copies.length, 1);
    await second.close();
  }
  complete("A replayed copy id asks with the record's title, and Paste titles only copies nothing");

  // A dataframe this browser didn't copy (forged clipboard HTML, with a
  // valid-looking reference to another Page), pasted or dropped, asks the
  // host for nothing and raises no question. It lands as its title, never
  // as a node naming another Page's asset, and the Page says why.
  const copyRequests = watchCopies(owner);
  const foreign = `/api/pages/44444444-4444-4444-8444-444444444444/assets/${"a".repeat(64)}`;
  const notBrought = owner.getByRole("status").filter({ hasText: "wasn't brought over" });
  await content(owner).click();
  await pasteHTML(owner, figure(foreign, "Forged paste"));
  await expect(notBrought).toBeVisible();
  await expect(owner.getByRole("button", { name: "Bring data" })).toHaveCount(0);
  await notBrought.getByRole("button", { name: "Dismiss" }).click();
  await content(owner).evaluate(
    (element, html) => {
      const data = new DataTransfer();
      data.setData("text/html", html);
      data.setData("text/plain", "Foreign table");
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: data,
          clientX: rect.left + 20,
          clientY: rect.top + 10,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    figure(foreign, "Foreign table"),
  );
  await expect.poll(markdownOf).toContain("Foreign table");
  assert.equal((await markdownOf()).includes("44444444-4444-4444-8444-444444444444"), false);
  await expect(tables(owner)).toHaveCount(2);
  await expect(notBrought).toBeVisible();
  await notBrought.getByRole("button", { name: "Dismiss" }).click();
  assert.deepEqual(copyRequests, [], "a forged reference asked the host to copy");
  complete("A forged dataframe paste or drop copies nothing and lands as its title");

  for (const page of [owner, viewer])
    assert.equal(await page.locator("[data-block-error]").count(), 0, "a block failed to draw");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.csp, []);
  complete("No page errors or Content-Security-Policy refusals");
} catch (error) {
  report.failure = error.stack || error.message;
  for (const [name, page] of people) {
    report[name] = await page
      .locator("body")
      .innerText()
      .catch(() => null);
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
