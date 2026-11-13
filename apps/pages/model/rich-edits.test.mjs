// Agent rich-text operations: format_match occurrence and all, replace_match
// replacement_markdown, and set_node.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, orderedBlockIds, applyPageOperation } from "./page.mjs";
import { blockMarkdown, textPath } from "./richtext.mjs";
import { guardPassageEdits } from "./passage-edits.mjs";
import { documentFeatures } from "./schema-features.mjs";
import { decode, encode } from "./wordgard-doc.mjs";

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

test("a Markdown operation without Markdown is refused", () => {
  const { doc, id } = fixture("Keep this paragraph.\n\n- and this list");
  for (const markdown of [undefined, null, 7, ["text"]]) {
    const field = markdown === undefined ? {} : { markdown };
    refuses(
      doc,
      [{ op: "replace_block_markdown", block_id: id, ...field }],
      /replace_block_markdown requires a markdown string/,
    );
    refuses(
      doc,
      [{ op: "insert_markdown", ...field }],
      /insert_markdown requires a markdown string/,
    );
  }
  // One bad operation refuses the whole batch.
  refuses(
    doc,
    [
      { op: "set_title", title: "Changed" },
      { op: "replace_block_markdown", block_id: id },
    ],
    /requires a markdown string/,
  );
  // A rewrite still works, and so does an explicit empty string: Page
  // transfer empties a block that way (scripts/project-transfer.mjs).
  const { after } = apply(doc, [
    { op: "replace_block_markdown", block_id: id, markdown: "Rewritten." },
    { op: "insert_markdown", markdown: "" },
  ]);
  assert.equal(md(after, id).trim(), "Rewritten.");
  assert.equal(orderedBlockIds(after).length, orderedBlockIds(doc).length + 1);
  const emptied = apply(doc, [{ op: "replace_block_markdown", block_id: id, markdown: "" }]).after;
  assert.equal(md(emptied, id).trim(), "");
});

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
    { op: "set_node", block_id: id, match_text: "Ship the beta", attrs: { checked: true } },
  ]);
  assert.equal(md(after, id), projected("- [x] Ship the beta\n- [ ] Write notes"));
  assert.deepEqual(result.edits, [{ op: "set_node", block_id: id, matched: 1 }]);
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
    { op: "set_node", block_id: id, match_text: "graph TD", attrs: { language: "mermaid" } },
  ]);
  assert.equal(md(after, id), "```mermaid\ngraph TD\n  A --> B\n```");
  const plain = apply(after, [
    { op: "set_node", block_id: id, match_text: "graph TD", attrs: { language: "" } },
  ]).after;
  assert.equal(md(plain, id), "```\ngraph TD\n  A --> B\n```");
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "graph", attrs: { language: "a`b" } }],
    /without backticks/,
  );
});

test("set_node changes heading levels and turns headings into paragraphs", () => {
  const { doc, id } = fixture("Next steps\n\n### Details");
  const heading = apply(doc, [
    {
      op: "set_node",
      block_id: id,
      match_text: "Next steps",
      type: "heading",
      attrs: { level: 2 },
    },
  ]);
  assert.equal(md(heading.after, id), "## Next steps\n\n### Details");
  const paragraph = apply(heading.after, [
    { op: "set_node", block_id: id, match_text: "Details", type: "paragraph" },
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
    { op: "set_node", block_id: id, match_text: "Opening", type: "heading", attrs: { level: 1 } },
  ]);
  assert.equal(md(after, id), "# Opening words");
});

test("set_node aligns a whole table column and clears it", () => {
  const { doc, id } = fixture("| Item | Total |\n| --- | --- |\n| Tea | 3 |\n| Cake | 12 |");
  const { after, result } = apply(doc, [
    { op: "set_node", block_id: id, match_text: "12", attrs: { align: "right" } },
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
    { op: "set_node", block_id: id, match_text: "Total", attrs: { align: null } },
  ]).after;
  assert.equal(md(cleared, id), md(doc, id));
});

