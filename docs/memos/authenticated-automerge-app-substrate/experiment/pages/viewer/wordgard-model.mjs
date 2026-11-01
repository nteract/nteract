// Adapted from rgbkrk/wordgard-automerge c9c6ea8 (BSD-3-Clause).
// Pages owns the native spans. This module projects them without a Markdown or
// ProseMirror round trip, including render-only wrappers with no native offset.
import * as A from "@automerge/automerge/slim";
import { Schema, Leaf, Plot, Mark, Node, Elt, parse } from "wordgard/doc";
import {
  Doc,
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  LineBreak,
  Strong,
  Emphasis,
  Strikethrough,
  Code,
  Blockquote,
  ListItem,
  OrderedList,
  BulletList,
  HorizontalRule,
  Table,
  TableRow,
  Cell,
  HeaderCell,
} from "wordgard/types";

import {
  DEFAULT_HIGHLIGHT,
  MARK_NAMES,
  decodeMarkValue,
  encodeMarkValue,
  isKnownMark,
  normalizeHighlight,
  safeUrl,
  updateSpansConfig,
} from "../model/marks.mjs";
// The Pages table format stores physical alignment. Wordgard's stock mark
// uses logical values and does not round-trip a physical `right` clipboard style.
const validCellAlignment = (value) => ["left", "center", "right"].includes(value);
export const Alignment = Mark.Type.define("PagesCellAlignment", {
  target: [Cell, HeaderCell],
  keepOnSplit: true,
  keepOnTypeChange: true,
  validate(value) {
    if (!validCellAlignment(value)) throw Error("Invalid table alignment");
  },
  shape: { attribute: "style", value: (value) => `text-align: ${value}` },
  parseRules: [
    {
      attribute: "style/text-align",
      readAttribute(value) {
        // Pages currently has an LTR table schema (no shared direction mark).
        const physical = value === "start" ? "left" : value === "end" ? "right" : value;
        return validCellAlignment(physical) ? physical : parse.Reject;
      },
    },
    {
      attribute: "data-align",
      readAttribute: (value) => (validCellAlignment(value) ? value : parse.Reject),
    },
  ],
});
export const PagesLink = Mark.Type.define("PagesLink", {
  inclusive: false,
  validate(value) {
    if (!value || !safeUrl(value.href) || (value.title != null && typeof value.title !== "string"))
      throw Error("Invalid Pages link");
  },
  shape: {
    element: "a",
    attributes: (value) =>
      safeUrl(value.href)
        ? {
            href: value.href,
            ...(value.title ? { title: value.title } : {}),
            target: "_blank",
            rel: "noopener noreferrer",
          }
        : {},
  },
});
// Palette highlights render through theme tokens. A custom color is a raw hex
// value the stylesheet tints, so text keeps the theme's foreground color.
export const PagesHighlight = Mark.Type.define("PagesHighlight", {
  validate(value) {
    decodeMarkValue("highlight", value);
  },
  shape: {
    element: "mark",
    selector: "mark",
    attributes: (value) =>
      value.startsWith("#")
        ? { "data-highlight": "custom", style: `--pages-highlight-custom: ${value}` }
        : { "data-highlight": value },
    readElement(element) {
      try {
        const named = element.getAttribute("data-highlight");
        const custom = element.style?.getPropertyValue("--pages-highlight-custom");
        return normalizeHighlight(named === "custom" ? custom : (named ?? DEFAULT_HIGHLIGHT));
      } catch {
        return parse.Reject;
      }
    },
  },
});
// Marks a newer build wrote, keyed by name with their stored values. They
// render as plain text and are written back unchanged, so this build can edit
// a block that carries them without erasing them.
export const PagesForeignMarks = Mark.Type.define("PagesForeignMarks", {
  // Non-inclusive: typing next to a foreign run must not extend a mark this
  // build can't show or remove.
  inclusive: false,
  validate(value) {
    if (
      !value ||
      typeof value !== "object" ||
      !Object.keys(value).length ||
      Object.keys(value).some(isKnownMark)
    )
      throw Error("Invalid foreign Pages marks");
  },
  shape: {
    element: "span",
    attributes: (value) => ({ "data-pages-foreign-marks": Object.keys(value).sort().join(" ") }),
  },
});
// A preserved Markdown block from an older build. Read-only: no writer
// creates one, and the Page host converts each stored one to native content
// (model/raw-migration.mjs). The editor still decodes it so a Page that holds
// one opens; remove it once no stored Page can hold one.
export const OpaqueBlock = Leaf.Type.define("PagesOpaque", {
  group: Node.Group.Content,
  selectable: true,
  validate(value) {
    if (!value || ["source", "importId", "kind"].some((k) => typeof value[k] !== "string"))
      throw Error("Invalid preserved Pages block");
  },
  shape: {
    structure: (value) =>
      // The notice is a CSS attribute, not content, so copying the block
      // copies only its source, which pastes as an editable code block.
      Elt.mk(
        "section",
        { class: "opaque", "data-pages-opaque": "true", "data-pages-notice": PRESERVED_NOTICE },
        [Elt.mk("pre", [value.source])],
      ),
  },
});
/** Shown above a preserved block until the host's conversion arrives. */
export const PRESERVED_NOTICE =
  "Saved by an older version of Pages. It becomes editable text once Pages finishes converting it; this happens when the Page syncs.";
