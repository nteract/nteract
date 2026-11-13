// The view node in a Page body: insert_node, its stored marker, its Markdown
// line and what keeps it through a rewrite, its typed read, comments, cards
// and previews. The view's own document is model/view-doc.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  applyPageOperation,
  createPageData,
  initializePage,
  orderedBlockIds,
  projectPage,
  validateNodeInsertion,
} from "./page.mjs";
import { textPath, validateRich } from "./richtext.mjs";
import { documentFeatures } from "./schema-features.mjs";
import { decode, encode, PagesView } from "./wordgard-doc.mjs";
import { blockAddress } from "./addresses.mjs";
import { projectReadContent } from "./read-content.mjs";
import { validateCommentSpans } from "./comment-content.mjs";
import { pageCard } from "./page-card.mjs";
import { pagePreview } from "./page-preview.mjs";
import { markdownlessNode } from "./richtext-spans.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
// A view's Markdown line: bracketed text with no link, its brackets escaped
// as an unknown node's notice's are.
const line = (viewId) => `\\[View: ${viewId}\\]`;
const S = (value) => new A.ImmutableString(value);
const fresh = () =>
  A.change(A.from(createPageData({ pageId })), (doc) => initializePage(doc, "Intro"));
const edit = (doc, operations) => {
  let result;
  const next = A.change(A.clone(doc), (draft) => {
    result = applyPageOperation(draft, { operation: "edit_page", arguments: { operations } });
  });
  return { doc: next, result };
};
const view = (view_id = "daily") => ({
  op: "insert_node",
  node: { type: "view", attrs: { view_id } },
});

test("insert_node writes one view marker with its view_id and stamps the feature", () => {
  const { doc, result } = edit(fresh(), [view()]);
  const [, id] = orderedBlockIds(doc);
  assert.equal(result.edits[0].type, "view");
  assert.deepEqual(result.edits[0].attrs, { view_id: "daily" });
  const spans = A.spans(doc, textPath(id));
  assert.equal(spans.length, 1);
  assert.equal(String(spans[0].value.type), "view");
  assert.equal(spans[0].value.isEmbed, false);
  assert.deepEqual(
    Object.fromEntries(Object.entries(spans[0].value.attrs).map(([k, v]) => [k, String(v)])),
    { view_id: "daily" },
  );
  validateRich(doc.blocks[id]);
  assert.ok(documentFeatures(doc).includes("view"));
  // The editor decodes and re-encodes it to the same marker.
  const decoded = decode(spans).doc;
  assert.equal(decoded.firstChild.type, PagesView);
  assert.deepEqual(decoded.firstChild.param, { view_id: "daily" });
  const after = A.change(A.clone(doc), (draft) =>
    A.updateSpans(draft, textPath(id), encode(decoded), { expand: "none" }),
  );
  assert.deepEqual(A.getHeads(after), A.getHeads(doc));
});

test("insert_node refuses a malformed view node", () => {
  for (const attrs of [
    {},
    { view_id: "" },
    { view_id: "Daily" },
    { view_id: "constructor" },
    { view_id: "daily", title: "x" },
    { asset_id: "d".repeat(64) },
  ])
    assert.throws(
      () => validateNodeInsertion({ op: "insert_node", node: { type: "view", attrs } }),
      /insert_node requires node/,
      JSON.stringify(attrs),
    );
});

test("a view reads back as its line, from the node alone", () => {
  const { doc } = edit(fresh(), [view()]);
  assert.equal(projectPage(doc).blocks[1].markdown, line("daily"));
  assert.equal(projectPage(doc).blocks[1].markdown.includes("/view/"), false);
  // Markdown never creates one: the same line inserted is text.
  const linked = edit(fresh(), [{ op: "insert_markdown", markdown: line("daily") }]).doc;
  const [, id] = orderedBlockIds(linked);
  assert.equal(
    A.spans(linked, textPath(id)).some((span) => String(span.value?.type) === "view"),
    false,
  );
  assert.equal(documentFeatures(linked).includes("view"), false);
});

