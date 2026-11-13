// A Page's card: the first screen of its content as a small JSON bundle the
// library grid draws in a scaled box (viewer/PageCardPreview.jsx). The Page
// host builds it from its document and stores it beside the Page's images
// (worker/page-card-writer.mjs); `page_cards` serves it to readers the
// Catalog has checked.
//
// The content is page-preview.mjs's JSON: each element [tag, attrs,
// ...children] from Wordgard read nodes, each text run a string.
// It is never HTML. A card differs from a preview in what it leaves out:
//
// - Images become a placeholder holding their alt text. No bytes, no src.
// - A dataframe becomes a placeholder holding its title, a view one naming
//   its view id.
// - Links keep their text and lose their href: the card is one link already.
// - Code blocks name their language (`data-language`), so Mermaid stays code
//   and reads as Mermaid.
// - Task checkboxes keep only whether they are checked.
//
// `card_hash` hashes CARD_BUILDER_VERSION and exactly the title, blocks and
// `truncated` flag the card holds, so an edit below the fold leaves it
// unchanged and the host skips the write, while a build that renders cards
// differently rewrites each one on its Page's next flush.
//
// `rich` says the first screen holds Mermaid, a dataframe, a view or an image, which
// the JSON card can only stand in for. Nothing reads it yet.
import { surfaceRead } from "./page-surface-read.mjs";
import { readKind } from "./native-read.mjs";
import { PagesLink } from "./wordgard-doc.mjs";
import { orderedBlockIds } from "./order.mjs";
import { renderNode } from "./page-preview.mjs";

export const CARD_VERSION = 1;
/**
 * The builder's own version, hashed into `card_hash`. Bump it whenever this
 * module renders the same document differently (an override, a placeholder,
 * the budget), so each Page's next flush rewrites its stored card. Bump it
 * too when the card shell (viewer/card-shell.mjs) draws the same card
 * differently: the owner's tab redraws an image only for a new hash. It
 * isn't the bundle's `v`: readers don't need to know it.
 */
export const CARD_BUILDER_VERSION = 2;
/** The most UTF-8 bytes the serialized `blocks` array may take. */
export const CARD_BLOCKS_MAX_BYTES = 8 * 1024;
/** The longest title a card keeps, in code points. */
export const CARD_TITLE_MAX = 300;
/** The most top-level nodes a card keeps. A card shows about a dozen lines;
 * this bounds the work for a Page that opens with many empty paragraphs. */
export const CARD_MAX_NODES = 64;
/** A clipped node is kept only when this much room is left for it. */
const CLIP_MIN_BYTES = 48;
/** Where a Page's card lives in the Page assets bucket. */
export const cardKey = (pageId) => `pages/${pageId}/card.json`;

const encoder = new TextEncoder();
const utf8 = (text) => encoder.encode(text).length;

/** The UTF-8 size of JSON.stringify(value), or Infinity once it passes
 * `limit`. Work stays proportional to `limit`, not to the value. */
export function sizeWithin(value, limit) {
  if (limit < 0) return Infinity;
  if (typeof value === "string") {
    // Every code unit takes at least one byte, so a longer string can't fit.
    if (value.length > limit) return Infinity;
    const size = utf8(JSON.stringify(value));
    return size > limit ? Infinity : size;
  }
  if (!Array.isArray(value)) {
    const size = utf8(JSON.stringify(value) ?? "null");
    return size > limit ? Infinity : size;
  }
  let size = 2;
  for (let index = 0; index < value.length; index++) {
    size += (index ? 1 : 0) + sizeWithin(value[index], limit - size);
    if (size > limit) return Infinity;
  }
  return size;
}

/** The longest code point prefix of `text` whose JSON fits `room`, or null. */
function clipText(text, room) {
  const points = Array.from(text.slice(0, Math.max(0, room)));
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8(JSON.stringify(points.slice(0, mid).join(""))) <= room) low = mid;
    else high = mid - 1;
  }
  return low ? points.slice(0, low).join("") : null;
}