export const PagesImage = Leaf.Type.define("PagesImage", {
  inline: true,
  selectable: true,
  validate(value) {
    if (
      !value ||
      !safeUrl(value.src) ||
      ["alt", "title"].some((key) => value[key] != null && typeof value[key] !== "string")
    )
      throw Error("Invalid Pages image");
  },
  parseRules: [
    {
      selector: "img[src]",
      readElement(element) {
        const src = element.getAttribute("src");
        return safeUrl(src)
          ? { src, alt: element.getAttribute("alt"), title: element.getAttribute("title") }
          : parse.Reject;
      },
    },
  ],
  shape: {
    structure: (value) =>
      safeUrl(value.src)
        ? Elt.mk("img", {
            src: value.src,
            ...(value.alt != null ? { alt: value.alt } : {}),
            ...(value.title != null ? { title: value.title } : {}),
          })
        : Elt.mk("span", ["Image omitted"]),
  },
});
export const Aside = Plot.define("PagesAside", {
  group: Node.Group.Content,
  blockContent: Node.Group.Content,
  shape: { element: "aside" },
});
export const TaskList = Plot.define("PagesTaskList", {
  blockContent: [ListItem],
  group: Node.Group.Content,
  role: Node.Role.List,
  defining: true,
  autoJoin: true,
  shape: { element: "ul", attributes: { "data-task-list": "true" } },
  parseRules: [{ selector: 'ul[data-task-list="true"]', precedence: 1 }],
});
export const TaskChecked = Mark.Type.define("PagesTaskChecked", {
  target: ListItem,
  keepOnSplit: false,
  validate(value) {
    if (typeof value !== "boolean") throw Error("Invalid task checked state");
  },
  shape: { attribute: "data-task-checked", value: (value) => String(value) },
  parseRules: [
    {
      attribute: "data-task-checked",
      readAttribute: (value) =>
        value === "true" ? true : value === "false" ? false : parse.Reject,
    },
  ],
});
export const elements = [
  Doc,
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  LineBreak,
  Strong,
  Emphasis,
  Strikethrough,
  Code,
  PagesLink,
  PagesHighlight,
  PagesForeignMarks,
  Blockquote,
  ListItem,
  OrderedList,
  BulletList,
  TaskList,
  TaskChecked,
  HorizontalRule,
  OpaqueBlock,
  PagesImage,
  Aside,
  Table,
  TableRow,
  Cell,
  HeaderCell,
  Alignment,
  ...[Strong, Emphasis, Strikethrough, Code, PagesLink, PagesHighlight, PagesForeignMarks].map(
    (mark) => Schema.Override.markTarget(mark, Leaf.Text),
  ),
];
export const schema = Schema.define(elements);
export {
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  LineBreak,
  Strong,
  Emphasis,
  Strikethrough,
  Code,
  Blockquote,
  ListItem,
  OrderedList,
  BulletList,
  HorizontalRule,
  Table,
  TableRow,
  Cell,
  HeaderCell,
};
export const expand = updateSpansConfig;
// Registry mark name -> Wordgard mark type and value codec.
const markTypes = {
  strong: { type: Strong, of: () => Strong, value: () => true },
  em: { type: Emphasis, of: () => Emphasis, value: () => true },
  strike: { type: Strikethrough, of: () => Strikethrough, value: () => true },
  code: { type: Code, of: () => Code, value: () => true },
  link: {
    type: PagesLink,
    of: (link) => PagesLink.of({ href: link.href, title: link.title ?? null }),
    value: (mark) => encodeMarkValue("link", mark.value),
  },
  highlight: {
    type: PagesHighlight,
    of: (color) => PagesHighlight.of(color),
    value: (mark) => encodeMarkValue("highlight", mark.value),
  },
};
for (const name of MARK_NAMES)
  if (!markTypes[name]) throw Error(`The Wordgard schema has no type for mark ${name}`);
