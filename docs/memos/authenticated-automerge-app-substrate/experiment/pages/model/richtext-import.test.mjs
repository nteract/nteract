import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { pmDocFromSpans, pmNodeToSpans } from "@automerge/prosemirror";
import { adapter, exportMarkdown, parseMarkdown, richDoc } from "./richtext.mjs";
import { applyComment } from "./comments.mjs";
import { commentMarkdown, markdownCommentSpans } from "./comment-content.mjs";
import {
  applyPageOperation,
  createPageData,
  initializePage,
  orderedBlockIds,
  projectPage,
} from "./page.mjs";

// An agent comment that rendered as one opaque monospace block. Its prose
// mentions two dollar amounts, which the import gate read as inline math.
const BODY = [
  'Diagnosis (agent): your lines above are joined by line breaks inside one paragraph, not separate paragraphs. The Markdown export shows `\\` at each line end, which is a hard break. That explains both effects: `## ` only fires at the start of a paragraph, and "Heading 1" converts the whole paragraph because it\'s all one paragraph.',
  "",
  "In progress, one PR:",
  "- Find out whether you pressed Shift+Enter or whether plain Enter is making line breaks somewhere (that would be a bug).",
  "- `## ` after a line break splits the paragraph there and makes just that line a heading. Same for `- `, `1. `, `> ` and task items.",
  "- Block commands on one line of a multi-line paragraph convert just that line.",
  '- Typing `` `code` `` makes inline code. No auto-math, so "$30 and $25" stays as text.',
].join("\n");

// Native content as stored: parsed Markdown after the Automerge span round trip.
const nativeDoc = (markdown) =>
  pmDocFromSpans(adapter, pmNodeToSpans(adapter, parseMarkdown(markdown)));
const kinds = (doc) => {
  const names = [];
  doc.descendants((node) => {
    names.push(node.type.name);
  });
  return names;
};
const codeText = (doc) => {
  const values = [];
  doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === "code")) values.push(node.text);
  });
  return values;
};

function assertDiagnosisStructure(doc) {
  assert.ok(!kinds(doc).includes("raw"), "the body is native rich text, not opaque source");
  assert.ok(!kinds(doc).includes("code_block"), "no inline code span opens a code block");
  assert.deepEqual(
    Array.from({ length: doc.childCount }, (_, i) => doc.child(i).type.name),
    ["paragraph", "paragraph", "bullet_list"],
  );
  assert.equal(doc.child(2).childCount, 4);
  assert.deepEqual(codeText(doc), ["\\", "## ", "## ", "- ", "1. ", "> ", "`code`"]);
  assert.match(doc.child(2).child(3).textContent, /"\$30 and \$25" stays as text\.$/);
}

test("the agent diagnosis comment body imports as paragraphs, a list and inline code", () => {
  assertDiagnosisStructure(parseMarkdown(BODY));
});

test("the diagnosis body's Markdown export reimports to the same document", () => {
  const doc = parseMarkdown(BODY);
  const markdown = exportMarkdown(doc);
  assert.ok(parseMarkdown(markdown).eq(doc));
  assert.equal(exportMarkdown(parseMarkdown(markdown)), markdown);
});

test("manage_page_comment add with body_format markdown stores the diagnosis as native rich text", () => {
  let doc = A.from({
    page_id: "comments",
    title: "Test",
    blocks: { one: { markdown: "A passage", position: "a0" } },
    comments: {},
  });
  let ids;
  doc = A.change(doc, (d) => {
    ids = applyComment(
      d,
      {
        action: "add",
        block_id: "one",
        selected_text: "passage",
        body: BODY,
        body_format: "markdown",
      },
      { principal: "fixture", displayName: "Agent", driver: "MCP" },
    );
  });
  const message = doc.comments[ids.thread_id].messages[ids.message_id];
  const stored = richDoc(message);
  assertDiagnosisStructure(stored);
  assert.ok(pmDocFromSpans(adapter, markdownCommentSpans(BODY)).eq(stored));
  // The Markdown projection reimports to the stored native content.
  assert.ok(pmDocFromSpans(adapter, markdownCommentSpans(commentMarkdown(message))).eq(stored));
});

