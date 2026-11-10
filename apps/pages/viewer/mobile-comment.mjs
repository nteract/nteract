/**
 * What the phone bar's Comment button comments on. It's an action, never a
 * toggle: the open-comments list stays in the header.
 *
 * - `selection`: the selected passage, like Comment on selection on desktop.
 * - `paragraph`: nothing is selected, so the paragraph holding the caret.
 *   Touch selection is fiddly; the desktop toolbar keeps requiring a selection.
 * - `none`: the caret's paragraph has no text. The bar asks for a selection.
 */
export function mobileCommentScope({ selected, paragraphText }) {
  if (selected) return "selection";
  // U+FFFC stands in for inline objects such as images; they carry no text.
  return paragraphText?.replaceAll("\ufffc", "").trim() ? "paragraph" : "none";
}

export const MOBILE_COMMENT_LABELS = {
  selection: "Comment on selection",
  paragraph: "Comment on paragraph",
  none: "Comment",
};

export const MOBILE_COMMENT_HINT = "Select some text to comment on.";
