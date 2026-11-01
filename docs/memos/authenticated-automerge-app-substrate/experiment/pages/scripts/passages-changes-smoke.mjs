// Local OIDC, real browser typing, and real MCP. No live origins or API keys.
// Run against the built local Pages fixture; this script never starts a server.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9896";
const url = new URL(origin);
assert.equal(url.origin, origin);
assert.equal(url.hostname, "localhost");
assert.equal(url.protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-passages-changes-browser";
await mkdir(output, { recursive: true });
const started = Date.now();
const budget = { requests: 0, mainLimit: 60, totalLimit: 70, mainMs: 210000, totalMs: 240000 };
const report = { origin, completed: [], errors: [], screenshots: [] };
const secrets = new Set();
const driver = "Passage changes QA agent";
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
let page,
  pageId,
  cleaning = false,
  stage = "local OIDC sign-in";
const content = () => page.locator("wg-content").first();
const body = (result) => result.blocks.map((block) => block.markdown).join("\n\n");
const redact = (value) => {
  let text = String(value);
  for (const secret of secrets) text = text.replaceAll(secret, "[retry authority]");
  return text;
};
function checkBudget(request = false) {
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < (cleaning ? budget.totalMs : budget.mainMs),
    "local smoke time budget exceeded",
  );
  if (request) {
    budget.requests++;
    assert.ok(
      budget.requests <= (cleaning ? budget.totalLimit : budget.mainLimit),
      "local smoke request budget exceeded",
    );
  }
}
function complete(name) {
  checkBudget();
  report.completed.push(name);
  console.log("PASS " + name);
}
function rememberAuthority(result) {
  for (const key of ["retry_token", "retry_key_prefix"])
    if (typeof result?.[key] === "string") secrets.add(result[key]);
  return result;
}
function guarded(authority, args) {
  assert.equal(typeof authority.retry_token, "string");
  assert.match(authority.retry_key_prefix, /^v1_[a-f0-9]{64}_$/);
  const key = authority.retry_key_prefix + crypto.randomUUID();
  secrets.add(key);
  return {
    ...args,
    retry_token: authority.retry_token,
    idempotency_key: key,
  };
}
async function rawMcp(name, args = {}) {
  checkBudget(true);
  const timeoutMs = Math.min(
    8000,
    (cleaning ? budget.totalMs : budget.mainMs) - (Date.now() - started),
  );
  const result = await page.evaluate(
    async ({ name, args, driver, timeoutMs }) => {
      // The authenticated local browser session supplies cookies. Neither cookies
      // nor bearer credentials are exposed to Node or written to the report.
      const response = await fetch("/mcp", {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Pages-Driver": driver,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      if (!response.ok) throw Error(`${name}: HTTP ${response.status}`);
      const envelope = await response.json();
      if (envelope.error) throw Error(`${name}: JSON-RPC error ${envelope.error.code}`);
      const result = envelope.result;
      const text = result?.content?.find((entry) => entry.type === "text")?.text;
      if (typeof text !== "string") throw Error(`${name}: missing MCP text result`);
      return { isError: result.isError === true, data: JSON.parse(text) };
    },
    { name, args, driver, timeoutMs },
  );
  rememberAuthority(result.data);
  return result;
}
async function mcp(name, args = {}) {
  const result = await rawMcp(name, args);
  if (result.isError) throw Error(`${name}: tool error ${result.data.code ?? "unspecified"}`);
  return result.data;
}
const read = () => mcp("read_page", { page_id: pageId, comments: "none" });
// Comments have their own revision: `commentHeads` is the comment_heads from
// the previous read, the baseline for comment changes.
const changes = (heads, comments = "none", commentHeads) =>
  mcp("read_page_changes", {
    page_id: pageId,
    since_heads: heads,
    comments,
    ...(commentHeads && { since_comment_heads: commentHeads }),
  });
function patchArgs(authority, operations) {
  return guarded(authority, {
    page_id: pageId,
    base_heads: authority.heads,
    conflict_scope: "target",
    operations,
  });
}
function commentArgs(authority, fields) {
  return guarded(authority, { page_id: pageId, base_heads: authority.heads, ...fields });
}
async function selectText(text, collapse = false) {
  checkBudget();
  await content().focus();
  await content().evaluate(
    (element, { text, collapse }) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement.closest(
            ".peer-caret,.wordgard-widget,.wordgard-diagram-actions,select,button",
          )
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      let source = "",
        node;
      while ((node = walker.nextNode())) {
        nodes.push({ node, start: source.length });
        source += node.textContent;
      }
      const start = source.indexOf(text);
      if (start < 0) throw Error("Selection fixture text is missing");
      const at = (offset, starting = false) => {
        const entry = nodes.find(
          ({ node, start }) =>
            offset >= start &&
            (starting ? offset < start + node.length : offset <= start + node.length),
        );
        if (!entry) throw Error("Selection fixture offset is missing");
        return [entry.node, offset - entry.start];
      };
      const range = document.createRange();
      range.setStart(...at(start, true));
      range.setEnd(...at(start + text.length));
      if (collapse) range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { text, collapse },
  );
  await expect
    .poll(() => page.evaluate(() => getSelection().toString()))
    .toBe(collapse ? "" : text);
}
async function typeAndObserve(target, replacement, collapse = false) {
  await selectText(target, collapse);
  await page.keyboard.insertText(replacement);
  const expected = collapse ? target + replacement : replacement;
  await expect(content()).toContainText(expected);
  // Bounded polling, counted against the same request cap as every MCP call.
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await read();
    if (body(current).includes(expected)) return current;
    await page.waitForTimeout(250);
  }
  throw Error("Native browser edit did not reach the server within eight reads");
}
function onlyNodes(delta, expected) {
  assert.equal(delta.title_changed, false);
  assert.equal(delta.attribution, "unavailable");
  assert.deepEqual(
    delta.changes.map(({ scope, change, node_index }) => ({ scope, change, node_index })),
    expected.map((node_index) => ({ scope: "node", change: "updated", node_index })),
  );
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(8000);
  context.setDefaultNavigationTimeout(20000);
  page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(redact(error.message).slice(0, 1000)));
  await page.goto(origin + "/api/auth/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 20000,
  });
  checkBudget(true);
  const session = await page.evaluate(async () => (await fetch("/api/auth/session")).json());
  assert.equal(session.editor, "wordgard");
  assert.ok(session.identity && session.canWrite, "local OIDC session can edit");
  complete(stage);

  stage = "one disposable rich-text Page through MCP";
  const initial = [
    "Alpha belongs to the human.",
    "Beta belongs to the agent.",
    "North keeps shared apple.",
    "South keeps shared apple.",
    "Preserve this exact sentinel.",
  ].join("\n\n");
  const catalog = await mcp("list_pages");
  const created = await mcp(
    "create_page",
    guarded(catalog, { title: "Local passage changes QA " + Date.now(), markdown: initial }),
  );
  pageId = created.page_id;
  report.fixture = pageId;
  await page.goto(origin + "/p/" + pageId, { waitUntil: "domcontentloaded" });
  await expect(content()).toContainText("Beta belongs to the agent.", { timeout: 20000 });
  const baseline = await read();
  assert.equal(baseline.blocks.length, 1);
  assert.equal(baseline.outline.entries.length, 5);
  const blockId = baseline.blocks[0].id;
  complete(stage);

  stage = "stale agent passage edit preserves native browser typing in the same block";
  const human = await typeAndObserve(
    "Alpha belongs to the human.",
    "Alpha was revised in the browser.",
  );
  const firstArgs = patchArgs(baseline, [
    {
      op: "replace_match",
      block_id: blockId,
      node_index: 1,
      match_text: "Beta belongs to the agent.",
      replacement: "Beta was revised by the agent.",
    },
  ]);
  const firstReceipt = await mcp("patch_page", firstArgs);
  assert.equal(firstReceipt.concurrency.rebased, true);
  assert.deepEqual(firstReceipt.concurrency.base_heads, baseline.heads);
  assert.deepEqual(firstReceipt.concurrency.observed_heads, human.heads);
  await expect(content()).toContainText("Beta was revised by the agent.");
  await expect(content()).toContainText("Alpha was revised in the browser.");
  const firstDelta = await changes(baseline.heads, "summary", baseline.comment_heads);
  onlyNodes(firstDelta, [0, 1]);
  assert.ok(!JSON.stringify(firstDelta).includes("Preserve this exact sentinel."));
  assert.equal(firstDelta.comments.length, 0);
  complete(stage);

  stage = "revision-bound node index disambiguates repeated visible text";
  const repeatedArgs = patchArgs(firstDelta, [
    {
      op: "replace_match",
      block_id: blockId,
      node_index: 3,
      match_text: "shared apple",
      replacement: "selected orange",
    },
  ]);
  await mcp("patch_page", repeatedArgs);
  const repeatedDelta = await changes(firstDelta.heads);
  onlyNodes(repeatedDelta, [3]);
  assert.equal(repeatedDelta.changes[0].markdown, "South keeps selected orange.");
  await expect(content()).toContainText("North keeps shared apple.");
  await expect(content()).toContainText("South keeps selected orange.");
  complete(stage);

  stage = "changed target returns a conflict address and catch-up permits a deliberate new edit";
  const beforeOverlap = repeatedDelta;
  await typeAndObserve("Beta was revised by the agent.", "Beta was changed again by the human.");
  const rejected = await rawMcp(
    "patch_page",
    patchArgs(beforeOverlap, [
      {
        op: "replace_match",
        block_id: blockId,
        node_index: 1,
        match_text: "Beta was revised by the agent.",
        replacement: "This stale edit must not appear.",
      },
    ]),
  );
  assert.equal(rejected.isError, true);
  assert.equal(rejected.data.code, "edit_conflict");
  assert.deepEqual(
    rejected.data.conflicts.map(({ block_id, node_index }) => ({ block_id, node_index })),
    [{ block_id: blockId, node_index: 1 }],
  );
  const caughtUp = await changes(beforeOverlap.heads);
  onlyNodes(caughtUp, [1]);
  assert.equal(caughtUp.changes[0].markdown, "Beta was changed again by the human.");
  const freshArgs = patchArgs(caughtUp, [
    {
      op: "replace_match",
      block_id: blockId,
      node_index: 1,
      match_text: "Beta was changed again by the human.",
      replacement: "Beta includes the human update and agent follow-up.",
    },
  ]);
  const freshReceipt = await mcp("patch_page", freshArgs);
  assert.equal(freshReceipt.concurrency.rebased, false);
  await expect(content()).toContainText("Beta includes the human update and agent follow-up.");
  complete(stage);

  stage = "exact retry after a later browser edit returns the original receipt without reauthoring";
  const later = await typeAndObserve("Alpha was revised in the browser.", " Still editing.", true);
  const retry = await mcp("patch_page", firstArgs);
  assert.deepEqual(retry, firstReceipt);
  const afterRetry = await read();
  assert.deepEqual(afterRetry.heads, later.heads);
  assert.equal(
    body(afterRetry),
    [
      "Alpha was revised in the browser. Still editing.",
      "Beta includes the human update and agent follow-up.",
      "North keeps shared apple.",
      "South keeps selected orange.",
      "Preserve this exact sentinel.",
    ].join("\n\n"),
  );
  complete(stage);

  stage = "comment catch-up returns current updates and omits deleted message content";
  const originalComment = "Original disposable comment " + crypto.randomUUID();
  const revisedComment = "Revised disposable comment " + crypto.randomUUID();
  const added = await mcp(
    "manage_page_comment",
    commentArgs(afterRetry, {
      action: "add",
      block_id: blockId,
      selected_text: "selected orange",
      body: originalComment,
    }),
  );
  const { thread_id, message_id } = added.result;
  // A comment moves only the comments document; the Page's heads stay put.
  assert.deepEqual(added.heads, afterRetry.heads);
  const addedDelta = await changes(afterRetry.heads, "all", afterRetry.comment_heads);
  assert.deepEqual(addedDelta.changes, []);
  assert.deepEqual(addedDelta.heads, afterRetry.heads);
  assert.equal(addedDelta.comments.length, 1);
  assert.equal(addedDelta.comments[0].thread_id, thread_id);
  assert.equal(addedDelta.comments[0].messages[0].body, originalComment);
  assert.ok(!JSON.stringify(addedDelta).includes("relativePositionBase64"));
  await mcp(
    "manage_page_comment",
    commentArgs(addedDelta, { action: "edit", thread_id, message_id, body: revisedComment }),
  );
  const editedDelta = await changes(addedDelta.heads, "all", addedDelta.comment_heads);
  assert.equal(editedDelta.comments[0].messages[0].body, revisedComment);
  assert.ok(!JSON.stringify(editedDelta).includes(originalComment));
  await mcp(
    "manage_page_comment",
    commentArgs(editedDelta, { action: "delete_message", thread_id, message_id }),
  );
  const deletedDelta = await changes(addedDelta.heads, "all", addedDelta.comment_heads);
  assert.deepEqual(deletedDelta.changes, []);
  assert.equal(deletedDelta.comments.length, 1);
  const tombstone = deletedDelta.comments[0].messages.find((message) => message.id === message_id);
  assert.ok(tombstone?.deletedAt);
  assert.equal(tombstone.body, undefined);
  assert.equal(tombstone.author, undefined);
  for (const secret of [originalComment, revisedComment])
    assert.ok(
      !JSON.stringify(deletedDelta).includes(secret),
      "deleted comment body is absent from the delta",
    );
  const unchanged = await changes(deletedDelta.heads, "all", deletedDelta.comment_heads);
  assert.deepEqual(unchanged.changes, []);
  assert.deepEqual(unchanged.comments, []);
  assert.deepEqual(unchanged.heads, deletedDelta.heads);
  complete(stage);

  stage = "full readback and browser state agree";
  const final = await read();
  assert.equal(body(final), body(afterRetry));
  for (const block of final.blocks)
    for (const paragraph of block.markdown.split("\n\n"))
      await expect(content()).toContainText(paragraph);
  await selectText("Beta includes the human update and agent follow-up.");
  await page.screenshot({ path: output + "/passages-and-changes.png", fullPage: true });
  report.screenshots.push("passages-and-changes.png");
  assert.deepEqual(report.errors, [], "no unhandled browser errors");
  complete(stage);
  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.stage = stage;
  report.failure = redact(error.stack ?? error);
  if (page)
    await page.screenshot({ path: output + "/failure.png", fullPage: true }).catch(() => {});
  console.error("FAIL " + stage + "\n" + report.failure);
  process.exitCode = 1;
} finally {
  // Only the Page ID returned by this run's create call is eligible for cleanup.
  cleaning = true;
  if (page && pageId) {
    try {
      const current = await read();
      const catalog = await mcp("list_pages");
      await mcp("delete_page", guarded(catalog, { page_id: pageId, base_heads: current.heads }));
      await purgeTrashedFixture(mcp, pageId, async () => guarded(await mcp("list_pages"), {}));
      const absent = await rawMcp("read_page", { page_id: pageId, comments: "none" });
      assert.equal(absent.isError, true);
      const remaining = await mcp("list_pages");
      assert.ok(!remaining.pages.some((entry) => entry.page_id === pageId));
      report.cleanedUp = true;
    } catch (error) {
      report.cleanedUp = false;
      report.result = "fail";
      report.cleanupFailure = redact(error.message);
      process.exitCode = 1;
    }
  }
  report.requests = budget.requests;
  report.elapsedMs = Date.now() - started;
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
