import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { GardState, Transaction } from "wordgard/state";
import { Leaf } from "wordgard/doc";
import { createWordgardBinding } from "./wordgard-binding.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
import { schema } from "./wordgard-model.mjs";
import { enableRich, textPath } from "../model/richtext.mjs";
import { captureImageInsertion, resolveImageInsertion } from "./image-upload.mjs";
import {
  resolveUploadPreview,
  setUploadPreview,
  uploadPreview,
  uploadPreviews,
} from "./upload-preview.mjs";

const pageId = "page_preview";
const text = (value) => [Leaf.text(value)];

// A replica, binding and editor wired the way WordgardEditor wires them: remote
// changes reach Automerge first and project into the editor; local edits reach
// the editor first, are written, then the preview re-resolves.
function fixture(markdown) {
  let doc = A.change(
    A.from({ page_id: pageId, blocks: { one: { id: "one", kind: "markdown", markdown } } }),
    (d) => enableRich(d, "one"),
  );
  const observers = new Set();
  const replica = {
    pageId,
    alive: true,
    canWrite: true,
    get doc() {
      return doc;
    },
    change(fn, remote = false) {
      const before = doc;
      doc = A.change(doc, fn);
      for (const listener of observers)
        listener({
          remote,
          patches: A.diff(doc, A.getHeads(before), A.getHeads(doc)),
          patchInfo: { before, after: doc },
        });
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
  };
  const binding = createWordgardBinding(replica, "one");
  let state = GardState.create({
    doc: binding.current.doc,
    config: [...schema.elements.map((e) => GardState.schemaElement.of(e)), uploadPreviews],
  });
  const editor = {
    get state() {
      return state;
    },
    dispatch(spec) {
      const tr = state.update(spec);
      state = tr.state;
      binding.applyEditorTransaction(tr);
      if (tr.docChanged && state.field(uploadPreview))
        state = state.update({ effects: resolveUploadPreview.of(null) }).state;
    },
  };
  binding.observe((event) => {
    if (event.remote)
      state = state.update({
        changes: projectChanges(state.doc, event.after.doc),
        effects: state.field(uploadPreview) ? resolveUploadPreview.of(null) : [],
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
      }).state;
  });
  const startUpload = (position) => {
    const target = captureImageInsertion(replica, "one", editor, binding.current.map, position);
    editor.dispatch({
      effects: setUploadPreview.of({
        resolve: () => resolveImageInsertion(replica, target, binding.current.map),
        src: "",
        name: "photo.png",
      }),
    });
    return target;
  };
  // Where the final insert would go, by the same resolution the uploader uses.
  const landing = (target) => resolveImageInsertion(replica, target, binding.current.map);
  const preview = () => editor.state.field(uploadPreview)?.pos ?? null;
  const remote = (fn) => replica.change(fn, true);
  return { replica, editor, startUpload, landing, preview, remote };
}

test("in repeated text, the preview follows the native cursor, not the value diff", () => {
  const f = fixture("aaaa");
  // Upload between the second and third "a".
  const target = f.startUpload(1 + 2);
  assert.equal(f.preview(), f.landing(target));
  // A peer types "a" at the very start. A value diff of "aaaa" -> "aaaaa" can't
  // tell where it went; the Automerge cursor can.
  f.remote((d) => A.splice(d, textPath("one"), 0, 0, "a"));
  assert.equal(f.landing(target), 1 + 3);
  assert.equal(f.preview(), f.landing(target));
  // And again at the end.
  f.remote((d) => A.splice(d, textPath("one"), d.blocks.one.richText.length, 0, "a"));
  assert.equal(f.preview(), f.landing(target));
});

test("local typing before, at and after the point keeps preview and landing together", () => {
  const f = fixture("before after");
  const target = f.startUpload(1 + "before ".length);
  f.editor.dispatch({ changes: { from: 1, insert: text("Plan: ") } });
  assert.equal(f.preview(), f.landing(target));
  const at = f.preview();
  f.editor.dispatch({ changes: { from: at, insert: text("X") } });
  assert.equal(f.preview(), f.landing(target));
  f.editor.dispatch({ changes: { from: f.editor.state.doc.length - 1, insert: text("!") } });
  assert.equal(f.preview(), f.landing(target));
});

test("when the anchor is deleted, the preview clears and the insert would fail", () => {
  const f = fixture("one two three");
  const target = f.startUpload(1 + "one two".length);
  assert.ok(f.preview() !== null);
  // A peer deletes the text around the insertion point.
  f.remote((d) => A.splice(d, textPath("one"), "one ".length, "two three".length));
  let landed;
  try {
    landed = f.landing(target);
  } catch {
    landed = null;
  }
  assert.equal(f.preview(), landed);
});

test("clearing removes the preview", () => {
  const f = fixture("text");
  f.startUpload(2);
  f.editor.dispatch({ effects: setUploadPreview.of(null) });
  assert.equal(f.preview(), null);
});

test("a remote change that leaves the text equal still moves the preview with its cursor", () => {
  const f = fixture("aaaa");
  const target = f.startUpload(1 + 2);
  // One peer change deletes the first "a" and appends one: the rendered text is
  // unchanged, so the projection is empty, but the native cursor moved left.
  f.remote((d) => {
    A.splice(d, textPath("one"), 0, 1);
    A.splice(d, textPath("one"), d.blocks.one.richText.length, 0, "a");
  });
  assert.equal(f.landing(target), 1 + 1);
  assert.equal(f.preview(), f.landing(target));
});
