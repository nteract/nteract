// Local-only OIDC + real celld R2 + Sift table qualification for `sift` blocks.
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  people.set(email, page);
  page.on("pageerror", (error) => {
    report.errors.push(`${report.completed.length}: ${error.message}`);
    if (report.errors.length <= 3) (report.stacks ??= []).push(`${email}: ${error.stack}`);
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
async function insertMarkdown(markdown) {
  const read = (await tool(owner, "read_page", { page_id: pageId })).body;
  const result = await tool(owner, "edit_page", {
    page_id: pageId,
    base_heads: read.heads,
    ...retry(read),
    operations: [{ op: "insert_markdown", markdown }],
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}
const fence = (body) => "```sift\n" + JSON.stringify(body) + "\n```";
const content = (page) => page.locator("wg-content").first();
// Each block has its own editor, so a table is in a later wg-content.
const tables = (page) => page.locator("wg-content section.wordgard-sift");
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

  // An agent's path: raw bytes with an API key, then a Markdown fence.
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

  await insertMarkdown(fence({ src: dataset.asset_url, title: "Usage by day" }));
  for (const page of [owner, viewer]) {
    await page.goto(`${origin}/p/${pageId}`);
    await expect(tables(page)).toHaveCount(1, { timeout: 15000 });
    const table = tables(page).first();
    await expect(table).toHaveAttribute("aria-label", "Usage by day");
    await expect(table.locator(".sift-root").first()).toBeVisible({ timeout: 20000 });
    for (const text of ["surface", "events", "browser", "mcp"])
      await expect(table).toContainText(text, { timeout: 20000 });
  }
  await owner.screenshot({ path: `${output}/sift-table-owner.png`, fullPage: true });
  await viewer.screenshot({ path: `${output}/sift-table-viewer.png`, fullPage: true });
  await expect(tables(viewer).getByRole("button", { name: "Edit table source" })).toHaveCount(0);
  complete("A sift fence renders the dataset as a Sift table for owner and viewer");

  const ownerTable = tables(owner).first();
  await ownerTable.getByRole("button", { name: "Edit table source" }).click();
  await expect(
    owner.locator("wg-content pre").filter({ hasText: dataset.asset_url }),
  ).toBeVisible();
  await expect(tables(owner)).toHaveCount(0);
  await owner.locator("wg-content").getByRole("button", { name: "Show table" }).click();
  await expect(tables(owner)).toHaveCount(1);
  await expect(tables(owner).first()).toContainText("browser", { timeout: 20000 });
  complete("Edit table source and Show table switch only the local view");

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
  await expect.poll(async () => (await markdownOf()).match(/```sift\n/g)?.length ?? 0).toBe(2);
  assert.match(
    await markdownOf(),
    new RegExp(`"src":"${dataset.asset_url}","title":"dropped usage"`),
  );
  complete("Dropping a .parquet file uploads it and inserts a shared sift block");

  await insertMarkdown(fence({ src: `/api/pages/${pageId}/assets/${"0".repeat(64)}` }));
  await insertMarkdown("```sift\nnot json\n```");
  await expect(tables(viewer)).toHaveCount(4, { timeout: 15000 });
  await expect(tables(viewer).nth(2)).toContainText("isn't stored on this Page", {
    timeout: 20000,
  });
  await expect(tables(viewer).nth(3)).toContainText("must be JSON");
  complete("A missing asset or malformed fence shows a reason in place of the table");

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
