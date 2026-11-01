// The comment-image machine over every state × event, and its interpreter:
// the Page's checks, one upload at a time, cancelled and failed uploads.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runTable } from "../shared/machine-test.mjs";
import { REJECT, commentImageMachine } from "./comment-image-machine.mjs";
import { NEEDS_EDIT_ACCESS, ONE_AT_A_TIME, createCommentImageUploader } from "./comment-image.mjs";

const idle = { name: "idle" };
const uploading = { name: "uploading", token: 2 };
const failed = { name: "failed", message: "Choose a PNG, JPEG, or WebP image." };
const row = (label, state, event, expect, kase) => ({
  label,
  ...(kase && { case: kase }),
  state,
  event,
  expect: { effects: [], ...expect },
});
const ROWS = [
  row(
    "an image starts uploading",
    idle,
    { type: "start", token: 1 },
    {
      state: { name: "uploading", token: 1 },
      effects: [{ type: "upload", token: 1 }],
    },
  ),
  row(
    "a second image waits for the first",
    uploading,
    { type: "start", token: 3 },
    {
      state: uploading,
      rejected: REJECT.busy,
    },
  ),
  row(
    "a new image clears the last failure",
    failed,
    { type: "start", token: 3 },
    {
      state: { name: "uploading", token: 3 },
      effects: [{ type: "upload", token: 3 }],
    },
  ),
  row(
    "idle has no upload to finish",
    idle,
    { type: "uploaded", token: 1 },
    {
      state: idle,
      rejected: REJECT.stale,
    },
  ),
  row(
    "the upload lands in the draft",
    uploading,
    { type: "uploaded", token: 2 },
    {
      state: idle,
      effects: [{ type: "insert", token: 2 }],
    },
    "current",
  ),
  row(
    "a cancelled upload's result is ignored",
    uploading,
    { type: "uploaded", token: 1 },
    {
      state: uploading,
      rejected: REJECT.stale,
    },
    "stale",
  ),
  row(
    "a failure shows no late upload",
    failed,
    { type: "uploaded", token: 2 },
    {
      state: failed,
      rejected: REJECT.stale,
    },
  ),
  row(
    "idle ignores a late failure",
    idle,
    { type: "failed", token: 1, message: "x" },
    {
      state: idle,
      rejected: REJECT.stale,
    },
  ),
  row(
    "a failed upload says why",
    uploading,
    { type: "failed", token: 2, message: "Too big" },
    {
      state: { name: "failed", message: "Too big" },
    },
    "current",
  ),
  row(
    "a cancelled upload's failure is ignored",
    uploading,
    { type: "failed", token: 1, message: "x" },
    {
      state: uploading,
      rejected: REJECT.stale,
    },
    "stale",
  ),
  row(
    "a shown failure ignores a late one",
    failed,
    { type: "failed", token: 2, message: "x" },
    {
      state: failed,
      rejected: REJECT.stale,
    },
  ),
  row(
    "a refused image says why",
    idle,
    { type: "problem", message: "Too big" },
    {
      state: { name: "failed", message: "Too big" },
    },
  ),
  row(
    "a problem during an upload waits",
    uploading,
    { type: "problem", message: "x" },
    {
      state: uploading,
      rejected: REJECT.busy,
    },
  ),
  row(
    "a newer problem replaces the old",
    failed,
    { type: "problem", message: "Newer" },
    {
      state: { name: "failed", message: "Newer" },
    },
  ),
  row("nothing to cancel", idle, { type: "cancel" }, { state: idle, rejected: REJECT.idle }),
  row(
    "cancel stops the upload",
    uploading,
    { type: "cancel" },
    {
      state: idle,
      effects: [{ type: "abort", token: 2 }],
    },
  ),
  row("cancel clears a failure", failed, { type: "cancel" }, { state: idle }),
];

test("the comment-image machine covers every state × event", async () => {
  assert.deepEqual(await runTable(commentImageMachine, ROWS), {
    rows: 17,
    pairs: 15,
    unreachable: 0,
    cases: 4,
  });
});

const png = (name = "chart.png", size = 100, type = "image/png") => ({ name, size, type });
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
function harness({ insert } = {}) {
  const uploads = [],
    inserted = [],
    states = [];
  const uploader = createCommentImageUploader({
    pageId: "page-1",
    upload(file, signal) {
      const pending = { file, signal, ...deferred() };
      uploads.push(pending);
      return pending.promise;
    },
    insert: insert ?? ((asset, alt) => inserted.push([asset.url, alt])),
    onState: (state) => states.push(state.name === "failed" ? state.message : state.name),
  });
  return { uploader, uploads, inserted, states };
}

