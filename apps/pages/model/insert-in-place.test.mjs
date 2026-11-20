// In-place inserts: insert_markdown, insert_image and insert_node with a
// top-level node's id as after_node_id write into that node's block,
// directly after it (model/insert-in-place.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { blockMarkdown, textPath } from "./richtext.mjs";
import { blockAddress, nodeAddresses } from "./addresses.mjs";
import { imageIds } from "./image-ids.mjs";
import { projectReadContent } from "./read-content.mjs";
import { projectReadChanges } from "./read-changes.mjs";
import { nativeRead } from "./native-read.mjs";
import { documentFeatures } from "./schema-features.mjs";
import { writeTargets } from "./agent-presence.mjs";
import { projectComments } from "./comments.mjs";
import { comment, newCommentsDoc } from "./comments-test-support.mjs";
import { imageAssetUrl } from "../shared/image-assets.mjs";

const PAGE = "44444444-4444-4444-8444-444444444444";
const KEY = "main";
const ASSET = "e".repeat(64);
const ACTORS = ["0a".repeat(16), "0b".repeat(16), "0c".repeat(16)];
const S = (value) => new A.ImmutableString(value);
const viewLine = (viewId) => `\\[View: ${viewId}\\]`;

/** A Page whose one block holds `markdown`. */
const page = (markdown, actor = ACTORS[2]) =>
  A.change(A.from(createPageData({ pageId: PAGE, title: "Plan" }), { actor }), (draft) =>
    initializePage(draft, markdown, KEY),
  );
/** One edit_page batch on a copy of `doc`: the next document, the result and
 * the presence trace. */
function edit(doc, operations, actor) {
  let result;
  const trace = [];
  let targets;
  const next = A.change(A.clone(doc, actor && { actor }), (draft) => {
    result = applyPageOperation(draft, {
      operation: "edit_page",
      arguments: { operations },
      trace,
    });
    targets = writeTargets(draft, trace);
  });
  return { doc: next, result, trace, targets };
}
const markdown = (doc, key = KEY) => blockMarkdown(doc.blocks[key], PAGE);
const ids = (doc, key = KEY) => nodeAddresses(doc, key);
const read = (doc, args) => projectReadContent(doc, args);
const refused = (doc, operations, code, pattern) =>
  assert.throws(
    () => edit(doc, operations),
    (error) => error.code === code && (!pattern || pattern.test(error.message)),
    JSON.stringify(operations),
  );

test("insert_markdown after a node writes into its block, between its neighbours", () => {
  const doc = page("Alpha\n\nBeta\n\nGamma");
  const [alpha, beta, gamma] = ids(doc);
  const { doc: after, result } = edit(doc, [
    { op: "insert_markdown", markdown: "New **bold** text\n\n- one\n- two", after_node_id: beta },
  ]);
  assert.deepEqual(orderedBlockIds(after), [KEY]);
  assert.equal(markdown(after), "Alpha\n\nBeta\n\nNew **bold** text\n\n- one\n- two\n\nGamma");
  const now = ids(after);
  assert.equal(now.length, 5);
  assert.deepEqual([now[0], now[1], now[4]], [alpha, beta, gamma]);
  // The receipt names the block as `block` and the new nodes; no node_id, so
  // nothing reads as a new block.
  assert.deepEqual(result.edits, [
    { op: "insert_markdown", block: blockAddress(after, KEY), nodes: [now[2], now[3]] },
  ]);
  // The new ids address the new nodes in a read.
  const selected = read(after, { node_ids: result.edits[0].nodes });
  assert.deepEqual(
    selected.nodes.map((node) => node.markdown),
    ["New **bold** text", "- one\n- two"],
  );
  // The ids an outline reports are the receipt's.
  assert.deepEqual(
    read(after, {})
      .outline.map((entry) => entry.node_id)
      .slice(2, 4),
    result.edits[0].nodes,
  );
});

