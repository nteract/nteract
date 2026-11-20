// What agents read back: the Markdown projection of native content, and the
// spans Pages' own writers store. Agents copy the projection's style, and the
// editor rewrites a block from its spans, so both must match what a person
// would write and what the editor writes.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf } from "wordgard/doc";
import markdownCorpus from "./markdown-corpus.json" with { type: "json" };
import { createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import {
  exportMarkdown,
  pageSpans,
  parseAgentMarkdown,
  parseMarkdown,
  schema,
  setRichMarkdown,
  setRichMarkdownKeepingNodes,
  textPath,
  unsupportedMarkdown,
} from "./richtext.mjs";
import {
  Blockquote,
  BulletList,
  Heading,
  ListItem,
  OrderedList,
  PagesDataframe,
  PagesImage,
  Paragraph,
  TaskChecked,
  TaskList,
  decode,
  encode,
  schema as wordgardSchema,
} from "./wordgard-doc.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { stampSpans } from "./schema-features.mjs";
import { richDoc } from "./richtext.mjs";

test("lists read back tight with - bullets, loose only when an item holds several blocks", () => {
  for (const [source, expected] of [
    ["- one\n- two", "- one\n- two"],
    ["* one\n* two", "- one\n- two"],
    ["- one\n\n- two", "- one\n- two"],
    ["1. a\n2. b\n3. c", "1. a\n2. b\n3. c"],
    ["- [ ] task\n- [x] done", "- [ ] task\n- [x] done"],
    ["- outer\n  - inner\n- next", "- outer\n  - inner\n- next"],
    ["> - a\n> - b", "> - a\n> - b"],
    ["Intro\n\n- a\n- b\n\nOutro", "Intro\n\n- a\n- b\n\nOutro"],
    // A second block in an item can only be written loose.
    ["- one\n\n  more\n- two", "- one\n\n  more\n\n- two"],
    ["- a\n\n  ```\n  code\n  ```\n- b", "- a\n\n  ```\n  code\n  ```\n\n- b"],
  ]) {
    const out = exportMarkdown(parseMarkdown(source));
    assert.equal(out, expected, source);
    // A read is stable and means the same content.
    assert.equal(exportMarkdown(parseMarkdown(out)), out, source);
    assert.ok(parseMarkdown(out).eq(parseMarkdown(source)), source);
  }
});

test("a nested list that can't interrupt a paragraph gets a blank line", () => {
  for (const source of [
    "- outer\n\n  -\n  - b",
    "1. outer\n\n   1.\n   2. b",
    "- outer\n\n  3. a\n  4. b",
  ]) {
    const out = exportMarkdown(parseMarkdown(source));
    assert.ok(parseMarkdown(out).eq(parseMarkdown(source)), `${source} -> ${out}`);
    assert.equal(exportMarkdown(parseMarkdown(out)), out, source);
  }
  // A list that can interrupt stays tight under its parent paragraph.
  assert.equal(exportMarkdown(parseMarkdown("- outer\n  - a\n  - b")), "- outer\n  - a\n  - b");
});

test("every corpus case reads back as the same tree", () => {
  for (const { id, markdown } of markdownCorpus.cases) {
    const tree = parseMarkdown(markdown);
    assert.ok(parseMarkdown(exportMarkdown(tree)).eq(tree), id);
  }
});

test("numbered lists past nine keep continuation lines inside their item", () => {
  const source = `${Array.from({ length: 10 }, (_, i) => `${i + 1}. item`).join("\n")}\n\n    tenth, continued`;
  const out = exportMarkdown(parseMarkdown(source));
  assert.ok(out.startsWith("1. item\n"));
  assert.ok(parseMarkdown(out).eq(parseMarkdown(source)));
});

// The binding's structural write: encode the decoded tree, with its config.
const rewritten = (doc, id) => {
  const path = textPath(id);
  return A.change(A.clone(doc), (draft) =>
    A.updateSpans(draft, path, encode(decode(A.spans(draft, path)).doc), updateSpansConfig),
  );
};
// Spans as plain values, for comparing writers. Adjacent text with the same
// marks is one run, as A.spans reads it back.
const plainSpans = (spans) =>
  spans.reduce((out, span) => {
    const last = out.at(-1);
    if (
      span.type === "text" &&
      last?.type === "text" &&
      JSON.stringify(last.marks) === JSON.stringify({ ...span.marks })
    )
      last.value += span.value;
    else out.push(plainSpan(span));
    return out;
  }, []);
const plainSpan = (span) =>
  span.type === "text"
    ? { type: "text", value: span.value, marks: { ...span.marks } }
    : {
        type: "block",
        value: {
          type: String(span.value.type),
          parents: span.value.parents.map(String),
          attrs: Object.fromEntries(
            Object.entries(span.value.attrs ?? {}).map(([key, value]) => [
              key,
              value instanceof A.ImmutableString ? String(value) : value,
            ]),
          ),
          isEmbed: !!span.value.isEmbed,
        },
      };
const editorRewrite = (doc, id) => {
  const after = rewritten(doc, id);
  return A.diff(after, A.getHeads(doc), A.getHeads(after));
};

// A rewrite with unchanged spans writes nothing, so it can't win over a
// peer's concurrent change to a mark that covers more than one span.
test("a rewrite with unchanged spans keeps a peer's concurrent unmark of a multi-span mark", () => {
  const path = ["t"];
  let base = A.from({ t: "" });
  base = A.change(base, (draft) =>
    A.updateSpans(
      draft,
      path,
      [
        { type: "text", value: "ab", marks: { strong: true } },
        { type: "text", value: "cd", marks: { strong: true, em: true } },
      ],
      updateSpansConfig,
    ),
  );
  const peer = A.change(A.clone(base, { actor: "bb" }), (draft) =>
    A.unmark(draft, path, { start: 0, end: 2, expand: "both" }, "strong"),
  );
  const rewrite = A.change(A.clone(base, { actor: "aa" }), (draft) =>
    A.updateSpans(draft, path, A.spans(draft, path), updateSpansConfig),
  );
  assert.deepEqual(A.getHeads(rewrite), A.getHeads(base));
  const merged = A.merge(A.clone(rewrite), peer);
  assert.deepEqual(A.spans(merged, path)[0], { type: "text", value: "ab" });
});

test("an editor rewrite of any block Pages wrote from Markdown writes nothing", () => {
  for (const { id: caseId, markdown } of markdownCorpus.cases) {
    // Agent writes, for the Markdown they accept, and literal imports of
    // stored source, for all of it.
    const writes = unsupportedMarkdown(markdown) ? [true] : [false, true];
    for (const literal of writes) {
      let doc = A.change(
        A.from(createPageData({ pageId: "projection", title: "Projection" })),
        (draft) => initializePage(draft),
      );
      const id = orderedBlockIds(doc)[0];
      try {
        doc = A.change(doc, (draft) => setRichMarkdown(draft, id, markdown, { literal }));
      } catch (error) {
        // Source the writer refuses as lossy writes nothing to compare.
        assert.match(error.message, /content missing/, caseId);
        continue;
      }
      const patches = editorRewrite(doc, id);
      assert.deepEqual(patches, [], `${literal ? "literal" : "agent"} ${caseId}`);
    }
  }
  // create_page goes through the same writer.
  let doc = A.from(createPageData({ pageId: "projection", title: "Projection" }));
  doc = A.change(doc, (draft) => initializePage(draft, "Intro\n\n- a\n- b"));
  assert.deepEqual(editorRewrite(doc, orderedBlockIds(doc)[0]), []);
});

test("nested-only sibling items keep separate outer markers through the shared encoder", () => {
  const tree = parseAgentMarkdown("-\n  - a\n-\n  - b");
  const expected = [
    {
      type: "block",
      value: { type: "unordered-list-item", parents: [], attrs: {}, isEmbed: false },
    },
    {
      type: "block",
      value: {
        type: "unordered-list-item",
        parents: ["unordered-list-item"],
        attrs: {},
        isEmbed: false,
      },
    },
    {
      type: "block",
      value: {
        type: "paragraph",
        parents: ["unordered-list-item", "unordered-list-item"],
        attrs: {},
        isEmbed: false,
      },
    },
    { type: "text", value: "a", marks: {} },
    {
      type: "block",
      value: { type: "unordered-list-item", parents: [], attrs: {}, isEmbed: false },
    },
    {
      type: "block",
      value: {
        type: "unordered-list-item",
        parents: ["unordered-list-item"],
        attrs: {},
        isEmbed: false,
      },
    },
    {
      type: "block",
      value: {
        type: "paragraph",
        parents: ["unordered-list-item", "unordered-list-item"],
        attrs: {},
        isEmbed: false,
      },
    },
    { type: "text", value: "b", marks: {} },
  ];
  assert.deepEqual(plainSpans(pageSpans(tree)), expected);
});

test("an agent that writes back what it read writes nothing", () => {
  for (const { id: caseId, markdown } of markdownCorpus.cases)
    for (const literal of unsupportedMarkdown(markdown) ? [true] : [false, true]) {
      let doc = A.change(
        A.from(createPageData({ pageId: "projection", title: "Projection" })),
        (draft) => initializePage(draft),
      );
      const id = orderedBlockIds(doc)[0];
      try {
        doc = A.change(doc, (draft) => setRichMarkdown(draft, id, markdown, { literal }));
      } catch {
        continue;
      }
      const read = exportMarkdown(richDoc(doc.blocks[id]));
      const after = A.change(A.clone(doc), (draft) => setRichMarkdownKeepingNodes(draft, id, read));
      assert.deepEqual(
        A.getHeads(after),
        A.getHeads(doc),
        `${literal ? "literal" : "agent"} ${caseId}`,
      );
      assert.deepEqual(A.save(after), A.save(doc), caseId);
    }
});

test("the no-op guard applies intended formatting changes and preserves strict source errors", () => {
  let doc = A.change(
    A.from(createPageData({ pageId: "projection", title: "Projection" })),
    (draft) => initializePage(draft),
  );
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) => setRichMarkdown(draft, id, "**ab*cd***"));
  const changed = A.change(A.clone(doc), (draft) =>
    setRichMarkdownKeepingNodes(draft, id, "ab*cd*"),
  );
  assert.notDeepEqual(A.getHeads(changed), A.getHeads(doc));
  assert.equal(exportMarkdown(richDoc(changed.blocks[id])), "ab*cd*");
  assert.deepEqual(A.spans(changed, textPath(id))[1], { type: "text", value: "ab" });
  for (const invalid of ["<script>bad</script>", "$x$"])
    assert.throws(
      () => A.change(A.clone(doc), (draft) => setRichMarkdownKeepingNodes(draft, id, invalid)),
      { code: "unsupported_markdown" },
    );
});

