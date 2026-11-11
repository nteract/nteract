import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import { projectReadContent } from "./read-content.mjs";
import { blockAddress } from "./addresses.mjs";
import { blockMarkdown } from "./richtext-page.mjs";
import { nativeRead, readMarkdown, readKind, readText } from "./native-read.mjs";
import fc from "fast-check";
import { pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";
import {
  encode,
  Strong,
  Emphasis,
  Strikethrough,
  Code,
  PagesLink,
  PagesHighlight,
  TaskChecked,
  CodeBlockLanguage,
  Alignment,
} from "./wordgard-doc.mjs";
import { projectReadChanges } from "./read-changes.mjs";
import { build } from "esbuild";
import { validateRich } from "./richtext-spans.mjs";
import { setNode } from "./set-node.mjs";

const block = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: {
    type: new A.ImmutableString(type),
    parents: parents.map((p) => new A.ImmutableString(p)),
    attrs,
    isEmbed,
  },
});

test("native read matches supported independently generated stored trees", () => {
  fc.assert(
    fc.property(pageTreeArbitrary({ hostile: true }), (description) => {
      const doc = page(encode(toWordgardTree(description)));
      try {
        const expected = [],
          actual = [];
        const pushText = (out, value, marks) => {
          for (const character of value) out.push({ text: character, marks });
        };
        const input = (node) => {
          if (node.kind === "text") pushText(expected, node.value, node.marks);
          else if (node.kind === "break") pushText(expected, "\n", {});
          else if (node.kind === "image" || node.kind === "dataframe")
            expected.push({ kind: node.kind, attrs: node.attrs });
          else {
            if (node.kind === "heading") expected.push({ kind: "heading", level: node.level });
            if (node.kind === "code")
              expected.push({ kind: "code-block", language: node.language ?? "" });
            if (node.kind === "item" && node.checked !== undefined)
              expected.push({ kind: "task", checked: node.checked });
            if (["cell", "header"].includes(node.kind))
              expected.push({
                kind: node.kind === "cell" ? "table-cell" : "table-header",
                align: node.align,
              });
            if (node.kind === "rule") expected.push({ kind: "horizontal-rule" });
            node.children?.forEach(input);
          }
        };
        const output = (node) => {
          const kind = readKind(node);
          if (node.isText) {
            const marks = {};
            for (const [name, type] of [
              ["strong", Strong.type],
              ["em", Emphasis.type],
              ["strike", Strikethrough.type],
              ["code", Code.type],
            ])
              if (node.marks.some((mark) => mark.type === type)) marks[name] = true;
            const link = node.mark(PagesLink),
              highlight = node.mark(PagesHighlight);
            if (link) marks.link = { href: link.href, title: link.title || null };
            if (highlight) marks.highlight = highlight;
            pushText(actual, node.param, marks);
          } else if (kind === "hard-break") pushText(actual, "\n", {});
          else if (kind === "image" || kind === "dataframe") {
            const attrs = { ...node.param };
            if (kind === "image") attrs.title ??= null;
            actual.push({ kind, attrs });
          } else {
            if (kind === "heading") actual.push({ kind, level: node.tag.param });
            if (kind === "code-block")
              actual.push({ kind, language: node.mark(CodeBlockLanguage) ?? "" });
            if (kind === "list-item" && node.mark(TaskChecked) !== undefined)
              actual.push({ kind: "task", checked: node.mark(TaskChecked) });
            if (["table-cell", "table-header"].includes(kind))
              actual.push({ kind, align: node.mark(Alignment) ?? null });
            if (kind === "horizontal-rule") actual.push({ kind });
            node.content?.forEach(output);
          }
        };
        input(description);
        // Generated asset references belong to this page, not the hand-written
        // fixtures' pageId. Foreign-page notice behavior is tested separately.
        nativeRead(doc.blocks.one, "55555555-5555-4555-8555-555555555555").nodes.forEach(output);
        assert.deepEqual(actual, expected);
      } finally {
        A.free(doc);
      }
    }),
    { seed: 4932, numRuns: 150 },
  );
});
const text = (value, marks = {}) => ({ type: "text", value, marks });
const pageId = "00000000-0000-4000-8000-000000000001";

