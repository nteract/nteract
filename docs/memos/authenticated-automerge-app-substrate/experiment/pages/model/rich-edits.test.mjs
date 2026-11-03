// Agent rich-text operations: format_match occurrence and all, replace_match
// replacement_markdown, and set_node.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, orderedBlockIds, applyPageOperation } from "./page.mjs";
import { blockMarkdown, textPath } from "./richtext.mjs";
import { guardPassageEdits } from "./passage-edits.mjs";
import { documentFeatures } from "./schema-features.mjs";

function fixture(markdown) {
  let doc = A.from(createPageData({ pageId: "rich_edits", title: "Rich edits" }));
  doc = A.change(doc, (draft) => initializePage(draft, markdown));
  return { doc, id: orderedBlockIds(doc)[0] };
}
function apply(doc, operations) {
  let result;
  const after = A.change(A.clone(doc), (draft) => {
    result = applyPageOperation(draft, { operation: "patch_page", arguments: { operations } });
  });
  return { after, result };
}
const md = (doc, id) => blockMarkdown(doc.blocks[id]);
// The projection of a Page written with `markdown`, so expectations follow
// the exporter's own list and table spacing.
const projected = (markdown) => {
  const { doc, id } = fixture(markdown);
  return md(doc, id);
};
const refuses = (doc, operations, pattern) => assert.throws(() => apply(doc, operations), pattern);
const markers = (doc, id) =>
  A.spans(doc, textPath(id))
    .filter((span) => span.type === "block")
    .map((span) => [String(span.value.type), { ...span.value.attrs }]);

test("format_match occurrence picks one match in document order", () => {
  const { doc, id } = fixture("Ship it. Ship it now. Ship it later.");
  const { after, result } = apply(doc, [
    { op: "format_match", block_id: id, match_text: "Ship", occurrence: 2, add: { strong: true } },
  ]);
  assert.equal(md(after, id), "Ship it. **Ship** it now. Ship it later.");
  assert.deepEqual(result.edits, [{ op: "format_match", block_id: id, matched: 1 }]);
  refuses(
    doc,
    [{ op: "format_match", block_id: id, match_text: "Ship", occurrence: 4, add: { em: true } }],
    /found 3 matches; occurrence 4/,
  );
  refuses(
    doc,
    [{ op: "format_match", block_id: id, match_text: "Ship", occurrence: 0, add: { em: true } }],
    /occurrence must be an integer/,
  );
  refuses(
    doc,
    [{ op: "format_match", block_id: id, match_text: "Ship", add: { em: true } }],
    /found 3 matches; exactly one is required. Use occurrence/,
  );
});

test("format_match all highlights every match, skips code, and counts both", () => {
  const { doc, id } = fixture(
    "A launch date.\n\n- launch date one\n- the launch date\n\n```\nlaunch date\n```",
  );
  const { after, result } = apply(doc, [
    {
      op: "format_match",
      block_id: id,
      match_text: "launch date",
      all: true,
      add: { highlight: "green" },
    },
  ]);
  assert.deepEqual(result.edits, [
    { op: "format_match", block_id: id, matched: 3, skipped_in_code: 1 },
  ]);
  assert.equal(
    md(after, id),
    projected(
      'A <mark data-color="green">launch date</mark>.\n\n- <mark data-color="green">launch date</mark> one\n- the <mark data-color="green">launch date</mark>\n\n```\nlaunch date\n```',
    ),
  );
  // Removing a mark from every match.
  const cleared = apply(after, [
    {
      op: "format_match",
      block_id: id,
      match_text: "launch date",
      all: true,
      remove: ["highlight"],
    },
  ]).after;
  assert.equal(md(cleared, id), md(doc, id));
  refuses(
    doc,
    [{ op: "format_match", block_id: id, match_text: "absent", all: true, add: { em: true } }],
    /found 0 matches/,
  );
  refuses(
    doc,
    [
      {
        op: "format_match",
        block_id: id,
        match_text: "launch",
        all: true,
        occurrence: 1,
        add: { em: true },
      },
    ],
    /occurrence or all/,
  );
  refuses(
    doc,
    [{ op: "format_match", block_id: id, match_text: "launch", all: false, add: { em: true } }],
    /all takes the value true/,
  );
});

