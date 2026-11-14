import { dataframeValue } from "../shared/dataset-assets.mjs";
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
import { VIEW_ATTR, VIEW_BLOCK, VIEW_ID_ATTR, readViewNode } from "../shared/views.mjs";
import { imageAttrs } from "./image-attrs.mjs";
import { markerParents } from "./richtext-format.mjs";
import {
  isKnownBlock,
  TEXT_CONTAINERS,
  validAlignment,
  validHeadingLevel,
  markerName,
  markerType,
} from "./node-registry.mjs";
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
// Marks a newer build wrote, keyed by name with their stored values: a name
// this build doesn't know, or a known name whose value it can't read or must
// not render (readMark). They render as plain text and are written back
// unchanged, so this build can edit a block that carries them without
// erasing them.
export const PagesForeignMarks = Mark.Type.define("PagesForeignMarks", {
  // Non-inclusive: typing next to a foreign run must not extend a mark this
  // build can't show or remove.
  inclusive: false,
  validate(value) {
    if (
      !value ||
      typeof value !== "object" ||
      !Object.keys(value).length ||
      Object.entries(value).some(([name, stored]) => readMark(name, stored))
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
    ? Object.fromEntries(Object.entries(value).filter(([k, v]) => dataframeValue(k, v)))
    : null;
export const PagesDataframe = Leaf.Type.define("PagesDataframe", {
  group: Node.Group.Content,
  selectable: true,
  validate(value) {
    if (!readDataframe(value) || !Object.entries(value).every(([k, v]) => dataframeValue(k, v)))
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
// A view: a block with no text whose `view_id` names one of the Page's
// views, a chart in its own document (model/view-doc.mjs). Its value is the
// stored attrs as scalars, including any this build doesn't know, so encode
// writes them back unchanged (shared/views.mjs readViewNode). The leaf's
// shape is what copy writes and what a build without a chart widget draws:
// a figure naming the view id, which its parse rule reads back on paste.
export const PagesView = Leaf.Type.define("PagesView", {
  group: Node.Group.Content,
  selectable: true,
  validate(value) {
    if (!readViewNode(value) || Object.values(value).some((v) => !scalar(v)))
      throw Error("Invalid Pages view");
  },
  parseRules: [
    {
      selector: `figure[${VIEW_ATTR}]`,
      readElement(element) {
        const value = readViewNode({ view_id: element.getAttribute(VIEW_ID_ATTR) });
        return value ?? parse.Reject;
      },
    },
  ],
  shape: {
    structure: (value) =>
      Elt.mk(
        "figure",
        {
          class: "wordgard-view",
          [VIEW_ATTR]: "",
          [VIEW_ID_ATTR]: value.view_id,
          "aria-label": `View ${value.view_id}`,
        },
        [value.view_id],
      ),
  },
});
// A node this build doesn't know, written by a newer build. Its feature stamp
// makes the Page read-only here (schemaGateStep in viewer/session.mjs), so it
// is drawn as a notice. Its value is the stored marker: type, attrs, parents
// and isEmbed, and encode writes exactly that marker back. decode reports
// `newer` content and `lossy` when it skips a container this build doesn't
// know; the binding refuses writes then, so an unstamped Page can't flatten
// what it can't draw.
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
    Object.entries(attrMap(marker.attrs) ?? {}).map(([key, value]) => {
      if (!A.isImmutableString(value)) return [key, value];
      immutable.push(key);
      return [key, String(value)];
    }),
  );
  return {
    // A type that isn't a name is quoted as nothing: its notice names no node.
    type: markerType(marker) ?? "",
    attrs,
    immutable,
    parents: storedParents(marker),
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
// A copy carries data-pages-aside, so a paste tells an aside copied inside
// Pages from one in outside HTML, which unwrapPastedAsides
// (viewer/clipboard-html.mjs) replaces by its content.
export const Aside = Plot.define("PagesAside", {
  group: Node.Group.Content,
  blockContent: Node.Group.Content,
  shape: { element: "aside", attributes: { "data-pages-aside": "true" } },
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
  PagesView,
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
const DOC_TYPE = schema.doc([Paragraph.create([])]).type;
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
/** The mark a stored name and value read as, or null when this build doesn't
 * know the name, can't read the value or must not render it (a link to an
 * unsafe URL, a highlight outside the registry's colors). Every reader treats
 * a null mark the same way: kept as stored in PagesForeignMarks, drawn as
 * nothing and written back by encode. */
export function readMark(name, value) {
  if (!isKnownMark(name)) return null;
  try {
    return markTypes[name].of(decodeMarkValue(name, value));
  } catch {
    return null;
  }
}
export function fromMarks(marks = {}) {
  const set = [];
  const foreign = {};
  for (const [name, value] of Object.entries(marks)) {
    const mark = readMark(name, value);
    if (mark) set.push(mark);
    else foreign[name] = value;
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
  // A readable mark wins over a stored value of the same name in
  // PagesForeignMarks, whatever their order (wordgardForeignMarks in
  // viewer/wordgard-binding.mjs keeps the editor from holding both).
  const readable = new Set(
    [...marks]
      .filter((mark) => mark.type !== PagesForeignMarks)
      .map((mark) => markTypeName(mark))
      .filter(Boolean),
  );
  for (const mark of [...marks].sort((a, b) => encodedRank(a) - encodedRank(b))) {
    if (mark.type === PagesForeignMarks) {
      for (const [name, value] of Object.entries(mark.value))
        if (!readable.has(name)) result[name] = value;
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
function markTypeName(mark) {
  return Object.keys(markTypes).find(
    (key) => markTypes[key].type === mark.type || markTypes[key].type.type === mark.type,
  );
}
const strings = (attrs = {}) =>
  Object.fromEntries(
    Object.entries(attrMap(attrs) ?? {}).map(([k, v]) => [
      k,
      A.isImmutableString(v) ? String(v) : v,
    ]),
  );
/** A marker's attrs when they are a map, or null. */
export const attrMap = (attrs = {}) =>
  attrs && typeof attrs === "object" && !Array.isArray(attrs) && !A.isImmutableString(attrs)
    ? attrs
    : null;

/** Whether this build can't read a stored marker's own values, or must not
 * render them: a value that isn't a map, attrs that aren't one, an image
 * whose attributes PagesImage refuses (an unsafe or missing src), a heading
 * level, table alignment or task state outside what this build writes.
 * Every reader draws such a marker as the notice for a node this build
 * doesn't know, and encode writes it back as stored. */
export function unreadableMarker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  if (value.attrs != null && !attrMap(value.attrs)) return true;
  const type = markerType(value),
    attrs = strings(value.attrs);
  if (type === null) return true;
  try {
    if (value.isEmbed) {
      if (type === "image") {
        if (!imageAttrs(value.attrs)) return true;
        PagesImage.spec.validate(attrs);
      }
      return false;
    }
    descriptor(type, attrs);
    return false;
  } catch {
    return true;
  }
}
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

/** A marker's parents as stored names: a list, or none. */
export const storedParents = markerParents;

const typeOf = (tag) => tag.type ?? tag;
/** Where a node of `tag` nests in `chain` (`[{ tag }]`, outermost first):
 * the length of the longest prefix whose last container can hold it, 0 for
 * the top level, or null when nothing in the chain, nor the top level, can.
 * Every reader nests a marker's parents and then the node by this rule:
 * each nests in the nearest container before it that can hold it, so a
 * repeated container or a parent that can't hold the next one drops out,
 * and decode reports the block's nesting `adjusted`. */
export function nestIn(chain, tag) {
  const type = typeOf(tag);
  for (let depth = chain.length; depth > 0; depth--)
    if (schema.canContain(typeOf(chain[depth - 1].tag), type)) return depth;
  return schema.canContain(DOC_TYPE, type) ? 0 : null;
}

/** The containers a table part needs around it, outermost first. Where no
 * container in its chain holds one, a reader draws these around it, as
 * containers with no marker of their own. */
export const TABLE_PART_OUTER = {
  "table-row": ["table"],
  "table-cell": ["table", "table-row"],
  "table-header": ["table", "table-row"],
};

/** Whether a code block holds an inline embed of `type` stored with
 * `parents`. A code block holds text and line breaks; every other textblock
 * holds every inline node. An embed of a type this build doesn't know that
 * was stored in the code block (its parents end there) stays there, drawn as
 * a notice. Anything else a merge leaves after a code block (an image, or an
 * embed stored in a paragraph that was deleted) can't continue it. */
export function codeHolds(type, parents) {
  if (type === "hard-break") return true;
  if (type === "image") return false;
  return markerName(parents.at(-1)) === "code-block";
}

/** The editor tree for a block's spans, the native/editor position maps,
 * the unmarked text it drew (`unmarked`) and the containers it drew with
 * no marker of their own (`rebuilt`), each with the native offset where a
 * writer's marker for it would go.
 *
 * Two reasons a block can't be drawn as stored are reported apart:
 * - `newer`: it holds content from a newer build: a node, container or embed
 *   name this build doesn't know, attributes it can't read, or a known node
 *   stored where this build can't draw it (a dataframe in a table cell).
 *   A node or embed drawn whole as a notice round-trips; a container that
 *   draws nothing, text after an unknown node or unreadable attributes
 *   don't, and make the block lossy. No repair rewrites a newer block.
 * - `adjusted`: every name is known, but nestIn re-homed a node or dropped
 *   or skipped one of its parents (parents no writer wrote, which a merge
 *   of two writers' parents can leave). `moved` lists each such node
 *   marker's offset and the parents it is drawn with; storing those parents
 *   (repairBlockMarkers in model/richtext-page.mjs) leaves the same tree
 *   with nothing adjusted.
 * `lossy` is either one that makes the tree differ from what is stored. */
export function decode(spans) {
  const blocks = [],
    stack = [],
    wgToAm = [],
    amToWg = [];
  let wg = 0,
    am = 0,
    newer = false,
    // Newer content this build draws only in part: a notice in place of a
    // container, text or attributes.
    partial = false,
    adjusted = false,
    afterUnknown = false;
  // Each node marker drawn with parents other than its stored ones.
  const moved = [];
  const boundary = () => {
    wgToAm[wg] = am;
    amToWg[am] ??= wg;
  };
  // Each unmarked run's start and the markers that would open it there.
  const unmarked = [];
  // Each container drawn from a later marker's parents because its own
  // marker is gone, and the marker a writer would have stored for it.
  const rebuilt = [];
  const append = (node) => (stack.at(-1)?.children ?? blocks).push(node);
  // `name` is the stored marker type a frame stands for (null for a list,
  // which has no marker of its own).
  const open = (tag, native = false, name = null) => {
    boundary();
    stack.push({ tag, children: [], name });
    wg++;
    if (native) am++;
    boundary();
    // Render-only wrappers share a native position. Prefer an editable interior.
    amToWg[am] = wg;
  };
  const close = () => {
    if (!stack.at(-1).tag.type.spec.inlineContent && !stack.at(-1).children.length) {
      const type = stack.at(-1).tag.type;
      open(type === Table.type ? TableRow : type === TableRow.type ? Cell : Paragraph);
      close();
    }
    const frame = stack.pop();
    boundary();
    wg++;
    wgToAm[wg] = am;
    append(frame.tag.create(frame.children));
  };
  // Content continues the node before it in its scope when that node can
  // hold it. Unmarked text is content no marker opens where its scope has
  // no node before it that can hold it: at the start of a block or a
  // container, after a leaf (a rule, a dataframe), or after a code block for
  // an inline node the code block can't hold (codeHolds). Only a merge of
  // concurrent edits leaves it (a peer typing into a node another writer
  // deletes); no writer does. It reads as a paragraph (in a
  // table, a row and cell) with no marker, so it has no node id, and
  // `unmarked` records the markers a writer adds to mark it
  // (repairBlockMarkers in model/richtext-page.mjs). What a node this build
  // doesn't know stores right after its own marker is that node's content
  // instead: drawn as a paragraph of its own, and the block is lossy.
  const ensureText = () => {
    if (stack.at(-1)?.tag.type.spec.inlineContent) return;
    if (afterUnknown) newer = partial = true;
    const markers = [];
    const opening = (tag, name) => {
      markers.push({ type: name, parents: stack.map((f) => f.name).filter(Boolean) });
      open(tag, false, name);
    };
    const at = am;
    if (stack.at(-1)?.tag.type === Table.type) opening(TableRow, "table-row");
    if (stack.at(-1)?.tag.type === TableRow.type) opening(Cell, "table-cell");
    if (!stack.at(-1)?.tag.type.spec.inlineContent) opening(Paragraph, "paragraph");
    if (!afterUnknown) unmarked.push({ at, markers });
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
      newer = partial = true;
      leaf(Leaf.text("\uFFFC", Mark.none));
    } else leaf(PagesUnknownEmbed.of(unknownValue(value)));
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
    if (span.type !== "block") throw Error("Invalid Pages rich span");
    // A marker whose value isn't a map reads as an inline notice; encode
    // can't write it back as stored.
    if (!span.value || typeof span.value !== "object" || Array.isArray(span.value)) {
      ensureText();
      newer = partial = true;
      unknownInline({ type: markerName(span.value) ?? "", isEmbed: true });
      continue;
    }
    // A marker's parents are a list of names. Anything else reads as no
    // parents: a node marker's nesting is then adjusted; an embed's parents
    // only say whether a code block holds it.
    const listed = Array.isArray(span.value.parents);
    const value = { ...span.value, parents: storedParents(span.value) },
      type = markerType(value),
      attrs = strings(value.attrs),
      unreadable = unreadableMarker(span.value);
    // Attrs that aren't a map, and a type or parent that isn't a name, can't
    // be written back as stored.
    if (span.value.attrs != null && !attrMap(span.value.attrs)) newer = partial = true;
    if (type === null || (listed && span.value.parents.some((p) => markerName(p) === null)))
      newer = partial = true;
    if (value.isEmbed) {
      // An embed a code block can't hold opens a paragraph after it.
      if (inCode() && !codeHolds(type, value.parents)) close();
      ensureText();
      if (type === "hard-break") leaf(LineBreak);
      else if (type === "image") {
        // An image this build can't read, or whose src it must not render.
        if (unreadable) {
          newer = partial = true;
          unknownInline(value);
        } else leaf(PagesImage.of(attrs));
      } else {
        newer = true;
        unknownInline(value);
      }
      continue;
    }
    afterUnknown = false;
    // The containers the marker's parents name, nested by nestIn.
    const outer = [];
    const place = (entry) => {
      const depth = nestIn(outer, entry.tag);
      if (depth === null) return false;
      if (depth < outer.length) outer.length = depth;
      outer.push(entry);
      return true;
    };
    for (const parent of value.parents) {
      // A container this build doesn't know draws nothing of its own; its
      // content renders at the nearest known level. A known name that
      // holds no nodes (a rule, an image) is no parent: it drops out, and
      // the marker's nesting is adjusted.
      const d = descriptor(String(parent));
      if (!d) {
        if (isKnownBlock(String(parent))) adjusted = true;
        else newer = partial = true;
        continue;
      }
      const before = outer.length;
      if (d.outer && !place({ tag: d.outer, name: null })) adjusted = true;
      else if (!place({ tag: d.tag, name: String(parent) })) adjusted = true;
      else if (outer.length !== before + (d.outer ? 2 : 1)) adjusted = true;
    }
    // Leaf blocks hold no content of their own.
    // A dataframe stored inside a text container (a table cell, a code
    // block) can't be drawn there. No Pages writer puts one there; one from
    // a peer takes the unknown-node path below (an inline notice, lossy).
    const inText = value.parents.some((parent) => TEXT_CONTAINERS.has(String(parent)));
    // A view takes the same path.
    const dataframe =
      type === DATAFRAME_BLOCK &&
      !inText &&
      readDataframe(attrs) &&
      Object.entries(attrs).every(([k, v]) => dataframeValue(k, v))
        ? attrs
        : null;
    const view =
      type === VIEW_BLOCK && !inText && readViewNode(attrs) && Object.values(attrs).every(scalar)
        ? attrs
        : null;
    const builtIn = type === "horizontal-rule" || !!dataframe || !!view;
    let desc = builtIn || unreadable ? null : descriptor(type, attrs);
    // The node itself nests the same way. A table part no container in its
    // chain holds is drawn inside the table containers it needs
    // (TABLE_PART_OUTER), which have no marker of their own.
    const own =
      type === "horizontal-rule"
        ? HorizontalRule
        : dataframe
          ? PagesDataframe
          : view
            ? PagesView
            : desc;
    const fits = (tag) => {
      const depth = nestIn(outer, tag);
      if (depth === null) return false;
      if (depth < outer.length) {
        adjusted = true;
        outer.length = depth;
      }
      return true;
    };
    const wrapped = (tag) => {
      const names = TABLE_PART_OUTER[type];
      if (!names) return false;
      for (let from = names.length - 1; from >= 0; from--) {
        const first = descriptor(names[from]).tag;
        if (nestIn(outer, first) === null) continue;
        for (const name of names.slice(from)) place({ tag: descriptor(name).tag, name });
        adjusted = true;
        return fits(tag);
      }
      return false;
    };
    let unknown = !builtIn && !desc;
    if (unknown) newer = true;
    if (desc) {
      if (
        desc.outer ? !place({ tag: desc.outer, name: null }) : !fits(desc.tag) && !wrapped(desc.tag)
      ) {
        adjusted = true;
        desc = null;
        unknown = true;
      }
    } else if (own && !fits(own)) {
      adjusted = true;
      unknown = true;
    }
    if (!unknown) {
      const drawn = outer.map((entry) => entry.name).filter(Boolean);
      if (!listed || drawn.join("\u0000") !== value.parents.join("\u0000")) {
        adjusted = true;
        moved.push({ at: am, parents: drawn });
      }
      // A notice can't write back parents that aren't a list.
    } else if (!listed) newer = partial = true;
    if (unknown && !outer.at(-1)?.tag.type.spec.inlineContent) fits(PagesUnknownBlock);
    let common = 0;
    while (
      common < outer.length &&
      common < stack.length &&
      stack[common].tag.type === outer[common].tag.type
    )
      common++;
    while (stack.length > common) close();
    // A named container opened here has no marker of its own: a merge
    // deleted it while a peer added a node inside it. Every reader draws it
    // from the surviving node's parents, and no writer restores its marker.
    for (let i = common; i < outer.length; i++) {
      if (outer[i].name)
        rebuilt.push({
          at: am,
          type: outer[i].name,
          parents: stack.map((frame) => frame.name).filter(Boolean),
        });
      open(outer[i].tag, false, outer[i].name);
    }
    if (unknown) {
      afterUnknown = true;
      if (stack.at(-1)?.tag.type.spec.inlineContent) {
        // Stored inside a text container (a table cell): drawn inline.
        newer = partial = true;
        unknownInline(value);
      } else leaf(PagesUnknownBlock.of(unknownValue(value)));
    } else if (type === "horizontal-rule") leaf(HorizontalRule);
    else if (dataframe) leaf(PagesDataframe.of(dataframe));
    else if (view) leaf(PagesView.of(view));
    else open(desc.tag, true, type);
  }
  // Empty text, which a merge can leave too: one empty unmarked paragraph.
  if (!blocks.length && !stack.length) {
    unmarked.push({ at: am, markers: [{ type: "paragraph", parents: [] }] });
    open(Paragraph);
  }
  while (stack.length) close();
  boundary();
  return {
    doc: schema.doc(blocks),
    map: { wgToAm, amToWg },
    lossy: partial || adjusted,
    newer,
    adjusted,
    moved: newer ? [] : moved,
    unmarked,
    rebuilt,
  };
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
  // Every node writes its opening marker, so every node has one to name it.
  const block = (node, parents, listType = null) => {
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
    if (node.type === PagesView) {
      marker(VIEW_BLOCK, parents, node.param);
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
      for (const child of node.content) block(child, parents, itemType);
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
    marker(type, parents, attrs);
    if (node.inlineContent)
      for (const child of node.content) inline(child, [...parents, type], type === "code-block");
    else for (const child of node.content) block(child, [...parents, type]);
  };
  for (const node of doc.content) block(node, []);
  return spans;
}
