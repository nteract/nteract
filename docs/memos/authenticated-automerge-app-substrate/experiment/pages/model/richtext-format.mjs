// The rich-text block format and span helpers that need no codec. The browser
// imports these without loading markdown-it or ProseMirror.
import * as A from "@automerge/automerge/slim";

export { safeUrl } from "./marks.mjs";

export const RICH_FORMAT = "automerge-rich-text-v1";
export const textPath = (id) => ["blocks", id, "richText"];
export const isRich = (block) => block?.format === RICH_FORMAT;
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
export function richSize(block) {
  return isRich(block)
    ? new TextEncoder().encode(JSON.stringify(A.spans(block, ["richText"]))).length
    : 0;
}
/** Whether `spans` open with a marker the editor wouldn't write: a plain
 * top-level paragraph marker before content, or as the only node (encode's
 * implicitAt in model/wordgard-doc.mjs). Writers drop it, so the editor's
 * next structural edit has nothing to delete. */
export function redundantFirstMarker(spans) {
  const [first, next] = spans;
  const plainParagraph =
    first?.type === "block" &&
    String(first.value.type) === "paragraph" &&
    !first.value.isEmbed &&
    !first.value.parents?.length &&
    !Object.keys(first.value.attrs ?? {}).length;
  const content = !next || next.type === "text" || next.value?.isEmbed;
  return plainParagraph && content;
}
