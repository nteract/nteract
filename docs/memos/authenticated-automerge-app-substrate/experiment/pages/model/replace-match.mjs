import * as A from "@automerge/automerge/slim";
import { diffArrays } from "diff";
import { isRich, textPath } from "./richtext-format.mjs";
import { parseInlineMarkdown } from "./markdown-import.mjs";
import { ancestryAt, blockAddresses, nodeIndexAt } from "./node-addresses.mjs";
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
 * read_page outlines (model/node-addresses.mjs). Containers remain intact; a
 * match still cannot cross a native paragraph/embed marker inside a list or
 * table. Returns the node's text range `{ start, end }`.
 */
export function visibleNodeRange(doc, id, nodeIndex) {
  if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 0)
    throw Error("node_index must be a nonnegative integer from the read outline");
  const block = doc.blocks[id];
  if (!isRich(block)) throw Error("replace_match requires a rich-text block");
  const { nodes } = blockAddresses(A.spans(doc, textPath(id)));
  if (nodeIndex >= nodes.length) throw Error("node_index is outside this block");
  const { start, end } = nodes[nodeIndex];
  return { start, end };
}

/** The top-level node holding the visible range `[start, end)`, its text
 * range, and the containers around its first and last characters, which a
 * target-scoped edit compares across revisions. */
export function visibleRangeAddress(doc, id, start, end) {
  const addresses = blockAddresses(A.spans(doc, textPath(id)));
  const last = end - (/^[\udc00-\udfff]$/.test(doc.blocks[id].richText[end - 1]) ? 2 : 1);
  const nodeIndex = nodeIndexAt(addresses, start);
  if (nodeIndex !== nodeIndexAt(addresses, last)) throw Error("Match crosses top-level nodes");
  const { start: nodeStart, end: nodeEnd } = addresses.nodes[nodeIndex];
  return {
    node_index: nodeIndex,
    start: nodeStart,
    end: nodeEnd,
    ancestry: [ancestryAt(addresses, start), ancestryAt(addresses, last)],
  };
}

