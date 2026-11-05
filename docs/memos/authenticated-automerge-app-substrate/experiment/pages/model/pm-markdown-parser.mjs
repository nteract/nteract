// ProseMirror boundary. model/pm-adapter.mjs, model/pm-markdown-parser.mjs
// and model/pm-markdown-serializer.mjs are the only production Pages modules
// that import ProseMirror packages (@automerge/prosemirror, prosemirror-*);
// model/pm-boundary.test.mjs checks it. Other modules reach ProseMirror trees,
// the span adapter and its traversal through these three.
//
// markdown-it tokens to a ProseMirror tree: the token table for the Pages
// schema, the parser over already-read tokens, and literal-text documents.
import MarkdownIt from "markdown-it";
import { MarkdownParser, defaultMarkdownParser } from "prosemirror-markdown";
import { schema } from "./pm-adapter.mjs";
import { imageAlt, tokenizer } from "./markdown-tokenizer.mjs";
import { normalizeSource } from "./markdown-scan.mjs";

const cellAttrs = (token) => ({
  isAmgBlock: true,
  align: /^text-align:(left|center|right)$/.exec(token.attrGet("style") ?? "")?.[1] ?? null,
});
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
export const plainImportParser = new MarkdownParser(
  schema,
  new MarkdownIt("commonmark", { html: false, linkify: false }),
  { ...defaultMarkdownParser.tokens, image: imageToken },
);

// Non-Markdown content is text: one paragraph per run of lines, each line
// break a hard break.
export function literalDoc(source) {
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

// The parser over tokens this module already read, so one import tokenizes
// its source once. Synchronous: nothing else can use the parser meanwhile.
export function parseTokens(tokens) {
  const own = parser.tokenizer;
  parser.tokenizer = { parse: () => tokens };
  try {
    return paragraphFirstItems(parser.parse(""));
  } finally {
    parser.tokenizer = own;
  }
}

/** `tree` with an empty paragraph opening every list item that opens with
 * another block. The adapter writes an item's marker for its first
 * paragraph, so without one an item that opens with a list has no marker and
 * joins the item before it. Reads accept either form (`list_item` is
 * `block+`). */
export function paragraphFirstItems(node) {
  if (node.isTextblock || node.isLeaf) return node;
  const children = [];
  node.forEach((child) => children.push(paragraphFirstItems(child)));
  if (node.type === schema.nodes.list_item && children[0]?.type !== schema.nodes.paragraph)
    children.unshift(schema.nodes.paragraph.create());
  return node.copy(node.content.constructor.from(children));
}
