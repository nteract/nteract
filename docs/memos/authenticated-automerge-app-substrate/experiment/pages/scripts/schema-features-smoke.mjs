// The schema-feature gate against a running local Wordgard fixture.
//
// A Node sync peer stamps one Page with a feature id no build knows, the way
// a newer build would. The host then refuses that peer's next edit
// (its build declared no features) and accepts one from a peer that declares
// the feature. Tool writes get unsupported_schema_feature, read_page reports
// the stamp, and the browser opens it read-only with the reload notice. A
// current Page carries only the comments-doc stamp and stays editable; a build
// from before the comments document is refused on it.
//
// Then the Markdown cutover: a strikethrough or horizontal rule write stamps
// its feature, so a baseline build's edits are refused; agent writes
// with math get unsupported_markdown; and a draft that holds a preserved block
// from an older build is refused at registration and registers nothing.
//
//   PAGES_ORIGIN=http://localhost:9894 node scripts/schema-features-smoke.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { textPath } from "../model/richtext.mjs";
import { retryKey } from "../model/retry-key.mjs";
import { chromium, expect } from "@playwright/test";
import { eventually, plainPeer } from "./plain-peer.mjs";

const origin = process.env.PAGES_ORIGIN ?? "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost", "Generated fixture requires local OIDC");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-schema-features-browser";
await mkdir(output, { recursive: true });
const FUTURE = "e2e-future-feature";
// What every current Page carries: its comments live in their own document.
const CURRENT = ["comments-doc"];
// viewer/SchemaNotice.jsx SCHEMA_UNSUPPORTED.
const SCHEMA_UNSUPPORTED =
  "This Page uses features this version doesn't support. Reload to update.";
const report = { origin, completed: [], errors: [] };
const browser = await chromium.launch({ headless: true });
let page,
  stage = "sign in";

function checkpoint(name) {
  report.completed.push(name);
  console.log("PASS " + name);
}

async function tool(operation, args = {}) {
  return page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, arguments: args }),
      });
      return { status: response.status, body: await response.json() };
    },
    { operation, args },
  );
}

