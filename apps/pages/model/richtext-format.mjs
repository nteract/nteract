// The rich-text block format and span helpers that need no codec. The browser
// imports these without loading markdown-it or ProseMirror.
import * as A from "@automerge/automerge/slim";

export { safeUrl } from "./marks.mjs";

export const RICH_FORMAT = "automerge-rich-text-v1";
export const textPath = (id) => ["blocks", id, "richText"];
/** Whether a comment message stores rich text. Page blocks always do. */
export const isRich = (message) => message?.format === RICH_FORMAT;
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
