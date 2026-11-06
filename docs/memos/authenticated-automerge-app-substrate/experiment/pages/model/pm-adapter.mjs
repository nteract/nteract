// ProseMirror boundary. model/pm-adapter.mjs, model/pm-markdown-parser.mjs
// and model/pm-markdown-serializer.mjs are the only production Pages modules
// that import ProseMirror packages (@automerge/prosemirror, prosemirror-*);
// model/pm-boundary.test.mjs checks it. Other modules reach ProseMirror trees,
// and the span adapter through these three.
//
// The ProseMirror schema and its Automerge span adapter. Markdown import and
// export and validation still read Pages spans through it. Node addressing
// (ids, ranges, node_index) uses the Wordgard tree (model/node-addresses.mjs).
import * as A from "@automerge/automerge/slim";
import {
  basicSchemaAdapter,
  SchemaAdapter,
  pmNodeToSpans,
  pmDocFromSpans,
} from "@automerge/prosemirror";
import { DEFAULT_HIGHLIGHT, MARK_REGISTRY, normalizeHighlight, safeUrl } from "./marks.mjs";
import { FEATURE_REGISTRY } from "./schema-features.mjs";
import { validAlignment } from "./node-registry.mjs";
import { DATAFRAME_BLOCK } from "../shared/dataset-assets.mjs";

export { pmNodeToSpans, pmDocFromSpans };

// Shared rich-text schema used by tool exports and ingress validation. Mark
// names, order and expand rules come from the registry in marks.json.
const nodes = {},
  baseMarks = {};
basicSchemaAdapter.schema.spec.nodes.forEach((name, spec) => {
  if (name !== "unknownLeaf") nodes[name] = { ...spec };
});
basicSchemaAdapter.schema.spec.marks.forEach((name, spec) => {
  if (name !== "unknownMark") baseMarks[name] = { ...spec };
});
baseMarks.code.automerge = { markName: "code" };
baseMarks.strike = {
  parseDOM: [
    { tag: "s" },
    { tag: "del" },
    { tag: "strike" },
    {
      style: "text-decoration",
      getAttrs: (value) => value.includes("line-through") && null,
    },
  ],
  toDOM: () => ["s", 0],
  automerge: { markName: "strike" },
};
baseMarks.highlight = {
  attrs: { color: { default: DEFAULT_HIGHLIGHT } },
  parseDOM: [
    {
      tag: "mark",
      getAttrs: (dom) => {
        try {
          return {
            color: normalizeHighlight(dom.getAttribute("data-highlight") ?? DEFAULT_HIGHLIGHT),
          };
        } catch {
          return false;
        }
      },
    },
  ],
  toDOM: (mark) => ["mark", { "data-highlight": mark.attrs.color }, 0],
  automerge: {
    markName: "highlight",
    parsers: {
      fromAutomerge: (value) => ({ color: String(value) }),
      fromProsemirror: (mark) => mark.attrs.color,
    },
  },
};
const marks = {};
for (const { name, expand } of MARK_REGISTRY.marks) {
  if (!baseMarks[name]) throw Error(`The ProseMirror schema has no spec for mark ${name}`);
  marks[name] = { ...baseMarks[name], inclusive: expand !== "none" };
}
nodes.task_list = {
  content: "list_item+",
  group: "block",
  toDOM: () => ["ul", { "data-task-list": "true" }, 0],
  parseDOM: [{ tag: 'ul[data-task-list="true"]', priority: 60 }],
};
// A list item can open with any block, as Wordgard's ListItem can. The
// adapter's `paragraph block*` can't read an item stored as a list-item
// marker followed by another block's marker, which both writers produce for
// an item that opens with a code block, heading, quote, rule or dataframe.
nodes.list_item = {
  ...nodes.list_item,
  content: "block+",
  attrs: { ...nodes.list_item.attrs, checked: { default: null } },
  toDOM: (node) =>
    typeof node.attrs.checked === "boolean"
      ? [
          "li",
          { "data-task-checked": String(node.attrs.checked) },
          [
            "input",
            {
              type: "checkbox",
              ...(node.attrs.checked ? { checked: "" } : {}),
              disabled: "",
              contenteditable: "false",
              "aria-label": "Task completed",
            },
          ],
          ["div", 0],
        ]
      : ["li", 0],
  parseDOM: [
    {
      tag: "li",
      getAttrs: (dom) => ({
        checked: dom.hasAttribute("data-task-checked")
          ? dom.getAttribute("data-task-checked") === "true"
          : null,
      }),
    },
  ],
  automerge: {
    ...nodes.list_item.automerge,
    block: {
      within: {
        ...nodes.list_item.automerge.block.within,
        task_list: "task-list-item",
      },
    },
    attrParsers: {
      fromAutomerge: (block) => ({ checked: block.attrs.checked ?? false }),
      fromProsemirror: (node) => ({ checked: node.attrs.checked }),
    },
  },
};
nodes.code_block = {
  ...nodes.code_block,
  attrs: { ...nodes.code_block.attrs, params: { default: "" } },
  automerge: {
    block: "code-block",
    attrParsers: {
      fromAutomerge: (block) => ({ params: String(block.attrs.params ?? "") }),
      fromProsemirror: (node) => ({
        params: new A.ImmutableString(node.attrs.params),
      }),
    },
  },
};

