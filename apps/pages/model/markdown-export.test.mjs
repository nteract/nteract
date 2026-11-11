import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import MarkdownIt from "markdown-it";
import fc from "fast-check";
import { build } from "esbuild";
import { commentDraftsMarkdown, pageMarkdown, unsentCommentsMarkdown } from "./markdown-export.mjs";
import { applyPageOperation, createPageData, initializePage, projectPage } from "./page.mjs";
import { nativeReadSpans, readMarkdown } from "./native-read.mjs";
import { codeTextUnmarked, readSpans } from "./richtext-format.mjs";
import { parseAgentMarkdown } from "./markdown-import.mjs";
import { pageSpans } from "./richtext-spans.mjs";
import { decode, encode } from "./wordgard-doc.mjs";
import { pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";

const page = (title, ...blocks) => ({ title, blocks: blocks.map((markdown) => ({ markdown })) });

test("whole-page Markdown includes the title and ordered blocks without rewriting their content", () => {
  const blocks = [
    "First paragraph.",
    "- [ ] Follow up\n- [x] Finished",
    "| Approach | Benefit |\n| --- | --- |\n| Shared | Realtime |",
    "```mermaid\ngraph TD\nA --> B\n```",
    "![Private image](/api/pages/page-one/assets/" + "a".repeat(64) + ")",
  ];
  assert.equal(
    pageMarkdown(page("Project plan", ...blocks)),
    `# Project plan\n\n${blocks.join("\n\n")}\n`,
  );
});

test("an existing matching leading H1 supplies the title exactly once", () => {
  for (const body of [
    "# Project plan\n\nContent",
    "# **Project plan**\n\nContent",
    "Project plan\n============\n\nContent",
  ]) {
    assert.equal(pageMarkdown(page("Project plan", body)), `${body}\n`);
  }
  assert.equal(
    pageMarkdown(page("Project plan", "# A different heading\n\nContent")),
    "# Project plan\n\n# A different heading\n\nContent\n",
  );
  assert.equal(
    pageMarkdown(page("Project plan", "## Project plan\n\nContent")),
    "# Project plan\n\n## Project plan\n\nContent\n",
  );
});

test("plain metadata titles cannot become Markdown links, formatting, or HTML", () => {
  const title = "**Plan** &amp; <img> [link](https://example.com) `code`";
  const tokens = new MarkdownIt({ html: false }).parse(pageMarkdown(page(title, "Body")), {});
  assert.equal(tokens[0].tag, "h1");
  assert.deepEqual(
    tokens[1].children.map(({ type, content }) => ({ type, content })),
    [{ type: "text", content: title }],
  );
  assert.equal(pageMarkdown(page("Multi\nline title")), "# Multi line title\n");
  assert.equal(pageMarkdown(page("")), "# Untitled\n");
  assert.throws(() => pageMarkdown(null), /No Page to copy/);
});

test("export uses live rich text and fractional block order from the Page projection", () => {
  let doc = A.from(createPageData({ pageId: "copy-fixture", title: "Before" }));
  try {
    doc = A.change(doc, (draft) => initializePage(draft, "Old content"));
    const first = projectPage(doc).blocks[0].id;
    doc = A.change(doc, (draft) =>
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: {
          operations: [
            { op: "set_title", title: "Current title" },
            { op: "replace_match", block_id: first, match_text: "Old", replacement: "Current" },
            { op: "insert_markdown", after_block_id: null, markdown: "First section" },
          ],
        },
      }),
    );
    assert.deepEqual(Object.keys(doc.blocks[first]).sort(), ["position", "richText"]);
    assert.equal(
      pageMarkdown(projectPage(doc)),
      "# Current title\n\nFirst section\n\nCurrent content\n",
    );
  } finally {
    A.free(doc);
  }
});

