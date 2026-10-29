// Disposable local OIDC fixture: native comment tables, drafts, modal menus and read-back.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9916";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-rich-comments-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1320, height: 1000 } });
const report = { origin, completed: [], errors: [] };
page.on("pageerror", (error) => report.errors.push(error.message));
let pageId;
const checkpoint = (name) => {
  report.completed.push(name);
  console.log("PASS " + name);
};
async function call(operation, args = {}) {
  return page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/mcp", {
        credentials: "same-origin",
        signal: AbortSignal.timeout(10000),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Pages-Driver": "Rich comments QA",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name: operation, arguments: args },
        }),
      });
      if (!response.ok) throw Error(`${operation}: HTTP ${response.status}`);
      const envelope = await response.json();
      if (envelope.error) throw Error(`${operation}: JSON-RPC error ${envelope.error.code}`);
      const result = envelope.result;
      const text = result?.content?.find((entry) => entry.type === "text")?.text;
      if (typeof text !== "string") throw Error(`${operation}: missing MCP text result`);
      const data = JSON.parse(text);
      if (result.isError) throw Error(`${operation}: tool error ${data.code ?? "unspecified"}`);
      return data;
    },
    { operation, args },
  );
}
async function mutate(operation, args = {}) {
  const catalog = ["create_page", "delete_page"].includes(operation);
  const authority = await call(
    catalog ? "list_pages" : "read_page",
    catalog ? {} : { page_id: args.page_id },
  );
  return call(operation, {
    ...args,
    base_heads:
      operation === "delete_page"
        ? (await call("read_page", { page_id: args.page_id })).heads
        : authority.heads,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
}
async function select(editor, text) {
  await editor.focus();
  await editor.evaluate((element, text) => {
    const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const at = walk.currentNode.textContent.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(walk.currentNode, at);
      range.setEnd(walk.currentNode, at + text.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
    throw Error("Text not found");
  }, text);
  await page.waitForTimeout(60);
}
try {
  await page.goto(origin + "/api/auth/login");
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
  const created = await mutate("create_page", {
    title: "Rich comments QA",
    markdown: "A passage for discussion.",
  });
  pageId = created.page_id;
  const document = await call("read_page", { page_id: pageId });
  report.pageId = pageId;
  const { result: legacy } = await mutate("manage_page_comment", {
    page_id: pageId,
    action: "add",
    block_id: document.blocks[0].id,
    body: "**Legacy literal** | value |",
    body_format: "plain",
  });
  const { result: added } = await mutate("manage_page_comment", {
    page_id: pageId,
    action: "add",
    block_id: document.blocks[0].id,
    selected_text: "passage",
    body: "**Native discussion**\n\n| Approach | Tradeoff |\n| --- | --- |\n| Rich text | **Editable cells** |\n| Markdown | `Agent friendly` |",
    body_format: "markdown",
  });
  await page.goto(origin + "/p/" + pageId);
  assert.equal(
    await page.locator(".comment-rich-editor wg-content").count(),
    0,
    "closed comments allocate no reply editors",
  );
  await page.getByRole("button", { name: /^Comments/ }).click();
  const thread = page.locator(`[data-thread-id="${added.thread_id}"]`);
  await expect(thread.locator(".comment-rich-content table")).toBeVisible();
  await expect(thread.locator(".comment-rich-content strong").first()).toHaveText(
    "Native discussion",
  );
  await expect(page.locator(`[data-thread-id="${legacy.thread_id}"] .message`)).toHaveText(
    "**Legacy literal** | value |",
  );
  assert.equal(
    await page.locator(".comment-rich-editor wg-content").count(),
    0,
    "unopened replies allocate no editors",
  );
  checkpoint("agent-created native table renders; old comment remains literal");
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  const editor = thread.getByRole("textbox", { name: "Reply", exact: true });
  await expect(editor).toBeFocused();
  await editor.pressSequentially("Draft stays here");
  await select(editor, "Draft");
  await thread.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(editor.locator("strong")).toHaveText("Draft");
  const bold = thread.getByRole("button", { name: "Bold", exact: true });
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await bold.focus();
  await bold.press("ArrowRight");
  await expect(thread.getByRole("button", { name: "Italic", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(thread.getByRole("button", { name: "Insert table", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(bold).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  await select(editor, "Draft");
  await thread.getByRole("button", { name: "Link", exact: true }).click();
  await expect(thread.getByRole("textbox", { name: "Comment link URL" })).toBeFocused();
  await thread.getByRole("textbox", { name: "Comment link URL" }).fill("javascript:alert(1)");
  await thread.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(thread.getByRole("status")).toHaveText(
    "Enter a valid web, email, or telephone link.",
  );
  await thread.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(thread.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await select(editor, "Draft");
  await thread.getByRole("button", { name: "Link", exact: true }).click();
  await thread
    .getByRole("textbox", { name: "Comment link URL" })
    .fill("https://example.com/discussion");
  await thread.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(editor.locator("a")).toHaveAttribute("href", "https://example.com/discussion");
  await select(editor, "Draft");
  await thread.getByRole("button", { name: "Link", exact: true }).click();
  await editor.focus();
  await editor.press("ControlOrMeta+Home");
  await editor.pressSequentially("Prefix ");
  await expect(thread.getByRole("textbox", { name: "Comment link URL" })).toHaveCount(0);
  await thread.getByRole("button", { name: "Hide reply" }).click();
  await thread.getByRole("button", { name: "Continue reply" }).click();
  await expect(editor.locator("strong")).toContainText("Draft");
  checkpoint("native formatting and hidden draft survive without submission");
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await thread.getByRole("button", { name: "Insert table", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Insert table", exact: true });
  await menu.getByRole("spinbutton", { name: "Columns" }).fill("2");
  await menu.getByRole("spinbutton", { name: "Rows" }).fill("2");
  await menu.getByRole("button", { name: "Insert table" }).click();
  await expect(editor.locator("table")).toBeVisible();
  assert.equal(
    (await call("read_page", { page_id: pageId })).comments.find((t) => t.id === added.thread_id)
      .messages.length,
    1,
    "inserting a table never submits its parent comment form",
  );
  await page.keyboard.type("Column A");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Column B");
  await page.keyboard.press("Tab");
  await expect(editor.locator("td, th").nth(2)).toHaveCSS("white-space", "pre-wrap");
  // Let the DOM settle with a trailing space before entering the next word.
  // Collapsed whitespace can move the native caret before that space.
  await page.keyboard.type("Native ");
  await page.waitForTimeout(80);
  await page.keyboard.type("cell");
  await expect(editor.locator("td, th").nth(2)).toHaveText("Native cell");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Kept");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#page-comments.comments-sheet")).toBeVisible();
  const touchTarget = await bold.boundingBox();
  assert.ok(touchTarget.width >= 40 && touchTarget.height >= 40);
  await thread.getByRole("button", { name: "Table options", exact: true }).click();
  const options = page.getByRole("menu", { name: "Table options" });
  await expect(options).toBeVisible();
  assert.equal(await options.evaluate((el) => el.closest("dialog")?.id), "page-comments");
  await options.getByRole("menuitem", { name: "Insert row below" }).click();
  await expect(editor.locator("tr")).toHaveCount(3);
  await editor.locator("td").last().click();
  await thread.getByRole("button", { name: "Table options", exact: true }).click();
  await expect(options.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  await expect(page.locator("#page-comments")).toBeVisible();
  assert.equal(
    await editor.evaluate((el) => el.parentElement.scrollLeft),
    0,
    "table scrolling does not shift the surrounding prose",
  );
  await page.screenshot({ path: output + "/mobile-draft.png", fullPage: true });
  checkpoint("native table editing works inside the mobile dialog; Escape closes only its menu");
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  await expect(thread.locator(".thread-replies .comment-rich-content table")).toBeVisible();
  await expect
    .poll(async () => {
      const latest = await call("read_page", { page_id: pageId });
      return latest.comments.find((t) => t.id === added.thread_id).messages.length;
    })
    .toBe(2);
  const latest = await call("read_page", { page_id: pageId });
  const reply = latest.comments.find((t) => t.id === added.thread_id).messages.at(-1);
  assert.equal(reply.body_format, "markdown");
  assert.match(reply.body, /Draft/);
  await expect(thread.locator(".thread-replies .comment-rich-content strong")).toContainText(
    "Draft",
  );
  await expect(thread.locator(".thread-replies .comment-rich-content a")).toHaveAttribute(
    "href",
    "https://example.com/discussion",
  );
  assert.match(reply.body, /Native cell/);
  assert.match(reply.body, /Column A/);
  await page.reload();
  await page.getByRole("button", { name: /^Comments/ }).click();
  await thread.getByRole("button", { name: "1 reply", exact: true }).click();
  await expect(thread.locator(".thread-replies .comment-rich-content table")).toBeVisible();
  assert.equal(await thread.locator('.comment-rich-content [contenteditable="true"]').count(), 0);
  checkpoint(
    "native reply persists, projects to Markdown, reloads and remains read-only outside composer",
  );
  await page.setViewportSize({ width: 1320, height: 1000 });
  await page.getByRole("button", { name: "Expand comments" }).click();
  await expect(page.locator(".comments-expanded")).toBeVisible();
  await page.screenshot({ path: output + "/wide-comments.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: output + "/dark-comments.png", fullPage: true });
  checkpoint("expanded table discussion at desktop width and dark appearance");
  assert.deepEqual(report.errors, []);
} finally {
  if (pageId) {
    try {
      await mutate("delete_page", { page_id: pageId });
      await purgeTrashedFixture(call, pageId, async () => {
        const authority = await call("list_pages");
        return {
          retry_token: authority.retry_token,
          idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
        };
      });
      report.fixtureDeleted = true;
    } catch (error) {
      report.cleanupError = error.message;
    }
  }
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2));
  await browser.close();
}
