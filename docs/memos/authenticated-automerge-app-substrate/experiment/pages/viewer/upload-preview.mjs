// A pending image upload shows where the image will land: an inline preview of
// the chosen file at the insertion point. It's editor view state only; the
// document gets the image once the upload finishes, at the same position.
import { Decoration, Widget } from "wordgard/editor";
import { GardState, Transaction } from "wordgard/state";

/** Set or clear the pending upload: `{ resolve, src, name, onCancel }` or
 * null. `resolve()` returns the editor position of the upload's native
 * Automerge cursor, or throws when that target is gone. It's the same
 * resolution the final insert uses, so the preview always marks the spot the
 * image will land, including in repeated text. */
export const setUploadPreview = Transaction.Effect.define();
/** Re-resolve the pending preview against the native document, after a local
 * write has landed in Automerge. */
export const resolveUploadPreview = Transaction.Effect.define();

function place(value) {
  try {
    const pos = value.resolve();
    return Number.isSafeInteger(pos) ? { ...value, pos } : null;
  } catch {
    // The insertion point is gone; the upload reports that itself.
    return null;
  }
}

export const uploadPreview = GardState.Field.define({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setUploadPreview)) return effect.value ? place(effect.value) : null;
      if (effect.is(resolveUploadPreview) && value) return place(value);
    }
    if (!value || !transaction.docChanged) return value;
    // Remote changes reach Automerge first, so the native cursor is current:
    // re-resolve it rather than map the editor position, since a value diff
    // can't tell which of several equal characters a peer inserted. A local
    // edit's diff is exact, and Automerge sees it only after this update, so
    // map it here; the editor re-resolves once the write lands.
    if (transaction.annotation(Transaction.remote)) return place(value);
    const pos = transaction.changes.mapPos(value.pos, 1);
    return pos == null ? null : { ...value, pos };
  },
});

const previewWidget = Widget.define({
  eq: (a, b) => a.src === b.src && a.name === b.name,
  render({ src, name, onCancel }) {
    const host = document.createElement("span");
    host.className = "wordgard-upload-preview";
    host.setAttribute("role", "status");
    host.setAttribute("aria-label", `Uploading ${name || "image"}`);
    if (src) {
      const image = host.appendChild(document.createElement("img"));
      image.src = src;
      image.alt = "";
    }
    const bar = host.appendChild(document.createElement("span"));
    bar.className = "wordgard-upload-preview-bar";
    bar.appendChild(document.createElement("span")).textContent = "Uploading image…";
    if (onCancel) {
      const cancel = bar.appendChild(document.createElement("button"));
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.onclick = (event) => {
        event.preventDefault();
        onCancel();
      };
    }
    return host;
  },
  propagateEvent: false,
});

export const uploadPreviews = [
  uploadPreview,
  Decoration.Point.source.of((state) => {
    const value = state.field(uploadPreview);
    return Decoration.Point.set(
      value ? [[Decoration.Point.widget(previewWidget.of(value), { side: 1 }), value.pos]] : [],
    );
  }),
];
