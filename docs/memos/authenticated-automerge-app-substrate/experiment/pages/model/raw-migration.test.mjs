import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { pmNodeToSpans } from "@automerge/prosemirror";
import { applyComment, projectComments } from "./comments.mjs";
import { createPageData, initializePage, orderedBlockIds, projectPage } from "./page.mjs";
import { projectReadContent } from "./read-content.mjs";
import {
  CONVERSION_FEATURE,
  convertPreservedBlocks,
  convertedSpans,
  hasPreservedBlocks,
  preservedBlockEdits,
  preservedTextPaths,
} from "./raw-migration.mjs";
import {
  adapter,
  exportMarkdown,
  parseAgentMarkdown,
  richDoc,
  schema,
  textPath,
  validateRich,
} from "./richtext.mjs";
import {
  BUILD_FEATURES,
  documentFeatures,
  requireSupportedSchema,
  unsupportedFeatures,
} from "./schema-features.mjs";

const identity = { principal: "account:one", displayName: "One", driver: "Browser" };
const raw = (source, kind = "markdown") => schema.node("raw", { source, importId: "i", kind });
const p = (text) => schema.node("paragraph", null, text ? [schema.text(text)] : []);

// A Page whose first block holds `nodes`, as an older build wrote it.
function stored(nodes) {
  let doc = A.change(A.from(createPageData({ pageId: "page_fixture", title: "Plan" })), (draft) =>
    initializePage(draft, ""),
  );
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      pmNodeToSpans(adapter, schema.node("doc", null, nodes)),
      adapter.updateSpansConfig(),
    ),
  );
  return { doc, id };
}
function convert(doc) {
  let converted;
  const after = A.change(doc, (draft) => {
    converted = convertPreservedBlocks(draft);
  });
  return { doc: after, converted };
}
const markdownOf = (doc, id) => exportMarkdown(richDoc(doc.blocks[id]));
const names = (doc, id) => {
  const seen = [];
  richDoc(doc.blocks[id]).descendants((node) => {
    seen.push(node.type.name);
  });
  return seen;
};

// Every shape an older build could store: a whole-body block, one beside
// native content, one nested in a list or quote, several, an instruction
// block, an empty source, and sources this build imports natively, as
// literal text, or both.
const SHAPES = [
  ["the whole body", [raw("Keep ~~this~~.\n\n---\n\nDone.")], "Keep ~~this~~.\n\n---\n\nDone."],
  [
    "between native paragraphs",
    [p("Before"), raw("Middle with `~~code~~`."), p("After")],
    "Before\n\nMiddle with `~~code~~`.\n\nAfter",
  ],
  ["math stays literal", [raw("The value is $x + 1$.")], "The value is \\$x + 1\\$."],
  [
    "HTML stays literal",
    [raw("<section>Preserve *this*</section>")],
    "\\<section>Preserve *this*\\</section>",
  ],
  [
    "display math keeps its lines",
    [raw("$$\n\\frac{a}{b}\n$$")],
    "\\$\\$\\\n\\\\frac{a}{b}\\\n\\$\\$",
  ],
  [
    "a table",
    [raw("| A | B |\n| --- | --- |\n| ~~x~~ | y |")],
    "| A | B |\n| --- | --- |\n| ~~x~~ | y |",
  ],
  [
    "a reference link",
    [raw("[Guide][g]\n\n[g]: https://example.org")],
    "[Guide](https://example.org)",
  ],
  [
    "inside a list item",
    [
      schema.node("bullet_list", null, [
        schema.node("list_item", null, [p("item"), raw("~~struck~~ note")]),
      ]),
    ],
    "* item\n\n  ~~struck~~ note",
  ],
  [
    "inside a quote",
    [schema.node("blockquote", null, [raw("quoted ~~x~~\n\n---")])],
    "> quoted ~~x~~\n>\n> ---",
  ],
  ["two blocks", [raw("~~a~~"), p("mid"), raw("$b$")], "~~a~~\n\nmid\n\n\\$b\\$"],
  ["an instruction block", [raw("# not *Markdown*", "instruction")], "\\# not \\*Markdown\\*"],
  ["an empty source", [p("Kept"), raw("")], "Kept"],
  // Sources that would parse to less than they say stay literal, all of them.
  [
    "an image inside a link",
    [raw("[![caption](image.png)](https://example.org)")],
    "\\[!\\[caption\\](image.png)\\](https://example.org)",
  ],
  [
    "a row with more cells than its header",
    [raw("| A |\n| --- |\n| b | c |")],
    "| A |\\\n| --- |\\\n| b | c |",
  ],
];

