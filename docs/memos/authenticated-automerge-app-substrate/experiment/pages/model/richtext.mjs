import * as A from "@automerge/automerge/slim";
import MarkdownIt from "markdown-it";
import {
  basicSchemaAdapter,
  SchemaAdapter,
  pmNodeToSpans,
  pmDocFromSpans,
} from "@automerge/prosemirror";
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
} from "prosemirror-markdown";

// Shared rich-text schema used by the editor, tool exports, and ingress validation.
const nodes = {},
  marks = {};
basicSchemaAdapter.schema.spec.nodes.forEach((name, spec) => {
  if (name !== "unknownLeaf") nodes[name] = { ...spec };
});
basicSchemaAdapter.schema.spec.marks.forEach((name, spec) => {
  if (name !== "unknownMark") marks[name] = { ...spec };
});
marks.code.automerge = { markName: "code" };
nodes.code_block = {
  ...nodes.code_block,
  attrs: { ...nodes.code_block.attrs, params: { default: "" } },
  automerge: {
    block: "code-block",
    attrParsers: {
      fromAutomerge: (block) => ({ params: String(block.attrs.params ?? "") }),
      fromProsemirror: (node) => ({ params: new A.ImmutableString(node.attrs.params) }),
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
nodes.raw = {
  group: "block",
  content: "text*",
  marks: "",
  atom: true,
  selectable: true,
  attrs: { source: { default: "" }, importId: { default: "" }, kind: { default: "markdown" } },
  automerge: {
    block: "pages-opaque",
    attrParsers: {
      fromAutomerge: (block) =>
        Object.fromEntries(
          ["source", "importId", "kind"].map((k) => [k, String(block.attrs[k] ?? "")]),
        ),
      fromProsemirror: (node) =>
        Object.fromEntries(
          ["source", "importId", "kind"].map((k) => [k, new A.ImmutableString(node.attrs[k])]),
        ),
    },
  },
  toDOM: (node) => [
    "section",
    { class: "opaque", contenteditable: "false", "aria-label": `Preserved ${node.attrs.kind}` },
    ["small", node.attrs.kind === "instruction" ? "Instruction" : "Preserved Markdown"],
    ["pre", node.attrs.source],
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
          align: ["left", "center", "right"].includes(dom.dataset.align) ? dom.dataset.align : null,
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
nodes.image.toDOM = (node) =>
  safeUrl(node.attrs.src) ? imageDOM(node) : ["span", {}, "Image omitted"];
export const adapter = new SchemaAdapter({ nodes, marks });
export const schema = adapter.schema;
// Keep bare URLs and email addresses as prose. Use a private tokenizer so table
// support does not mutate other consumers of the default Markdown parser.
const tokenizer = new MarkdownIt("commonmark", { html: false, linkify: false }).enable("table");
// A line break in a Markdown table cannot be a physical newline. Recognize
// only this fixed tag while parsing cell text, before escape/entity information
// is lost. General HTML stays literal, and code spans retain their own parser.
tokenizer.inline.ruler.before("html_inline", "table_break", (state, silent) => {
  if (!state.env.pagesTableCell) return false;
  const match = /^<br\s*\/?\s*>/i.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) state.push("hardbreak", "br", 0);
  state.pos += match[0].length;
  return true;
});
// Markdown-it's ordinary inline pass, with context scoped to the current cell.
tokenizer.core.ruler.at("inline", (state) => {
  let inCell = false;
  for (const token of state.tokens) {
    if (["td_open", "th_open"].includes(token.type)) inCell = true;
    if (["td_close", "th_close"].includes(token.type)) inCell = false;
    if (token.type === "inline")
      state.md.inline.parse(
        token.content,
        state.md,
        { ...state.env, pagesTableCell: inCell },
        token.children,
      );
  }
});
const cellAttrs = (token) => ({
  isAmgBlock: true,
  align: /^text-align:(left|center|right)$/.exec(token.attrGet("style") ?? "")?.[1] ?? null,
});
const parser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  table: { block: "table", attrs: { isAmgBlock: true } },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row", attrs: { isAmgBlock: true } },
  th: { block: "table_header", getAttrs: cellAttrs },
  td: { block: "table_cell", getAttrs: cellAttrs },
});
const plainImportParser = new MarkdownParser(
  schema,
  new MarkdownIt("commonmark", { html: false, linkify: false }),
  defaultMarkdownParser.tokens,
);
const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    table(state, node) {
      const rows = [];
      const width = Math.max(
        ...Array.from({ length: node.childCount }, (_, i) => node.child(i).childCount),
      );
      node.forEach((row) => {
        const cells = [];
        row.forEach((cell) => {
          // Serialize cell contents with the regular rich marks, then protect
          // pipes (including those in code spans) from Markdown table splitting.
          const value = tableCellSerializer.serialize(
            schema.node("doc", null, [schema.node("paragraph", null, cell.content)]),
          );
          cells.push(value.replace(/\|/g, "\\|").replace(/\n/g, "<br>"));
        });
        // Concurrent structural changes may temporarily make a table ragged.
        // Pad the projection so a later Markdown import cannot discard cells.
        while (cells.length < width) cells.push("");
        rows.push(`| ${cells.join(" | ")} |`);
      });
      const alignment = [];
      node.firstChild.forEach((cell) =>
        alignment.push(
          cell.attrs.align === "center"
            ? ":---:"
            : cell.attrs.align === "right"
              ? "---:"
              : cell.attrs.align === "left"
                ? ":---"
                : "---",
        ),
      );
      while (alignment.length < width) alignment.push("---");
      rows.splice(1, 0, `| ${alignment.join(" | ")} |`);
      rows.forEach((row, index) => {
        if (index) state.ensureNewLine();
        // write() supplies the surrounding quote/list delimiter for every row.
        state.write(row);
      });
      state.closeBlock(node);
    },
    raw(state, node) {
      state.write(node.attrs.source);
      state.closeBlock(node);
    },
  },
  defaultMarkdownSerializer.marks,
);

const tableCellSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    hard_break(state) {
      state.write("<br>");
    },
  },
  defaultMarkdownSerializer.marks,
  { escapeExtraCharacters: /</g },
);

// Conservative import gate: unknown syntax is opaque rather than silently discarded.
export function parseMarkdown(source, importId = "", kind = "markdown") {
  const unsupported =
    kind !== "markdown" ||
    /(^|\n)\s*(<|\$\$|---\s*$)|\$[^\n$]+\$|!?\[[^\]]*\]\s*\[|^\s*\[[^\]]+\]:|~~|\[[ xX]\]/m.test(
      source,
    );
  return unsupported
    ? schema.node("doc", null, [schema.node("raw", { source, importId, kind })])
    : parser.parse(source);
}
// Existing opaque blocks opt in through an editor transaction; reading a page
// never silently rewrites its history or changes comment anchors.
export function nativeTableSpans(source) {
  const tree = parseMarkdown(source);
  let table = false,
    opaque = false;
  tree.descendants((node) => {
    table ||= node.type.name === "table";
    opaque ||= node.type.name === "raw";
  });
  return table && !opaque ? pmNodeToSpans(adapter, tree) : null;
}
export function exportMarkdown(doc) {
  return serializer.serialize(doc);
}

export const RICH_FORMAT = "automerge-rich-text-v1";
export const textPath = (id) => ["blocks", id, "richText"];
export const isRich = (block) => block?.format === RICH_FORMAT;
export const richDoc = (block) => pmDocFromSpans(adapter, A.spans(block, ["richText"]));
export function blockMarkdown(block) {
  if (!isRich(block)) return block.markdown;
  const current = exportMarkdown(richDoc(block));
  const baseline = exportMarkdown(
    pmDocFromSpans(adapter, pmNodeToSpans(adapter, parseMarkdown(block.markdown))),
  );
  if (current === baseline) return block.markdown;
  // Before native tables, pipe syntax without outer pipes was imported as
  // prose. Retain its original source while that native content is unchanged;
  // merely reading it must not flatten the original table into one line.
  if (
    block.markdown.includes("|") &&
    current ===
      exportMarkdown(
        pmDocFromSpans(adapter, pmNodeToSpans(adapter, plainImportParser.parse(block.markdown))),
      )
  )
    return block.markdown;
  return current;
}
export function richSize(block) {
  return isRich(block)
    ? new TextEncoder().encode(JSON.stringify(A.spans(block, ["richText"]))).length
    : 0;
}

// markdown remains immutable import provenance once a block is rich. Snapshots
// and semantic tool edits use the rich field, never this old source string.
export function enableRich(doc, id) {
  const block = doc.blocks[id];
  if (isRich(block)) return;
  if (block.kind !== "markdown") throw Error("Only prose blocks support rich editing");
  block.format = RICH_FORMAT;
  block.richText = "";
  setRichMarkdown(doc, id, block.markdown);
}
export function setRichMarkdown(doc, id, source) {
  A.updateSpans(
    doc,
    textPath(id),
    pmNodeToSpans(adapter, parseMarkdown(source)),
    adapter.updateSpansConfig(),
  );
}
export function projectedBlock(block) {
  const { richText: _rich, ...result } = block;
  return { ...result, markdown: blockMarkdown(block) };
}

// Bound the actual spans: JSON.stringify(doc) alone misses block-marker data.
export function validateRich(block) {
  const spans = A.spans(block, ["richText"]);
  if (richSize(block) > 262144) throw Error("Rich block exceeds content limit");
  for (const span of spans) {
    if (span.type === "text") {
      for (const [name, value] of Object.entries(span.marks ?? {})) {
        if (!["strong", "em", "code", "link"].includes(name)) throw Error("Unsupported rich mark");
        if (name === "link") {
          const href = typeof value === "string" ? JSON.parse(value).href : null;
          if (typeof href !== "string" || !safeUrl(href)) throw Error("Invalid rich link");
        } else if (value !== true) throw Error("Invalid rich mark value");
      }
    } else if (span.type === "block") {
      const value = span.value;
      if (
        !value ||
        Object.keys(value).some((k) => !["type", "parents", "attrs", "isEmbed"].includes(k)) ||
        !Array.isArray(value.parents) ||
        value.parents.length > 32 ||
        !adapter.nodeMappings.some((mapping) => mapping.blockName === String(value.type))
      )
        throw Error("Unsupported rich block marker");
      for (const parent of value.parents)
        if (!adapter.nodeMappings.some((mapping) => mapping.blockName === String(parent)))
          throw Error("Unsupported rich parent");
    } else throw Error("Unsupported rich span");
  }
  const tree = richDoc(block);
  tree.check();
  tree.descendants((node) => {
    if (
      ["table_cell", "table_header"].includes(node.type.name) &&
      node.attrs.align != null &&
      !["left", "center", "right"].includes(node.attrs.align)
    )
      throw Error("Invalid table alignment");
    if (node.type.name === "image" && !safeUrl(node.attrs.src))
      throw Error("Invalid rich image URL");
    for (const mark of node.marks)
      if (mark.type.name === "link" && !safeUrl(mark.attrs.href)) throw Error("Invalid rich link");
  });
  exportMarkdown(tree);
}
export function safeUrl(value) {
  return (
    typeof value === "string" &&
    ![...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value.replace(/^(https?|mailto|tel):/i, ""))
  );
}
