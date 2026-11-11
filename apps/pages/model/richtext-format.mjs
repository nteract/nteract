// The rich-text block format and span helpers that need no codec. The browser
// imports these without loading markdown-it or ProseMirror.
import * as A from "@automerge/automerge/slim";

export { safeUrl } from "./marks.mjs";

export const textPath = (id) => ["blocks", id, "richText"];

// A marker stores its parents as one immutable string: the container names,
// outermost first, joined by "/" ("" for none). No block name holds a "/".
// As one value, two writers that change one marker's parents at once leave
// one writer's parents, never a mix of both. Code reads and writes parents as
// a list of names; readSpans and the writers below convert at the store.
export const PARENTS_SEPARATOR = "/";
/** The stored form of a list of parent names. */
export const parentsValue = (parents = []) =>
  new A.ImmutableString(parents.map(String).join(PARENTS_SEPARATOR));
const parentsList = (value) =>
  String(value) === ""
    ? []
    : String(value)
        .split(PARENTS_SEPARATOR)
        .map((name) => new A.ImmutableString(name));
const storedMarker = (value) =>
  Array.isArray(value.parents) ? { ...value, parents: parentsValue(value.parents) } : value;
/** `A.spans`, with each marker's stored parents read as a list of names. A
 * value that isn't an immutable string is passed through as stored, and
 * every reader draws it as no parents (lossy). Spike: a stored list is passed
 * through too, so fixtures that store lists still read. */
export function readSpans(doc, path) {
  return A.spans(doc, path).map((span) =>
    span.type === "block" && A.isImmutableString(span.value?.parents)
      ? { ...span, value: { ...span.value, parents: parentsList(span.value.parents) } }
      : span,
  );
}
/** Inside a change: split a block marker in, with its parents stored. */
export const splitBlockStored = (doc, path, at, value) =>
  A.splitBlock(doc, path, at, storedMarker(value));

const markerKey = (value) =>
  JSON.stringify([
    String(value.type),
    Array.isArray(value.parents) ? value.parents.map(String) : String(value.parents ?? ""),
    Object.entries(value.attrs ?? {})
      .map(([key, item]) => [key, A.isImmutableString(item) ? String(item) : item])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    !!value.isEmbed,
  ]);

/** Inside a change: store `spans` as the text at `path`, as `A.updateSpans`
 * does, and then give every marker exactly the value `spans` gives it.
 * Automerge 3.5's updateSpans diffs a marker's `parents` list in place, and
 * when a rewrite changes the parents of several markers it can store a list
 * other than the one given (a table row's parents become `["table",
 * "table"]`). `A.updateBlock` replaces a marker's value and keeps the marker,
 * so its cursor, which is its node id, stays. */
export function updateSpansExactly(doc, path, given, config) {
  const spans = given.map((span) =>
    span.type === "block" ? { ...span, value: storedMarker(span.value) } : span,
  );
  A.updateSpans(doc, path, spans, config);
  const wanted = new Map();
  let at = 0;
  for (const span of spans) {
    if (span.type === "block") wanted.set(at, span.value);
    at += span.type === "text" ? span.value.length : 1;
  }
  at = 0;
  for (const span of A.spans(doc, path)) {
    if (span.type === "block") {
      const value = wanted.get(at);
      if (value && markerKey(value) !== markerKey(span.value)) A.updateBlock(doc, path, at, value);
    }
    at += span.type === "text" ? span.value.length : 1;
  }
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
  for (const span of readSpans(block, ["richText"])) {
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
