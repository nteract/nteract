// A read-only rendering of a Page the viewer can show before its WASM
// runtimes load and its first sync finishes. The host projects Wordgard's
// native read tree into the preview's stable tags and attributes. Each element is
// [tag, attributes, ...children] and each text run is a string. The viewer
// (viewer/PagePreview.jsx) builds elements from an allowlist; nothing here is
// HTML.
import { readChildren, readKind } from "./native-read.mjs";
import { surfaceRead } from "./page-surface-read.mjs";
import { orderedBlockIds } from "./order.mjs";
import { MARK_REGISTRY, safeUrl } from "./marks.mjs";
import { unknownNodeNotice } from "./richtext-notices.mjs";
import { Leaf, Mark } from "wordgard/doc";
import {
  Code,
  Emphasis,
  PagesForeignMarks,
  PagesHighlight,
  PagesLink,
  Strikethrough,
  Strong,
} from "./wordgard-doc.mjs";

/** The most UTF-8 bytes the serialized preview may take. */
export const PREVIEW_MAX_BYTES = 256 * 1024;

const MARKS = new Map([
  [PagesLink, "link"],
  [Emphasis.type, "em"],
  [Strong.type, "strong"],
  [Strikethrough.type, "strike"],
  [PagesHighlight, "highlight"],
  [Code.type, "code"],
  [PagesForeignMarks, "foreign"],
]);
const MARK_RANK = new Map(
  [...MARK_REGISTRY.marks.map(({ name }) => name), "foreign"].map((name, index) => [name, index]),
);
const TAGS = {
  paragraph: "p",
  blockquote: "blockquote",
  aside: "aside",
  "bullet-list": "ul",
  "table-row": "tr",
  "horizontal-rule": "hr",
  "hard-break": "br",
};

/**
 * One Wordgard read node as preview JSON. `overrides.node(node,
 * children, attrs)` may return a replacement array, where `children()`
 * renders its content with the same overrides; `overrides.mark(mark,
 * content)` may return a replacement for a mark's wrapper. Returning
 * undefined keeps the preview rendering. Cards (page-card.mjs) use them.
 * Metadata is the native reader's private map of stored scalar attributes.
 */
