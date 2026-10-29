import * as A from "@automerge/automerge/slim";
import { amSpliceIdxToPmIdx, pmRangeToAmRange } from "@automerge/prosemirror/dist/traversal.js";
import { adapter, isRich, richDoc, textPath } from "./richtext.mjs";

const MAX_TEXT_LENGTH = 262144;
const MAX_MATCHES = 10000;

export function replacementLiteral(value, name, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH)
    throw Error(`${name} must be a string of at most ${MAX_TEXT_LENGTH} UTF-16 units`);
  if (
    [...value].some((char) => {
      const point = char.codePointAt(0);
      return point >= 0xd800 && point <= 0xdfff;
    })
  )
    throw Error(`${name} must not contain an unpaired surrogate`);
  return value;
}

/** The optional node index uses the same revision-bound, top-level address as
 * read_page outlines. Containers remain intact; a match still cannot cross a
 * native paragraph/embed marker inside a list or table.
 */
export function visibleNodeRange(doc, id, nodeIndex) {
  if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 0)
    throw Error("node_index must be a nonnegative integer from the read outline");
  const block = doc.blocks[id];
  if (!isRich(block)) throw Error("replace_match requires a rich-text block");
  const tree = richDoc(block);
  if (nodeIndex >= tree.childCount) throw Error("node_index is outside this block");
  let from = 0;
  for (let i = 0; i < nodeIndex; i++) from += tree.child(i).nodeSize;
  return pmRangeToAmRange(adapter, A.spans(doc, textPath(id)), {
    from,
    to: from + tree.child(nodeIndex).nodeSize,
  });
}

export function visibleRangeAddress(doc, id, start, end) {
  const spans = A.spans(doc, textPath(id));
  const tree = richDoc(doc.blocks[id]);
  const from = tree.resolve(amSpliceIdxToPmIdx(adapter, spans, start));
  const last = end - (/^[\udc00-\udfff]$/.test(doc.blocks[id].richText[end - 1]) ? 2 : 1);
  const to = tree.resolve(amSpliceIdxToPmIdx(adapter, spans, last));
  const nodeIndex = from.index(0);
  if (nodeIndex !== to.index(0)) throw Error("Match crosses top-level nodes");
  const ancestry = (position) =>
    Array.from({ length: position.depth }, (_, index) => {
      const node = position.node(index + 1);
      return { type: node.type.name, attrs: node.attrs };
    });
  return {
    node_index: nodeIndex,
    ...visibleNodeRange(doc, id, nodeIndex),
    ancestry: [ancestry(from), ancestry(to)],
  };
}

// Mark boundaries do not interrupt visible text, but rich block/embed markers
// do. Never expose their object-replacement characters to a literal text edit.
function textSegments(block) {
  if (!isRich(block)) throw Error("replace_match requires a rich-text block");
  if (block.richText.length > MAX_TEXT_LENGTH) throw Error("Block is too large for replace_match");
  const segments = [];
  let offset = 0;
  let segment;
  for (const span of A.spans(block, ["richText"])) {
    if (span.type === "block") {
      segment = undefined;
      offset++;
    } else {
      if (!segment) {
        segment = { offset, text: "" };
        segments.push(segment);
      }
      segment.text += span.value;
      offset += span.value.length;
    }
  }
  return segments;
}

/** Resolve one visible range without changing the document. Context is searched
 * between occurrences and cannot cross a paragraph or embedded-node boundary.
 */
export function findUniqueVisibleRange(doc, id, input) {
  const match = replacementLiteral(input.match_text, "match_text");
  const before = replacementLiteral(input.context_before, "context_before", true);
  const after = replacementLiteral(input.context_after, "context_after", true);
  const scope = input.node_index === undefined ? null : visibleNodeRange(doc, id, input.node_index);
  if (!match) throw Error("match_text must not be empty");
  const matches = [];
  let candidates = 0;
  for (const segment of textSegments(doc.blocks[id])) {
    const offsets = [];
    for (let at = segment.text.indexOf(match); at >= 0; at = segment.text.indexOf(match, at + 1)) {
      if (++candidates > MAX_MATCHES) throw Error("Too many matches; use a longer match_text");
      offsets.push(at);
    }
    for (let i = 0; i < offsets.length; i++) {
      const at = offsets[i];
      if (
        scope &&
        (segment.offset + at < scope.start || segment.offset + at + match.length > scope.end)
      )
        continue;
      const gapStart = i ? offsets[i - 1] + match.length : 0;
      const gapEnd = offsets[i + 1] ?? segment.text.length;
      if (before !== undefined && !segment.text.slice(gapStart, at).includes(before)) continue;
      if (after !== undefined && !segment.text.slice(at + match.length, gapEnd).includes(after))
        continue;
      matches.push(segment.offset + at);
    }
  }
  if (matches.length !== 1)
    throw Error(
      `replace_match found ${matches.length} matches; exactly one is required. Use context_before/context_after or a longer match_text.`,
    );
  const path = textPath(id);
  const start = matches[0];
  const end = start + match.length;
  return { path, start, end };
}

/** Replace one visible text range, preserving every untouched CRDT character. */
export function replaceMatch(doc, id, input) {
  const replacement = replacementLiteral(input.replacement, "replacement");
  const { path, start, end } = findUniqueVisibleRange(doc, id, input);
  const commonMarks = A.marks(doc, path).filter((mark) => mark.start <= start && mark.end >= end);
  A.splice(doc, path, start, end - start, replacement);
  if (replacement.length) {
    const range = { start, end: start + replacement.length };
    const actual = A.marks(doc, path).filter((mark) => mark.start < range.end && mark.end > start);
    // A splice inherits marks at its insertion boundary. That can drop a
    // non-expanding link or spread a partial bold run across the replacement.
    // Reconcile only inserted characters against marks shared by the full match.
    for (const mark of actual)
      if (!commonMarks.some((common) => common.name === mark.name && common.value === mark.value))
        A.unmark(doc, path, { ...range, expand: "none" }, mark.name);
    for (const mark of commonMarks)
      if (
        !actual.some(
          (current) =>
            current.name === mark.name &&
            current.value === mark.value &&
            current.start <= start &&
            current.end >= range.end,
        )
      )
        A.mark(
          doc,
          path,
          { ...range, expand: adapter.expandConfig(mark.name) },
          mark.name,
          mark.value,
        );
  }
  return { op: "replace_match", block_id: id, matched: 1 };
}
