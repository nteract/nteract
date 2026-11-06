// Interprets comment-composer-machine.mjs for the viewer.
//
// The store holds the machine state, the captured passage (`composer`) and the
// draft body. The body is local UI state: `{ text, spans }` from the rich
// comment editor (CommentRichText), where `spans` are the editor's spans and
// `text` their readable text for copy and recovery, or "" when empty. It
// reaches the shared document only through `send`.
import { commentComposerMachine } from "./comment-composer-machine.mjs";
import { Store } from "./store.mjs";
import { commentSpansMeasure } from "../model/comment-text.mjs";

/** Whether a draft body has content worth keeping and sending: by the
 * comment content rule, text that isn't whitespace or an image. */
export const hasDraftText = (value) =>
  Array.isArray(value?.spans)
    ? commentSpansMeasure(value.spans).content
    : Boolean((typeof value === "string" ? value : "").trim());

/** A draft body's readable text, for copy, display and recovery. */
export const draftText = (value) =>
  typeof value === "string" ? value : typeof value?.text === "string" ? value.text : "";

/** The comment write for a draft body, as `[input, spans]` for
 * `session.comment`: a rich draft's spans as the editor wrote them, or a bare
 * string as literal text. */
export const draftComment = (value) =>
  Array.isArray(value?.spans)
    ? [{}, value.spans]
    : [{ body: draftText(value), body_format: "plain" }, undefined];

const EMPTY = Object.freeze({ state: commentComposerMachine.initial, composer: null, body: "" });

export class CommentComposer {
  store = new Store(EMPTY);
  #adapters;
  #newKey;
  /**
   * Adapters run the machine's effects:
   * - send(composer, body): write the draft. Returns the new thread id (or a
   *   promise of it). A throw or rejection reports `failed`.
   * - focusComposer(), returnFocus(composer), flash(threadId).
   */
  constructor(adapters, { newKey = () => crypto.randomUUID() } = {}) {
    this.#adapters = adapters;
    this.#newKey = newKey;
  }
  snapshot() {
    return this.store.snapshot();
  }
  /** Comment was chosen on `draft` (from captureCommentDraft). */
  start(draft, quote = "") {
    const key = this.#newKey();
    return this.#dispatch({ type: "start", key }, (current) => ({
      ...current,
      composer: Object.freeze({ key, draft, quote }),
    }));
  }
  /** Reopen the dismissed draft where it was. */
  reopen() {
    const key = this.snapshot().composer?.key;
    return key ? this.#dispatch({ type: "start", key }) : false;
  }
  change(body) {
    if (!this.snapshot().composer) return;
    this.store.update((current) => ({ ...current, body }));
  }
  dismiss({ returnFocus = false } = {}) {
    return this.#dispatch({
      type: "dismiss",
      empty: !hasDraftText(this.snapshot().body),
      returnFocus,
    });
  }
  cancel() {
    return this.#dispatch({ type: "cancel" });
  }
  submit() {
    if (!hasDraftText(this.snapshot().body)) return false;
    return this.#dispatch({ type: "submit" });
  }
  reset() {
    return this.#dispatch({ type: "reset" });
  }
  /** Move focus into the visible composer, for a surface that just stopped
   * accepting focus. Does nothing while the composer is closed. */
  focus() {
    const { name } = this.snapshot().state;
    if (name === "open" || name === "sending") this.#adapters.focusComposer?.();
  }
  /** Step the machine; on acceptance apply `update` and the state, then run
   * the effects. Returns whether the event was accepted. */
  #dispatch(event, update = (current) => current) {
    const before = this.snapshot();
    const result = commentComposerMachine.step(before.state, event);
    if (result.rejected) return false;
    const next = this.store.update((current) => ({ ...update(current), state: result.state }));
    for (const effect of result.effects) this.#run(effect, next, before);
    return true;
  }
  #run(effect, current, before) {
    const adapters = this.#adapters;
    switch (effect.type) {
      case "discardDraft":
        this.store.update((value) => ({ ...value, composer: null, body: "" }));
        return;
      case "focusComposer":
        return adapters.focusComposer?.();
      case "returnFocus":
        return adapters.returnFocus?.(current.composer ?? before.composer);
      case "flash":
        return adapters.flash?.(effect.threadId);
      case "send":
        return this.#send(effect.key, current);
    }
    throw new Error(`unknown effect ${effect.type}`);
  }
  #send(key, { composer, body }) {
    const failed = (error) =>
      this.#dispatch({
        type: "failed",
        key,
        message: String(error?.message || error || "Couldn't send the comment"),
      });
    let pending;
    try {
      pending = this.#adapters.send(composer, body);
    } catch (error) {
      // Report after this dispatch finishes so the store sees `sending` first.
      queueMicrotask(() => failed(error));
      return;
    }
    Promise.resolve(pending).then(
      (threadId) => this.#dispatch({ type: "sent", key, threadId: threadId || null }),
      failed,
    );
  }
}

/** What a recovery record keeps of a draft body: its text and, for a rich
 * draft, its spans as plain data (IndexedDB keeps no class instances), so the
 * archive can export its formatting and images. */
export const draftRecord = (value) => ({
  body: draftText(value),
  ...(Array.isArray(value?.spans) && { spans: JSON.parse(JSON.stringify(value.spans)) }),
});
