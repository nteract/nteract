import * as A from "@automerge/automerge/slim";
import { diffArrays } from "diff";
import { amSpliceIdxToPmIdx, pmRangeToAmRange } from "@automerge/prosemirror/dist/traversal.js";
import { adapter, isRich, richDoc, textPath } from "./richtext.mjs";
import {
  encodeMarkValue,
  isKnownMark,
  markExpand,
  markSpec,
  normalizeHighlight,
} from "./marks.mjs";
import { stampMarks } from "./schema-features.mjs";

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
export function textSegments(block) {
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

const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const graphemes = (text) => Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
/** Whether UTF-16 offset `at` in `text` falls between grapheme clusters. */
function graphemeBoundary(text, at) {
  if (at <= 0 || at >= text.length) return true;
  return graphemeSegmenter.segment(text).containing(at).index === at;
}

/** Resolve one visible range without changing the document. Context is searched
 * between occurrences and cannot cross a paragraph or embedded-node boundary.
 * The match must start and end between grapheme clusters: a match that cuts
 * an accented letter, an emoji sequence or a flag would otherwise leave the
 * rest of that character behind, and a comment anchored on it attached to it.
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
      matches.push({ at: segment.offset + at, segment, local: at });
    }
  }
  if (matches.length !== 1)
    throw Error(
      `${input.op ?? "replace_match"} found ${matches.length} matches; exactly one is required. Use context_before/context_after or a longer match_text.`,
    );
  const [{ at: start, segment, local }] = matches;
  const op = input.op ?? "replace_match";
  if (!graphemeBoundary(segment.text, local))
    throw Error(`${op} match_text starts inside a character; include the whole character`);
  if (!graphemeBoundary(segment.text, local + match.length))
    throw Error(`${op} match_text ends inside a character; include the whole character`);
  return { path: textPath(id), start, end: start + match.length };
}

// Diff tokens are built from grapheme clusters, so a combining accent, a ZWJ
// emoji sequence or a flag pair is never split: a run of word clusters
// (letters, digits, marks, underscore), a run of whitespace, or one other
// cluster.
const WORD = /^[\p{L}\p{N}\p{M}_]/u;
const SPACE = /^\s/u;
function tokenize(text) {
  const tokens = [];
  let kind;
  for (const cluster of graphemes(text)) {
    const next = WORD.test(cluster) ? "word" : SPACE.test(cluster) ? "space" : "other";
    if (next !== "other" && next === kind) tokens[tokens.length - 1] += cluster;
    else tokens.push(cluster);
    kind = next;
  }
  return tokens;
}

// Myers is O((N + M) D). Past this many token edits, one diff is refused and
// the texts are split at tokens unique to both; a chunk with no such token
// that is still over budget refuses the whole edit rather than fall back to a
// coarse splice that would detach anchors on words it kept.
const MAX_TOKEN_EDITS = 2000;
const tooLarge = () =>
  Object.assign(
    Error(
      "replace_match changes too much text at once to keep comment anchors on the words it leaves alone. Split it into smaller replace_match operations, or use replace_block_markdown if the block has no comments to keep.",
    ),
    { status: 400, code: "replace_match_too_large" },
  );

/** The longest run of `pairs` ([i, j], ascending in i) whose j also ascends. */
function increasing(pairs) {
  const tails = [],
    links = [];
  for (let n = 0; n < pairs.length; n++) {
    let low = 0,
      high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (pairs[tails[mid]][1] < pairs[n][1]) low = mid + 1;
      else high = mid;
    }
    links[n] = low ? tails[low - 1] : -1;
    tails[low] = n;
  }
  const result = [];
  for (let n = tails.at(-1) ?? -1; n >= 0; n = links[n]) result.unshift(pairs[n]);
  return result;
}

/** jsdiff change parts for `before` → `after`, each within the edit budget.
 * Over budget, the sequences are split at tokens that occur exactly once in
 * both (in a common order) and each piece is diffed on its own. */
