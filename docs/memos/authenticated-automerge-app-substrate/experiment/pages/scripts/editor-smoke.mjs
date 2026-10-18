// Generated local OIDC fixtures only. The WebSocket proxy below never interprets
// or manufactures native protocol bytes; it holds one client's outbound frames.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-native-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true }),
  errors = [];
const text = (editor) =>
  editor.evaluate((el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll(".peer-caret").forEach((n) => n.remove());
    return copy.textContent;
  });
async function edge(editor, end = false) {
  await editor.focus();
  await editor.page().waitForTimeout(30);
  await editor.evaluate((el, end) => {
    const s = getSelection();
    s.selectAllChildren(el);
    if (end) s.collapseToEnd();
    else s.collapseToStart();
  }, end);
  await editor.page().waitForTimeout(30);
}
async function call(page, operation, args, driver) {
  return page.evaluate(
    async ({ operation, args, driver }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(driver ? { "X-Pages-Driver": driver } : {}),
        },
        body: JSON.stringify({ operation, arguments: args }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(JSON.stringify(body));
      return body;
    },
    { operation, args, driver },
  );
}
try {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  let hold = false,
    blocked = null,
    held = 0;
  await contexts[0].routeWebSocket(/\/api\/sync\?/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((data) => {
      if (hold && !blocked) blocked = ws;
      if (ws === blocked) {
        held++;
        return;
      }
      server.send(data);
    });
    server.onMessage((data) => ws.send(data));
  });
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  for (const p of pages) {
    p.on("pageerror", (error) => errors.push(error.message));
    await p.goto(origin + "/api/auth/login");
    await expect(p.getByRole("button", { name: "Sign out" })).toBeVisible();
  }
  const [a, b] = pages;
  const result = await call(a, "create_page", {
    title: "Browser collaboration fixture " + Date.now(),
    markdown: "The **fox** crossed the garden.",
    idempotency_key: crypto.randomUUID(),
  });
  for (const p of pages) {
    await p.goto(origin + "/?page=" + result.page_id);
    await expect(p.locator(".ProseMirror")).toHaveText("The fox crossed the garden.", {
      timeout: 20000,
    });
    await expect(p.getByRole("status")).toHaveText("Saved", { timeout: 20000 });
  }
  // window.open clones sessionStorage. Web Locks must force a separate signer
  // and byte-store namespace instead of two live owners of the same database.
  const popupPromise = contexts[0].waitForEvent("page");
  await a.evaluate(() => window.open(location.href, "_blank"));
  const duplicate = await popupPromise;
  await expect(duplicate.getByRole("status")).toHaveText("Saved", { timeout: 20000 });
  const fingerprint = (p) =>
    p.evaluate(async () => {
      const key = Object.keys(sessionStorage).find((k) => k.startsWith("pages-native:"));
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(sessionStorage.getItem(key)),
      );
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    });
  assert.notEqual(
    await fingerprint(a),
    await fingerprint(duplicate),
    "duplicated tab has exclusive local storage identity",
  );
  await duplicate.close();
  const ea = a.locator(".ProseMirror"),
    eb = b.locator(".ProseMirror");
  await edge(ea);
  await a.keyboard.type("Hello ");
  await expect.poll(() => text(eb), { timeout: 15000 }).toBe("Hello The fox crossed the garden.");
  await expect(b.locator(".peer-caret")).toContainText("Local Developer");
  await a.keyboard.press("Shift+ArrowLeft");
  await a.keyboard.press("Shift+ArrowLeft");
  await expect(b.locator(".peer-selection")).toHaveCount(1);
  await a.getByRole("button", { name: "Comment on this block" }).click();
  await a.getByRole("textbox", { name: "Comment on selection" }).fill("A realtime passage comment");
  await a.getByRole("button", { name: "Send", exact: true }).first().click();
  await b.getByRole("button", { name: /^Comments/ }).click();
  await expect(b.locator(".message")).toContainText("A realtime passage comment");
  await expect
    .poll(async () => (await eb.locator(".comment-passage").allTextContents()).join(""))
    .toBe("o ");
  await b
    .getByRole("textbox", { name: "Reply", exact: true })
    .fill("A reply from the other browser");
  await b.locator(".thread").getByRole("button", { name: "Send", exact: true }).click();
  await expect(a.locator(".thread")).toContainText("A reply from the other browser");
  // An agent's guarded semantic edit travels through the same native document.
  await expect(a.getByRole("status")).toHaveText("Saved", { timeout: 20000 });
  let current = await call(a, "read_page", { page_id: result.page_id });
  await call(
    a,
    "patch_page",
    {
      page_id: result.page_id,
      base_heads: current.heads,
      idempotency_key: crypto.randomUUID(),
      operations: [
        {
          op: "patch_block_markdown",
          block_id: current.blocks[0].id,
          replacements: [{ old: "fox", new: "otter" }],
        },
      ],
    },
    "Fixture agent",
  );
  await expect(eb.locator(".remote-edit").filter({ hasText: "tter" })).toBeVisible();
  await expect(eb.locator(".remote-edit").filter({ hasText: "tter" })).toHaveAttribute(
    "title",
    /Fixture agent/,
  );
  await expect(b.locator(".thread .quote")).toHaveText("o");
  // Local undo removes only the local editor action, retaining the peer's text.
  await edge(eb, true);
  await b.keyboard.type(" Peer");
  await expect.poll(() => text(ea)).toContain(" Peer");
  await edge(ea);
  await a.keyboard.type("Own ");
  await expect.poll(() => text(eb)).toContain("Own ");
  assert.match(
    await text(ea),
    /^Own Hello/,
    "fixture inserts at document start rather than replacing its prior selected passage",
  );
  await a.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => text(ea)).not.toContain("Own ");
  await expect.poll(() => text(ea)).toContain(" Peer");
  await expect(b.locator(".thread .quote")).toHaveText("o");
  // Hold actual outbound native frames, persist a local edit, discard that
  // socket on reload, then reconstruct from the same exclusive IndexedDB store.
  await expect(a.getByRole("status")).toHaveText("Saved", { timeout: 20000 });
  hold = true;
  await edge(ea);
  await a.keyboard.type("Pending ");
  await expect.poll(() => held).toBeGreaterThan(0);
  await a.waitForTimeout(600); // IndexedDB writes finish independently of server receipt.
  assert.equal((await text(eb)).includes("Pending "), false);
  await edge(eb, true);
  await b.keyboard.type(" Concurrent");
  await expect.poll(() => text(ea)).toContain("Concurrent");
  hold = false;
  await a.reload();
  await expect.poll(() => text(ea), { timeout: 20000 }).toContain("Pending ");
  await expect.poll(() => text(eb), { timeout: 20000 }).toContain("Pending ");
  await expect.poll(() => text(ea)).toContain("Concurrent");
  await expect(a.getByRole("status")).toHaveText("Saved", { timeout: 20000 });
  assert.equal(await text(ea), await text(eb));
  await expect(b.locator(".thread .quote")).toHaveText("o");
  await edge(ea, true);
  await a.keyboard.press("Enter");
  await a.keyboard.type("Another paragraph");
  await expect(eb.locator("p")).toHaveCount(2);
  await edge(ea.locator("p").last());
  await a.keyboard.press("Backspace");
  await expect(eb.locator("p")).toHaveCount(1);
  await expect.poll(() => text(eb)).toBe(await text(ea));
  await expect(b.locator(".thread .quote")).toHaveText("o");
  await a.screenshot({ path: output + "/desktop.png", fullPage: true });
  await a.setViewportSize({ width: 390, height: 844 });
  await a.getByRole("button", { name: /^Comments/ }).click();
  await a.screenshot({ path: output + "/mobile.png", fullPage: true });
  assert.equal(
    await a.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    "mobile horizontal overflow",
  );
  await b.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(b.getByRole("link", { name: "Sign in with Anaconda" })).toBeVisible();
  const denied = await b.request.post(origin + "/api/tools", {
    data: { operation: "read_page", arguments: { page_id: result.page_id } },
    headers: { Origin: origin },
  });
  assert.equal(denied.status(), 401, "signed out browser cannot read a Page");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      page_id: result.page_id,
      checks: [
        "two browser native sync",
        "duplicate-tab exclusive IndexedDB ownership",
        "named cursor and selection",
        "anchored comment and reply",
        "agent patch illumination and label",
        "peer-preserving undo",
        "pending IndexedDB reload and concurrent merge",
        "paragraph split/join",
        "desktop and 390px layout",
        "sign out revokes HTTP access",
      ],
      screenshots: output,
    }),
  );
} catch (error) {
  console.error("Page errors:", errors);
  for (const context of browser.contexts())
    for (const p of context.pages()) console.error("Page:", await p.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