for (const [label, nodes, markdown] of SHAPES) {
  test(`a preserved block converts to native content: ${label}`, () => {
    const { doc, id } = stored(nodes);
    assert.ok(hasPreservedBlocks(doc));
    const result = convert(doc);
    assert.ok(result.converted > 0);
    assert.equal(hasPreservedBlocks(result.doc), false);
    assert.ok(!names(result.doc, id).includes("raw"));
    validateRich(result.doc.blocks[id]);
    assert.equal(markdownOf(result.doc, id), markdown);
    // The projection is writable as is.
    assert.doesNotThrow(() => parseAgentMarkdown(markdownOf(result.doc, id)));
    assert.ok(documentFeatures(result.doc).includes(CONVERSION_FEATURE));
  });
}

test("conversion is idempotent: a second run finds nothing and writes nothing", () => {
  const { doc } = stored([p("Before"), raw("~~x~~ and $y$")]);
  const first = convert(doc);
  assert.equal(first.converted, 1);
  const heads = A.getHeads(first.doc);
  const second = convert(first.doc);
  assert.equal(second.converted, 0);
  assert.deepEqual(A.getHeads(second.doc), heads);
  // A Page with no preserved blocks gets no stamp either.
  const plain = convert(A.from(createPageData({ pageId: "page_fixture", title: "x" })));
  assert.equal(plain.converted, 0);
  assert.equal(plain.doc.schema, undefined);
});

test("conversion stamps the features of the content it writes, in the same change", () => {
  const { doc } = stored([raw("~~x~~\n\n---")]);
  const after = convert(doc).doc;
  const changes = A.getChanges(doc, after);
  assert.equal(changes.length, 1);
  const [applied] = A.applyChanges(A.load(A.save(doc)), changes);
  assert.deepEqual(documentFeatures(applied), ["horizontal-rule", CONVERSION_FEATURE, "strike"]);
  // A build from before the conversion, which could still write or convert
  // a preserved block, reads the Page read-only and the host refuses it.
  const older = BUILD_FEATURES.filter((id) => id !== CONVERSION_FEATURE);
  assert.deepEqual(unsupportedFeatures(applied, older), [CONVERSION_FEATURE]);
  assert.throws(() => requireSupportedSchema(applied, older), {
    code: "unsupported_schema_feature",
  });
  assert.doesNotThrow(() => requireSupportedSchema(applied));
});

test("preserved blocks in comment messages convert too", () => {
  let { doc, id } = stored([p("We ship on Friday.")]);
  doc = A.change(doc, (draft) =>
    applyComment(
      draft,
      { action: "add", block_id: id, body: "placeholder", body_format: "markdown" },
      identity,
    ),
  );
  const [threadId] = Object.keys(doc.comments);
  const [messageId] = Object.keys(doc.comments[threadId].messages);
  const path = ["comments", threadId, "messages", messageId, "richText"];
  doc = A.change(doc, (draft) =>
    A.updateSpans(
      draft,
      path,
      pmNodeToSpans(adapter, schema.node("doc", null, [raw("Drop ~~this~~ and $x$")])),
      adapter.updateSpansConfig(),
    ),
  );
  assert.deepEqual(preservedTextPaths(doc), [path]);
  const after = convert(doc).doc;
  assert.equal(hasPreservedBlocks(after), false);
  assert.equal(projectComments(after)[0].messages[0].body, "Drop ~~this~~ and \\$x\\$");
});

test("text around a converted block keeps its identity: comment anchors and cursors survive", () => {
  let { doc, id } = stored([p("Anchor here."), raw("~~old~~ text"), p("Tail words.")]);
  doc = A.change(doc, (draft) =>
    applyComment(
      draft,
      { action: "add", block_id: id, selected_text: "Tail words", body: "About the tail" },
      identity,
    ),
  );
  const cursor = A.getCursor(doc, textPath(id), doc.blocks[id].richText.indexOf("Anchor"));
  const after = convert(doc).doc;
  const text = after.blocks[id].richText;
  assert.equal(text.slice(A.getCursorPosition(after, textPath(id), cursor)).slice(0, 6), "Anchor");
  const [thread] = projectComments(after);
  assert.equal(thread.selectionContext.status, "attached");
  assert.equal(thread.selectionContext.text, "Tail words");
});

// Two peers: the host converts while a browser edits beside the block. The
// merge holds the converted content once and keeps the browser's edit.
test("a host conversion merges with a concurrent edit beside the block, without duplication", () => {
  const { doc: base, id } = stored([p("Before"), raw("~~once~~ only"), p("After")]);
  const host = convert(A.clone(base)).doc;
  const peer = A.change(A.clone(base), (draft) => {
    A.splice(draft, textPath(id), draft.blocks[id].richText.indexOf("After"), 0, "Still ");
  });
  for (const merged of [A.merge(A.clone(host), peer), A.merge(A.clone(peer), host)]) {
    const markdown = markdownOf(merged, id);
    assert.equal(markdown, "Before\n\n~~once~~ only\n\nStill After");
    assert.equal(hasPreservedBlocks(merged), false);
  }
});

