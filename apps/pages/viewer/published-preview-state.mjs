export const PREVIEW_STATES = [
  "loading",
  "ready",
  "rendering",
  "uploading",
  "publishing",
  "unpublishing",
  "failed",
];
export const PREVIEW_EVENTS = [
  "loaded",
  "edit",
  "choose_cover",
  "choose_visual",
  "prepare",
  "prepared",
  "publish",
  "uploaded",
  "unpublish",
  "saved",
  "failed",
  "reload",
];

/** The draft and prepared image are local UI state. Only the server's value
 * reports publication. A changed draft invalidates the exact image approved. */
export function previewEditorTransition(state, event) {
  switch (event.type) {
    case "loaded":
      if (state.name !== "loading") return state;
      return {
        name: "ready",
        value: event.value,
        draft: event.value.snapshot
          ? {
              title: event.value.snapshot.title,
              description: event.value.snapshot.description,
              visual: "text",
            }
          : state.draft,
        prepared: null,
        edited: false,
        error: null,
      };
    case "edit":
      return state.name === "ready"
        ? {
            ...state,
            draft: { ...state.draft, ...event.patch },
            prepared: null,
            edited: true,
            error: null,
            message: null,
          }
        : state;
    case "prepare":
      return state.name === "ready" && state.draft.title.trim()
        ? { ...state, name: "rendering", error: null }
        : state;
    case "choose_cover":
      return state.name === "ready" && event.file
        ? {
            ...state,
            name: "rendering",
            draft: { ...state.draft, visual: "upload", file: event.file },
            prepared: null,
            edited: true,
            error: null,
            message: null,
          }
        : state;
    case "choose_visual":
      return state.name === "ready" && typeof event.visual === "string"
        ? {
            ...state,
            name: "rendering",
            draft: { ...state.draft, visual: event.visual, file: undefined },
            prepared: null,
            edited: true,
            error: null,
            message: null,
          }
        : state;
    case "prepared":
      return state.name === "rendering"
        ? { ...state, name: "ready", prepared: event.prepared }
        : state;
    case "publish":
      return state.name === "ready" && state.prepared && state.draft.title.trim()
        ? { ...state, name: "uploading", nonce: event.nonce }
        : state;
    case "uploaded":
      return state.name === "uploading"
        ? { ...state, name: "publishing", asset: event.asset }
        : state;
    case "unpublish":
      return state.name === "ready" && state.value.snapshot
        ? { ...state, name: "unpublishing", nonce: event.nonce }
        : state;
    case "saved":
      return ["publishing", "unpublishing"].includes(state.name)
        ? {
            ...state,
            name: "ready",
            value: event.value,
            prepared: null,
            edited: false,
            message: event.value.snapshot ? "Preview published." : "Preview removed.",
          }
        : state;
    case "failed":
      return ["loading", "rendering", "uploading", "publishing", "unpublishing"].includes(
        state.name,
      )
        ? { ...state, name: "failed", error: event.error, prepared: null }
        : state;
    case "reload":
      return ["ready", "failed"].includes(state.name)
        ? { ...state, name: "loading", error: null, prepared: null }
        : state;
    default:
      return state;
  }
}
