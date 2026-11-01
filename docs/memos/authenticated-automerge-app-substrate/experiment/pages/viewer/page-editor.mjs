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
export {
  TITLE_IDLE,
  TITLE_MAX_LENGTH,
  composingTitle,
  resolveTitleSelection,
  titleChange,
  titleInput,
  titleSnapshot,
  writeTitle,
} from "./title-selection.mjs";

/** The heads a Trash move compares with the host's copy. */
export const pageHeads = (doc) => A.getHeads(doc);