test("insert_image after a node writes a paragraph holding the image into the block", () => {
  const doc = page("Alpha\n\nGamma");
  const [alpha, gamma] = ids(doc);
  const { doc: after, result } = edit(doc, [
    { op: "insert_image", asset_id: ASSET, alt: "A chart", title: "Usage", after_node_id: alpha },
  ]);
  assert.deepEqual(orderedBlockIds(after), [KEY]);
  const now = ids(after);
  assert.deepEqual([now[0], now[2]], [alpha, gamma]);
  const [{ id: image }] = imageIds(after, KEY);
  assert.deepEqual(result.edits, [
    {
      op: "insert_image",
      block: blockAddress(after, KEY),
      nodes: [now[1]],
      image,
      asset_id: ASSET,
      asset_url: imageAssetUrl(PAGE, ASSET),
      title: "Usage",
      alt: "A chart",
    },
  ]);
  assert.equal(
    markdown(after),
    `Alpha\n\n![A chart](${imageAssetUrl(PAGE, ASSET)} "Usage")\n\nGamma`,
  );
  assert.match(read(after, { node_ids: [now[1]] }).nodes[0].markdown, /^!\[A chart\]/);
});

test("insert_node after a node writes a view or a dataframe into the block", () => {
  const doc = page("Alpha\n\nGamma");
  const [alpha, gamma] = ids(doc);
  const { doc: after, result } = edit(doc, [
    {
      op: "insert_node",
      node: { type: "view", attrs: { view_id: "daily" } },
      after_node_id: alpha,
    },
  ]);
  assert.deepEqual(orderedBlockIds(after), [KEY]);
  const now = ids(after);
  assert.deepEqual([now[0], now[2]], [alpha, gamma]);
  assert.deepEqual(result.edits, [
    {
      op: "insert_node",
      block: blockAddress(after, KEY),
      nodes: [now[1]],
      type: "view",
      attrs: { view_id: "daily" },
    },
  ]);
  assert.equal(markdown(after), `Alpha\n\n${viewLine("daily")}\n\nGamma`);
  assert.ok(documentFeatures(after).includes("view"));
  // A dataframe after the view, by the view's id from the receipt.
  const framed = edit(after, [
    {
      op: "insert_node",
      node: { type: "dataframe", attrs: { asset_id: ASSET, title: "Usage" } },
      after_node_id: now[1],
    },
  ]);
  const framedIds = ids(framed.doc);
  assert.deepEqual(framed.result.edits[0].nodes, [framedIds[2]]);
  assert.equal(framed.result.edits[0].type, "dataframe");
  assert.equal(framedIds.length, 4);
  assert.deepEqual([framedIds[0], framedIds[1], framedIds[3]], now);
  assert.equal(read(framed.doc, { node_ids: [framedIds[2]] }).outline[0].type, "dataframe");
});

test("a list or quote is addressed as a whole: the insert goes after its last item", () => {
  const doc = page("- a\n- b\n\n> q\n>\n> r\n\nEnd");
  const [list, quote, end] = ids(doc);
  const afterList = edit(doc, [{ op: "insert_markdown", markdown: "Mid", after_node_id: list }]);
  assert.equal(markdown(afterList.doc), "- a\n- b\n\nMid\n\n> q\n>\n> r\n\nEnd");
  const afterQuote = edit(doc, [{ op: "insert_markdown", markdown: "Mid", after_node_id: quote }]);
  assert.equal(markdown(afterQuote.doc), "- a\n- b\n\n> q\n>\n> r\n\nMid\n\nEnd");
  assert.deepEqual(
    ids(afterQuote.doc).filter((_, i) => i !== 2),
    [list, quote, end],
  );
});

test("a block's id, null and an omitted after_node_id still make a new block", () => {
  const doc = page("Alpha\n\nBeta");
  const block = blockAddress(doc, KEY);
  for (const after_node_id of [block, null, undefined]) {
    const { doc: next, result } = edit(doc, [
      {
        op: "insert_markdown",
        markdown: "New",
        ...(after_node_id !== undefined && { after_node_id }),
      },
    ]);
    assert.equal(orderedBlockIds(next).length, 2);
    assert.equal(markdown(next), "Alpha\n\nBeta");
    assert.ok(result.edits[0].node_id);
    assert.equal(result.edits[0].block, undefined);
  }
});

