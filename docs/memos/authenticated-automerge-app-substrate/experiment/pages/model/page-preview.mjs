// A read-only rendering of a Page the viewer can show before its WASM
// runtimes load and its first sync finishes. The host builds it from the
// rich-text schema's own toDOM specs, so the preview has the same tags and
// attributes the codec renders. It is plain JSON: each element is
// [tag, attributes, ...children] and each text run is a string. The viewer
// (viewer/PagePreview.jsx) builds elements from an allowlist; nothing here is
// HTML.
import { isRich, richDoc } from "./richtext.mjs";
import { orderedBlockIds } from "./order.mjs";

/** The preview stops adding blocks once its JSON passes this size. */
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

/** The Page's title and as many blocks as fit in `maxBytes` of JSON, in order. */
export function pagePreview(doc, { maxBytes = PREVIEW_MAX_BYTES } = {}) {
  const blocks = [];
  let bytes = 0;
  let truncated = false;
  for (const id of orderedBlockIds(doc)) {
    const content = blockPreview(doc.blocks[id]);
    if (!content) {
      truncated = true;
      break;
    }
    const size = JSON.stringify(content).length;
    if (bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    blocks.push({ id, content });
  }
  return { title: String(doc.title ?? ""), blocks, truncated };
}
