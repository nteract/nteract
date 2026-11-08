// Markdown-it tokens become the same Wordgard tree the editor writes.
import { Leaf, Mark } from "wordgard/doc";
import {
  schema,
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  Blockquote,
  BulletList,
  OrderedList,
  ListItem,
  TaskList,
  TaskChecked,
  Table,
  TableRow,
  Cell,
  HeaderCell,
  Alignment,
  HorizontalRule,
  LineBreak,
  Strong,
  Emphasis,
  Strikethrough,
  Code,
  PagesLink,
  PagesHighlight,
  PagesImage,
} from "./wordgard-doc.mjs";
import { normalizeSource } from "./markdown-scan.mjs";
import { imageAlt } from "./markdown-tokenizer.mjs";

export function parseTokens(tokens) {
  const stack = [{ children: [] }];
  let marks = Mark.none;
  const append = (node) => stack.at(-1).children.push(node);
  const text = (value, set = marks) => {
    value.split("\n").forEach((part, index) => {
      if (index) append(LineBreak);
      if (part) append(Leaf.text(part, set));
    });
  };
  const walk = (list) => {
    for (const token of list) {
      const type = token.type;
      if (type === "inline") {
        walk(token.children ?? []);
        continue;
      }
      if (["thead_open", "thead_close", "tbody_open", "tbody_close"].includes(type)) continue;
      if (type === "text") {
        text(token.content);
        continue;
      }
      if (type === "softbreak") {
        text(" ");
        continue;
      }
      if (type === "hardbreak") {
        append(LineBreak);
        continue;
      }
      if (type === "code_inline") {
        text(token.content, Code.addToSet(marks));
        continue;
      }
      if (type === "image") {
        append(
          PagesImage.of({
            src: token.attrGet("src"),
            title: token.attrGet("title") || null,
            alt: imageAlt(token.children),
          }),
        );
        continue;
      }
      if (type === "hr") {
        append(HorizontalRule);
        continue;
      }
      if (type === "fence" || type === "code_block") {
        const language = type === "fence" ? token.info || "" : "";
        const tag = language ? CodeBlock.withMarks([CodeBlockLanguage.of(language)]) : CodeBlock;
        append(
          tag.create(
            token.content
              .replace(/\n$/, "")
              .split("\n")
              .flatMap((line, i) => [
                ...(i ? [LineBreak] : []),
                ...(line ? [Leaf.text(line)] : []),
              ]),
          ),
        );
        continue;
      }
      const name = type.replace(/_(open|close)$/, "");
      const markType = {
        strong: Strong.type,
        em: Emphasis.type,
        s: Strikethrough.type,
        link: PagesLink,
        pages_highlight: PagesHighlight,
      }[name];
      if (markType) {
        if (type.endsWith("_close")) marks = markType.removeFromSet(marks);
        else {
          const mark =
            name === "link"
              ? PagesLink.of({ href: token.attrGet("href"), title: token.attrGet("title") || null })
              : name === "pages_highlight"
                ? PagesHighlight.of(token.attrGet("color"))
                : { strong: Strong, em: Emphasis, s: Strikethrough }[name];
          marks = mark.addToSet(marks);
        }
        continue;
      }
      if (token.nesting === -1) {
        const frame = stack.pop();
        // A block-first list's Markdown label creates a placeholder paragraph.
        // The list-item marker itself already owns that opening boundary.
        if (
          frame.tag.type === ListItem.type &&
          frame.children.length > 1 &&
          frame.children[0].type === Paragraph.type &&
          !frame.children[0].content.length
        )
          frame.children.shift();
        if ([ListItem.type, Blockquote.type].includes(frame.tag.type) && !frame.children.length)
          frame.children.push(Paragraph.create([]));
        append(frame.tag.create(frame.children));
        continue;
      }
      const align = /^text-align:(left|center|right)$/.exec(token.attrGet("style") ?? "")?.[1];
      let tag = {
        paragraph: Paragraph,
        blockquote: Blockquote,
        bullet_list: BulletList,
        task_list: TaskList,
        table: Table,
        tr: TableRow,
        th: HeaderCell,
        td: Cell,
      }[name];
      if (name === "heading") tag = Heading.of(Number(token.tag.slice(1)));
      if (name === "ordered_list") tag = OrderedList.of(1);
      if (name === "list_item")
        tag =
          token.attrGet("checked") == null
            ? ListItem
            : ListItem.withMarks([TaskChecked.of(token.attrGet("checked"))]);
      if ((name === "th" || name === "td") && align) tag = tag.withMarks([Alignment.of(align)]);
      if (!tag) throw Error(`Unsupported Pages token: ${type}`);
      stack.push({ tag, children: [] });
    }
  };
  walk(tokens);
  const nodes = stack[0].children;
  return schema.doc(nodes.length ? nodes : [Paragraph.create([])]);
}

export function literalDoc(source) {
  const paragraphs = normalizeSource(source)
    .split(/\n[ \t]*\n/)
    .filter((part) => part.trim())
    .map((part) =>
      Paragraph.create(
        part
          .replace(/^\n+|\n+$/g, "")
          .split("\n")
          .flatMap((line, index) => [
            ...(index ? [LineBreak] : []),
            ...(line ? [Leaf.text(line)] : []),
          ]),
      ),
    );
  return schema.doc(paragraphs.length ? paragraphs : [Paragraph.create([])]);
}
