// ONE-SHOT MIGRATION tests: delete with content-normalization.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { adapterSpans, pageSpans } from "./richtext-spans.mjs";
import { parseMarkdown } from "./markdown-import.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { textPath, RICH_FORMAT } from "./richtext-format.mjs";
import { decode, encode } from "./wordgard-doc.mjs";
import { nodeIds } from "./node-ids.mjs";
import { selectionContext } from "./comments.mjs";
import { comment, newCommentsDoc } from "./comments-test-support.mjs";
import { documentFeatures } from "./schema-features.mjs";
import {
  applyPageNormalization,
  measureRewrite,
  normalizationProblems,
  planPageNormalization,
} from "./content-normalization.mjs";

const PAGE_ID = "44444444-4444-4444-8444-444444444444";

/** A stamped Page whose first block holds `markdown` in the adapter's form,
 * as builds before pageSpans wrote it. */
function adapterPage(markdown) {
  let doc = A.change(A.from(createPageData({ pageId: PAGE_ID, title: "Old" })), (draft) =>
    initializePage(draft, ""),
  );
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) =>
    A.updateSpans(draft, textPath(id), adapterSpans(parseMarkdown(markdown)), updateSpansConfig),
  );
  return { doc, id };
}

// Spans as plain JSON. Stored text spans omit empty marks; written ones carry them.
const plain = (spans) =>
  JSON.parse(
    JSON.stringify(spans, (_key, value) => (A.isImmutableString(value) ? String(value) : value)),
  ).map(({ marks, ...span }) =>
    span.type === "text" && marks && Object.keys(marks).length ? { ...span, marks } : span,
  );
const canonical = (doc, id) => {
  const spans = A.spans(doc, textPath(id));
  return plain(encode(decode(spans).doc));
};
const normalize = (doc, writes) =>
  A.change(doc, (draft) => {
    applyPageNormalization(draft, writes);
  });

test("adapter-form inputs come out in the editor's form", () => {
  for (const markdown of [
    "Hello world\n\nSecond paragraph",
    "> - quoted item\n> - another",
    "line one  \nline two",
    "Opening\n\n```js\nlet x = 1\n```",
    "Plain only paragraph",
  ]) {
    const { doc, id } = adapterPage(markdown);
    const { report, writes } = planPageNormalization(doc);
    const after = normalize(doc, writes);
    assert.deepEqual(
      plain(A.spans(after, textPath(id))),
      plain(pageSpans(parseMarkdown(markdown))),
    );
    assert.deepEqual(plain(A.spans(after, textPath(id))), canonical(after, id), markdown);
    assert.equal(report.refused, 0);
  }
});

test("the report names each old form it removes", () => {
  const first = planPageNormalization(adapterPage("Hello\n\nWorld").doc).report;
  assert.deepEqual(first.blocks[0].forms, ["first_marker"]);
  assert.deepEqual(first.blocks[0].markers.removed, { paragraph: 1 });
  assert.deepEqual(first.blocks[0].markers.added, {});
  const quote = planPageNormalization(adapterPage("> - a\n> - b").doc).report;
  assert.deepEqual(quote.blocks[0].forms, ["quote_marker"]);
  assert.deepEqual(quote.blocks[0].markers.added, { blockquote: 1 });
  assert.equal(quote.blocks[0].markers.kept, 2);
  assert.deepEqual(quote.forms, { quote_marker: 1 });
  // A stored `\n` in prose becomes a hard break; only that character goes.
  let { doc, id } = adapterPage("x");
  doc = A.change(doc, (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      [
        { type: "block", value: { type: "paragraph", parents: [], attrs: {}, isEmbed: false } },
        { type: "text", value: "a\nb", marks: {} },
      ],
      updateSpansConfig,
    ),
  );
  const newline = planPageNormalization(doc).report.blocks[0];
  assert.deepEqual(newline.forms, ["first_marker", "prose_newline"]);
  assert.deepEqual(newline.markers.added, { "hard-break": 1 });
  assert.equal(newline.text.unexpected, 0);
});

