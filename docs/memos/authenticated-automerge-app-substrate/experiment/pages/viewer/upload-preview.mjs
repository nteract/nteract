// A pending image upload shows where the image will land: an inline preview of
// the chosen file at the insertion point. It's editor view state only; the
// document gets the image once the upload finishes, at the same position.
import { Decoration, Widget } from "wordgard/editor";
import { GardState, Transaction } from "wordgard/state";

/** Set or clear the pending upload: `{ pos, src, name, onCancel }` or null. */
export const setUploadPreview = Transaction.Effect.define({
  map(value, mapping) {
    if (!value) return value;
    const pos = mapping.mapPos(value.pos, 1);
    return pos == null ? null : { ...value, pos };
  },
});

export const uploadPreview = GardState.Field.define({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setUploadPreview)) return effect.value;
    if (!value || !transaction.docChanged) return value;
    // Follow the insertion point through typing and remote edits, the way its
    // Automerge cursor does, so the finished image replaces the preview in place.
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