// A link value this build can't read is a mark it doesn't know: plain text,
// as the editor draws it.
test("rereview: malformed and incomplete legacy links read as plain text", () => {
  for (const [link, expected] of [
    ["https://example.org", "a"],
    ["null", "a"],
    ["{}", "a"],
    ['""', "a"],
    [JSON.stringify({ href: null }), "a"],
    [JSON.stringify({ title: "tip" }), "a"],
    [JSON.stringify({ href: "javascript:alert(1)" }), "a"],
    [7, "a"],
  ]) {
    const doc = page([text("a", { link })]);
    try {
      assert.equal(readMarkdown(nativeRead(doc.blocks.one, pageId).nodes), expected);
      assert.equal(projectReadContent(doc).blocks[0].markdown, expected);
      assert.equal(blockMarkdown(doc.blocks.one, pageId), expected);
      assert.doesNotThrow(() => projectReadContent(doc, { include_content: false }));
    } finally {
      A.free(doc);
    }
  }
});

test("rereview: inherited property names are private foreign marks", () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const marks = JSON.parse(`{"${name}":"private"}`);
    const doc = page([text("a", marks)]);
    try {
      const bytes = A.save(doc),
        spans = A.spans(doc.blocks.one, ["richText"]);
      assert.ok(
        A.marks(doc.blocks.one, ["richText"]).some((mark) => mark.name === name),
        "native mark exists",
      );
      assert.equal(Object.hasOwn(spans[0].marks, name), name !== "__proto__");
      assert.equal(readMarkdown(nativeRead(doc.blocks.one, pageId).nodes), "a");
      const result = projectReadContent(doc);
      assert.equal(result.blocks[0].markdown, "a");
      assert.ok(!JSON.stringify(result).includes("private"));
      assert.deepEqual(A.save(doc), bytes);
      assert.equal(Object.prototype.private, undefined);
    } finally {
      A.free(doc);
    }
  }
});

test("rereview: raw false, zero and empty cell alignment read as notices in every reader", () => {
  for (const align of [false, 0, ""]) {
    const before = page([block("table-cell", ["table", "table-row"], { align }), text("x")]);
    const after = A.change(A.clone(before), (d) =>
      A.splice(d, ["blocks", "one", "richText"], 2, 0, "y"),
    );
    try {
      const bytes = A.save(after);
      assert.throws(() => validateRich(before.blocks.one));
      const result = projectReadContent(after);
      // An alignment this build doesn't write reads as a notice.
      assert.ok(
        result.outline.some((entry) => entry.type === "unknown"),
        String(align),
      );
      assert.equal(
        result.blocks[0].markdown,
        readMarkdown(nativeRead(after.blocks.one, pageId).nodes),
      );
      const delta = projectReadChanges(after, {
        since_heads: A.getHeads(before),
        comments: "none",
      });
      // Every reader draws the cell as a notice, so the change is scoped to
      // the node that holds it.
      assert.equal(delta.changes[0].scope, "node");
      assert.deepEqual(A.save(after), bytes);
    } finally {
      A.free(before);
      A.free(after);
    }
  }
});

const legacyLinks = [
  "https://example.org",
  "null",
  "{}",
  '""',
  "[]",
  "0",
  "false",
  "true",
  "1",
  '"text"',
  ...[null, false, 0, "", 1, true, [], {}, "https://example.org"].map((href) =>
    JSON.stringify({ href }),
  ),
  ...[null, false, 0, "tip", 1, [], {}].map((title) => JSON.stringify({ title })),
];
test("rereview: 54-case stored scalar and legacy corpus matches the actual old projection", () => {
  const cases = [
    ...legacyLinks.map((link) => [text("a", { link })]),
    ...["strong", "em", "strike", "code", "highlight"].flatMap((name) =>
      [false, 0, "invalid"].map((value) => [text("a", { [name]: value })]),
    ),
    ...[0, false, null].flatMap((value) => [
      [block("heading", [], { level: value }), text("a")],
      [block("code-block", [], { params: value }), text("a")],
    ]),
    ...["constructor", "toString", "__proto__", "hasOwnProperty"].map((name) => [
      text("a", JSON.parse(`{"${name}":"private"}`)),
    ]),
    ...[false, 0, ""].map((align) => [
      block("table-cell", ["table", "table-row"], { align }),
      text("a"),
    ]),
  ];
  assert.equal(cases.length, 54);
  for (const spans of cases) {
    const doc = page(spans);
    try {
      const bytes = A.save(doc);
      let expected,
        refusal = false;
      try {
        expected = readMarkdown(nativeRead(doc.blocks.one, pageId).nodes);
      } catch {
        refusal = true;
      }
      if (refusal) assert.throws(() => projectReadContent(doc));
      else {
        const current = projectReadContent(doc);
        assert.equal(current.blocks[0].markdown, expected);
        assert.equal(namedBlockMarkdown(doc), expected);
      }
      assert.deepEqual(A.save(doc), bytes);
    } finally {
      A.free(doc);
    }
  }
});