test("restored rich-only metadata is checked before identical Markdown can be a no-op", () => {
  const pageId = "55555555-5555-4555-8555-555555555555";
  const src = `/api/pages/${pageId}/assets/${"b".repeat(64)}`;
  let doc = A.change(A.from(createPageData({ pageId, title: "Projection" })), (draft) =>
    initializePage(draft),
  );
  const id = orderedBlockIds(doc)[0];
  const spans = encode(
    wordgardSchema.doc([
      Paragraph.create([
        PagesImage.of({ src: "/light.png", dark_src: "/dark.png", alt: "Image", title: null }),
      ]),
      PagesDataframe.of({ src, media_type: "application/vnd.apache.parquet", future: "kept" }),
    ]),
  );
  doc = A.change(doc, (draft) => {
    A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  const markdown = exportMarkdown(richDoc(doc.blocks[id]));
  const after = A.change(A.clone(doc), (draft) => setRichMarkdownKeepingNodes(draft, id, markdown));
  assert.deepEqual(A.getHeads(after), A.getHeads(doc));
  assert.deepEqual(A.save(after), A.save(doc));
  const malformed = A.change(A.clone(doc), (draft) => {
    const next = A.spans(draft, textPath(id));
    next.find((span) => String(span.value?.type) === "dataframe").value.attrs.future = {
      nested: true,
    };
    A.updateSpans(draft, textPath(id), next, updateSpansConfig);
  });
  assert.throws(
    () => A.change(A.clone(malformed), (draft) => setRichMarkdownKeepingNodes(draft, id, markdown)),
    { code: "markdownless_node" },
  );
});

test("a lossy Markdown mark boundary is not mistaken for an unchanged stored target", () => {
  const spans = [
    {
      type: "text",
      value: "a",
      marks: { strong: true, link: JSON.stringify({ href: "https://example.org/a", title: null }) },
    },
    { type: "text", value: " a", marks: { strong: true } },
  ];
  let doc = A.change(
    A.from(createPageData({ pageId: "projection", title: "Projection" })),
    (draft) => initializePage(draft),
  );
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) => A.updateSpans(draft, textPath(id), spans, updateSpansConfig));
  const markdown = exportMarkdown(richDoc(doc.blocks[id]));
  const target = plainSpans(pageSpans(parseAgentMarkdown(markdown)));
  assert.notDeepEqual(target, plainSpans(A.spans(doc, textPath(id))));
  const after = A.change(A.clone(doc), (draft) => setRichMarkdownKeepingNodes(draft, id, markdown));
  assert.notDeepEqual(A.getHeads(after), A.getHeads(doc));
  assert.deepEqual(plainSpans(A.spans(after, textPath(id))), target);
});

