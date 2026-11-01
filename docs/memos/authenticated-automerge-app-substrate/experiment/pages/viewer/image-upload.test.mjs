import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { JSDOM } from "jsdom";
import { Leaf, parse, serialize } from "wordgard/doc";
import { GardState, Transaction } from "wordgard/state";
import { history, undo, redo } from "wordgard/history";
import { Command } from "wordgard/command";
import { createWordgardBinding } from "./wordgard-binding.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
import { schema, encode, decode, PagesImage, Paragraph } from "./wordgard-model.mjs";
import { blockMarkdown, enableRich, textPath, validateRich } from "../model/richtext.mjs";
import { IMAGE_MAX_BYTES, imageAssetUrl } from "../shared/image-assets.mjs";
import {
  captureImageInsertion,
  resolveImageInsertion,
  createImageUploader,
  imageFiles,
  uploadPageImage,
} from "./image-upload.mjs";

const assetId = "a".repeat(64),
  pageId = "page-a",
  asset = { asset_id: assetId, url: imageAssetUrl(pageId, assetId), mime_type: "image/png" },
  file = { name: "Screenshot.png", type: "image/png", size: 100 };
function fixture(markdown = "hello world", { anchor = 7 } = {}) {
  let doc = A.change(
    A.from({
      page_id: pageId,
      blocks: { one: { id: "one", kind: "markdown", markdown } },
    }),
    (d) => enableRich(d, "one"),
  );
  const observers = new Set(),
    replica = {
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
    },
    binding = createWordgardBinding(replica, "one");
  let state = GardState.create({
    doc: binding.current.doc,
    config: [history(), ...schema.elements.map((element) => GardState.schemaElement.of(element))],
    selection: { anchor: typeof anchor === "function" ? anchor(binding.current) : anchor },
  });
  const editor = {
    get state() {
      return state;
    },
    dispatch(spec) {
      const tr = state.update(spec);
      state = tr.state;
      binding.applyEditorTransaction(tr);
    },
  };
  binding.observe((event) => {
    if (event.remote)
      state = state.update({
        changes: projectChanges(state.doc, event.after.doc),
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
      }).state;
  });
  return {
    replica,
    binding,
    editor,
    target: () => captureImageInsertion(replica, "one", editor, binding.current.map),
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("image clipboard HTML preserves the native reference, alt and title without executable attributes", () => {
  const dom = new JSDOM();
  try {
    const native = A.change(
      A.from({
        blocks: {
          one: { kind: "markdown", markdown: `Before ![Screenshot](${asset.url} "A title") after` },
        },
      }),
      (d) => enableRich(d, "one"),
    );
    const original = decode(A.spans(native, textPath("one"))).doc,
      fragment = serialize(original).toDOM(dom.window.document),
      pasted = parse(schema, fragment);
    assert.ok(pasted.eq(original));
    const updated = A.change(native, (d) => A.updateSpans(d, textPath("one"), encode(pasted)));
    validateRich(updated.blocks.one);
    assert.equal(blockMarkdown(updated.blocks.one), blockMarkdown(native.blocks.one));
    dom.window.document.body.innerHTML = `<p><img src="${asset.url}" alt="&lt;script&gt;" onerror="alert(1)" style="display:none"></p>`;
    const safe = serialize(parse(schema, dom.window.document.body)).toDOM(dom.window.document);
    const image = safe.querySelector("img");
    assert.equal(image.getAttribute("alt"), "<script>");
    assert.equal(image.hasAttribute("onerror"), false);
    assert.equal(image.hasAttribute("style"), false);
    for (const src of [
      "javascript:alert(1)",
      "data:image/png;base64,xyz",
      "blob:https://example.test/image",
      "java\tscript:alert(1)",
    ]) {
      const element = dom.window.document.createElement("img");
      element.setAttribute("src", src);
      dom.window.document.body.replaceChildren(element);
      assert.equal(
        serialize(parse(schema, dom.window.document.body))
          .toDOM(dom.window.document)
          .querySelector("img"),
        null,
      );
      assert.throws(
        () => encode(schema.doc([Paragraph.create([PagesImage.of({ src })])])),
        /Invalid Pages image/,
      );
    }
  } finally {
    dom.window.close();
  }
});

test("delayed image upload follows a native cursor through peer edits and remains undoable", async () => {
  const f = fixture(),
    pending = deferred(),
    states = [];
  const object = A.getObjectId(f.replica.doc.blocks.one, "richText"),
    target = f.target();
  const uploader = createImageUploader({
    replica: f.replica,
    getEditor: () => f.editor,
    getMap: () => f.binding.current.map,
    isCurrent: () => true,
    onState: (state) => states.push(state),
    upload: () => pending.promise,
  });
  const completion = uploader.start([file], target);
  assert.equal(states.at(-1).pending, true);
  f.replica.change((d) => A.splice(d, textPath("one"), 0, 0, "Peer "), true);
  // The uploader must not move a caret that moved elsewhere while waiting.
  f.editor.dispatch({ selection: { anchor: 1 } });
  pending.resolve(asset);
  await completion;
  assert.equal(f.editor.state.selection.head, 1);
  assert.equal(A.getObjectId(f.replica.doc.blocks.one, "richText"), object);
  assert.equal(
    blockMarkdown(f.replica.doc.blocks.one),
    `Peer hello ![Screenshot](${asset.url})world`,
  );
  assert.equal(states.at(-1), null);
  const run = (command) => Command.dispatch(f.editor, command);
  assert.equal(run(undo), true);
  assert.equal(blockMarkdown(f.replica.doc.blocks.one), "Peer hello world");
  assert.equal(run(redo), true);
  assert.match(blockMarkdown(f.replica.doc.blocks.one), /!\[Screenshot\]/);
  uploader.destroy();
  f.binding.destroy();
});

function uploaderFor(f, upload) {
  return createImageUploader({
    replica: f.replica,
    getEditor: () => f.editor,
    getMap: () => f.binding.current.map,
    isCurrent: () => true,
    onState: () => {},
    upload,
  });
}
function type(f, text) {
  for (const character of text) {
    const from = f.editor.state.selection.head;
    f.editor.dispatch({
      changes: { from, insert: [Leaf.text(character)] },
      selection: { anchor: from + 1 },
      userEvent: "input.type",
    });
  }
}
const image = `![Screenshot](${asset.url})`;

test("after an image paste the caret follows the image, so typing continues after it", async () => {
  const f = fixture(),
    uploader = uploaderFor(f, async () => asset);
  await uploader.start([file], f.target());
  assert.equal(blockMarkdown(f.replica.doc.blocks.one), `hello ${image}world`);
  assert.equal(f.editor.state.selection.head, 8);
  type(f, "b");
  assert.equal(blockMarkdown(f.replica.doc.blocks.one), `hello ${image}bworld`);
  uploader.destroy();
  f.binding.destroy();
});

test("typing during a slow upload stays after the image and keeps the caret", async () => {
  const f = fixture(),
    pending = deferred(),
    uploader = uploaderFor(f, () => pending.promise);
  const completion = uploader.start([file], f.target());
  type(f, "bc");
  assert.equal(blockMarkdown(f.replica.doc.blocks.one), "hello bcworld");
  // A peer edit before the paste point moves both anchors together.
  f.replica.change((d) => A.splice(d, textPath("one"), 0, 0, "Peer "), true);
  pending.resolve(asset);
  await completion;
  assert.equal(blockMarkdown(f.replica.doc.blocks.one), `Peer hello ${image}bcworld`);
  // The caret stays after "bc", which moved right past the image.
  assert.equal(f.editor.state.selection.head, 1 + "Peer hello ".length + 1 + 2);
  type(f, "d");
  assert.equal(blockMarkdown(f.replica.doc.blocks.one), `Peer hello ${image}bcdworld`);
  uploader.destroy();
  f.binding.destroy();
});

test("an image pasted at the start or the end of a block puts the caret after it", async () => {
  const start = fixture("hello world", { anchor: 1 }),
    first = uploaderFor(start, async () => asset);
  await first.start([file], start.target());
  assert.equal(blockMarkdown(start.replica.doc.blocks.one), `${image}hello world`);
  assert.equal(start.editor.state.selection.head, 2);
  first.destroy();
  start.binding.destroy();

  const end = fixture("hello world", { anchor: ({ doc }) => doc.length - 1 }),
    second = uploaderFor(end, async () => asset);
  await second.start([file], end.target());
  assert.equal(blockMarkdown(end.replica.doc.blocks.one), `hello world${image}`);
  assert.equal(end.editor.state.selection.head, end.editor.state.doc.length - 1);
  type(end, "!");
  assert.equal(blockMarkdown(end.replica.doc.blocks.one), `hello world${image}!`);
  second.destroy();
  end.binding.destroy();
});

test("pending images never insert into a revoked, disposed, replaced, deleted or different Page", async () => {
  for (const scenario of ["revoked", "disposed", "replaced", "deleted", "page", "anchor removed"]) {
    const f = fixture(),
      pending = deferred(),
      states = [];
    let current = true;
    const uploader = createImageUploader({
      replica: f.replica,
      getEditor: () => f.editor,
      getMap: () => f.binding.current.map,
      isCurrent: () => current,
      onState: (state) => states.push(state),
      upload: () => pending.promise,
    });
    const completion = uploader.start([file], f.target());
    if (scenario === "revoked") f.replica.canWrite = false;
    if (scenario === "disposed") {
      current = false;
      uploader.destroy();
    }
    if (scenario === "replaced")
      f.replica.change((d) => {
        d.blocks.one.richText = "replacement";
      }, true);
    if (scenario === "deleted")
      f.replica.change((d) => {
        delete d.blocks.one;
      }, true);
    if (scenario === "page") f.replica.pageId = "other-page";
    if (scenario === "anchor removed")
      // The image is anchored to the character before the insertion point.
      f.replica.change((d) => A.splice(d, textPath("one"), 5, 1, ""), true);
    const before = A.getHeads(f.replica.doc);
    pending.resolve(asset);
    await completion;
    assert.deepEqual(A.getHeads(f.replica.doc), before, scenario);
    uploader.destroy();
    f.binding.destroy();
  }
});

test("upload failures retain a local retry, and cancellation cannot later insert", async () => {
  const f = fixture(),
    states = [];
  let attempts = 0;
  const uploader = createImageUploader({
    replica: f.replica,
    getEditor: () => f.editor,
    getMap: () => f.binding.current.map,
    isCurrent: () => true,
    onState: (state) => states.push(state),
    upload: async () => {
      if (!attempts++) throw Error("Network unavailable");
      return asset;
    },
  });
  await uploader.start([file], f.target());
  assert.equal(states.at(-1).retryable, true);
  assert.equal(blockMarkdown(f.replica.doc.blocks.one), "hello world");
  await uploader.retry();
  assert.equal(attempts, 2);
  assert.match(blockMarkdown(f.replica.doc.blocks.one), /!\[Screenshot\]/);
  uploader.destroy();
  f.binding.destroy();

  const next = fixture(),
    pending = deferred();
  let signal;
  const canceled = createImageUploader({
    replica: next.replica,
    getEditor: () => next.editor,
    getMap: () => next.binding.current.map,
    isCurrent: () => true,
    onState() {},
    upload: (_pageId, _file, value) => {
      signal = value;
      return pending.promise;
    },
  });
  const completion = canceled.start([file], next.target());
  canceled.cancel();
  assert.equal(signal.aborted, true);
  pending.resolve(asset);
  await completion;
  assert.equal(blockMarkdown(next.replica.doc.blocks.one), "hello world");
  canceled.destroy();
  next.binding.destroy();
});

test("invalid files are rejected before upload, and read-only capture is unavailable", async () => {
  const f = fixture(),
    states = [];
  const uploader = createImageUploader({
    replica: f.replica,
    getEditor: () => f.editor,
    getMap: () => f.binding.current.map,
    isCurrent: () => true,
    onState: (state) => states.push(state),
    upload() {
      assert.fail("Unexpected upload");
    },
  });
  for (const invalid of [
    { ...file, size: IMAGE_MAX_BYTES + 1 },
    { ...file, type: "image/svg+xml" },
    { ...file, size: 0 },
  ]) {
    await uploader.start([invalid], f.target());
    assert.equal(states.at(-1).retryable, false);
  }
  await uploader.start([file, file], f.target());
  assert.match(states.at(-1).message, /one image/);
  const target = f.target();
  f.replica.canWrite = false;
  assert.throws(f.target, /insertion point/);
  assert.throws(
    () => resolveImageInsertion(f.replica, target, f.binding.current.map),
    /insertion point/,
  );
  uploader.destroy();
  f.binding.destroy();
});

test("a rejected native insertion cannot look like a completed upload", async () => {
  const f = fixture(),
    states = [];
  let dispatches = 0;
  const uploader = createImageUploader({
    replica: f.replica,
    getEditor: () => ({
      state: f.editor.state,
      dispatch() {
        dispatches++;
      },
    }),
    getMap: () => f.binding.current.map,
    isCurrent: () => true,
    onState: (state) => states.push(state),
    upload: async () => asset,
  });
  await uploader.start([file], f.target());
  assert.equal(states.at(-1).pending, false);
  assert.match(states.at(-1).message, /wasn't inserted/);
  assert.equal(states.at(-1).retryable, false);
  await uploader.retry();
  assert.equal(dispatches, 1);
  assert.equal(blockMarkdown(f.replica.doc.blocks.one), "hello world");
  uploader.destroy();
  f.binding.destroy();
});

test("paste/drop recognize image files while ordinary text keeps the editor clipboard path", () => {
  assert.deepEqual(imageFiles({ files: [file] }), [file]);
  assert.deepEqual(imageFiles({ items: [{ kind: "file", getAsFile: () => file }] }), [file]);
  assert.deepEqual(imageFiles({ files: [{ type: "text/plain", name: "notes.txt" }] }), []);
  assert.deepEqual(
    imageFiles({ files: [{ ...file, name: "Screenshot.png", type: "" }] }).length,
    1,
  );
});

test("raw upload uses only the stable same-origin authenticated route", async () => {
  const signal = new AbortController().signal;
  const result = await uploadPageImage(pageId, file, signal, async (url, options) => {
    assert.equal(url, `/api/pages/${pageId}/assets`);
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.body, file);
    assert.equal(options.headers["Content-Type"], "image/png");
    assert.equal(options.signal, signal);
    return Response.json(asset, { status: 201 });
  });
  assert.deepEqual(result, asset);
  for (const url of [
    "https://bucket.example/image?token=secret",
    "data:image/png;base64,xyz",
    "/api/pages/other/assets/" + assetId,
  ])
    await assert.rejects(
      uploadPageImage(pageId, file, signal, async () => Response.json({ ...asset, url })),
      /invalid image reference/,
    );
  await assert.rejects(
    uploadPageImage(pageId, file, signal, async () =>
      Response.json({ error: "No edit access" }, { status: 403 }),
    ),
    /No edit access/,
  );
});