test("format_match all takes non-overlapping matches and honors node_index", () => {
  const { doc, id } = fixture("aaaa\n\naa");
  const whole = apply(doc, [
    { op: "format_match", block_id: id, match_text: "aa", all: true, add: { strong: true } },
  ]);
  assert.equal(whole.result.edits[0].matched, 3);
  const scoped = apply(doc, [
    {
      op: "format_match",
      block_id: id,
      match_text: "aa",
      all: true,
      node_index: 1,
      add: { em: true },
    },
  ]);
  assert.equal(md(scoped.after, id), "aaaa\n\n*aa*");
});

test("replace_match occurrence replaces one of several matches", () => {
  const { doc, id } = fixture("TODO first, TODO second");
  const { after } = apply(doc, [
    { op: "replace_match", block_id: id, match_text: "TODO", occurrence: 2, replacement: "DONE" },
  ]);
  assert.equal(md(after, id), "TODO first, DONE second");
});

test("replacement_markdown writes text and formatting while anchors on kept words survive", () => {
  const { doc, id } = fixture("We ship on **Friday** with QA review.");
  const path = textPath(id);
  const at = doc.blocks[id].richText.indexOf("review");
  const cursor = A.getCursor(doc, path, at);
  const { after, result } = apply(doc, [
    {
      op: "replace_match",
      block_id: id,
      match_text: "ship on Friday with QA",
      replacement_markdown:
        'ship on Monday with <mark data-color="green">QA</mark> and ~~no~~ *extra*',
    },
  ]);
  assert.equal(
    md(after, id),
    'We ship on Monday with <mark data-color="green">QA</mark> and ~~no~~ *extra* review.',
  );
  // Formatting written in Markdown is explicit, so no marks_dropped warning.
  assert.deepEqual(result.edits, [{ op: "replace_match", block_id: id, matched: 1 }]);
  assert.equal(
    after.blocks[id].richText.slice(A.getCursorPosition(after, path, cursor)).slice(0, 6),
    "review",
  );
  assert.ok(documentFeatures(after).includes("strike"));
});

test("replacement_markdown keeps whole-match marks, outer spaces and foreign text", () => {
  const { doc, id } = fixture("Read the [release notes](https://example.com) today.");
  const { after } = apply(doc, [
    {
      op: "replace_match",
      block_id: id,
      match_text: "release notes",
      replacement_markdown: " **new** release notes ",
    },
  ]);
  // The link covered the whole match, so it covers the replacement too.
  assert.equal(md(after, id), "Read the [ **new** release notes ](https://example.com) today.");
});

test("replacement_markdown refuses blocks, line breaks, code text and doubled replacements", () => {
  const { doc, id } = fixture("Plain words.\n\n```\ncode words\n```");
  const base = { op: "replace_match", block_id: id, match_text: "Plain" };
  refuses(doc, [{ ...base, replacement_markdown: "# Heading" }], /inline Markdown on one line/);
  refuses(doc, [{ ...base, replacement_markdown: "- item" }], /inline Markdown on one line/);
  refuses(doc, [{ ...base, replacement_markdown: "a\nb" }], /inline Markdown on one line/);
  refuses(doc, [{ ...base, replacement_markdown: "$x$" }], /math/i);
  refuses(
    doc,
    [{ ...base, replacement: "x", replacement_markdown: "x" }],
    /replacement or replacement_markdown/,
  );
  refuses(doc, [{ ...base }], /replacement or replacement_markdown/);
  refuses(
    doc,
    [{ op: "replace_match", block_id: id, match_text: "code", replacement_markdown: "**c**" }],
    /inside a code block/,
  );
  // An escaped leading marker stays text.
  const escaped = apply(doc, [{ ...base, replacement_markdown: "\\# Plain" }]).after;
  assert.equal(escaped.blocks[id].richText.includes("# Plain words."), true);
});