test("marks at the anchor's end don't spread into the new node, and the new runs keep theirs", () => {
  for (const [source, name] of [
    ["*end*", "em"],
    ["**end**", "strong"],
    ["~~end~~", "strike"],
    ['<mark data-color="green">end</mark>', "highlight"],
  ]) {
    const doc = page(`Start ${source}\n\nNext`);
    const [anchor, next] = ids(doc);
    const { doc: after } = edit(doc, [
      { op: "insert_markdown", markdown: "Plain *and em*", after_node_id: anchor },
    ]);
    assert.equal(markdown(after), `Start ${source}\n\nPlain *and em*\n\nNext`, name);
    // No mark of the anchor's covers any inserted character.
    const text = after.blocks[KEY].richText;
    const from = text.indexOf("Plain");
    const to = from + "Plain ".length;
    const spread = A.marks(after, textPath(KEY)).filter(
      (mark) => mark.name === name && mark.start < to && mark.end > from,
    );
    assert.deepEqual(spread, [], name);
    // A person typing at the anchor's end continues its mark; typing at the
    // start of the new paragraph doesn't take it.
    const typed = A.change(A.clone(after), (draft) => {
      A.splice(draft, textPath(KEY), text.indexOf("end") + 3, 0, "X");
      A.splice(draft, textPath(KEY), from + 1, 0, "Y");
    });
    assert.equal(
      markdown(typed),
      `Start ${source.replace("end", "endX")}\n\nYPlain *and em*\n\nNext`,
      name,
    );
    assert.deepEqual(
      ids(after).filter((_, i) => i !== 1),
      [anchor, next],
    );
  }
  // Stamps follow the new spans' needs.
  const doc = page("Start");
  assert.ok(!documentFeatures(doc).includes("strike"));
  const struck = edit(doc, [
    { op: "insert_markdown", markdown: "~~gone~~", after_node_id: ids(doc)[0] },
  ]).doc;
  assert.ok(documentFeatures(struck).includes("strike"));
});

test("text spliced at the end of a new node stays out of the anchor's mark", () => {
  for (const [source, name] of [
    ["*end*", "em"],
    ["**end**", "strong"],
    ["~~end~~", "strike"],
    ['<mark data-color="green">end</mark>', "highlight"],
  ]) {
    const doc = page(`Start ${source}\n\nNext`);
    const { doc: after } = edit(doc, [
      { op: "insert_markdown", markdown: "Plain", after_node_id: ids(doc)[0] },
    ]);
    // A writer that splices without setting marks, at the new node's end.
    const text = after.blocks[KEY].richText;
    const typed = A.change(A.clone(after), (draft) => {
      A.splice(draft, textPath(KEY), text.indexOf("Plain") + "Plain".length, 0, "Q");
    });
    assert.equal(markdown(typed), `Start ${source}\n\nPlainQ\n\nNext`, name);
  }
  // A mark that crosses into the node after the anchor keeps covering it.
  const doc = page("Start **end**\n\n**Next** tail");
  const { doc: after } = edit(doc, [
    { op: "insert_markdown", markdown: "Plain", after_node_id: ids(doc)[0] },
  ]);
  assert.equal(markdown(after), "Start **end**\n\nPlain\n\n**Next** tail");
});

test("a batch's in-place inserts are bounded by the block text they read", () => {
  const big = page(`${"word ".repeat(60_000)}\n\nEnd`);
  const [anchor] = ids(big);
  const op = { op: "insert_markdown", markdown: "New", after_node_id: anchor };
  // Three inserts read under the bound; a fourth passes it and nothing is written.
  assert.throws(
    () => edit(big, [op, op, op, op]),
    /inserts inside blocks too many times for their size/,
  );
  const small = page("One\n\nTwo");
  const many = Array.from({ length: 100 }, () => ({
    op: "insert_markdown",
    markdown: "New",
    after_node_id: ids(small)[0],
  }));
  assert.equal(edit(small, many).result.edits.length, 100);
});

test("a new list next to a list of the same kind is refused and the batch rolls back", () => {
  for (const [source, insert, at, pattern] of [
    ["- a\n- b\n\nEnd", "- c", 0, /would join the new bullet-list and the bullet-list it follows/],
    ["1. a\n\nEnd", "1. c", 0, /would join the new ordered-list and the ordered-list it follows/],
    ["- [ ] a\n\nEnd", "- [x] c", 0, /would join the new task-list and the task-list it follows/],
    ["Start\n\n- a", "- z", 0, /would join the new bullet-list and the bullet-list after it/],
    [
      "Start\n\n1. a",
      "Text\n\n1. z",
      0,
      /would join the new ordered-list and the ordered-list after it/,
    ],
  ]) {
    const doc = page(source);
    const anchor = ids(doc)[at];
    refused(
      doc,
      [
        { op: "set_title", title: "Changed" },
        { op: "insert_markdown", markdown: insert, after_node_id: anchor },
      ],
      "nodes_would_join",
      pattern,
    );
  }
  // The refusal leaves the document as it was: the throw aborts the change.
  const doc = page("- a\n\nEnd");
  const heads = A.getHeads(doc);
  const copy = A.clone(doc);
  assert.throws(() =>
    A.change(copy, (draft) =>
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: {
          operations: [
            { op: "set_title", title: "Changed" },
            { op: "insert_markdown", markdown: "- b", after_node_id: ids(doc)[0] },
          ],
        },
      }),
    ),
  );
  assert.deepEqual(A.getHeads(copy), heads);
  assert.equal(copy.title, "Plan");
});

