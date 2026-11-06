// Adapted from rgbkrk/wordgard-automerge c9c6ea8 (BSD-3-Clause); see
// viewer/WORDGARD-NOTICE.
// The Pages document model: the Wordgard schema (node and mark types), the
// stored-type descriptor table, and the span codec (decode, encode). Pages owns
// the native spans. This module projects them without a Markdown or ProseMirror
// round trip, including render-only wrappers with no native offset.
//
// It imports only wordgard/doc and wordgard/types, which are DOM-free, so the
// Worker and the browser share it. Shapes and parse rules are data until an
// editor calls them. Code that needs the DOM or wordgard/editor belongs in
// viewer/ (viewer/wordgard-model.mjs re-exports this module for the editor).
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
} from "./marks.mjs";
import { DATAFRAME_BLOCK, readDataframe } from "../shared/dataset-assets.mjs";
import { imageAttrs } from "./image-attrs.mjs";
import { TEXT_CONTAINERS, validAlignment, validHeadingLevel } from "./node-registry.mjs";
// The Pages table format stores physical alignment. Wordgard's stock mark
// uses logical values and does not round-trip a physical `right` clipboard style.
const validCellAlignment = validAlignment;
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
  // Wordgard's own Link rank: a link draws around emphasis, bold, strike,
  // code and highlight (rank 40 to 100), so one link is one <a> however its
  // text is formatted. Rank orders only the in-memory mark set and the DOM:
  // encoded spans keep their mark order (toMarks), so storage, node
  // addresses and Markdown are unchanged.
  rank: 20,
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
    // Pasted and dropped HTML keeps its links. The raw attribute keeps a
    // relative link relative; an unsafe scheme keeps the text unlinked.
    readElement(element) {
      const href = element.getAttribute("href");
      if (!href || !safeUrl(href)) return parse.Reject;
      return { href, title: element.getAttribute("title") || null };
    },
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
const IMAGE_ATTR = "data-pages-image";
const IMAGE_METADATA_LIMIT = 16 * 1024;
function imageMetadata(value) {
  const attrs = imageAttrs(value);
  if (!attrs || Object.keys(attrs).length > 64 || Object.keys(attrs).some((k) => k.length > 256))
    throw Error("Invalid Pages image metadata");
  const json = JSON.stringify(
    Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))),
  );
  if (json.length > IMAGE_METADATA_LIMIT) throw Error("Pages image metadata is too large to copy");
  return json;
}
function copyImageMetadata(value) {
  try {
    return imageMetadata(value);
  } catch {
    // Keep rendering a valid native image, but refuse a lossy Pages paste.
    return "null";
  }
}
export const PagesImage = Leaf.Type.define("PagesImage", {
  inline: true,
  selectable: true,
  validate(value) {
    if (
      !imageAttrs(value) ||
      !safeUrl(value.src) ||
      (value.dark_src != null && !safeUrl(value.dark_src)) ||
      ["alt", "title"].some((key) => value[key] != null && typeof value[key] !== "string")
    )
      throw Error("Invalid Pages image");
  },
  parseRules: [
    {
      selector: "img[src]",
      readElement(element) {
        const src = element.getAttribute("src");
        if (!safeUrl(src)) return parse.Reject;
        const metadata = element.getAttribute(IMAGE_ATTR);
        if (metadata !== null) {
          try {
            if (metadata.length > IMAGE_METADATA_LIMIT) return parse.Reject;
            const attrs = JSON.parse(metadata);
            imageMetadata(attrs);
            PagesImage.spec.validate(attrs);
            // Metadata cannot override the sanitized, visible image identity.
            if (
              ["src", "alt", "title"].some(
                (key) => (attrs[key] ?? null) !== element.getAttribute(key),
              )
            )
              return parse.Reject;
            return attrs;
          } catch {
            return parse.Reject;
          }
        }
        return { src, alt: element.getAttribute("alt"), title: element.getAttribute("title") };
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
            [IMAGE_ATTR]: copyImageMetadata(value),
          })
        : Elt.mk("span", ["Image omitted"]),
  },
});
// A dataframe: a block with no text that names a Page dataset asset. Its
// value is the stored attrs as strings, including any this build doesn't
// know, so encode writes them back unchanged (shared/dataset-assets.mjs
// readDataframe). The leaf's shape is what copy writes: a figure carrying the
// attrs as JSON, which its parse rule reads back on paste. In the editor,
// viewer/wordgard-dataframes.mjs draws the table instead.
export const DATAFRAME_ATTR = "data-pages-dataframe";
const scalar = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);
export const plainAttrs = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => scalar(v)))
    : null;