nodes.hard_break = {
  inline: true,
  group: "inline",
  selectable: false,
  toDOM: () => ["br"],
  parseDOM: [{ tag: "br" }],
  automerge: { block: "hard-break", isEmbed: true },
};
nodes.horizontal_rule = {
  ...nodes.horizontal_rule,
  automerge: { block: "horizontal-rule" },
};
// A dataframe: a block with no text whose attrs name a Page dataset asset
// (shared/dataset-assets.mjs). It has no Markdown syntax, so the codec never
// creates one; insert_node does (model/page.mjs). Every string attr is
// immutable, as the Wordgard encoder writes it, so either writer leaves the
// marker unchanged. The adapter keeps attrs this build doesn't know in
// `unknownAttrs` and writes them back (pageSpans stores them immutable), so
// a later build can add one under the same feature.
const immutable = (value) => (value == null ? null : new A.ImmutableString(String(value)));
nodes.dataframe = {
  group: "block",
  atom: true,
  selectable: true,
  attrs: { src: {}, media_type: {}, title: { default: null } },
  automerge: {
    block: DATAFRAME_BLOCK,
    attrParsers: {
      fromAutomerge: (block) => ({
        src: String(block.attrs.src ?? ""),
        media_type: String(block.attrs.media_type ?? ""),
        title: block.attrs.title == null ? null : String(block.attrs.title),
      }),
      fromProsemirror: (node) => ({
        src: immutable(node.attrs.src),
        media_type: immutable(node.attrs.media_type),
        ...(node.attrs.title != null && { title: immutable(node.attrs.title) }),
      }),
    },
  },
  toDOM: (node) => [
    "figure",
    { "data-dataframe": node.attrs.media_type },
    node.attrs.title ?? "Dataframe",
  ],
};
// Table structure lives in the same Automerge text as prose. Explicit markers
// keep adjacent rows/cells distinct even when their contents are empty.
nodes.table = {
  group: "block",
  content: "table_row+",
  isolating: true,
  automerge: { block: "table" },
  toDOM: () => ["table", ["tbody", 0]],
  parseDOM: [{ tag: "table" }],
};
nodes.table_row = {
  content: "(table_cell | table_header)+",
  automerge: { block: "table-row" },
  toDOM: () => ["tr", 0],
  parseDOM: [{ tag: "tr" }],
};
for (const [name, tag, block] of [
  ["table_cell", "td", "table-cell"],
  ["table_header", "th", "table-header"],
]) {
  nodes[name] = {
    content: "inline*",
    isolating: true,
    attrs: { align: { default: null } },
    automerge: {
      block,
      attrParsers: {
        fromAutomerge: (value) => ({
          align: value.attrs.align == null ? null : String(value.attrs.align),
        }),
        fromProsemirror: (node) =>
          node.attrs.align ? { align: new A.ImmutableString(node.attrs.align) } : {},
      },
    },
    toDOM: (node) => [tag, { "data-align": node.attrs.align }, 0],
    parseDOM: [
      {
        tag,
        getAttrs: (dom) => ({
          align: validAlignment(dom.dataset.align) ? dom.dataset.align : null,
        }),
      },
    ],
  };
}
// Generic document writers may send unfamiliar or unsafe link attributes.
// Rendering remains safe even when the host intentionally accepts open schemas.
const linkDOM = marks.link.toDOM;
marks.link.toDOM = (mark, inline) =>
  safeUrl(mark.attrs.href) ? linkDOM(mark, inline) : ["span", 0];
const imageDOM = nodes.image.toDOM;
const baseImageParsers = nodes.image.automerge.attrParsers;
nodes.image = {
  ...nodes.image,
  attrs: { ...nodes.image.attrs, dark_src: { default: null } },
  automerge: {
    ...nodes.image.automerge,
    attrParsers: {
      fromAutomerge: (block) => ({
        ...baseImageParsers.fromAutomerge(block),
        dark_src: block.attrs.dark_src == null ? null : String(block.attrs.dark_src),
      }),
      fromProsemirror: (node) => ({
        ...baseImageParsers.fromProsemirror(node),
        ...(node.attrs.dark_src != null && {
          dark_src: new A.ImmutableString(node.attrs.dark_src),
        }),
      }),
    },
  },
};
nodes.image.toDOM = (node) =>
  safeUrl(node.attrs.src) ? imageDOM(node) : ["span", {}, "Image omitted"];
export const adapter = new SchemaAdapter({ nodes, marks });
for (const block of FEATURE_REGISTRY.blocks.keys())
  if (!adapter.nodeMappings.some((mapping) => mapping.blockName === block))
    throw Error(`The ProseMirror schema has no block type ${block} for its schema feature`);
// The upstream adapter currently installs attrParsers only for direct mappings,
// not `within` mappings. Task items need both their list wrapper and checked
// attribute; install the parser on that one resolved mapping explicitly.
adapter.nodeMappings.find((mapping) => mapping.blockName === "task-list-item").attrParsers =
  nodes.list_item.automerge.attrParsers;
export const schema = adapter.schema;