test("a pasted image uploads once and lands as its asset", async () => {
  const h = harness();
  assert.equal(h.uploader.accept([png()]), true);
  assert.equal(h.uploader.accept([png("second.png")]), true, "a second paste is swallowed");
  await settle();
  assert.equal(h.uploads.length, 1);
  h.uploads[0].resolve({ url: "/api/pages/page-1/assets/" + "a".repeat(64) });
  await settle();
  assert.deepEqual(h.inserted, [["/api/pages/page-1/assets/" + "a".repeat(64), "chart"]]);
  assert.deepEqual(h.states, ["uploading", "idle"]);
});

test("the Page's checks refuse an image before it uploads", async () => {
  for (const [file, message] of [
    [png("notes.gif", 100, "image/gif"), "Choose a PNG, JPEG, or WebP image."],
    [png("huge.png", 6 * 1024 * 1024), "Choose an image smaller than 5 MiB."],
  ]) {
    const h = harness();
    assert.equal(h.uploader.accept([file]), true);
    await settle();
    assert.equal(h.uploads.length, 0);
    assert.deepEqual(h.states, [message]);
  }
  const many = harness();
  many.uploader.accept([png(), png("b.png")]);
  assert.deepEqual(many.states, [ONE_AT_A_TIME]);
  const reader = harness();
  reader.uploader.accept([png()], { canUpload: false });
  assert.deepEqual(reader.states, [NEEDS_EDIT_ACCESS]);
});

test("paste without image files falls through to the editor", () => {
  const h = harness();
  assert.equal(h.uploader.accept([]), false);
  assert.deepEqual(h.states, []);
});

test("a cancelled upload aborts and never inserts", async () => {
  const h = harness();
  h.uploader.accept([png()]);
  await settle();
  h.uploader.cancel();
  assert.equal(h.uploads[0].signal.aborted, true);
  h.uploads[0].resolve({ url: "/late" });
  await settle();
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(h.states, ["uploading", "idle"]);
});

test("a failed upload reports the endpoint's message, then the next image clears it", async () => {
  const h = harness();
  h.uploader.accept([png()]);
  await settle();
  h.uploads[0].reject(Error("Use a valid, static PNG, JPEG, or WebP image"));
  await settle();
  assert.equal(h.uploader.state.name, "failed");
  h.uploader.accept([png("retry.png")]);
  await settle();
  h.uploads[1].resolve({ url: "/api/pages/page-1/assets/" + "b".repeat(64) });
  await settle();
  assert.deepEqual(h.states, [
    "uploading",
    "Use a valid, static PNG, JPEG, or WebP image",
    "uploading",
    "idle",
  ]);
  assert.equal(h.inserted.length, 1);
});

test("an insertion point lost during the upload is reported, not dropped", async () => {
  const h = harness({
    insert() {
      throw Error("The draft changed while the image uploaded. Add it again.");
    },
  });
  h.uploader.accept([png()]);
  await settle();
  h.uploads[0].resolve({ url: "/api/pages/page-1/assets/" + "c".repeat(64) });
  await settle();
  assert.equal(h.uploader.state.name, "failed");
  assert.equal(h.states.at(-1), "The draft changed while the image uploaded. Add it again.");
});

test("closing the composer aborts its upload", async () => {
  const h = harness();
  h.uploader.accept([png()]);
  await settle();
  h.uploader.destroy();
  assert.equal(h.uploads[0].signal.aborted, true);
  assert.equal(h.uploader.accept([png()]), true);
  await settle();
  assert.equal(h.uploads.length, 1, "a destroyed uploader starts nothing");
});

test("the comment composer has no table button and one draft scroller", async () => {
  const source = await readFile(new URL("./CommentRichText.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /TableMenu/);
  const css = await readFile(new URL("./comments.css", import.meta.url), "utf8");
  // The popover scrolls its draft in one box; wg-content must not scroll too.
  const content = css.match(
    /\.comment-popover \.comment-rich-editor \.wordgard-document wg-content \{([^}]*)\}/,
  );
  assert.ok(content);
  assert.doesNotMatch(content[1], /overflow|max-height/);
  assert.match(css, /\.comment-popover \.comment-rich-scroll \{[^}]*overflow-y: auto/);
});

test("typed trailing spaces can't scroll the editor sideways", async () => {
  const css = await readFile(new URL("./wordgard.css", import.meta.url), "utf8");
  assert.match(css, /\.wordgard-document > wg-scroller \{\s*overflow: clip visible;/);
});
