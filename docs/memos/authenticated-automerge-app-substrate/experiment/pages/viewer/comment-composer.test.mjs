// The comment-composer table through the pure machine, and CommentComposer's
// interpretation of it: draft persistence, sending, and stale results.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { commentComposerMachine } from "./comment-composer-machine.mjs";
import { CommentComposer, draftText, hasDraftText } from "./comment-composer.mjs";

const TABLE = new URL("../test/fixtures/machines/comment-composer.json", import.meta.url);

test("the comment-composer table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(commentComposerMachine, loadTable(TABLE)), {
    rows: 32,
    pairs: 28,
    unreachable: 0,
    cases: 8,
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}

function harness(send = () => "thread-1") {
  const calls = [];
  let n = 0;
  const composer = new CommentComposer(
    {
      send: (current, body) => {
        calls.push(["send", current.key, body]);
        return send(current, body);
      },
      focusComposer: () => calls.push(["focusComposer"]),
      returnFocus: (current) => calls.push(["returnFocus", current?.draft.blockId]),
      flash: (threadId) => calls.push(["flash", threadId]),
    },
    { newKey: () => `key-${++n}` },
  );
  return { composer, calls, state: () => composer.snapshot() };
}

const draft = (blockId = "block-a") => ({ blockId, target: { kind: "selection" } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("hasDraftText reads a rich draft's spans: text or an image counts, whitespace doesn't", () => {
  const image = {
    type: "block",
    value: {
      type: "image",
      parents: ["paragraph"],
      attrs: { src: "/a.png", alt: "" },
      isEmbed: true,
    },
  };
  const hardBreak = {
    type: "block",
    value: { type: "hard-break", parents: ["paragraph"], attrs: {}, isEmbed: true },
  };
  assert.equal(hasDraftText(""), false);
  assert.equal(hasDraftText("  \n"), false);
  assert.equal(
    hasDraftText({ text: " ", spans: [{ type: "text", value: " ", marks: {} }] }),
    false,
  );
  assert.equal(hasDraftText({ text: "\n", spans: [hardBreak] }), false);
  assert.equal(hasDraftText("Note"), true);
  assert.equal(
    hasDraftText({ text: "Note", spans: [{ type: "text", value: "Note", marks: {} }] }),
    true,
  );
  assert.equal(hasDraftText({ text: "", spans: [image] }), true, "an image-only comment");
  assert.equal(draftText({ text: "Note", spans: [] }), "Note");
  assert.equal(draftText("Plain"), "Plain");
  assert.equal(draftText(""), "");
});

test("closing with text keeps the draft; Continue reopens the same text and passage", () => {
  const { composer, calls, state } = harness();
  assert.equal(composer.start(draft(), "passage"), true);
  composer.change({ text: "Keep me", spans: [{ type: "text", value: "Keep me", marks: {} }] });
  assert.equal(composer.dismiss({ returnFocus: true }), true);
  assert.equal(state().state.name, "dismissed");
  assert.deepEqual(state().body, {
    text: "Keep me",
    spans: [{ type: "text", value: "Keep me", marks: {} }],
  });
  assert.equal(composer.reopen(), true);
  assert.deepEqual(state().state, { name: "open", key: "key-1" });
  assert.equal(state().composer.quote, "passage");
  assert.deepEqual(state().body, {
    text: "Keep me",
    spans: [{ type: "text", value: "Keep me", marks: {} }],
  });
  assert.deepEqual(calls, [["focusComposer"], ["returnFocus", "block-a"], ["focusComposer"]]);
});

test("closing an empty popover drops the composer without moving focus", () => {
  const { composer, calls, state } = harness();
  composer.start(draft());
  composer.change("   ");
  composer.dismiss();
  assert.deepEqual(state(), { state: { name: "idle" }, composer: null, body: "" });
  assert.deepEqual(calls, [["focusComposer"]]);
});

test("choosing Comment on another passage keeps the text under a new key", () => {
  const { composer, state } = harness();
  composer.start(draft("block-a"), "first");
  composer.change("Carry this");
  composer.dismiss();
  composer.start(draft("block-b"), "second");
  assert.deepEqual(state().state, { name: "open", key: "key-2" });
  assert.equal(state().composer.draft.blockId, "block-b");
  assert.equal(state().composer.quote, "second");
  assert.equal(state().body, "Carry this");
});

test("Cancel discards the draft and returns focus to the passage's block", () => {
  const { composer, calls, state } = harness();
  composer.start(draft("block-c"));
  composer.change("Throw away");
  composer.cancel();
  assert.deepEqual(state(), { state: { name: "idle" }, composer: null, body: "" });
  assert.deepEqual(calls.at(-1), ["returnFocus", "block-c"]);
  composer.change("ignored without a composer");
  assert.equal(state().body, "");
});

test("an empty draft is never sent", () => {
  const { composer, calls, state } = harness();
  composer.start(draft());
  assert.equal(composer.submit(), false);
  assert.equal(state().state.name, "open");
  assert.equal(
    calls.some(([name]) => name === "send"),
    false,
  );
});

test("a send writes the body, then closes, flashes the thread and returns focus", async () => {
  const pending = deferred();
  const { composer, calls, state } = harness(() => pending.promise);
  composer.start(draft("block-a"));
  composer.change({ text: "Ship it", spans: [{ type: "text", value: "Ship it", marks: {} }] });
  assert.equal(composer.submit(), true);
  assert.deepEqual(state().state, { name: "sending", key: "key-1" });
  assert.deepEqual(calls.at(-1), [
    "send",
    "key-1",
    { text: "Ship it", spans: [{ type: "text", value: "Ship it", marks: {} }] },
  ]);
  assert.equal(composer.dismiss({ returnFocus: true }), false, "Escape waits for the send");
  assert.equal(composer.start(draft("block-b")), false, "a new passage waits for the send");
  pending.resolve("thread-9");
  await settle();
  assert.deepEqual(state(), { state: { name: "idle" }, composer: null, body: "" });
  assert.deepEqual(calls.slice(-2), [
    ["flash", "thread-9"],
    ["returnFocus", "block-a"],
  ]);
});

test("a failed send reopens the draft with its reason and the text intact", async () => {
  const { composer, state } = harness(() => {
    throw Error("Selected passage was removed or replaced; select it again");
  });
  composer.start(draft());
  composer.change("Still here");
  composer.submit();
  assert.equal(state().state.name, "sending");
  await settle();
  assert.deepEqual(state().state, {
    name: "open",
    key: "key-1",
    error: "Selected passage was removed or replaced; select it again",
  });
  assert.equal(state().body, "Still here");
});

test("a send that settles after the Page changed leaves the next composer alone", async () => {
  const pending = deferred();
  const { composer, calls, state } = harness(() => pending.promise);
  composer.start(draft("old"));
  composer.change("Old Page");
  composer.submit();
  composer.reset();
  composer.start(draft("new"));
  composer.change("New Page");
  pending.resolve("thread-old");
  await settle();
  assert.deepEqual(state().state, { name: "open", key: "key-2" });
  assert.equal(state().body, "New Page");
  assert.equal(
    calls.some(([name]) => name === "flash"),
    false,
  );
});