test("rereview: arbitrary bounded JSON link values follow base fallback and refusal semantics", () => {
  fc.assert(
    fc.property(fc.jsonValue({ maxDepth: 2 }), (value) => {
      const doc = page([text("a", { link: JSON.stringify(value) })]);
      try {
        let expected,
          refusal = false;
        try {
          expected = readMarkdown(nativeRead(doc.blocks.one, pageId).nodes);
        } catch {
          refusal = true;
        }
        if (refusal) assert.throws(() => projectReadContent(doc));
        else assert.equal(projectReadContent(doc).blocks[0].markdown, expected);
      } finally {
        A.free(doc);
      }
    }),
    { seed: 4934, numRuns: 100 },
  );
});

test("review: joined table row/cell remains readable without changing native content", () => {
  let doc = page([
    block("table"),
    block("table-row", ["table"]),
    block("table-cell", ["table", "table-row"]),
    text("x"),
  ]);
  doc = A.change(doc, (draft) => {
    A.joinBlock(draft, ["blocks", "one", "richText"], 2);
    A.joinBlock(draft, ["blocks", "one", "richText"], 1);
  });
  const empty = page([block("table")]);
  try {
    validateRich(doc.blocks.one);
    const bytes = A.save(doc);
    assert.equal(projectReadContent(doc).blocks[0].markdown, "| x |\n| --- |");
    assert.equal(projectReadContent(empty).outline[0].summary.columns, 1);
    assert.deepEqual(A.save(doc), bytes);
  } finally {
    A.free(doc);
    A.free(empty);
  }
});

test("review: unknown first children compose inside quotes and lists", () => {
  for (const parent of ["blockquote", "unordered-list-item"]) {
    const doc = page([block(parent), block("future", [parent]), text("inside")]);
    try {
      const expected =
        parent === "blockquote"
          ? "> \\[Unsupported node: future\\]\n>\n> inside"
          : "- \n  \\[Unsupported node: future\\]\n\n  inside";
      assert.equal(projectReadContent(doc).blocks[0].markdown, expected);
      assert.equal(blockMarkdown(doc.blocks.one, pageId), expected);
    } finally {
      A.free(doc);
    }
  }
});

test("malformed native frames expose explicit notices while retaining surrounding text", () => {
  for (const [spans, expected] of [
    [
      [text("before"), block("future"), text("after")],
      "before\n\n\\[Unsupported node: future\\]\n\nafter",
    ],
    [
      [text("before"), block("future", [], {}, true), text("after")],
      "before\\[Unsupported node: future\\]after",
    ],
    [[block("table"), text("before after")], "| before after |\n| --- |"],
    [
      [block("dataframe", [], { src: new A.ImmutableString("/unavailable") })],
      "\\[Unsupported node: dataframe\\]",
    ],
  ]) {
    const doc = page(spans);
    try {
      const before = A.save(doc),
        heads = A.getHeads(doc);
      assert.equal(readMarkdown(nativeRead(doc.blocks.one, pageId).nodes), expected);
      assert.equal(projectReadContent(doc).blocks[0].markdown, expected);
      assert.deepEqual(A.save(doc), before);
      assert.deepEqual(A.getHeads(doc), heads);
    } finally {
      A.free(doc);
    }
  }
});

