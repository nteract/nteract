// The rich-text block format and span helpers that need no codec. The browser
// imports these without loading markdown-it or ProseMirror.
import * as A from "@automerge/automerge/slim";

export { safeUrl } from "./marks.mjs";

export const textPath = (id) => ["blocks", id, "richText"];

const markerKey = (value) =>
  JSON.stringify([
    String(value.type),
    Array.isArray(value.parents) ? value.parents.map(String) : [value.parents ?? null],
    Object.entries(value.attrs ?? {})
      .map(([key, item]) => [key, A.isImmutableString(item) ? String(item) : item])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    !!value.isEmbed,
  ]);

/** The offsets of the markers whose stored value at `path` differs from the
 * one `spans` gives, with the value it gives. */
function misstored(doc, path, spans) {
  const wanted = new Map();
  let at = 0;
  for (const span of spans) {
    if (span.type === "block") wanted.set(at, span.value);
    at += span.type === "text" ? span.value.length : 1;
  }
  const wrong = [];
  at = 0;
  for (const span of A.spans(doc, path)) {
    if (span.type === "block") {
      const value = wanted.get(at);
      if (value && markerKey(value) !== markerKey(span.value)) wrong.push([at, value]);
    }
    at += span.type === "text" ? span.value.length : 1;
  }
  return wrong;
}

/** Inside a change: store `spans` as the text at `path`, as `A.updateSpans`
 * does, giving every marker exactly the value `spans` gives it. Automerge
 * 3.5's updateSpans diffs a marker's `parents` list in place, and when a
 * rewrite changes the parents of several markers it can store a list other
 * than the one given (a table row's parents become `["table", "table"]`).
 * A second updateSpans, now over markers of the right types, edits those
 * lists in place, which keeps every marker and so its cursor (its node id).
 * A marker still wrong after that is replaced with `A.updateBlock`, which
 * deletes the marker and inserts a new one: its node id changes. */
export function updateSpansExactly(doc, path, spans, config) {
  A.updateSpans(doc, path, spans, config);
  if (!misstored(doc, path, spans).length) return;
  A.updateSpans(doc, path, spans, config);
  for (const [at, value] of misstored(doc, path, spans)) A.updateBlock(doc, path, at, value);
}
// Code text is unformatted: ProseMirror's code_block allows no marks and a
// Markdown fence can't express them. Marks a writer left on code text are not
// read, so one stray mark can't make the whole Page unreadable.
export function codeTextUnmarked(spans) {
  let code = false;
  return spans.map((span) => {
    if (span.type === "block") code = String(span.value?.type) === "code-block";
    return code && span.type === "text" && Object.keys(span.marks ?? {}).length
      ? { ...span, marks: {} }
      : span;
  });
}
// How the Markdown serializer writes a whitespace-only run. Code, link and
// highlight wrap it in syntax (`` ` ` ``, `[ ](url)`, `<mark> </mark>`).
// Strong, em and strike expel it: when one of them opens on that run, the run
// is written as plain whitespace and none of its marks open. A mark this build
// doesn't know is written as plain text. A new mark in marks.json belongs in
// one of these lists (model/blank-block.test.mjs checks each mark).
const WHITESPACE_VISIBLE_MARKS = ["code", "link", "highlight"];
const WHITESPACE_EXPELLING_MARKS = ["strong", "em", "strike"];
const hasMark = (marks, names) => names.some((name) => marks?.[name] != null);
const inlineParents = (parents = []) =>
  parents.length === 0 || (parents.length === 1 && String(parents[0]) === "paragraph");
/** Whether a block holds nothing a reader would see: the same answer as
 * `!blockMarkdown(block).trim()`, read from the stored content without the
 * Markdown codec. A rich block is blank when it holds only top-level
 * paragraphs with whitespace text and trailing hard breaks. Any other marker
 * (heading, list item, quote, code block, table, rule) or embed (image,
 * dataframe, a node this build doesn't know) has a Markdown form, and so does
 * a hard break followed by text in its paragraph (`\` at the line end). */
export function isBlankBlock(block) {
  let breakPending = false;
  for (const span of A.spans(block, ["richText"])) {
    if (span.type === "text") {
      if (breakPending || span.value.trim()) return false;
      // In a blank block no mark is open before this run: only text, an
      // image or a hard break followed by text could have opened one.
      if (
        hasMark(span.marks, WHITESPACE_VISIBLE_MARKS) &&
        !hasMark(span.marks, WHITESPACE_EXPELLING_MARKS)
      )
        return false;
      continue;
    }
    if (span.type !== "block") return false;
    const { type, isEmbed, parents } = span.value;
    if (isEmbed && String(type) === "hard-break" && inlineParents(parents)) breakPending = true;
    else if (!isEmbed && String(type) === "paragraph" && !parents?.length) breakPending = false;
    else return false;
  }
  return true;
}
export function richSize(block) {
  return new TextEncoder().encode(JSON.stringify(A.spans(block, ["richText"]))).length;
}
