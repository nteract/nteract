// Exercises the user-facing authoring flows against generated local OIDC only.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-authoring-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const rendererRequests = [];
const diagram = `graph TD
  A[Ingest] --> B{Valid?}
  B -->|Yes| C[Transform]
  B -->|No| D[Quarantine]
  C --> E[(Warehouse)]
  C --> F[Metrics]
  F --> G[Dashboard]
  E --> G`;
// Keep the exact token, key and payload for a fixture retry, including its driver.
// No retry authority is silently regenerated after an uncertain mutation.
const requestsByPage = new WeakMap();
async function call(page, operation, args = {}) {
  if (args.idempotency_key && !args.retry_token) {
    let requests = requestsByPage.get(page);
    if (!requests) requestsByPage.set(page, (requests = new Map()));
    const requestKey = JSON.stringify([operation, args.idempotency_key]);
    const fingerprint = JSON.stringify(args);
    let request = requests.get(requestKey);
    if (!request) {
      const catalog = ["create_page", "delete_page"].includes(operation);
      const authority = await rawCall(
        page,
        catalog ? "list_pages" : "read_page",
        catalog ? {} : { page_id: args.page_id },
      );
      assert.equal(typeof authority.retry_token, "string");
      assert.match(authority.retry_key_prefix, /^v1_[a-f0-9]{64}_$/);
      request = {
        fingerprint,
        args: structuredClone({
          ...args,
          retry_token: authority.retry_token,
          idempotency_key: authority.retry_key_prefix + args.idempotency_key,
        }),
      };
      requests.set(requestKey, request);
    }
    assert.equal(request.fingerprint, fingerprint, "fixture retry preserves its original payload");
    args = request.args;
  }
  return rawCall(page, operation, args);
}
async function rawCall(page, operation, args) {
  return page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pages-Driver": "Authoring fixture" },
        body: JSON.stringify({ operation, arguments: args }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(JSON.stringify(body));
      return body;
    },
    { operation, args },
  );
}
const documentText = (locator) =>
  locator.evaluate((el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll(".peer-caret").forEach((n) => n.remove());
    return copy.textContent;
  });
