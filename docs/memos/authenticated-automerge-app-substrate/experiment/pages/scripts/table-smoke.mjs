// Local generated OIDC fixture; never creates test pages on a public deployment.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-tables-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
let fixture, author;
const source = `| **Approach** | Count | Notes |\n| :--- | ---: | :---: |\n| *Pages* | 12 | [Implementation notes](/llms.txt) and \`code\` |\n| Notebook | 7 | An intentionally wide table to exercise scrolling |\n`;
async function call(page, operation, args) {
  return page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pages-Driver": "Table fixture" },
        body: JSON.stringify({ operation, arguments: args }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(JSON.stringify(body));
      return body;
    },
    { operation, args },
  );
}
const saved = (page) =>
  expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 20000 });
try {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
  author = a;
  for (const page of [a, b]) {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/api/auth/login");
    await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
  }
  fixture = await call(a, "create_page", {
    title: "Table rendering fixture " + Date.now(),
    markdown: source,
    idempotency_key: crypto.randomUUID(),
  });
  let current = await call(a, "read_page", { page_id: fixture.page_id });
  const tableId = current.blocks[0].id;
  await call(a, "edit_page", {
    page_id: fixture.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [{ op: "insert_markdown", markdown: "Writing continues after the table." }],
  });
  for (const page of [a, b]) {
    await page.goto(origin + "/p/" + fixture.page_id);
    await expect(page.locator(".preserved-table-preview table")).toBeVisible();
    await expect(page.locator(".preserved-table-preview thead th")).toHaveCount(3);
    await expect(page.locator(".preserved-table-preview tbody tr")).toHaveCount(2);
    await expect(page.locator(".preserved-table-preview th strong")).toHaveText("Approach");
    await expect(page.locator(".preserved-table-preview td em")).toHaveText("Pages");
    await expect(page.locator(".preserved-table-preview td code")).toHaveText("code");
    assert.equal(
      await page
        .locator(".preserved-table-preview th")
        .nth(1)
        .evaluate((el) => getComputedStyle(el).textAlign),
      "right",
    );
    await saved(page);
  }
  await a.setViewportSize({ width: 1280, height: 900 });
  await a.screenshot({ path: output + "/table-desktop.png", fullPage: true });
  const popupPromise = a.waitForEvent("popup");
  await a.locator(".preserved-table-preview a").click();
  const popup = await popupPromise;
  await popup.waitForURL(origin + "/llms.txt");
  await popup.close();
  await expect(a.getByRole("dialog", { name: "Link", exact: true })).toHaveCount(0);
  await a.getByRole("button", { name: "Show table Markdown source" }).click();
  assert.equal(await a.locator(".preserved-table-source").textContent(), source);
  await expect(a.locator(".preserved-table-source")).toBeVisible();
  await expect(b.locator(".preserved-table-preview")).toBeVisible();
  current = await call(a, "read_page", { page_id: fixture.page_id });
  assert.equal(current.blocks.find((block) => block.id === tableId).markdown, source);
  await call(a, "patch_page", {
    page_id: fixture.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "patch_block_markdown",
        block_id: tableId,
        replacements: [{ old: "| 12 |", new: "| 123 |" }],
      },
    ],
  });
  await expect(
    b.locator(".preserved-table-preview tbody tr").first().locator("td").nth(1),
  ).toHaveText("123");
  await expect(a.locator(".preserved-table-source")).toHaveText(
    source.replace("| 12 |", "| 123 |"),
  );
  await expect(a.locator(".preserved-table-source")).toBeVisible();
  // The table stays opaque; prose in its own Page block remains an ordinary editor.
  const prose = a.locator(".ProseMirror").last();
  await prose.click();
  await a.keyboard.press("ControlOrMeta+End");
  await a.keyboard.insertText(" Still editable.");
  await expect(b.locator(".ProseMirror").last()).toContainText("Still editable.");
  await saved(a);
  current = await call(a, "read_page", { page_id: fixture.page_id });
  assert.equal(
    current.blocks.find((block) => block.id === tableId).markdown,
    source.replace("| 12 |", "| 123 |"),
  );
  assert.equal(current.blocks[1].markdown, "Writing continues after the table. Still editable.");
  await a.reload();
  await expect(
    a.locator(".preserved-table-preview tbody tr").first().locator("td").nth(1),
  ).toHaveText("123");
  await a.setViewportSize({ width: 390, height: 844 });
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(
    await a.locator(".markdown-table-scroll").evaluate((el) => el.scrollWidth > el.clientWidth),
  );
  await a.screenshot({ path: output + "/table-mobile.png", fullPage: true });
  await a.getByRole("button", { name: "Show table Markdown source" }).click();
  await expect(a.locator(".preserved-table-source")).toBeVisible();
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await a.screenshot({ path: output + "/table-source-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ page_id: fixture.page_id, errors, screenshots: output }));
} finally {
  try {
    if (fixture && author) {
      const current = await call(author, "read_page", { page_id: fixture.page_id });
      await call(author, "delete_page", {
        page_id: fixture.page_id,
        base_heads: current.heads,
        idempotency_key: crypto.randomUUID(),
      });
    }
  } finally {
    await browser.close();
  }
}
