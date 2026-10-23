// Scoped local-browser regression for passage/thread context and reply drafts.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = "/tmp/pages-comment-navigation-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let fixture;
async function call(operation, args) {
  return page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pages-Driver": "Comment navigation fixture",
        },
        body: JSON.stringify({ operation, arguments: args }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(JSON.stringify(data));
      return data;
    },
    { operation, args },
  );
}
try {
  await page.goto(origin + "/api/auth/login");
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
  fixture = await call("create_page", {
    title: "Comment navigation fixture " + Date.now(),
    markdown: "The Pages experiment takes those lessons into a smaller application.",
    idempotency_key: crypto.randomUUID(),
  });
  let current = await call("read_page", { page_id: fixture.page_id });
  await call("edit_page", {
    page_id: fixture.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "insert_markdown",
        markdown: "A separate section leaves room to check scrolling. ".repeat(50),
      },
      {
        op: "insert_markdown",
        markdown:
          "The Parquet file remains the bulk data source. Select words here for a new comment.",
      },
    ],
  });
  current = await call("read_page", { page_id: fixture.page_id });
  const first = current.blocks[0],
    second = current.blocks.at(-1);
  const threadIds = [];
  for (let i = 0; i < 5; i++) {
    current = await call("read_page", { page_id: fixture.page_id });
    const result = await call("manage_page_comment", {
      page_id: fixture.page_id,
      base_heads: current.heads,
      idempotency_key: crypto.randomUUID(),
      action: "add",
      block_id: i === 4 ? second.id : first.id,
      selected_text:
        i === 4
          ? "The Parquet file remains the bulk data source."
          : "The Pages experiment takes those lessons",
      body: i === 4 ? "Discuss the data and the view." : "Earlier thread " + i,
    });
    threadIds.push(result.result.thread_id);
  }
  await page.goto(origin + "/p/" + fixture.page_id);
  const source = page.locator(`[data-block-id="${first.id}"] .ProseMirror`);
  const data = page.locator(`[data-block-id="${second.id}"] .ProseMirror`);
  await expect(data.locator(".comment-passage")).toContainText("Parquet");
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const firstThread = page.locator(`[data-thread-id="${threadIds[0]}"]`);
  const dataThread = page.locator(`[data-thread-id="${threadIds[4]}"]`);
  const reply = firstThread.getByRole("textbox", { name: "Reply", exact: true });
  await reply.fill("Keep this unsent reply on the original thread.");
  await expect(firstThread).toHaveClass(/thread-active/);
  await expect(dataThread).not.toBeInViewport();
  await data.locator(".comment-passage").click();
  await expect(dataThread).toHaveClass(/thread-active/);
  await expect(dataThread).toBeInViewport();
  await expect(data.locator(".comment-passage-active")).toContainText("Parquet");
  assert.equal(await source.locator(".comment-passage-active").count(), 0);
  await expect(reply).toHaveValue("Keep this unsent reply on the original thread.");
  await page.screenshot({ path: output + "/correct-comment-context.png", fullPage: true });
  // A dragged selection is a selection, not navigation to a different thread.
  await source.scrollIntoViewIfNeeded();
  const range = await source.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (!text.textContent.includes("The Pages experiment")) continue;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 20);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + 1, y: rect.y + rect.height / 2, end: rect.right - 1 };
    }
    throw Error("Missing highlighted text");
  });
  await page.mouse.move(range.x, range.y);
  await page.mouse.down();
  await page.mouse.move(range.end, range.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection().toString())).not.toBe("");
  await expect(dataThread).toHaveClass(/thread-active/);
  await page.getByRole("button", { name: "Comment on selection", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Comment on selection", exact: true }),
  ).toBeVisible();
  assert.equal(
    await page.locator(".thread-active").count(),
    0,
    "new composer clears old thread emphasis",
  );
  await expect(reply).toHaveValue("Keep this unsent reply on the original thread.");
  // Sidebar quotes retain the reverse navigation on desktop and mobile.
  await page
    .locator(".comment-composer")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await dataThread.locator(".quote").click();
  await expect(data.locator(".comment-passage-active")).toBeInViewport();
  await firstThread.locator(".quote").click();
  await expect(source.locator(".comment-passage-active")).toBeInViewport();
  await expect(reply).toHaveValue("Keep this unsent reply on the original thread.");
  await page.setViewportSize({ width: 390, height: 844 });
  await dataThread.locator(".quote").click();
  await expect(page.getByRole("dialog", { name: "Comments", exact: true })).not.toBeVisible();
  await expect(data.locator(".comment-passage-active")).toBeInViewport();
  await data.locator(".comment-passage").click();
  await expect(page.getByRole("dialog", { name: "Comments", exact: true })).toBeVisible();
  await expect(dataThread).toHaveClass(/thread-active/);
  await expect(dataThread).toBeInViewport();
  await expect(reply).toHaveValue("Keep this unsent reply on the original thread.");
  await page.screenshot({ path: output + "/correct-comment-context-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      page_id: fixture.page_id,
      screenshot: output + "/correct-comment-context.png",
      checks: [
        "passage reveals matching thread",
        "sidebar scroll",
        "reply draft preserved",
        "drag selection preserved",
        "new composer clears old thread emphasis",
        "quote reveals passage on desktop and mobile",
      ],
    }),
  );
} finally {
  try {
    if (fixture) {
      const current = await call("read_page", { page_id: fixture.page_id });
      await call("delete_page", {
        page_id: fixture.page_id,
        base_heads: current.heads,
        idempotency_key: crypto.randomUUID(),
      });
    }
  } finally {
    await browser.close();
  }
}
