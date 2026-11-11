// Everything the viewer needs to open, show and edit a Page. Importing this
// module waits for the Automerge WASM runtime, so main.jsx
// loads it with import() (editor-loader.mjs), at boot or on first use from an
// index route, and renders the shell without it. Keep every Automerge import behind this module;
// scripts/build.mjs fails the build if app.js can reach the runtime.

export { PageSession } from "./session.mjs";
export { orderedBlockIds } from "../model/order.mjs";
export { captureCommentDraft, sendCommentDraft } from "./comment-draft.mjs";
export { isEmptyPage, writingContinuation } from "./writing-continuation.mjs";
export { WordgardEditor } from "./WordgardEditor.jsx";
export { onRendererUnavailable } from "./wordgard-widgets.mjs";
export { CommentsPanel } from "./CommentsPanel.jsx";
export { HeadingAnchors } from "./HeadingAnchors.jsx";
export { CommentPopover } from "./CommentPopover.jsx";
export { SaveStatus } from "./SaveStatus.jsx";
export { PageControls } from "./PageControls.jsx";
export { captureCards } from "./card-capture.mjs";
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