/** Elements a card keeps whole or not at all: a half table row would show
 * cells out of line with the header. */
const WHOLE = new Set(["tr"]);

/** As much of `node` as fits `room` bytes, in document order, or null. */
export function clipNode(node, room) {
  if (typeof node === "string") return clipText(node, room);
  if (!Array.isArray(node) || typeof node[0] !== "string" || WHOLE.has(node[0])) return null;
  const [tag, attrs, ...children] = node;
  const out = [tag, attrs];
  let used = utf8(JSON.stringify(out));
  if (used > room) return null;
  for (const child of children) {
    const size = sizeWithin(child, room - used - 1);
    if (used + 1 + size <= room) {
      out.push(child);
      used += 1 + size;
      continue;
    }
    const part = clipNode(child, room - used - 1);
    if (part !== null) out.push(part);
    break;
  }
  return out.length > 2 ? out : null;
}

/** A code block's language, from its params' first word, when it names one. */
export function codeLanguage(params) {
  const word = String(params ?? "")
    .trim()
    .split(/\s+/)[0];
  return /^[A-Za-z0-9_+#.-]{1,32}$/.test(word) ? word.toLowerCase() : null;
}

const cut = (value, max = 200) =>
  Array.from(String(value ?? ""))
    .slice(0, max)
    .join("");

/** How a card renders the nodes it changes (see the header). */
const CARD_OVERRIDES = Object.freeze({
  node(node, children, attrs) {
    switch (readKind(node)) {
      case "image": {
        const alt = cut(node.param.alt || node.param.title);
        return [["span", { "data-card-placeholder": "image" }, ...(alt ? [alt] : [])]];
      }
      case "dataframe":
        return [
          ["div", { "data-card-placeholder": "dataframe" }, cut(node.param.title) || "Dataframe"],
        ];
      // The view's title is in its own document; the card names the view.
      case "view":
        return [["div", { "data-card-placeholder": "view" }, cut(String(node.param.view_id))]];
      case "code-block": {
        const language = codeLanguage(attrs.params);
        return [
          ["pre", language ? { "data-language": language } : {}, ["code", {}, ...children()]],
        ];
      }
      case "list-item":
        if (typeof attrs.checked !== "boolean") return undefined;
        return [
          [
            "li",
            { "data-task-checked": String(attrs.checked) },
            ["input", attrs.checked ? { checked: "" } : {}],
            ["div", {}, ...children()],
          ],
        ];
      default:
        return undefined;
    }
  },
  mark(mark, content) {
    return mark.type === PagesLink ? [["a", {}, ...content]] : undefined;
  },
});

/** One block's top-level card nodes, lazily, or null when it can't render. */
function blockNodes(block) {
  let doc;
  try {
    doc = surfaceRead(block);
  } catch {
    return null;
  }
  return (function* () {
    for (const child of doc.nodes) yield* renderNode(child, CARD_OVERRIDES, doc.metadata);
  })();
}

/** Whether a card node shows anything: text that isn't blank, an image or
 * dataframe placeholder, a rule, or a task checkbox. A Page emptied to
 * blank paragraphs then has no blocks, and the grid keeps its icon. */
export function showsContent(node) {
  if (typeof node === "string") return node.trim().length > 0;
  if (!Array.isArray(node) || typeof node[0] !== "string") return false;
  const [tag, attrs, ...children] = node;
  if (tag === "hr" || tag === "input" || attrs?.["data-card-placeholder"]) return true;
  return children.some(showsContent);
}

/** Whether card content holds Mermaid, a dataframe, a view or an image. */
export function holdsRich(content) {
  if (!Array.isArray(content)) return false;
  if (typeof content[0] === "string" && content[1] && typeof content[1] === "object") {
    const attrs = content[1];
    if (attrs["data-card-placeholder"] || attrs["data-language"] === "mermaid") return true;
    return content.slice(2).some(holdsRich);
  }
  return content.some(holdsRich);
}

/**
 * The card's content: the title, the first blocks' top-level nodes while the
 * serialized `blocks` fit `maxBytes`, and whether anything was left out. A
 * node that doesn't fit is clipped (its leading children, its leading text)
 * when enough room is left, and the card ends there.
 */
export function cardContent(doc, { maxBytes = CARD_BLOCKS_MAX_BYTES } = {}) {
  const points = Array.from(String(doc.title ?? ""));
  const title = points.slice(0, CARD_TITLE_MAX).join("");
  let truncated = points.length > CARD_TITLE_MAX;
  const blocks = [];
  // "[]" around the blocks.
  let bytes = 2;
  let nodes = 0;
  outer: for (const id of orderedBlockIds(doc)) {
    const rendered = blockNodes(doc.blocks[id]);
    if (!rendered) {
      truncated = true;
      break;
    }
    const content = [];
    // {"id":…,"content":[]} and the comma before it after the first block.
    const shell = utf8(JSON.stringify({ id, content: [] })) + (blocks.length ? 1 : 0);
    let used = bytes + shell;
    if (used > maxBytes) {
      truncated = true;
      break;
    }
    for (const node of rendered) {
      if (!showsContent(node)) continue;
      const comma = content.length ? 1 : 0;
      if (nodes >= CARD_MAX_NODES) {
        truncated = true;
        if (content.length) blocks.push({ id, content });
        break outer;
      }
      const size = sizeWithin(node, maxBytes - used - comma);
      if (used + comma + size <= maxBytes) {
        content.push(node);
        used += comma + size;
        nodes++;
        continue;
      }
      truncated = true;
      const room = maxBytes - used - comma;
      const part = room >= CLIP_MIN_BYTES ? clipNode(node, room) : null;
      if (part !== null) content.push(part);
      if (content.length) blocks.push({ id, content });
      break outer;
    }
    if (content.length) {
      blocks.push({ id, content });
      bytes = used;
    }
  }
  return {
    title,
    blocks,
    truncated,
    rich: blocks.some((block) => holdsRich(block.content)),
  };
}

/** SHA-256 over the builder version and exactly what the card shows, as
 * lowercase hex. */
export async function cardHash(
  { title, blocks, truncated },
  { builderVersion = CARD_BUILDER_VERSION } = {},
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify([builderVersion, title, blocks, truncated])),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The `card.v1` bundle for a Page document:
 * `{ v, card_hash, content_updated_at, title, blocks, truncated, rich }`.
 * `contentUpdatedAt` is the host's content time, or null when it has none.
 */
export async function pageCard(doc, { contentUpdatedAt = null, maxBytes } = {}) {
  const content = cardContent(doc, { maxBytes });
  return {
    v: CARD_VERSION,
    card_hash: await cardHash(content),
    content_updated_at: contentUpdatedAt ?? null,
    title: content.title,
    blocks: content.blocks,
    truncated: content.truncated,
    rich: content.rich,
  };
}

/** A stored card as `page_cards` returns it, or null when it isn't one this
 * build reads. Readers never trust the stored object's extra fields. */
export function readStoredCard(value) {
  if (!value || typeof value !== "object" || value.v !== CARD_VERSION) return null;
  if (typeof value.card_hash !== "string" || !Array.isArray(value.blocks)) return null;
  return {
    v: CARD_VERSION,
    card_hash: value.card_hash,
    content_updated_at:
      typeof value.content_updated_at === "string" ? value.content_updated_at : null,
    title: typeof value.title === "string" ? value.title : "",
    blocks: value.blocks.filter(
      (block) => block && typeof block.id === "string" && Array.isArray(block.content),
    ),
    truncated: value.truncated === true,
    rich: value.rich === true,
  };
}