export function renderNode(node, overrides, metadata) {
  if (node.isText) {
    let content = [node.param];
    const marks = [...node.marks].sort(
      (a, b) => MARK_RANK.get(MARKS.get(b.type)) - MARK_RANK.get(MARKS.get(a.type)),
    );
    for (const mark of marks) {
      const replaced = overrides?.mark?.(mark, content);
      if (replaced) {
        content = replaced;
        continue;
      }
      const name = MARKS.get(mark.type);
      if (name === "link") {
        const { href, title } = mark.value;
        content = safeUrl(href)
          ? [["a", { href, ...(title != null && { title }) }, ...content]]
          : [["span", {}, ...content]];
      } else if (name === "highlight")
        content = [["mark", { "data-highlight": mark.value }, ...content]];
      else if (name === "foreign") content = [["span", { "data-unknown-mark": true }, ...content]];
      else if (name) content = [[name === "strike" ? "s" : name, {}, ...content]];
    }
    return content;
  }
  const children = () => {
    const out = [];
    const nodes = readChildren(node);
    for (let i = 0; i < nodes.length; i++) {
      let child = nodes[i];
      if (child.isText) {
        let text = child.param;
        while (nodes[i + 1]?.isText && Mark.sameSet(child.marks, nodes[i + 1].marks))
          text += nodes[++i].param;
        if (text !== child.param) child = Leaf.text(text, child.marks);
      }
      out.push(...renderNode(child, overrides, metadata));
    }
    return out;
  };
  const attrs = metadata?.get(node) ?? {};
  const replaced = overrides?.node?.(node, children, attrs);
  if (replaced) return replaced;
  const kind = readKind(node);
  if (TAGS[kind]) return [[TAGS[kind], {}, ...children()]];
  switch (kind) {
    case "heading":
      return [[`h${node.tag.param}`, {}, ...children()]];
    case "code-block":
      return [["pre", {}, ["code", {}, ...children()]]];
    case "ordered-list":
      return [["ol", node.tag.param === 1 ? {} : { start: node.tag.param }, ...children()]];
    case "task-list":
      return [["ul", { "data-task-list": "true" }, ...children()]];
    case "list-item": {
      const { checked } = attrs;
      return typeof checked === "boolean"
        ? [
            [
              "li",
              { "data-task-checked": String(checked) },
              [
                "input",
                {
                  type: "checkbox",
                  ...(checked && { checked: "" }),
                  disabled: "",
                  contenteditable: "false",
                  "aria-label": "Task completed",
                },
              ],
              ["div", {}, ...children()],
            ],
          ]
        : [["li", {}, ...children()]];
    }
    case "table":
      return [["table", {}, ["tbody", {}, ...children()]]];
    case "table-cell":
    case "table-header":
      return [
        [
          kind === "table-cell" ? "td" : "th",
          attrs.align == null ? {} : { "data-align": attrs.align },
          ...children(),
        ],
      ];
    case "image": {
      const { src, alt, title, dark_src } = node.param;
      if (!safeUrl(src)) return [["span", {}, "Image omitted"]];
      return [
        [
          "img",
          {
            src,
            alt: alt ?? "",
            ...(title != null && { title }),
            ...(dark_src != null && safeUrl(dark_src) && { dark_src }),
          },
        ],
      ];
    }
    case "dataframe": {
      const { media_type, title } = node.param;
      // Scalar titles are not DOM specs. Zero means no caption; unsupported
      // title shapes fail closed rather than constructing elements.
      if (title != null && typeof title !== "string" && title !== 0)
        throw Error("Unreadable dataframe title");
      return [
        [
          "figure",
          media_type == null ? {} : { "data-dataframe": media_type },
          ...(title === 0 ? [] : [title ?? "Dataframe"]),
        ],
      ];
    }
    // A figure naming the view, as the editor draws a view it has no chart
    // for. The chart reads the view's own document.
    case "view": {
      const { view_id } = node.param;
      if (typeof view_id !== "string") throw Error("Unreadable view id");
      return [["figure", { "data-view": view_id }, view_id]];
    }
    case "unknown":
      return [["div", { "data-unknown-block": "true" }, ...children()]];
    case "unknown-inline":
      return [unknownNodeNotice(node.param.type)];
    default:
      return children();
  }
}

/** One block's preview content, or null when it can't be rendered. */
export function blockPreview(block) {
  try {
    const { nodes, metadata } = surfaceRead(block);
    const out = [];
    for (const child of nodes) out.push(...renderNode(child, undefined, metadata));
    return out;
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();
/** UTF-8 bytes of a string, as a response body carries it. */
const utf8 = (text) => encoder.encode(text).length;
/** The serialized preview. Its fields and their order are the response shape. */
const serialize = (title, blocks, truncated) => JSON.stringify({ title, blocks, truncated });

/** The longest prefix of `title`, by code point, whose envelope fits `budget`. */
function fittingTitle(title, budget) {
  const points = Array.from(title);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8(serialize(points.slice(0, mid).join(""), [], true)) <= budget) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join("");
}

/**
 * The Page's title and as many blocks as fit, in order. The UTF-8 length of
 * JSON.stringify(result) is at most `maxBytes`, counting the title, block ids
 * and JSON punctuation. Blocks stop at the first one that doesn't fit or can't
 * be rendered; a title too long for the budget is cut at a code point.
 * `truncated` says whether anything was left out.
 */
export function pagePreview(doc, { maxBytes = PREVIEW_MAX_BYTES } = {}) {
  let title = String(doc.title ?? "");
  // The envelope with `truncated: false`, the longer of the two literals.
  const floor = utf8(serialize("", [], false));
  if (maxBytes < floor) throw new RangeError(`A preview needs at least ${floor} bytes`);
  let titleCut = false;
  if (utf8(serialize(title, [], false)) > maxBytes) {
    title = fittingTitle(title, maxBytes);
    titleCut = true;
  }
  const blocks = [];
  let bytes = utf8(serialize(title, [], false));
  let truncated = titleCut;
  for (const id of orderedBlockIds(doc)) {
    const content = blockPreview(doc.blocks[id]);
    if (!content) {
      truncated = true;
      break;
    }
    // One array element, plus the comma before it after the first.
    const size = utf8(JSON.stringify({ id, content })) + (blocks.length ? 1 : 0);
    if (bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    blocks.push({ id, content });
  }
  return { title, blocks, truncated };
}