test("neighbours that stay apart are allowed: lists of other kinds, quotes, code blocks", () => {
  for (const [source, insert, expected] of [
    ["- a\n\nEnd", "1. b", "- a\n\n1. b\n\nEnd"],
    ["1. a\n\nEnd", "- b", "1. a\n\n- b\n\nEnd"],
    ["- a\n\nEnd", "- [ ] b", "- a\n\n- [ ] b\n\nEnd"],
    ["- [ ] a\n\nEnd", "- b", "- [ ] a\n\n- b\n\nEnd"],
    ["> a\n\nEnd", "> b", "> a\n\n> b\n\nEnd"],
    ["```\na\n```\n\nEnd", "```\nb\n```", "```\na\n```\n\n```\nb\n```\n\nEnd"],
    ["## A\n\nEnd", "## B", "## A\n\n## B\n\nEnd"],
    ["---\n\nEnd", "---", "---\n\n---\n\nEnd"],
    ["| a |\n| --- |\n| b |\n\nEnd", "| c |\n| --- |\n| d |", null],
  ]) {
    const doc = page(source);
    const before = ids(doc);
    const { doc: after, result } = edit(doc, [
      { op: "insert_markdown", markdown: insert, after_node_id: before[0] },
    ]);
    if (expected) assert.equal(markdown(after), expected);
    const now = ids(after);
    assert.equal(now.length, 3, source);
    assert.deepEqual([now[0], now[2]], before, source);
    assert.deepEqual(result.edits[0].nodes, [now[1]]);
  }
  // A list between paragraphs of a block that holds a list elsewhere.
  const doc = page("- a\n\nMid\n\nEnd");
  const [, mid] = ids(doc);
  const { doc: after } = edit(doc, [
    { op: "insert_markdown", markdown: "- b", after_node_id: mid },
  ]);
  assert.equal(markdown(after), "- a\n\nMid\n\n- b\n\nEnd");
});

test("unmarked text after a leaf gets its marker before the insert, so it stays its own node", () => {
  let doc = page("Intro");
  const [intro] = ids(doc);
  doc = edit(doc, [
    {
      op: "insert_node",
      node: { type: "view", attrs: { view_id: "daily" } },
      after_node_id: intro,
    },
  ]).doc;
  const [, view] = ids(doc);
  // Text with no marker after the view, as a merge can leave.
  doc = A.change(doc, (draft) =>
    A.splice(draft, textPath(KEY), draft.blocks[KEY].richText.length, 0, "tail"),
  );
  assert.deepEqual(ids(doc).slice(0, 2), [intro, view]);
  assert.equal(ids(doc)[2], null);
  const { doc: after, result } = edit(doc, [
    { op: "insert_markdown", markdown: "New", after_node_id: view },
  ]);
  assert.equal(markdown(after), `Intro\n\n${viewLine("daily")}\n\nNew\n\ntail`);
  const now = ids(after);
  assert.equal(now.length, 4);
  assert.deepEqual(now.slice(0, 2), [intro, view]);
  assert.deepEqual(result.edits[0].nodes, [now[2]]);
  assert.ok(now[3]);
});

test("a block holding content from a newer build refuses in-place inserts", () => {
  let doc = page("Intro\n\nOutro");
  const [intro] = ids(doc);
  doc = A.change(doc, (draft) => {
    const end = draft.blocks[KEY].richText.length;
    A.splitBlock(draft, textPath(KEY), end, {
      type: S("future-chart"),
      parents: [],
      attrs: {},
      isEmbed: false,
    });
    A.splice(draft, textPath(KEY), end + 1, 0, "series");
  });
  refused(
    doc,
    [{ op: "insert_markdown", markdown: "New", after_node_id: intro }],
    "newer_content",
    /newer version of Pages/,
  );
  // The block's own id still inserts a block after it.
  const { doc: after } = edit(doc, [
    { op: "insert_markdown", markdown: "New", after_node_id: blockAddress(doc, KEY) },
  ]);
  assert.equal(orderedBlockIds(after).length, 2);
});

