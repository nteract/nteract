// A read-only rendering of a Page the viewer can show before its WASM
// runtimes load and its first sync finishes. The host builds it from the
// rich-text schema's own toDOM specs, so the preview has the same tags and
// attributes the codec renders. It is plain JSON: each element is
// [tag, attributes, ...children] and each text run is a string. The viewer
// (viewer/PagePreview.jsx) builds elements from an allowlist; nothing here is
// HTML.
import { isRich, richDoc } from "./richtext.mjs";
import { orderedBlockIds } from "./order.mjs";

/** The most UTF-8 bytes the serialized preview may take. */
export const PREVIEW_MAX_BYTES = 256 * 1024;

/** A DOMOutputSpec with its content hole filled, as [tag, attrs, ...children]. */
function fill(spec, children) {
  if (typeof spec === "string") return spec;
  const [tag, ...rest] = spec;
  const attrs =
    rest.length && rest[0] && typeof rest[0] === "object" && !Array.isArray(rest[0])
      ? rest.shift()
      : {};
  const kept = Object.fromEntries(
    Object.entries(attrs).filter(([, value]) => value !== null && value !== undefined),
  );
  const out = [tag, kept];
  for (const part of rest) {
    if (part === 0) out.push(...children);
    else out.push(fill(part, children));
  }
  return out;
}

function renderNode(node) {
  if (node.isText) {
    // Marks apply outermost first, the order ProseMirror's serializer uses.
    let content = [node.text];
    for (const mark of [...node.marks].reverse()) {
      const toDOM = mark.type.spec.toDOM;
      content = toDOM ? [fill(toDOM(mark, true), content)] : content;
    }
    return content;
  }
  const children = [];
  node.forEach((child) => children.push(...renderNode(child)));
  const toDOM = node.type.spec.toDOM;
  // Unknown or unrenderable nodes keep their text.
  return toDOM ? [fill(toDOM(node), children)] : children;
}

/** One block's preview content, or null when it can't be rendered. */
export function blockPreview(block) {
  try {
    if (!isRich(block)) return [["pre", {}, String(block.markdown ?? "")]];
    const doc = richDoc(block);
    const out = [];
    doc.forEach((child) => out.push(...renderNode(child)));
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