test("unsent comments quote their passage and list only what the saved state lacks", () => {
  const message = (id, body, createdAt, extra = {}) => ({
    id,
    body,
    createdAt,
    author: { displayName: "Ada" },
    deletedAt: null,
    ...extra,
  });
  const thread = (id, messages, selectionContext) => ({
    id,
    target: { kind: "block", blockId: "b1" },
    selectionContext,
    messages,
  });
  const saved = {
    blocks: [{ id: "b1", markdown: "Block text" }],
    comments: [thread("t1", [message("m1", "Sent", "1"), message("m2", "Before edit", "2")])],
  };
  const current = {
    ...saved,
    comments: [
      thread("t1", [
        message("m1", "Sent", "1"),
        message("m2", "After edit", "2"),
        message("m3", "Two lines\nof reply", "3"),
        message("m4", "Gone", "4", { deletedAt: "5" }),
      ]),
      thread("t2", [message("m5", "Fresh", "6")], { status: "attached", text: "picked words" }),
    ],
  };
  const section = unsentCommentsMarkdown(current, saved);
  assert.match(section, /^\n---\n\n## Unsent comments\n\nThese comments and replies never reached/);
  assert.match(
    section,
    /### On “Block text”\n\nThread t1\n\n\*\*Ada\*\* · edited · 2\n\n> After edit/,
  );
  assert.match(section, /\*\*Ada\*\* · reply · 3\n\n> Two lines\n> of reply/);
  assert.match(
    section,
    /### On “picked words”\n\nThread t2\n\n\*\*Ada\*\* · comment · 6\n\n> Fresh/,
  );
  assert.doesNotMatch(section, /> Sent|Gone/);
  assert.equal(unsentCommentsMarkdown(saved, saved), "");
  assert.match(unsentCommentsMarkdown(saved, null), /may not have reached the server[\s\S]*> Sent/);
});

test("a comment draft archived with its spans exports their formatting and images", () => {
  // As a recovery record stores them: plain JSON from the editor's encode.
  const spans = JSON.parse(
    JSON.stringify([
      { type: "text", value: "Ship ", marks: {} },
      { type: "text", value: "Friday", marks: { strong: true } },
      {
        type: "block",
        value: {
          type: "image",
          parents: ["paragraph"],
          attrs: { src: "https://example.org/chart.png", alt: "chart", title: null },
          isEmbed: true,
        },
      },
    ]),
  );
  const exported = commentDraftsMarkdown([
    { kind: "comment", body: "Ship Fridaychart", spans, quote: "plan" },
    { kind: "reply", thread_id: "t1", body: "Plain only" },
  ]);
  assert.match(exported, /Ship \*\*Friday\*\*/);
  assert.match(exported, /!\[chart\]\(https:\/\/example\.org\/chart\.png\)/);
  assert.match(exported, /Plain only/);
  // An image-only draft has no text, and is still exported.
  assert.match(
    commentDraftsMarkdown([{ kind: "comment", body: "", spans: [spans[2]] }]),
    /!\[chart\]/,
  );
});

// Frozen pre-Wordgard draft reader. Only the differential oracle materializes
// ProseMirror nodes; production draft exports must not depend on it.
function previousDraftBody(draft) {
  if (Array.isArray(draft.spans))
    try {
      const immutable = (value) =>
        typeof value === "string" ? new A.ImmutableString(value) : value;
      const spans = draft.spans.map((span) =>
        span?.type === "block"
          ? {
              ...span,
              value: {
                ...span.value,
                type: immutable(span.value?.type),
                parents: (span.value?.parents ?? []).map(immutable),
                attrs: Object.fromEntries(
                  Object.entries(span.value?.attrs ?? {}).map(([key, value]) => [
                    key,
                    immutable(value),
                  ]),
                ),
              },
            }
          : span,
      );
      return readMarkdown(nativeReadSpans(codeTextUnmarked(spans)).nodes);
    } catch {}
  return draft.body;
}

const json = (value) => JSON.parse(JSON.stringify(value));
const marker = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: { type, parents, attrs, isEmbed },
});
const textSpan = (value, marks = {}) => ({ type: "text", value, marks });
const draftFixtures = [
  ...[
    '# Heading\n\n**bold** *em* ~~strike~~ `code` [link](https://example.org "title") <mark data-color="pink">highlight</mark>',
    "```mermaid\ngraph TD\nA --> B\n```\n\n~~~js\n```\n~~~",
    "- [ ] Open\n- [x] Done\n  - Nested\n\n1. First\n2. Second",
    "> Quote\n>\n> ## Heading\n\n---\n\nAfter",
    "| Left | Right |\n| :--- | ---: |\n| **bold** | `a\\|b`<br>next |",
    'Before\\\nafter ![chart](https://example.org/image.png "chart")',
  ].map((source) => ({
    name: source.slice(0, 30),
    spans: json(pageSpans(parseAgentMarkdown(source))),
  })),
  {
    name: "foreign marks and unknown embeds",
    spans: [
      textSpan("known", { strong: true, future: { value: 1 } }),
      marker("future-inline", ["paragraph"], { payload: "kept" }, true),
    ],
  },
  {
    name: "unknown block and its text",
    spans: [marker("future-block", [], { payload: "kept" }), textSpan("inside")],
  },
  {
    name: "dataframe",
    spans: [
      marker("dataframe", [], {
        src: `/api/pages/00000000-0000-4000-8000-000000000000/assets/${"a".repeat(64)}`,
        media_type: "application/vnd.apache.parquet",
        title: "Dataset",
      }),
    ],
  },
  { name: "empty spans", spans: [] },
];