test("review: legacy link extras read as plain text and remain invalid for admission", () => {
  const doc = page([
    text("a", { link: JSON.stringify({ href: "https://example.org", future: "private" }) }),
  ]);
  try {
    assert.throws(() => validateRich(doc.blocks.one));
    const result = projectReadContent(doc);
    assert.equal(result.blocks[0].markdown, "a");
    assert.ok(!JSON.stringify(result).includes("private"));
  } finally {
    A.free(doc);
  }
});

test("review: setting existing code language default is a budget-safe empty delta", () => {
  const before = page([block("code-block"), text("x".repeat(5000))]);
  const after = A.change(A.clone(before), (draft) =>
    setNode(draft, "one", { match_text: "x".repeat(5000), attrs: { language: "" } }),
  );
  try {
    assert.equal(
      projectReadContent(after).outline[0].node_id,
      projectReadContent(before).outline[0].node_id,
    );
    assert.deepEqual(
      projectReadChanges(after, {
        since_heads: A.getHeads(before),
        comments: "none",
        max_bytes: 4096,
      }).changes,
      [],
    );
  } finally {
    A.free(before);
    A.free(after);
  }
});

test("review: hard-break private attrs change fingerprints without leaking values", () => {
  const spans = [
    block("paragraph"),
    text("a"),
    block("hard-break", ["paragraph"], {}, true),
    text("b"),
  ];
  const before = page(spans);
  const after = A.change(A.clone(before), (draft) =>
    A.updateSpans(
      draft,
      ["blocks", "one", "richText"],
      spans.map((span, i) =>
        i === 2
          ? block("hard-break", ["paragraph"], { future: new A.ImmutableString("private") }, true)
          : span,
      ),
    ),
  );
  try {
    const delta = projectReadChanges(after, { since_heads: A.getHeads(before), comments: "none" });
    assert.equal(delta.changes.length, 1);
    assert.equal(delta.changes[0].change, "updated");
    assert.equal(delta.changes[0].markdown, "a\\\nb");
    assert.ok(!JSON.stringify(delta).includes("private"));
  } finally {
    A.free(before);
    A.free(after);
  }
});

test("review: recognized defaults normalize without suppressing private hard-break changes in code", () => {
  for (const [spans, index, attrs] of [
    [[block("heading"), text("title")], 0, { level: 1 }],
    [[block("table-cell", ["table", "table-row"]), text("cell")], 0, { align: null }],
    [
      [block("code-block"), text("a"), block("hard-break", ["code-block"], {}, true), text("b")],
      2,
      { future: "private" },
    ],
  ]) {
    const before = page(spans);
    const after = A.change(A.clone(before), (draft) =>
      A.updateSpans(
        draft,
        ["blocks", "one", "richText"],
        spans.map((span, i) => (i === index ? { ...span, value: { ...span.value, attrs } } : span)),
      ),
    );
    try {
      const oldRead = projectReadContent(before),
        newRead = projectReadContent(after);
      assert.deepEqual(newRead.outline, oldRead.outline);
      assert.equal(newRead.blocks[0].markdown, oldRead.blocks[0].markdown);
      assert.deepEqual(
        projectReadChanges(after, {
          since_heads: A.getHeads(before),
          comments: "none",
          max_bytes: 4096,
        }).changes,
        [],
      );
    } finally {
      A.free(before);
      A.free(after);
    }
  }
});

test("review: legacy scalar marks and attrs retain base read behavior", () => {
  const fixtures = [
    ...["strong", "em", "strike", "code", "highlight"].flatMap((name) =>
      [false, 0, "invalid"].map((value) => [text("a", { [name]: value })]),
    ),
    ...[0, false, null].flatMap((value) => [
      [block("heading", [], { level: value }), text("a")],
      [block("code-block", [], { params: value }), text("a")],
    ]),
  ];
  for (const spans of fixtures) {
    const doc = page(spans);
    try {
      const bytes = A.save(doc),
        result = projectReadContent(doc);
      assert.equal(
        result.blocks[0].markdown,
        readMarkdown(nativeRead(doc.blocks.one, pageId).nodes),
      );
      if (spans[0].type === "block") {
        if (String(spans[0].value.type) === "code-block")
          assert.equal(result.outline[0].attrs.language, String(spans[0].value.attrs.params ?? ""));
        // A heading level this build doesn't write reads as a notice.
        else assert.equal(result.outline[0].type, "unknown");
      }
      assert.deepEqual(A.save(doc), bytes);
    } finally {
      A.free(doc);
    }
  }
});

