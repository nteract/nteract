import * as A from "@automerge/automerge";
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

// Reuse the published browser binding. This experiment does not change NotebookDoc.
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
    [
      "small",
      node.attrs.kind === "instruction"
        ? "Instruction · protected in this fixture"
        : "Unsupported Markdown · preserved verbatim",
    ],
    ["pre", node.attrs.source],
  ],
};
export const adapter = new SchemaAdapter({ nodes, marks });
export const schema = adapter.schema;
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
export const fixture = [
  {
    id: "page-title",
    kind: "markdown",
    source: "# A field guide to small discoveries",
    metadata: { role: "title" },
  },
  {
    id: "first-observation",
    kind: "markdown",
    source:
      "The **fox** crossed the garden.\n\nThese two paragraphs share one Page block. Select across them, then type a replacement.",
    metadata: { tag: "observation", unknown: { keep: true } },
  },
  {
    id: "second-observation",
    kind: "markdown",
    source:
      "A second observer wrote: café, 日本語, and 🦊. Try Enter to split, Backspace to join, and undo.",
    metadata: {},
  },
  {
    id: "checklist",
    kind: "markdown",
    source: "- Listen for birds\n- Look for tracks\n- Follow [the field notes](https://nteract.io)",
    metadata: {},
  },
  {
    id: "code",
    kind: "markdown",
    source: '```python\nprint("hello, garden")\n```',
    metadata: { language: "python" },
  },
  {
    id: "table-math",
    kind: "markdown",
    source: "| Place | Count |\n| --- | --- |\n| Garden | 3 |\n\n$$x^2 + y^2$$",
    metadata: { future: "table-and-math" },
  },
  {
    id: "instruction",
    kind: "instruction",
    source: "Keep observations separate from guesses.",
    metadata: { audience: "agent" },
  },
];
export function textPath(id) {
  return ["blocks", id, "richText"];
}
export function createSeed() {
  const blocks = Object.fromEntries(
    fixture.map((block) => [
      block.id,
      { kind: block.kind, metadata: block.metadata, originalMarkdown: block.source, richText: "" },
    ]),
  );
  return A.change(
    A.from({ blockOrder: fixture.map((block) => block.id), blocks }),
    { message: "Import generated Page" },
    (doc) => {
      for (const block of fixture)
        A.updateSpans(
          doc,
          textPath(block.id),
          pmNodeToSpans(adapter, parseMarkdown(block.source, block.id, block.kind)),
          adapter.updateSpansConfig(),
        );
    },
  );
}
export function projected(doc, id) {
  return pmDocFromSpans(adapter, A.spans(doc, textPath(id)));
}
export function exportBlock(doc, id) {
  const block = doc.blocks[id],
    current = exportMarkdown(projected(doc, id));
  // Original bytes are import provenance, never an independently editable document.
  const baseline = exportMarkdown(parseMarkdown(block.originalMarkdown, id, block.kind));
  return current === baseline ? block.originalMarkdown : current;
}

// Minimal DocHandle interface: no storage/network facade, just two in-memory replicas.
export class Replica {
  listeners = new Set();
  constructor(doc, name) {
    this.current = doc;
    this.name = name;
  }
  doc() {
    return this.current;
  }
  on(_event, callback) {
    this.listeners.add(callback);
  }
  off(_event, callback) {
    this.listeners.delete(callback);
  }
  apply(operation) {
    let event;
    this.current = operation((patches, patchInfo) => {
      event = { patches, patchInfo };
    });
    if (event)
      for (const callback of this.listeners)
        callback({ ...event, doc: this.current, handle: this });
    if (event) this.changed?.();
  }
  change(fn) {
    this.apply((patchCallback) =>
      A.change(this.current, { message: `${this.name}: editor transaction`, patchCallback }, fn),
    );
  }
  merge(other) {
    const before = this.current,
      heads = A.getHeads(before);
    this.current = A.merge(before, other.doc());
    if (heads.sort().join() === A.getHeads(this.current).sort().join()) return;
    const event = {
      handle: this,
      doc: this.current,
      patches: A.diff(this.current, heads, A.getHeads(this.current)),
      patchInfo: { before, after: this.current, source: "merge" },
    };
    for (const callback of this.listeners) callback(event);
    this.changed?.();
  }
}
export function pair() {
  const seed = createSeed();
  return [new Replica(A.clone(seed), "Alice"), new Replica(A.clone(seed), "Bob")];
}
export function synchronize(a, b) {
  a.merge(b);
  b.merge(a);
}
export function headsEqual(a, b) {
  return A.getHeads(a.doc()).sort().join() === A.getHeads(b.doc()).sort().join();
}
export { A };