test("set_node refuses the wrong node and malformed fields", () => {
  const { doc, id } = fixture("A paragraph.\n\n- [ ] A task");
  const base = { op: "set_node", block_id: id };
  refuses(
    doc,
    [{ ...base, match_text: "paragraph", attrs: { checked: true } }],
    /checked applies to task list items; match_text is in a paragraph/,
  );
  refuses(
    doc,
    [{ ...base, match_text: "task", type: "heading", attrs: { level: 2 } }],
    /type applies to paragraphs and headings; match_text is in a task list item/,
  );
  refuses(
    doc,
    [{ ...base, match_text: "task", attrs: { language: "py" } }],
    /language applies to code blocks/,
  );
  refuses(
    doc,
    [{ ...base, match_text: "task", attrs: { align: "left" } }],
    /align applies to table cells/,
  );
  refuses(
    doc,
    [{ ...base, match_text: "task" }],
    /set_node takes type, attrs \(level, language, checked, align\), or both/,
  );
  refuses(
    doc,
    [{ ...base, match_text: "task", attrs: { checked: "yes" } }],
    /checked takes true or false/,
  );
  refuses(
    doc,
    [{ ...base, match_text: "paragraph", type: "heading", attrs: { level: 7 } }],
    /level takes an integer from 1 to 6/,
  );
  refuses(
    doc,
    [{ ...base, match_text: "task", attrs: { align: "justify" } }],
    /align takes left, center, right or null/,
  );
});

test("target scope accepts set_node beside unrelated edits and conflicts on the same node", () => {
  const { doc, id } = fixture("- [ ] Ship the beta\n- [ ] Write notes\n\nOther text.");
  const heads = A.getHeads(doc);
  const op = {
    op: "set_node",
    block_id: id,
    match_text: "Ship the beta",
    attrs: { checked: true },
  };
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
    () => guardPassageEdits(toggled, heads, [{ ...op, attrs: { checked: false } }]),
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
    { op: "set_node", block_id: id, match_text: "by Friday", attrs: { checked: true } },
    {
      op: "set_node",
      block_id: id,
      match_text: "y",
      occurrence: 1,
      node_index: 1,
      attrs: { align: "center" },
    },
  ]);
  assert.match(md(after, id), /^- \[x\] Ship/);
  assert.match(md(after, id), /\| :---: \| --- \|/);
});

test("set_node names a container's first paragraph instead of a marker type", () => {
  const { doc, id } = fixture("> quoted first\n>\n> second");
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "quoted", type: "heading", attrs: { level: 2 } }],
    /match_text is in a quote's first paragraph/,
  );
  // The quote's later paragraphs have their own markers.
  const { after } = apply(doc, [
    { op: "set_node", block_id: id, match_text: "second", type: "heading", attrs: { level: 3 } },
  ]);
  assert.match(md(after, id), /> ### second/);
});