export const PagesDataframe = Leaf.Type.define("PagesDataframe", {
  group: Node.Group.Content,
  selectable: true,
  validate(value) {
    if (!readDataframe(value) || Object.values(value).some((v) => !scalar(v)))
      throw Error("Invalid Pages dataframe");
  },
  parseRules: [
    {
      selector: `figure[${DATAFRAME_ATTR}]`,
      readElement(element) {
        try {
          const value = plainAttrs(JSON.parse(element.getAttribute(DATAFRAME_ATTR)));
          return value && readDataframe(value) ? value : parse.Reject;
        } catch {
          return parse.Reject;
        }
      },
    },
  ],
  shape: {
    structure: (value) =>
      Elt.mk(
        "figure",
        {
          class: "wordgard-dataframe",
          [DATAFRAME_ATTR]: JSON.stringify(value),
          "aria-label": value.title || "Table",
        },
        [value.title || "Table"],
      ),
  },
});
// A node this build doesn't know, written by a newer build. Its feature stamp
// makes the Page read-only here (schemaGateStep in viewer/session.mjs), so it
// is drawn as a notice. Its value is the stored marker: type, attrs, parents
// and isEmbed, and encode writes exactly that marker back. decode reports
// `lossy` when it can't place a node where it was stored, or when it skips a
// container this build doesn't know; the binding refuses writes then, so an
// unstamped Page can't flatten what it can't draw.
export const UNKNOWN_NODE_NOTICE = "Added by a newer version of Pages. Reload to see it.";
function validateUnknown(value) {
  if (
    !value ||
    typeof value.type !== "string" ||
    !value.attrs ||
    typeof value.attrs !== "object" ||
    !Array.isArray(value.immutable) ||
    !Array.isArray(value.parents) ||
    typeof value.isEmbed !== "boolean"
  )
    throw Error("Invalid unknown Pages node");
}
const unknownShape = (tag) => ({
  // The notice is a CSS attribute, not content: copying the node copies
  // nothing that pastes as text.
  structure: (value) =>
    Elt.mk(tag, {
      class: "unknown-node",
      "data-pages-node": value.type,
      "data-pages-notice": UNKNOWN_NODE_NOTICE,
    }),
});
export const PagesUnknownBlock = Leaf.Type.define("PagesUnknownBlock", {
  group: Node.Group.Content,
  selectable: true,
  validate: validateUnknown,
  shape: unknownShape("section"),
});
export const PagesUnknownEmbed = Leaf.Type.define("PagesUnknownEmbed", {
  inline: true,
  selectable: true,
  validate: validateUnknown,
  shape: unknownShape("span"),
});
/** An unknown marker's value: its type, attrs as plain values, which attrs
 * were immutable strings, its parents and isEmbed, so encode restores the
 * exact stored marker. */
function unknownValue(marker) {
  const immutable = [];
  const attrs = Object.fromEntries(
    Object.entries(marker.attrs ?? {}).map(([key, value]) => {
      if (!A.isImmutableString(value)) return [key, value];
      immutable.push(key);
      return [key, String(value)];
    }),
  );
  return {
    type: String(marker.type),
    attrs,
    immutable,
    parents: (marker.parents ?? []).map(String),
    isEmbed: !!marker.isEmbed,
  };
}
function storedAttrs({ attrs, immutable }) {
  return Object.fromEntries(
    Object.entries(attrs).map(([key, value]) => [
      key,
      immutable.includes(key) ? new A.ImmutableString(value) : value,
    ]),
  );
}
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
  PagesImage,
  PagesDataframe,
  PagesUnknownBlock,
  PagesUnknownEmbed,
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
// The order encoded spans name their marks in. A mark set orders marks by
// rank, which also decides how they nest in the DOM (PagesLink's rank draws a
// link around the other marks); encoded spans keep this fixed order instead,
// the one they had before PagesLink had a rank, so a document encodes to the
// same JSON whatever the marks' ranks.
const ENCODED_MARK_ORDER = [
  "Strikethrough",
  "Emphasis",
  "Strong",
  "Code",
  "PagesForeignMarks",
  "PagesHighlight",
  "PagesLink",
];
const encodedRank = (mark) => {
  const index = ENCODED_MARK_ORDER.indexOf(mark.type.name);
  return index < 0 ? ENCODED_MARK_ORDER.length : index;
};
export function toMarks(marks) {
  const result = {};
  for (const mark of [...marks].sort((a, b) => encodedRank(a) - encodedRank(b))) {
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
      if (attrs.align != null && !validAlignment(attrs.align))
        throw Error("Invalid table alignment");
      const tag = type === "table-cell" ? Cell : HeaderCell;
      return { tag: attrs.align ? tag.withMarks([Alignment.of(attrs.align)]) : tag };
    }
    case "paragraph":
      return { tag: Paragraph };
    case "heading": {
      // The same rule registration applies: an integer 1 to 6, 1 when absent.
      const level = attrs.level === undefined ? 1 : attrs.level;
      if (!validHeadingLevel(level)) throw Error("Invalid Pages heading level");
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
      // A type this build doesn't know; decode draws a notice.
      return null;
  }
}

/** The editor tree for a block's spans, the native/editor position maps, and
 * whether the tree had to leave out something it couldn't place (`lossy`). */