test("replace_block_markdown keeps a view whose line is unchanged, and refuses dropping or faking one", () => {
  const { doc } = edit(fresh(), [view()]);
  const [, id] = orderedBlockIds(doc);
  const node = blockAddress(doc, id);
  const kept = edit(doc, [
    { op: "replace_block_markdown", node_id: node, markdown: `Before\n\n${line("daily")}` },
  ]).doc;
  const spans = A.spans(kept, textPath(id));
  assert.deepEqual(
    spans.filter((span) => span.type === "block").map((span) => String(span.value.type)),
    ["paragraph", "view"],
  );
  assert.equal(projectPage(kept).blocks[1].markdown, `Before\n\n${line("daily")}`);
  // The same text unescaped is the same line.
  const plain = edit(doc, [
    { op: "replace_block_markdown", node_id: node, markdown: "[View: daily]\n\nAfter" },
  ]).doc;
  assert.equal(projectPage(plain).blocks[1].markdown, `${line("daily")}\n\nAfter`);
  for (const [markdown, pattern] of [
    ["Gone", /holds a view with no line/],
    [line("weekly"), /holds a view with no line/],
    [`> ${line("daily")}`, /A view's line can't go inside a quote/],
    [`${line("daily")}\n\n${line("daily")}`, /A view's line appears more times/],
    [`${line("daily")}\n\n${line("weekly")}`, /reads as a view this block doesn't hold/],
    // A link or formatted text isn't the line: refused, never a view
    // dropped for a plain link.
    [`[View: daily](/p/${pageId}/view/daily)`, /holds a view with no line/],
    ["**[View: daily]**", /holds a view with no line/],
  ])
    assert.throws(
      () => edit(doc, [{ op: "replace_block_markdown", node_id: node, markdown }]),
      (error) => error.code === "markdownless_node" && pattern.test(error.message),
      markdown,
    );
});

test("a view's outline entry carries its view_id and its view's title and media type", () => {
  const { doc } = edit(fresh(), [view()]);
  const summaries = {
    viewSummary: (id) =>
      id === "daily"
        ? { title: "Daily usage", media_type: "application/vnd.vegalite.v6+json" }
        : undefined,
  };
  const entry = projectReadContent(doc, { include_content: false }, summaries).outline.find(
    (item) => item.type === "view",
  );
  assert.deepEqual(entry.attrs, { view_id: "daily" });
  assert.deepEqual(entry.summary, {
    title: "Daily usage",
    media_type: "application/vnd.vegalite.v6+json",
  });
  // A view whose document isn't readable still reads its view_id.
  const bare = projectReadContent(doc, { include_content: false }).outline.find(
    (item) => item.type === "view",
  );
  assert.deepEqual(bare.attrs, { view_id: "daily" });
  assert.equal(bare.summary, undefined);
});

test("a peer-written view inside a table cell reads as a notice and refuses a rewrite", () => {
  const doc = fresh();
  const [id] = orderedBlockIds(doc);
  const marker = (type, attrs = {}, parents = []) => ({
    type: "block",
    value: { type: S(type), parents: parents.map(S), attrs, isEmbed: false },
  });
  const next = A.change(A.clone(doc), (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      [
        marker("table", { columns: S("[]") }),
        marker("table-row", {}, ["table"]),
        marker("table-cell", {}, ["table", "table-row"]),
        { type: "text", value: "Af" },
        marker("view", { view_id: S("daily") }, ["table", "table-row", "table-cell"]),
        { type: "text", value: "ter" },
      ],
      { expand: "none" },
    ),
  );
  assert.match(projectPage(next).blocks[0].markdown, /Unsupported node: view/);
  assert.equal(markdownlessNode(next.blocks[id], pageId), "view");
  assert.equal(decode(A.spans(next, textPath(id))).lossy, true);
});

test("comments refuse a view node", () => {
  const spans = [
    {
      type: "block",
      value: { type: S("view"), parents: [], attrs: { view_id: S("daily") }, isEmbed: false },
    },
  ];
  assert.throws(() => validateCommentSpans(spans), /Comments can't hold a view/);
});

test("cards and previews show a view as a figure naming it", async () => {
  const { doc } = edit(fresh(), [view()]);
  const card = await pageCard(doc);
  assert.deepEqual(card.blocks[1].content, [["div", { "data-card-placeholder": "view" }, "daily"]]);
  assert.equal(card.rich, true);
  assert.deepEqual(pagePreview(doc).blocks[1].content, [
    ["figure", { "data-view": "daily" }, "daily"],
  ]);
});
