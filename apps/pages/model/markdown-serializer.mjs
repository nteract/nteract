import { dataframeLine } from "../shared/dataset-assets.mjs";
// Pages Markdown from the Wordgard editor tree: the projection for reads and
// exports. DOM-free and ProseMirror-free, so the Worker and the browser share
// it.
//
// The output follows CommonMark escaping, mark nesting and block separation,
// plus the Pages rules below.
// model/markdown-serializer.test.mjs pins it byte for byte against a frozen
// corpus. A change to any rule here changes what agents read and write back.
//
import { MARK_REGISTRY } from "./marks.mjs";
import { readDataframe } from "../shared/dataset-assets.mjs";
import { readViewNode, viewLine } from "../shared/views.mjs";
import { escapeLiteralSyntax } from "./markdown-scan.mjs";
import { dataframeLabel, unknownNodeNotice } from "./richtext-notices.mjs";
import {
  Alignment,
  Aside,
  Blockquote,
  BulletList,
  Code,
  CodeBlock,
  CodeBlockLanguage,
  Emphasis,
  Heading,
  HorizontalRule,
  LineBreak,
  ListItem,
  OrderedList,
  PagesDataframe,
  PagesView,
  PagesForeignMarks,
  PagesHighlight,
  PagesImage,
  PagesLink,
  PagesUnknownBlock,
  PagesUnknownEmbed,
  Paragraph,
  Strikethrough,
  Strong,
  Table,
  TaskChecked,
  TaskList,
} from "./wordgard-doc.mjs";

// --- Marks -----------------------------------------------------------------

// Registry order is the Markdown nesting order: code is the innermost known
// mark. Marks this build doesn't know (PagesForeignMarks) are one mark that
// writes nothing, ranked after every known mark. It still separates text
// runs, and inside a code span it makes the code text escaped.
const MARK_RANK = new Map(
  [...MARK_REGISTRY.marks.map(({ name }) => name), "foreign"].map((name, index) => [name, index]),
);
const markName = (mark) => {
  switch (mark.type) {
    case Strong.type:
      return "strong";
    case Emphasis.type:
      return "em";
    case Strikethrough.type:
      return "strike";
    case Code.type:
      return "code";
    case PagesLink:
      return "link";
    case PagesHighlight:
      return "highlight";
    case PagesForeignMarks:
      return "foreign";
    default:
      return null;
  }
};
/** A text node's marks as the serializer reads them: `{ name, value }` in
 * registry order. Each array keeps its own objects, so a mark can be checked
 * for being a node's innermost mark by identity. */
function serialMarks(marks) {
  const out = [];
  for (const mark of marks) {
    // A mark with no projection writes nothing: its text reads unmarked.
    const name = markName(mark);
    if (name && MARKS[name]) out.push({ name, value: mark.value });
  }
  return out.sort((a, b) => MARK_RANK.get(a.name) - MARK_RANK.get(b.name));
}
// Stored links read with a missing href or title as "" (an empty title is no
// title), so they compare that way.
const linkKey = (value) => `${value?.href || ""}\u0000${value?.title || ""}`;
// Structural equality of stored values, as ProseMirror compares mark attrs.
const sameValue = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
  );
};
const markEq = (a, b) =>
  a === b ||
  (a.name === b.name &&
    (a.name === "link"
      ? linkKey(a.value) === linkKey(b.value)
      : a.name === "highlight" || a.name === "foreign"
        ? sameValue(a.value, b.value)
        : true));
const inSet = (mark, set) => set.some((other) => markEq(mark, other));