test("set_node checks a task without moving its marker or text", () => {
  const { doc, id } = fixture("- [ ] Ship the beta\n- [ ] Write notes");
  const path = textPath(id);
  const marker = A.getCursor(doc, path, 0);
  const text = A.getCursor(doc, path, 1);
  const heads = A.getHeads(doc);
  const { after, result } = apply(doc, [
    { op: "set_node", block_id: id, match_text: "Ship the beta", checked: true },
  ]);
  assert.equal(md(after, id), projected("- [x] Ship the beta\n- [ ] Write notes"));
  assert.deepEqual(result.edits, [
    { op: "set_node", block_id: id, matched: 1, node: "task-list-item" },
  ]);
  assert.equal(A.getCursorPosition(after, path, marker), 0);
  assert.equal(A.getCursorPosition(after, path, text), 1);
  // One attribute write: no text splices, no marker replacement.
  const patches = A.diff(after, heads, A.getHeads(after));
  assert.deepEqual(
    patches.map((patch) => [patch.action, patch.path.slice(3)]),
    [["put", [0, "attrs", "checked"]]],
  );
});

test("set_node sets a code block's language, including mermaid", () => {
  const { doc, id } = fixture("```\ngraph TD\n  A --> B\n```");
  const { after } = apply(doc, [
    { op: "set_node", block_id: id, match_text: "graph TD", language: "mermaid" },
  ]);
  assert.equal(md(after, id), "```mermaid\ngraph TD\n  A --> B\n```");
  const plain = apply(after, [
    { op: "set_node", block_id: id, match_text: "graph TD", language: "" },
  ]).after;
  assert.equal(md(plain, id), "```\ngraph TD\n  A --> B\n```");
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "graph", language: "a`b" }],
    /without backticks/,
  );
});

test("set_node changes heading levels and turns headings into paragraphs", () => {
  const { doc, id } = fixture("Next steps\n\n### Details");
  const heading = apply(doc, [
    { op: "set_node", block_id: id, match_text: "Next steps", heading_level: 2 },
  ]);
  assert.equal(md(heading.after, id), "## Next steps\n\n### Details");
  assert.equal(heading.result.edits[0].node, "heading");
  const paragraph = apply(heading.after, [
    { op: "set_node", block_id: id, match_text: "Details", heading_level: 0 },
  ]).after;
  assert.equal(md(paragraph, id), "## Next steps\n\nDetails");
  assert.deepEqual(markers(paragraph, id), [
    ["heading", { level: 2 }],
    ["paragraph", {}],
  ]);
});

test("set_node gives the implicit first paragraph a marker when it becomes a heading", () => {
  let doc = A.from(createPageData({ pageId: "implicit", title: "Implicit" }));
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) => A.splice(draft, textPath(id), 0, 0, "Opening words"));
  assert.deepEqual(markers(doc, id), []);
  const { after } = apply(doc, [
    { op: "set_node", block_id: id, match_text: "Opening", heading_level: 1 },
  ]);
  assert.equal(md(after, id), "# Opening words");
});

test("set_node aligns a whole table column and clears it", () => {
  const { doc, id } = fixture("| Item | Total |\n| --- | --- |\n| Tea | 3 |\n| Cake | 12 |");
  const { after, result } = apply(doc, [
    { op: "set_node", block_id: id, match_text: "12", align: "right" },
  ]);
  assert.equal(result.edits[0].cells, 3);
  assert.equal(
    md(after, id),
    projected("| Item | Total |\n| --- | ---: |\n| Tea | 3 |\n| Cake | 12 |"),
  );
  assert.deepEqual(
    markers(after, id)
      .filter(([type]) => type.startsWith("table-") && type !== "table-row")
      .map(([, attrs]) => (attrs.align == null ? null : String(attrs.align))),
    [null, "right", null, "right", null, "right"],
  );
  const cleared = apply(after, [
    { op: "set_node", block_id: id, match_text: "Total", align: null },
  ]).after;
  assert.equal(md(cleared, id), md(doc, id));
});

