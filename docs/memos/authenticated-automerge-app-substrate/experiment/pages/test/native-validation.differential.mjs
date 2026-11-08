// PAGES_VALIDATION_BASE=02b8c81c PAGES_VALIDATION_RUNS=100000 node --test test/native-validation.differential.mjs
// Kept out of the default suite so shallow CI checkouts need no historical source.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import fc from "fast-check";
import { baseline, marker, resultOf, text } from "./native-validation-baseline.mjs";
import { NODE_TYPES } from "../model/node-registry.mjs";
import { validateRichSpans, pageSpans, adapterSpans } from "../model/richtext-spans.mjs";
import { parseMarkdown } from "../model/markdown-import.mjs";
import { decode, encode } from "../model/wordgard-doc.mjs";
import { pageTreeArbitrary, toWordgardTree } from "./random-page-tree.mjs";
import { COMMENT_MAX_BYTES, validateCommentSpans } from "../model/comment-content.mjs";

const S = (value) => new A.ImmutableString(value);
const B = (type, parents = [], attrs = {}, embed = false) =>
  marker(S(type), parents.map(S), attrs, embed);
const asset = `/api/pages/12345678-1234-4123-8123-123456789abc/assets/${"a".repeat(64)}`;
const dataframe = { src: S(asset), media_type: S("application/vnd.apache.parquet") };
const attrsFor = (type) =>
  type === "image"
    ? { src: S("/image.png") }
    : type === "dataframe"
      ? dataframe
      : type === "task-list-item"
        ? { checked: true }
        : {};
const compare = (spans, limit) => {
  assert.deepEqual(
    resultOf(validateRichSpans, spans, limit),
    resultOf(baseline.validateRichSpans, spans, limit),
    JSON.stringify(spans),
  );
};

test("native validation preserves actual-base writer and editor forms", () => {
  for (const source of [
    "Plain **bold** *italic* ~~strike~~ `code` [link](https://example.org)",
    "# Heading\n\n> Quote\n>\n> - [x] checked\n> - [ ] open\n\nAfter",
    "| A | B |\n| :--- | ---: |\n| 1 | 2 |\n| 3 | 4 |",
    "- Intro\n\n  | A | B |\n  | --- | --- |\n  | x | y |\n\n- Tail",
    '```python\nx = 1\n```\n\n![alt](/image.png "caption")\n\n---',
  ]) {
    const parsed = parseMarkdown(source);
    for (const spans of [adapterSpans(parsed), pageSpans(parsed)]) {
      assert.equal(resultOf(baseline.validateRichSpans, spans).accepted, true);
      compare(spans);
      compare(encode(decode(spans).doc));
    }
  }
  fc.assert(
    fc.property(pageTreeArbitrary({ maxDepth: 3 }), (description) => {
      const spans = encode(toWordgardTree(description));
      assert.equal(resultOf(baseline.validateRichSpans, spans).accepted, true);
      compare(spans);
    }),
    { seed: 11082026, numRuns: 120 },
  );
});

test("native validation keeps partial tables, ragged rows, raw newlines and lenient feature attrs", () => {
  const accepted = [
    [],
    [text("\n")],
    [B("table")],
    [B("table"), text("cell")],
    [B("table-row", ["table"])],
    [B("table-cell", ["table", "table-row"])],
    [
      B("table-header", ["table", "table-row"], { align: S("right") }),
      text("h"),
      B("table-cell", ["table", "table-row"]),
      text("h2"),
      B("table-row", ["table"]),
      text("only one"),
    ],
    [B("code-block", [], { params: { future: true } }), text("code", { strong: true })],
    [B("heading", [], { level: 6, future: ["nested", { payload: "kept" }] }), text("Title")],
    [
      B(
        "image",
        [],
        { src: S("/image.png"), alt: false, title: 0, future: { nested: true } },
        true,
      ),
    ],
    [B("dataframe", [], { ...dataframe, media_type: "future/type", future: { nested: [1, 2] } })],
    [marker("heading", [], { level: 99 }), text("mutable type is a paragraph")],
    [marker(S("paragraph"), ["code-block"]), text("mutable parents reset", { em: true })],
    [B("code-block", [], {}, true), text("outside", { strong: true })],
  ];
  for (const spans of accepted) {
    assert.equal(resultOf(baseline.validateRichSpans, spans).accepted, true, JSON.stringify(spans));
    compare(spans);
  }
});

