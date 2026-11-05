// The node registry against the layers that still define block types in
// their own terms: the ProseMirror adapter, features.json and the Wordgard
// model. A type added to one of them without the registry fails here.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import featureFile from "./features.json" with { type: "json" };
import {
  ALIGNMENTS,
  INSERT_OPERATIONS,
  insertOperation,
  NODE_TYPES,
  TEXT_CONTAINERS,
  isKnownBlock,
  nodeLabel,
  nodeType,
  validHeadingLevel,
} from "./node-registry.mjs";
import { adapter, schema } from "./richtext.mjs";
import { PagesUnknownBlock, PagesUnknownEmbed, decode, encode } from "../viewer/wordgard-model.mjs";
import { insertedAssets } from "./page.mjs";

test("every adapter block mapping has exactly one registry entry, and back", () => {
  const mapped = [...new Set(adapter.nodeMappings.map((mapping) => mapping.blockName))].sort();
  const declared = NODE_TYPES.map((type) => type.block).sort();
  assert.deepEqual(declared, mapped);
  assert.equal(new Set(declared).size, declared.length);
});

test("each entry's ProseMirror node, wrapper and kind match the schema", () => {
  for (const type of NODE_TYPES) {
    const node = schema.nodes[type.pm];
    assert.ok(node, `${type.block}: no ProseMirror node ${type.pm}`);
    const mapping = adapter.nodeMappings.find((item) => item.blockName === type.block);
    assert.equal(mapping.content.name, type.pm, type.block);
    assert.equal(mapping.outer?.name ?? null, type.wrapper, type.block);
    if (type.kind === "embed") assert.equal(mapping.isEmbed ?? false, true, type.block);
    else assert.notEqual(mapping.isEmbed, true, type.block);
    if (type.kind === "text-container") {
      // Text and line breaks only: a paragraph can't go inside.
      assert.ok(!node.contentMatch.matchType(schema.nodes.paragraph), type.block);
    }
    for (const name of Object.keys(type.attrs))
      assert.ok(name in (node.spec.attrs ?? {}), `${type.block}.${name}`);
  }
});

test("feature gates match features.json", () => {
  const gated = {};
  for (const feature of featureFile.features)
    for (const block of feature.blocks ?? []) gated[block] = feature.id;
  for (const type of NODE_TYPES) assert.equal(type.feature, gated[type.block] ?? null, type.block);
});

test("the Wordgard model draws every block type as a known node", () => {
  const S = (value) => new A.ImmutableString(value);
  const marker = (type, parents = [], attrs = {}) => ({
    type: "block",
    value: { type: S(type), parents: parents.map(S), attrs, isEmbed: false },
  });
  const text = { type: "text", value: "x" };
  // A minimal stored form of each type, as the editor encodes it.
  const forms = {
    paragraph: [marker("paragraph"), text],
    heading: [marker("heading", [], { level: 2 }), text],
    "code-block": [marker("code-block", [], { params: S("py") }), text],
    blockquote: [marker("blockquote"), text],
    aside: [marker("aside"), text],
    "unordered-list-item": [marker("unordered-list-item"), text],
    "ordered-list-item": [marker("ordered-list-item"), text],
    "task-list-item": [marker("task-list-item", [], { checked: false }), text],
    table: [
      marker("table"),
      marker("table-row", ["table"]),
      marker("table-cell", ["table", "table-row"]),
      text,
    ],
    "table-row": [
      marker("table"),
      marker("table-row", ["table"]),
      marker("table-cell", ["table", "table-row"]),
      text,
    ],
    "table-cell": [
      marker("table"),
      marker("table-row", ["table"]),
      marker("table-cell", ["table", "table-row"]),
      text,
    ],
    "table-header": [
      marker("table"),
      marker("table-row", ["table"]),
      marker("table-header", ["table", "table-row"]),
      text,
    ],
    "horizontal-rule": [marker("horizontal-rule")],
    "pages-opaque": [
      marker("pages-opaque", [], { source: S("x"), importId: S("i"), kind: S("markdown") }),
    ],
    dataframe: [
      marker("dataframe", [], {
        src: S(`/api/pages/11111111-1111-4111-8111-111111111111/assets/${"a".repeat(64)}`),
        media_type: S("application/vnd.apache.parquet"),
      }),
    ],
    image: [
      marker("paragraph"),
      {
        type: "block",
        value: {
          type: S("image"),
          parents: [S("paragraph")],
          attrs: { src: S("https://example.com/a.png"), alt: S("a"), title: null },
          isEmbed: true,
        },
      },
    ],
    "hard-break": [
      marker("paragraph"),
      text,
      {
        type: "block",
        value: { type: S("hard-break"), parents: [S("paragraph")], attrs: {}, isEmbed: true },
      },
      text,
    ],
  };
  for (const type of NODE_TYPES) {
    assert.ok(forms[type.block], `no stored form for ${type.block}`);
    const decoded = decode(forms[type.block]);
    assert.equal(decoded.lossy, false, type.block);
    let unknown = false;
    decoded.doc.iterate((node) => {
      unknown ||= node.type === PagesUnknownBlock || node.type === PagesUnknownEmbed;
    });
    assert.equal(unknown, false, type.block);
    // The editor's rewrite keeps the node, and a second rewrite writes
    // nothing. (The first may drop an explicit first paragraph marker,
    // which the editor leaves implicit.)
    const rewrite = (doc) =>
      A.change(A.clone(doc), (d) => A.updateSpans(d, ["t"], encode(decode(A.spans(d, ["t"])).doc)));
    let doc = A.change(A.from({ t: "" }), (d) => A.updateSpans(d, ["t"], forms[type.block]));
    const once = rewrite(doc);
    assert.ok(decode(A.spans(once, ["t"])).doc.eq(decoded.doc), `${type.block} rewrite`);
    const twice = rewrite(once);
    assert.deepEqual(
      A.diff(twice, A.getHeads(once), A.getHeads(twice)),
      [],
      `${type.block} round trip`,
    );
  }
});