for (const { name, spans } of draftFixtures)
  test(`Wordgard draft export matches the previous reader: ${name}`, () => {
    const draft = { kind: "comment", body: "Plain fallback", spans };
    const before = json(draft);
    const expected = commentDraftsMarkdown([{ kind: "comment", body: previousDraftBody(draft) }]);
    if (name.startsWith("unknown") || name.startsWith("foreign marks")) {
      assert.ok(commentDraftsMarkdown([draft]).startsWith(expected.trimEnd()));
      assert.match(commentDraftsMarkdown([draft]), /Unsupported node: archive-spans/);
    } else assert.equal(commentDraftsMarkdown([draft]), expected);
    assert.deepEqual(draft, before, "read leaves archived spans and unknown values unchanged");
  });

test("an unreadable draft keeps its archived plain-text fallback", () => {
  const draft = {
    kind: "comment",
    body: "Plain fallback",
    spans: [{ type: "block", value: null }],
  };
  assert.match(
    commentDraftsMarkdown([draft]),
    /Plain fallback[\s\S]*Unsupported node: archive-spans[\s\S]*"value": null/,
  );
});

test("old prose text retains literal and trailing newlines without changing stored spans", () => {
  const draft = { kind: "comment", body: "one\ntwo\n", spans: [textSpan("one\ntwo\n")] };
  assert.equal(previousDraftBody(draft), "one\ntwo\n");
  assert.match(commentDraftsMarkdown([draft]), /> one\n> two\n>\n$/);
});

test("an unknown parent has an ordered visible notice and keeps its content", () => {
  const draft = {
    kind: "comment",
    body: "inside",
    spans: [marker("paragraph", ["future-wrapper"]), textSpan("inside")],
  };
  const before = json(draft);
  assert.match(previousDraftBody(draft), /Unsupported node: future-wrapper/);
  assert.match(commentDraftsMarkdown([draft]), /Unsupported node: future-wrapper[\s\S]*inside/);
  assert.deepEqual(draft, before);
});

test("malformed spans cannot discard adjacent text or asset references", () => {
  const src = `/api/pages/archive/assets/${"b".repeat(64)}`;
  const draft = {
    kind: "comment",
    body: "stale fallback",
    spans: [
      textSpan("first"),
      { type: "block", value: null },
      marker("image", ["paragraph"], { src, alt: "chart" }, true),
      textSpan("last"),
    ],
  };
  const before = json(draft);
  const result = commentDraftsMarkdown([draft]);
  assert.ok(result.indexOf("first") < result.indexOf(src));
  assert.ok(result.indexOf(src) < result.lastIndexOf("last"));
  assert.match(result, /Unsupported node/);
  assert.deepEqual(draft, before);
});

test("unknown code embeds keep an explicit notice rather than a replacement character", () => {
  const draft = {
    kind: "comment",
    body: "stale",
    spans: [
      marker("code-block", [], { params: "mermaid" }),
      textSpan("before\n"),
      marker("future-embed", ["code-block"], {}, true),
      textSpan("\nafter"),
    ],
  };
  const result = commentDraftsMarkdown([draft]);
  assert.match(result, /before[\s\S]*Unsupported node: future-embed[\s\S]*after/);
  assert.doesNotMatch(result, /\uFFFC/);
});