const backticksFor = (node, side) => {
  let len = 0;
  if (node.isText) for (const run of node.text.match(/`+/g) ?? []) len = Math.max(len, run.length);
  let result = len > 0 && side > 0 ? " `" : "`";
  result += "`".repeat(len);
  if (len > 0 && side < 0) result += " ";
  return result;
};
const isPlainURL = (link, parent, index) => {
  const { href, title } = link.value;
  if (title || !/^\w+:/.test(href)) return false;
  const content = parent[index];
  if (!content.isText || content.text !== href || content.marks.at(-1) !== link) return false;
  return index === parent.length - 1 || !inSet(link, parent[index + 1].marks);
};
const MARKS = {
  em: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
  strong: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
  link: {
    open(state, mark, parent, index) {
      state.inAutolink = isPlainURL(mark, parent, index);
      return state.inAutolink ? "<" : "[";
    },
    close(state, mark) {
      const { inAutolink } = state;
      state.inAutolink = undefined;
      if (inAutolink) return ">";
      const { href, title } = mark.value;
      return `](${href.replace(/[()"]/g, "\\$&")}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
    },
    mixable: true,
  },
  code: {
    open: (_state, _mark, parent, index) => backticksFor(parent[index], -1),
    close: (_state, _mark, parent, index) => backticksFor(parent[index - 1], 1),
    escape: false,
  },
  strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  // Not mixable: strong and em always open outside a highlight. Reordering
  // them inside it makes a strong run reopen after </mark> with a leading
  // space, which Markdown reads as literal asterisks.
  highlight: { open: (_state, mark) => `<mark data-color="${mark.value}">`, close: "</mark>" },
  foreign: { open: "", close: "", mixable: true },
};
for (const { name } of MARK_REGISTRY.marks)
  if (!MARKS[name]) throw Error(`No Markdown projection for mark ${name}`);

// --- The tree as the serializer reads it -------------------------------------

/** What a node is, for the serializer. Inline content is read through
 * `inlineItems`, so text appears there, never here. */
function kind(node) {
  switch (node.type) {
    case Paragraph.type:
      return "paragraph";
    case Heading:
      return "heading";
    case CodeBlock.type:
      return "code_block";
    case Blockquote.type:
      return "blockquote";
    case HorizontalRule.type:
      return "horizontal_rule";
    case BulletList.type:
      return "bullet_list";
    case OrderedList:
      return "ordered_list";
    case TaskList.type:
      return "task_list";
    case ListItem.type:
      return "list_item";
    case Table.type:
      return "table";
    case PagesDataframe:
      return "dataframe";
    case PagesView:
      return "view";
    case PagesUnknownBlock:
      return "unknownBlock";
    case Aside.type:
      return "aside";
    default:
      return node.name;
  }
}
/** What an inline leaf is, for the serializer. A leaf it has no renderer
 * for reads as the notice (unknownLeaf). */
const leafKind = (node) =>
  node.type === LineBreak.type
    ? "hard_break"
    : node.type === PagesImage
      ? "image"
      : node.type === PagesUnknownEmbed
        ? "unknownLeaf"
        : node.name;
/** A textblock's inline content: text runs with the same projected marks
 * joined (a mark this build doesn't know projects as nothing), and leaves.
 * Escaping reads a whole run at once, so a run must not be split. */
function inlineItems(content) {
  const items = [];
  for (const node of content) {
    if (node.isText) {
      const marks = serialMarks(node.marks);
      const last = items.at(-1);
      if (
        last?.isText &&
        last.marks.length === marks.length &&
        last.marks.every((mark, i) => markEq(mark, marks[i]))
      )
        last.text += String(node.param);
      else items.push({ isText: true, kind: "text", text: String(node.param), marks });
      continue;
    }
    items.push({ isText: false, marks: serialMarks(node.marks), node, kind: leafKind(node) });
  }
  return items;
}
const withText = (item, text) => ({ ...item, text });
const textContent = (node) =>
  node.content
    .map((child) =>
      child.isText ? String(child.param) : child.type === LineBreak.type ? "\n" : "",
    )
    .join("");
const children = (node) => (node.isPlot ? node.content : []);
const LIST_KINDS = new Set(["bullet_list", "ordered_list", "task_list"]);
const checked = (item) => TaskChecked.isInSet(item.tag.marks)?.value;

// --- Serializer state --------------------------------------------------------

// Literal text that looks like a highlight tag or an entity is escaped so it
// reads back as text. Each lookahead reads a bounded run.
const literalHighlightTag = /<(?=\/?mark\b)|&(?=#?[a-z0-9]{1,32};)/gi;
const cellEscapes = /<|&(?=#?[a-z0-9]{1,32};)/gi;

class State {
  constructor(nodes, escapeExtraCharacters) {
    this.nodes = nodes;
    this.escapeExtraCharacters = escapeExtraCharacters;
    this.tightLists = false;
    this.delim = "";
    // The output as chunks, and its last two characters. Reading the end of
    // a string built by appending flattens it, which would make every check
    // linear in the output so far.
    this.chunks = [];
    this.tail = "";
    // { kind } of the last closed block, until the next write separates it.
    this.closed = null;
    this.inAutolink = undefined;
    this.atBlockStart = false;
    this.inTightList = false;
  }
  get out() {
    return this.chunks.join("");
  }
  append(text) {
    if (!text) return;
    this.chunks.push(text);
    this.tail = text.length >= 2 ? text.slice(-2) : (this.tail + text).slice(-2);
  }
  flushClose(size = 2) {
    if (!this.closed) return;
    if (!this.atBlank()) this.append("\n");
    if (size > 1) {
      const delimMin = this.delim.replace(/\s+$/, "");
      for (let i = 1; i < size; i++) this.append(`${delimMin}\n`);
    }
    this.closed = null;
  }
  wrapBlock(delim, firstDelim, node, f) {
    const old = this.delim;
    this.write(firstDelim ?? delim);
    this.delim += delim;
    f();
    this.delim = old;
    this.closeBlock(node);
  }
  atBlank() {
    return this.tail === "" || this.tail.endsWith("\n");
  }
  ensureNewLine() {
    if (!this.atBlank()) this.append("\n");
  }
  write(content) {
    this.flushClose();
    if (this.delim && this.atBlank()) this.append(this.delim);
    this.append(content);
  }
  closeBlock(node) {
    this.closed = { kind: kind(node) };
  }
  text(text, escape = true) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      this.write();
      // Escape exclamation marks in front of links.
      if (!escape && lines[i][0] === "[" && /(^|[^\\])!$/.test(this.tail)) {
        const last = this.chunks.length - 1;
        this.chunks[last] = `${this.chunks[last].slice(0, -1)}\\!`;
        this.tail = "\\!";
      }
      this.append(escape ? this.esc(lines[i], this.atBlockStart) : lines[i]);
      if (i !== lines.length - 1) this.append("\n");
    }
  }
  esc(str, startOfLine = false) {
    str = str.replace(/[`*\\~[\]_]/g, (m, i) =>
      m === "_" && i > 0 && i + 1 < str.length && /\w/.test(str[i - 1]) && /\w/.test(str[i + 1])
        ? m
        : `\\${m}`,
    );
    if (startOfLine)
      str = str
        .replace(/^(\+[ ]|[-*>])/, "\\$&")
        .replace(/^(\s*)(#{1,6})(\s|$)/, "$1\\$2$3")
        .replace(/^(\s*\d+)\.\s/, "$1\\. ");
    return str.replace(this.escapeExtraCharacters, "\\$&");
  }
  render(node, parent, index) {
    (this.nodes[kind(node)] ?? unrendered)(this, node, parent, index);
  }
  renderContent(parent) {
    parent.content.forEach((node, i) => this.render(node, parent, i));
  }
  renderInlineItem(item, parent, index) {
    (this.nodes[item.kind] ?? unknownLeaf)(this, item, parent, index);
  }
  markString(mark, open, parent, index) {
    const value = open ? MARKS[mark.name].open : MARKS[mark.name].close;
    return typeof value === "string" ? value : value(this, mark, parent, index);
  }
  /** `items` is the textblock's inlineItems. */
  renderInline(items, fromBlockStart = true) {
    this.atBlockStart = fromBlockStart;
    const active = [];
    let trailing = "";
    const progress = (node, index) => {
      let marks = node ? node.marks : [];
      // Drop marks from a hard break that is the last node inside them, so no
      // newline comes just before a closing mark.
      if (node?.kind === "hard_break")
        marks = marks.filter((mark) => {
          if (index + 1 === items.length) return false;
          const next = items[index + 1];
          return inSet(mark, next.marks) && (!next.isText || /\S/.test(next.text));
        });
      let leading = trailing;
      trailing = "";
      // Whitespace at a mark's edge moves outside it.
      if (
        node?.isText &&
        marks.some((mark) => MARKS[mark.name].expelEnclosingWhitespace && !inSet(mark, active))
      ) {
        const [, lead, rest] = /^(\s*)(.*)$/m.exec(node.text);
        if (lead) {
          leading += lead;
          node = rest ? withText(node, rest) : null;
          if (!node) marks = active;
        }
      }
      if (
        node?.isText &&
        marks.some(
          (mark) =>
            MARKS[mark.name].expelEnclosingWhitespace &&
            (index === items.length - 1 || !inSet(mark, items[index + 1].marks)),
        )
      ) {
        const [, rest, trail] = /^(.*?)(\s*)$/m.exec(node.text);
        if (trail) {
          trailing = trail;
          node = rest ? withText(node, rest) : null;
          if (!node) marks = active;
        }
      }
      const inner = marks.length ? marks.at(-1) : null;
      const noEsc = inner && MARKS[inner.name].escape === false;
      const len = marks.length - (noEsc ? 1 : 0);
      // Reorder mixable marks (em, strong, strike, link) so the node's marks
      // open in the order they are already active.
      outer: for (let i = 0; i < len; i++) {
        const mark = marks[i];
        if (!MARKS[mark.name].mixable) break;
        for (let j = 0; j < active.length; j++) {
          const other = active[j];
          if (!MARKS[other.name].mixable) break;
          if (markEq(mark, other)) {
            if (i > j)
              marks = marks
                .slice(0, j)
                .concat(mark)
                .concat(marks.slice(j, i))
                .concat(marks.slice(i + 1, len));
            else if (j > i)
              marks = marks
                .slice(0, i)
                .concat(marks.slice(i + 1, j))
                .concat(mark)
                .concat(marks.slice(j, len));
            continue outer;
          }
        }
      }
      let keep = 0;
      while (keep < Math.min(active.length, len) && markEq(marks[keep], active[keep])) ++keep;
      while (keep < active.length)
        this.text(this.markString(active.pop(), false, items, index), false);
      if (leading) this.text(leading);
      if (node) {
        while (active.length < len) {
          const add = marks[active.length];
          active.push(add);
          this.text(this.markString(add, true, items, index), false);
          this.atBlockStart = false;
        }
        // Code content is never escaped.
        if (noEsc && node.isText)
          this.text(
            this.markString(inner, true, items, index) +
              node.text +
              this.markString(inner, false, items, index + 1),
            false,
          );
        else this.renderInlineItem(node, items, index);
        this.atBlockStart = false;
      }
      if (node?.isText && node.text.length > 0) this.atBlockStart = false;
    };
    items.forEach(progress);
    progress(null, items.length);
    this.atBlockStart = false;
  }
  renderList(node, delim, firstDelim) {
    if (this.closed?.kind === kind(node)) this.flushClose(3);
    else if (this.inTightList) this.flushClose(1);
    const isTight = this.tightLists;
    const prevTight = this.inTightList;
    this.inTightList = isTight;
    node.content.forEach((child, i) => {
      if (i && isTight) this.flushClose(1);
      this.wrapBlock(delim, firstDelim(i), node, () => this.render(child, node, i));
    });
    this.inTightList = prevTight;
  }
}

// --- Node rules --------------------------------------------------------------

const image = (state, item) => {
  const { alt, src, title } = item.node.param;
  state.write(
    `![${state.esc(alt || "")}](${src.replace(/[()]/g, "\\$&")}${
      title ? ` "${title.replace(/"/g, '\\"')}"` : ""
    })`,
  );
};
// The notice names a node this build doesn't know by its stored type, and
// a node the serializer has no renderer for by its editor name, which no
// notice quotes.
const noticeName = (node) =>
  node.type === PagesUnknownBlock || node.type === PagesUnknownEmbed
    ? node.param?.type
    : node.type === Aside.type
      ? "aside"
      : node.name;
// Every notice goes through `notice`, so noticeNode sees what a render
// writes as one. Set only while noticeNode renders. A stored marker this
// build can't read (PagesUnknownBlock, PagesUnknownEmbed) is left to
// markdownlessNode, which judges it by its stored name: a known type with
// unreadable values is one a Markdown rewrite recovers.
let onNotice = null;
const notice = (state, node, name = noticeName(node)) => {
  if (node.type !== PagesUnknownBlock && node.type !== PagesUnknownEmbed) onNotice?.(name);
  state.write(state.esc(unknownNodeNotice(name)));
};
const unknownLeaf = (state, item) => notice(state, item.node);
// A notice is a line of paragraph text. What follows it separates as from a
// paragraph, so a list that can't interrupt one gets its blank line.
const closeAsParagraph = (state) => (state.closed = { kind: "paragraph" });
/** A block node with no renderer: the notice, then its content, as an
 * aside reads. A textblock's inline content reads as a paragraph. */
function unrendered(state, node) {
  notice(state, node);
  closeAsParagraph(state);
  if (!node.isPlot || !node.content.length) return;
  if (node.inlineContent) {
    state.renderInline(inlineItems(node.content));
    closeAsParagraph(state);
  } else state.renderContent(node);
}
const paragraph = (state, node) => {
  state.renderInline(inlineItems(node.content));
  state.closeBlock(node);
};

// Lists have no tight attribute: the native model doesn't record blank lines
// between items. A list reads back tight unless an item holds more than one
// block besides nested lists, which Markdown can only write loose.
const looseItem = (item) => item.content.filter((child) => !LIST_KINDS.has(kind(child))).length > 1;
// Markdown lets a list interrupt a paragraph only when its first item has
// text, and an ordered one only when it starts at 1. Directly under a
// paragraph, any other list reads as that paragraph's text (or turns it into a
// setext heading), so it needs a blank line first.
const cannotInterrupt = (list) => {
  if (kind(list) === "ordered_list" && (list.tag.param ?? 1) !== 1) return true;
  const first = list.content[0]?.content?.[0];
  // Block-first items serialize with an empty marker line.
  if (!first || kind(first) !== "paragraph") return true;
  return !first.content.some((child) =>
    child.isText ? String(child.param).trim() !== "" : child.type !== LineBreak.type,
  );
};
function renderList(state, node, delim, firstDelim) {
  // A dataframe's or view's read-back link is also a Markdown paragraph.
  if (
    state.inTightList &&
    ["paragraph", "dataframe", "view"].includes(state.closed?.kind) &&
    cannotInterrupt(node)
  )
    state.flushClose(2);
  const tight = state.tightLists;
  state.tightLists = !node.content.some(looseItem);
  try {
    state.renderList(node, delim, firstDelim);
  } finally {
    state.tightLists = tight;
  }
}

// A table cell's inline content, serialized on its own: hard breaks become
// <br>, and `<` is always escaped.
const CELL_NODES = {
  paragraph,
  text: (state, item) => state.text(item.text, !state.inAutolink),
  image,
  hard_break: (state) => state.write("<br>"),
  unknownLeaf,
};
const cellMarkdown = (cell) => {
  const state = new State(CELL_NODES, cellEscapes);
  state.renderInline(
    inlineItems(cell.inlineContent ? cell.content : cell.content.flatMap(children)),
  );
  return state.out;
};
const alignmentRow = (cell) => {
  const align = Alignment.isInSet(cell.tag.marks)?.value;
  return align === "center"
    ? ":---:"
    : align === "right"
      ? "---:"
      : align === "left"
        ? ":---"
        : "---";
};

const NODES = {
  paragraph,
  heading(state, node) {
    state.write(`${"#".repeat(node.tag.param)} `);
    state.renderInline(inlineItems(node.content), false);
    state.closeBlock(node);
  },
  blockquote(state, node) {
    state.wrapBlock("> ", null, node, () => state.renderContent(node));
  },
  horizontal_rule(state, node) {
    state.write("---");
    state.closeBlock(node);
  },
  // Fences: backticks longer than any backtick run in the code. An info
  // string can't hold a backtick in a backtick fence; a tilde fence can.
  code_block(state, node) {
    const code = textContent(node);
    const params = String(node.mark(CodeBlockLanguage) ?? "");
    let fence;
    if (params.includes("`")) {
      const longest = Math.max(0, ...(code.match(/~{3,}/g) ?? []).map((run) => run.length));
      fence = "~".repeat(Math.max(3, longest + 1));
    } else {
      const backticks = code.match(/`{3,}/gm);
      fence = backticks ? `${backticks.sort().at(-1)}\`` : "```";
    }
    state.write(`${fence}${params}\n`);
    state.text(code, false);
    state.write("\n");
    state.write(fence);
    state.closeBlock(node);
  },
  // Text after a hard break starts a source line, where block syntax such as
  // `>`, `#` or a setext `=` would start a new block. Escape it as at a block
  // start.
  text(state, item, items, index) {
    if (!state.inAutolink && index > 0 && items[index - 1].kind === "hard_break") {
      state.atBlockStart = true;
      if (item.text.startsWith("=")) {
        state.text("\\=", false);
        state.atBlockStart = false;
        if (item.text.length > 1) state.text(item.text.slice(1), true);
        return;
      }
    }
    state.text(item.text, !state.inAutolink);
  },
  // A hard break with only hard breaks after it writes nothing.
  hard_break(state, _item, items, index) {
    for (let i = index + 1; i < items.length; i++)
      if (items[i].kind !== "hard_break") {
        state.write("\\\n");
        return;
      }
  },
  image,
  unknownLeaf,
  // An item that opens with a block other than a paragraph puts its marker
  // on a line of its own: on the marker's line, a rule or a nested list's
  // marker would read as a thematic break. A task box is paragraph text, so
  // a blank line follows it; otherwise a line that can't interrupt a
  // paragraph, such as a dataframe's, would join the box's text.
  list_item(state, node, parent) {
    const first = node.content[0];
    if (first && kind(first) !== "paragraph") {
      // flushClose keeps quote delimiters on blank lines without trailing spaces.
      state.closeBlock(node);
      state.flushClose(kind(parent) === "task_list" ? 2 : 1);
    }
    state.renderContent(node);
  },
  bullet_list(state, node) {
    renderList(state, node, "  ", () => "- ");
  },
  ordered_list(state, node) {
    const start = node.tag.param ?? 1;
    const width = String(start + node.content.length - 1).length;
    // Numbers aren't padded; continuation lines take the widest marker's
    // indent, which stays inside every item.
    renderList(state, node, " ".repeat(width + 2), (index) => `${start + index}. `);
  },
  task_list(state, node) {
    // The Markdown list marker is '- '; '[x] ' belongs to the paragraph.
    // Six-space continuation would turn later paragraphs into code blocks.
    renderList(state, node, "  ", (index) => (checked(node.content[index]) ? "- [x] " : "- [ ] "));
  },
  table(state, node) {
    const rows = node.content;
    const width = Math.max(...rows.map((row) => row.content.length));
    const lines = rows.map((row) => {
      // Pipes (including those in code spans) are escaped so Markdown table
      // splitting keeps them; a ragged row is padded so a later import keeps
      // every cell.
      const cells = row.content.map((cell) =>
        cellMarkdown(cell).replace(/\|/g, "\\|").replace(/\n/g, "<br>"),
      );
      while (cells.length < width) cells.push("");
      return `| ${cells.join(" | ")} |`;
    });
    const alignment = (rows[0]?.content ?? []).map(alignmentRow);
    while (alignment.length < width) alignment.push("---");
    lines.splice(1, 0, `| ${alignment.join(" | ")} |`);
    lines.forEach((line, index) => {
      if (index) state.ensureNewLine();
      // write() supplies the surrounding quote/list delimiter for every row.
      state.write(line);
    });
    state.closeBlock(node);
  },
  // A dataframe has no Markdown form. It reads as a labeled link to its
  // asset on its own line. replace_block_markdown turns that exact line back
  // into the node (setRichMarkdownKeepingNodes) and refuses a rewrite
  // without it, so the link never silently replaces the node. Attrs this
  // build can't read read as a notice, so a read never offers their src.
  dataframe(state, node) {
    const attrs = node.param;
    if (!readDataframe(attrs)) notice(state, node, "dataframe");
    else if (attrs.binding) state.write(state.esc(dataframeLine(attrs)));
    else state.write(`[${state.esc(dataframeLabel(attrs.title))}](${attrs.src})`);
    state.closeBlock(node);
  },
  // A view reads as bracketed text naming its view id, `[View: <view_id>]`:
  // only what the node stores, so the line stays the same when the view's
  // title changes, and no link, since a view has no address of its own.
  // replace_block_markdown keeps the node for that exact line, as it does a
  // dataframe's.
  view(state, node) {
    const view = readViewNode(node.param);
    if (!view) notice(state, node, "view");
    else state.write(state.esc(viewLine(view.view_id)));
    state.closeBlock(node);
  },
  // A node this build doesn't know, written by a newer build. It reads as a
  // notice naming its type, so a read never hides it. replace_block_markdown
  // refuses the block (markdownlessNode).
  unknownBlock: unrendered,
  // An aside (a container any synced client can write; a paste from outside
  // Pages makes none) has no Markdown form. It reads as the notice, then its
  // content; a Markdown rewrite refuses the block (markdownlessNode).
  aside: unrendered,
};