test("text identity, node ids and comment anchors survive", () => {
  const { doc, id } = adapterPage("> - keep this passage\n> - second item\n\nClosing words here");
  let comments = newCommentsDoc();
  let added;
  ({ comments, result: added } = comment(doc, comments, {
    block_id: id,
    selected_text: "this passage",
    body: "Anchored",
  }));
  const before = nodeIds(doc, id).map((node) => node.id);
  const { report, writes } = planPageNormalization(doc, { commentsDoc: comments });
  assert.deepEqual(report.blocks[0].anchors, { attached: 1, detached: 0 });
  assert.equal(report.blocks[0].text.lost, 0);
  const after = normalize(doc, writes);
  const thread = comments.threads[added.thread_id];
  const context = selectionContext(after, thread.target);
  assert.equal(context.status, "attached");
  assert.equal(context.text, "this passage");
  // The quote gains its own marker (a new id); the items' markers and the
  // closing paragraph's keep theirs.
  const ids = nodeIds(after, id).map((node) => node.id);
  for (const kept of before.slice(1)) assert.ok(ids.includes(kept), kept);
});

test("a lossy block is refused and reported, and the rest of the Page still normalizes", () => {
  let { doc, id } = adapterPage("Hello\n\nWorld");
  const lossy = "b".repeat(8);
  doc = A.change(doc, (draft) => {
    draft.blocks[lossy] = {
      id: lossy,
      position: "a9",
      kind: "markdown",
      format: RICH_FORMAT,
      markdown: "",
      richText: "",
      metadata: {},
    };
    A.updateSpans(
      draft,
      textPath(lossy),
      [
        {
          type: "block",
          value: { type: "paragraph", parents: ["mystery-container"], attrs: {}, isEmbed: false },
        },
        { type: "text", value: "inside", marks: {} },
      ],
      updateSpansConfig,
    );
  });
  const lossyBefore = plain(A.spans(doc, textPath(lossy)));
  const { report, writes } = planPageNormalization(doc);
  assert.equal(report.refused, 1);
  assert.deepEqual(
    report.blocks.find((block) => block.block_id === lossy),
    { block_id: lossy, action: "refused", reason: "lossy" },
  );
  assert.ok(writes.every((write) => write.block_id !== lossy));
  const after = normalize(doc, writes);
  assert.deepEqual(plain(A.spans(after, textPath(lossy))), lossyBefore);
  assert.deepEqual(plain(A.spans(after, textPath(id))), canonical(after, id));
  assert.deepEqual(normalizationProblems(planPageNormalization(after).report), [
    `${lossy}: refused (lossy)`,
  ]);
});

test("a Markdown-era block becomes rich text in the editor's form", () => {
  let { doc } = adapterPage("Rich\n\nalready");
  const old = "m".repeat(8);
  doc = A.change(doc, (draft) => {
    draft.blocks[old] = {
      id: old,
      position: "a9",
      kind: "markdown",
      markdown: "Old **bold** text\n\n~~gone~~",
      metadata: {},
    };
  });
  const { report, writes } = planPageNormalization(doc);
  assert.deepEqual(report.forms, { first_marker: 1, markdown_block: 1 });
  const after = normalize(doc, writes);
  assert.equal(after.blocks[old].format, RICH_FORMAT);
  assert.deepEqual(plain(A.spans(after, textPath(old))), canonical(after, old));
  // The stamp names what the new spans need.
  assert.ok(documentFeatures(after).includes("strike"));
});

test("a second run writes nothing", () => {
  const { doc } = adapterPage("Hello\n\n> - a\n\nTail");
  const { writes } = planPageNormalization(doc);
  assert.ok(writes.length > 0);
  const after = normalize(doc, writes);
  const again = planPageNormalization(after);
  assert.equal(again.writes.length, 0);
  assert.deepEqual(normalizationProblems(again.report), []);
  const replayed = normalize(after, again.writes);
  assert.deepEqual(A.getHeads(replayed), A.getHeads(after));
});

