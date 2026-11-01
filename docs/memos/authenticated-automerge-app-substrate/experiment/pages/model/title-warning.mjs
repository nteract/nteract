import { orderedBlockIds } from "./order.mjs";
import { isRich, parseMarkdown, richDoc } from "./richtext.mjs";

const MAX_HEADING = 1024;
const MAX_COMPARE = 8192;
const negations = new Set(["no", "not", "never", "without", "non", "versus", "vs"]);
const word = /^[\p{L}\p{M}]+$/u;

// Keep accents, apostrophes inside words, numeric separators and meaningful
// symbols. This is typography normalization, not semantic similarity.
function normalized(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/gu, "'")
    .replace(/\p{Pd}/gu, (_dash, at, source) =>
      /\p{N}/u.test(source[at - 1] ?? "") || /\p{N}/u.test(source[at + 1] ?? "") ? "-" : " ",
    )
    .replace(/[,:;]/gu, (mark, at, source) =>
      /\p{N}/u.test(source[at - 1] ?? "") && /\p{N}/u.test(source[at + 1] ?? "") ? mark : " ",
    )
    .replace(/[!？?！()[\]{}"“”„«»_]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^'+|[.']+$/gu, "")
    .trim();
}

function matchKind(title, heading) {
  const a = normalized(title),
    b = normalized(heading);
  if (!/[\p{L}\p{N}]/u.test(a)) return null;
  if (a === b) return "normalized_exact";
  const aWords = a.split(" "),
    bWords = b.split(" "),
    [shorter, longer] = aWords.length < bWords.length ? [aWords, bWords] : [bWords, aWords];
  if (
    Math.min(a.length, b.length) < 24 ||
    shorter.length < 6 ||
    longer.length !== shorter.length + 1 ||
    new Set(shorter).size < 4 ||
    !longer.every((token) => word.test(token))
  )
    return null;
  let insertion = 0;
  while (insertion < shorter.length && shorter[insertion] === longer[insertion]) insertion++;
  if (insertion === 0 || insertion === shorter.length || negations.has(longer[insertion]))
    return null;
  return shorter.slice(insertion).every((token, index) => token === longer[insertion + index + 1])
    ? "near_match"
    : null;
}

// Only an empty text paragraph/heading is skippable. Images, opaque source,
// rules and even empty containers occupy the opening position in the document.
function plainText(node) {
  let text = "",
    plain = true;
  node.forEach((child) => {
    if (child.isText) text += child.text;
    else if (child.type.name === "hard_break") text += "\n";
    else plain = false;
  });
  return plain ? text : null;
}

/** Best-effort authoring feedback from the captured, post-edit document. Never
 * changes content or promotes Markdown import provenance over native rich text.
 * Callers persist the returned plain JSON with the successful operation receipt.
 */
export function openingTitleWarning(doc) {
  if (typeof doc?.title !== "string" || !doc.title.trim() || doc.title.length > MAX_COMPARE)
    return null;
  try {
    for (const blockId of orderedBlockIds(doc)) {
      if (blockId.length > 128) return null;
      const block = doc.blocks[blockId];
      if (!block || (block.kind !== undefined && block.kind !== "markdown")) return null;
      if (block.format !== undefined && !isRich(block)) return null;
      const tree = isRich(block)
        ? richDoc(block)
        : typeof block.markdown === "string"
          ? parseMarkdown(block.markdown)
          : null;
      if (!tree) return null;
      for (let index = 0; index < tree.childCount; index++) {
        const node = tree.child(index);
        if (!["paragraph", "heading"].includes(node.type.name)) return null;
        const heading = plainText(node);
        if (heading === null) return null;
        if (!heading.trim()) continue;
        if (node.type.name !== "heading" || heading.length > MAX_COMPARE) return null;
        const kind = matchKind(doc.title, heading);
        if (!kind) return null;
        const truncated = heading.length > MAX_HEADING;
        const end =
          truncated && /[\ud800-\udbff]/u.test(heading[MAX_HEADING - 1])
            ? MAX_HEADING - 1
            : MAX_HEADING;
        return {
          code: "opening_heading_repeats_title",
          block_id: blockId,
          heading: heading.slice(0, end),
          match_kind: kind,
          suggested_action:
            "The Page already displays its title above the body. Consider removing or rewording this opening heading if the repetition is unintended; the content was preserved.",
          ...(truncated && { heading_truncated: true }),
        };
      }
    }
  } catch {
    // An advisory warning must not reject an otherwise accepted operation when
    // unfamiliar or malformed content cannot be projected safely.
  }
  return null;
}
