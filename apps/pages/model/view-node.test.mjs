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
// The node_id of the block's first paragraph, from read_page's outline. Only
// a block's first entry names its block; the entries after it, until the
// next block's, are its own.
const projectReadNodeId = (doc, id) => {
  const outline = projectReadContent(doc, { include_content: false }).outline;
  const start = outline.findIndex((entry) => entry.block === blockAddress(doc, id));
  const end = outline.findIndex((entry, index) => index > start && entry.block);
  return outline
    .slice(start, end === -1 ? undefined : end)
    .find((entry) => entry.type === "paragraph").node_id;
};
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
  // The view, then a paragraph a text edit turns into the same text.
  const placed = (markdown) => {
    const made = withProse(view("daily"), markdown);
    const intro = projectReadNodeId(made.doc, made.id);
    const doc = edit(made.doc, [
      { op: "replace_match", node_id: intro, match_text: "Intro", replacement: "[View: daily]" },
    ]).doc;
    return { ...made, doc };
  };
  const viewSpan = (d, id) =>
    A.spans(d, textPath(id)).findIndex((span) => String(span.value?.type) === "view");
  for (const [order, types] of [
    [(line) => `${line}\n\nIntro`, ["view", "paragraph"]],
    [(line) => `Intro\n\n${line}`, ["paragraph", "view"]],
  ]) {
    const { doc, id, node } = placed(order);
    assert.deepEqual(blockTypes(doc, id), types);
    const markdown = projectPage(doc).blocks[1].markdown;
    assert.equal(markdown, `${line("daily")}\n\n${line("daily")}`);
    // An unchanged round trip keeps the view on its own line.
    const same = rewrite(doc, node, markdown);
    assert.deepEqual(blockTypes(same, id), types);
    assert.equal(viewSpan(same, id), viewSpan(doc, id));
    // Edits elsewhere keep it too.
    const more = rewrite(doc, node, `${markdown}\n\nAfter`);
    assert.deepEqual(blockTypes(more, id), [...types, "paragraph"]);
    // Removing either identical line leaves the view's line unclear: refused.
    assert.throws(
      () => rewrite(doc, node, line("daily")),
      (error) => error.code === "markdownless_node",
    );
  }
});

test("an identical line added anywhere in the block is refused, never given the view", () => {
  const { doc, node } = withProse(view("daily"), (line) => `${line}\n\nIntro`);
  for (const markdown of [
    `${line("daily")}\n\n${line("daily")}\n\nIntro`,
    `[View: daily]\n\n${line("daily")}\n\nIntro`,
    `${line("daily")}\n\nIntro\n\n> [View: daily]`,
    `${line("daily")}\n\nIntro\n\n- [View: daily]`,
  ])
    assert.throws(
      () => rewrite(doc, node, markdown),
      (error) => error.code === "markdownless_node" && /unclear/.test(error.message),
      markdown,
    );
});

// A block written as raw spans, for views inside quotes and list items.
const marker = (type, attrs = {}, parents = []) => ({
  type: "block",
  value: { type: S(type), parents: parents.map(S), attrs, isEmbed: false },
});
const viewIn = (viewId, parents = []) => marker("view", { view_id: S(viewId) }, parents);
const paragraph = (text, parents = []) => [
  marker("paragraph", {}, parents),
  { type: "text", value: text },
];
const spansBlock = (spans) => {
  const doc = fresh();
  const [id] = orderedBlockIds(doc);
  const next = A.change(A.clone(doc), (draft) =>
    A.updateSpans(draft, textPath(id), spans, { expand: "none" }),
  );
  return { doc: next, id, node: blockAddress(next, id) };
};
// Each view's view_id with its parents, in reading order.
const viewsAt = (doc, id) =>
  A.spans(doc, textPath(id))
    .filter((span) => span.type === "block" && String(span.value.type) === "view")
    .map(
      (span) => `${String(span.value.attrs.view_id)}@${span.value.parents.map(String).join("/")}`,
    );
const Q = ["blockquote"];
const LI = ["unordered-list-item"];
// The refusal for a view whose quote or list item changed position.
const shiftedContainer = (container, viewId) =>
  `The ${container} holding view ${viewId} changed position: a ${container} was added, removed or moved before it, or the view's line went into another ${container}. A Markdown rewrite can't follow a view through that. Make the structural change with insert_node, move_block and delete_node by node_id, or change only text outside the view's ${container} with replace_match or insert_markdown.`;
const refusedWith = (message) => (error) =>
  error.code === "markdownless_node" && error.message === message;

