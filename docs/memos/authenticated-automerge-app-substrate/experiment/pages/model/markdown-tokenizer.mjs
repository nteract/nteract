// The Pages Markdown tokenizer: markdown-it with the Pages rules (task items,
// table line breaks, highlight tags) and the lossy-construct rules that record
// `env.pagesLossy`. Token-level only; it builds no document tree.
import MarkdownIt from "markdown-it";
import { DEFAULT_HIGHLIGHT, normalizeHighlight, safeUrl } from "./marks.mjs";

// Keep bare URLs and email addresses as prose. Use a private tokenizer so table
// support does not mutate other consumers of the default Markdown parser.
export const tokenizer = new MarkdownIt("commonmark", {
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
// Tag whitespace is ASCII only, as in CommonMark. Both patterns are
// anchored at one `<`. Every run of spaces is followed by `data-color`, `=`, a
// quote or `>`, none of which is a space, so giving back a space fails on the
// next character. One attempt reads its run of spaces a bounded number of
// times, and attempts at different `<` read different runs.
export const HIGHLIGHT_OPEN =
  /^<mark(?:[ \t\r\n]+data-color[ \t\r\n]*=[ \t\r\n]*(?:"([^"<>]*)"|'([^'<>]*)'))?[ \t\r\n]*>/i;
export const HIGHLIGHT_CLOSE = /^<\/mark[ \t\r\n]*>/i;
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
export function splitCells(text) {
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
export const imageAlt = (tokens) =>
  (tokens ?? [])
    .map((token) =>
      token.children
        ? imageAlt(token.children)
        : ["softbreak", "hardbreak"].includes(token.type)
          ? "\n"
          : token.content,
    )
    .join("");
