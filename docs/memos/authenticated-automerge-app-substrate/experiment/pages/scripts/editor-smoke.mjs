// Generated local OIDC fixtures only. The WebSocket proxy below never interprets
// or manufactures native protocol bytes; it holds one client's outbound frames.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { selectionToolbarPosition } from "../viewer/selection-toolbar.mjs";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-native-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: process.env.PAGES_HEADED !== "1" }),
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
async function assertStableToolbarGeometry(page) {
  // Use the real controls and CSS, without moving the focused editor's toolbar.
  const boxes = await page.locator(".rich-toolbar").evaluate((toolbar) => {
    const fixture = document.createElement("div");
    fixture.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
    fixture.style.width = toolbar.parentElement.getBoundingClientRect().width + "px";
    const clone = toolbar.cloneNode(true);
    clone.removeAttribute("style");
    fixture.append(clone);
    document.body.append(fixture);
    try {
      return [false, true].map((floating) => {
        clone.classList.toggle("is-floating", floating);
        const { width, height } = clone.getBoundingClientRect();
        return { width, height };
      });
    } finally {
      fixture.remove();
    }
  });
  assert.deepEqual(boxes[0], boxes[1], "floating keeps the toolbar's measured box stable");
  // This range leaves just enough room below for the normal row. If floating
  // adds padding/borders, the ResizeObserver-driven decision oscillates forever.
  const viewport = { left: 0, top: 64, right: 1200, bottom: 800 };
  const selection = {
    start: { left: 400, right: 400, top: 120, bottom: 144 },
    end: { left: 600, right: 600, top: 714, bottom: 738 },
    viewport,
  };
  let floating = false;
  const placements = [];
  for (let round = 0; round < 6; round++) {
    const position = selectionToolbarPosition({ ...selection, ...boxes[Number(floating)] });
    assert.ok(position, "the boundary selection has space for a floating toolbar");
    assert.ok(position.top + boxes[Number(floating)].height <= viewport.bottom - 12);
    placements.push(position);
    floating = true;
  }
  assert.ok(
    placements.every((position) => JSON.stringify(position) === JSON.stringify(placements[0])),
    "placement settles without a resize feedback loop",
  );
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
    held = 0,
    delaying = false;
  const delayedFrames = [];
  await contexts[0].routeWebSocket(/\/api\/sync\?/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((data) => {
      if (delaying) {
        delayedFrames.push({ server, data });
        return;
      }
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
    await expect(p.getByRole("button", { name: /, switch page$/ })).toBeVisible();
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
  await expect(a.getByRole("status")).toHaveText("Saved", { timeout: 20000 });
  await expect.poll(() => text(eb), { timeout: 20000 }).toBe(await text(ea));
  // Cross the authorization recheck boundary before delaying native traffic.
  // A fresh connection would miss the retired-admission-context regression.
  await new Promise((resolve) => setTimeout(resolve, 17000));
  // Delay real outbound native frames through the server's 10-second heads
  // deadline, then return to the same tab and release the original bytes. A
  // late receipt within the bounded retry window must clear its error
  // without another edit, Retry or reload.
  await a.bringToFront();
  const documentTimeOrigin = await a.evaluate(() => performance.timeOrigin);
  const delayedReceipt = a.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/saved" &&
      new URL(response.url()).searchParams.get("page") === result.page_id &&
      response.status() === 409,
    { timeout: 20000 },
  );
  delaying = true;
  await edge(ea, true);
  await a.keyboard.type(" Returned from another tab.");
  await expect.poll(() => delayedFrames.length).toBeGreaterThan(0);
  const backgroundTab = await contexts[0].newPage();
  await backgroundTab.goto("about:blank");
  await backgroundTab.bringToFront();
  const backgroundVisibility = await a.evaluate(() => document.visibilityState);
  assert.equal(await backgroundTab.evaluate(() => document.visibilityState), "visible");
  assert.equal((await text(eb)).includes("Returned from another tab."), false);
  assert.equal((await (await delayedReceipt).json()).error, "Requested edits have not arrived");
  await expect(a.getByRole("alert")).toContainText("Requested edits have not arrived");
  await a.bringToFront();
  const returnedVisibility = await a.evaluate(() => document.visibilityState);
  assert.equal(returnedVisibility, "visible");
  await backgroundTab.close();
  delaying = false;
  for (const { server, data } of delayedFrames.splice(0)) server.send(data);
  await expect.poll(() => text(eb), { timeout: 20000 }).toContain("Returned from another tab.");
  await expect(a.getByRole("status")).toHaveText("Saved", { timeout: 20000 });
  await expect(a.getByRole("alert")).toHaveCount(0);
  assert.equal(await a.evaluate(() => performance.timeOrigin), documentTimeOrigin, "no reload");
  assert.equal(await text(ea), await text(eb));
  const afterReturn = await call(a, "read_page", { page_id: result.page_id });
  assert.match(afterReturn.blocks[0].markdown, /Returned from another tab\./);
  const tabReturn = {
    background_visibility: backgroundVisibility,
    returned_visibility: returnedVisibility,
    visibility_transition_verified: backgroundVisibility === "hidden",
  };
  // Headless Chromium can report every tab as visible. In that mode this is
  // delayed-frame/receipt recovery, not proof of background throttling. Set
  // PAGES_HEADED=1 to exercise actual tab visibility when the browser supports it.
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
  // Recovery must leave both existing peers able to send their next edit.
  await edge(eb, true);
  await b.keyboard.type(" Peer after reload.");
  await expect.poll(() => text(ea), { timeout: 20000 }).toContain("Peer after reload.");
  await edge(ea, true);
  await a.keyboard.type(" Owner after reload.");
  await expect.poll(() => text(eb), { timeout: 20000 }).toContain("Owner after reload.");
  await edge(ea, true);
  await a.keyboard.press("Enter");
  await a.keyboard.type("Another paragraph");
  await expect(eb.locator("p")).toHaveCount(2);
  await edge(ea.locator("p").last());
  await a.keyboard.press("Backspace");
  await expect(eb.locator("p")).toHaveCount(1);
  await expect.poll(() => text(eb)).toBe(await text(ea));
  await expect(b.locator(".thread .quote")).toHaveText("o");
  // Commands read the actual selection, including stored marks before typing.
  const bold = a.getByRole("button", { name: "Bold", exact: true });
  await edge(ea, true);
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  await a.keyboard.press("ControlOrMeta+b");
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await a.keyboard.type(" Bold words");
  await expect(ea.locator("strong").last()).toHaveText(" Bold words");
  await a.keyboard.press("ControlOrMeta+b");
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  await a.keyboard.type(" plain");
  await edge(ea.locator("strong").last(), true);
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await a.keyboard.press("Shift+ArrowLeft");
  await a.keyboard.press("Shift+ArrowLeft");
  const selected = await a.evaluate(() => getSelection().toString());
  await a.getByRole("button", { name: "Italic", exact: true }).click();
  assert.equal(
    await a.evaluate(() => getSelection().toString()),
    selected,
    "toolbar preserves selection",
  );
  await expect(ea).toBeFocused();
  await expect(a.getByRole("button", { name: "Italic", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await a.keyboard.press("Alt+F10");
  await expect(a.locator(".rich-toolbar :focus")).toHaveCount(1);
  // Alt-F10 starts at the style select; arrows leave its native option navigation.
  await a.keyboard.press("ArrowRight");
  await expect(bold).toBeFocused();
  await a.keyboard.press("End");
  await expect(a.getByRole("button", { name: "Numbered list", exact: true })).toBeFocused();
  await a.keyboard.press("Escape");
  await expect(ea).toBeFocused();
  await edge(ea, true);
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  await a.getByRole("combobox", { name: "Text style" }).focus();
  await a.getByRole("combobox", { name: "Text style" }).selectOption("heading2");
  await expect(a.getByRole("combobox", { name: "Text style" })).toBeFocused();
  await expect(ea.locator("h2")).toHaveCount(1);
  await a.getByRole("combobox", { name: "Text style" }).selectOption("paragraph");
  await a.getByRole("button", { name: "Bulleted list", exact: true }).click();
  await expect(ea.locator("ul")).toHaveCount(1);
  await expect(a.getByRole("button", { name: "Bulleted list", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await a.getByRole("button", { name: "Numbered list", exact: true }).click();
  await expect(ea.locator("ol")).toHaveCount(1);
  await expect(ea.locator("ul")).toHaveCount(0);
  await a.getByRole("button", { name: "Numbered list", exact: true }).click();
  await expect(ea.locator("ol")).toHaveCount(0);
  await expect.poll(() => text(eb)).toBe(await text(ea));
  await assertStableToolbarGeometry(a);
  const commentsToggle = a.getByRole("button", { name: "Comments", exact: true });
  if ((await commentsToggle.getAttribute("aria-expanded")) !== "true") await commentsToggle.click();
  await a.screenshot({ path: output + "/desktop.png", fullPage: true });
  await a.setViewportSize({ width: 390, height: 844 });
  await expect(commentsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(a.getByRole("dialog", { name: "Comments", exact: true })).toBeVisible();
  await expect(a.locator(".comments")).toHaveJSProperty("open", true);
  await a.screenshot({ path: output + "/mobile-comments.png", fullPage: true });
  await a.keyboard.press("Escape");
  await expect(commentsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(commentsToggle).toBeFocused();
  await a.screenshot({ path: output + "/mobile.png", fullPage: true });
  assert.equal(
    await a.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    "mobile horizontal overflow",
  );
  // A selection in block A must not become a comment target for block B.
  await a.setViewportSize({ width: 1280, height: 900 });
  await edge(ea);
  await a.keyboard.press("Shift+ArrowRight");
  await a.getByRole("button", { name: "Block", exact: true }).click();
  const second = a.locator(".ProseMirror").nth(1);
  await expect(second).toBeFocused();
  await a.keyboard.type("A second block");
  await a.getByRole("button", { name: "Comment on this block" }).nth(1).click();
  await expect(a.getByRole("textbox", { name: "Comment on block", exact: true })).toBeVisible();
  await expect(a.locator(".composer-context")).toHaveCount(0);
  await a
    .getByRole("textbox", { name: "Comment on block", exact: true })
    .fill("Unsent block draft");
  await a.getByRole("button", { name: "Comment on this block" }).first().click();
  await expect(a.getByRole("textbox", { name: "Comment on block", exact: true })).toHaveValue(
    "Unsent block draft",
  );
  await a.getByLabel("Account", { exact: true }).click();
  await expect(a.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await a.keyboard.press("Escape");
  await expect(a.getByRole("button", { name: "Sign out", exact: true })).toBeHidden();
  await expect(a.getByLabel("Account", { exact: true })).toBeFocused();
  await a.getByLabel("Document actions", { exact: true }).click();
  await expect(a.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  await a.getByRole("textbox", { name: "Page title" }).click();
  await expect(a.getByRole("button", { name: "Delete", exact: true })).toBeHidden();
  await expect(a.getByRole("status")).toHaveText("Saved", { timeout: 20000 });
  current = await call(a, "read_page", { page_id: result.page_id });
  await call(a, "patch_page", {
    page_id: result.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "patch_block_markdown",
        block_id: current.blocks[0].id,
        replacements: [{ old: current.blocks[0].markdown, new: "" }],
      },
    ],
  });
  await expect(a.locator(".thread").getByText("Passage removed", { exact: true })).toBeVisible();
  await expect(
    a.locator(".thread").getByRole("button", { name: "Show block", exact: true }),
  ).toBeVisible();
  await a.locator(".thread").getByRole("button", { name: "Show block", exact: true }).click();
  await a.getByRole("button", { name: /, switch page$/ }).click();
  await expect(a.getByRole("textbox", { name: "Search Pages" })).toBeFocused();
  await a.getByRole("button", { name: "New Page", exact: true }).click();
  await expect(a.locator(".ProseMirror")).toHaveCount(1);
  await expect(a.locator(".ProseMirror")).toBeFocused();
  await expect(a.getByRole("button", { name: "Comments", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await a.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(a.getByRole("textbox", { name: "Comment on block", exact: true })).toHaveValue("");
  await b.getByLabel("Account", { exact: true }).click();
  await b.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(b.getByRole("link", { name: "Sign In" })).toBeVisible();
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
        tabReturn.visibility_transition_verified
          ? "delayed native frames and background-tab return without reload"
          : "delayed native frames and receipt recovery without reload (tabs remained visible)",
        "paragraph split/join",
        "selection-driven toolbar and keyboard access",
        "stable floating-toolbar geometry at viewport boundaries",
        "text style and list commands",
        "desktop and 390px layout with modal comments",
        "comment target isolation, draft retargeting and detached block navigation",
        "menu dismissal and local new-page focus",
        "sign out revokes HTTP access",
      ],
      tab_return: tabReturn,
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