/** The name the first notice in `doc`'s Markdown names, `null` for a
 * notice with no quotable name, or undefined when the Markdown holds none.
 * It renders `doc` and watches `notice`, so it counts every notice the
 * serializer writes: a node or leaf with no renderer, an aside, a dataframe
 * it can't read. A stored marker this build can't read is left out; see
 * `notice`. markdownlessNode (model/richtext-spans.mjs) refuses a Markdown
 * rewrite of a block this names, so a node type added without a renderer is
 * refused rather than rewritten into literal notice text. */
export function noticeNode(doc) {
  let found;
  const outer = onNotice;
  onNotice = (name) => {
    found ??= name ?? null;
  };
  try {
    nodesMarkdown(doc.content);
  } finally {
    onNotice = outer;
  }
  return found;
}

/** Pages Markdown for top-level editor nodes. */
function nodesMarkdown(nodes) {
  const state = new State(NODES, literalHighlightTag);
  nodes.forEach((node, index) => state.render(node, null, index));
  // Markdown has no empty paragraph. The serializer writes an empty leading
  // paragraph as a blank line, which parsers ignore, so drop it rather than
  // suggest the newline is content. The pattern is anchored at the start.
  return escapeLiteralSyntax(state.out.replace(/^\n+/, ""));
}
/** Pages Markdown for a Wordgard document (`decode(spans).doc`, or a doc
 * holding a slice of one's top-level nodes). */
export const treeMarkdown = (doc) => nodesMarkdown(doc.content);

export const exportMarkdown = treeMarkdown;
