// Strict span validation, separate from legacy read repair and editor admission.
// The registry fixes the container rules. Wordgard nodes supply the Markdown
// check; no projection fallback, position map, re-encoding or shared write runs.
import * as A from "@automerge/automerge/slim";
import { Leaf, Mark } from "wordgard/doc";
import { markSpec, safeUrl, validateMarkValue } from "./marks.mjs";
import { NODE_TYPES, isKnownBlock, validAlignment, validHeadingLevel } from "./node-registry.mjs";
import { readDataframe } from "../shared/dataset-assets.mjs";
import { treeMarkdown } from "./markdown-serializer.mjs";
import {
  Alignment,
  Aside,
  Blockquote,
  BulletList,
  Cell,
  CodeBlock,
  CodeBlockLanguage,
  HeaderCell,
  Heading,
  HorizontalRule,
  LineBreak,
  ListItem,
  OrderedList,
  PagesDataframe,
  PagesImage,
  Paragraph,
  Table,
  TableRow,
  TaskChecked,
  TaskList,
  fromMarks,
} from "./wordgard-doc.mjs";

const tags = {
  paragraph: Paragraph,
  heading: Heading,
  "code-block": CodeBlock,
  blockquote: Blockquote,
  aside: Aside,
  "list-item": ListItem,
  table: Table,
  "table-row": TableRow,
  "table-cell": Cell,
  "table-header": HeaderCell,
  "horizontal-rule": HorizontalRule,
  image: PagesImage,
  "hard-break": LineBreak,
  dataframe: PagesDataframe,
  ordered_list: OrderedList.of(1),
  bullet_list: BulletList,
  task_list: TaskList,
};
const shapes = new Map(
  NODE_TYPES.map((entry) => {
    const key = entry.wrapper ? "list-item" : entry.block;
    return [
      entry.block,
      {
        key,
        tag: tags[key],
        wrapper: entry.wrapper,
        errorName: entry.pm,
        group: entry.wrapper
          ? "item"
          : entry.block === "table-row"
            ? "row"
            : ["table-cell", "table-header"].includes(entry.block)
              ? "cell"
              : entry.kind === "embed"
                ? "inline"
                : "block",
        content:
          entry.block === "table"
            ? "row"
            : entry.block === "table-row"
              ? "cell"
              : entry.block === "code-block"
                ? "text"
                : ["text", "text-container"].includes(entry.kind)
                  ? "inline"
                  : entry.kind === "container"
                    ? "block"
                    : null,
      },
    ];
  }),
);
shapes.set("list-item", shapes.get("unordered-list-item"));
for (const wrapper of new Set(NODE_TYPES.map((entry) => entry.wrapper).filter(Boolean)))
  shapes.set(wrapper, {
    key: wrapper,
    tag: tags[wrapper],
    group: "block",
    content: "item",
    errorName: wrapper,
  });
const rootShape = { key: "doc", content: "block", errorName: "doc" };
const textShape = { key: "text", group: "inline" };
const accepts = (parent, child) =>
  parent.content === "text" ? child.key === "text" : parent.content === child.group;
const defaultChild = {
  block: "paragraph",
  item: "list-item",
  row: "table-row",
  cell: "table-cell",
};

// Only text and embeds can request an implicit path. Explicit parent chains
// must already fit, including table -> row -> cell and list -> item.
function wrapping(parent, child) {
  if (accepts(parent, child)) return [];
  if (parent.content === "block")
    return {
      inline: ["paragraph"],
      item: ["ordered_list"],
      row: ["table"],
      cell: ["table", "table-row"],
    }[child.group];
  if (parent.content === "item") {
    const rest = wrapping(rootShape, child);
    return rest && ["list-item", ...rest];
  }
  if (parent.content === "row")
    return child.group === "cell"
      ? ["table-row"]
      : child.group === "inline"
        ? ["table-row", "table-cell"]
        : undefined;
  if (parent.content === "cell" && child.group === "inline") return ["table-cell"];
}

function attributes(shape, value) {
  const attrs = Object.create(null);
  if (value && typeof value === "object")
    for (const [key, v] of Object.entries(value)) attrs[key] = A.isImmutableString(v) ? v.val : v;
  const get = (key, fallback) => (attrs[key] === undefined ? fallback : attrs[key]);
  if (shape.key === "image")
    return {
      src: attrs.src,
      alt: get("alt", null),
      title: get("title", null),
      dark_src: get("dark_src", null),
    };
  if (shape.key === "dataframe")
    return { src: attrs.src, media_type: attrs.media_type, title: get("title", null) };
  if (shape.key === "heading") return { level: get("level", 1) };
  if (["table-cell", "table-header"].includes(shape.key)) return { align: get("align", null) };
  if (shape.key === "list-item") return { checked: get("checked", null) };
  if (shape.key === "code-block") return { params: get("params", "") };
  return {};
}
function requiredAttrs({ shape, attrs }) {
  const keys =
    shape.key === "image" ? ["src"] : shape.key === "dataframe" ? ["src", "media_type"] : [];
  for (const key of keys)
    if (attrs[key] === undefined) throw new RangeError(`No value supplied for attribute ${key}`);
}
function nodeOf({ shape, attrs, children: content }) {
  const children = content.map((child) => (child.isText ? child : nodeOf(child)));
  if (shape.key === "doc") return { content: children };
  if (["image", "dataframe"].includes(shape.key)) return shape.tag.of(attrs);
  if (shape.content === null) return shape.tag;
  let tag = shape.tag;
  if (shape.key === "heading") tag = Heading.of(attrs.level);
  if (shape.key === "code-block" && attrs.params)
    tag = tag.withMarks([CodeBlockLanguage.of(String(attrs.params))]);
  if (shape.key === "list-item" && typeof attrs.checked === "boolean")
    tag = tag.withMarks([TaskChecked.of(attrs.checked)]);
  if (["table-cell", "table-header"].includes(shape.key) && attrs.align)
    tag = tag.withMarks([Alignment.of(attrs.align)]);
  return tag.create(children);
}

