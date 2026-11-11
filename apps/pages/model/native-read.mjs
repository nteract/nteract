// Read-only projection of stored spans. Ordinary nodes are Wordgard nodes;
// unknown containers retain their logical children in a reader-only Plot.
// Neither this projection nor its source correspondence is an editor document.
import * as A from "@automerge/automerge/slim";
import { Leaf, Mark, Plot } from "wordgard/doc";
import {
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  Blockquote,
  Aside,
  BulletList,
  OrderedList,
  TaskList,
  ListItem,
  TaskChecked,
  Table,
  TableRow,
  Cell,
  HeaderCell,
  Alignment,
  HorizontalRule,
  LineBreak,
  PagesImage,
  PagesDataframe,
  PagesUnknownEmbed,
  PagesUnknownBlock,
  Strong,
  Emphasis,
  Strikethrough,
  Code,
  PagesLink,
  PagesHighlight,
  PagesForeignMarks,
  codeHolds,
} from "./wordgard-doc.mjs";
import { treeMarkdown } from "./markdown-serializer.mjs";
import { codeTextUnmarked } from "./richtext-format.mjs";
import { unknownNodeNotice } from "./richtext-notices.mjs";
import { parseAssetPath } from "../shared/dataset-assets.mjs";
import { TEXT_CONTAINERS } from "./node-registry.mjs";

// Never installed in the editor schema: a stored unknown container is readable,
// but constructing this projection does not make it editable or admissible.
const ReadUnknown = Plot.define("ReadUnknown", {
  blockContent: true,
  shape: { element: "div" },
}).type;
export const readChildren = (node) => node.content ?? [];
const READ_KINDS = new Map([
  [Paragraph.type, "paragraph"],
  [Heading, "heading"],
  [CodeBlock.type, "code-block"],
  [Blockquote.type, "blockquote"],
  [Aside.type, "aside"],
  [BulletList.type, "bullet-list"],
  [OrderedList, "ordered-list"],
  [TaskList.type, "task-list"],
  [ListItem.type, "list-item"],
  [Table.type, "table"],
  [TableRow.type, "table-row"],
  [Cell.type, "table-cell"],
  [HeaderCell.type, "table-header"],
  [HorizontalRule.type, "horizontal-rule"],
  [LineBreak.type, "hard-break"],
  [PagesImage, "image"],
  [PagesDataframe, "dataframe"],
  [PagesUnknownEmbed, "unknown-inline"],
]);
export function readKind(node) {
  if (node.type === ReadUnknown || node.type === PagesUnknownBlock) return "unknown";
  if (node.isText) return "text";
  return READ_KINDS.get(node.type);
}
export function readText(node) {
  if (node.isText) return node.param;
  return readChildren(node).map(readText).join("");
}
export function readVisibleText(node) {
  if (readKind(node) === "image") return node.param.alt ?? "";
  if (readKind(node) === "hard-break") return "\n";
  if (node.isText) return node.param;
  return readChildren(node)
    .map(readVisibleText)
    .join(node.type?.spec.inlineContent ? "" : "\n");
}
export const readFingerprint = (node, metadata) => ({
  value: node.tag.toJSON(),
  stored: fingerprintAttrs(node, metadata.get(node)),
  children: readChildren(node).map((child) => readFingerprint(child, metadata)),
});
export function readDescendants(node, visit) {
  for (const child of readChildren(node)) {
    if (visit(child) !== false) readDescendants(child, visit);
  }
}
function serialNodes(node) {
  if (node.type === ReadUnknown)
    return [
      PagesUnknownBlock.of({ type: node.tag.param }),
      ...node.content.flatMap((child) =>
        readKind(child) === "paragraph" && !readChildren(child).length ? [] : serialNodes(child),
      ),
    ];
  if (node.type === CodeBlock.type && !node.mark(CodeBlockLanguage))
    return [CodeBlock.create(node.content)];
  return node.isPlot ? [node.tag.create(node.content.flatMap(serialNodes))] : [node];
}
export const readMarkdown = (nodes) => treeMarkdown({ content: nodes.flatMap(serialNodes) });
const strings = (attrs = {}) =>
  Object.fromEntries(
    Object.entries(attrs).map(([key, value]) => [
      key,
      A.isImmutableString(value) ? String(value) : value,
    ]),
  );

