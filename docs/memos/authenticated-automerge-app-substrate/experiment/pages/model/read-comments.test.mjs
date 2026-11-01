import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyComment as applyCommentTo } from "./comments.mjs";
import { projectReadComments as projectReadCommentsOf } from "./read-comments.mjs";

// One document plays both roles here: it holds the blocks anchors resolve
// against and the comments document's `threads`.
const applyComment = (d, input, identity) =>
  applyCommentTo(d, input, identity, undefined, { page: d, role: "editor" });
const projectReadComments = (doc, options) =>
  projectReadCommentsOf(doc, options, { threads: doc.threads });

const author = { principal: "account:one", displayName: "Human 🌊", driver: "Agent" };
function fixture() {
  let doc = A.from({
    page_id: "page",
    title: "Comments",
    blocks: {
      first: { markdown: "Before 🌊 passage after" },
      second: { markdown: "另一段文字。" },
    },
    threads: {},
  });
  const ids = {};
  doc = A.change(doc, (draft) => {
    ids.first = applyComment(
      draft,
      { block_id: "first", selected_text: "🌊 passage", body: "Discuss 🌈 this" },
      author,
    );
    ids.second = applyComment(draft, { block_id: "second", body: "回复" }, author);
    ids.resolved = applyComment(draft, { block_id: "first", body: "Done" }, author);
    applyComment(draft, { action: "resolve", thread_id: ids.resolved.thread_id }, author);
    ids.reply = applyComment(
      draft,
      { action: "reply", thread_id: ids.first.thread_id, body: "Follow up" },
      author,
    );
  });
  return { doc, ids };
}

test("compact threads preserve Unicode quotes/coordinates and allowlist document content", () => {
  let { doc, ids } = fixture();
  doc = A.change(doc, (draft) => {
    const thread = draft.threads[ids.first.thread_id];
    thread.extra = { private: "not output" };
    thread.status.extra = "not output";
    thread.messages[ids.first.message_id].extra = "not output";
    thread.messages[ids.first.message_id].author.verified = true;
    thread.messages[ids.first.message_id].author.extra = "not output";
  });
  const before = A.getHeads(doc);
  const [thread] = projectReadComments(doc, { thread_ids: [ids.first.thread_id] });
  assert.deepEqual(Object.keys(thread).sort(), [
    "block_id",
    "createdAt",
    "id",
    "message_count",
    "messages",
    "selectionContext",
    "state",
  ]);
  assert.equal(thread.block_id, "first");
  assert.equal(thread.message_count, 2);
  assert.deepEqual(thread.selectionContext, {
    status: "attached",
    start: { blockId: "first", offsetUtf16: 7 },
    end: { blockId: "first", offsetUtf16: 17 },
    text: "🌊 passage",
  });
  const message = thread.messages.find((value) => value.id === ids.first.message_id);
  assert.deepEqual(message.author, author);
  assert.equal(message.body, "Discuss 🌈 this");
  assert.equal(message.deletedAt, undefined);
  const serialized = JSON.stringify(thread);
  for (const hidden of ["relativePositionBase64", "textObjectId", "extra", "verified", '"target"'])
    assert.ok(!serialized.includes(hidden), hidden);
  assert.deepEqual(A.getHeads(doc), before);
});

test("state, block and thread selectors intersect without resolving unrelated threads", () => {
  const { doc, ids } = fixture();
  assert.equal(projectReadComments(doc).length, 3);
  assert.equal(projectReadComments(doc, { state: "open" }).length, 2);
  assert.deepEqual(
    projectReadComments(doc, { state: "resolved" }).map((value) => value.id),
    [ids.resolved.thread_id],
  );
  assert.deepEqual(
    projectReadComments(doc, { state: "open", block_id: "first" }).map((value) => value.id),
    [ids.first.thread_id],
  );
  assert.deepEqual(
    projectReadComments(doc, { state: "resolved", thread_ids: [ids.first.thread_id] }),
    [],
  );
  assert.deepEqual(projectReadComments(doc, { block_id: "missing" }), []);
});

test("summary reads count messages without reading their bodies", () => {
  const { doc } = fixture();
  const summaries = projectReadComments(doc, { include_messages: false });
  assert.ok(summaries.every((value) => !Object.hasOwn(value, "messages")));
  assert.equal(
    summaries.reduce((sum, value) => sum + value.message_count, 0),
    4,
  );
  assert.equal(
    summaries.find((value) => value.selectionContext)?.selectionContext.text,
    "🌊 passage",
  );
  const only = {
    blocks: { block: {} },
    threads: {
      comment: {
        target: { kind: "block", blockId: "block" },
        status: { value: "open" },
        messages: {
          message: {
            get body() {
              assert.fail("Summary must not read message body");
            },
          },
        },
      },
    },
  };
  assert.equal(projectReadComments(only, { include_messages: false })[0].message_count, 1);
});