test("create_page and replace_block_markdown store the diagnosis as native rich text", () => {
  let doc = A.change(A.from(createPageData({ pageId: "page_fixture", title: "Test" })), (d) =>
    initializePage(d, BODY),
  );
  const id = orderedBlockIds(doc)[0];
  assertDiagnosisStructure(richDoc(doc.blocks[id]));
  doc = A.change(doc, (d) => initializePage(d, "Placeholder"));
  doc = A.change(doc, (d) =>
    applyPageOperation(d, {
      operation: "patch_page",
      arguments: { operations: [{ op: "replace_block_markdown", block_id: id, markdown: BODY }] },
    }),
  );
  assertDiagnosisStructure(richDoc(doc.blocks[id]));
  const projected = projectPage(doc).blocks[0].markdown;
  assert.ok(nativeDoc(projected).eq(richDoc(doc.blocks[id])));
});

// Dollar signs in prose are currency unless they delimit math: an opening `$`
// is followed by a non-space, and a closing `$` follows a non-space and is not
// followed by a digit.
for (const [label, source] of [
  ["two prices in one line", "No auto-math, so $30 and $25 stay as text."],
  ["a price range", "Budget $5-$10 per seat."],
  ["prices separated by spaces", "Between $5 and $10."],
  ["a trailing dollar sign", "It costs 30 $ or 25 $."],
]) {
  test(`currency is prose: ${label}`, () => {
    const doc = parseMarkdown(source);
    assert.deepEqual(kinds(doc), ["paragraph", "text"]);
    assert.equal(doc.textContent, source);
    assert.equal(exportMarkdown(doc), source);
  });
}

for (const source of ["The value is $x + 1$.", "$x$", "Inline $a=b$ math", "$$\nx\n$$"]) {
  test(`math source stays opaque: ${JSON.stringify(source)}`, () => {
    const doc = parseMarkdown(source);
    assert.equal(doc.firstChild.type.name, "raw");
    assert.equal(doc.firstChild.attrs.source, source);
  });
}

// CommonMark code spans: backslashes are literal, a run of N backticks closes
// only on another run of N, and one leading and trailing space is stripped
// when both are present. None of them opens a block-level fence.
for (const [label, source, code] of [
  ["backslash is literal", "Ends with `\\` here.", ["\\"]],
  ["backslash before the closing backtick", "Path `C:\\` and more `text`.", ["C:\\", "text"]],
  ["double backticks wrap a backtick span", "Typing `` `code` `` works.", ["`code`"]],
  ["double backticks without padding", "A ``x`y`` span.", ["x`y"]],
  ["trailing space is content", "Type `## ` first.", ["## "]],
  ["only-space content is kept", "A `  ` gap.", ["  "]],
  ["triple backticks inline", "Inline ```fence``` text.", ["fence"]],
  ["list markers as code", "Same for `- `, `1. `, `> `.", ["- ", "1. ", "> "]],
]) {
  test(`inline code span: ${label}`, () => {
    const doc = parseMarkdown(source);
    assert.deepEqual(
      Array.from({ length: doc.childCount }, (_, i) => doc.child(i).type.name),
      ["paragraph"],
    );
    assert.deepEqual(codeText(doc), code);
    assert.ok(parseMarkdown(exportMarkdown(doc)).eq(doc), exportMarkdown(doc));
  });
}

test("an inline code span on one line never opens a fence for later lines", () => {
  const source = "First `` ` `` line\n\n- `\\`\n- `` `code` ``\n\nLast paragraph";
  const doc = parseMarkdown(source);
  assert.deepEqual(
    Array.from({ length: doc.childCount }, (_, i) => doc.child(i).type.name),
    ["paragraph", "bullet_list", "paragraph"],
  );
  assert.deepEqual(codeText(doc), ["`", "\\", "`code`"]);
  assert.ok(parseMarkdown(exportMarkdown(doc)).eq(doc));
});
