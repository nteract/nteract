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
import { FEATURE_REGISTRY, stampSpans } from "./schema-features.mjs";

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
// `raw` (`pages-opaque`) is read-only and exists only to read documents that
// still hold one. No writer creates it: Markdown import never emits it, and the
// Page host replaces every stored one with native content on load (see
// raw-migration.mjs). Remove it once no stored Page can hold one.
nodes.raw = {
  group: "block",
  content: "text*",
  marks: "",
  atom: true,
  selectable: true,
  attrs: {
    source: { default: "" },
    importId: { default: "" },
    kind: { default: "markdown" },
  },
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
    {
      class: "opaque",
      contenteditable: "false",
      "aria-label": `Preserved ${node.attrs.kind}`,
    },
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
for (const block of FEATURE_REGISTRY.blocks.keys())
  if (!adapter.nodeMappings.some((mapping) => mapping.blockName === block))
    throw Error(`The ProseMirror schema has no block type ${block} for its schema feature`);
// The upstream adapter currently installs attrParsers only for direct mappings,
// not `within` mappings. Task items need both their list wrapper and checked
// attribute; install the parser on that one resolved mapping explicitly.
adapter.nodeMappings.find((mapping) => mapping.blockName === "task-list-item").attrParsers =
  nodes.list_item.automerge.attrParsers;
export const schema = adapter.schema;
// Keep bare URLs and email addresses as prose. Use a private tokenizer so table
// support does not mutate other consumers of the default Markdown parser.
const tokenizer = new MarkdownIt("commonmark", {
  html: false,
  linkify: false,
}).enable(["table", "strikethrough"]);
// A destination Pages can't render stays literal text, so import never writes
// a link or image that validation would then refuse.
const defaultValidateLink = tokenizer.validateLink;
tokenizer.validateLink = (url) => defaultValidateLink(url) && safeUrl(url);
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
        // Anchored at the start of the item text, with one run of spaces.
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
  // The second run of spaces follows a required `/`, so the two runs cannot
  // trade characters while backtracking.
  const match = /^<br\s*(?:\/\s*)?>/i.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) state.push("hardbreak", "br", 0);
  state.pos += match[0].length;
  return true;
});
// Highlights have no Markdown syntax. Pages reads and writes exactly
// `<mark data-color="…">` and `</mark>`; other HTML stays literal text. The
// tokenizer emits every tag it recognizes, and the balance pass below turns
// nested, unopened or unclosed tags back into their source text.
// Tag whitespace is ASCII only, matching the Rust codec. Both patterns are
// anchored at one `<`. Every run of spaces is followed by `data-color`, `=`, a
// quote or `>`, none of which is a space, so giving back a space fails on the
// next character. One attempt reads its run of spaces a bounded number of
// times, and attempts at different `<` read different runs.
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
// Markdown that parses to less than its source said. Each rule records
// `{ construct, offset }` in `env.pagesLossy`, where `offset` is a source
// position for the error's line and column:
// - "table-cells": a body row with more cells than the header. The extra
//   cells are dropped.
// - "definition": a reference definition no link uses, or a second definition
//   of a label. Its destination is dropped.
// - "wrapped-image": an image inside a link, emphasis, strikethrough or
//   highlight. An image is a block marker, which can't carry a mark.
// - "empty-link": a link with no text. Its destination has nowhere to live.
// parseMarkdown keeps such source as literal text; parseAgentMarkdown
// refuses it. Positions are found with bounded reads of the source.
const lossy = (env, construct, offset) => (env.pagesLossy ??= []).push({ construct, offset });
const lineOffset = (state, line) => state.bMarks[line] + state.tShift[line];
function splitCells(text) {
  // Markdown-it's escapedSplit, returning each cell's start offset.
  const starts = [0];
  for (let i = 0, escaped = false; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x7c && !escaped) starts.push(i + 1);
    escaped = code === 0x5c;
  }
  return starts;
}
// Wrapped in place: `at` takes the rule's terminator list (`alt`) from its
// options, so each wrapper passes the original's.
const blockRule = (name) => tokenizer.block.ruler.__rules__.find((rule) => rule.name === name);
const { fn: tableRule, alt: tableAlt } = blockRule("table");
const { fn: referenceRule, alt: referenceAlt } = blockRule("reference");
tokenizer.block.ruler.at(
  "table",
  (state, startLine, endLine, silent) => {
    if (!tableRule(state, startLine, endLine, silent)) return false;
    if (silent) return true;
    const cells = (line) => {
      const start = lineOffset(state, line);
      const raw = state.src.slice(start, state.eMarks[line]);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      const starts = splitCells(text);
      // A leading and a trailing pipe open and close no cell.
      let first = 0,
        count = starts.length;
      if (text.startsWith("|")) {
        first = 1;
        count--;
      }
      if (text.endsWith("|") && !text.endsWith("\\|") && count > 0) count--;
      return { count, at: (index) => start + lead + starts[first + index] };
    };
    const columns = cells(startLine).count;
    for (let line = startLine + 2; line < state.line; line++) {
      const row = cells(line);
      if (row.count > columns) lossy(state.env, "table-cells", row.at(columns) - 1);
    }
    return true;
  },
  { alt: [...tableAlt] },
);
tokenizer.block.ruler.at(
  "reference",
  (state, startLine, endLine, silent) => {
    const before = new Set(Object.keys(state.env.references ?? {}));
    if (!referenceRule(state, startLine, endLine, silent)) return false;
    if (silent) return true;
    const added = Object.keys(state.env.references ?? {}).filter((label) => !before.has(label));
    const offset = lineOffset(state, startLine);
    if (!added.length) lossy(state.env, "definition", offset);
    else (state.env.pagesDefinitions ??= new Map()).set(added[0], offset);
    return true;
  },
  { alt: [...referenceAlt] },
);
// Record which definitions a link reads, through the object the inline rules
// look labels up in.
tokenizer.core.ruler.before("inline", "pages_reference_use", (state) => {
  const references = state.env.references;
  if (!references) return;
  const used = (state.env.pagesUsedDefinitions = new Set());
  state.env.references = new Proxy(references, {
    get(target, label) {
      if (typeof label === "string") used.add(label);
      return target[label];
    },
  });
});
tokenizer.core.ruler.after("inline", "pages_lossy", (state) => {
  const env = state.env;
  for (const [label, offset] of env.pagesDefinitions ?? [])
    if (!env.pagesUsedDefinitions?.has(label)) lossy(env, "definition", offset);
  const marks = new Set(["link_open", "strong_open", "em_open", "s_open", "pages_highlight_open"]);
  let lineStarts;
  const lineStart = (line) => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = state.src.indexOf("\n"); i >= 0; i = state.src.indexOf("\n", i + 1))
        lineStarts.push(i + 1);
    }
    return line < lineStarts.length ? lineStarts[line] : state.src.length;
  };
  // Table cells have no line map; their row's map stands in.
  let map;
  for (const token of state.tokens) {
    if (token.map) map = token.map;
    if (token.type !== "inline" || !map) continue;
    if (!token.children?.some((child) => child.type === "image" || child.type === "link_open"))
      continue;
    // Inline children have no positions: point at the nearest bracket after
    // the previous finding, within this block.
    const start = lineStart(map[0]);
    const end = lineStart(map[1]);
    let cursor = start;
    const find = (needle) => {
      const at = state.src.indexOf(needle, cursor);
      cursor = at >= 0 && at < end ? at + 1 : cursor;
      return at >= 0 && at < end ? at : start;
    };
    let depth = 0;
    const children = token.children ?? [];
    children.forEach((child, index) => {
      // Highlight tokens have nesting 0, so each close is matched by name.
      if (marks.has(child.type)) depth++;
      else if (marks.has(child.type.replace(/_close$/, "_open"))) depth--;
      if (child.type === "image" && depth > 0) lossy(env, "wrapped-image", find("!["));
      if (child.type === "link_open" && children[index + 1]?.type === "link_close")
        lossy(env, "empty-link", find("[]"));
    });
  }
  env.pagesLossy?.sort((a, b) => a.offset - b.offset);
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
  pages_highlight: {
    mark: "highlight",
    getAttrs: (token) => ({ color: token.attrGet("color") }),
  },
  s: { mark: "strike" },
  // An explicit block: the span adapter emits no marker for a leaf it infers.
  hr: { node: "horizontal_rule", attrs: { isAmgBlock: true } },
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
  strike: {
    open: "~~",
    close: "~~",
    mixable: true,
    expelEnclosingWhitespace: true,
  },
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
// Literal text that looks like a highlight tag or an entity is escaped so it
// reads back as text. Each lookahead reads a bounded run.
const literalHighlightTag = /<(?=\/?mark\b)|&(?=#?[a-z0-9]{1,32};)/gi;
const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    // A backtick fence can't hold a backtick in its info string; a tilde fence
    // can. Otherwise this is the default serializer.
    code_block(state, node) {
      if (!node.attrs.params.includes("`"))
        return defaultMarkdownSerializer.nodes.code_block(state, node);
      const longest = Math.max(
        0,
        ...(node.textContent.match(/~{3,}/g) ?? []).map((run) => run.length),
      );
      const fence = "~".repeat(Math.max(3, longest + 1));
      state.write(`${fence}${node.attrs.params}\n`);
      state.text(node.textContent, false);
      state.write("\n");
      state.write(fence);
      state.closeBlock(node);
    },
    // Text after a hard break starts a source line, where block syntax such
    // as `>`, `#` or a setext `=` would start a new block. Escape it as at a
    // block start.
    text(state, node) {
      if (!state.inAutolink && state.out.endsWith("\\\n")) {
        state.atBlockStart = true;
        if (node.text.startsWith("=")) {
          state.text(`\\=`, false);
          state.atBlockStart = false;
          if (node.text.length > 1) state.text(node.text.slice(1), true);
          return;
        }
      }
      state.text(node.text, !state.inAutolink);
    },
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
    // A preserved block the host has not converted yet projects as the
    // content it converts to, so a read never offers source a write refuses.
    raw(state, node) {
      state.renderContent(parseMarkdown(node.attrs.source, { kind: node.attrs.kind }));
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
  { escapeExtraCharacters: /<|&(?=#?[a-z0-9]{1,32};)/gi },
);

// Pages has no math node. These rules decide what Markdown counts as math:
// - A `$$` at a line start, after optional spaces, opens display math.
// - A `$$` pair on one line is display math, with or without spaces.
// - A `$` pair follows Pandoc's dollar rule: the opening `$` is followed by a
//   non-space, the closing `$` follows a non-space and is not followed by a
//   digit. Prose such as "$30 and $25" stays native text.
// When unsure, the text counts as math. Each rule spells out its spaces,
// because JS and Rust disagree on `\s` (U+0085, U+FEFF):
// - The dollar rule's spaces are ASCII whitespace, [ \t\n\v\f\r]. Any other
//   character is content, so the span counts as math.
// - Before a line-start `$$`, a space is any character either codec's `\s`
//   matched that does not start a line: ASCII space, tab, VT and FF, U+00A0,
//   U+0085, U+1680, U+2000-U+200A, U+202F, U+205F, U+3000, U+FEFF.
// A line starts at the start of input or after LF, CR, CRLF, U+2028 or
// U+2029, the line terminators of JS multiline `^`. JS `m` and Rust `(?m)`
// disagree on CR, U+2028 and U+2029, so the pattern has no multiline flag
// and writes line starts as `(?:^|\r\n?|[\n\u2028\u2029])`. Line terminators
// are not in the prefix class, so the alternatives never overlap and a run
// of line breaks is scanned once. Each repetition has disjoint branches, so
// matching is linear. Every `\uXXXX` escape is a BMP code point, which JS
// reads without the `u` flag; Rust's regex reads the same escape as the same
// code point. crates/nteract-rich-text/src/import.rs uses this pattern text,
// and its `math_pattern_matches_pages` test reads this literal. Keep it a
// flagless literal that starts on the line after `MATH_SYNTAX =`.
export const MATH_SYNTAX =
  /(?:^|\r\n?|[\n\u2028\u2029])[ \t\v\f\u00a0\u0085\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*\$\$|\$\$(?:[^\n$]|\$[^\n$])*\$\$|\$[^ \t\n\v\f\r$](?:[^ \t\n\v\f\r$]|[ \t\v\f\r]+[^ \t\n\v\f\r$])*\$(?:[^0-9]|$)/;

// Markdown Pages can't represent, and what happens to it.
//
// Every construct Markdown-it reads has a native mapping except two: math and
// HTML other than highlight tags (and `<br>` in a table cell). The scan finds
// both outside code. Code spans, fenced and indented code, and characters a
// backslash escapes are masked first, so `~~x~~` or `$x$` inside backticks is
// code, not syntax.
//
// Agent writes refuse such source with `unsupported_markdown`, naming the
// construct, line and column (`parseAgentMarkdown`). Everything else
// (preserved-block migration, legacy blocks, read projections) keeps it as
// literal, editable text: the scan's ranges are backslash-escaped before
// parsing, so math keeps its exact characters (`parseMarkdown`). Export
// escapes the same ranges, so read-then-write never trips the refusal.
//
// The scan is linear in the input. Page Markdown can be close to the record
// size limit, so no step may rescan a run of line breaks, spaces or brackets:
// code spans pair through per-length queues that only move forward, the math
// pattern runs once over the text, and each tag or link destination is read
// within a bounded window.

// Block structure only: which lines are code, tables or inline content.
const blockTokenizer = new MarkdownIt("commonmark", {
  html: false,
  linkify: false,
})
  .enable("table")
  .disable(["inline", "text_join"]);
const MASKED = "\u0000";
const isAsciiPunctuation = (code) =>
  (code >= 0x21 && code <= 0x2f) ||
  (code >= 0x3a && code <= 0x40) ||
  (code >= 0x5b && code <= 0x60) ||
  (code >= 0x7b && code <= 0x7e);
// Markdown-it reads CRLF and CR as LF and NUL as U+FFFD before parsing. The
// scan reads the same text, so its line numbers are Markdown-it's lines.
const normalizeSource = (source) =>
  String(source).replace(/\r\n?/g, "\n").replaceAll("\u0000", "\ufffd");

// Mark code spans and backslash escapes in source[start, end). A backtick run
// opens a span when its first backtick is not escaped; the span closes at the
// next run of exactly the same length. Inside a span, backslashes are literal.
function maskInline(source, masked, start, end) {
  const runs = new Map(); // length -> start offsets of maximal backtick runs
  for (let i = start; i < end; ) {
    if (source.charCodeAt(i) !== 0x60) {
      i++;
      continue;
    }
    let j = i;
    while (j < end && source.charCodeAt(j) === 0x60) j++;
    if (!runs.has(j - i)) runs.set(j - i, { at: 0, starts: [] });
    runs.get(j - i).starts.push(i);
    i = j;
  }
  const closer = (length, after) => {
    const queue = runs.get(length);
    if (!queue) return -1;
    while (queue.at < queue.starts.length && queue.starts[queue.at] < after) queue.at++;
    return queue.at < queue.starts.length ? queue.starts[queue.at] : -1;
  };
  for (let i = start; i < end; ) {
    const code = source.charCodeAt(i);
    if (code === 0x5c && i + 1 < end && isAsciiPunctuation(source.charCodeAt(i + 1))) {
      masked[i + 1] = 1;
      i += 2;
      continue;
    }
    if (code !== 0x60) {
      i++;
      continue;
    }
    let j = i;
    while (j < end && source.charCodeAt(j) === 0x60) j++;
    const close = closer(j - i, j);
    if (close < 0) {
      i = j;
      continue;
    }
    masked.fill(1, i, close + (j - i));
    i = close + (j - i);
  }
}

// Link destinations and titles, after `](` or a definition's `]:`, are URLs
// and quoted text, never math or HTML: `[a](<x>)` is a link to `x`. Each is
// read with Markdown-it's own helpers, at most LINK_WINDOW characters, so each
// `]` costs a bounded read. A longer destination is scanned like prose. A `](`
// Markdown-it doesn't read as a link stays masked too; that only accepts text
// Markdown-it keeps literal anyway.
const LINK_WINDOW = 4096;
const { parseLinkDestination, parseLinkTitle } = tokenizer.helpers;
function maskDestinations(source, masked) {
  const skipSpace = (at, newlines) => {
    while (at < source.length) {
      const code = source.charCodeAt(at);
      if (code === 0x0a) {
        if (!newlines--) break;
      } else if (code !== 0x20 && code !== 0x09) break;
      at++;
    }
    return at;
  };
  for (let at = source.indexOf("]"); at >= 0; at = source.indexOf("]", at + 1)) {
    const next = source.charCodeAt(at + 1);
    if (masked[at] || (next !== 0x28 && next !== 0x3a)) continue;
    const start = skipSpace(at + 2, 1);
    const destination = parseLinkDestination(
      source,
      start,
      Math.min(source.length, start + LINK_WINDOW),
    );
    if (!destination.ok) continue;
    let end = destination.pos;
    const titleStart = skipSpace(end, 1);
    if (titleStart > end) {
      const title = parseLinkTitle(
        source,
        titleStart,
        Math.min(source.length, titleStart + LINK_WINDOW),
      );
      if (title.ok) end = title.pos;
    }
    masked.fill(1, start, end);
    at = end - 1;
  }
}

/**
 * Math and HTML outside code in the normalized `source`. Returns `found`, the
 * `{ construct, start, end }` ranges in order and not overlapping, and
 * `masked`, which flags each code or escaped position.
 */
function scanMarkdown(source, tokens = blockTokenizer.parse(source, {})) {
  const lineStarts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1))
    lineStarts.push(i + 1);
  const offset = (line) => (line < lineStarts.length ? lineStarts[line] : source.length);
  const masked = new Uint8Array(source.length);
  // Inline content, as `[start, end, inTable]`, in order: where code spans
  // pair and where HTML can be. A table cell is its own range, as Markdown-it
  // splits cells before reading their inline content.
  const inline = [];
  for (const token of tokens) {
    if (!token.map) continue;
    const start = offset(token.map[0]),
      end = offset(token.map[1]);
    if (token.type === "fence" || token.type === "code_block") masked.fill(1, start, end);
    else if (token.type === "inline") inline.push([start, end, false]);
    else if (token.type === "table_open")
      for (let line = token.map[0]; line < token.map[1]; line++) {
        if (line === token.map[0] + 1) continue; // the delimiter row
        const lineStart = offset(line);
        const lineEnd = Math.max(lineStart, offset(line + 1) - 1);
        const starts = splitCells(source.slice(lineStart, lineEnd));
        starts.forEach((cell, index) =>
          inline.push([
            lineStart + cell,
            index + 1 < starts.length ? lineStart + starts[index + 1] - 1 : lineEnd,
            true,
          ]),
        );
      }
  }
  for (const [start, end] of inline) maskInline(source, masked, start, end);
  maskDestinations(source, masked);
  // Line breaks stay, so the line-start rules still see every line.
  let text = source;
  if (masked.includes(1)) {
    const chars = source.split("");
    for (let i = 0; i < chars.length; i++) if (masked[i] && chars[i] !== "\n") chars[i] = MASKED;
    text = chars.join("");
  }
  const found = [];
  const math = new RegExp(MATH_SYNTAX.source, "g");
  const blank = /\n[ \t]*\n/g;
  let paragraphEnd = -1;
  for (let match = math.exec(text); match; match = math.exec(text)) {
    const first = match.index + match[0].indexOf("$"),
      matched = match.index + match[0].length;
    let end;
    if (matched - first === 2) {
      // A line-start `$$` opens display math. It runs to the next `$$` before
      // a blank line, or to that blank line.
      if (paragraphEnd < matched) {
        blank.lastIndex = matched;
        paragraphEnd = blank.exec(text)?.index ?? text.length;
      }
      const close = text.indexOf("$$", matched);
      end = close >= 0 && close < paragraphEnd ? close + 2 : paragraphEnd;
    } else if (text[first + 1] === "$") end = matched;
    // The dollar rule's body holds no `$`, and its match may read one more
    // character after the closing `$`.
    else end = text.indexOf("$", first + 1) + 1;
    found.push({ construct: "math", start: first, end });
    math.lastIndex = end;
  }
  const mathCount = found.length;
  let inMath = 0;
  const tags = text.includes("<") ? tagMatcher(text) : null;
  for (const [rangeStart, rangeEnd, inTable] of tags ? inline : []) {
    for (let at = text.indexOf("<", rangeStart); at >= 0 && at < rangeEnd; ) {
      while (inMath < mathCount && found[inMath].end <= at) inMath++;
      if (inMath < mathCount && found[inMath].start <= at) {
        at = text.indexOf("<", found[inMath].end);
        continue;
      }
      const end = tags.match(at, rangeEnd);
      if (end < 0) {
        at = text.indexOf("<", at + 1);
        continue;
      }
      const tag = text.slice(at, end);
      const highlight = [HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE].some((pattern) => {
        const match = pattern.exec(tag);
        return match?.[0].length === tag.length && highlightColorValid(match);
      });
      const tableBreak = inTable && TABLE_BREAK.exec(tag)?.[0].length === tag.length;
      if (!highlight && !tableBreak) found.push({ construct: "html", start: at, end });
      at = text.indexOf("<", end);
    }
  }
  // An HTML comment or instruction can span a math range. Overlapping ranges
  // merge, and the first one names the construct.
  const merged = [];
  for (const range of found.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return { found: merged, masked };
}

// CommonMark raw HTML, recognized at a `<` within an inline range: an open or
// closing tag, a comment, a processing instruction, a declaration or CDATA.
// `match(at, end)` returns the tag's end, or -1. Whitespace is ASCII, as in
// CommonMark and the Rust codec.
//
// The work is linear in the text. A quoted attribute value jumps to its
// closing quote through a precomputed next-quote table. Comment, instruction,
// declaration and CDATA ends come from forward searches whose start only
// moves forward, so no stretch of text is searched twice. Walks over names,
// spaces and unquoted values cost one step a character, and only a quoted
// value can hold a later `<`, so a re-walk needs a quote pair; past a budget
// of steps (only adversarial input reaches it) every remaining `<` reads as
// HTML, which only ever escapes it.
function tagMatcher(text) {
  const length = text.length;
  const nextOf = (char) => {
    const table = new Int32Array(length + 1).fill(-1);
    for (let i = length - 1; i >= 0; i--) table[i] = text[i] === char ? i : table[i + 1];
    return table;
  };
  let doubleQuote, singleQuote;
  const searches = new Map();
  const after = (needle, from) => {
    let search = searches.get(needle);
    if (!search) searches.set(needle, (search = { from: -1, at: -1 }));
    if (from < search.from || (search.at >= 0 && from > search.at) || search.from < 0) {
      search.from = from;
      search.at = text.indexOf(needle, from);
    }
    return search.at;
  };
  let budget = 16 * length + 4096;
  const code = (i) => text.charCodeAt(i);
  const isSpace = (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  const isLetter = (c) => (c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a;
  const isDigit = (c) => c >= 0x30 && c <= 0x39;
  const nameChar = (c) => isLetter(c) || isDigit(c) || c === 0x2d;
  const attrStart = (c) => isLetter(c) || c === 0x5f || c === 0x3a;
  const attrChar = (c) => attrStart(c) || isDigit(c) || c === 0x2e || c === 0x2d;
  // Not space or a control character, and not one of " ' = < > `.
  const unquoted = (c) =>
    c > 0x20 && c !== 0x22 && c !== 0x27 && c !== 0x3d && c !== 0x3c && c !== 0x3e && c !== 0x60;
  const bounded = (at, needle, end) =>
    at >= 0 && at + needle.length <= end ? at + needle.length : -1;
  function match(at, end) {
    if (budget < 0) return at + 1;
    const walk = (i, test) => {
      const start = i;
      while (i < end && test(code(i))) i++;
      budget -= i - start + 1;
      return i;
    };
    const next = code(at + 1);
    if (next === 0x21) {
      if (text.startsWith("<!--", at)) {
        if (text.startsWith("<!-->", at)) return at + 5 <= end ? at + 5 : -1;
        if (text.startsWith("<!--->", at)) return at + 6 <= end ? at + 6 : -1;
        return bounded(after("-->", at + 4), "-->", end);
      }
      if (text.startsWith("<![CDATA[", at)) return bounded(after("]]>", at + 9), "]]>", end);
      if (isLetter(code(at + 2))) return bounded(after(">", at + 2), ">", end);
      return -1;
    }
    if (next === 0x3f) return bounded(after("?>", at + 2), "?>", end);
    if (next === 0x2f) {
      if (!isLetter(code(at + 2))) return -1;
      const i = walk(walk(at + 3, nameChar), isSpace);
      return i < end && code(i) === 0x3e ? i + 1 : -1;
    }
    if (!isLetter(next)) return -1;
    let i = walk(at + 2, nameChar);
    for (;;) {
      const spaced = walk(i, isSpace);
      if (spaced < end && code(spaced) === 0x3e) return spaced + 1;
      if (spaced + 1 < end && code(spaced) === 0x2f && code(spaced + 1) === 0x3e) return spaced + 2;
      if (spaced === i || spaced >= end || !attrStart(code(spaced))) return -1;
      i = walk(spaced + 1, attrChar);
      let j = walk(i, isSpace);
      if (j >= end || code(j) !== 0x3d) continue;
      j = walk(j + 1, isSpace);
      const quote = code(j);
      if (quote === 0x22 || quote === 0x27) {
        const table =
          quote === 0x22 ? (doubleQuote ??= nextOf('"')) : (singleQuote ??= nextOf("'"));
        const close = j + 1 <= length ? table[j + 1] : -1;
        if (close < 0 || close >= end) return -1;
        budget--;
        i = close + 1;
      } else {
        const valueEnd = walk(j, unquoted);
        if (valueEnd === j) return -1;
        i = valueEnd;
      }
    }
  }
  return { match };
}
const TABLE_BREAK = /^<br\s*(?:\/\s*)?>/i;
function highlightColorValid(match) {
  if (match[1] === undefined && match[2] === undefined) return true;
  try {
    normalizeHighlight(match[1] ?? match[2]);
    return true;
  } catch {
    return false;
  }
}

const CONSTRUCTS = {
  "table-cells": {
    name: "A table row with more cells than its header",
    advice:
      "Add the missing header cells, or remove the extra cells, so every row matches the header.",
  },
  definition: {
    name: "A reference definition no link uses (or a repeated label)",
    advice:
      "Use it in a link such as [text][label], or remove it. Write [label]: as \\[label]: to keep it as text.",
  },
  "wrapped-image": {
    name: "An image inside a link or formatting",
    advice:
      "Pages images can't be linked or formatted. Put the image on its own and the link next to it.",
  },
  "empty-link": {
    name: "A link with no text",
    advice: "Give the link text, as in [text](url).",
  },
  unrepresentable: {
    name: "Markdown that Pages would store with content missing",
    advice:
      "Simplify it: give every link visible text, and keep images out of links, formatting and table line breaks.",
  },
  math: {
    name: "Math",
    advice:
      "Pages has no math. Put it in a code span or a ```math code block, or escape each $ as \\$ to keep it as text.",
  },
  html: {
    name: "HTML",
    advice:
      'Use Markdown instead. Highlights use <mark data-color="...">; to keep a tag as text, put it in a code span or escape < as \\<.',
  },
};

/** The first construct Pages can't represent in `source`, outside code, as
 * `{ construct, line, column, excerpt }`, or null. Line and column are
 * 1-based; the column counts characters (code points) in that line. */
export function unsupportedMarkdown(source) {
  const text = normalizeSource(source);
  const env = {};
  return firstUnsupported(text, tokenizer.parse(text, env), env);
}
// The earliest construct, math and HTML or lossy, located.
function firstUnsupported(text, tokens, env) {
  const [range] = scanMarkdown(text, tokens).found;
  const [lost] = env.pagesLossy ?? [];
  if (!range && !lost) return null;
  if (range && (!lost || range.start <= lost.offset)) return locate(text, range);
  return locate(text, {
    construct: lost.construct,
    start: lost.offset,
    end: lost.offset + 40,
  });
}
function locate(text, first) {
  const lineStart = text.lastIndexOf("\n", first.start - 1) + 1;
  const lineEnd = text.indexOf("\n", first.start);
  const excerpt = text.slice(first.start, Math.min(first.end, lineEnd < 0 ? Infinity : lineEnd));
  return {
    construct: first.construct,
    line: text.slice(0, lineStart).split("\n").length,
    // Code points, not UTF-16 units.
    column: Array.from(text.slice(lineStart, first.start)).length + 1,
    excerpt: [...excerpt].slice(0, 80).join(""),
  };
}

/** The refusal for agent-written Markdown Pages can't represent. */
export function unsupportedMarkdownError(found) {
  const { name, advice } = CONSTRUCTS[found.construct];
  return Object.assign(
    Error(
      `${name} at line ${found.line}, column ${found.column} (${JSON.stringify(found.excerpt)}) isn't supported in Pages Markdown. ${advice}`,
    ),
    {
      status: 400,
      code: "unsupported_markdown",
      details: { unsupported: found },
    },
  );
}

// Backslash-escape every ASCII punctuation character in each range, outside
// code, so Markdown-it reads the range as its literal characters. A line break
// between two lines of display math becomes a hard break, so it keeps its
// lines.
function literalize(source, { found, masked }) {
  if (!found.length) return source;
  let result = "",
    copied = 0;
  for (const { construct, start, end } of found) {
    result += source.slice(copied, start);
    for (let i = start; i < end; i++) {
      const code = source.charCodeAt(i);
      if (!masked[i]) {
        if (
          construct === "math" &&
          code === 0x0a &&
          i > start &&
          i + 1 < end &&
          source[i - 1] !== "\n" &&
          source[i + 1] !== "\n" &&
          !masked[i + 1]
        )
          result += "\\";
        else if (isAsciiPunctuation(code)) result += "\\";
      }
      result += source[i];
    }
    copied = end;
  }
  return result + source.slice(copied);
}

// Non-Markdown content is text: one paragraph per run of lines, each line
// break a hard break.
function literalDoc(source) {
  const paragraphs = normalizeSource(source)
    .split(/\n[ \t]*\n/)
    .filter((part) => part.trim())
    .map((part) =>
      schema.node(
        "paragraph",
        null,
        // Line breaks at a paragraph's edges separate it; they aren't content.
        part
          .replace(/^\n+|\n+$/g, "")
          .split("\n")
          .flatMap((line, index) => [
            ...(index ? [schema.node("hard_break")] : []),
            ...(line ? [schema.text(line)] : []),
          ]),
      ),
    );
  return schema.node("doc", null, paragraphs.length ? paragraphs : [schema.node("paragraph")]);
}

/**
 * Markdown as native rich text. Math and HTML Pages can't represent stay as
 * literal text, so this never fails on content and never writes a preserved
 * block. Content whose `kind` is not Markdown is all literal text. Use
 * `parseAgentMarkdown` for agent writes, which refuses such source instead.
 */
export function parseMarkdown(source, { kind = "markdown" } = {}) {
  if (kind !== "markdown") return literalDoc(source);
  const text = normalizeSource(source);
  let env = {};
  let tokens = tokenizer.parse(text, env);
  const scan = scanMarkdown(text, tokens);
  if (scan.found.length) tokens = tokenizer.parse(literalize(text, scan), (env = {}));
  // Markdown that would parse to less than it says stays literal, all of it.
  if (env.pagesLossy?.length) return literalDoc(source);
  const doc = parseTokens(tokens);
  return lostContent(tokens, doc) ? literalDoc(source) : doc;
}

/** What the native parse of `source` would lose, before parseMarkdown
 * falls back to literal text: `lostContent` of that parse, or null. For
 * tests and diagnostics. */
export function nativeImportLoss(source) {
  const text = normalizeSource(source);
  let env = {};
  let tokens = tokenizer.parse(text, env);
  const scan = scanMarkdown(text, tokens);
  if (scan.found.length) tokens = tokenizer.parse(literalize(text, scan), (env = {}));
  if (env.pagesLossy?.length) return { kind: "lossy-rule" };
  return lostContent(tokens, parseTokens(tokens));
}

/**
 * The general preservation check, behind the specific lossy rules: what the
 * parsed Markdown carried that the native spans don't. Every link must hold
 * visible text of its own, every link href must be in the spans, every image
 * occurrence (src and alt) must have its own marker, and all visible text
 * must match with whitespace removed. Returns `{ kind, value }` for the first loss, or null.
 *
 * The specific rules name a construct for the error; this catches whatever
 * they miss, such as a link whose only content is a line break.
 */
export function lostContent(tokens, doc) {
  const carried = { text: [], links: new Set(), images: [], bareLink: null };
  // Each link must hold visible text of its own: links are marks on text, so
  // one with only a line break or an image has nowhere to keep its href,
  // whatever other links share it.
  const walk = (list) => {
    let open = null;
    for (const token of list) {
      if (token.type === "inline") walk(token.children ?? []);
      else if (["text", "code_inline", "fence", "code_block"].includes(token.type)) {
        carried.text.push(token.content);
        if (open && token.content) open.text = true;
      } else if (token.type === "link_open") {
        open = { href: token.attrGet("href"), text: false };
        carried.links.add(open.href);
      } else if (token.type === "link_close" && open) {
        if (!open.text) carried.bareLink ??= open.href;
        open = null;
      } else if (token.type === "image")
        carried.images.push(JSON.stringify([token.attrGet("src"), imageAlt(token.children) ?? ""]));
    }
  };
  walk(tokens);
  if (carried.bareLink !== null) return { kind: "link", value: carried.bareLink };
  const produced = { text: [], links: new Set(), images: [] };
  for (const span of pmNodeToSpans(adapter, doc)) {
    if (span.type === "text") {
      produced.text.push(span.value);
      const link = span.marks?.link;
      if (link) produced.links.add(JSON.parse(String(link)).href);
    } else if (String(span.value.type) === "image") {
      const attrs = span.value.attrs ?? {};
      produced.images.push(JSON.stringify([String(attrs.src), String(attrs.alt ?? "")]));
    }
  }
  const squash = (parts) => parts.join("").replace(/\s+/g, "");
  if (squash(carried.text) !== squash(produced.text)) return { kind: "text" };
  for (const href of carried.links)
    if (!produced.links.has(href)) return { kind: "link", value: href };
  // Images are embeds, one marker each: compare every occurrence.
  const remaining = new Map();
  for (const image of produced.images) remaining.set(image, (remaining.get(image) ?? 0) + 1);
  for (const image of carried.images) {
    const left = remaining.get(image) ?? 0;
    if (!left) return { kind: "image", value: JSON.parse(image)[0] };
    remaining.set(image, left - 1);
  }
  return null;
}

/** Markdown an agent wrote, as native rich text. Throws a 400
 * `unsupported_markdown` refusal naming the first construct Pages can't
 * represent, so the agent can rewrite and retry. */
export function parseAgentMarkdown(source) {
  const text = normalizeSource(source);
  const env = {};
  const tokens = tokenizer.parse(text, env);
  const found = firstUnsupported(text, tokens, env);
  if (found) throw unsupportedMarkdownError(found);
  const doc = parseTokens(tokens);
  const lost = lostContent(tokens, doc);
  if (lost) {
    // Point at the lost destination when there is one; otherwise the start.
    const at = lost.value ? Math.max(0, text.indexOf(lost.value)) : 0;
    throw unsupportedMarkdownError(
      locate(text, { construct: "unrepresentable", start: at, end: at + 40 }),
    );
  }
  return doc;
}
// The parser over tokens this module already read, so one import tokenizes
// its source once. Synchronous: nothing else can use the parser meanwhile.
function parseTokens(tokens) {
  const own = parser.tokenizer;
  parser.tokenizer = { parse: () => tokens };
  try {
    return parser.parse("");
  } finally {
    parser.tokenizer = own;
  }
}

// Export escapes literal text that would otherwise read back as math or HTML:
// every `$` and `<` in a math or HTML range. Escaping one range can expose
// another (escaping `$a$` leaves the `$` after it unpaired, which can pair
// with a later one), so this repeats; a third pass escapes every `$` and `<`
// outside code, which always ends it. A later import, including an agent's
// write of what it read, reads the same text.
function escapeLiteralSyntax(markdown) {
  if (!markdown.includes("$") && !markdown.includes("<")) return markdown;
  for (let pass = 0; ; pass++) {
    const { found, masked } = scanMarkdown(markdown);
    if (!found.length) return markdown;
    const ranges = pass < 2 ? found : [{ start: 0, end: markdown.length }];
    let result = "",
      copied = 0;
    for (const { start, end } of ranges)
      for (let i = start; i < end; i++) {
        if (masked[i] || (markdown[i] !== "$" && markdown[i] !== "<")) continue;
        result += `${markdown.slice(copied, i)}\\`;
        copied = i;
      }
    markdown = result + markdown.slice(copied);
  }
}

// Markdown has no empty paragraph. The serializer writes an empty leading
// paragraph as a blank line, which parsers ignore, so drop it rather than
// suggest the newline is content. The pattern is anchored at the start.
export function exportMarkdown(doc) {
  return escapeLiteralSyntax(serializer.serialize(doc).replace(/^\n+/, ""));
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
  // Source that holds math or HTML is provenance only: its current projection
  // is the escaped literal text an agent can write back.
  if (unsupportedMarkdown(block.markdown)) return current;
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
  setRichMarkdown(doc, id, block.markdown, { literal: true });
}
// Rich writers stamp the schema features their spans need in the same change.
// Agent-written Markdown refuses math and HTML (`parseAgentMarkdown`); pass
// `literal: true` for stored source, which keeps them as text instead.
export function setRichMarkdown(doc, id, source, { literal = false } = {}) {
  const tree = literal ? parseMarkdown(source) : parseAgentMarkdown(source);
  const spans = pmNodeToSpans(adapter, tree);
  A.updateSpans(doc, textPath(id), spans, updateSpansConfig);
  stampSpans(doc, spans);
}
export function setRichImage(doc, id, { src, alt }) {
  // Construct the embed directly: alt text is content, never Markdown syntax.
  const tree = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.node("image", { src, alt, title: null })]),
  ]);
  const spans = pmNodeToSpans(adapter, tree);
  A.updateSpans(doc, textPath(id), spans, updateSpansConfig);
  stampSpans(doc, spans);
}
export function projectedBlock(block) {
  const { richText: _rich, ...result } = block;
  return { ...result, markdown: blockMarkdown(block) };
}

// Bound the actual spans: JSON.stringify(doc) alone misses block-marker data.
export function validateRich(block) {
  validateRichSpans(A.spans(block, ["richText"]));
}

/** Schema check for native rich-text spans read from any Automerge text
 * object: a Page block's `richText` or a comments-doc message `body`. */
export function validateRichSpans(spans, maxBytes = 262144) {
  if (new TextEncoder().encode(JSON.stringify(spans)).length > maxBytes)
    throw Error("Rich block exceeds content limit");
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
  const tree = pmDocFromSpans(adapter, codeTextUnmarked(spans));
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
