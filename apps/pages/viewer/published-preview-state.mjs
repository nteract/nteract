import { PREVIEW_LAYOUTS } from "../shared/preview-layouts.mjs";

export const PREVIEW_STATES = [
  "loading",
  "ready",
  "rendering",
  "render_failed",
  "uploading_cover",
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
  "choose_layout",
  "prepare",
  "prepared",
  "publish",
  "uploaded",
  "cover_uploaded",
  "unpublish",
  "saved",
  "failed",
  "reload",
];

/** The draft and prepared image are local UI state. Only the server's value
 * reports publication. While rendering edits, retain the last image for display
 * but block publication until the new image is ready. */
export function previewEditorTransition(state, event) {
  switch (event.type) {
    case "loaded":
      if (state.name !== "loading") return state;
      return {
        name: "ready",
        value: event.value,
        draft:
          !state.edited && event.value.snapshot
            ? {
                title: event.value.snapshot.title,
                description: event.value.snapshot.description,
                author: event.value.snapshot.author ?? "",
                visual: event.value.snapshot.cover ? "upload" : "text",
                cover: event.value.snapshot.cover,
                // A snapshot without a layout predates the choice: caption.
                layout:
                  event.value.snapshot.cover && event.value.snapshot.layout === "fill"
                    ? "fill"
                    : "caption",
              }
            : state.draft,
        prepared: null,
        edited: state.edited ?? false,
        error: null,
      };
    case "edit":
      return ["ready", "rendering", "render_failed"].includes(state.name)
        ? {
            ...state,
            name: "rendering",
            draft: { ...state.draft, ...event.patch },
            edited: true,
            error: null,
            message: null,
          }
        : state;
    case "prepare":
      return ["ready", "render_failed"].includes(state.name) && state.draft.title.trim()
        ? { ...state, name: "rendering", error: null }
        : state;
    case "choose_cover":
      return ["ready", "rendering", "render_failed"].includes(state.name) && event.file
        ? {
            ...state,
            name: "rendering",
            draft: {
              ...state.draft,
              visual: "upload",
              file: event.file,
              cover: null,
              layout: "fill",
            },
            prepared: null,
            edited: true,
            error: null,
            message: null,
          }
        : state;
    case "choose_visual":
      return ["ready", "rendering", "render_failed"].includes(state.name) &&
        typeof event.visual === "string"
        ? {
            ...state,
            name: "rendering",
            draft: {
              ...state.draft,
              visual: event.visual,
              file: undefined,
              cover: null,
              layout: "caption",
            },
            prepared: null,
            edited: true,
            error: null,
            message: null,
          }
        : state;
    case "choose_layout":
      return ["ready", "rendering", "render_failed"].includes(state.name) &&
        state.draft.visual === "upload" &&
        PREVIEW_LAYOUTS.includes(event.layout) &&
        event.layout !== (state.draft.layout ?? "caption")
        ? {
            ...state,
            name: "rendering",
            draft: { ...state.draft, layout: event.layout },
            prepared: null,
            edited: true,
            error: null,
            message: null,
          }
        : state;
    case "prepared":
      return state.name === "rendering" && event.draft === state.draft
        ? { ...state, name: "ready", prepared: event.prepared }
        : state;
    case "publish":
      return state.name === "ready" && state.prepared && state.draft.title.trim()
        ? {
            ...state,
            name: state.draft.file || state.prepared.sourceFile ? "uploading_cover" : "uploading",
            nonce: event.nonce,
          }
        : state;
    case "cover_uploaded":
      return state.name === "uploading_cover"
        ? {
            ...state,
            name: "uploading",
            draft: { ...state.draft, visual: "upload", cover: event.cover, file: undefined },
          }
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
      if (state.name === "rendering")
        return event.draft === state.draft
          ? { ...state, name: "render_failed", error: event.error, prepared: null }
          : state;
      return ["loading", "uploading_cover", "uploading", "publishing", "unpublishing"].includes(
        state.name,
      )
        ? { ...state, name: "failed", error: event.error }
        : state;
    case "reload":
      return ["ready", "failed"].includes(state.name)
        ? { ...state, name: "loading", error: null, prepared: null }
        : state;
    default:
      return state;
  }
}