// Automerge resolves a mark across adjacent runs as one mark, while the spans
// list it per run, so updateSpans with unchanged spans removes and re-adds it:
// new heads, same spans. That rewrite isn't a change of form.
test("a rewrite that leaves the spans unchanged isn't planned", () => {
  for (const markdown of [
    "**bold [linked](https://example.org) bold**",
    "*a* plain *b*\n\n~~struck [link](https://example.org/x)~~",
  ]) {
    const { doc, id } = adapterPage(markdown);
    const after = normalize(doc, planPageNormalization(doc).writes);
    const again = planPageNormalization(after);
    assert.deepEqual(again.writes, [], markdown);
    assert.deepEqual(again.report.blocks, [], markdown);
    assert.deepEqual(normalizationProblems(again.report), [], markdown);
    assert.deepEqual(plain(A.spans(after, textPath(id))), canonical(after, id), markdown);
  }
});

test("a Page already in the editor's form plans nothing", () => {
  const doc = A.change(A.from(createPageData({ pageId: PAGE_ID })), (draft) =>
    initializePage(draft, "# Title\n\nBody with **bold**\n\n> quoted\n\n- [x] task"),
  );
  const { report, writes } = planPageNormalization(doc);
  assert.deepEqual(writes, []);
  assert.deepEqual(report.blocks, []);
});

test("an incomplete stamp is repaired in the same change", () => {
  const doc = A.change(A.from(createPageData({ pageId: PAGE_ID })), (draft) =>
    initializePage(draft, "~~struck~~"),
  );
  const unstamped = A.change(doc, (draft) => {
    draft.schema.features.splice(draft.schema.features.indexOf("strike"), 1);
  });
  // Concurrent first stamps: the visible value (the higher actor's) lacks
  // `strike`; only the conflicting one holds it.
  const concurrent = A.merge(
    A.change(A.clone(unstamped, { actor: "aa".repeat(16) }), (draft) => {
      draft.schema = { features: ["comments-doc", "strike"] };
    }),
    A.change(A.clone(unstamped, { actor: "bb".repeat(16) }), (draft) => {
      draft.schema = { features: ["comments-doc"] };
    }),
  );
  assert.deepEqual([...concurrent.schema.features], ["comments-doc"]);
  const { report, writes } = planPageNormalization(concurrent);
  assert.equal(report.stamp_repair, true);
  assert.deepEqual(writes, [{ kind: "stamps" }]);
  const after = normalize(concurrent, writes);
  assert.deepEqual([...after.schema.features], ["comments-doc", "strike"]);
  assert.equal(planPageNormalization(after).report.stamp_repair, false);
  assert.ok(documentFeatures(concurrent).includes("strike"));
});

/** A Page whose first block holds a paragraph with a stored `\n`, and a
 * comment whose selection ends on that `\n`: normalization would delete it. */
function newlineAnchoredPage() {
  let { doc, id } = adapterPage("x");
  doc = A.change(doc, (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      [
        { type: "block", value: { type: "paragraph", parents: [], attrs: {}, isEmbed: false } },
        { type: "text", value: "first\nsecond", marks: {} },
      ],
      updateSpansConfig,
    ),
  );
  let comments = newCommentsDoc();
  ({ comments } = comment(doc, comments, { block_id: id, selected_text: "t\n", body: "Edge" }));
  return { doc, id, comments };
}

test("a block whose rewrite would detach a comment anchor is refused", () => {
  const { doc, id, comments } = newlineAnchoredPage();
  const { report, writes } = planPageNormalization(doc, { commentsDoc: comments });
  assert.deepEqual(report.blocks, [
    { block_id: id, action: "refused", reason: "anchors_detached" },
  ]);
  assert.deepEqual(writes, []);
  assert.deepEqual(report.refused_reasons, { anchors_detached: 1 });
});