test("review: generated partial tables, unknown descendants, and legacy marks match actual old projections", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("table", "blockquote", "unordered-list-item", "ordered-list-item"),
      fc.integer({ min: 0, max: 2 }),
      fc.string({ minLength: 1, maxLength: 12 }),
      fc.boolean(),
      (kind, joins, value, legacy) => {
        const spans =
          kind === "table"
            ? [
                block("table"),
                block("table-row", ["table"]),
                block("table-cell", ["table", "table-row"]),
                text(value, legacy ? { strong: false } : {}),
              ]
            : [
                block(kind),
                block("future", [kind]),
                text(
                  value,
                  legacy
                    ? { link: JSON.stringify({ href: "https://example.org", private: "kept" }) }
                    : {},
                ),
              ];
        let doc = page(spans);
        if (kind === "table")
          doc = A.change(doc, (draft) => {
            if (joins >= 1) A.joinBlock(draft, ["blocks", "one", "richText"], 2);
            if (joins === 2) A.joinBlock(draft, ["blocks", "one", "richText"], 1);
          });
        try {
          const bytes = A.save(doc),
            expected = readMarkdown(nativeRead(doc.blocks.one, pageId).nodes);
          assert.equal(projectReadContent(doc).blocks[0].markdown, expected);
          assert.equal(namedBlockMarkdown(doc), expected);
          assert.deepEqual(A.save(doc), bytes);
        } finally {
          A.free(doc);
        }
      },
    ),
    { seed: 4933, numRuns: 100 },
  );
});

test("concurrent table joins and peer typing retain the surviving table identity", () => {
  const before = page([
    block("table"),
    block("table-row", ["table"]),
    block("table-cell", ["table", "table-row"]),
    text("x"),
  ]);
  const left = A.change(A.clone(before), (draft) => {
    A.joinBlock(draft, ["blocks", "one", "richText"], 2);
    A.joinBlock(draft, ["blocks", "one", "richText"], 1);
  });
  const right = A.change(A.clone(before), (draft) =>
    A.splice(draft, ["blocks", "one", "richText"], 4, 0, " peer"),
  );
  const merged = A.merge(left, right),
    loaded = A.load(A.save(merged));
  try {
    const bytes = A.save(loaded),
      current = projectReadContent(loaded);
    assert.equal(current.blocks[0].markdown, "| x peer |\n| --- |");
    const tableId = projectReadContent(before).outline[0].node_id;
    assert.equal(typeof tableId, "string");
    assert.equal(current.outline[0].node_id, tableId);
    const delta = projectReadChanges(loaded, { since_heads: A.getHeads(before), comments: "none" });
    assert.equal(
      delta.changes.find((entry) => entry.markdown).markdown,
      current.blocks[0].markdown,
    );
    assert.deepEqual(A.save(loaded), bytes);
  } finally {
    for (const doc of [before, right, merged, loaded]) A.free(doc);
  }
});
/** The Markdown read_page gives for block "one" when node_ids names it. */
const namedBlockMarkdown = (doc) =>
  projectReadContent(doc, { node_ids: [blockAddress(doc, "one")] }).blocks[0].markdown;
/** The Markdown read_page gives for top-level node `index` when node_ids
 * names it by its outline id. */
function nodeMarkdown(doc, index) {
  const id = projectReadContent(doc).outline[index].node_id;
  return projectReadContent(doc, { node_ids: [id] }).nodes[0].markdown;
}

function page(spans) {
  return A.change(
    A.from({
      page_id: pageId,
      blocks: {
        one: { position: "a0", richText: "" },
      },
    }),
    (doc) => {
      A.updateSpans(doc, ["blocks", "one", "richText"], spans);
    },
  );
}

