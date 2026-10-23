import * as A from "@automerge/automerge/slim";
import { adapter, isRich, textPath } from "./richtext.mjs";

const MAX_TEXT_LENGTH = 262144;
const MAX_MATCHES = 10000;

function literal(value, name, optional = false) {
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

/** Replace one visible text range, preserving every untouched CRDT character.
 * Context is searched in the gaps between occurrences, as in notebook tools,
 * and cannot cross a paragraph, code block, or embedded-node boundary.
 */
export function replaceMatch(doc, id, input) {
  const match = literal(input.match_text, "match_text");
  const replacement = literal(input.replacement, "replacement");
  const before = literal(input.context_before, "context_before", true);
  const after = literal(input.context_after, "context_after", true);
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
  const commonMarks = A.marks(doc, path).filter((mark) => mark.start <= start && mark.end >= end);
  A.splice(doc, path, start, match.length, replacement);
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
