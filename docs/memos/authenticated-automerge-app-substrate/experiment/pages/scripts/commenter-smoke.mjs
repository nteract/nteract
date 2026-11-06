// A commenter can read and comment on a Page, but never edit it.
//
// Two local OIDC accounts: the owner, and alice invited as a commenter through
// the sharing UI. Alice's browser opens the Page read-only, comments on a
// selection, and the owner sees it live. Her comment never moves the Page's
// heads. She resolves the owner's thread, but can't edit the owner's message;
// a raw sync write that tries is refused by the host. MCP follows the same
// rules with her API key.
//
// Runs under local-sharing-e2e.mjs --commenter, which supplies PAGES_ORIGIN,
// PAGES_SCREENSHOTS and PAGES_E2E_KEY_FILE.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import * as A from "@automerge/automerge";
import { plainPeer } from "./plain-peer.mjs";
import { expectPendingInvite } from "./sharing-rows.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const keys = process.env.PAGES_E2E_KEY_FILE
  ? JSON.parse(await readFile(process.env.PAGES_E2E_KEY_FILE, "utf8"))
  : null;
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-commenter-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { completed: [], errors: [] };
let pageId, owner, commenter;

async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });
async function mcp(name, operation, args) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${keys[name]}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Pages-Driver": "E2E agent",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: operation, arguments: args },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return {
    error: body.result?.isError === true,
    body: JSON.parse(body.result.content[0].text),
  };
}
const content = (page) => page.locator("article wg-content").first();
/** A raw peer for `page`'s signed-in account: it syncs the comments document
 * directly, with none of the viewer's or tools' rules. */
async function rawCommentsPeer(page) {
  const cookie = (await page.context().cookies(origin))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const headers = { cookie, origin };
  const discovery = await fetch(`${origin}/api/connect?page=${pageId}`, {
    headers,
  }).then((r) => r.json());
  assert.ok(discovery.commentsDocumentId, JSON.stringify(discovery));
  const features = ["comments-doc", "horizontal-rule", "preserved-markdown-converted", "strike"];
  const plain = await plainPeer({ origin, pageId, cookie, discovery, features });
  const handle = await plain.repo.find(discovery.commentsDocumentId);
  return {
    handle,
    async change(fn) {
      handle.change(fn);
      await plain.repo.flush().catch(() => {});
    },
    close: () => plain.close(),
  };
}
const checkpoint = (name) => {
  report.completed.push(name);
  console.log("PASS " + name);
};
/** Select `text` inside `locator`, as a person dragging over it would. */
async function select(page, locator, text) {
  await locator.evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
    throw Error("Text not found");
  }, text);
  await page.waitForTimeout(100);
}