for (const type of ["dataframe", "heading"])
  test(`a malformed known ${type} code embed retains its exact source`, () => {
    const spans = [
      marker("code-block"),
      marker(type, ["code-block"], { src: "/asset-to-recover", payload: "preserve me" }, true),
    ];
    const draft = { kind: "comment", spans };
    const before = json(draft);
    const output = commentDraftsMarkdown([draft]);
    const tokens = new MarkdownIt().parse(output, {});
    const source = tokens.find((token) => token.type === "fence" && token.info === "json");
    assert.ok(source, output);
    assert.deepEqual(JSON.parse(source.content), spans);
    assert.ok(output.includes(`[Unsupported node: ${type}]`));
    assert.deepEqual(draft, before);
  });

test("nested unknown parents keep notices in opening order without repeating each sibling", () => {
  const draft = {
    kind: "comment",
    spans: [
      marker("paragraph", ["outer-future", "inner-future"]),
      textSpan("first"),
      marker("paragraph", ["outer-future", "inner-future"]),
      textSpan("second"),
      marker("paragraph"),
      textSpan("outside"),
    ],
  };
  const result = commentDraftsMarkdown([draft]);
  const visible = result.split("[Unsupported node: archive-spans]")[0];
  assert.match(
    visible,
    /Unsupported node: outer-future[\s\S]*Unsupported node: inner-future[\s\S]*first[\s\S]*second[\s\S]*outside/,
  );
  assert.equal((visible.match(/Unsupported node: outer-future/g) ?? []).length, 1);
});

test("an explicit unknown parent and its child share one visible notice", () => {
  const output = commentDraftsMarkdown([
    {
      kind: "comment",
      spans: [marker("future-wrapper"), marker("paragraph", ["future-wrapper"]), textSpan("child")],
    },
  ]);
  const visible = output.split("[Unsupported node: archive-spans]")[0];
  assert.equal((visible.match(/Unsupported node: future-wrapper/g) ?? []).length, 1);
  assert.match(visible, /Unsupported node: future-wrapper[\s\S]*child/);
});

test("lossy or malformed archive projection includes exact inert source JSON", () => {
  for (const spans of [
    [
      textSpan("before"),
      marker("future", [], { src: "/asset", payload: "```\nunsafe\n```" }),
      textSpan("after"),
    ],
    [marker("code-block"), marker("future", ["code-block"], { src: "/asset" }), textSpan("after")],
    [textSpan("before"), { type: "block", value: null }, textSpan("after")],
    [marker("image", [], { src: "asset" })],
    [marker("paragraph", ["table", "table-row", "table-cell", "future-parent"]), textSpan("cell")],
  ]) {
    const draft = { kind: "comment", body: "fallback", spans };
    const before = json(draft);
    const tokens = new MarkdownIt().parse(commentDraftsMarkdown([draft]), {});
    const source = tokens.find((token) => token.type === "fence" && token.info === "json");
    assert.ok(source, JSON.stringify(spans));
    assert.deepEqual(JSON.parse(source.content), spans);
    assert.deepEqual(draft, before);
  }
});

test("old marked prose newlines preserve their mark and literal text", () => {
  const draft = { kind: "comment", spans: [textSpan("one\ntwo\n", { highlight: "pink" })] };
  assert.equal(
    commentDraftsMarkdown([draft]),
    commentDraftsMarkdown([{ kind: "comment", body: previousDraftBody(draft) }]),
  );
});

test("archive spans outside the editor grammar never silently disappear", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.constant(null),
          fc.record({ type: fc.constant("future-span"), value: fc.string() }),
          fc.record({ type: fc.constant("text"), value: fc.string() }),
          fc.record({
            type: fc.constant("block"),
            value: fc.record({ type: fc.constant("future-block"), attrs: fc.jsonValue() }),
          }),
        ),
        { minLength: 1, maxLength: 12 },
      ),
      (spans) => {
        if (spans.every((span) => span?.type === "text")) return;
        const draft = { kind: "comment", body: "fallback", spans: json(spans) };
        const before = json(draft);
        const tokens = new MarkdownIt().parse(commentDraftsMarkdown([draft]), {});
        const source = tokens.find((token) => token.type === "fence" && token.info === "json");
        assert.ok(source);
        assert.deepEqual(JSON.parse(source.content), json(spans));
        assert.deepEqual(draft, before);
      },
    ),
    { seed: 4927, numRuns: 150 },
  );
});