/** A one-block text document and a copy changed by `edit`. */
function rewritten(text, edit) {
  const path = ["blocks", "b", "richText"];
  const before = A.change(A.from({ blocks: { b: { richText: "" } } }), (draft) =>
    A.updateSpans(
      draft,
      path,
      [
        { type: "block", value: { type: "paragraph", parents: [], attrs: {}, isEmbed: false } },
        { type: "text", value: text, marks: {} },
      ],
      updateSpansConfig,
    ),
  );
  return { before, after: A.change(A.clone(before), (draft) => edit(draft, path)), path };
}

test("every lost character is counted, not a sample", () => {
  const text = "abcdefghij".repeat(10);
  // Index 6 of the text (7 with the marker) is no probe position of a stride.
  const { before, after, path } = rewritten(text, (draft, at) => A.splice(draft, at, 7, 1));
  const { text: measured } = measureRewrite(before, after, path);
  assert.deepEqual(measured, { before: 100, after: 99, lost: 1, newlines: 0, unexpected: 1 });
});

test("a lost prose newline is expected; inserted text is not", () => {
  const dropped = rewritten("one\ntwo", (draft, at) => A.splice(draft, at, 4, 1));
  assert.deepEqual(measureRewrite(dropped.before, dropped.after, dropped.path).text, {
    before: 7,
    after: 6,
    lost: 1,
    newlines: 1,
    unexpected: 0,
  });
  const grown = rewritten("one", (draft, at) => A.splice(draft, at, 2, 0, "X"));
  const text = measureRewrite(grown.before, grown.after, grown.path).text;
  assert.equal(text.unexpected, 0);
  assert.notEqual(text.after, text.before - text.newlines);
});

test("measuring a 256 KiB block stays fast", () => {
  const paragraph = "word ".repeat(200).trim();
  const markdown = Array.from({ length: 256 }, () => paragraph).join("\n\n");
  const { doc } = adapterPage(markdown);
  const started = performance.now();
  const { report } = planPageNormalization(doc);
  const elapsed = performance.now() - started;
  assert.equal(report.blocks[0].text.before, 256 * paragraph.length);
  assert.equal(report.blocks[0].text.unexpected, 0);
  note(`256 KiB block planned in ${Math.round(elapsed)} ms`);
  assert.ok(elapsed < 10_000, `${elapsed} ms`);
});

function note(message) {
  process.stdout.write(`# ${message}\n`);
}

test("a Markdown-era block is in the editor's form after one pass", () => {
  for (const markdown of [
    "Old **bold** text\n\n~~gone~~",
    "> - a\n> - b\n\nline  \nbreak",
    "x\ny",
    "```\ncode\n```",
    "| a |\n|---|\n| 1 |",
    "- [ ] t",
    "![i](https://example.com/i.png)",
    "> quote\n>\n> more",
    "1. one\n2. two\n\n   para",
  ]) {
    let { doc } = adapterPage("");
    doc = A.change(doc, (draft) => {
      draft.blocks.m = { id: "m", position: "a9", kind: "markdown", markdown, metadata: {} };
    });
    const after = normalize(doc, planPageNormalization(doc).writes);
    assert.deepEqual(planPageNormalization(after).writes, [], markdown);
  }
});

test("a block with no kind is refused, and counted on its own", () => {
  let { doc } = adapterPage("");
  doc = A.change(doc, (draft) => {
    draft.blocks.k = { id: "k", position: "a9", markdown: "Pre-format text", metadata: {} };
    draft.blocks.c = { id: "c", position: "b0", kind: "code", markdown: "x", metadata: {} };
  });
  const { report, writes } = planPageNormalization(doc);
  assert.deepEqual(writes, []);
  assert.deepEqual(report.refused_reasons, { kind_missing: 1, not_prose: 1 });
  assert.deepEqual(
    report.blocks.find((block) => block.block_id === "k"),
    { block_id: "k", action: "refused", reason: "kind_missing" },
  );
});