test("deleted messages are body-free tombstones and still count toward the thread total", () => {
  let { doc, ids } = fixture();
  doc = A.change(doc, (draft) =>
    applyComment(
      draft,
      {
        action: "delete_message",
        thread_id: ids.first.thread_id,
        message_id: ids.first.message_id,
      },
      author,
    ),
  );
  const [thread] = projectReadComments(doc, { thread_ids: [ids.first.thread_id] });
  const deleted = thread.messages.find((value) => value.id === ids.first.message_id);
  assert.deepEqual(Object.keys(deleted).sort(), ["createdAt", "deletedAt", "id"]);
  assert.ok(deleted.deletedAt);
  assert.equal(thread.message_count, 2);
  assert.ok(!JSON.stringify(thread).includes("Discuss 🌈 this"));
  assert.equal(
    thread.messages.find((value) => value.id === ids.reply.message_id).body,
    "Follow up",
  );
});

test("deleted blocks remain addressable and removed selections report detached", () => {
  let { doc, ids } = fixture();
  doc = A.change(doc, (draft) => {
    delete draft.blocks.second;
    A.splice(draft, ["blocks", "first", "markdown"], 7, 10, "");
  });
  const [detachedBlock] = projectReadComments(doc, { block_id: "second" });
  assert.equal(detachedBlock.id, ids.second.thread_id);
  assert.equal(detachedBlock.block_id, "second");
  assert.deepEqual(detachedBlock.selectionContext, { status: "detached" });
  const [selection] = projectReadComments(doc, { thread_ids: [ids.first.thread_id] });
  assert.deepEqual(selection.selectionContext, { status: "detached" });
});

test("all selectors are strict and bounded, including UTF-8 identifier bytes", () => {
  const { doc } = fixture();
  const invalid = [
    null,
    [],
    new Date(),
    Object.create({ state: "open" }),
    { state: "closed" },
    { state: null },
    { state: false },
    { block_id: "" },
    { block_id: "   " },
    { block_id: "with\nline" },
    { block_id: "x".repeat(257) },
    { block_id: "🌊".repeat(65) },
    { block_id: 3 },
    { thread_ids: [] },
    { thread_ids: Array(1) },
    { thread_ids: "thread" },
    { thread_ids: ["x", "x"] },
    { thread_ids: [""] },
    { thread_ids: [null] },
    { thread_ids: ["🌊".repeat(65)] },
    { thread_ids: Array.from({ length: 101 }, (_, n) => String(n)) },
    { include_messages: "false" },
    { include_messages: null },
    { unknown: true },
  ];
  const before = A.getHeads(doc);
  for (const options of invalid)
    assert.throws(() => projectReadComments(doc, options), {
      status: 400,
      code: "invalid_comment_selector",
    });
  assert.deepEqual(projectReadComments(doc, { block_id: "🌊".repeat(64) }), []);
  assert.deepEqual(A.getHeads(doc), before);
});

test("unknown requested threads fail explicitly before other filters can hide them", () => {
  const { doc, ids } = fixture();
  for (const options of [
    { thread_ids: ["missing"] },
    { thread_ids: [ids.first.thread_id, "missing"], state: "resolved" },
    { thread_ids: ["missing"], block_id: "missing" },
    { thread_ids: ["__proto__"] },
  ])
    assert.throws(() => projectReadComments(doc, options), {
      status: 404,
      code: "comment_not_found",
    });
});

test("filters run before expensive anchor and message projection on many unrelated threads", () => {
  let anchorReads = 0;
  const comments = Object.fromEntries(
    Array.from({ length: 500 }, (_, n) => [
      `thread-${n}`,
      {
        status: { value: "resolved" },
        target: {
          kind: "selection",
          anchor: { blockId: "other" },
          get head() {
            anchorReads++;
            assert.fail("Excluded thread anchor was resolved");
          },
        },
        get messages() {
          assert.fail("Excluded messages were projected");
        },
      },
    ]),
  );
  comments.selected = {
    status: { value: "open" },
    target: { kind: "block", blockId: "wanted" },
    messages: {},
  };
  const doc = { blocks: { wanted: {} }, threads: comments };
  for (const options of [{ state: "open" }, { block_id: "wanted" }, { thread_ids: ["selected"] }])
    assert.deepEqual(
      projectReadComments(doc, options).map((value) => value.id),
      ["selected"],
    );
  assert.equal(anchorReads, 0);
});

test("message order is chronological and full quotes/bodies are never silently shortened", () => {
  const body = "完整🌊".repeat(1500),
    quote = "long 🌈 passage ".repeat(500);
  let doc = A.from({ blocks: { block: { markdown: quote } }, threads: {} });
  let id;
  doc = A.change(doc, (draft) => {
    const result = applyComment(draft, { block_id: "block", selected_text: quote, body }, author);
    id = result.thread_id;
    draft.threads[id].messages[result.message_id].createdAt = "2026-01-02T00:00:00Z";
    draft.threads[id].messages.earlier = {
      body: "Earlier",
      author,
      createdAt: "2026-01-01T00:00:00Z",
      deletedAt: null,
    };
  });
  const before = A.getHeads(doc),
    [thread] = projectReadComments(doc);
  assert.equal(thread.messages[0].body, "Earlier");
  assert.equal(thread.messages[1].body, body);
  assert.equal(thread.selectionContext.text, quote);
  assert.deepEqual(A.getHeads(doc), before);
});