test("set_node refuses the wrong node and malformed fields", () => {
  const { doc, id } = fixture("A paragraph.\n\n- [ ] A task");
  const base = { op: "set_node", block_id: id };
  refuses(
    doc,
    [{ ...base, match_text: "paragraph", checked: true }],
    /checked applies to task list items; match_text is in a paragraph/,
  );
  refuses(
    doc,
    [{ ...base, match_text: "task", heading_level: 2 }],
    /heading_level applies to paragraphs and headings; match_text is in a task list item/,
  );
  refuses(
    doc,
    [{ ...base, match_text: "task", language: "py" }],
    /language applies to code blocks/,
  );
  refuses(doc, [{ ...base, match_text: "task", align: "left" }], /align applies to table cells/);
  refuses(
    doc,
    [{ ...base, match_text: "task" }],
    /exactly one of checked, language, heading_level, align/,
  );
  refuses(doc, [{ ...base, match_text: "task", checked: true, language: "x" }], /exactly one of/);
  refuses(doc, [{ ...base, match_text: "task", checked: "yes" }], /checked takes true or false/);
  refuses(
    doc,
    [{ ...base, match_text: "paragraph", heading_level: 7 }],
    /heading_level takes 1 to 6/,
  );
  refuses(
    doc,
    [{ ...base, match_text: "task", align: "justify" }],
    /align takes left, center, right or null/,
  );
});

test("target scope accepts set_node beside unrelated edits and conflicts on the same node", () => {
  const { doc, id } = fixture("- [ ] Ship the beta\n- [ ] Write notes\n\nOther text.");
  const heads = A.getHeads(doc);
  const op = { op: "set_node", block_id: id, match_text: "Ship the beta", checked: true };
  // A peer edits elsewhere: the target is unchanged.
  const elsewhere = apply(doc, [
    { op: "replace_match", block_id: id, match_text: "Other", replacement: "Different" },
  ]).after;
  const plan = guardPassageEdits(elsewhere, heads, [op]);
  assert.equal(plan.rebased, true);
  const merged = apply(elsewhere, plan.operations).after;
  assert.equal(
    md(merged, id),
    projected("- [x] Ship the beta\n- [ ] Write notes\n\nDifferent text."),
  );
  // A peer checks the same item first: the node's attributes changed.
  const toggled = apply(doc, [op]).after;
  assert.throws(
    () => guardPassageEdits(toggled, heads, [{ ...op, checked: false }]),
    (error) =>
      error.code === "edit_conflict" &&
      error.details.conflicts[0].reason === "target_structure_changed",
  );
  // all is page-scoped only.
  assert.throws(
    () =>
      guardPassageEdits(doc, heads, [
        { op: "format_match", block_id: id, match_text: "e", all: true, add: { em: true } },
      ]),
    (error) => error.code === "invalid_edit_selector" && /conflict_scope page/.test(error.message),
  );
});

test("set_node looks past hard breaks to the node that holds the text", () => {
  const { doc, id } = fixture(
    "- [ ] Ship\\\nby Friday\n\n| a | b |\n| --- | --- |\n| x<br>y | 2 |",
  );
  const { after } = apply(doc, [
    { op: "set_node", block_id: id, match_text: "by Friday", checked: true },
    {
      op: "set_node",
      block_id: id,
      match_text: "y",
      occurrence: 1,
      node_index: 1,
      align: "center",
    },
  ]);
  assert.match(md(after, id), /^- \[x\] Ship/);
  assert.match(md(after, id), /\| :---: \| --- \|/);
});

