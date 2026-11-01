// Everything the viewer needs to open, show and edit a Page. Importing this
// module waits for the Automerge and Subduction WASM runtimes, so main.jsx
// loads it with import() (editor-loader.mjs), at boot or on first use from an
// index route, and renders the shell without it. Keep every Automerge or Subduction import behind this module;
// scripts/build.mjs fails the build if app.js can reach the runtimes.
import * as A from "@automerge/automerge";

export { PageSession } from "./session.mjs";
export { orderedBlockIds } from "../model/order.mjs";
export { captureCommentDraft, sendCommentDraft } from "./comment-draft.mjs";
export { writingContinuation } from "./writing-continuation.mjs";
export { WordgardEditor } from "./WordgardEditor.jsx";
export { onRendererUnavailable } from "./wordgard-widgets.mjs";
export { CommentsPanel } from "./CommentsPanel.jsx";
export { CommentPopover } from "./CommentPopover.jsx";
export { SaveStatus } from "./SaveStatus.jsx";
export { PageControls } from "./PageControls.jsx";
export { resolveTitleSelection, titleEdit, titleSnapshot } from "./title-selection.mjs";

/** The heads a Trash move compares with the host's copy. */
export const pageHeads = (doc) => A.getHeads(doc);

/** Replace a Page title inside `session.change`. `edit` comes from
 * titleEdit against the document before the change; without one the title
 * is diffed as a whole. */
export function setPageTitle(doc, title, edit = null) {
  if (edit) {
    if (edit.remove || edit.insert) A.splice(doc, ["title"], edit.index, edit.remove, edit.insert);
  } else A.updateText(doc, ["title"], title);
}