test("native validation is not tolerant projection or blanket editor-lossy refusal", () => {
  const refused = [
    [B("future")],
    [B("pages-opaque")],
    [B("paragraph", ["future"])],
    [B("table-row")],
    [B("paragraph", ["table", "table-cell"])],
    [B("paragraph", ["table", "aside", "table-row"])],
    [B("table", [], {}, true)],
    [B("table-row", ["table"], {}, true)],
    [B("blockquote", [], {}, true)],
    [B("paragraph"), B("heading", [], {}, true)],
    [B("code-block"), B("hard-break", [], {}, true)],
    [B("code-block"), B("image", [], { src: "/image.png" }, true)],
    [B("dataframe"), text("after")],
    [B("horizontal-rule"), text("after")],
    [B("aside"), text("no Markdown form")],
    [B("heading", [], { level: S("2") }), text("not an integer")],
    [B("image", [], { src: "javascript:alert(1)" }, true)],
    [B("image", [], { src: "/safe", dark_src: "data:image/png;base64,xx" }, true)],
    [B("dataframe", [], { ...dataframe, src: "https://example.org/data.parquet" })],
    [text("text", { future: true })],
    [text("text", { strong: false })],
    [text("text", { link: JSON.stringify({ href: "javascript:alert(1)" }) })],
  ];
  for (const spans of refused) {
    assert.equal(
      resultOf(baseline.validateRichSpans, spans).accepted,
      false,
      JSON.stringify(spans),
    );
    compare(spans);
  }
  const oldAccepted = [B("dataframe", [], dataframe, true)];
  assert.equal(resultOf(baseline.validateRichSpans, oldAccepted).accepted, true);
  compare(oldAccepted);
});

test("native validation matches each known marker in every immediate container and raw representation", () => {
  for (const { block: type } of NODE_TYPES) {
    for (const parent of [null, ...NODE_TYPES.map(({ block }) => block)]) {
      for (const typeMutable of [false, true]) {
        for (const parentsMutable of [false, true]) {
          for (const embed of [false, true]) {
            const span = marker(
              typeMutable ? type : S(type),
              parent === null ? [] : [parentsMutable ? parent : S(parent)],
              attrsFor(type),
              embed,
            );
            compare([span]);
            compare([text("before"), span, text("after")]);
          }
        }
      }
    }
  }
});

test("native validation matches actual-base mixed and interrupted structural forms", () => {
  const kind = fc.constantFrom(...NODE_TYPES.map(({ block }) => block));
  const parent = fc.tuple(kind, fc.boolean()).map(([name, mutable]) => (mutable ? name : S(name)));
  const block = fc
    .record({
      type: kind,
      mutable: fc.boolean(),
      parents: fc.array(parent, { maxLength: 4 }),
      embed: fc.boolean(),
      attrs: fc.constantFrom(
        {},
        { checked: true },
        { level: 0 },
        { align: "right" },
        { alt: true },
        { future: { nested: true } },
      ),
    })
    .map(({ type, mutable, parents, embed, attrs }) =>
      marker(mutable ? type : S(type), parents, { ...attrsFor(type), ...attrs }, embed),
    );
  const run = fc
    .record({
      value: fc.constantFrom("text", "\n", " ", "", "**literal**", "a\nb"),
      marks: fc.constantFrom(
        {},
        { strong: true },
        { em: true },
        { code: true },
        { highlight: "yellow" },
      ),
    })
    .map(({ value, marks }) => text(value, marks));
  fc.assert(fc.property(fc.array(fc.oneof(block, run), { maxLength: 12 }), compare), {
    seed: 11082026,
    numRuns: Number(process.env.PAGES_VALIDATION_RUNS || 3000),
  });
});

test("native validation preserves exact JSON byte bounds and raw error precedence", () => {
  const empty = JSON.stringify([text("")]);
  for (const limit of [262144, COMMENT_MAX_BYTES]) {
    for (const extra of [-1, 0, 1]) {
      const spans = [text("x".repeat(limit - Buffer.byteLength(empty) + extra))];
      assert.equal(Buffer.byteLength(JSON.stringify(spans)), limit + extra);
      compare(spans, limit);
      assert.equal(resultOf(validateRichSpans, spans, limit).accepted, extra <= 0);
    }
  }
  for (const spans of [
    [text("x".repeat(262144), { future: true })],
    [B("heading", [], { level: 0 }), text("x", { future: true })],
    [B("image", [], { src: "javascript:x" }, true), B("paragraph", ["table"])],
    [B("task-list-item", [], { checked: "false" })],
    [B("image", [], {}, true)],
    [B("dataframe", [], { src: asset })],
  ])
    compare(spans);
  assert.throws(
    () => validateCommentSpans([B("image", [], { src: "/image", dark_src: "/dark" }, true)]),
    /theme image variants/,
  );
  assert.throws(
    () => validateCommentSpans([B("dataframe", [], dataframe)]),
    /can't hold a dataframe/,
  );
});