export function fromMarks(marks = {}) {
  const set = [];
  const foreign = {};
  for (const [name, value] of Object.entries(marks)) {
    if (!isKnownMark(name)) {
      foreign[name] = value;
      continue;
    }
    let decoded;
    try {
      decoded = decodeMarkValue(name, value);
    } catch {
      throw Error(name === "link" ? "Invalid Pages link" : `Invalid Pages ${name} mark`);
    }
    set.push(markTypes[name].of(decoded));
  }
  if (Object.keys(foreign).length) set.push(PagesForeignMarks.of(foreign));
  return set.reduce((result, mark) => mark.addToSet(result), Mark.none);
}
export function toMarks(marks) {
  const result = {};
  for (const mark of marks) {
    if (mark.type === PagesForeignMarks) {
      Object.assign(result, mark.value);
      continue;
    }
    const name = Object.keys(markTypes).find(
      (key) => markTypes[key].type === mark.type || markTypes[key].type.type === mark.type,
    );
    if (!name) throw Error(`Unsupported Wordgard inline mark: ${mark.name}`);
    try {
      result[name] = markTypes[name].value(mark);
    } catch {
      throw Error(name === "link" ? "Invalid Pages link" : `Invalid Pages ${name} mark`);
    }
  }
  return result;
}
export const markNames = (mark) => Object.keys(toMarks([mark]));
const strings = (attrs = {}) =>
  Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [k, A.isImmutableString(v) ? String(v) : v]),
  );