function diffTokens(before, after) {
  const direct = diffArrays(before, after, { maxEditLength: MAX_TOKEN_EDITS });
  if (direct) return direct;
  const count = (tokens) => {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
  };
  const inBefore = count(before),
    inAfter = count(after);
  const afterIndex = new Map(after.map((token, index) => [token, index]));
  const pairs = [];
  before.forEach((token, index) => {
    if (inBefore.get(token) === 1 && inAfter.get(token) === 1)
      pairs.push([index, afterIndex.get(token)]);
  });
  const anchors = increasing(pairs);
  if (!anchors.length) throw tooLarge();
  const parts = [];
  let from = 0,
    to = 0;
  for (const [i, j] of [...anchors, [before.length, after.length]]) {
    if (i > from || j > to) parts.push(...diffTokens(before.slice(from, i), after.slice(to, j)));
    if (i < before.length) parts.push({ value: [before[i]] });
    from = i + 1;
    to = j + 1;
  }
  return parts;
}

/** How to turn `before` into `after`: `splices`, each `{ at, remove, insert }`
 * with `at` an offset into `before`, in ascending order, and `changed`, the
 * span of `after` holding every word that differs (null when nothing does).
 *
 * Words and whitespace the two texts share stay in place, so a comment anchor
 * on an unchanged word keeps its characters. A changed run is narrowed by its
 * common prefix and suffix, in whole grapheme clusters, so fixing a typo
 * inside a word keeps the rest of that word. A word that changes beyond that
 * is replaced whole: an anchor ending in it detaches, and one starting in it
 * shrinks to the words that remain. A character-level LCS (what
 * `A.updateText` runs) would instead keep stray letters, leaving an anchor on
 * "table" attached to the "e" of "desk".
 */
export function textSplices(before, after) {
  if (before === after) return { splices: [], changed: null };
  const splices = [];
  let at = 0,
    atAfter = 0,
    removed = "",
    added = "",
    changed = null;
  const flush = () => {
    if (removed || added) {
      const gone = graphemes(removed),
        came = graphemes(added);
      let prefix = 0;
      while (prefix < gone.length && prefix < came.length && gone[prefix] === came[prefix])
        prefix++;
      let suffix = 0;
      while (
        suffix < gone.length - prefix &&
        suffix < came.length - prefix &&
        gone[gone.length - 1 - suffix] === came[came.length - 1 - suffix]
      )
        suffix++;
      const prefixLength = gone.slice(0, prefix).join("").length;
      const suffixLength = suffix ? gone.slice(-suffix).join("").length : 0;
      const remove = removed.length - prefixLength - suffixLength;
      const insert = added.slice(prefixLength, added.length - suffixLength);
      if (remove || insert) splices.push({ at: at + prefixLength, remove, insert });
      changed = { start: changed?.start ?? atAfter, end: atAfter + added.length };
      at += removed.length;
      atAfter += added.length;
      removed = "";
      added = "";
    }
  };
  for (const part of diffTokens(tokenize(before), tokenize(after))) {
    const text = part.value.join("");
    if (part.removed) removed += text;
    else if (part.added) added += text;
    else {
      flush();
      at += text.length;
      atAfter += text.length;
    }
  }
  flush();
  return { splices, changed };
}

/** Replace one visible text range, preserving every untouched CRDT character:
 * only the words that differ between the match and the replacement are
 * spliced, so comment anchors on the rest of the match survive. */