test("an inline image's id is refused as an anchor; its paragraph's id is taken", () => {
  const doc = page(`Text ![chart](${imageAssetUrl(PAGE, ASSET)}) more\n\nEnd`);
  const [{ id: image }] = imageIds(doc, KEY);
  for (const operation of [
    { op: "insert_markdown", markdown: "x", after_node_id: image },
    { op: "insert_image", asset_id: ASSET, alt: "", after_node_id: image },
    { op: "insert_node", node: { type: "view", attrs: { view_id: "a" } }, after_node_id: image },
  ])
    refused(
      doc,
      [operation],
      "wrong_address_kind",
      /names an image; set_image changes it; to insert after it, name the node that holds it/,
    );
  const { doc: after } = edit(doc, [
    { op: "insert_markdown", markdown: "x", after_node_id: ids(doc)[0] },
  ]);
  assert.match(markdown(after), /more\n\nx\n\nEnd$/);
});

test("inserts chain across requests by the ids each receipt returns", () => {
  let doc = page("Start\n\nEnd");
  let anchor = ids(doc)[0];
  for (const text of ["One", "Two", "Three"]) {
    const { doc: next, result } = edit(doc, [
      { op: "insert_markdown", markdown: text, after_node_id: anchor },
    ]);
    doc = next;
    anchor = result.edits[0].nodes.at(-1);
  }
  assert.equal(markdown(doc), "Start\n\nOne\n\nTwo\n\nThree\n\nEnd");
  // In one batch each operation lands directly after the node it names, so
  // three after the same node read in reverse order; a later operation can
  // name a node an earlier one in the batch kept.
  const start = page("Start\n\nEnd");
  const [first, last] = ids(start);
  const { doc: batched, result } = edit(start, [
    { op: "insert_markdown", markdown: "Three", after_node_id: first },
    { op: "insert_node", node: { type: "view", attrs: { view_id: "two" } }, after_node_id: first },
    { op: "insert_markdown", markdown: "One", after_node_id: first },
    { op: "insert_markdown", markdown: "Last", after_node_id: last },
  ]);
  assert.equal(markdown(batched), `Start\n\nOne\n\n${viewLine("two")}\n\nThree\n\nEnd\n\nLast`);
  const now = ids(batched);
  assert.deepEqual(
    result.edits.map((entry) => entry.nodes[0]),
    [now[3], now[2], now[1], now[5]],
  );
});

test("selection comments on the anchor and the node after it stay attached", () => {
  const doc = page("The anchor sentence.\n\nThe following sentence.");
  let comments = newCommentsDoc();
  for (const selected_text of ["anchor sentence", "following sentence"])
    ({ comments } = comment(doc, comments, {
      action: "add",
      block_id: KEY,
      selected_text,
      body: "Note",
    }));
  const { doc: after } = edit(doc, [
    { op: "insert_markdown", markdown: "Between them.", after_node_id: ids(doc)[0] },
    {
      op: "insert_image",
      asset_id: ASSET,
      alt: "chart",
      after_node_id: ids(doc)[0],
    },
  ]);
  const contexts = projectComments(after, comments).map((thread) => thread.selectionContext);
  assert.deepEqual(
    contexts.map(({ status, text }) => ({ status, text })),
    [
      { status: "attached", text: "anchor sentence" },
      { status: "attached", text: "following sentence" },
    ],
  );
});

