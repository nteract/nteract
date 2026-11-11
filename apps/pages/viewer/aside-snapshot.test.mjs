// An aside reaches a Page or a comment draft through pasted HTML: the schema
// parses `<aside>` from Aside's shape. Markdown has no form for it, and the
// session projects every block and comment to Markdown on each change
// (snapshot → projectPage → blockMarkdown). The projection reads it as a
// notice and its content, so the editor and the composer keep working.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import * as A from "@automerge/automerge";
import "fake-indexeddb/auto";
import { parse } from "wordgard/doc";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { newCommentsDoc } from "../model/comments-test-support.mjs";
import { updateSpansConfig } from "../model/marks.mjs";
import { textPath } from "../model/richtext-format.mjs";
import { Aside, encode, schema } from "./wordgard-model.mjs";
import { PageSession } from "./session.mjs";

const owner = {
  role: "owner",
  generation: 0,
  revision: 0,
  canRead: true,
  canWrite: true,
  canComment: true,
  canManageAccess: true,
  canDelete: true,
};

/** The editor's tree for pasted HTML. */
function pasted(t, html) {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  dom.window.document.body.innerHTML = html;
  return parse(schema, dom.window.document.body);
}

function session(t, body) {
  const value = new PageSession("page_fixture", { buildFeatures: ["comments-doc"] });
  let page = A.change(A.from(createPageData({ pageId: "page_fixture", title: "Plan" })), (d) => {
    initializePage(d);
    A.updateSpans(d, textPath(orderedBlockIds(d)[0]), encode(body), updateSpansConfig);
  });
  let comments = newCommentsDoc();
  value.credentialCanWrite = true;
  value.access = owner;
  value.identity = { principal: "user:kyle", displayName: "Kyle", driver: "Browser" };
  value.handle = { doc: () => page, change: () => Promise.resolve() };
  value.commentsHandle = {
    doc: () => comments,
    change(fn) {
      comments = A.change(comments, fn);
      return Promise.resolve();
    },
  };
  value.queueSaved = () => {};
  value.observeSchema();
  value.updateCapabilities();
  t.after(() => clearTimeout(value.savedTimer));
  return value;
}

test("pasted <aside> HTML becomes an aside", (t) => {
  const tree = pasted(t, "<p>Start</p><aside><p>Wait we can copy asides</p></aside>");
  assert.deepEqual(
    tree.content.map((node) => node.type === Aside.type),
    [false, true],
  );
});

test("a Page body holding an aside projects to Markdown on every snapshot", (t) => {
  const s = session(
    t,
    pasted(t, "<p>Start</p><aside><p>Note</p><ul><li><p>one</p></li></ul></aside>"),
  );
  const page = s.snapshot();
  assert.equal(page.blocks[0].markdown, "Start\n\n\\[Unsupported node: aside\\]\n\nNote\n\n- one");
});

test("a typed comment on a Page holding an aside writes, and the Page and thread project", (t) => {
  const s = session(t, pasted(t, "<p>Start</p><aside><p>Note</p></aside>"));
  const block = Object.keys(s.doc.blocks)[0];
  // The write itself never projects the Page; the snapshot after it does.
  s.comment({ action: "add", block_id: block, body: "Wait we can copy asides" });
  const page = s.snapshot();
  assert.equal(page.comments[0].messages[0].body, "Wait we can copy asides");
  assert.match(page.blocks[0].markdown, /\\\[Unsupported node: aside\\\]/);
});

test("a comment draft holding a pasted aside sends, and the thread reads", (t) => {
  const s = session(t, pasted(t, "<p>We ship on Friday.</p>"));
  const block = Object.keys(s.doc.blocks)[0];
  const draft = encode(pasted(t, "<aside><p>Wait we can copy asides</p></aside>"));
  s.comment({ action: "add", block_id: block }, draft);
  const [thread] = s.snapshot().comments;
  assert.equal(thread.messages[0].body, "\\[Unsupported node: aside\\]\n\nWait we can copy asides");
});
