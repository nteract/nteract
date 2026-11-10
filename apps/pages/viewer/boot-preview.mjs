// Interprets boot-preview-machine.mjs: the read-only preview a Page route may
// show while the editor loads, for this page load and the account the host
// authenticated for it.
import { bootPreviewMachine } from "./boot-preview-machine.mjs";
import { Store } from "./store.mjs";

/** Whether a value has the shape model/page-preview.mjs produces. */
export function isPagePreview(value) {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.title === "string" &&
    Array.isArray(value.blocks) &&
    value.blocks.every(
      (block) => block && typeof block.id === "string" && Array.isArray(block.content),
    )
  );
}

/** The preview the shell may show, or null. Beside the machine's own state it
 * checks the route and account the shell is about to render, so a frame drawn
 * between a change and its event can't show a stale preview. */
export function visiblePreview(state, { pageId, principal }) {
  return state.name === "shown" && state.pageId === pageId && state.principal === principal
    ? state.preview
    : null;
}

export class BootPreview {
  store = new Store(bootPreviewMachine.initial);
  #releases = [];

  /** Start the preview of `pageId` from the head script's request:
   * `early` is earlyConnectAnswer's `{ answer, onInvalidate }`, or null when
   * there is none. */
  start(pageId, early) {
    if (!this.dispatch({ type: "start", pageId })) return;
    if (!early) {
      this.dispatch({ type: "refused" });
      return;
    }
    this.#releases.push(early.onInvalidate(() => this.dispatch({ type: "invalidated" })));
    early.answer.then(
      (answer) =>
        this.dispatch(
          answer?.ok && typeof answer.principal === "string" && isPagePreview(answer.preview)
            ? { type: "resolved", pageId, principal: answer.principal, preview: answer.preview }
            : { type: "refused" },
        ),
      () => this.dispatch({ type: "refused" }),
    );
  }

  /** Run one event. Returns whether the machine accepted it. */
  dispatch(event) {
    const result = bootPreviewMachine.step(this.store.snapshot(), event);
    if (result.rejected) return false;
    this.store.update(() => result.state);
    for (const effect of result.effects) {
      if (effect.type !== "release") throw new Error(`unknown effect ${effect.type}`);
      for (const release of this.#releases.splice(0)) release();
    }
    return true;
  }
}