export function decode(spans) {
  const blocks = [],
    stack = [],
    wgToAm = [],
    amToWg = [];
  let wg = 0,
    am = 0,
    lossy = false,
    afterUnknown = false;
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
  const inCode = () => stack.at(-1)?.tag.type === CodeBlock.type;
  // An unknown node where only text can go: a code block holds nothing but
  // text, so it shows an object replacement character; other text containers
  // (a table cell) show the inline notice.
  const unknownInline = (value) => {
    if (inCode()) {
      lossy = true;
      leaf(Leaf.text("\uFFFC", Mark.none));
    } else leaf(PagesUnknownEmbed.of(unknownValue(value)));
  };
  for (const span of spans) {
    if (span.type === "text") {
      // Text right after an unknown block is that block's own content, which
      // this build draws as a separate paragraph.
      if (afterUnknown) lossy = true;
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
    afterUnknown = false;
    if (value.isEmbed) {
      ensureText();
      if (type === "hard-break") leaf(LineBreak);
      else if (type === "image") {
        if (!safeUrl(attrs.src)) throw Error("Invalid Pages image");
        if (!imageAttrs(value.attrs)) {
          lossy = true;
          unknownInline(value);
        } else {
          PagesImage.spec.validate(attrs);
          leaf(PagesImage.of(attrs));
        }
      } else unknownInline(value);
      continue;
    }
    const outer = [];
    for (const parent of value.parents) {
      // A container this build doesn't know draws nothing of its own; its
      // content renders at the nearest known level.
      const d = descriptor(String(parent));
      if (!d) {
        lossy = true;
        continue;
      }
      if (d.outer) outer.push(d.outer);
      outer.push(d.tag);
    }
    // Leaf blocks hold no content of their own.
    // A dataframe stored inside a text container (a table cell, a code
    // block) can't be drawn there. No Pages writer puts one there; one from
    // a peer takes the unknown-node path below (an inline notice, lossy).
    const inText = value.parents.some((parent) => TEXT_CONTAINERS.has(String(parent)));
    const dataframe =
      type === DATAFRAME_BLOCK &&
      !inText &&
      readDataframe(attrs) &&
      Object.values(attrs).every(scalar)
        ? attrs
        : null;
    const builtIn = type === "horizontal-rule" || !!dataframe;
    const desc = builtIn ? null : descriptor(type, attrs);
    const unknown = !builtIn && !desc;
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
    if (unknown) {
      afterUnknown = true;
      if (stack.at(-1)?.tag.type.spec.inlineContent) {
        // Stored inside a text container (a table cell): drawn inline.
        lossy = true;
        unknownInline(value);
      } else leaf(PagesUnknownBlock.of(unknownValue(value)));
    } else if (type === "horizontal-rule") leaf(HorizontalRule);
    else if (dataframe) leaf(PagesDataframe.of(dataframe));
    else open(desc.tag, true);
  }
  if (!blocks.length && !stack.length) open(Paragraph);
  // Empty list items and containers still need an editable paragraph.
  if (stack.length && !stack.at(-1).tag.type.spec.inlineContent && !stack.at(-1).children.length)
    open(Paragraph);
  while (stack.length) close();
  boundary();
  return { doc: schema.doc(blocks), map: { wgToAm, amToWg }, lossy };
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
  // An unknown node's marker, exactly as it was stored, wherever decode drew it.
  const unknownMarker = (node) => {
    validateUnknown(node.param);
    spans.push({
      type: "block",
      value: {
        type: new A.ImmutableString(node.param.type),
        parents: node.param.parents.map((p) => new A.ImmutableString(p)),
        attrs: storedAttrs(node.param),
        isEmbed: node.param.isEmbed,
      },
    });
  };
  const inline = (node, parents, code = false) => {
    if (node.isText)
      spans.push({ type: "text", value: String(node.param), marks: toMarks(node.marks) });
    else if (node.type === LineBreak.type) {
      if (code) spans.push({ type: "text", value: "\n", marks: toMarks(node.marks) });
      else marker("hard-break", parents, {}, true);
    } else if (node.type === PagesImage) {
      PagesImage.spec.validate(node.param);
      marker("image", parents, node.param, true);
    } else if (node.type === PagesUnknownEmbed) unknownMarker(node);
    else throw Error(`Unsupported Wordgard inline node: ${node.name}`);
  };
  // A first paragraph can omit its marker when it has content or is the
  // container's only child. Otherwise, emit a marker to preserve the empty
  // paragraph.
  const implicitAt = (siblings, i) =>
    i === 0 && (siblings.length === 1 || siblings[0].content?.length > 0);
  const block = (node, parents, implicit = false, listType = null) => {
    if (node.type === PagesUnknownBlock) {
      unknownMarker(node);
      return;
    }
    if (node.type === HorizontalRule.type) {
      marker("horizontal-rule", parents);
      return;
    }
    if (node.type === PagesDataframe) {
      marker(DATAFRAME_BLOCK, parents, node.param);
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