async function selectText(page, text) {
  await page.locator(".ProseMirror").focus();
  await page.locator(".ProseMirror").evaluate((el, text) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.textContent.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
    throw Error("Missing selection text");
  }, text);
  await expect.poll(() => page.evaluate(() => getSelection().toString())).toBe(text);
}
try {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
  for (const page of [a, b]) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/mermaid.js") rendererRequests.push(page);
    });
    await page.goto(origin + "/api/auth/login");
    await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
  }
  const fixture = await call(a, "create_page", {
    title: "Authoring interaction fixture " + Date.now(),
    markdown: "Select these words to discuss. Open [Pages implementation notes](/llms.txt).",
    idempotency_key: crypto.randomUUID(),
  });
  for (const page of [a, b]) {
    await page.goto(origin + "/p/" + fixture.page_id);
    await expect(page.locator(".ProseMirror")).toContainText("Select these words");
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
      timeout: 20000,
    });
  }
  await selectText(a, "these words");
  const comment = a.getByRole("button", { name: "Comment on selection", exact: true });
  await expect(comment).toBeEnabled();
  await a.screenshot({ path: output + "/selection-toolbar.png", fullPage: true });
  await comment.click();
  await a
    .getByRole("textbox", { name: "Comment on selection" })
    .fill("A comment from the selection toolbar");
  await a.getByRole("button", { name: "Send", exact: true }).first().click();
  await expect(b.locator(".comment-passage")).toHaveText("these words");
  await b.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(b.locator(".thread .quote")).toHaveText("these words");
  await expect(b.locator(".thread .message")).toContainText("A comment from the selection toolbar");
  // New comments are explicitly anchored to a passage through the selection toolbar.
  await expect(a.getByRole("button", { name: "Comment on this block" })).toHaveCount(0);
  await expect(a.locator(".comment-composer")).toHaveCount(0);
  await selectText(a, "Select");
  await comment.click();
  await expect(a.getByRole("textbox", { name: "Comment on selection" })).toBeVisible();
  await expect(a.locator(".composer-context")).toHaveText("Select");
  await a.locator(".comment-composer").getByRole("button", { name: "Cancel", exact: true }).click();
  // Close the sidebar before checking link and mobile geometry.
  await a.getByRole("button", { name: "Comments", exact: true }).click();
  const link = a.locator(".ProseMirror a");
  await link.click();
  const linkMenu = a.getByRole("dialog", { name: "Link", exact: true });
  await expect(linkMenu).toBeVisible();
  await a.screenshot({ path: output + "/link-menu.png", fullPage: true });
  const open = linkMenu.getByRole("link", { name: "Open link", exact: true });
  await expect(open).toHaveAttribute("href", origin + "/llms.txt");
  await expect(open).toHaveAttribute("rel", /noopener/);
  const popupPromise = a.waitForEvent("popup");
  await open.click();
  const popup = await popupPromise;
  await popup.waitForURL(origin + "/llms.txt");
  await popup.close();
  await linkMenu.getByRole("button", { name: "Edit link", exact: true }).click();
  await linkMenu
    .getByRole("textbox", { name: "Link address" })
    .fill(origin + "/llms.txt?from=editor");
  await linkMenu.getByRole("button", { name: "Save link", exact: true }).click();
  await expect(b.locator(".ProseMirror a")).toHaveAttribute(
    "href",
    origin + "/llms.txt?from=editor",
  );
  await expect(a.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
    timeout: 20000,
  });
  let current = await call(a, "read_page", { page_id: fixture.page_id });
  await call(a, "patch_page", {
    page_id: fixture.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "replace_match",
        block_id: current.blocks[0].id,
        match_text: "discuss",
        replacement: "review",
      },
    ],
  });
  await expect(b.locator(".ProseMirror")).toContainText("Select these words to review");
  await expect(b.locator(".comment-passage")).toHaveText("these words");
  await expect(b.locator(".thread .quote")).toHaveText("these words");

  assert.equal(rendererRequests.length, 0, "prose-only documents do not load Mermaid");
  const codeFixture = await call(a, "create_page", {
    title: "Code and Mermaid fixture " + Date.now(),
    markdown: "",
    idempotency_key: crypto.randomUUID(),
  });
  for (const page of [a, b]) {
    await page.goto(origin + "/p/" + codeFixture.page_id);
    await expect(page.locator(".ProseMirror")).toHaveCount(1);
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
      timeout: 20000,
    });
  }
  await a.locator(".ProseMirror").click();
  await a.keyboard.type("```");
  await a.keyboard.press("Enter");
  await expect(a.locator(".code-block-source")).toBeVisible();
  await a.keyboard.insertText(diagram);
  await expect.poll(() => documentText(b.locator(".code-block-source code"))).toBe(diagram);
  await a.getByRole("combobox", { name: "Code language" }).selectOption("mermaid");
  for (const page of [a, b]) {
    await expect(page.locator(".code-block-preview svg.pele")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".code-block-preview")).toContainText("Warehouse");
    assert.equal(
      await page
        .locator(".code-block-preview svg.pele")
        .locator("script, foreignObject, image, a, use")
        .count(),
      0,
    );
  }
  assert.ok(
    rendererRequests.includes(a) && rendererRequests.includes(b),
    "each peer loads the local renderer only for its diagram",
  );
  // A toolbar round-trip must never leave a caret inside hidden code.
  await a.locator('.rich-toolbar [data-toolbar-control="style"]').focus();
  await a.keyboard.press("Escape");
  await a.keyboard.press("ArrowRight");
  await expect(a.locator(".code-block")).toHaveClass(/ProseMirror-selectednode/);
  await a.getByRole("button", { name: "Source", exact: true }).focus();
  await a.keyboard.press("Enter");
  await expect(a.locator(".code-block-source")).toBeVisible();
  await a.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(a.locator(".code-block-preview svg.pele")).toBeVisible();
  await a.screenshot({ path: output + "/mermaid-desktop.png", fullPage: true });
  await a.getByRole("button", { name: "Source", exact: true }).click();
  await expect(a.locator(".code-block-source")).toBeVisible();
  // Source edits go through the regular editor binding; peer remains in preview.
  await selectText(a, "Metrics");
  await a.keyboard.insertText("Telemetry");
  await expect(b.locator(".code-block-preview")).toContainText("Telemetry");
  await a.keyboard.press("ControlOrMeta+Enter");
  await a.keyboard.type("Writing continues after the diagram.");
  await expect
    .poll(() => documentText(b.locator(".ProseMirror > p").last()))
    .toBe("Writing continues after the diagram.");
  await expect(a.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
    timeout: 20000,
  });
  current = await call(a, "read_page", { page_id: codeFixture.page_id });
  assert.ok(current.blocks[0].markdown.includes("```mermaid"));
  assert.ok(current.blocks[0].markdown.includes(diagram.replace("Metrics", "Telemetry")));
  assert.ok(
    !current.blocks[0].markdown.includes("<svg"),
    "rendered preview never enters the document",
  );
  // Invalid diagrams preserve editable source and recover after a targeted edit.
  await call(a, "patch_page", {
    page_id: codeFixture.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "replace_match",
        block_id: current.blocks[0].id,
        match_text: "graph TD",
        replacement: "invalid-diagram",
      },
    ],
  });
  await expect(b.locator(".code-block-status")).toContainText("Diagram unavailable");
  current = await call(a, "read_page", { page_id: codeFixture.page_id });
  await call(a, "patch_page", {
    page_id: codeFixture.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "replace_match",
        block_id: current.blocks[0].id,
        match_text: "invalid-diagram",
        replacement: "graph TD",
      },
    ],
  });
  await expect(b.locator(".code-block-preview svg.pele")).toBeVisible();
  await a.reload();
  await expect(a.locator(".code-block-preview svg.pele")).toBeVisible({ timeout: 20000 });
  await a.setViewportSize({ width: 390, height: 844 });
  await expect(a.locator(".code-block-preview svg.pele")).toBeVisible();
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await a.screenshot({ path: output + "/mermaid-mobile.png", fullPage: true });
  await a.getByRole("button", { name: "Source", exact: true }).click();
  await expect(a.locator(".code-block-source")).toBeVisible();
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await a.screenshot({ path: output + "/code-mobile.png", fullPage: true });
  console.log(
    JSON.stringify({
      page_id: fixture.page_id,
      code_page_id: codeFixture.page_id,
      errors,
      screenshots: output,
    }),
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