test("a view in one quote stays there; prose in another quote never takes it", () => {
  const { doc, id, node } = spansBlock([
    marker("blockquote"),
    ...paragraph("First quote", Q),
    ...paragraph("Between"),
    marker("blockquote"),
    viewIn("daily", Q),
  ]);
  const markdown = projectPage(doc).blocks[0].markdown;
  assert.equal(markdown, `> First quote\n\nBetween\n\n> ${line("daily")}`);
  const same = rewrite(doc, node, markdown);
  assert.deepEqual(viewsAt(same, id), ["daily@blockquote"]);
  assert.deepEqual(blockTypes(same, id), blockTypes(doc, id));
  // A paragraph added outside the quotes leaves each quote its place.
  const above = rewrite(doc, node, `Above\n\n${markdown}`);
  assert.deepEqual(viewsAt(above, id), ["daily@blockquote"]);
  assert.equal(projectPage(above).blocks[0].markdown, `Above\n\n${markdown}`);
  // The view's text added to the first quote: refused, the view not moved.
  assert.throws(
    () => rewrite(doc, node, `> First quote\n>\n> [View: daily]\n\nBetween\n\n> ${line("daily")}`),
    (error) => error.code === "markdownless_node" && /unclear/.test(error.message),
  );
  // The view's line moved to the first quote, its own quote emptied, a quote
  // added before the view's quote, or the first quote removed: the view's
  // quote changed position. Refused, never moved into another quote.
  for (const changed of [
    `> First quote\n>\n> ${line("daily")}\n\nBetween\n\n> Emptied`,
    `> New quote\n\n${markdown}`,
    `Between\n\n> ${line("daily")}`,
  ])
    assert.throws(
      () => rewrite(doc, node, changed),
      refusedWith(shiftedContainer("quote", "daily")),
      changed,
    );
  // Out of its quote, or into a heading: the container kind changed.
  for (const changed of [
    `> First quote\n\nBetween\n\n${line("daily")}`,
    `> First quote\n\nBetween\n\n> # ${line("daily")}`,
  ])
    assert.throws(
      () => rewrite(doc, node, changed),
      (error) =>
        error.code === "markdownless_node" && /can't go inside a quote/.test(error.message),
      changed,
    );
});

test("two views in two quotes keep their quotes through an unchanged rewrite", () => {
  const { doc, id, node } = spansBlock([
    marker("blockquote"),
    viewIn("daily", Q),
    ...paragraph("Between"),
    marker("blockquote"),
    viewIn("weekly", Q),
  ]);
  const markdown = projectPage(doc).blocks[0].markdown;
  const same = rewrite(doc, node, markdown);
  assert.deepEqual(viewsAt(same, id), ["daily@blockquote", "weekly@blockquote"]);
  assert.equal(projectPage(same).blocks[0].markdown, markdown);
  // Swapping the two lines would move each view to the other quote: refused.
  const swapped = markdown
    .replace("daily", "TMP")
    .replace("weekly", "daily")
    .replace("TMP", "weekly");
  assert.throws(() => rewrite(doc, node, swapped), refusedWith(shiftedContainer("quote", "daily")));
});

test("a view in one list item stays there; prose in another item, at any depth, never takes it", () => {
  const { doc, id, node } = spansBlock([
    marker("unordered-list-item"),
    ...paragraph("First item", LI),
    marker("unordered-list-item", {}, LI),
    ...paragraph("Nested item", [...LI, ...LI]),
    marker("unordered-list-item"),
    viewIn("daily", LI),
  ]);
  const markdown = projectPage(doc).blocks[0].markdown;
  const same = rewrite(doc, node, markdown);
  assert.deepEqual(viewsAt(same, id), ["daily@unordered-list-item"]);
  assert.equal(projectPage(same).blocks[0].markdown, markdown);
  // An item added before the view's item, or the first item removed, shifts
  // the view's item: refused with what to do instead.
  for (const changed of [
    `- New item\n${markdown}`,
    markdown.replace(/^- First item\n  - Nested item\n/, ""),
  ]) {
    assert.notEqual(changed, markdown);
    assert.throws(
      () => rewrite(doc, node, changed),
      refusedWith(shiftedContainer("list item", "daily")),
      changed,
    );
  }
  for (const added of [
    markdown.replace("First item", "First item\n\n  [View: daily]"),
    markdown.replace("Nested item", "Nested item\n\n    [View: daily]"),
  ]) {
    assert.notEqual(added, markdown);
    assert.throws(
      () => rewrite(doc, node, added),
      (error) => error.code === "markdownless_node" && /unclear/.test(error.message),
      added,
    );
  }
});

test("views with different ids reorder among one container's paragraphs by reordering their lines", () => {
  const markers = (doc, id) =>
    A.spans(doc, textPath(id)).filter(
      (span) => span.type === "block" && String(span.value.type) === "view",
    );
  for (const parents of [[], LI]) {
    const { doc, id, node } = spansBlock([
      ...(parents.length ? [marker("unordered-list-item")] : []),
      ...paragraph("Intro", parents),
      viewIn("daily", parents),
      viewIn("weekly", parents),
    ]);
    const markdown = projectPage(doc).blocks[0].markdown;
    const swapped = markdown
      .replace(line("daily"), "TMP")
      .replace(line("weekly"), line("daily"))
      .replace("TMP", line("weekly"));
    assert.notEqual(swapped, markdown);
    const next = rewrite(doc, node, swapped);
    assert.equal(projectPage(next).blocks[0].markdown, swapped);
    // Each view is its own stored marker, view_id intact, in its container.
    const after = markers(next, id);
    assert.deepEqual(
      after.map((span) => String(span.value.attrs.view_id)),
      ["weekly", "daily"],
    );
    for (const span of after) {
      assert.deepEqual(span.value.parents.map(String), parents);
      assert.deepEqual(Object.keys(span.value.attrs), ["view_id"]);
    }
  }
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