// Why the host is the only writer: Automerge keeps every concurrent insert,
// so two independent conversions of the same block hold its content twice.
// The host serializes its own runs; browsers never convert; and the stamp
// refuses the older builds that could.
test("two independent conversions would duplicate content, so only the host converts", () => {
  const { doc: base, id } = stored([raw("~~twice~~")]);
  const left = convert(A.clone(base)).doc;
  const right = convert(A.clone(base)).doc;
  const merged = A.merge(A.clone(left), right);
  assert.equal(markdownOf(merged, id).split("twice").length, 3);
  // A writer that reads the document after the first conversion writes
  // nothing: the host's serialized second run.
  assert.equal(convert(left).converted, 0);
});

test("read-content, outline and export read converted blocks as native nodes", () => {
  const { doc, id } = stored([raw("# Title\n\nBody ~~x~~\n\n---\n\n$m$")]);
  // Before conversion, reads project the content the block converts to.
  const before = projectReadContent(doc, { include_content: false });
  assert.deepEqual(
    before.outline.map((entry) => entry.type),
    ["raw"],
  );
  assert.equal(projectPage(doc).blocks[0].markdown, "# Title\n\nBody ~~x~~\n\n---\n\n\\$m\\$");
  const after = convert(doc).doc;
  const read = projectReadContent(after, { include_content: false });
  assert.deepEqual(
    read.outline.map((entry) => entry.type),
    ["heading", "paragraph", "horizontal_rule", "paragraph"],
  );
  assert.equal(projectPage(after).blocks[0].markdown, projectPage(doc).blocks[0].markdown);
  assert.equal(
    projectReadContent(after, { section: "Title" }).blocks[0].markdown,
    "# Title\n\nBody ~~x~~\n\n---\n\n\\$m\\$",
  );
  assert.equal(orderedBlockIds(after)[0], id);
});

test("conversion keeps every character of a lossy source", () => {
  for (const source of [
    "[![caption](image.png)](https://example.org)",
    "| A |\n| --- |\n| b | c | d |",
    "**![c](i.png)** and [](https://x.test)",
    "Prose.\n\n[unused]: https://example.org",
  ]) {
    const { doc, id } = stored([raw(source)]);
    const tree = richDoc(convert(doc).doc.blocks[id]);
    for (const line of source.split("\n").filter(Boolean))
      assert.ok(tree.textContent.includes(line), `${source}: ${line}`);
  }
});

// A pre-cutover tab's own conversion, or its deletion of the block, is
// selected; the host's stamped conversion and unrelated edits are not.
test("preservedBlockEdits selects only unstamped edits to a preserved block", () => {
  const { doc: base, id } = stored([p("Intro"), raw("~~x~~")]);
  const since = A.getHeads(base);
  const competing = A.change(A.clone(base, { actor: "4d".repeat(16) }), (draft) => {
    const spans = A.spans(draft, textPath(id)).flatMap((span) =>
      span.type === "block" && String(span.value.type) === "pages-opaque"
        ? convertedSpans(span)
        : [span],
    );
    A.updateSpans(draft, textPath(id), spans, adapter.updateSpansConfig());
  });
  const found = preservedBlockEdits(competing, since);
  assert.deepEqual(found.baseHeads, since);
  assert.equal(found.changes.length, 1);
  // Deleting the block counts too.
  const deleted = A.change(A.clone(base, { actor: "5d".repeat(16) }), (draft) => {
    const spans = A.spans(draft, textPath(id)).filter(
      (span) => !(span.type === "block" && String(span.value.type) === "pages-opaque"),
    );
    A.updateSpans(draft, textPath(id), spans, adapter.updateSpansConfig());
  });
  assert.ok(preservedBlockEdits(deleted, since));
  // Not selected: the host's conversion, an edit elsewhere, no edit at all.
  assert.equal(preservedBlockEdits(convert(A.clone(base)).doc, since), null);
  const titled = A.change(A.clone(base), (draft) => {
    draft.title = "Renamed";
  });
  assert.equal(preservedBlockEdits(titled, since), null);
  assert.equal(preservedBlockEdits(base, since), null);
  assert.equal(preservedBlockEdits(base, []), null);
  // A later edit built on the competing conversion goes with it.
  const later = A.change(A.clone(competing), (draft) => {
    draft.title = "After";
  });
  assert.deepEqual(preservedBlockEdits(later, since).baseHeads, since);
});
