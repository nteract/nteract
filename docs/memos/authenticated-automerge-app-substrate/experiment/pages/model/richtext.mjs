import * as A from "@automerge/automerge/slim";
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
// Keep bare URLs and email addresses as prose. Only explicit Markdown links
// become link marks; dependency upgrades must preserve this import behavior.
defaultMarkdownParser.tokenizer.disable("linkify");
defaultMarkdownParser.tokenizer.set({ linkify: false });
const parser = new MarkdownParser(
  schema,
  defaultMarkdownParser.tokenizer,
  defaultMarkdownParser.tokens,
);
const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    raw(state, node) {
      state.write(node.attrs.source);
      state.closeBlock(node);
    },
  },
  defaultMarkdownSerializer.marks,
);

// Conservative import gate: unknown syntax is opaque rather than silently discarded.
export function parseMarkdown(source, importId = "", kind = "markdown") {
  const unsupported =
    kind !== "markdown" ||
    /(^|\n)\s*(<|\|.*\||\$\$|---\s*$)|\$[^\n$]+\$|!?\[[^\]]*\]\s*\[|^\s*\[[^\]]+\]:|~~|\[[ xX]\]/m.test(
      source,
    );
  return unsupported
    ? schema.node("doc", null, [schema.node("raw", { source, importId, kind })])
    : parser.parse(source);
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
  return current === baseline ? block.markdown : current;
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
    if (node.type.name === "image" && !safeUrl(node.attrs.src))
      throw Error("Invalid rich image URL");
    for (const mark of node.marks)
      if (mark.type.name === "link" && !safeUrl(mark.attrs.href)) throw Error("Invalid rich link");
  });
  exportMarkdown(tree);
}
function safeUrl(value) {
  return (
    typeof value === "string" &&
    ![...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value.replace(/^(https?|mailto|tel):/i, ""))
  );
}
