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

test("insert_node refuses a malformed view node, naming the attr and its rule", () => {
  const pattern = "attrs.view_id must match ^[a-z][a-z0-9_-]{0,63}$, not constructor or prototype";
  for (const [attrs, message] of [
    [undefined, "a view node's attrs must be {view_id}"],
    [[], "a view node's attrs must be {view_id}"],
    [{}, "a view node needs attrs.view_id: the view_id a set_view on this Page created"],
    [{ view_id: "" }, pattern],
    [{ view_id: "Daily" }, pattern],
    [{ view_id: 7 }, pattern],
    [{ view_id: "constructor" }, pattern],
    [{ view_id: "daily", title: "x" }, `a view node's attrs take view_id only, not "title"`],
    [{ asset_id: "d".repeat(64) }, `a view node's attrs take view_id only, not "asset_id"`],
  ])
    assert.throws(
      () => validateNodeInsertion({ op: "insert_node", node: { type: "view", attrs } }),
      { message },
      JSON.stringify(attrs),
    );
  for (const [op, message] of [
    [{ op: "insert_node" }, /: insert_node requires node: /],
    [
      { op: "insert_node", node: { type: "view", attrs: { view_id: "a" } }, after: "x" },
      /: insert_node does not take after; it takes node and after_node_id$/,
    ],
    [
      { op: "insert_node", node: { type: "view", attrs: { view_id: "a" }, id: 1 } },
      /: insert_node's node takes type and attrs, not "id"$/,
    ],
    [
      { op: "insert_node", node: { type: "chart", attrs: { view_id: "a" } } },
      /: node\.type must be .*view, not "chart"$/,
    ],
    [
      { op: "insert_node", node: { type: "view", attrs: { view_id: "a" } }, after_node_id: 7 },
      /: after_node_id must be a block's id, or null to insert first$/,
    ],
  ])
    assert.throws(() => validateNodeInsertion(op), message, JSON.stringify(op));
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
    [`# ${line("daily")}`, /A view's line can't go inside a quote/],
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

// A block holding a view or a dataframe and paragraphs around it, written
// through replace_block_markdown so the kept node stays the stored one.
const dataframeNode = {
  op: "insert_node",
  node: { type: "dataframe", attrs: { asset_id: "d".repeat(64), title: "Usage" } },
};
const withProse = (insert, markdown) => {
  const { doc } = edit(fresh(), [insert]);
  const [, id] = orderedBlockIds(doc);
  const node = blockAddress(doc, id);
  const keep = projectPage(doc).blocks[1].markdown;
  const next = edit(doc, [
    { op: "replace_block_markdown", node_id: node, markdown: markdown(keep) },
  ]).doc;
  return { doc: next, id, node: blockAddress(next, id), keep };
};
const blockTypes = (doc, id) =>
  A.spans(doc, textPath(id))
    .filter((span) => span.type === "block")
    .map((span) => String(span.value.type));
// The node_id of the block's first paragraph, from read_page's outline.
const projectReadNodeId = (doc, id) =>
  projectReadContent(doc, { include_content: false }).outline.find(
    (entry) => entry.block === blockAddress(doc, id) && entry.type === "paragraph",
  ).node_id;
const rewrite = (doc, node, markdown) =>
  edit(doc, [{ op: "replace_block_markdown", node_id: node, markdown }]).doc;

test("prose that reads like a view line stays prose beside a dataframe", () => {
  const { doc, id, node } = withProse(dataframeNode, (keep) => `${keep}\n\n[View: summary]`);
  assert.deepEqual(blockTypes(doc, id), ["dataframe", "paragraph"]);
  const markdown = projectPage(doc).blocks[1].markdown;
  assert.match(markdown, /\\\[View: summary\\\]$/);
  // An unchanged round trip keeps both, and edits around them apply.
  const same = rewrite(doc, node, markdown);
  assert.equal(projectPage(same).blocks[1].markdown, markdown);
  assert.deepEqual(blockTypes(same, id), ["dataframe", "paragraph"]);
  const edited = rewrite(doc, node, `${markdown}\n\nAfter`);
  assert.deepEqual(blockTypes(edited, id), ["dataframe", "paragraph", "paragraph"]);
  assert.equal(documentFeatures(edited).includes("view"), false);
});

test("prose naming a view the block doesn't store creates nothing", () => {
  const { doc, id, node, keep } = withProse(view("daily"), (line) => `${line}\n\nIntro`);
  for (const markdown of [
    `${keep}\n\n[View: weekly]`,
    `${keep}\n\n\\[View: weekly\\]`,
    `[View: weekly]\n\n${keep}`,
  ]) {
    const next = rewrite(doc, node, markdown);
    assert.deepEqual(
      blockTypes(next, id),
      markdown.startsWith(keep) ? ["view", "paragraph"] : ["paragraph", "view"],
      markdown,
    );
    assert.equal(
      A.spans(next, textPath(id)).filter((span) => String(span.value?.type) === "view").length,
      1,
    );
  }
});

test("prose with a stored view's own text stays prose beside the view's line", () => {
  // The view, then a paragraph whose text reads the same.
  const { doc, id, node } = withProse(view("daily"), (line) => `${line}\n\n[View: daily]`);
  assert.deepEqual(blockTypes(doc, id), ["view", "paragraph"]);
  const markdown = projectPage(doc).blocks[1].markdown;
  assert.equal(markdown, `${line("daily")}\n\n${line("daily")}`);
  const viewSpan = (d) =>
    A.spans(d, textPath(id)).findIndex((span) => String(span.value?.type) === "view");
  const same = rewrite(doc, node, markdown);
  assert.deepEqual(blockTypes(same, id), ["view", "paragraph"]);
  assert.equal(viewSpan(same), viewSpan(doc));
  // Prose first, written by a text edit: the view keeps its place after it.
  // (A rewrite that adds the line ahead of the view gives the view to the
  // first line at its count, and the later one reads as prose.)
  const placed = withProse(view("daily"), (l) => `Intro\n\n${l}`);
  const intro = projectReadNodeId(placed.doc, placed.id);
  const before = {
    ...placed,
    doc: edit(placed.doc, [
      { op: "replace_match", node_id: intro, match_text: "Intro", replacement: "[View: daily]" },
    ]).doc,
  };
  assert.deepEqual(blockTypes(before.doc, before.id), ["paragraph", "view"]);
  const again = rewrite(before.doc, before.node, projectPage(before.doc).blocks[1].markdown);
  assert.deepEqual(blockTypes(again, before.id), ["paragraph", "view"]);
  // Dropping the prose that stood before the view leaves no line at the
  // view's place: refused, as a dropped line is.
  assert.throws(
    () => rewrite(before.doc, before.node, line("daily")),
    (error) =>
      error.code === "markdownless_node" && /holds a view with no line/.test(error.message),
  );
});

test("a stored view whose line is edited or dropped is still refused", () => {
  const { doc, node } = withProse(view("daily"), (line) => `${line}\n\nIntro`);
  for (const markdown of ["Intro", `${line("weekly")}\n\nIntro`, `**[View: daily]**\n\nIntro`])
    assert.throws(
      () => rewrite(doc, node, markdown),
      (error) =>
        error.code === "markdownless_node" && /holds a view with no line/.test(error.message),
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