async function create(title, markdown) {
  const result = await tool("create_page", {
    title,
    markdown,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.page_id;
}

/** A raw sync peer on a Page, admitted with `declared` as its build's schema
 * features (none: the baseline, like a build from before the stamp). */
async function syncPeer(cookie, pageId, declared) {
  const headers = { cookie, origin };
  const discovery = await fetch(`${origin}/api/connect?page=${pageId}`, {
    headers,
  }).then((response) => response.json());
  assert.ok(discovery.documentId, JSON.stringify(discovery));
  const peer = await plainPeer({
    origin,
    pageId,
    cookie,
    discovery,
    features: declared,
  });
  const handle = await peer.repo.find(discovery.documentId);
  return {
    handle,
    async change(fn) {
      handle.change(fn);
      await peer.repo.flush();
      const heads = A.getHeads(handle.doc());
      let last;
      await eventually(async () => {
        const response = await fetch(`${origin}/api/saved?page=${pageId}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ heads, schema_features: declared }),
        });
        last = { status: response.status, body: await response.json() };
        return response.ok || last.body.code === "schema_unsupported";
      }, 20_000);
      return last;
    },
    close: () => peer.close(),
  };
}

const content = () => page.locator(".page-block wg-content");
const title = () => page.getByRole("textbox", { name: "Page title" });
const notice = () => page.getByRole("alert").filter({ hasText: SCHEMA_UNSUPPORTED });

try {
  const context = await browser.newContext();
  page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.stack ?? error.message));
  await page.goto(origin + "/api/auth/login");
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60_000,
  });
  const cookie = (await context.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  checkpoint("local OIDC sign-in");

  stage = "a current Page is editable";
  const baseline = await create("Baseline " + Date.now(), "Plain words.");
  const baselineRead = await tool("read_page", {
    page_id: baseline,
    comments: "none",
  });
  // A new Page's comments live in their own document.
  assert.deepEqual(baselineRead.body.schema_features, CURRENT);
  await page.goto(origin + "/p/" + baseline);
  await expect(content().first()).toBeVisible();
  await expect(title()).toBeEditable();
  await expect(content().first()).toHaveAttribute("contenteditable", "true");
  await expect(notice()).toHaveCount(0);
  checkpoint("a current Page opens editable with no notice");

  stage = "a build from before the comments document is refused";
  const older = await syncPeer(cookie, baseline, []);
  const olderEdit = await older.change((doc) => {
    doc.comments = { stray: { messages: {} } };
  });
  assert.equal(olderEdit.status, 409, JSON.stringify(olderEdit.body));
  assert.equal(olderEdit.body.code, "schema_unsupported");
  await older.close();
  checkpoint("an old tab can't write comments into the Page document");

  stage = "a sync peer stamps an unknown feature";
  const future = await create("Future " + Date.now(), "Words from a newer build.");
  // A peer with this build's baseline may stamp a Page it can write.
  const stale = await syncPeer(cookie, future, CURRENT);
  const stamping = await stale.change((doc) => {
    doc.schema = { features: [...CURRENT, FUTURE] };
  });
  assert.equal(stamping.status, 200, JSON.stringify(stamping.body));
  const stampedRead = await tool("read_page", {
    page_id: future,
    comments: "none",
  });
  assert.equal(stampedRead.status, 200);
  assert.deepEqual(stampedRead.body.schema_features, [...CURRENT, FUTURE]);
  checkpoint("read_page reports the stamp");

  stage = "the host refuses edits from a build without the feature";
  const staleEdit = await stale.change((doc) => {
    doc.staleEdit = "should not land";
  });
  assert.equal(staleEdit.status, 409, JSON.stringify(staleEdit.body));
  assert.equal(staleEdit.body.code, "schema_unsupported");
  // The receipt answers as soon as the heads are missing; give the refused
  // edit time to reach the host before checking nothing landed.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await stale.close();
  const afterStale = await tool("read_page", {
    page_id: future,
    comments: "none",
  });
  assert.deepEqual([...afterStale.body.heads].sort(), [...stampedRead.body.heads].sort());
  checkpoint("a stale build's edit is refused and the Page is unchanged");

  stage = "the host accepts edits from a build with the feature";
  const fresh = await syncPeer(cookie, future, [...CURRENT, FUTURE]);
  // Page-body admission refuses unknown root keys, so the edit types text.
  const freshEdit = await fresh.change((doc) => {
    A.splice(doc, textPath(orderedBlockIds(doc)[0]), 0, 0, "Lands. ");
  });
  assert.equal(freshEdit.status, 200, JSON.stringify(freshEdit.body));
  await fresh.close();
  const futureRead = await tool("read_page", {
    page_id: future,
    comments: "none",
  });
  assert.notDeepEqual([...futureRead.body.heads].sort(), [...stampedRead.body.heads].sort());
  checkpoint("a current build's edit is accepted");

  stage = "the host refuses writes it can't express";
  const refused = await tool("patch_page", {
    page_id: future,
    base_heads: futureRead.body.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "replace_match",
        block_id: futureRead.body.blocks[0].id,
        match_text: "newer",
        replacement: "older",
      },
    ],
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "unsupported_schema_feature");
  assert.deepEqual(refused.body.unsupported_features, [FUTURE]);
  checkpoint("tool writes are refused with unsupported_schema_feature");

  stage = "the viewer opens the stamped Page read-only";
  await page.goto(origin + "/p/" + future);
  await expect(content().first()).toBeVisible();
  await expect(notice()).toBeVisible();
  await expect(notice().getByRole("button", { name: "Reload" })).toBeEnabled();
  await expect(title()).not.toBeEditable();
  await expect(content().first()).toHaveAttribute("contenteditable", "false");
  await expect(
    page.getByRole("button", { name: "Comment on this block", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: output + "/read-only.png", fullPage: true });
  // Typing reaches nothing: the Page's heads stay where the stamp left them.
  await content().first().click();
  await page.keyboard.type("local edit");
  await title().click({ force: true });
  await page.keyboard.type(" renamed");
  await page.waitForTimeout(1500);
  const after = await tool("read_page", { page_id: future, comments: "none" });
  assert.deepEqual([...after.body.heads].sort(), [...futureRead.body.heads].sort());
  // The text the feature-aware peer typed, and nothing from this tab.
  assert.equal(after.body.blocks[0].markdown, "Lands. Words from a newer build.");
  checkpoint("the viewer shows the notice and writes nothing");

  stage = "the notice's Reload reloads the tab";
  await Promise.all([
    page.waitForEvent("load", { timeout: 30_000 }),
    notice().getByRole("button", { name: "Reload" }).click(),
  ]);
  await expect(content().first()).toBeVisible();
  // This build still lacks the feature, so the Page opens read-only again.
  await expect(notice()).toBeVisible();
  checkpoint("Reload goes ahead from a read-only Page");

  stage = "strikethrough and rules stamp their features";
  const struck = await create("Struck " + Date.now(), "Old ~~plan~~.\n\n---\n\nNew plan.");
  const struckRead = await tool("read_page", {
    page_id: struck,
    comments: "none",
  });
  assert.deepEqual(struckRead.body.schema_features, [...CURRENT, "horizontal-rule", "strike"]);
  assert.equal(struckRead.body.blocks[0].markdown, "Old ~~plan~~.\n\n---\n\nNew plan.");
  const baselinePeer = await syncPeer(cookie, struck, CURRENT);
  const baselineEdit = await baselinePeer.change((doc) => {
    doc.staleEdit = "should not land";
  });
  assert.equal(baselineEdit.status, 409, JSON.stringify(baselineEdit.body));
  assert.equal(baselineEdit.body.code, "schema_unsupported");
  await baselinePeer.close();
  await page.goto(origin + "/p/" + struck);
  await expect(content().first().locator("s")).toHaveText("plan");
  await expect(content().first().locator("hr")).toHaveCount(1);
  await expect(notice()).toHaveCount(0);
  await expect(content().first()).toHaveAttribute("contenteditable", "true");
  checkpoint("strike and horizontal-rule stamp; a baseline build's edit is refused");

  stage = "agent Markdown with math is refused with its position";
  const math = await tool("create_page", {
    title: "Math " + Date.now(),
    markdown: "Intro\n\nArea: $\\pi r^2$ and `$kept$`.",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(math.status, 400, JSON.stringify(math.body));
  assert.equal(math.body.code, "unsupported_markdown");
  assert.deepEqual(math.body.unsupported, {
    construct: "math",
    line: 3,
    column: 7,
    excerpt: "$\\pi r^2$",
  });
  checkpoint("create_page refuses math with unsupported_markdown, line and column");

  stage = "registration refuses a draft holding a preserved block";
  const draftId = crypto.randomUUID();
  const draftTitle = "Draft " + Date.now();
  let draft = A.change(A.from(createPageData({ pageId: draftId, title: draftTitle })), (doc) =>
    initializePage(doc, ""),
  );
  const draftBlock = orderedBlockIds(draft)[0];
  // The `pages-opaque` marker a protocol 1 viewer could write.
  draft = A.change(draft, (doc) =>
    A.splitBlock(doc, textPath(draftBlock), 0, {
      type: new A.ImmutableString("pages-opaque"),
      parents: [],
      attrs: { source: new A.ImmutableString("Keep ~~drop~~. The value is $x$.") },
      isEmbed: false,
    }),
  );
  const prepared = await tool("list_pages", {});
  const session = await page.evaluate(() =>
    fetch("/api/auth/session").then((response) => response.json()),
  );
  const registered = await page.evaluate(
    (body) =>
      fetch("/api/pages/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    {
      expected_principal: session.identity.principal,
      page_id: draftId,
      document_id: interpretAsDocumentId(generateAutomergeUrl()),
      initial_snapshot_base64: Buffer.from(A.save(draft)).toString("base64"),
      title: draftTitle,
      retry_token: prepared.body.retry_token,
      idempotency_key: await retryKey(prepared.body.retry_token),
    },
  );
  assert.equal(registered.status, 400, JSON.stringify(registered.body));
  const unregistered = await tool("read_page", { page_id: draftId, comments: "none" });
  assert.notEqual(unregistered.status, 200, JSON.stringify(unregistered.body));
  checkpoint("registration refuses a preserved block and registers nothing");

  stage = "navigating back to the current Page";
  await page.goto(origin + "/p/" + baseline);
  await expect(content().first()).toBeVisible();
  await expect(notice()).toHaveCount(0);
  await expect(title()).toBeEditable();
  checkpoint("the gate is per Page");

  assert.deepEqual(report.errors, []);
  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.stage = stage;
  report.failure = String(error.stack ?? error);
  if (page) {
    await page.screenshot({ path: output + "/failure.png", fullPage: true }).catch(() => {});
    await writeFile(output + "/failure.html", await page.content()).catch(() => {});
  }
  console.error("FAIL " + stage + "\n" + report.failure);
  process.exitCode = 1;
} finally {
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
