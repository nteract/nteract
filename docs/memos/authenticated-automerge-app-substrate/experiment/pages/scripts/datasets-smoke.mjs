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
const report = { completed: [], errors: [], csp: [] };
const people = new Map();
const created = [];
let owner, viewer, pageId;
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Datasets E2E] ${name}`);
};
const retry = (value) => ({
  retry_token: value.retry_token,
  idempotency_key: value.retry_key_prefix + crypto.randomUUID(),
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
async function signIn(email) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
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
    base_heads: read.heads,
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
    idempotency_key: crypto.randomUUID(),
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
  const [node] = inserted.body.result.inserted_nodes;
  assert.deepEqual(node.attrs, {
    asset_id: dataset.asset_id,
    src: dataset.asset_url,
    media_type: PARQUET,
    title: "Usage by day",
  });
  const blocks = (await tool(owner, "read_page", { page_id: pageId })).body.blocks;
  assert.equal(
    blocks.find((block) => block.id === node.block_id).markdown,
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
      base_heads: before.heads,
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

  const rewrite = await editPage([
    { op: "replace_block_markdown", block_id: node.block_id, markdown: "gone" },
  ]);
  assert.equal(rewrite.status, 400);
  assert.equal(rewrite.body.code, "markdownless_node", JSON.stringify(rewrite.body));
  const missing = await editPage([dataframe("0".repeat(64))]);
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body.code, "dataset_not_found");
  const line = `[Dataframe: Usage by day](${dataset.asset_url})`;
  const kept = await editPage([
    { op: "replace_block_markdown", block_id: node.block_id, markdown: `Intro\n\n${line}` },
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

  // An HTML drop of a dataframe copied from another Page lands as its title,
  // never as a node naming another Page's asset.
  const foreign = `/api/pages/44444444-4444-4444-8444-444444444444/assets/${"a".repeat(64)}`;
  await content(owner).evaluate((element, src) => {
    const data = new DataTransfer();
    const attrs = JSON.stringify({
      src,
      media_type: "application/vnd.apache.parquet",
      title: "Foreign table",
    });
    data.setData("text/html", `<figure data-pages-dataframe='${attrs}'>Foreign table</figure>`);
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
  }, foreign);
  await expect.poll(markdownOf).toContain("Foreign table");
  assert.equal((await markdownOf()).includes("44444444-4444-4444-8444-444444444444"), false);
  await expect(tables(owner)).toHaveCount(2);
  complete("An HTML drop of another Page's dataframe lands as its title");

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
        base_heads: read.heads,
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