test("set_node updates markers in place and leaves every text mark alone", () => {
  const { doc, id } = fixture(
    "Lead\n\nIntro **bold** text\n\n```py\nx = 1\n```\n\n| a | *b* |\n| --- | --- |\n| 1 | 2 |",
  );
  const path = textPath(id);
  // The first paragraph is implicit; "Intro" has its own marker to update.
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
  // Marker offsets by type, and each position's marks, at one revision.
  const markerOffsets = (d) => {
    const found = [];
    let at = 0;
    for (const span of A.spans(d, path)) {
      if (span.type === "block") found.push([at++, String(span.value.type)]);
      else at += span.value.length;
    }
    return found;
  };
  const positionMarks = (d) => {
    const each = Array.from({ length: d.blocks[id].richText.length }, () => ({}));
    for (const mark of A.marks(d, path))
      for (let at = mark.start; at < mark.end; at++) each[at][mark.name] = mark.value;
    return each.map((value) => JSON.stringify(value));
  };
  const cells = markerOffsets(marked)
    .filter(([, type]) => type === "table-cell" || type === "table-header")
    .map(([at]) => at);
  for (const [op, expected] of [
    [
      { match_text: "Intro", type: "heading", attrs: { level: 2 } },
      markerOffsets(marked)
        .filter(([, type]) => type === "paragraph")
        .map(([at]) => at)
        .slice(0, 1),
    ],
    [
      { match_text: "x = 1", attrs: { language: "rust" } },
      markerOffsets(marked)
        .filter(([, type]) => type === "code-block")
        .map(([at]) => at),
    ],
    [{ match_text: "2", attrs: { align: "right" } }, cells.filter((_, index) => index % 2 === 1)],
  ]) {
    const heads = A.getHeads(marked);
    const before = marks(marked);
    const beforePositions = positionMarks(marked);
    const markers = new Set(markerOffsets(marked).map(([at]) => at));
    const next = apply(marked, [{ op: "set_node", block_id: id, ...op }]).after;
    assert.equal(marks(next), before, JSON.stringify(op));
    // Only the expected markers' attributes and types change: no text
    // splices, no marker deleted and reinserted, no other marker touched.
    const touched = new Set();
    for (const patch of A.diff(next, heads, A.getHeads(next))) {
      if (patch.action === "mark") continue;
      const [, , , at, field] = patch.path;
      assert.ok(
        ["attrs", "type"].includes(field),
        `${JSON.stringify(op)} wrote ${JSON.stringify(patch)}`,
      );
      touched.add(at);
    }
    assert.deepEqual(
      [...touched].sort((a, b) => a - b),
      expected,
      JSON.stringify(op),
    );
    // Marks change only on marker characters, which format nothing.
    positionMarks(next).forEach((value, at) => {
      if (value !== beforePositions[at])
        assert.ok(markers.has(at), `${JSON.stringify(op)} changed marks at text offset ${at}`);
    });
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
    { op: "set_node", block_id: id, match_text: "Ship the beta", attrs: { checked: true } },
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

// The editor rewrites a whole block from encode(decode(spans)). If an import
// or a set_node wrote a marker the editor would encode differently, the next
// keystroke in the block would write history.
test("an editor rewrite after an import or a set_node writes nothing", () => {
  const source =
    "Intro words\n\n- [ ] task\n\n```py\nx = 1\n```\n\n| a | b |\n| --- | ---: |\n| 1 | 2 |";
  const rewrite = (doc, id) => {
    const path = textPath(id);
    const heads = A.getHeads(doc);
    const after = A.change(A.clone(doc), (draft) =>
      A.updateSpans(draft, path, encode(decode(A.spans(draft, path)).doc)),
    );
    return A.diff(after, heads, A.getHeads(after)).map((patch) => [
      patch.action,
      patch.path.slice(3),
    ]);
  };
  const untouched = fixture(source);
  assert.deepEqual(rewrite(untouched.doc, untouched.id), []);
  const key = JSON.stringify;
  for (const op of [
    { match_text: "Intro", type: "heading", attrs: { level: 3 } },
    { match_text: "task", attrs: { checked: true } },
    { match_text: "x = 1", attrs: { language: "rust" } },
    { match_text: "x = 1", attrs: { language: "" } },
    { match_text: "2", attrs: { align: "center" } },
    { match_text: "2", attrs: { align: null } },
  ]) {
    const { doc, id } = fixture(source);
    const { after } = apply(doc, [{ op: "set_node", block_id: id, ...op }]);
    assert.deepEqual(rewrite(after, id), [], key(op));
  }
  // The implicit first paragraph: a heading marker the editor keeps, and a
  // no-op that writes nothing at all.
  let doc = A.from(createPageData({ pageId: "implicit_rewrite", title: "Implicit" }));
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) => A.splice(draft, textPath(id), 0, 0, "Opening words"));
  const heading = apply(doc, [
    { op: "set_node", block_id: id, match_text: "Opening", type: "heading", attrs: { level: 2 } },
  ]);
  assert.deepEqual(rewrite(heading.after, id), []);
  const same = apply(doc, [
    { op: "set_node", block_id: id, match_text: "Opening", type: "paragraph" },
  ]);
  assert.deepEqual(A.getHeads(same.after), A.getHeads(doc));
  assert.deepEqual(same.result.edits, [{ op: "set_node", block_id: id, matched: 1 }]);
});

test("occurrence names a match in the batch's starting snapshot", () => {
  const { doc, id } = fixture("TODO a, TODO b, TODO c");
  const operations = [
    { op: "replace_match", block_id: id, match_text: "TODO", occurrence: 1, replacement: "DONE" },
    { op: "replace_match", block_id: id, match_text: "TODO", occurrence: 2, replacement: "DONE" },
  ];
  assert.equal(md(apply(doc, operations).after, id), "DONE a, DONE b, TODO c");
  // Target scope agrees with page scope.
  const plan = guardPassageEdits(doc, A.getHeads(doc), operations);
  assert.equal(md(apply(doc, plan.operations).after, id), "DONE a, DONE b, TODO c");
  // An occurrence an earlier operation rewrote is refused, never retargeted.
  refuses(
    doc,
    [
      { op: "replace_match", block_id: id, match_text: "TODO b", replacement: "x" },
      {
        op: "format_match",
        block_id: id,
        match_text: "TODO",
        occurrence: 2,
        add: { strong: true },
      },
    ],
    /occurrence 2 was changed by an earlier operation in this batch/,
  );
  // Overlapping matches count for occurrence; all skips them.
  const overlap = fixture("aaa");
  const second = apply(overlap.doc, [
    {
      op: "format_match",
      block_id: overlap.id,
      match_text: "aa",
      occurrence: 2,
      add: { em: true },
    },
  ]).after;
  assert.equal(md(second, overlap.id), "a*aa*");
});

test("formatting writes are capped per all and per batch", () => {
  const { doc, id } = fixture("x ".repeat(1001).trim());
  refuses(
    doc,
    [{ op: "format_match", block_id: id, match_text: "x", all: true, add: { strong: true } }],
    /found 1001 matches; at most 1000 per operation/,
  );
  const many = fixture("y ".repeat(700).trim());
  const each = { op: "format_match", block_id: many.id, match_text: "y", all: true };
  refuses(
    many.doc,
    [
      { ...each, add: { strong: true } },
      { ...each, add: { em: true } },
      { ...each, add: { strike: true } },
    ],
    /more than 2000 ranges; split it/,
  );
  // replacement_markdown runs count against the same batch budget.
  refuses(
    doc,
    Array.from({ length: 5 }, (_, index) => ({
      op: "replace_match",
      block_id: id,
      match_text: "x",
      occurrence: index + 1,
      replacement_markdown: "**a** *b* ".repeat(201).trim(),
    })),
    /more than 2000 ranges/,
  );
});

test("replacement_markdown keeps unsafe link destinations as literal text", () => {
  const { doc, id } = fixture("Read here.");
  for (const markdown of ["[x](javascript:alert(1))", "[x](data:text/html,hi)"]) {
    const { after } = apply(doc, [
      { op: "replace_match", block_id: id, match_text: "here", replacement_markdown: markdown },
    ]);
    assert.deepEqual(A.marks(after, textPath(id)), [], markdown);
    assert.ok(after.blocks[id].richText.includes(markdown), markdown);
  }
});

test("set_node can't address an image block, which has no visible text", () => {
  const { doc, id } = fixture("Before.");
  const assetId = "a".repeat(64);
  const { after } = (() => {
    let result;
    const next = A.change(A.clone(doc), (draft) => {
      result = applyPageOperation(draft, {
        operation: "edit_page",
        arguments: {
          operations: [{ op: "insert_image", asset_id: assetId, alt: "Chart", after_block_id: id }],
        },
      });
    });
    return { after: next, result };
  })();
  const image = orderedBlockIds(after)[1];
  refuses(
    after,
    [
      {
        op: "set_node",
        block_id: image,
        match_text: "Chart",
        type: "heading",
        attrs: { level: 2 },
      },
    ],
    /found 0 matches/,
  );
});

test("set_node takes {type, attrs} with the names read_page reports", () => {
  const { doc, id } = fixture(
    "Intro words\n\n- [ ] task\n\n```\ngraph TD\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
  );
  const run = (op) => apply(doc, [{ op: "set_node", block_id: id, ...op }]);
  assert.match(
    md(run({ match_text: "Intro", type: "heading", attrs: { level: 2 } }).after, id),
    /^## Intro words/,
  );
  assert.match(md(run({ match_text: "task", attrs: { checked: true } }).after, id), /- \[x\] task/);
  assert.match(
    md(run({ match_text: "graph", attrs: { language: "mermaid" } }).after, id),
    /```mermaid/,
  );
  const aligned = run({ match_text: "2", attrs: { align: "right" } });
  assert.equal(aligned.result.edits[0].cells, 2);
  // Heading level changes, and back to a paragraph drops the level.
  const heading = run({ match_text: "Intro", type: "heading", attrs: { level: 2 } }).after;
  const deeper = apply(heading, [
    { op: "set_node", block_id: id, match_text: "Intro", attrs: { level: 4 } },
  ]).after;
  assert.match(md(deeper, id), /^#### Intro words/);
  const back = apply(deeper, [
    { op: "set_node", block_id: id, match_text: "Intro", type: "paragraph" },
  ]).after;
  assert.match(md(back, id), /^Intro words/);
  assert.deepEqual(markers(back, id)[0], ["paragraph", {}]);
  // Refusals name the registry's types.
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "Intro", type: "heading" }],
    /heading needs attrs\.level/,
  );
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "task", type: "heading", attrs: { level: 1 } }],
    /type applies to paragraphs and headings; match_text is in a task list item/,
  );
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "task", attrs: { level: 2 } }],
    /level applies to headings; match_text is in a task list item/,
  );
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "task", type: "code-block" }],
    /type takes paragraph or heading/,
  );
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "task", attrs: { color: "red" } }],
    /attrs take level, language, checked, align; color isn't one/,
  );
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "Intro", type: "heading", attrs: { level: 7 } }],
    /level takes an integer from 1 to 6/,
  );
  // A retype refusal names the type the node would become.
  refuses(
    heading,
    [{ op: "set_node", block_id: id, match_text: "Intro", type: "paragraph", attrs: { level: 2 } }],
    /type paragraph has no level; level applies to headings/,
  );
  // attrs can name several attributes, and each must apply to the node. No
  // type holds two settable attrs, so a second one is refused, never dropped.
  refuses(
    heading,
    [{ op: "set_node", block_id: id, match_text: "Intro", attrs: { level: 3, checked: true } }],
    /checked applies to task list items; match_text is in a heading/,
  );
  refuses(
    doc,
    [{ op: "set_node", block_id: id, match_text: "2", attrs: { align: "left", language: "js" } }],
    /language applies to code blocks; match_text is in a table cell/,
  );
});

test("a retype drops only the old type's own attrs and keeps a newer build's", () => {
  const { doc: plain, id } = fixture("Intro words\n\nSecond words");
  // A newer build's attr on the second paragraph's marker.
  const extra = A.change(A.clone(plain), (draft) => {
    const spans = A.spans(draft, textPath(id)).map((span) =>
      span.type === "block" ? { ...span, value: { ...span.value, attrs: { anchor: "a1" } } } : span,
    );
    A.updateSpans(draft, textPath(id), spans);
  });
  assert.deepEqual(markers(extra, id), [["paragraph", { anchor: "a1" }]]);
  const heading = apply(extra, [
    { op: "set_node", block_id: id, match_text: "Second", type: "heading", attrs: { level: 2 } },
  ]).after;
  assert.deepEqual(markers(heading, id), [["heading", { anchor: "a1", level: 2 }]]);
  const back = apply(heading, [
    { op: "set_node", block_id: id, match_text: "Second", type: "paragraph" },
  ]).after;
  assert.deepEqual(markers(back, id), [["paragraph", { anchor: "a1" }]]);
});

test("set_node refuses a top-level field and names the typed field to use", () => {
  const { doc, id } = fixture(
    "Intro words\n\n- [ ] task\n\n```\ngraph TD\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
  );
  const cases = [
    [
      "Intro",
      { heading_level: 2 },
      /not a top-level heading_level; use type "heading" with attrs\.level, or type "paragraph"/,
    ],
    ["Intro", { heading_level: 0 }, /not a top-level heading_level/],
    ["task", { checked: true }, /not a top-level checked; use attrs\.checked/],
    ["graph", { language: "mermaid" }, /not a top-level language; use attrs\.language/],
    ["2", { align: "center" }, /not a top-level align; use attrs\.align/],
    ["2", { align: null }, /not a top-level align; use attrs\.align/],
    // Beside the typed shape too: refused, never silently ignored.
    ["task", { checked: false, attrs: { checked: true } }, /not a top-level checked/],
  ];
  for (const [target, fields, message] of cases)
    refuses(doc, [{ op: "set_node", block_id: id, match_text: target, ...fields }], message);
});
