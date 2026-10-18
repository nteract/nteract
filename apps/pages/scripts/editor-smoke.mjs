// Real-browser generated-fixture check against the isolated local Pages service.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9893";
assert.equal(new URL(origin).hostname, "localhost");
async function text(editor) {
  return editor.evaluate((el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll(".peer-caret").forEach((n) => n.remove());
    return copy.textContent;
  });
}
async function edge(editor, end = false) {
  await editor.evaluate((el, end) => {
    el.focus();
    const s = window.getSelection();
    s.selectAllChildren(el);
    if (end) s.collapseToEnd();
    else s.collapseToStart();
  }, end);
}
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  for (const p of pages) {
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(origin + "/api/auth/login");
    await expect(p.getByRole("button", { name: "Sign out" })).toBeVisible();
  }
  const [a, b] = pages;
  const title = "Realtime editor fixture " + Date.now();
  const result = await a.evaluate(
    async ({ title }) => {
      const r = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "create_page",
          arguments: {
            title,
            idempotency_key: crypto.randomUUID(),
            block_units: [
              { markdown: "The **fox** crossed the garden.", format: "automerge-rich-text-v1" },
            ],
          },
        }),
      });
      if (!r.ok) throw Error(await r.text());
      return r.json();
    },
    { title },
  );
  for (const p of pages) {
    await p.goto(origin + "/?page=" + result.page_id);
    await expect(p.locator(".ProseMirror")).toHaveText("The fox crossed the garden.");
    await expect(p.getByRole("status")).toHaveText("Saved · Live");
  }
  const ea = a.locator(".ProseMirror"),
    eb = b.locator(".ProseMirror");
  await ea.click();
  await edge(ea);
  await a.keyboard.type("Hello ");
  await expect.poll(() => text(eb)).toBe("Hello The fox crossed the garden.");
  await expect(b.locator(".peer-caret")).toHaveCount(1);
  await a.keyboard.press("Shift+ArrowLeft");
  await a.keyboard.press("Shift+ArrowLeft");
  await expect(b.locator(".peer-selection")).toHaveCount(1);
  await a.getByRole("button", { name: "Comment", exact: true }).click();
  await a
    .getByRole("textbox", { name: "Comment on selected passage" })
    .fill("A realtime passage comment");
  await a.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(b.getByRole("button", { name: "1 open comment" })).toBeVisible();
  await b.getByRole("button", { name: "1 open comment" }).click();
  await expect(b.locator(".comment-thread blockquote")).toHaveText("o");
  await expect(b.locator(".comment-message")).toContainText("A realtime passage comment");
  // Formatting and peer-preserving undo run through real browser transactions.
  await eb.click();
  await edge(eb, true);
  await b.getByRole("button", { name: "Italic", exact: true }).click();
  await b.keyboard.type(" Peer");
  await expect(ea.locator("em")).toHaveText(" Peer");
  await b.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => text(ea)).toBe("Hello The fox crossed the garden.");
  // Concurrent offline input must converge after the first browser reconnects.
  await contexts[0].setOffline(true);
  await ea.click();
  await edge(ea);
  await a.keyboard.type("Left ");
  await eb.click();
  await edge(eb, true);
  await b.keyboard.type(" Right");
  await contexts[0].setOffline(false);
  await expect.poll(() => text(ea), { timeout: 20000 }).toContain("Right");
  await expect.poll(() => text(eb), { timeout: 20000 }).toContain("Left");
  assert.equal(await text(ea), await text(eb));
  await expect(a.getByRole("status")).toHaveText("Saved · Live");
  await expect(b.getByRole("status")).toHaveText("Saved · Live");
  await edge(ea, true);
  await a.keyboard.press("Enter");
  await a.keyboard.type("Another paragraph");
  await expect(eb.locator("p")).toHaveCount(2);
  await edge(ea.locator("p").last());
  await a.keyboard.press("Backspace");
  await expect(eb.locator("p")).toHaveCount(1);
  await expect.poll(() => text(eb)).toBe(await text(ea));
  await expect(a.getByRole("status")).toHaveText("Saved · Live");
  const finalText = await text(ea);
  await a.reload();
  await expect(ea).toHaveText(finalText);
  await a.screenshot({ path: ".context/pages-rich-desktop.png", fullPage: true });
  await a.setViewportSize({ width: 390, height: 844 });
  await a.screenshot({ path: ".context/pages-rich-mobile.png", fullPage: true });
  assert.equal(
    await a.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    "mobile horizontal overflow",
  );
  const legacy = await b.evaluate(async () => {
    const response = await fetch("/api/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "create_page",
        arguments: {
          title: "Source conversion fixture",
          markdown: "Existing **Markdown**",
          idempotency_key: crypto.randomUUID(),
        },
      }),
    });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  });
  await b.goto(origin + "/?page=" + legacy.page_id);
  await expect(b.getByRole("status")).toHaveText("Saved · Live");
  await b.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(eb).toHaveText("Existing Markdown");
  await expect(eb.locator("strong")).toHaveText("Markdown");
  await edge(eb, true);
  await b.keyboard.type(" converted");
  await expect(b.getByRole("status")).toHaveText("Saved · Live");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      page: result.page_id,
      checks: [
        "two sessions",
        "presence caret and selection",
        "passage comment",
        "formatting",
        "undo",
        "offline concurrent merge",
        "paragraph split and join",
        "durable reload",
        "390px layout",
        "existing source conversion",
      ],
      finalText,
    }),
  );
} catch (e) {
  console.error("Browser errors:", errors);
  for (const c of browser.contexts())
    for (const p of c.pages()) console.error("Page:", await p.locator("body").innerText());
  throw e;
} finally {
  await browser.close();
}
