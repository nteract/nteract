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
import {
  DEFAULT_HIGHLIGHT,
  MARK_REGISTRY,
  markSpec,
  normalizeHighlight,
  safeUrl,
  updateSpansConfig,
  validateMarkValue,
} from "./marks.mjs";

export { safeUrl } from "./marks.mjs";

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
nodes.list_item = {
  ...nodes.list_item,
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
      within: { ...nodes.list_item.automerge.block.within, task_list: "task-list-item" },
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
// The upstream adapter currently installs attrParsers only for direct mappings,
// not `within` mappings. Task items need both their list wrapper and checked
// attribute; install the parser on that one resolved mapping explicitly.
adapter.nodeMappings.find((mapping) => mapping.blockName === "task-list-item").attrParsers =
  nodes.list_item.automerge.attrParsers;
export const schema = adapter.schema;
// Keep bare URLs and email addresses as prose. Use a private tokenizer so table
// support does not mutate other consumers of the default Markdown parser.
const tokenizer = new MarkdownIt("commonmark", { html: false, linkify: false }).enable("table");
// Recognize task syntax only at the beginning of an actual list item. Splitting
// mixed bullet/task runs retains ordinary bullets instead of inventing checkboxes
// for their neighbors. Work on tokens before inline parsing so escaped brackets,
// inline code, and prose containing "[ ]" remain literal.
tokenizer.core.ruler.before("inline", "pages_tasks", (state) => {
  const transform = (tokens) => {
    const result = [];
    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i];
      if (open.type !== "bullet_list_open") {
        result.push(open);
        continue;
      }
      let end = i + 1,
        depth = 1;
      for (; end < tokens.length; end++) {
        if (tokens[end].type === "bullet_list_open") depth++;
        if (tokens[end].type === "bullet_list_close" && --depth === 0) break;
      }
      const items = [];
      for (let j = i + 1; j < end; ) {
        let itemEnd = j + 1,
          itemDepth = 1;
        for (; itemEnd < end; itemEnd++) {
          if (tokens[itemEnd].type === "list_item_open") itemDepth++;
          if (tokens[itemEnd].type === "list_item_close" && --itemDepth === 0) break;
        }
        const item = tokens.slice(j, itemEnd + 1),
          inline =
            item[1]?.type === "paragraph_open" && item[2]?.type === "inline" ? item[2] : null,
          task = inline && /^\[([ xX])\](?:[ \t]+|$)/.exec(inline.content);
        if (task) {
          item[0].attrSet("checked", task[1].toLowerCase() === "x");
          inline.content = inline.content.slice(task[0].length);
        }
        items.push({ task: !!task, tokens: transform(item) });
        j = itemEnd + 1;
      }
      let kind = null;
      const wrapper = (token, task) => {
        const copy = Object.assign(Object.create(Object.getPrototypeOf(token)), token);
        if (task) copy.type = copy.type.replace("bullet_list", "task_list");
        return copy;
      };
      for (const item of items) {
        if (kind !== item.task) {
          if (kind !== null) result.push(wrapper(tokens[end], kind));
          result.push(wrapper(open, item.task));
          kind = item.task;
        }
        result.push(...item.tokens);
      }
      if (kind !== null) result.push(wrapper(tokens[end], kind));
      i = end;
    }
    return result;
  };
  state.tokens = transform(state.tokens);
});
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
// Highlights have no Markdown syntax. Pages reads and writes exactly
// `<mark data-color="…">` and `</mark>`; other HTML stays literal text. The
// tokenizer emits every tag it recognizes, and the balance pass below turns
// nested, unopened or unclosed tags back into their source text.
// Tag whitespace is ASCII only, matching the Rust codec.
const HIGHLIGHT_OPEN =
  /^<mark(?:[ \t\r\n]+data-color[ \t\r\n]*=[ \t\r\n]*(?:"([^"<>]*)"|'([^'<>]*)'))?[ \t\r\n]*>/i;