// A block's content as an agent reads it, from its stored spans.
const storedRead = (spans) => {
  let doc = A.change(
    A.from(createPageData({ pageId: "projection", title: "Projection" })),
    (draft) => initializePage(draft),
  );
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) => A.updateSpans(draft, textPath(id), spans, updateSpansConfig));
  return exportMarkdown(richDoc(doc.blocks[id]));
};

test("block-first tasks keep quote delimiters on their blank lines", () => {
  for (const checked of [false, true]) {
    for (const depth of [1, 2]) {
      let quote = Blockquote.create([
        TaskList.create([
          ListItem.withMarks([TaskChecked.of(checked)]).create([
            Heading.of(1).create([Leaf.text("a")]),
          ]),
        ]),
        Paragraph.create([Leaf.text("a")]),
      ]);
      for (let level = 1; level < depth; level++) quote = Blockquote.create([quote]);
      const tree = wordgardSchema.doc([quote]);
      const markdown = storedRead(encode(tree));
      assert.deepEqual(
        decode(pageSpans(parseAgentMarkdown(markdown))).doc.toJSON(),
        tree.toJSON(),
        markdown,
      );
      assert.equal(storedRead(pageSpans(parseAgentMarkdown(markdown))), markdown);
    }
  }
});

test("a dataframe stays a standalone link before a nested block-first list", () => {
  const pageId = "55555555-5555-4555-8555-555555555555";
  const src = `/api/pages/${pageId}/assets/${"b".repeat(64)}`;
  for (const list of [BulletList, OrderedList.of(1)]) {
    const tree = wordgardSchema.doc([
      TaskList.create([
        ListItem.withMarks([TaskChecked.of(false)]).create([
          PagesDataframe.of({ src, media_type: "application/vnd.apache.parquet" }),
          list.create([ListItem.create([Heading.of(1).create([Leaf.text("a")])])]),
        ]),
      ]),
    ]);
    let doc = A.change(A.from(createPageData({ pageId, title: "Projection" })), (draft) =>
      initializePage(draft),
    );
    const id = orderedBlockIds(doc)[0];
    const spans = encode(tree);
    doc = A.change(doc, (draft) => {
      A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
      stampSpans(draft, spans);
    });
    const markdown = exportMarkdown(richDoc(doc.blocks[id]));
    const after = A.change(A.clone(doc), (draft) =>
      setRichMarkdownKeepingNodes(draft, id, markdown),
    );
    assert.deepEqual(decode(A.spans(after, textPath(id))).doc.toJSON(), tree.toJSON(), markdown);
    assert.deepEqual(A.getHeads(after), A.getHeads(doc), markdown);
  }
});