function fingerprintAttrs(node, attrs = {}) {
  const result = { ...attrs };
  const defaults =
    {
      heading: { level: 1 },
      "code-block": { params: "" },
      "table-cell": { align: null },
      "table-header": { align: null },
    }[readKind(node)] ?? {};
  for (const [key, value] of Object.entries(defaults))
    if (result[key] === value) delete result[key];
  return result;
}

const READ_MARKS = new Map([
  ["strong", Strong],
  ["em", Emphasis],
  ["strike", Strikethrough],
  ["code", Code],
]);
function readMarks(marks = {}) {
  let result = Mark.none;
  const foreign = Object.create(null);
  for (const [name, value] of Object.entries(marks)) {
    let mark = READ_MARKS.get(name);
    if (name === "link") {
      let link;
      if (typeof value === "string") {
        try {
          link = JSON.parse(value);
        } catch {
          /* Legacy malformed links read with empty fields. */
        }
      }
      mark = PagesLink.of({ href: link?.href || "", title: link?.title || "" });
    } else if (name === "highlight") mark = PagesHighlight.of(String(value));
    else if (!mark) foreign[name] = value;
    if (mark) result = mark.addToSet(result);
  }
  if (Object.keys(foreign).length) result = PagesForeignMarks.of(foreign).addToSet(result);
  return result;
}

function descriptor(type, attrs = {}) {
  switch (type) {
    case "paragraph":
      return { tag: Paragraph };
    case "heading":
      return { tag: Heading.of(attrs.level === undefined ? 1 : attrs.level) };
    case "code-block":
      return {
        tag:
          attrs.params != null && attrs.params !== ""
            ? CodeBlock.withMarks([CodeBlockLanguage.of(attrs.params)])
            : CodeBlock,
      };
    case "blockquote":
      return { tag: Blockquote };
    case "aside":
      return { tag: Aside };
    case "unordered-list-item":
      return { tag: ListItem, outer: BulletList };
    case "ordered-list-item":
      return { tag: ListItem, outer: OrderedList.of(1) };
    case "task-list-item":
      return { tag: ListItem.withMarks([TaskChecked.of(attrs.checked ?? false)]), outer: TaskList };
    case "table":
      return { tag: Table };
    case "table-row":
      return { tag: TableRow };
    case "table-cell":
    case "table-header": {
      const tag = type === "table-cell" ? Cell : HeaderCell;
      return { tag: attrs.align ? tag.withMarks([Alignment.of(attrs.align)]) : tag };
    }
    default:
      return { tag: ReadUnknown.of(type) };
  }
}

export function nativeRead(block, pageId) {
  return nativeReadSpans(A.spans(block, ["richText"]), pageId);
}

