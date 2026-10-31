import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { focusReturnTarget } from "./focus-return.mjs";

function page(blockIds) {
  const { document } = new JSDOM("<!doctype html><body></body>").window;
  const article = document.body.appendChild(document.createElement("article"));
  const title = article.appendChild(document.createElement("input"));
  for (const id of blockIds) {
    const block = article.appendChild(document.createElement("section"));
    block.className = "page-block";
    block.dataset.blockId = id;
    block.appendChild(document.createElement("wg-content")).textContent = id;
  }
  const editor = (id) => article.querySelector(`[data-block-id="${id}"] wg-content`);
  return { article, title, editor };
}

test("focus returns to the draft's block while it exists", () => {
  const { article, title, editor } = page(["a", "draft", "b"]);
  assert.equal(focusReturnTarget(article, { blockIds: ["draft", "b"], title }), editor("draft"));
});

test("a deleted draft block falls back to the editor holding the selection", () => {
  const { article, title, editor } = page(["a", "selected"]);
  assert.equal(
    focusReturnTarget(article, { blockIds: ["deleted", "selected"], title }),
    editor("selected"),
  );
});

test("with neither block left, focus goes to the first surviving editor", () => {
  const { article, title, editor } = page(["first", "second"]);
  assert.equal(
    focusReturnTarget(article, { blockIds: ["deleted", "also-deleted"], title }),
    editor("first"),
  );
  assert.equal(focusReturnTarget(article, { blockIds: [null, undefined], title }), editor("first"));
});

test("a Page with no editors left returns focus to its title", () => {
  const { article, title } = page([]);
  assert.equal(focusReturnTarget(article, { blockIds: ["deleted"], title }), title);
  const markdownOnly = page([]);
  const pre = markdownOnly.article.appendChild(
    markdownOnly.article.ownerDocument.createElement("section"),
  );
  pre.className = "page-block";
  pre.dataset.blockId = "legacy";
  assert.equal(
    focusReturnTarget(markdownOnly.article, { blockIds: ["legacy"], title: markdownOnly.title }),
    markdownOnly.title,
    "a block without a rich editor is skipped",
  );
});

test("nothing connected yields null instead of throwing", () => {
  const { article, title } = page([]);
  title.remove();
  assert.equal(focusReturnTarget(article, { blockIds: ["gone"], title }), null);
  assert.equal(focusReturnTarget(null, {}), null);
});
