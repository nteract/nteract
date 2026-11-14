import { dataframeValue } from "../shared/dataset-assets.mjs";
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
  PagesView,
  PagesUnknownEmbed,
  PagesUnknownBlock,
  PagesForeignMarks,
  PagesLink,
  codeHolds,
  nestIn,
  attrMap,
  storedParents,
  TABLE_PART_OUTER,
  unreadableMarker,
  readMark,
} from "./wordgard-doc.mjs";
import { treeMarkdown } from "./markdown-serializer.mjs";
import { codeTextUnmarked } from "./richtext-format.mjs";
import { unknownNodeNotice } from "./richtext-notices.mjs";
import { parseAssetPath, readDataframe } from "../shared/dataset-assets.mjs";
import { readViewNode } from "../shared/views.mjs";
import {
  DATA_LEAVES,
  isKnownBlock,
  TEXT_CONTAINERS,
  markerName,
  markerType,
} from "./node-registry.mjs";

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
  [PagesView, "view"],
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
    Object.entries(attrMap(attrs) ?? {}).map(([key, value]) => [
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

// A mark whose name or value this build can't read, or must not render,
// reads as a name it doesn't know (readMark): drawn as nothing, so an unsafe
// link or highlight never reaches Markdown, an outline, a card or HTML.
function readMarks(marks = {}) {
  let result = Mark.none;
  const foreign = Object.create(null);
  for (const [name, value] of Object.entries(marks)) {
    let mark = readMark(name, value);
    // The agent read spells a link with no title as an empty one.
    if (mark?.type === PagesLink && mark.value.title == null)
      mark = PagesLink.of({ ...mark.value, title: "" });
    if (mark) result = mark.addToSet(result);
    else foreign[name] = value;
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

// The read node type of each leaf that draws stored data.
const LEAVES = Object.freeze({ dataframe: PagesDataframe, view: PagesView });

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
    // A marker this build can't read, or must not render (decode's
    // unreadableMarker), reads as the notice for a node it doesn't know. A
    // value that isn't a map reads as an inline one.
    const stored = span.value && typeof span.value === "object" && !Array.isArray(span.value);
    // A type that isn't a name reads as "", which no notice quotes.
    const value = stored ? span.value : { type: markerName(span.value) ?? "", isEmbed: true },
      type = markerType(value) ?? "",
      attrs = strings(value.attrs),
      unreadable = unreadableMarker(span.value);
    const parents = storedParents(value);
    if (value.isEmbed) {
      // An embed a code block can't hold opens a paragraph after it.
      if (code() && !codeHolds(type, parents)) close();
      ensureText();
      if (type === "hard-break") {
        if (code()) append(Leaf.text("\n", Mark.none));
        else append(LineBreak, at, attrs);
      } else if (type === "image" && !unreadable) append(PagesImage.of(attrs), at, attrs);
      else if (code()) notice(type);
      else append(PagesUnknownEmbed.of({ type }), at, attrs);
      at++;
      continue;
    }
    // Parents and then the node nest by decode's rule (nestIn in
    // model/wordgard-doc.mjs): each known container nests in the nearest
    // container before it that can hold it. A container this build doesn't
    // know, which decode skips, is kept here as a notice wherever a block
    // could go, and is transparent to that rule; inside a textblock it is
    // skipped too. Where it holds nodes, this reader's top-level nodes can
    // differ from decode's, and readableNodeIds gives the block's nodes no
    // ids (node-ids.mjs).
    const outer = [];
    const depthFor = (tag) => {
      const known = [];
      outer.forEach((entry, index) => {
        if (entry.tag.type !== ReadUnknown) known.push(index);
      });
      const depth = nestIn(
        known.map((index) => outer[index]),
        tag,
      );
      if (depth === null) return null;
      if (depth === known.length) return outer.length;
      return depth ? known[depth - 1] + 1 : 0;
    };
    const fits = (tag) => {
      const depth = depthFor(tag);
      if (depth === null) return false;
      outer.length = depth;
      return true;
    };
    const place = (entry) => {
      if (entry.tag.type === ReadUnknown) {
        if (depthFor(PagesUnknownBlock) !== outer.length) return false;
      } else if (!fits(entry.tag)) return false;
      outer.push(entry);
      return true;
    };
    for (const parent of parents) {
      const desc = descriptor(parent);
      // A known node that holds no nodes (a rule, an image) is no parent.
      if (desc.tag.type === ReadUnknown && isKnownBlock(parent)) continue;
      if (!desc.outer || place({ tag: desc.outer })) place(desc);
    }
    let desc = unreadable ? { tag: ReadUnknown.of(type) } : descriptor(type, attrs);
    // A table part no container holds is drawn inside the table containers
    // it needs, as decode draws it (TABLE_PART_OUTER).
    const wrapped = (tag) => {
      const names = TABLE_PART_OUTER[type];
      if (!names) return false;
      for (let from = names.length - 1; from >= 0; from--) {
        if (depthFor(descriptor(names[from]).tag) === null) continue;
        for (const name of names.slice(from)) place(descriptor(name));
        return fits(tag);
      }
      return false;
    };
    const unknownNode = () => {
      desc = { tag: ReadUnknown.of(type) };
      if (!inlineAt()) fits(PagesUnknownBlock);
    };
    const inlineAt = () =>
      !!outer.findLast((entry) => entry.tag.type !== ReadUnknown)?.tag.type.spec.inlineContent;
    const foreign =
      !attrs.binding &&
      pageId !== undefined &&
      parseAssetPath(typeof attrs.src === "string" ? attrs.src : "")?.pageId !== pageId;
    // A dataframe it can't show reads as a notice where it is stored: in a
    // text container, from another Page, or with attrs it can't read (as
    // decode reads them), so no reader is handed their src.
    // A view it can't show (in a text container, or with attrs it can't
    // read) reads as a notice too.
    const scalars = Object.values(attrs).every(
      (value) => value === null || ["string", "number", "boolean"].includes(typeof value),
    );
    const readable =
      type === "view"
        ? scalars && !!readViewNode(attrs)
        : !!readDataframe(attrs) && Object.entries(attrs).every(([k, v]) => dataframeValue(k, v));
    const shown =
      !(
        parents.some((parent) => TEXT_CONTAINERS.has(parent)) ||
        (type === "dataframe" && foreign)
      ) && readable;
    let leafNode = DATA_LEAVES.has(type) || type === "horizontal-rule";
    if (DATA_LEAVES.has(type) && !shown) {
      if (!inlineAt()) fits(PagesUnknownBlock);
    } else if (leafNode) {
      if (!fits(LEAVES[type] ?? HorizontalRule)) {
        leafNode = false;
        unknownNode();
      }
    } else if (desc.tag.type === ReadUnknown) unknownNode();
    else if (desc.outer ? !place({ tag: desc.outer }) : !fits(desc.tag) && !wrapped(desc.tag))
      unknownNode();
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
    if (leafNode && DATA_LEAVES.has(type)) {
      if (!shown) notice(type);
      else if (type === "dataframe") append(PagesDataframe.of(attrs), at, attrs);
      else append(PagesView.of(attrs), at, attrs);
    } else if (leafNode) append(HorizontalRule.type.of(null), at, attrs);
    else if (desc.tag.type === ReadUnknown && inline()) notice(type);
    else open(desc, at, attrs);
    at++;
  }
  while (stack.length) close();
  // Empty text, which a merge can leave: one empty unmarked paragraph.
  if (!nodes.length) nodes.push(Paragraph.create([]));
  return { nodes, source, metadata };
}