test("concurrent text after a rule keeps both leaf and following text", () => {
  let base = A.from({ richText: "" });
  base = A.change(base, (draft) =>
    A.updateSpans(draft, ["richText"], [...pageSpans(parseAgentMarkdown("---\n\nword"))]),
  );
  const spans = readSpans(base, ["richText"]);
  const paragraph = spans.findIndex(
    (span) => span.type === "block" && String(span.value.type) === "paragraph",
  );
  const at = spans
    .slice(0, paragraph)
    .reduce((sum, span) => sum + (span.type === "text" ? span.value.length : 1), 0);
  let a = A.clone(base),
    b = A.clone(base);
  a = A.change(a, (draft) => A.splice(draft, ["richText"], at, 1));
  b = A.change(b, (draft) => A.splice(draft, ["richText"], at + 1, 0, "peer "));
  const merged = A.merge(a, b);
  const bytes = A.save(merged);
  const output = commentDraftsMarkdown([
    { kind: "comment", spans: json(readSpans(merged, ["richText"])) },
  ]);
  assert.match(output, /> ---\n>\n> peer word/);
  assert.deepEqual(A.save(merged), bytes);
  for (const doc of [base, b, merged]) A.free(doc);
});

test("independently generated editor drafts retain the previous Markdown projection", () => {
  fc.assert(
    fc.property(pageTreeArbitrary({ hostile: true }), (description) => {
      const spans = json(encode(toWordgardTree(description)));
      const draft = { kind: "comment", body: "fallback", spans };
      assert.equal(
        commentDraftsMarkdown([draft]),
        commentDraftsMarkdown([{ kind: "comment", body: previousDraftBody(draft) }]),
      );
    }),
    { seed: 4922, numRuns: 200 },
  );
});

test("the complete draft export import graph excludes ProseMirror", async () => {
  const result = await build({
    entryPoints: [new URL("./markdown-export.mjs", import.meta.url).pathname],
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
  });
  assert.ok(Object.keys(result.metafile.inputs).some((name) => name.includes("wordgard")));
  assert.deepEqual(
    Object.keys(result.metafile.inputs).filter((name) =>
      /prosemirror|pm-adapter|pm-markdown-parser/.test(name),
    ),
    [],
  );
});

test("draft export survives native save/load and concurrent edits without changing IDs or anchors", () => {
  let doc = A.from({ richText: "", metadata: { future: "kept" } });
  let left, right, merged, loaded;
  try {
    doc = A.change(doc, (draft) =>
      A.updateSpans(draft, ["richText"], pageSpans(parseAgentMarkdown("**shared** text\n\n---"))),
    );
    const objectId = A.getObjectId(doc, "richText");
    assert.equal(typeof objectId, "string");
    const anchor = A.getCursor(doc, ["richText"], 3);
    left = A.clone(doc);
    right = A.clone(doc);
    left = A.change(left, (draft) => A.splice(draft, ["richText"], 0, 0, "left "));
    right = A.change(right, (draft) => A.splice(draft, ["richText"], 8, 0, "right "));
    merged = A.merge(left, right);
    loaded = A.load(A.save(merged));
    const bytes = A.save(loaded);
    const spans = readSpans(loaded, ["richText"]);
    const draft = {
      kind: "reply",
      thread_id: "thread",
      body: "fallback",
      spans: json(spans),
      anchor,
    };
    assert.equal(
      commentDraftsMarkdown([draft]),
      commentDraftsMarkdown([{ ...draft, spans: undefined, body: previousDraftBody(draft) }]),
    );
    assert.deepEqual(
      json(encode(decode(spans).doc)),
      json(encode(decode(encode(decode(spans).doc)).doc)),
    );
    assert.deepEqual(A.save(loaded), bytes);
    assert.equal(A.getObjectId(loaded, "richText"), objectId);
    assert.equal(
      A.getCursorPosition(loaded, ["richText"], anchor),
      A.getCursorPosition(merged, ["richText"], anchor),
    );
    assert.equal(loaded.metadata.future, "kept");
  } finally {
    for (const value of [doc, right, merged, loaded]) if (value) A.free(value);
  }
});