export function replaceMatch(doc, id, input, trace) {
  const replacement = replacementLiteral(input.replacement, "replacement");
  const { path, start, end } = findUniqueVisibleRange(doc, id, input);
  const commonMarks = A.marks(doc, path).filter((mark) => mark.start <= start && mark.end >= end);
  const { splices, changed } = textSplices(doc.blocks[id].richText.slice(start, end), replacement);
  const inserted = [];
  let shift = 0;
  for (const splice of splices) {
    const at = start + splice.at + shift;
    A.splice(doc, path, at, splice.remove, splice.insert);
    if (splice.insert.length) inserted.push({ start: at, end: at + splice.insert.length });
    shift += splice.insert.length - splice.remove;
  }
  for (const range of inserted) {
    const actual = A.marks(doc, path).filter(
      (mark) => mark.start < range.end && mark.end > range.start,
    );
    // A splice inherits marks at its insertion boundary. That can drop a
    // non-expanding link or spread a partial bold run across the insertion.
    // Reconcile only inserted characters against marks shared by the full
    // match; untouched characters keep their own marks.
    for (const mark of actual)
      if (!commonMarks.some((common) => common.name === mark.name && common.value === mark.value))
        A.unmark(doc, path, { ...range, expand: "none" }, mark.name);
    for (const mark of commonMarks)
      if (
        !actual.some(
          (current) =>
            current.name === mark.name &&
            current.value === mark.value &&
            current.start <= range.start &&
            current.end >= range.end,
        )
      )
        A.mark(doc, path, { ...range, expand: markExpand(mark.name) }, mark.name, mark.value);
  }
  // Inserted text carries the marks shared by the whole match.
  if (inserted.length)
    stampMarks(
      doc,
      commonMarks.map((mark) => mark.name),
    );
  // The caret covers the words that changed; a replacement that changed
  // nothing shows the match it addressed.
  trace?.push({
    type: "text",
    block_id: id,
    ...(changed ? { start: start + changed.start, end: start + changed.end } : { start, end }),
  });
  return { op: "replace_match", block_id: id, matched: 1 };
}

/** Normalize format_match `add` input into stored Automerge mark values. */
export function formatMarks(add) {
  if (add === undefined) return {};
  if (!add || typeof add !== "object" || Array.isArray(add))
    throw Error("add must map mark names to values");
  return Object.fromEntries(
    Object.entries(add).map(([name, value]) => {
      if (!isKnownMark(name)) throw Error(`Unsupported rich mark: ${name}`);
      const rule = markSpec(name).value;
      if (rule.type === "flag" && value !== true) throw Error(`${name} takes the value true`);
      if (name === "highlight") return [name, normalizeHighlight(value)];
      return [name, encodeMarkValue(name, value)];
    }),
  );
}

/** Add or remove marks over one visible text range. Text and CRDT identity
 * are unchanged; a mark added over an existing one with a different value
 * replaces that value in the range. */
export function formatMatch(doc, id, input, trace) {
  const add = formatMarks(input.add);
  const remove = input.remove ?? [];
  if (!Array.isArray(remove) || remove.some((name) => typeof name !== "string"))
    throw Error("remove must be a list of mark names");
  for (const name of remove) if (!isKnownMark(name)) throw Error(`Unsupported rich mark: ${name}`);
  if (!Object.keys(add).length && !remove.length)
    throw Error("format_match requires add or remove");
  if (remove.some((name) => Object.hasOwn(add, name)))
    throw Error("A mark cannot be both added and removed");
  const { path, start, end } = findUniqueVisibleRange(doc, id, { ...input, op: "format_match" });
  if (inCodeBlock(doc, path, start))
    throw Error("format_match can't format text inside a code block; code text is unformatted.");
  for (const name of remove) A.unmark(doc, path, { start, end, expand: "both" }, name);
  for (const [name, value] of Object.entries(add))
    A.mark(doc, path, { start, end, expand: markExpand(name) }, name, value);
  stampMarks(doc, Object.keys(add));
  trace?.push({ type: "text", block_id: id, start, end });
  return { op: "format_match", block_id: id, matched: 1 };
}

// Whether native position `at` sits in a code block: the nearest block marker
// before it is a code-block marker.
function inCodeBlock(doc, path, at) {
  let pos = 0,
    code = false;
  for (const span of A.spans(doc, path)) {
    if (pos > at) break;
    if (span.type === "block") {
      code = String(span.value?.type) === "code-block";
      pos += 1;
    } else pos += span.value.length;
  }
  return code;
}
