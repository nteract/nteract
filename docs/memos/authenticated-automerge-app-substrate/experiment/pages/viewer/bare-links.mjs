// A pasted URL becomes a bare link: the URL as text, with a link mark whose
// href is that same text. Markdown projects a bare link as an autolink,
// `<url>` (model/markdown-serializer.mjs isPlainURL), and a bare link to one
// of this deployment's Pages or Projects draws as a chit (page-chits.mjs).
//
// Only a plain-text paste converts, and only when the clipboard's text,
// trimmed, is exactly one absolute http(s) URL that passes safeUrl. Every
// such URL converts, not just this deployment's: a link to anywhere is still
// a link. What stays text:
//
// - paste as plain text (Shift): Wordgard skips text parsers for it;
// - a paste into a code block or inside inline code;
// - a paste inside an existing link, which keeps that link's text;
// - anything else on the clipboard: two URLs, a URL and words, `javascript:`.
//
// HTML on the clipboard takes Wordgard's HTML path instead, so a copied
// `<a>` keeps its own label.
//
// The paste is two undo steps, as in Google Docs: the first undo takes the
// link off and leaves the URL as text, the second takes the text out.
import { Leaf, Node, Slice } from "wordgard/doc";
import { Wordgard } from "wordgard/editor";
import { GardSelection } from "wordgard/state";
import { history } from "wordgard/history";
import { Code } from "wordgard/types";
import { safeUrl } from "../model/marks.mjs";
import { PagesLink } from "./wordgard-model.mjs";

/** `text`, trimmed, when it is exactly one absolute http(s) URL that
 * passes safeUrl; otherwise null. */
export function bareUrl(text) {
  if (typeof text !== "string") return null;
  const url = text.trim();
  if (!/^https?:\/\/[^\s/?#]+\S*$/i.test(url) || !safeUrl(url)) return null;
  try {
    return new URL(url).host ? url : null;
  } catch {
    return null;
  }
}

/** The link mark a bare link carries for `url`. */
export const bareLink = (url) => PagesLink.of({ href: url, title: null });

// Slices the text parser made, so the paste handler only takes those.
const parsed = new WeakSet();

/** The slice a plain-text paste of `text` at `pos` should insert as a bare
 * link's text, or null when it stays ordinary text. */
export function bareUrlSlice(text, state, pos = state.selection.replacementRange.from) {
  const url = bareUrl(text);
  if (!url) return null;
  const at = state.doc.resolve(pos);
  if (at.parent.node.type.hasRole(Node.Role.Code)) return null;
  const marks = at.marks();
  if (Code.isInSet(marks) || PagesLink.isInSet(marks)) return null;
  const slice = Slice.of([Leaf.text(url, marks)]);
  parsed.add(slice);
  return slice;
}

/** The text of `state`'s document between `from` and `to`. */
const textBetween = (state, from, to) => Slice.of(state.doc.slice(from, to)).textContent();

/** Insert `slice` (from bareUrlSlice) over the selection, then link it in a
 * second, separate undo step. False when `slice` isn't one of ours. */
export function pasteBareLink(wg, slice) {
  if (!parsed.has(slice)) return false;
  parsed.delete(slice);
  const url = slice.textContent();
  const { from, to } = wg.state.selection.replacementRange;
  const insert = wg.state.update({
    changes: { from, to, insert: slice, fit: true },
    selection: (cx, changes) => GardSelection.near(cx, changes.mapPos(to, 1), -1),
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  wg.dispatch(insert);
  const end = insert.changes.mapPos(to, 1),
    start = end - url.length;
  // A host that refused the paste put the editor back; leave it.
  if (start < 0 || end > wg.state.doc.length || textBetween(wg.state, start, end) !== url)
    return true;
  wg.dispatch({
    changes: { from: start, to: end, add: bareLink(url) },
    userEvent: "input.link",
    annotations: history.isolate.of(true),
  });
  return true;
}

/** The editor extension: Page blocks and comments both use it. */
export const bareLinkPaste = () => [
  Wordgard.clipboardTextParser.of((text, state) => bareUrlSlice(text, state)),
  Wordgard.pasteHandler.of((wg, _event, slice) => pasteBareLink(wg, slice)),
];