test("presence names the inserted range, and read_page_changes reports the new nodes", () => {
  const doc = page("Alpha\n\nGamma");
  const [alpha, gamma] = ids(doc);
  const {
    doc: after,
    trace,
    targets,
    result,
  } = edit(doc, [{ op: "insert_markdown", markdown: "Beta", after_node_id: alpha }]);
  const text = after.blocks[KEY].richText;
  assert.deepEqual(trace, [
    { type: "text", block_id: KEY, start: text.indexOf("Beta") - 1, end: text.indexOf("Beta") + 4 },
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kind, "text");
  assert.equal(
    A.getCursorPosition(after, textPath(KEY), targets[0].start),
    text.indexOf("Beta") - 1,
  );
  assert.equal(A.getCursorPosition(after, textPath(KEY), targets[0].end), text.indexOf("Beta") + 4);
  const changes = projectReadChanges(after, { page_id: PAGE, since_heads: A.getHeads(doc) });
  const [beta] = result.edits[0].nodes;
  assert.deepEqual(
    changes.changes.map(({ node_id, block, scope, change, before_node_id, markdown: md }) => ({
      node_id,
      block,
      scope,
      change,
      before_node_id,
      markdown: md,
    })),
    [
      {
        node_id: beta,
        block: blockAddress(after, KEY),
        scope: "node",
        change: "inserted",
        before_node_id: gamma,
        markdown: "Beta",
      },
    ],
  );
});

/** Every reader takes `doc` without throwing; returns the block's Markdown. */
function readable(doc) {
  for (const key of orderedBlockIds(doc)) {
    nativeRead(doc.blocks[key], PAGE);
    nodeAddresses(doc, key);
  }
  read(doc, {});
  return markdown(doc);
}
/** `left` and `right` forked from `base` with their own actors, merged in
 * both directions: the two results, which must agree. */
function mergeBoth(base, leftChange, rightChange, [leftActor, rightActor]) {
  const left = leftChange(A.clone(base, { actor: leftActor }), leftActor);
  const right = rightChange(A.clone(base, { actor: rightActor }), rightActor);
  const one = A.merge(A.clone(left), right);
  const two = A.merge(A.clone(right), left);
  assert.equal(readable(one), readable(two));
  return one;
}
const agentInsert = (markdownText) => (doc, actor) =>
  edit(doc, [{ op: "insert_markdown", markdown: markdownText, after_node_id: ids(doc)[0] }], actor)
    .doc;

test("a person typing at the anchor's end while the agent inserts: both survive, in both actor orders", () => {
  const orders = [];
  for (const actors of [ACTORS.slice(0, 2), [ACTORS[1], ACTORS[0]]]) {
    const base = page("First\n\nSecond");
    const anchorEnd = base.blocks[KEY].richText.indexOf("First") + 5;
    const merged = mergeBoth(
      base,
      agentInsert("AGENT"),
      (doc) => A.change(doc, (draft) => A.splice(draft, textPath(KEY), anchorEnd, 0, " typed")),
      actors,
    );
    const text = readable(merged);
    assert.match(text, /typed/);
    assert.match(text, /AGENT/);
    assert.match(text, /^First/);
    assert.match(text, /Second$/);
    assert.equal(ids(merged).length, 3);
    orders.push(text);
  }
  // Concurrent inserts at one place are ordered by their op ids: the typed
  // text stays in the anchor, or follows the agent's text in its new node.
  for (const text of orders)
    assert.ok(
      ["First typed\n\nAGENT\n\nSecond", "First\n\nAGENT typed\n\nSecond"].includes(text),
      text,
    );
});

test("the anchor deleted while the agent inserts after it: the new node survives", () => {
  for (const actors of [ACTORS.slice(0, 2), [ACTORS[1], ACTORS[0]]]) {
    const base = page("First\n\nSecond");
    const [, second] = ids(base);
    const merged = mergeBoth(
      base,
      agentInsert("AGENT"),
      (doc) => edit(doc, [{ op: "delete_node", node_id: ids(doc)[0] }], undefined).doc,
      actors,
    );
    assert.equal(readable(merged), "AGENT\n\nSecond");
    assert.equal(ids(merged)[1], second);
  }
});

test("two writers inserting after the same anchor: both nodes survive, in one order", () => {
  for (const actors of [ACTORS.slice(0, 2), [ACTORS[1], ACTORS[0]]]) {
    const base = page("First\n\nSecond");
    const [first, second] = ids(base);
    const merged = mergeBoth(base, agentInsert("ONE\n\n- list"), agentInsert("TWO"), actors);
    const text = readable(merged);
    assert.ok(
      [
        "First\n\nONE\n\n- list\n\nTWO\n\nSecond",
        "First\n\nTWO\n\nONE\n\n- list\n\nSecond",
      ].includes(text),
      text,
    );
    const now = ids(merged);
    assert.equal(now.length, 5);
    assert.deepEqual([now[0], now[4]], [first, second]);
  }
});