for (const [name, spans] of [
  ["legacy heading", [block("heading", [], { level: 9 }), text("old")]],
  [
    "unknown parent",
    [block("paragraph", ["future"]), text("inside"), block("paragraph"), text("after")],
  ],
  ["unknown block", [block("future"), text("inside"), block("paragraph"), text("after")]],
  [
    "unknown in table",
    [
      block("table-cell", ["table", "table-row"]),
      text("before"),
      block("future", ["table", "table-row", "table-cell"]),
      text("inside"),
    ],
  ],
  [
    "code hardbreak",
    [block("code-block"), text("a"), block("hard-break", ["code-block"], {}, true), text("b")],
  ],
  ["marked newline", [text("a\nb\n", { strong: true })]],
])
  test(`base native read contract: ${name}`, () => {
    const doc = page(spans);
    try {
      const before = A.save(doc);
      const full = projectReadContent(doc);
      assert.equal(full.blocks[0].markdown, blockMarkdown(doc.blocks.one, pageId));
      assert.equal(namedBlockMarkdown(doc), full.blocks[0].markdown);
      const native = nativeRead(doc.blocks.one, pageId);
      assert.equal(readMarkdown(native.nodes), full.blocks[0].markdown);
      assert.deepEqual(
        native.nodes.map(readKind),
        full.outline.map((entry) => entry.type),
      );
      if (name === "unknown in table")
        assert.equal(native.nodes.map(readText).join(""), "before[Unsupported node: future]inside");
      assert.deepEqual(A.save(doc), before);
    } finally {
      A.free(doc);
    }
  });

test("reader module and image bridge import graphs exclude PM", async () => {
  for (const module of ["native-read.mjs", "image-ids.mjs"]) {
    const result = await build({
      entryPoints: [new URL(module, import.meta.url).pathname],
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
  }
});

test("replaced marker with changed foreign attrs reports replacement without leaking attrs", () => {
  const base = page([block("heading", [], { level: 2, future: "before" }), text("title")]);
  const heads = A.getHeads(base);
  const next = A.change(A.clone(base), (draft) =>
    A.updateBlock(
      draft,
      ["blocks", "one", "richText"],
      0,
      block("heading", [], { level: 2, future: "secret-after" }).value,
    ),
  );
  try {
    const before = projectReadContent(base).outline[0];
    const after = projectReadContent(next).outline[0];
    assert.notEqual(after.node_id, before.node_id);
    const delta = projectReadChanges(next, { since_heads: heads, comments: "none" });
    assert.equal(delta.changes.length, 2);
    assert.equal(delta.changes.find((entry) => entry.change === "inserted").markdown, "## title");
    assert.ok(!JSON.stringify(delta).includes("secret-after"));
  } finally {
    A.free(base);
    A.free(next);
  }
});

test("native snapshots and concurrent edits preserve legacy grouping and image marker identity", () => {
  const base = page([
    block("future"),
    text("inside"),
    block("paragraph"),
    block("image", ["paragraph"], { src: "https://example.org/image.png", alt: "picture" }, true),
    text("after"),
  ]);
  const heads = A.getHeads(base);
  let a = A.clone(base),
    b = A.clone(base);
  a = A.change(a, (draft) => A.splice(draft, ["blocks", "one", "richText"], 1, 0, "left "));
  b = A.change(b, (draft) =>
    A.splice(draft, ["blocks", "one", "richText"], draft.blocks.one.richText.length, 0, " right"),
  );
  const merged = A.merge(a, b),
    loaded = A.load(A.save(merged));
  try {
    const bytes = A.save(loaded);
    const current = projectReadContent(loaded);
    assert.equal(
      current.blocks[0].markdown,
      readMarkdown(nativeRead(loaded.blocks.one, pageId).nodes),
    );
    assert.deepEqual(
      current.outline.map((node) => node.type),
      ["unknown", "paragraph"],
    );
    assert.deepEqual(
      current.outline.map((node) => node.node_id),
      projectReadContent(base).outline.map((node) => node.node_id),
    );
    const images = current.outline[1].summary.images;
    assert.equal(images[0].node_id, projectReadContent(base).outline[1].summary.images[0].node_id);
    const delta = projectReadChanges(loaded, { since_heads: heads, comments: "none" });
    assert.deepEqual(
      delta.changes.map((entry) => entry.markdown),
      current.outline.map((_entry, i) => nodeMarkdown(loaded, i)),
    );
    assert.deepEqual(A.save(loaded), bytes);
  } finally {
    for (const doc of [base, b, merged, loaded]) A.free(doc);
  }
});