/** Preserve the raw envelope, mark, byte and task checks before interpreting
 * marker representation. Unknown data is never made admissible by a notice. */
export function validateNativeSpans(spans, maxBytes = 262144) {
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
        !isKnownBlock(value.type)
      )
        throw Error("Unsupported rich block marker");
      for (const parent of value.parents)
        if (!isKnownBlock(parent)) throw Error("Unsupported rich parent");
      if (String(value.type) === "task-list-item" && typeof value.attrs.checked !== "boolean")
        throw Error("Invalid task checked state");
    } else throw Error("Unsupported rich span");
  }

  const stack = [{ shape: rootShape, attrs: {}, children: [] }],
    ordered = [];
  const open = (shape, attrs = {}) => {
    if (!accepts(stack.at(-1).shape, shape)) throw Error("Match cannot be null");
    const frame = { shape, attrs: attributes(shape, attrs), children: [] };
    stack.push(frame);
    ordered.push(frame);
  };
  const close = () => {
    const frame = stack.at(-1);
    if (!frame.children.length && defaultChild[frame.shape.content]) {
      open(shapes.get(defaultChild[frame.shape.content]));
      close();
    }
    requiredAttrs(frame);
    stack.pop();
    stack.at(-1).children.push(frame);
  };
  const fit = (shape) => {
    for (const key of wrapping(stack.at(-1).shape, shape) ?? []) open(shapes.get(key));
    if (!accepts(stack.at(-1).shape, shape)) throw Error("Match cannot be null");
  };
  let rawCode = false;
  if (!spans.length) open(shapes.get("paragraph"));
  for (const span of spans) {
    if (span.type === "text") {
      fit(textShape);
      if (!span.value) throw new RangeError("Empty text nodes are not allowed");
      const marks = rawCode ? Mark.none : fromMarks(span.marks ?? {});
      stack.at(-1).children.push(Leaf.text(span.value, marks));
      continue;
    }
    const value = span.value;
    rawCode = String(value.type) === "code-block";
    // Stored mutable tags read as paragraphs; one mutable parent clears the
    // entire parent hint. Attribute strings unwrap only at the top level.
    const shape = shapes.get(A.isImmutableString(value.type) ? value.type.val : "paragraph");
    if (value.isEmbed) {
      fit(shape);
      if (defaultChild[shape.content])
        throw new RangeError(`Invalid content for node ${shape.errorName}: <>`);
      const frame = { shape, attrs: attributes(shape, value.attrs), children: [] };
      requiredAttrs(frame);
      ordered.push(frame);
      stack.at(-1).children.push(frame);
      continue;
    }
    const outer = [];
    if (value.parents.every(A.isImmutableString))
      for (const parent of value.parents) {
        const part = shapes.get(parent.val);
        if (part.wrapper) outer.push(shapes.get(part.wrapper));
        outer.push(part);
      }
    if (shape.wrapper) outer.push(shapes.get(shape.wrapper));
    let common = 0;
    while (
      common < outer.length &&
      common + 1 < stack.length &&
      stack[common + 1].shape.key === outer[common].key
    )
      common++;
    while (stack.length > common + 1) close();
    for (const part of outer.slice(common)) open(part);
    open(shape, value.attrs);
  }
  while (stack.length > 1) close();
  // Structural/required-attribute failures precede public attribute errors.
  for (const { shape, attrs } of ordered) {
    if (
      ["table-cell", "table-header"].includes(shape.key) &&
      attrs.align != null &&
      !validAlignment(attrs.align)
    )
      throw Error("Invalid table alignment");
    if (shape.key === "heading" && !validHeadingLevel(attrs.level))
      throw Error("Invalid heading level");
    if (
      shape.key === "image" &&
      (!safeUrl(attrs.src) || (attrs.dark_src != null && !safeUrl(attrs.dark_src)))
    )
      throw Error("Invalid rich image URL");
    if (shape.key === "dataframe" && !readDataframe(attrs))
      throw Error("Invalid dataframe: src must be a Page asset path");
  }
  // This is a serialization check, not schema.doc() or decode.lossy admission:
  // raw newlines and lenient known-feature attrs are accepted stored forms.
  treeMarkdown(nodeOf(stack[0]));
}