/** A read-only projection of stored spans. */
export function nativeReadSpans(input, pageId) {
  const spans = codeTextUnmarked(input);
  const nodes = [],
    stack = [],
    source = new WeakMap(),
    metadata = new WeakMap();
  let at = 0;
  const append = (node, offset = null, attrs) => {
    // Wordgard interns leaves. Source positions belong to occurrences, not
    // shared values (two identical rules or images have different markers).
    if (node.isLeaf) node = Leaf.new(node.type, node.param, node.marks);
    source.set(node, offset);
    if (attrs) metadata.set(node, attrs);
    (stack.at(-1)?.children ?? nodes).push(node);
  };
  const open = (desc, offset = null, attrs) => stack.push({ ...desc, offset, attrs, children: [] });
  const close = () => {
    const frame = stack.pop();
    if (!frame.children.length && !frame.tag?.type.spec.inlineContent)
      frame.children.push(
        frame.tag.type === Table.type
          ? TableRow.create([Cell.create([])])
          : frame.tag.type === TableRow.type
            ? Cell.create([])
            : Paragraph.create([]),
      );
    append(
      frame.tag.create(frame.children),
      frame.offset ??
        (frame.tag?.type.spec.inlineContent ? null : source.get(frame.children[0])) ??
        null,
      frame.attrs,
    );
  };
  const inline = () => !!stack.at(-1)?.tag?.type.spec.inlineContent;
  // Content continues the node before it in its scope when that node can
  // hold it (codeHolds). Unmarked text (nothing before it in its scope
  // can hold it; only a merge leaves it, see decode in
  // model/wordgard-doc.mjs) reads as a paragraph with no marker, as does
  // what a node this build doesn't know stores after its own marker.
  const ensureText = () => {
    if (stack.at(-1)?.tag.type === Table.type) open({ tag: TableRow });
    if (stack.at(-1)?.tag.type === TableRow.type) open({ tag: Cell });
    if (!inline()) open({ tag: Paragraph });
  };
  const code = () => stack.at(-1)?.tag?.type === CodeBlock.type;
  // A node this reader can't show reads as notice text where it is stored:
  // inline in a text container, or as a paragraph of its own.
  const notice = (type) => {
    const own = !inline();
    if (own) open({ tag: Paragraph });
    append(Leaf.text(unknownNodeNotice(type), Mark.none));
    if (own) close();
  };
  for (const span of spans) {
    if (span.type === "text") {
      ensureText();
      if (span.value) append(Leaf.text(span.value, code() ? Mark.none : readMarks(span.marks)));
      at += span.value.length;
      continue;
    }
    const value = span.value,
      type = String(value.type),
      attrs = strings(value.attrs);
    const parents = (value.parents ?? []).map(String);
    if (value.isEmbed) {
      // An embed a code block can't hold opens a paragraph after it.
      if (code() && !codeHolds(type, parents)) close();
      ensureText();
      if (type === "hard-break") {
        if (code()) append(Leaf.text("\n", Mark.none));
        else append(LineBreak, at, attrs);
      } else if (type === "image") append(PagesImage.of(attrs), at, attrs);
      else if (code()) notice(type);
      else append(PagesUnknownEmbed.of({ type }), at, attrs);
      at++;
      continue;
    }
    const outer = [];
    for (const parent of parents) {
      const desc = descriptor(parent);
      if (desc.outer) outer.push({ tag: desc.outer });
      outer.push(desc);
    }
    const desc = descriptor(type, attrs);
    if (desc.outer) outer.push({ tag: desc.outer });
    let common = 0;
    while (
      common < outer.length &&
      common < stack.length &&
      stack[common].tag?.type === outer[common].tag?.type &&
      (stack[common].tag.type !== ReadUnknown ||
        stack[common].tag.param === outer[common].tag.param)
    )
      common++;
    while (stack.length > common) close();
    for (let i = common; i < outer.length; i++) open(outer[i]);
    const foreign =
      pageId !== undefined && parseAssetPath(String(attrs.src ?? ""))?.pageId !== pageId;
    if (type === "dataframe") {
      if (parents.some((parent) => TEXT_CONTAINERS.has(parent)) || foreign) notice(type);
      else append(PagesDataframe.of(attrs), at, attrs);
    } else if (type === "horizontal-rule") append(HorizontalRule.type.of(null), at, attrs);
    else if (desc.tag.type === ReadUnknown && inline()) notice(type);
    else open(desc, at, attrs);
    at++;
  }
  while (stack.length) close();
  // Empty text, which a merge can leave: one empty unmarked paragraph.
  if (!nodes.length) nodes.push(Paragraph.create([]));
  return { nodes, source, metadata };
}