// Mark boundaries do not interrupt visible text, but rich block/embed markers
// do. Never expose their object-replacement characters to a literal text edit.
// Each segment records whether a code block holds it: the nearest block
// marker before it, as inCodeBlock decides.
export function textSegments(block) {
  if (!isRich(block)) throw Error("replace_match requires a rich-text block");
  if (block.richText.length > MAX_TEXT_LENGTH) throw Error("Block is too large for replace_match");
  const segments = [];
  let offset = 0;
  let segment;
  let code = false;
  for (const span of A.spans(block, ["richText"])) {
    if (span.type === "block") {
      code = String(span.value?.type) === "code-block";
      segment = undefined;
      offset++;
    } else {
      if (!segment) {
        segment = { offset, text: "", code };
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
// Each segment's grapheme cluster starts, found once however many matches
// it holds.
const clusterStarts = new WeakMap();
/** Whether UTF-16 offset `at` in `segment.text` falls between grapheme clusters. */
function graphemeBoundary(segment, at) {
  if (at <= 0 || at >= segment.text.length) return true;
  let starts = clusterStarts.get(segment);
  if (!starts) {
    starts = new Set(Array.from(graphemeSegmenter.segment(segment.text), (part) => part.index));
    clusterStarts.set(segment, starts);
  }
  return starts.has(at);
}

const MAX_OCCURRENCE = 10000;
/** The optional one-based `occurrence` of a passage operation, or undefined. */
export function occurrenceOf(input) {
  if (input.occurrence === undefined) return undefined;
  if (
    !Number.isSafeInteger(input.occurrence) ||
    input.occurrence < 1 ||
    input.occurrence > MAX_OCCURRENCE
  )
    throw Error(`occurrence must be an integer from 1 to ${MAX_OCCURRENCE}`);
  if (input.all !== undefined) throw Error("Use occurrence or all, not both");
  return input.occurrence;
}

/** Every visible occurrence of match_text in the block that its context and
 * node_index allow, in document order. Occurrences may overlap. Context is
 * searched between occurrences and cannot cross a paragraph or embedded-node
 * boundary. */
function visibleMatches(doc, id, input) {
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
  return matches;
}

/** One match as a range. It must start and end between grapheme clusters: a
 * match that cuts an accented letter, an emoji sequence or a flag would
 * otherwise leave the rest of that character behind, and a comment anchored on
 * it attached to it. */
function matchRange(id, input, { at: start, segment, local }) {
  const op = input.op ?? "replace_match";
  const length = input.match_text.length;
  if (!graphemeBoundary(segment, local))
    throw Error(`${op} match_text starts inside a character; include the whole character`);
  if (!graphemeBoundary(segment, local + length))
    throw Error(`${op} match_text ends inside a character; include the whole character`);
  return { path: textPath(id), start, end: start + length, code: segment.code };
}

/** Resolve one visible range without changing the document: the only match,
 * or the one-based `occurrence` among the matches context and node_index
 * allow. */
export function findUniqueVisibleRange(doc, id, input) {
  const occurrence = occurrenceOf(input);
  const op = input.op ?? "replace_match";
  if (input.all !== undefined) throw Error(`${op} does not take all`);
  const matches = visibleMatches(doc, id, input);
  if (occurrence !== undefined) {
    if (occurrence > matches.length)
      throw Error(
        `${op} found ${matches.length} matches; occurrence ${occurrence} doesn't exist. Read the block again.`,
      );
    return matchRange(id, input, matches[occurrence - 1]);
  }
  if (matches.length !== 1)
    throw Error(
      `${op} found ${matches.length} matches; exactly one is required. Use occurrence, context_before/context_after or a longer match_text.`,
    );
  return matchRange(id, input, matches[0]);
}

/** Every non-overlapping match, in document order, for an operation with
 * `all: true`. A match that starts or ends inside a character is skipped. At
 * least one match is required. */
export function findAllVisibleRanges(doc, id, input) {
  if (input.all !== true) throw Error("all takes the value true");
  if (input.occurrence !== undefined) throw Error("Use occurrence or all, not both");
  const ranges = [];
  const length = input.match_text.length;
  for (const match of visibleMatches(doc, id, input)) {
    if (ranges.length && match.at < ranges.at(-1).end) continue;
    if (!graphemeBoundary(match.segment, match.local)) continue;
    if (!graphemeBoundary(match.segment, match.local + length)) continue;
    ranges.push(matchRange(id, input, match));
  }
  if (!ranges.length) throw Error(`${input.op} found 0 matches; at least one is required`);
  return ranges;
}

const lastWidth = (text) => (/^[\udc00-\udfff]$/.test(text.at(-1)) ? 2 : 1);

/** The characters an `occurrence` addresses, captured as cursors on the
 * batch's starting snapshot. Agents count occurrences from what they read, so
 * an earlier operation in the batch never shifts which match a later one
 * means. */
export function anchorOccurrence(doc, id, input) {
  const { path, start, end } = findUniqueVisibleRange(doc, id, input);
  return {
    path,
    first: A.getCursor(doc, path, start),
    last: A.getCursor(doc, path, end - lastWidth(input.match_text)),
  };
}

/** The range an operation addresses now: its anchored occurrence when it has
 * one, otherwise its unique match. An anchored match an earlier operation in
 * the batch changed is refused rather than retargeted. */
export function locateRange(doc, id, input, anchor) {
  if (!anchor) return findUniqueVisibleRange(doc, id, input);
  const { path } = anchor;
  const start = A.getCursorPosition(doc, path, anchor.first);
  const end = A.getCursorPosition(doc, path, anchor.last) + lastWidth(input.match_text);
  if (
    A.getCursor(doc, path, start) !== anchor.first ||
    doc.blocks[id].richText.slice(start, end) !== input.match_text
  )
    throw Error(
      `${input.op ?? "replace_match"} occurrence ${input.occurrence} was changed by an earlier operation in this batch`,
    );
  return { path, start, end };
}

/** Bounds on the formatting one batch may write. A range written with each
 * of its marks counts once per mark. */
export const MAX_ALL_RANGES = 1000;
export const MAX_BATCH_MARK_WRITES = 2000;
/** Count `writes` against the batch, refusing before any is made. */
export function spendMarkWrites(budget, writes) {
  if (!budget) return;
  budget.writes += writes;
  if (budget.writes > MAX_BATCH_MARK_WRITES)
    throw Error(
      `This batch writes formatting on more than ${MAX_BATCH_MARK_WRITES} ranges; split it into smaller batches.`,
    );
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

/** At most this many partial-mark ranges are named in a marks_dropped warning. */
const MAX_DROPPED_RANGES = 32;

/** The advisory a replace_match receipt carries when a mark covered part of
 * the match but not all of it. The replacement keeps only marks shared by the
 * whole match, so these no longer cover it; the caller decides whether to
 * reapply them with format_match. `ranges` are offsets into match_text. */
function marksDroppedWarning(partial, start, end) {
  const ranges = partial
    .map((mark) => ({
      mark: mark.name,
      start: Math.max(mark.start, start) - start,
      end: Math.min(mark.end, end) - start,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.mark < b.mark ? -1 : 1));
  return {
    code: "marks_dropped",
    marks: [...new Set(ranges.map((range) => range.mark))],
    ranges: ranges.slice(0, MAX_DROPPED_RANGES),
    ...(ranges.length > MAX_DROPPED_RANGES && { ranges_truncated: true }),
    suggested_action:
      "The replacement is plain where these marks covered only part of the match. If it should keep them, apply format_match over the right ranges of the new text.",
  };
}

/** Replace one visible text range, preserving every untouched CRDT character:
 * only the words that differ between the match and the replacement are
 * spliced, so comment anchors on the rest of the match survive. The result
 * reports `matched: 1`, and a `marks_dropped` warning when a mark that
 * covered part of the match without covering all of it was crossed by a
 * replacement or touched by an insertion at its boundary: the inserted
 * characters are plain there. A replaced word inside a mark run, or text
 * inserted strictly inside one, continues the run; a partial mark none of
 * whose words changed still covers every character it did; neither is
 * reported. */
export function replaceMatch(doc, id, input, trace, { anchor, budget } = {}) {
  const { text: replacement, runs } = replacementOf(input);
  const { path, start, end } = locateRange(doc, id, input, anchor);
  if (runs && inCodeBlock(doc, path, start))
    throw Error(
      "replacement_markdown can't format text inside a code block; code text is unformatted. Use replacement.",
    );
  const overlapping = A.marks(doc, path).filter((mark) => mark.start < end && mark.end > start);
  const covers = (mark) => mark.start <= start && mark.end >= end;
  const commonMarks = overlapping.filter(covers);
  const { splices, changed } = textSplices(doc.blocks[id].richText.slice(start, end), replacement);
  const same = (mark) => (other) => other.name === mark.name && other.value === mark.value;
  // Judged before splicing, in the document's offsets at that time. A splice
  // meets a mark when the characters it replaces overlap the mark, or its
  // insertion point touches it. A mark run that encloses the splice (the
  // replaced characters all inside it, or a pure insertion strictly inside
  // it) continues through the inserted text, as under a keystroke that
  // retypes a marked word. A pure insertion at a run's boundary, or a
  // replacement crossing its edge, does not spread the mark, and a partial
  // mark met that way is reported as dropped.
  const meets = (mark, { at, remove }) =>
    remove
      ? mark.start < start + at + remove && mark.end > start + at
      : mark.start <= start + at && start + at <= mark.end;
  const encloses = (mark, { at, remove }) =>
    remove
      ? mark.start <= start + at && start + at + remove <= mark.end
      : mark.start < start + at && start + at < mark.end;
  const partialMarks = overlapping.filter(
    (mark) =>
      !covers(mark) &&
      splices.some(
        (splice) => splice.insert.length && meets(mark, splice) && !encloses(mark, splice),
      ),
  );
  const inserted = [];
  let shift = 0;
  for (const splice of splices) {
    const at = start + splice.at + shift;
    A.splice(doc, path, at, splice.remove, splice.insert);
    if (splice.insert.length)
      inserted.push({
        start: at,
        end: at + splice.insert.length,
        keep: [
          ...commonMarks,
          ...overlapping.filter((mark) => !covers(mark) && encloses(mark, splice)),
        ],
      });
    shift += splice.insert.length - splice.remove;
  }
  for (const { keep, ...range } of inserted) {
    const actual = A.marks(doc, path).filter(
      (mark) => mark.start < range.end && mark.end > range.start,
    );
    // A splice inherits marks at its insertion boundary. That can drop a
    // non-expanding link or spread a partial bold run across the insertion.
    // Reconcile only inserted characters against the marks they keep: those
    // shared by the full match, and the runs that enclose this insertion.
    // Untouched characters keep their own marks.
    for (const mark of actual)
      if (!keep.some(same(mark))) A.unmark(doc, path, { ...range, expand: "none" }, mark.name);
    for (const mark of keep)
      if (
        !actual.some(
          (current) =>
            same(mark)(current) && current.start <= range.start && current.end >= range.end,
        )
      )
        A.mark(doc, path, { ...range, expand: markExpand(mark.name) }, mark.name, mark.value);
  }
  if (inserted.length)
    stampMarks(doc, [...new Set(inserted.flatMap(({ keep }) => keep.map((mark) => mark.name)))]);
  if (runs) applyRuns(doc, path, start, runs, commonMarks, budget);
  // The caret covers the words that changed; a replacement that changed
  // nothing shows the match it addressed.
  trace?.push({
    type: "text",
    block_id: id,
    ...(changed ? { start: start + changed.start, end: start + changed.end } : { start, end }),
  });
  // Formatting written in replacement_markdown is explicit: nothing to report.
  const warn = !runs && partialMarks.length;
  return {
    op: "replace_match",
    block_id: id,
    matched: 1,
    ...(warn ? { warnings: [marksDroppedWarning(partialMarks, start, end)] } : {}),
  };
}

/** The replacement text of a replace_match, and its formatting runs when it
 * came from replacement_markdown. Exactly one of the two is required. */
export function replacementOf(input) {
  const literal = input.replacement !== undefined;
  if (literal === (input.replacement_markdown !== undefined))
    throw Error("replace_match takes replacement or replacement_markdown, not both");
  if (literal) return { text: replacementLiteral(input.replacement, "replacement"), runs: null };
  const source = replacementLiteral(input.replacement_markdown, "replacement_markdown");
  const runs = parseInlineMarkdown(source);
  return { text: runs.map((run) => run.text).join(""), runs };
}

/** Set the formatting of the replaced text, which now starts at `start`, to
 * what replacement_markdown wrote. Marks that covered the whole match stay,
 * as for a literal replacement. Every other mark this build knows is cleared
 * from the range before the written marks are applied. Marks this build
 * doesn't know are kept: Markdown can't express them. */
function applyRuns(doc, path, start, runs, commonMarks, budget) {
  const end = start + runs.reduce((length, run) => length + run.text.length, 0);
  if (end === start) return;
  spendMarkWrites(
    budget,
    runs.reduce((count, run) => count + Object.keys(run.marks).length, 0),
  );
  const kept = new Set(commonMarks.map((mark) => mark.name));
  const clear = new Set(
    A.marks(doc, path)
      .filter((mark) => mark.start < end && mark.end > start)
      .map((mark) => mark.name)
      .filter((name) => isKnownMark(name) && !kept.has(name)),
  );
  for (const name of clear) A.unmark(doc, path, { start, end, expand: "none" }, name);
  const written = new Set();
  let at = start;
  for (const run of runs) {
    const next = at + run.text.length;
    for (const [name, value] of Object.entries(run.marks)) {
      A.mark(doc, path, { start: at, end: next, expand: markExpand(name) }, name, value);
      written.add(name);
    }
    at = next;
  }
  stampMarks(doc, [...written]);
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

/** Validate format_match's add and remove. Returns the stored mark values to
 * add and the mark names to remove. */
export function formatChanges(input) {
  const add = formatMarks(input.add);
  const remove = input.remove ?? [];
  if (!Array.isArray(remove) || remove.some((name) => typeof name !== "string"))
    throw Error("remove must be a list of mark names");
  for (const name of remove) if (!isKnownMark(name)) throw Error(`Unsupported rich mark: ${name}`);
  if (!Object.keys(add).length && !remove.length)
    throw Error("format_match requires add or remove");
  if (remove.some((name) => Object.hasOwn(add, name)))
    throw Error("A mark cannot be both added and removed");
  return { add, remove };
}

/** Add or remove marks over one visible text range, or over every match with
 * `all: true`. Text and CRDT identity are unchanged; a mark added over an
 * existing one with a different value replaces that value in the range.
 *
 * Code text is unformatted. One addressed match inside a code block is
 * refused; with `all`, matches in code are left alone and counted in
 * `skipped_in_code`. */
export function formatMatch(doc, id, input, trace, { anchor, budget } = {}) {
  const { add, remove } = formatChanges(input);
  const located = { ...input, op: "format_match" };
  const path = textPath(id);
  let ranges,
    skipped = 0;
  if (input.all === undefined) {
    const range = locateRange(doc, id, located, anchor);
    if (inCodeBlock(doc, path, range.start))
      throw Error("format_match can't format text inside a code block; code text is unformatted.");
    ranges = [range];
  } else {
    const found = findAllVisibleRanges(doc, id, located);
    if (found.length > MAX_ALL_RANGES)
      throw Error(
        `format_match all found ${found.length} matches; at most ${MAX_ALL_RANGES} per operation. Narrow it with node_index, context or a longer match_text.`,
      );
    ranges = found.filter((range) => !range.code);
    skipped = found.length - ranges.length;
    if (!ranges.length)
      throw Error("format_match found matches only inside code blocks; code text is unformatted.");
  }
  spendMarkWrites(budget, ranges.length * (Object.keys(add).length + remove.length));
  for (const { start, end } of ranges) {
    for (const name of remove) A.unmark(doc, path, { start, end, expand: "both" }, name);
    for (const [name, value] of Object.entries(add))
      A.mark(doc, path, { start, end, expand: markExpand(name) }, name, value);
  }
  stampMarks(doc, Object.keys(add));
  const { start, end } = ranges.at(-1);
  trace?.push({ type: "text", block_id: id, start, end });
  return {
    op: "format_match",
    block_id: id,
    matched: ranges.length,
    ...(skipped ? { skipped_in_code: skipped } : {}),
  };
}

// Whether native position `at` sits in a code block: the nearest block marker
// before it is a code-block marker.
export function inCodeBlock(doc, path, at) {
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
