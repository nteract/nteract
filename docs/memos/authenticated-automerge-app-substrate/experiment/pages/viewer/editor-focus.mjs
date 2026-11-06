// Giving focus back to the editor a node lives in. A link inside an editable
// Wordgard document can't take focus itself (it is part of the editable
// content), so a card or menu that closes gives focus to the editor instead,
// through Wordgard's own focus(), which restores the editor's selection
// rather than moving it.
//
// Editors register their content element here when they mount
// (WordgardEditor.jsx, CommentRichText.jsx). Wordgard has no public lookup
// from a DOM node to its editor.
const editors = new WeakMap();

/** Register `editor` (a Wordgard view); returns the function that forgets it. */
export function registerEditor(editor) {
  const content = editor.contentDOM;
  editors.set(content, editor);
  return () => {
    if (editors.get(content) === editor) editors.delete(content);
  };
}

/** Whether `element` takes focus itself: connected, not part of editable
 * content, and focusable (a link with an href, a control, or a tabindex). */
export function takesFocus(element) {
  if (!element?.isConnected || element.isContentEditable) return false;
  if (element.closest?.("[inert]")) return false;
  if (element.matches?.("a[href], button:not(:disabled), input:not(:disabled)")) return true;
  return element.tabIndex >= 0;
}

/**
 * Put focus back on `element`, or, when it can't take focus, on the editor it
 * lives in, keeping that editor's selection. Returns what got focus, or null.
 */
export function returnFocus(element) {
  if (!element?.isConnected) return null;
  const document = element.ownerDocument;
  if (takesFocus(element)) {
    if (document.activeElement !== element) element.focus({ preventScroll: true });
    return element;
  }
  const content = element.closest("wg-content");
  if (!content) return null;
  const editor = editors.get(content);
  if (document.activeElement === content) return content;
  if (editor) editor.focus();
  else content.focus({ preventScroll: true });
  return content;
}