const HIGHLIGHT_CLOSE = /^<\/mark[ \t\r\n]*>/i;
tokenizer.inline.ruler.before("html_inline", "pages_highlight", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x3c) return false;
  const rest = state.src.slice(state.pos);
  const close = HIGHLIGHT_CLOSE.exec(rest);
  const open = close ? null : HIGHLIGHT_OPEN.exec(rest);
  const match = close ?? open;
  if (!match) return false;
  let color;
  if (open) {
    try {
      color = normalizeHighlight(open[1] ?? open[2] ?? DEFAULT_HIGHLIGHT);
    } catch {
      return false;
    }
  }
  if (!silent) {
    // Nesting 0: markdown-it's delimiter stack must not see these tags, since
    // the balance pass may turn either one back into text.
    const token = state.push(open ? "pages_highlight_open" : "pages_highlight_close", "mark", 0);
    token.markup = match[0];
    if (open) token.attrSet("color", color);
  }
  state.pos += match[0].length;
  return true;
});
tokenizer.inline.ruler2.push("pages_highlight_balance", (state) => {
  let open = null;
  const literal = (token) => {
    token.type = "text";
    token.tag = "";
    token.content = token.markup;
    token.attrs = null;
  };
  for (const token of state.tokens) {
    if (token.type === "pages_highlight_open") {
      if (open) literal(token);
      else open = token;
    } else if (token.type === "pages_highlight_close") {
      if (open) open = null;
      else literal(token);
    }
  }
  if (open) literal(open);
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
const imageAlt = (tokens) =>
  (tokens ?? [])
    .map((token) =>
      token.children
        ? imageAlt(token.children)
        : ["softbreak", "hardbreak"].includes(token.type)
          ? "\n"
          : token.content,
    )
    .join("");
const imageToken = {
  node: "image",
  getAttrs: (token) => ({
    src: token.attrGet("src"),
    title: token.attrGet("title") || null,
    // The upstream parser takes only the first child. Escaped punctuation and
    // entities split alt text into multiple tokens, all of which belong here.
    alt: imageAlt(token.children),
  }),
};
const parser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  image: imageToken,
  task_list: { block: "task_list" },
  list_item: {
    block: "list_item",
    getAttrs: (token) => ({ checked: token.attrGet("checked") ?? null }),
  },
  table: { block: "table", attrs: { isAmgBlock: true } },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row", attrs: { isAmgBlock: true } },
  th: { block: "table_header", getAttrs: cellAttrs },
  td: { block: "table_cell", getAttrs: cellAttrs },
  pages_highlight: { mark: "highlight", getAttrs: (token) => ({ color: token.attrGet("color") }) },
});
const plainImportParser = new MarkdownParser(
  schema,
  new MarkdownIt("commonmark", { html: false, linkify: false }),
  { ...defaultMarkdownParser.tokens, image: imageToken },
);
// Marks with "markdown": "html" in the registry project as their one fixed tag.
// A mark this build doesn't know projects as its plain text. Edit it through
// replace_match and format_match, which work on native spans.
const markSerializers = {
  ...defaultMarkdownSerializer.marks,
  highlight: {
    open: (_state, mark) => `<mark data-color="${mark.attrs.color}">`,
    close: "</mark>",
    // Not mixable: strong and em always open outside a highlight. Reordering
    // them inside it makes a strong run reopen after </mark> with a leading
    // space, which Markdown reads as literal asterisks.
  },
  unknownMark: { open: "", close: "", mixable: true },
};
for (const { name } of MARK_REGISTRY.marks)
  if (!markSerializers[name]) throw Error(`No Markdown projection for mark ${name}`);
// Literal text that looks like a highlight tag is escaped so it reads back as text.
const literalHighlightTag = /<(?=\/?mark\b)/gi;
const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    task_list(state, node) {
      // The Markdown list marker is '- '; '[x] ' belongs to the paragraph.
      // Six-space continuation would turn later paragraphs into code blocks.
      state.renderList(node, "  ", (index) =>
        node.child(index).attrs.checked ? "- [x] " : "- [ ] ",
      );
    },
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
  markSerializers,
  { escapeExtraCharacters: literalHighlightTag },
);

const tableCellSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    hard_break(state) {
      state.write("<br>");
    },
  },
  markSerializers,
  { escapeExtraCharacters: /</g },
);

// Conservative import gate: unknown syntax is opaque rather than silently discarded.
export function parseMarkdown(source, importId = "", kind = "markdown") {
  // A task followed by an ordinary inline link is not a reference-link pair.
  // Keep the conservative gate, but omit recognized task prefixes from its scan.
  const syntax = source.replace(/^(\s*(?:>\s*)*[-+*][ \t]+)\[[ xX]\](?=[ \t]|$)/gm, "$1");
  const unsupported =
    kind !== "markdown" ||
    /(^|\n)\s*(<(?!\/?mark[ \t\r\n>])|\$\$|---\s*$)|\$[^\n$]+\$|!?\[[^\]]*\]\s*\[|^\s*\[[^\]]+\]:|~~/im.test(
      syntax,
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
// Markdown has no empty paragraph. The serializer writes an empty leading
// paragraph as a blank line, which parsers ignore, so drop it rather than
// suggest the newline is content.
export function exportMarkdown(doc) {
  return serializer.serialize(doc).replace(/^\n+/, "");
}

export const RICH_FORMAT = "automerge-rich-text-v1";
export const textPath = (id) => ["blocks", id, "richText"];
export const isRich = (block) => block?.format === RICH_FORMAT;
// Code text is unformatted: ProseMirror's code_block allows no marks and a
// Markdown fence can't express them. Marks a writer left on code text are not
// read, so one stray mark can't make the whole Page unreadable.
export function codeTextUnmarked(spans) {
  let code = false;
  return spans.map((span) => {
    if (span.type === "block") code = String(span.value?.type) === "code-block";
    return code && span.type === "text" && Object.keys(span.marks ?? {}).length
      ? { ...span, marks: {} }
      : span;
  });
}
export const richDoc = (block) =>
  pmDocFromSpans(adapter, codeTextUnmarked(A.spans(block, ["richText"])));
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
    updateSpansConfig,
  );
}
export function setRichImage(doc, id, { src, alt }) {
  // Construct the embed directly: alt text is content, never Markdown syntax.
  const tree = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.node("image", { src, alt, title: null })]),
  ]);
  A.updateSpans(doc, textPath(id), pmNodeToSpans(adapter, tree), updateSpansConfig);
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
        markSpec(name);
        try {
          validateMarkValue(name, value);
        } catch {
          throw Error(name === "link" ? "Invalid rich link" : "Invalid rich mark value");
        }
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
      if (String(value.type) === "task-list-item" && typeof value.attrs.checked !== "boolean")
        throw Error("Invalid task checked state");
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