test("set_node names a container's first paragraph instead of a marker type", () => {
  const { doc, id } = fixture("> quoted first\n>\n> second");
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "quoted", heading_level: 2 }],
    /match_text is in a quote's first paragraph/,
  );
  // The quote's later paragraphs have their own markers.
  const { after } = apply(doc, [
    { op: "set_node", block_id: id, match_text: "second", heading_level: 3 },
  ]);
  assert.match(md(after, id), /> ### second/);
});

test("set_node updates markers in place and leaves every text mark alone", () => {
  const { doc, id } = fixture(
    "Intro **bold** text\n\n```py\nx = 1\n```\n\n| a | *b* |\n| --- | --- |\n| 1 | 2 |",
  );
  const path = textPath(id);
  // A mark crossing a block marker, a stray mark on code text, and a mark
  // this build doesn't know: none may change on any text character. Marks on
  // the marker characters themselves carry no formatting; updateSpans drops
  // them, as it does for every editor keystroke in the block.
  let marked = A.change(A.clone(doc), (draft) => {
    const text = draft.blocks[id].richText;
    A.mark(
      draft,
      path,
      { start: text.indexOf("text"), end: text.indexOf("x =") + 1, expand: "none" },
      "em",
      true,
    );
    A.mark(
      draft,
      path,
      { start: text.indexOf("1\n"), end: text.indexOf("1\n") + 1, expand: "none" },
      "strong",
      true,
    );
    A.mark(draft, path, { start: 0, end: 5, expand: "none" }, "futureMark", "v");
  });
  const marks = (d) =>
    JSON.stringify(
      A.spans(d, path)
        .filter((span) => span.type === "text")
        .map((span) => [span.value, span.marks ?? {}]),
    );
  for (const op of [
    { match_text: "Intro", heading_level: 2 },
    { match_text: "x = 1", language: "rust" },
    { match_text: "2", align: "right" },
  ]) {
    const heads = A.getHeads(marked);
    const before = marks(marked);
    const next = apply(marked, [{ op: "set_node", block_id: id, ...op }]).after;
    assert.equal(marks(next), before, JSON.stringify(op));
    // Only marker attributes and types change: no text splices, no marker
    // deleted and reinserted. A mark patch is the marker normalization above.
    for (const patch of A.diff(next, heads, A.getHeads(next))) {
      if (patch.action === "mark") continue;
      const [, , , , field] = patch.path;
      assert.ok(
        ["attrs", "type"].includes(field),
        `${JSON.stringify(op)} wrote ${JSON.stringify(patch)}`,
      );
    }
    marked = next;
  }
});

test("target scope keeps unsupported_markdown and lets set_node share a passage", () => {
  const { doc, id } = fixture("- [ ] Ship the beta");
  const heads = A.getHeads(doc);
  assert.throws(
    () =>
      guardPassageEdits(doc, heads, [
        { op: "replace_match", block_id: id, match_text: "beta", replacement_markdown: "$x$" },
      ]),
    (error) => error.code === "unsupported_markdown" && !!error.details?.unsupported,
  );
  const operations = [
    { op: "set_node", block_id: id, match_text: "Ship the beta", checked: true },
    { op: "format_match", block_id: id, match_text: "Ship the beta", add: { strike: true } },
  ];
  const plan = guardPassageEdits(doc, heads, operations);
  assert.equal(md(apply(doc, plan.operations).after, id), projected("- [x] ~~Ship the beta~~"));
});

test("format_match all skips a match that cuts a character", () => {
  const { doc, id } = fixture("cafe\u0301 and cafe");
  const { after, result } = apply(doc, [
    { op: "format_match", block_id: id, match_text: "cafe", all: true, add: { strong: true } },
  ]);
  assert.equal(result.edits[0].matched, 1);
  assert.equal(md(after, id), "cafe\u0301 and **cafe**");
});