test("native validation preserves scalar attribute types without deep-coercing hidden metadata", () => {
  const scalars = [
    undefined,
    null,
    false,
    true,
    0,
    1,
    6,
    7,
    NaN,
    Infinity,
    "",
    "2",
    "right",
    "left",
    "/image",
    "javascript:x",
    S("2"),
    S("right"),
    S("/image"),
    [],
    ["right"],
    {},
    { nested: ["private metadata"] },
    new A.Counter(1),
    new Date(0),
    new Uint8Array([1, 2]),
  ];
  for (const type of [
    "paragraph",
    "heading",
    "code-block",
    "unordered-list-item",
    "task-list-item",
    "table-cell",
    "image",
    "dataframe",
  ]) {
    const parents = type === "table-cell" ? ["table", "table-row"] : [];
    for (const key of [
      "level",
      "params",
      "checked",
      "align",
      "src",
      "alt",
      "title",
      "dark_src",
      "media_type",
      "unknownAttrs",
      "unknownBlock",
      "future",
    ]) {
      for (const value of scalars) {
        const spans = [B(type, parents, { ...attrsFor(type), [key]: value }, type === "image")];
        compare(spans);
      }
    }
  }
});

test("native validation checks raw marker and mark forms before normalization", () => {
  const forms = [
    undefined,
    null,
    false,
    true,
    0,
    1,
    "",
    "paragraph",
    S("paragraph"),
    [],
    ["paragraph"],
    {},
    { val: "paragraph" },
  ];
  for (const value of forms) {
    compare([text(value)]);
    compare([B("code-block"), text(value)]);
    compare([marker(value)]);
    compare([marker(S("paragraph"), value)]);
    compare([marker(S("paragraph"), [], value)]);
    compare([marker(S("task-list-item"), [], value)]);
    compare([marker(S("paragraph"), [], {}, value)]);
  }
  for (const marks of [
    null,
    {},
    [],
    "strong",
    { strong: null },
    { strong: S("true") },
    { link: {} },
    { link: S('{"href":"/"}') },
    { constructor: true },
    { highlight: "#ABCDEF" },
    { em: true, strong: true },
    { link: '{"href":"","title":null}' },
  ]) {
    compare([text("x", marks)]);
    compare([B("code-block"), text("x", marks)]);
  }
  for (const parents of [
    Array(32).fill(S("blockquote")),
    Array(33).fill(S("blockquote")),
    [S("blockquote"), "paragraph"],
    [S("blockquote"), S("paragraph")],
    [["paragraph"]],
  ])
    compare([marker(S("paragraph"), parents), text("x")]);
  compare([
    { type: "block", value: { type: S("paragraph"), parents: [], attrs: {}, extra: true } },
  ]);
  compare([{ type: "unknown", value: "x" }]);
});

test("native validation checks inherited code context and construction before public attrs", () => {
  for (const marks of [
    { strong: true },
    { em: true, strong: true },
    { code: true },
    { link: '{"href":"/","title":null}' },
  ]) {
    compare([B("code-block"), text("before"), B("code-block", [], {}, true), text("after", marks)]);
    compare([
      B("heading", [], { level: 0 }),
      B("table-cell", ["table", "table-row"], { align: "wrong" }),
      text("x", marks),
    ]);
    compare([B("image", [], { src: "javascript:x" }, true), B("dataframe", [], {})]);
  }
  compare([B("code-block", [], { params: S("js") }), B("hard-break", [], {}, false)]);
  compare([B("code-block"), marker("code-block", [S("code-block")]), text("x", { em: true })]);
  for (const attrs of [
    JSON.parse('{"__proto__":{"src":"/ok","level":9}}'),
    { params: { toString: 1 } },
    { params: { toString: null } },
  ])
    for (const type of ["image", "heading", "code-block"])
      for (const tail of [[], [B("heading", [], { level: 0 })]])
        compare([B(type, [], attrs, type === "image"), ...tail]);
});

test("native validation differentially checks hostile sequence values and nested known tables", () => {
  for (const value of [1, true, ["x"], { text: "x" }, S("x")])
    for (const marks of [{}, { strong: true }])
      for (const spans of [
        [text(value, marks), text("after", marks)],
        [text("before", marks), text(value, marks)],
        [B("code-block"), text(value, marks)],
        [B("paragraph"), text(value, marks), B("heading", [], { level: 0 })],
      ])
        compare(spans);
  for (const outer of [
    [],
    ["blockquote"],
    ["unordered-list-item"],
    ["task-list-item", "blockquote"],
    Array(29).fill("blockquote"),
  ]) {
    compare([
      B("table", outer),
      B("table-row", [...outer, "table"]),
      B("table-cell", [...outer, "table", "table-row"]),
      text("cell"),
      B("table-header", [...outer, "table", "table-row"], { align: S("center") }),
      text("two"),
    ]);
  }
});
