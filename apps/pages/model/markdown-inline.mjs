// Native inline replacement parsing. Block tokens still decide whether the
// source is one paragraph; no full document constructor lives on this path.
import { Leaf, Mark } from "wordgard/doc";
import {
  Paragraph,
  Strong,
  Emphasis,
  Strikethrough,
  Code,
  PagesLink,
  PagesHighlight,
  toMarks,
} from "./wordgard-doc.mjs";
import { imageAlt } from "./markdown-tokenizer.mjs";
import { agentTokens, lostSpansContent, refuseLoss } from "./markdown-import-policy.mjs";

const inlineOnly = () =>
  Object.assign(
    Error(
      'replacement_markdown must be inline Markdown on one line: text, **bold**, *italic*, ~~strike~~, `code`, [links](url) and <mark data-color="…">highlights</mark>. Escape a leading #, >, -, *, +, 1. or ``` with a backslash.',
    ),
    { status: 400, code: "invalid_edit_selector" },
  );
const markTypes = new Map([
  ["strong", Strong.type],
  ["em", Emphasis.type],
  ["s", Strikethrough.type],
  ["link", PagesLink],
  ["pages_highlight", PagesHighlight],
]);

export function parseInlineMarkdown(source) {
  if (/[\r\n]/.test(source)) throw inlineOnly();
  const lead = /^[ \t]*/.exec(source)[0],
    trail = /[ \t]*$/.exec(source.slice(lead.length))[0];
  const middle = source.slice(lead.length, source.length - trail.length);
  const runs = lead ? [{ text: lead, marks: {} }] : [];
  if (middle) {
    const { text, tokens } = agentTokens(middle);
    const spans = [];
    let embedded = false;
    // Preserve loss-refusal precedence even when the block shape will be refused.
    for (const block of tokens) {
      if (["fence", "code_block"].includes(block.type))
        spans.push({ type: "text", value: block.content });
      if (block.type !== "inline") continue;
      let marks = Mark.none;
      const leaves = [];
      const flush = () => {
        for (const node of Paragraph.create(leaves).content)
          spans.push({ type: "text", value: node.param, marks: toMarks(node.marks) });
        leaves.length = 0;
      };
      for (const token of block.children ?? []) {
        const name = token.type.replace(/_(open|close)$/, "");
        const type = markTypes.get(name);
        if (type) {
          if (token.type.endsWith("_close")) marks = type.removeFromSet(marks);
          else {
            const mark =
              name === "link"
                ? PagesLink.of({
                    href: token.attrGet("href"),
                    title: token.attrGet("title") || null,
                  })
                : name === "pages_highlight"
                  ? PagesHighlight.of(token.attrGet("color"))
                  : { strong: Strong, em: Emphasis, s: Strikethrough }[name];
            marks = mark.addToSet(marks);
          }
        } else if (token.type === "text" || token.type === "code_inline") {
          if (token.content)
            leaves.push(
              Leaf.text(token.content, token.type === "code_inline" ? Code.addToSet(marks) : marks),
            );
        } else if (token.type === "softbreak") leaves.push(Leaf.text(" ", marks));
        else if (token.type === "image") {
          flush();
          embedded = true;
          spans.push({
            type: "block",
            value: {
              type: "image",
              attrs: { src: token.attrGet("src"), alt: imageAlt(token.children) },
            },
          });
        } else if (token.type === "hardbreak") {
          flush();
          embedded = true;
        } else throw inlineOnly();
      }
      flush();
    }
    const lost = lostSpansContent(tokens, spans);
    if (lost) refuseLoss(text, lost);
    if (
      tokens.length !== 3 ||
      tokens[0].type !== "paragraph_open" ||
      tokens[1].type !== "inline" ||
      tokens[2].type !== "paragraph_close" ||
      embedded
    )
      throw inlineOnly();
    for (const span of spans) runs.push({ text: span.value, marks: { ...span.marks } });
  }
  if (trail) runs.push({ text: trail, marks: {} });
  return runs;
}
