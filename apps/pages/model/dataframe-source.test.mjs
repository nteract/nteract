import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, applyPageOperation, orderedBlockIds } from "./page.mjs";
import { blockMarkdown, textPath } from "./richtext.mjs";
import { projectReadContent } from "./read-content.mjs";
import { validateRichSpans } from "./richtext-spans.mjs";
import { decode, encode } from "./wordgard-doc.mjs";
import { blockAddress } from "./addresses.mjs";
import { readDataframe, dataframeFor, PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

const pageId = "44444444-4444-4444-8444-444444444444";
const asset_id = "a".repeat(64);
function fixture() {
  return A.change(A.from(createPageData({ pageId, title: "Usage" })), (d) =>
    initializePage(d, "Prose\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"),
  );
}
function edit(doc, operations) {
  return A.change(A.clone(doc), (d) =>
    applyPageOperation(d, { operation: "edit_page", arguments: { operations } }),
  );
}
const entry = (doc) =>
  projectReadContent(doc, { include_content: false }).outline.find((n) => n.type === "dataframe");
const insert = (attrs) => ({ op: "insert_node", node: { type: "dataframe", attrs } });

test("follow and pin survive storage, decode, admission and Markdown read-back without a resolved asset", () => {
  for (const binding of [{ source_id: "usage" }, { source_id: "usage", revision: "1" }]) {
    const doc = edit(fixture(), [insert({ binding, title: "Usage" })]);
    const read = entry(doc);
    assert.deepEqual(read.attrs, { binding, media_type: PARQUET_MEDIA_TYPE, title: "Usage" });
    assert.ok(doc.schema.features.includes("dataframe-source"));
    const key = orderedBlockIds(doc).at(-1);
    const spans = A.spans(doc, textPath(key));
    validateRichSpans(spans);
    const encoded = encode(decode(spans).doc);
    assert.deepEqual(
      readDataframe(
        Object.fromEntries(
          Object.entries(encoded[0].value.attrs).map(([k, v]) => [
            k,
            A.isImmutableString(v) ? String(v) : v,
          ]),
        ),
      ),
      read.attrs,
    );
    assert.equal(spans[0].value.attrs.src, undefined);
    const markdown = blockMarkdown(doc.blocks[key], pageId);
    assert.match(markdown, /source: usage/);
    const rewritten = edit(doc, [
      {
        op: "replace_block_markdown",
        node_id: read.block,
        markdown: `Before\n\n${markdown}\n\nAfter`,
      },
    ]);
    assert.equal(entry(rewritten).node_id, read.node_id);
    assert.deepEqual(entry(rewritten).attrs, read.attrs);
  }
});

test("in-place asset/follow/pin edits preserve marker cursor, surrounding text and comment cursor", () => {
  let doc = edit(fixture(), [insert({ asset_id, title: "Usage" })]);
  const initial = entry(doc);
  const key = orderedBlockIds(doc).at(-1);
  const cursor = A.getCursor(doc, textPath(key), 0);
  const prose = blockMarkdown(doc.blocks[orderedBlockIds(doc)[0]], pageId);
  for (const attrs of [
    { binding: { source_id: "usage" } },
    { binding: { source_id: "usage", revision: "2" } },
    { title: "New title" },
    { asset_id },
  ]) {
    doc = edit(doc, [{ op: "set_node", node_id: initial.node_id, attrs }]);
    assert.equal(entry(doc).node_id, initial.node_id);
    assert.equal(
      A.getCursor(doc, textPath(key), A.getCursorPosition(doc, textPath(key), cursor)),
      cursor,
    );
    assert.equal(blockMarkdown(doc.blocks[orderedBlockIds(doc)[0]], pageId), prose);
    validateRichSpans(A.spans(doc, textPath(key)));
  }
  assert.equal(entry(doc).attrs.asset_id, asset_id);
  assert.equal(entry(doc).attrs.binding, undefined);
});

test("dataframe references reject ambiguous or malformed bindings", () => {
  for (const attrs of [
    { asset_id, binding: { source_id: "usage" } },
    { binding: { source_id: "__proto__" } },
    { binding: { source_id: "usage", revision: 1 } },
    { binding: { source_id: "usage", revision: "0" } },
    { binding: { source_id: "usage", asset_id } },
  ])
    assert.throws(() => dataframeFor(pageId, attrs));
  assert.equal(
    readDataframe({
      src: `/api/pages/${pageId}/assets/${asset_id}`,
      binding: { source_id: "usage" },
      media_type: PARQUET_MEDIA_TYPE,
    }),
    null,
  );
});

test("a concurrent caption edit and source rebind preserve both changes and the node identity", () => {
  const base = edit(fixture(), [
    insert({ binding: { source_id: "usage", revision: "1" }, title: "Usage" }),
  ]);
  const node_id = entry(base).node_id;
  const rebind = edit(base, [
    { op: "set_node", node_id, attrs: { binding: { source_id: "daily" } } },
  ]);
  const caption = edit(base, [{ op: "set_node", node_id, attrs: { title: "Daily usage" } }]);
  const merged = A.merge(A.clone(rebind), caption);
  assert.equal(entry(merged).node_id, node_id);
  assert.deepEqual(entry(merged).attrs.binding, { source_id: "daily" });
  assert.equal(entry(merged).attrs.title, "Daily usage");
});

test("a source table's Markdown refuses a shifted container with node guidance", () => {
  const base = edit(fixture(), [insert({ binding: { source_id: "usage" }, title: "Usage" })]);
  const key = orderedBlockIds(base).at(-1);
  const doc = A.change(A.clone(base), (draft) => {
    const [frame] = A.spans(draft, textPath(key));
    A.updateSpans(draft, textPath(key), [
      {
        type: "block",
        value: { type: new A.ImmutableString("blockquote"), parents: [], attrs: {} },
      },
      { ...frame, value: { ...frame.value, parents: [new A.ImmutableString("blockquote")] } },
    ]);
  });
  const before = A.getCursor(doc, textPath(key), 1);
  const markdown = blockMarkdown(doc.blocks[key], pageId);
  assert.throws(
    () =>
      edit(doc, [
        {
          op: "replace_block_markdown",
          node_id: blockAddress(doc, key),
          markdown: `> New quote\n\nBetween\n\n${markdown}`,
        },
      ]),
    (error) =>
      error.code === "markdownless_node" &&
      /holding dataframe usage changed position/.test(error.message),
  );
  assert.equal(A.getCursor(doc, textPath(key), 1), before);
});