function descriptor(type, attrs = {}) {
  switch (type) {
    case "table":
      return { tag: Table };
    case "table-row":
      return { tag: TableRow };
    case "table-cell":
    case "table-header": {
      if (attrs.align != null && !["left", "center", "right"].includes(attrs.align))
        throw Error("Invalid table alignment");
      const tag = type === "table-cell" ? Cell : HeaderCell;
      return { tag: attrs.align ? tag.withMarks([Alignment.of(attrs.align)]) : tag };
    }
    case "paragraph":
      return { tag: Paragraph };
    case "heading": {
      const level = Number(attrs.level ?? 1);
      if (!Number.isInteger(level) || level < 1 || level > 6)
        throw Error("Invalid Pages heading level");
      return { tag: Heading.of(level) };
    }
    case "code-block":
      return {
        tag: attrs.params
          ? CodeBlock.withMarks([CodeBlockLanguage.of(String(attrs.params))])
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
    case "task-list-item": {
      const checked = Object.hasOwn(attrs, "checked") ? attrs.checked : false;
      if (typeof checked !== "boolean") throw Error("Invalid task checked state");
      return { tag: ListItem.withMarks([TaskChecked.of(checked)]), outer: TaskList };
    }
    default:
      throw Error(`Unsupported Pages block: ${type}`);
  }
}

export function decode(spans) {
  const blocks = [],
    stack = [],
    wgToAm = [],
    amToWg = [];
  let wg = 0,
    am = 0;
  const boundary = () => {
    wgToAm[wg] = am;
    amToWg[am] ??= wg;
  };
  const append = (node) => (stack.at(-1)?.children ?? blocks).push(node);
  const open = (tag, native = false) => {
    boundary();
    stack.push({ tag, children: [] });
    wg++;
    if (native) am++;
    boundary();
    // Render-only wrappers share a native position. Prefer an editable interior.
    amToWg[am] = wg;
  };
  const close = () => {
    if (!stack.at(-1).tag.type.spec.inlineContent && !stack.at(-1).children.length) {
      open(Paragraph);
      close();
    }
    const frame = stack.pop();
    boundary();
    wg++;
    wgToAm[wg] = am;
    append(frame.tag.create(frame.children));
  };
  const ensureText = () => {
    if (!stack.at(-1)?.tag.type.spec.inlineContent) open(Paragraph);
  };
  const leaf = (node, length = 1) => {
    boundary();
    append(node);
    for (let i = 0; i < length; i++) {
      wg++;
      am++;
      boundary();
    }
  };
  for (const span of spans) {
    if (span.type === "text") {
      ensureText();
      const marks = fromMarks(span.marks);
      // Wordgard uses a LineBreak leaf for newlines in code and prose. Code
      // text is unformatted, so marks a code span carries are not decoded.
      const code = stack.at(-1)?.tag.type === CodeBlock.type;
      const textMarks = code ? Mark.none : marks;
      span.value.split("\n").forEach((part, i) => {
        if (i) leaf(LineBreak);
        if (part) leaf(Leaf.text(part, textMarks), part.length);
      });
      continue;
    }
    if (span.type !== "block" || !span.value || !Array.isArray(span.value.parents))
      throw Error("Invalid Pages rich span");
    const value = span.value,
      type = String(value.type),
      attrs = strings(value.attrs);
    if (value.isEmbed) {
      ensureText();
      if (type === "hard-break") leaf(LineBreak);
      else if (type === "image") {
        if (!safeUrl(attrs.src)) throw Error("Invalid Pages image");
        leaf(PagesImage.of({ src: attrs.src, alt: attrs.alt ?? null, title: attrs.title ?? null }));
      } else throw Error(`Unsupported Pages embed: ${type}`);
      continue;
    }
    const outer = [];
    for (const parent of value.parents) {
      const d = descriptor(String(parent));
      if (d.outer) outer.push(d.outer);
      outer.push(d.tag);
    }
    // Leaf blocks hold no content of their own.
    const leafBlock = type === "pages-opaque" || type === "horizontal-rule";
    const desc = leafBlock ? null : descriptor(type, attrs);
    if (desc?.outer) outer.push(desc.outer);
    let common = 0;
    while (
      common < outer.length &&
      common < stack.length &&
      stack[common].tag.type === outer[common].type
    )
      common++;
    while (stack.length > common) close();
    for (let i = common; i < outer.length; i++) open(outer[i]);
    if (type === "horizontal-rule") leaf(HorizontalRule);
    else if (type === "pages-opaque") {
      leaf(
        OpaqueBlock.of({
          source: String(attrs.source ?? ""),
          importId: String(attrs.importId ?? ""),
          kind: String(attrs.kind ?? "markdown"),
        }),
      );
    } else open(desc.tag, true);
  }
  if (!blocks.length && !stack.length) open(Paragraph);
  // Empty list items and containers still need an editable paragraph.
  if (stack.length && !stack.at(-1).tag.type.spec.inlineContent && !stack.at(-1).children.length)
    open(Paragraph);
  while (stack.length) close();
  boundary();
  return { doc: schema.doc(blocks), map: { wgToAm, amToWg } };
}

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
  // A first paragraph can omit its marker when it has content or is the
  // container's only child. Otherwise, emit a marker to preserve the empty
  // paragraph.
  const implicitAt = (siblings, i) =>
    i === 0 && (siblings.length === 1 || siblings[0].content?.length > 0);
  const block = (node, parents, implicit = false, listType = null) => {
    if (node.type === OpaqueBlock) {
      marker("pages-opaque", parents, node.param);
      return;
    }
    if (node.type === HorizontalRule.type) {
      marker("horizontal-rule", parents);
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
    else
      node.content.forEach((child, i, siblings) =>
        block(child, [...parents, type], implicitAt(siblings, i)),
      );
  };
  doc.content.forEach((node, i, siblings) => block(node, [], implicitAt(siblings, i)));
  return spans;
}