try {
  const people = [];
  for (const email of ["dev@localhost", "alice@localhost"]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    const begin = await ctx.request.get(`${origin}/api/auth/login`, {
      maxRedirects: 0,
    });
    assert.equal(begin.status(), 302);
    const authorize = new URL(begin.headers().location);
    authorize.searchParams.set("login_hint", email);
    await page.goto(authorize.href, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
      timeout: 60000,
    });
    // Every socket a tab opens: a reconnect would show up as a second one.
    page.sockets = [];
    page.on("websocket", (socket) => page.sockets.push(socket.url()));
    people.push(page);
  }
  [owner, commenter] = people;
  const created = await tool(owner, "create_page", {
    title: "Commenter fixture " + Date.now(),
    markdown: "A passage worth discussing.",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  pageId = created.body.page_id;
  report.pageId = pageId;

  // The owner invites alice with Can comment from the sharing panel.
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText("worth discussing");
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = owner.getByRole("dialog", { name: "Share Page" });
  await dialog.getByLabel("Invite by email").fill("alice@localhost");
  await dialog.getByLabel("Access", { exact: true }).selectOption("commenter");
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expectPendingInvite(dialog, "alice@localhost", "commenter");
  const invited = await api(owner, `/api/access?page=${pageId}`);
  assert.equal(invited.body.invites[0]?.role, "commenter", JSON.stringify(invited.body));
  await owner.screenshot({ path: `${output}/share-commenter.png` });
  await owner.keyboard.press("Escape");
  checkpoint("the owner invites a commenter from the sharing panel");

  const read = (await tool(owner, "read_page", { page_id: pageId })).body;
  const blockId = read.blocks[0].id;
  const ownerComment = await tool(owner, "manage_page_comment", {
    page_id: pageId,
    action: "add",
    block_id: blockId,
    body: "Owner's note",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(ownerComment.status, 200, JSON.stringify(ownerComment.body));
  assert.deepEqual(ownerComment.body.heads, read.heads, "a comment never moves the Page's heads");

  // Alice opens the Page: she can read and comment, not edit.
  await commenter.goto(`${origin}/p/${pageId}`);
  await expect(content(commenter)).toContainText("worth discussing");
  const connect = await api(commenter, `/api/connect?page=${pageId}`);
  assert.equal(connect.body.access.role, "commenter");
  assert.equal(connect.body.access.canComment, true);
  assert.equal(connect.body.access.canWrite, false);
  await expect(content(commenter)).not.toHaveAttribute("contenteditable", "true");
  checkpoint("a commenter opens the Page read-only");

  // Comment on a selection from the read-only text.
  await content(commenter).click();
  await select(commenter, content(commenter), "passage");
  await commenter.getByRole("button", { name: "Comment on selection", exact: true }).click();
  const popover = commenter.getByRole("dialog", {
    name: "Comment on selection",
    exact: true,
  });
  const inline = popover.getByRole("textbox", {
    name: "Comment on selection",
    exact: true,
  });
  await expect(inline).toBeFocused();
  await inline.pressSequentially("Alice was here");
  await inline.press("ControlOrMeta+Enter");
  await expect(popover).toHaveCount(0);
  await commenter.screenshot({ path: `${output}/commenter-commented.png` });
  await expect
    .poll(async () =>
      (await tool(owner, "read_page", { page_id: pageId })).body.comments.some(
        (t) => t.messages[0]?.body === "Alice was here",
      ),
    )
    .toBe(true);
  const afterComment = (await tool(owner, "read_page", { page_id: pageId })).body;
  assert.deepEqual(afterComment.heads, read.heads, "the commenter's comment moved no Page heads");
  const aliceThread = afterComment.comments.find((t) => t.messages[0]?.body === "Alice was here");
  assert.equal(aliceThread.selectionContext?.text ?? "passage", "passage");
  checkpoint("a commenter comments on a selection; the Page's heads never move");

  // The owner sees it live in the thread list.
  await owner.getByRole("button", { name: /^Comments/ }).click();
  await expect(owner.locator(".thread-row", { hasText: "Alice was here" })).toBeVisible();
  checkpoint("the owner sees the commenter's thread live");

  // Typing in the Page reaches nothing.
  await content(commenter).click();
  await commenter.keyboard.type("should not land");
  await commenter.waitForTimeout(1500);
  const afterTyping = (await tool(owner, "read_page", { page_id: pageId })).body;
  assert.deepEqual(afterTyping.heads, read.heads);
  assert.equal(afterTyping.blocks[0].markdown, "A passage worth discussing.");

  // The HTTP tools follow the same rules.
  const edit = await tool(commenter, "edit_page", {
    page_id: pageId,
    base_heads: read.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [{ op: "set_title", title: "Not allowed" }],
  });
  assert.equal(edit.status, 403);
  const resolve = await tool(commenter, "manage_page_comment", {
    page_id: pageId,
    action: "resolve",
    thread_id: ownerComment.body.result.thread_id,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(resolve.status, 200, JSON.stringify(resolve.body));
  const rewrite = await tool(commenter, "manage_page_comment", {
    page_id: pageId,
    action: "edit",
    thread_id: ownerComment.body.result.thread_id,
    message_id: ownerComment.body.result.message_id,
    body: "Rewritten by alice",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(rewrite.status, 403);
  assert.equal(rewrite.body.code, "comment_not_author");
  checkpoint("a commenter resolves any thread but can't edit the Page or another's message");

  // A raw sync peer as alice skips every rule and rewrites the owner's
  // message in the comments document. The host's per-author check refuses
  // it before storage, so nobody ever sees it.
  await commenter.getByRole("button", { name: /^Comments/ }).click();
  const ownerSockets = owner.sockets.length,
    commenterSockets = commenter.sockets.length;
  const raw = await rawCommentsPeer(commenter);
  const ownerThreadId = ownerComment.body.result.thread_id;
  const ownerMessageId = ownerComment.body.result.message_id;
  await expect
    .poll(() => !!raw.handle.doc()?.threads?.[ownerThreadId], {
      timeout: 15000,
    })
    .toBe(true);
  await raw.change((doc) =>
    A.updateText(doc, ["threads", ownerThreadId, "messages", ownerMessageId, "richText"], "Forged"),
  );
  await commenter.waitForTimeout(3000);
  await raw.close();
  const afterForge = (
    await tool(owner, "list_page_comments", { page_id: pageId, state: "all" })
  ).body.comments.find((thread) => thread.id === ownerThreadId);
  assert.equal(afterForge.messages[0].body, "Owner's note", "the forged edit never landed");
  // Every other peer keeps syncing both ways on the sockets it already had.
  // The owner types in the Page; alice's open tab shows it.
  await content(owner).click();
  await owner.keyboard.press("End");
  await owner.keyboard.type(" Still live.");
  await expect(content(commenter)).toContainText("Still live.", {
    timeout: 10000,
  });
  // A comment the host writes reaches both open tabs.
  const live = await tool(owner, "manage_page_comment", {
    page_id: pageId,
    action: "reply",
    // Alice's open thread: the owner's is resolved and collapsed by now.
    thread_id: aliceThread.id,
    body: "Reply after the refusal",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(live.status, 200, JSON.stringify(live.body));
  // Both open tabs show the reply arrive (collapsed as "1 reply").
  const aliceCard = (page) => page.locator(`[data-thread-id="${aliceThread.id}"]`);
  for (const page of [owner, commenter])
    await expect(aliceCard(page)).toContainText("1 reply", { timeout: 10000 });
  // Only the forged change was refused: alice herself still comments.
  const receipts = [];
  const observeReceipt = (response) => {
    const url = new URL(response.url());
    if (
      url.pathname === "/api/saved" &&
      url.searchParams.get("page") === pageId &&
      !url.searchParams.has("probe") &&
      response.request().method() === "POST" &&
      response.status() === 200
    )
      receipts.push(response);
  };
  commenter.on("response", observeReceipt);
  const aliceReply = await tool(commenter, "manage_page_comment", {
    page_id: pageId,
    action: "reply",
    thread_id: aliceThread.id,
    body: "Alice still comments",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(aliceReply.status, 200, JSON.stringify(aliceReply.body));
  await expect(aliceCard(owner)).toContainText("2 replies", { timeout: 10000 });
  assert.equal(owner.sockets.length, ownerSockets, "the owner's tab never reconnected");
  assert.equal(commenter.sockets.length, commenterSockets, "alice's tab never reconnected");
  checkpoint(
    "a raw sync edit of another author's message is refused; every other peer keeps syncing",
  );

  // Her thread list offers the comment controls a commenter holds.
  await commenter.locator(`.thread-row[data-thread-id="${aliceThread.id}"]`).click();
  const ownThread = commenter.locator(`.thread-view[data-thread-id="${aliceThread.id}"]`);
  await expect(ownThread).toBeVisible();
  await expect(ownThread.getByRole("button", { name: "Resolve", exact: true })).toBeEnabled();
  await expect(ownThread.getByRole("button", { name: "Reply", exact: true })).toBeEnabled();
  await commenter.screenshot({ path: `${output}/commenter-threads.png` });

  if (keys) {
    const agent = await mcp("editor", "manage_page_comment", {
      page_id: pageId,
      action: "reply",
      thread_id: aliceThread.id,
      body: "Agent reply as alice",
      idempotency_key: crypto.randomUUID(),
    });
    assert.equal(agent.error, false, JSON.stringify(agent.body));
    const agentEdit = await mcp("editor", "patch_page", {
      page_id: pageId,
      base_heads: read.heads,
      idempotency_key: crypto.randomUUID(),
      operations: [
        {
          op: "replace_match",
          block_id: blockId,
          match_text: "passage",
          replacement: "x",
        },
      ],
    });
    assert.equal(agentEdit.error, true);
    checkpoint("MCP: alice's key comments but can't edit");
  }

  // Clean promotion requires the latest remote reply's receipt to be applied
  // in Alice's tab, not merely accepted by the agent or visible to the owner.
  const frontier = (await tool(owner, "read_page", { page_id: pageId })).body;
  await expect(
    commenter.getByText(keys ? "3 replies" : "2 replies", { exact: true }),
  ).toBeVisible();
  const sameHeads = (a, b) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((head) => b.includes(head));
  const matchingReceipt = () =>
    receipts.find((response) => {
      const request = response.request().postDataJSON();
      return (
        sameHeads(request.heads, frontier.heads) &&
        sameHeads(request.comment_heads, frontier.comment_heads)
      );
    });
  await expect.poll(() => !!matchingReceipt()).toBe(true);
  assert.equal(await matchingReceipt().finished(), null);
  // The reply render queued Syncing before this response. Saved proves the
  // client applied its acknowledgement, rather than an in-flight HTTP answer.
  await expect(commenter.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
  commenter.off("response", observeReceipt);
  checkpoint("Alice applied a receipt for the latest Page and comment frontiers");

  // The clean tab reconnects on the new grant without login or manual reload.
  const current = await api(owner, `/api/access?page=${pageId}`);
  const alice = (await api(commenter, "/api/auth/session")).body.identity.principal;
  const promoted = await api(owner, `/api/access?page=${pageId}`, {
    action: "set_role",
    principal: alice,
    role: "editor",
    expected_revision: current.body.access.revision,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  await expect(content(commenter)).toHaveAttribute("contenteditable", "true", {
    timeout: 15000,
  });
  checkpoint("promoting a commenter to editor makes the open tab editable");

  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack ?? error.message;
  for (const [name, page] of [
    ["owner", owner],
    ["commenter", commenter],
  ])
    if (page) {
      report[name] = await page
        .locator("body")
        .innerText()
        .catch(() => null);
      await page.screenshot({ path: `${output}/failure-${name}.png` }).catch(() => {});
    }
  console.error("FAIL\n" + report.failure);
  process.exitCode = 1;
} finally {
  if (pageId && owner) {
    try {
      const r = await tool(owner, "read_page", { page_id: pageId });
      const d = await tool(owner, "delete_page", {
        page_id: pageId,
        base_heads: r.body.heads,
        idempotency_key: crypto.randomUUID(),
      });
      report.cleaned = d.status === 200;
    } catch (error) {
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
