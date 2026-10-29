// encode() exactly as shipped in Pages build d53a6e64b, before an empty first
// paragraph kept its native marker. Mixed-version tests use it to stand in for
// a browser tab that loaded that build. Do not update it with the live encoder.
import * as A from "@automerge/automerge/slim";
import {
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  LineBreak,
  Blockquote,
  ListItem,
  OrderedList,
  BulletList,
  Table,
  TableRow,
  Cell,
  HeaderCell,
} from "wordgard/types";
import {
  Alignment,
  Aside,
  OpaqueBlock,
  PagesImage,
  TaskChecked,
  TaskList,
  toMarks,
} from "../viewer/wordgard-model.mjs";

export function encode(doc) {
  const spans = [];
  const marker = (type, parents, attrs = {}, isEmbed = false) =>
    spans.push({
      type: "block",
      value: {
        type: new A.ImmutableString(type),
        parents: parents.map((p) => new A.ImmutableString(p)),
        attrs: Object.fromEntries(
          Object.entries(attrs).map(([k, v]) => [
            k,
            typeof v === "string" ? new A.ImmutableString(v) : v,
          ]),
        ),
        isEmbed,
      },
    });
  const inline = (node, parents, code = false) => {
    if (node.isText)
      spans.push({ type: "text", value: String(node.param), marks: toMarks(node.marks) });
    else if (node.type === LineBreak.type) {
      if (code) spans.push({ type: "text", value: "\n", marks: toMarks(node.marks) });
      else marker("hard-break", parents, {}, true);
    } else if (node.type === PagesImage) {
      PagesImage.spec.validate(node.param);
      marker("image", parents, node.param, true);
    } else throw Error(`Unsupported Wordgard inline node: ${node.name}`);
  };
  const block = (node, parents, implicit = false, listType = null) => {
    if (node.type === OpaqueBlock) {
      marker("pages-opaque", parents, node.param);
      return;
    }
    if (!node.isPlot) throw Error(`Unsupported Wordgard block: ${node.name}`);
    if (node.type === BulletList.type || node.type === OrderedList || node.type === TaskList.type) {
      if (node.type === OrderedList && node.tag.param !== 1)
        throw Error("Pages ordered lists currently start at 1");
      const itemType =
        node.type === TaskList.type
          ? "task-list-item"
          : node.type === BulletList.type
            ? "unordered-list-item"
            : "ordered-list-item";
      for (const child of node.content) block(child, parents, false, itemType);
      return;
    }
    let type,
      attrs = {};
    if (node.type === Table.type) type = "table";
    else if (node.type === TableRow.type) type = "table-row";
    else if (node.type === Cell.type || node.type === HeaderCell.type) {
      type = node.type === Cell.type ? "table-cell" : "table-header";
      const alignment = Alignment.isInSet(node.tag.marks);
      if (alignment) {
        Alignment.spec.validate(alignment.value);
        attrs.align = alignment.value;
      }
    } else if (node.type === Paragraph.type) type = "paragraph";
    else if (node.type === Heading) {
      type = "heading";
      attrs.level = Number(node.tag.param);
    } else if (node.type === CodeBlock.type) {
      type = "code-block";
      attrs.params = String(node.mark(CodeBlockLanguage) ?? "");
    } else if (node.type === Blockquote.type) type = "blockquote";
    else if (node.type === Aside.type) type = "aside";
    else if (node.type === ListItem.type && listType) {
      type = listType;
      if (listType === "task-list-item") {
        const mark = TaskChecked.isInSet(node.tag.marks);
        attrs.checked = mark ? mark.value : false;
        TaskChecked.spec.validate(attrs.checked);
      }
    } else throw Error(`Unsupported Wordgard block: ${node.name}`);
    if (!(implicit && type === "paragraph")) marker(type, parents, attrs);
    if (node.inlineContent)
      for (const child of node.content) inline(child, [...parents, type], type === "code-block");
    else node.content.forEach((child, i) => block(child, [...parents, type], i === 0));
  };
  doc.content.forEach((node, i) => block(node, [], i === 0));
  return spans;
}
