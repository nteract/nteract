import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { build } from "esbuild";
import * as A from "@automerge/automerge";
import { parseInlineMarkdown } from "./markdown-inline.mjs";
import { parseAgentMarkdown } from "./markdown-import.mjs";
import { encode, Paragraph } from "./wordgard-doc.mjs";
import { tokenizer } from "./markdown-tokenizer.mjs";
import { createPageData, initializePage, applyPageOperation, projectPage } from "./page.mjs";

// Test-only previous inline contract over the retained PM-returning full parser.
function previous(source) {
  const invalid = () =>
    Object.assign(Error("inline"), { code: "invalid_edit_selector", status: 400 });
  if (/[\r\n]/.test(source)) throw invalid();
  const lead = /^[ \t]*/.exec(source)[0],
    trail = /[ \t]*$/.exec(source.slice(lead.length))[0];
  const middle = source.slice(lead.length, source.length - trail.length),
    runs = lead ? [{ text: lead, marks: {} }] : [];
  if (middle) {
    const tree = parseAgentMarkdown(middle);
    if (tree.content.length !== 1 || tree.firstChild.type !== Paragraph.type) throw invalid();
    // The paragraph's own marker opens the spans; its content follows.
    for (const span of encode(tree).slice(1)) {
      if (span.type !== "text") throw invalid();
      runs.push({ text: span.value, marks: { ...span.marks } });
    }
  }
  if (trail) runs.push({ text: trail, marks: {} });
  return runs;
}
const outcome = (fn, source) => {
  try {
    return { runs: fn(source) };
  } catch (e) {
    return { code: e.code, status: e.status, details: e.details };
  }
};
const fixtures = [
  "",
  " \t ",
  "a",
  " **bold**\t",
  "[&#10;](/link)",
  "***both***",
  '**<mark data-color="pink">a** b</mark>',
  '<mark data-color="pink">a **b</mark> c**',
  "[**bold** *em*](https://example.org)",
  "`a\\b`",
  "😀 é **x**",
  "\\# text",
  "# heading",
  "> quote",
  "- item",
  "1. item",
  "---",
  "```",
  "# [](/empty)",
  "# [&#10;](/x)",
  "![x](/image)",
  "[![x](/image)](/link)",
  "**![x](/image)**",
  "<br>",
  "a  <br>b",
  "$x$",
  "<script>x</script>",
  "[x](javascript:alert(1))",
  "[](/empty)",
  '[a](https://example.org "title")',
  "[a &amp; b](/x)",
  "a\nb",
  "# <script>x</script>",
  "[x]()",
  "**`code`**",
  "&#0;",
  "a\0b",
  "*a* *b*",
  "**a****b**",
];
test("inline entities retain text newlines without accepting literal multi-line source", () => {
  assert.deepEqual(parseInlineMarkdown("a&#10;b"), [{ text: "a\nb", marks: {} }]);
  assert.throws(() => parseInlineMarkdown("a\nb"), { code: "invalid_edit_selector" });
});
for (const source of fixtures)
  test(`inline parity: ${JSON.stringify(source)}`, () =>
    assert.deepEqual(outcome(parseInlineMarkdown, source), outcome(previous, source)));

test("generated single-line Markdown retains runs and refusal priority", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...fixtures.filter((s) => !s.includes("\n"))), {
        minLength: 1,
        maxLength: 8,
      }),
      (parts) => {
        const source = parts.join(" ");
        assert.deepEqual(outcome(parseInlineMarkdown, source), outcome(previous, source));
      },
    ),
    { seed: 4936, numRuns: 500 },
  );
});
test("native inline module import graph excludes PM", async () => {
  const result = await build({
    entryPoints: [new URL("./markdown-inline.mjs", import.meta.url).pathname],
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
  });
  assert.deepEqual(
    Object.keys(result.metafile.inputs).filter((path) =>
      /prosemirror|pm-adapter|pm-markdown-parser/.test(path),
    ),
    [],
  );
});
test("native inline parsing scans source once", () => {
  const original = tokenizer.parse;
  let calls = 0;
  tokenizer.parse = function (...args) {
    calls++;
    return original.apply(this, args);
  };
  try {
    parseInlineMarkdown("[**a**](/b) and `c`");
    assert.equal(calls, 1);
  } finally {
    tokenizer.parse = original;
  }
});
test("real replacement API writes mixed marks without replacing native text object", () => {
  let doc = A.from(createPageData({ pageId: "inline-test" }));
  doc = A.change(doc, (d) => initializePage(d, "before target after"));
  const id = Object.keys(doc.blocks)[0],
    object = A.getObjectId(doc.blocks[id], "richText");
  doc = A.change(doc, (d) =>
    applyPageOperation(d, {
      operation: "patch_page",
      arguments: {
        operations: [
          {
            op: "replace_match",
            block_id: id,
            match_text: "target",
            replacement_markdown: "**bold** [link](https://example.org) 😀",
          },
        ],
      },
    }),
  );
  const loaded = A.load(A.save(doc));
  try {
    assert.equal(A.getObjectId(loaded.blocks[id], "richText"), object);
    assert.match(
      projectPage(loaded).blocks[0].markdown,
      /before \*\*bold\*\* \[link\]\(https:\/\/example.org\) 😀 after/,
    );
  } finally {
    A.free(doc);
    A.free(loaded);
  }
});