test("the native encoder is stable for every corpus case", () => {
  for (const { id: caseId, markdown } of markdownCorpus.cases)
    for (const literal of unsupportedMarkdown(markdown) ? [true] : [false, true]) {
      let tree;
      try {
        tree = literal ? parseMarkdown(markdown) : parseAgentMarkdown(markdown);
      } catch {
        continue;
      }
      const spans = pageSpans(tree);
      // Encoding the stored spans again writes them unchanged.
      assert.deepEqual(plainSpans(encode(decode(spans).doc)), plainSpans(spans), caseId);
    }
});

test("a newline in a paragraph is stored as the hard break the editor writes", () => {
  const spans = pageSpans(parseAgentMarkdown("a&#10;b"));
  assert.deepEqual(
    plainSpans(spans).map((span) => (span.type === "text" ? span.value : span.value.type)),
    ["paragraph", "a", "hard-break", "b"],
  );
  // It reads back as a hard break, so a read written back keeps it.
  assert.equal(storedRead(spans), "a\\\nb");
});

test("a tree the editor can't hold whole is refused, not stored", () => {
  assert.throws(() =>
    pageSpans(
      schema.doc([
        Paragraph.create([PagesImage.of({ src: "/a.png", alt: { nested: true }, title: null })]),
      ]),
    ),
  );
});
