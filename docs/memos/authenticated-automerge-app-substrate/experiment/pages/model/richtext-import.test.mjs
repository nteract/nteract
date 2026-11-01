import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { pmDocFromSpans, pmNodeToSpans } from "@automerge/prosemirror";
import {
  MATH_SYNTAX,
  adapter,
  exportMarkdown,
  parseAgentMarkdown,
  parseMarkdown,
  richDoc,
  unsupportedMarkdown,
} from "./richtext.mjs";
import { comment } from "./comments-test-support.mjs";
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
  const page = A.from({
    page_id: "comments",
    title: "Test",
    blocks: { one: { markdown: "A passage", position: "a0" } },
  });
  const { comments, result: ids } = comment(
    page,
    A.from({ threads: {} }),
    {
      action: "add",
      block_id: "one",
      selected_text: "passage",
      body: BODY,
      body_format: "markdown",
    },
    { principal: "fixture", displayName: "Agent", driver: "MCP" },
  );
  const message = comments.threads[ids.thread_id].messages[ids.message_id];
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
// followed by a digit. Spaces are ASCII whitespace only; see parseMarkdown.
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

// Math is found: an agent write naming it is refused, and a literal import
// keeps it as text whose export an agent may write back unchanged.
function assertLiteralMath(source) {
  assert.equal(unsupportedMarkdown(source)?.construct, "math");
  assert.throws(() => parseAgentMarkdown(source), { code: "unsupported_markdown" });
  const doc = parseMarkdown(source);
  doc.descendants((node) => assert.notEqual(node.type.name, "raw"));
  for (const part of source.split(/\r\n?|\n/)) assert.ok(doc.textContent.includes(part.trim()));
  const exported = exportMarkdown(doc);
  assert.equal(unsupportedMarkdown(exported), null, exported);
  assert.ok(parseAgentMarkdown(exported).eq(doc), exported);
}

for (const source of [
  "The value is $x + 1$.",
  "$x$",
  "Inline $a=b$ math",
  "$$\nx\n$$",
  // A `$$` pair anywhere on a line is display math, with or without spaces.
  "Before $$ \\{x\\} $$ after.",
  "Inline $$x$$ math.",
  "Escapes $$\\frac{a}{b} \\_ \\{x\\}$$ stay.",
  "$$ \\{x\\} $$",
  "$5 and $$x$$",
  "Costs $5 and $$ x $$ later.",
  // A `$$` at a line start opens display math. A line starts at the start of
  // input or after LF, CR, CRLF, U+2028 or U+2029.
  "Before\n$$\n\\{x\\}",
  "Before\r$$\n\\{x\\}",
  "Before\r\n$$\r\n\\{x\\}",
  "Before\r \t$$\n\\{x\\}",
  "Before\r\r\v\f$$\r\\{x\\}",
  "Before\u2028$$\n\\{x\\}",
  "Before\u2029$$\n\\{x\\}",
  "Before\u2028 \u00a0$$\n\\{x\\}",
  // Only ASCII whitespace disqualifies a delimiter. Other spaces are content.
  "$\u0085x$",
  "$\ufeffx$",
  "$\u00a0x$",
  "$\u2028x$",
  "$x\u00a0$",
]) {
  test(`math is found and stays literal text: ${JSON.stringify(source)}`, () => {
    assertLiteralMath(source);
  });
}

// Before a line-start `$$`, any character either codec's `\s` matches is a
// space, except CR and LF. Each of these lines opens display math.
for (const space of [
  "\u00a0",
  "\u0085",
  "\u1680",
  "\u2000",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
  " \t\v\f\u00a0\ufeff",
]) {
  // A space and a tab at the start of a block indent four columns, which
  // makes an indented code block; only the continuation line is prose there.
  const sources = space.startsWith(" \t")
    ? [`Before\r${space}$$\n\\{x\\}`]
    : [`${space}$$\n\\{x\\}`, `Before\r${space}$$\n\\{x\\}`];
  for (const source of sources) {
    test(`a Unicode space before $$ opens display math: ${JSON.stringify(source)}`, () => {
      assertLiteralMath(source);
    });
  }
}

test("other characters before $$ do not open display math", () => {
  for (const source of ["\u200b$$\n\\{x\\}", "x$$\n\\{x\\}", "\u00ad$$\n\\{x\\}"])
    assert.equal(parseMarkdown(source).firstChild.type.name, "paragraph", JSON.stringify(source));
});

// The pattern has no flags: it writes its own line starts, so a multiline `^`
// would overlap them, and its BMP `\uXXXX` escapes need no `u` flag.
test("the math pattern has no JS flags", () => {
  assert.equal(MATH_SYNTAX.flags, "");
});

// The math gate runs on every agent write. Unclosed delimiters followed by
// long runs of spaces and dollars must not backtrack quadratically.
test("the math gate stays linear on unclosed delimiters", () => {
  const sources = [
    `$a${" a".repeat(100000)} `,
    `$$${" a $".repeat(100000)}`,
    "$ ".repeat(100000),
    `$a${" ".repeat(200000)}$`,
  ];
  const started = performance.now();
  for (const source of sources) parseMarkdown(source);
  assert.ok(performance.now() - started < 5000, "200 KB of delimiters parses within 5 s");
});

test("the math pattern stays linear on runs of line breaks and spaces", () => {
  const sources = [
    "\r".repeat(200000),
    "\n".repeat(200000),
    `${"\r\n \t\v\f".repeat(40000)}x`,
    `$a${" \r".repeat(100000)}`,
    `$$${"\r$".repeat(100000)}`,
    `${"\r\u00a0\ufeff\u3000".repeat(50000)}x`,
    `${"\n\u2028".repeat(100000)}x`,
    `${"\u2029 \u3000".repeat(70000)}x`,
  ];
  const started = performance.now();
  for (const source of sources) MATH_SYNTAX.test(source);
  assert.ok(performance.now() - started < 1000, "200 KB of line breaks scans within 1 s");
});

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
