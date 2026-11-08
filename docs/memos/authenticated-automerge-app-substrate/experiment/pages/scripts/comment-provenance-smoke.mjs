// Disposable local fixture only: real MCP assertions through celld persistence,
// browser sync, reload, explicit disclosure and narrow/wide layout.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-comment-provenance";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
async function call(operation, args = {}, agent) {
  return page.evaluate(
    async ({ operation, args, agent }) => {
      const response = await fetch("/mcp", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Pages-Driver": "Provenance QA",
          "X-Pages-Client": "Harness/1",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name: operation, arguments: args, ...(agent && { _meta: { agent } }) },
        }),
      });
      const envelope = await response.json();
      if (envelope.result?.isError || envelope.error) throw Error(JSON.stringify(envelope));
      return envelope.result.structuredContent;
    },
    { operation, args, agent },
  );
}
let pageId;
try {
  await page.goto(origin + "/api/auth/login");
  await page.waitForURL(origin + "/");
  const created = await call("create_page", {
    title: "Comment assertions fixture",
    markdown: "Keep this content unchanged.",
    idempotency_key: crypto.randomUUID(),
  });
  pageId = created.page_id;
  const read = await call("read_page", { page_id: pageId });
  const name = '<img src=x onerror="alert(1)">';
  const args = {
    page_id: pageId,
    block_id: read.blocks[0].id,
    body: "Created with asserted labels",
    idempotency_key: crypto.randomUUID(),
  };
  const first = await call("manage_page_comment", args, {
    name,
    id: "private-session",
    model: "model-a",
  });
  const threadId = first.result.thread_id;
  await call(
    "manage_page_comment",
    {
      page_id: pageId,
      action: "reply",
      thread_id: threadId,
      body: "Model switched",
      idempotency_key: crypto.randomUUID(),
    },
    { name, model: "model-b" },
  );
  assert.deepEqual(
    await call("manage_page_comment", args, { name: "Retry", model: "other" }),
    first,
  );
  await page.goto(origin + "/p/" + pageId);
  const open = async () => {
    await page.getByRole("button", { name: /^Comments/ }).click();
    await page.locator(`.thread-row[data-thread-id="${threadId}"]`).click();
    return page.locator(`.thread-view[data-thread-id="${threadId}"]`);
  };
  let thread = await open();
  await expect(thread.locator(".message-author strong")).toHaveText([name, name]);
  await expect(thread.locator(".message-author").first()).toContainText("client-supplied");
  await expect(thread.locator(".message-author").first()).toContainText("model-a");
  await expect(thread.locator(".message-author").last()).toContainText("model-b");
  assert.equal(await thread.locator(".message-author img, .message-author a").count(), 0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(thread.locator(".message-author").first()).toBeVisible();
    await page.screenshot({ path: `${output}/assertions-${width}.png`, fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
  }
  await page.reload();
  // Comments are local UI state; open only if the panel is closed after reload.
  if (!(await page.locator(`.thread-view[data-thread-id="${threadId}"]`).isVisible()))
    thread = await open();
  await expect(thread.locator(".message-author").first()).toContainText("model-a");
  const listed = await call("list_page_comments", { page_id: pageId });
  assert.ok(!JSON.stringify(listed).includes("private-session"));
  assert.ok(!JSON.stringify(listed.comments).includes("Harness/1"));
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/report.json`,
    JSON.stringify(
      {
        passed: true,
        widths: [1440, 390],
        errors,
        localProposalOnly: true,
        publicationInputs: ["params._meta.agent.name", "params._meta.agent.model"],
        omittedInputs: ["params._meta.agent.id", "X-Pages-Client"],
      },
      null,
      2,
    ),
  );
} finally {
  if (pageId)
    await call("delete_page", { page_id: pageId, idempotency_key: crypto.randomUUID() }).catch(
      () => {},
    );
  await browser.close();
}
