// ProseMirror boundary. model/pm-adapter.mjs, model/pm-markdown-parser.mjs
// and model/pm-markdown-serializer.mjs are the only production Pages modules
// that import ProseMirror packages (@automerge/prosemirror, prosemirror-*);
// model/pm-boundary.test.mjs checks it. Other modules reach ProseMirror trees,
// the span adapter and its traversal through these three.
//
// ProseMirror tree to Pages Markdown: the serializer for reads and exports.
import { MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";
import { MARK_REGISTRY } from "./marks.mjs";
import { readDataframe } from "../shared/dataset-assets.mjs";
import { schema } from "./pm-adapter.mjs";
import { escapeLiteralSyntax } from "./markdown-scan.mjs";
import { parseMarkdown } from "./markdown-import.mjs";
import { dataframeLabel, unknownNodeNotice } from "./richtext-notices.mjs";

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
// Lists have no tight attribute: the native model doesn't record blank lines
// between items. A list reads back tight unless an item holds more than one
// block besides nested lists, which Markdown can only write loose.
const LIST_TYPES = new Set(["bullet_list", "ordered_list", "task_list"]);
const looseItem = (item) => {
  let blocks = 0;
  item.forEach((child) => {
    if (!LIST_TYPES.has(child.type.name)) blocks++;
  });
  return blocks > 1;
};
// Markdown lets a list interrupt a paragraph only when its first item has
// text, and an ordered one only when it starts at 1. Directly under a
// paragraph, any other list reads as that paragraph's text (or turns it into a
// setext heading), so it needs a blank line first.
const cannotInterrupt = (list) => {
  if (list.type.name === "ordered_list" && (list.attrs.order ?? 1) !== 1) return true;
  const first = list.firstChild?.firstChild;
  // Block-first items serialize with an empty marker line.
  if (first?.type.name !== "paragraph") return true;
  let text = false;
  first.forEach((child) => {
    text ||= child.isText && child.text.trim() !== "";
    text ||= child.type.name !== "hard_break" && !child.isText;
  });
  return !text;
};
function renderList(state, node, delim, firstDelim) {
  // A dataframe's read-back link is also a Markdown paragraph.
  if (
    state.inTightList &&
    ["paragraph", "dataframe"].includes(state.closed?.type.name) &&
    cannotInterrupt(node)
  )
    state.flushClose(2);
  const tight = state.options.tightLists;
  let loose = false;
  node.forEach((item) => {
    loose ||= looseItem(item);
  });
  state.options.tightLists = !loose;
  try {
    state.renderList(node, delim, firstDelim);
  } finally {
    state.options.tightLists = tight;
  }
}
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
    // block start. The previous sibling says so in constant time; reading
    // `state.out` would flatten the whole output string on every text node.
    text(state, node, parent, index) {
      if (!state.inAutolink && index > 0 && parent.child(index - 1).type.name === "hard_break") {
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
    // An item that opens with a block other than a paragraph puts its marker
    // on a line of its own: on the marker's line, a rule or a nested list's
    // marker would read as a thematic break. A task box is paragraph text, so
    // a blank line follows it; otherwise a line that can't interrupt a
    // paragraph, such as a dataframe's, would join the box's text.
    list_item(state, node, parent, index) {
      if (node.firstChild && node.firstChild.type !== schema.nodes.paragraph) {
        // flushClose keeps quote delimiters on blank lines without trailing spaces.
        state.closeBlock(node);
        state.flushClose(parent.type === schema.nodes.task_list ? 2 : 1);
      }
      defaultMarkdownSerializer.nodes.list_item(state, node, parent, index);
    },
    bullet_list(state, node) {
      renderList(state, node, "  ", () => "- ");
    },
    ordered_list(state, node) {
      const start = node.attrs.order ?? 1;
      const width = String(start + node.childCount - 1).length;
      const space = " ".repeat(width + 2);
      // Numbers aren't padded; continuation lines take the widest marker's
      // indent, which stays inside every item.
      renderList(state, node, space, (index) => `${start + index}. `);
    },
    task_list(state, node) {
      // The Markdown list marker is '- '; '[x] ' belongs to the paragraph.
      // Six-space continuation would turn later paragraphs into code blocks.
      renderList(state, node, "  ", (index) =>
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
    // A dataframe has no Markdown form. It reads as a labeled link to its
    // asset on its own line. replace_block_markdown turns that exact line back
    // into the node (setRichMarkdownKeepingNodes) and refuses a rewrite
    // without it, so the link never silently replaces the node.
    dataframe(state, node) {
      // Attrs this build can't read (never written by a Pages writer) read as
      // a notice, so a read never offers their src as a link.
      if (!readDataframe(node.attrs)) state.write(state.esc(unknownNodeNotice("dataframe")));
      else state.write(`[${state.esc(dataframeLabel(node.attrs.title))}](${node.attrs.src})`);
      state.closeBlock(node);
    },
    // A preserved block the host has not converted yet projects as the
    // content it converts to, so a read never offers source a write refuses.
    raw(state, node) {
      state.renderContent(parseMarkdown(node.attrs.source, { kind: node.attrs.kind }));
    },
    // A node this build doesn't know, written by a newer build. It reads as a
    // notice naming its type, followed by any text it holds, so a read never
    // hides it. replace_block_markdown refuses the block (markdownlessNode).
    unknownBlock(state, node) {
      const type = node.attrs.unknownBlock?.type ?? node.attrs.unknownParentBlock;
      state.write(state.esc(unknownNodeNotice(type)));
      state.closeBlock(node);
      node.forEach((child, _offset, index) => {
        if (child.type.name !== "paragraph" || child.content.size) state.render(child, node, index);
      });
    },
    unknownLeaf(state, node) {
      state.write(state.esc(unknownNodeNotice(node.attrs.unknownBlock?.type)));
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
    unknownLeaf(state, node) {
      state.write(state.esc(unknownNodeNotice(node.attrs.unknownBlock?.type)));
    },
    unknownBlock(state, node) {
      state.write(state.esc(unknownNodeNotice(node.attrs.unknownBlock?.type)));
    },
  },
  markSerializers,
  { escapeExtraCharacters: /<|&(?=#?[a-z0-9]{1,32};)/gi },
);

// Markdown has no empty paragraph. The serializer writes an empty leading
// paragraph as a blank line, which parsers ignore, so drop it rather than
// suggest the newline is content. The pattern is anchored at the start.
export function exportMarkdown(doc) {
  return escapeLiteralSyntax(serializer.serialize(doc).replace(/^\n+/, ""));
}