test("helpers read the registry", () => {
  assert.deepEqual([...TEXT_CONTAINERS].sort(), ["code-block", "table-cell", "table-header"]);
  assert.deepEqual(ALIGNMENTS, ["left", "center", "right"]);
  assert.equal(isKnownBlock("dataframe"), true);
  assert.equal(isKnownBlock("callout"), false);
  assert.equal(nodeLabel("blockquote"), "a quote's first paragraph");
  assert.equal(nodeLabel("callout"), "a callout node");
  assert.equal(nodeType("heading").attrs.level.agent, undefined);
  assert.equal(nodeType("code-block").attrs.params.agent, "language");
  assert.ok([1, 6].every(validHeadingLevel));
  assert.ok(![0, 7, 2.5, "2"].some(validHeadingLevel));
  for (const name of ["constructor", "__proto__", "toString", 3, undefined])
    assert.equal(insertOperation(name), undefined, String(name));
  assert.equal(nodeType("task-list-item").governsFirstParagraph, true);
  assert.deepEqual(INSERT_OPERATIONS, {
    insert_image: { block: "image", asset: "image" },
    insert_node: { block: "dataframe", asset: "dataset" },
  });
});

test("insertedAssets lists each stored asset a batch names, validated", () => {
  const pageId = "11111111-1111-4111-8111-111111111111";
  const a = "a".repeat(64),
    b = "b".repeat(64);
  assert.deepEqual(
    insertedAssets(
      [
        { op: "insert_image", asset_id: a, alt: "one" },
        { op: "insert_image", asset_id: a, alt: "again" },
        { op: "replace_match", block_id: "x", match_text: "y", replacement: "z" },
        { op: "insert_node", node: { type: "dataframe", attrs: { asset_id: b } } },
      ],
      pageId,
    ),
    [
      { asset: "image", assetId: a },
      { asset: "dataset", assetId: b, mediaType: "application/vnd.apache.parquet" },
    ],
  );
  assert.throws(() => insertedAssets([{ op: "insert_image", asset_id: "nope", alt: "" }], pageId));
  assert.throws(() =>
    insertedAssets(
      [{ op: "insert_node", node: { type: "video", attrs: { asset_id: b } } }],
      pageId,
    ),
  );
});

test("set_node's attrs are the registry attrs marked settable", async () => {
  const { NODE_ATTRS, REFUSED_FIELDS } = await import("./set-node.mjs");
  const settable = new Set();
  for (const type of NODE_TYPES)
    for (const [name, attr] of Object.entries(type.attrs))
      if (attr.set === "set_node") settable.add(attr.agent ?? name);
  assert.deepEqual([...settable].sort(), [...NODE_ATTRS].sort());
  assert.deepEqual(Object.keys(REFUSED_FIELDS).sort(), [
    "align",
    "checked",
    "heading_level",
    "language",
  ]);
});

test("the editor and registration agree on heading levels", () => {
  const S = (value) => new A.ImmutableString(value);
  const heading = (attrs) => [
    { type: "block", value: { type: S("heading"), parents: [], attrs, isEmbed: false } },
    { type: "text", value: "x" },
  ];
  assert.equal(decode(heading({})).lossy, false);
  assert.equal(decode(heading({ level: 6 })).lossy, false);
  for (const level of [null, "3", S("3"), 0, 7, 2.5])
    assert.throws(() => decode(heading({ level })), /heading level/, String(level));
});

test("agent-facing types are stored block names, list names or unknown", async () => {
  const { agentType, LIST_TYPES } = await import("./node-registry.mjs");
  for (const type of NODE_TYPES) if (!type.wrapper) assert.equal(agentType(type.pm), type.block);
  for (const [pm, name] of Object.entries(LIST_TYPES)) {
    assert.ok(schema.nodes[pm], pm);
    assert.equal(agentType(pm), name);
  }
  assert.equal(agentType("unknownBlock"), "unknown");
});
