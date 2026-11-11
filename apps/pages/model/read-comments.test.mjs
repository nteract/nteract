import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyComment as applyCommentTo } from "./comments.mjs";
import { projectReadComments as projectReadCommentsOf } from "./read-comments.mjs";
import { currentForm } from "./richtext-test-support.mjs";
import { blockAddress, nodeAddresses } from "./addresses.mjs";

// One document plays both roles here: it holds the blocks anchors resolve
// against and the comments document's `threads`.
const applyComment = (d, input, identity) =>
  applyCommentTo(d, input, identity, undefined, { page: d, role: "editor" });
const projectReadComments = (doc, options) =>
  projectReadCommentsOf(doc, options, { threads: doc.threads });

const author = { principal: "account:one", displayName: "Human 🌊", driver: "Agent" };
function fixture() {
  let doc = A.change(
    A.from({
      page_id: "page",
      title: "Comments",
      blocks: {
        first: { markdown: "Before 🌊 passage after" },
        second: { markdown: "另一段文字。" },
      },
      threads: {},
    }),
    currentForm,
  );
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
    "createdAt",
    "id",
    "message_count",
    "messages",
    "node_id",
    "selectionContext",
    "state",
  ]);
  assert.equal(thread.node_id, blockAddress(doc, "first"));
  assert.equal(thread.message_count, 2);
  // The thread names its block, so the endpoints carry only their offsets.
  assert.deepEqual(thread.selectionContext, {
    status: "attached",
    start: { offsetUtf16: 8 },
    end: { offsetUtf16: 18 },
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
  const first = blockAddress(doc, "first");
  assert.deepEqual(
    projectReadComments(doc, { state: "open", node_id: first }).map((value) => value.id),
    [ids.first.thread_id],
  );
  assert.deepEqual(
    projectReadComments(doc, { node_id: first }).map((value) => value.id),
    [ids.first.thread_id, ids.resolved.thread_id],
  );
  assert.deepEqual(
    projectReadComments(doc, { node_id: blockAddress(doc, "second") }).map(
      (value) => value.node_id,
    ),
    [blockAddress(doc, "second")],
  );
  assert.deepEqual(
    projectReadComments(doc, { state: "resolved", thread_ids: [ids.first.thread_id] }),
    [],
  );
  // node_id takes a block's id. A node's id is the wrong kind; a block's
  // key or an id that names nothing is not a selector.
  const [nodeId] = nodeAddresses(doc, "first");
  assert.ok(nodeId);
  assert.throws(
    () => projectReadComments(doc, { node_id: nodeId }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "wrong_address_kind");
      assert.match(error.message, /list_page_comments takes a block's id/);
      return true;
    },
  );
  for (const node_id of ["first", "999999@abcdef"])
    assert.throws(() => projectReadComments(doc, { node_id }), {
      status: 400,
      code: "invalid_comment_selector",
    });
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
    schema: { features: ["comments-doc"] },
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
  const second = blockAddress(doc, "second");
  doc = A.change(doc, (draft) => {
    delete draft.blocks.second;
    A.splice(draft, ["blocks", "first", "richText"], 8, 10, "");
  });
  const [detachedBlock] = projectReadComments(doc, { thread_ids: [ids.second.thread_id] });
  assert.equal(detachedBlock.id, ids.second.thread_id);
  // A thread on a deleted block names no block.
  assert.equal(detachedBlock.node_id, null);
  assert.deepEqual(detachedBlock.selectionContext, { status: "detached" });
  assert.throws(() => projectReadComments(doc, { node_id: second }), {
    status: 400,
    code: "invalid_comment_selector",
  });
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
    { node_id: "" },
    { node_id: "   " },
    { node_id: "with\nline" },
    { node_id: "x".repeat(257) },
    { node_id: "🌊".repeat(65) },
    { node_id: "🌊".repeat(64) },
    { node_id: 3 },
    { block_id: blockAddress(doc, "first") },
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
  assert.deepEqual(A.getHeads(doc), before);
});

test("unknown requested threads fail explicitly before other filters can hide them", () => {
  const { doc, ids } = fixture();
  for (const options of [
    { thread_ids: ["missing"] },
    { thread_ids: [ids.first.thread_id, "missing"], state: "resolved" },
    { thread_ids: ["missing"], node_id: blockAddress(doc, "second") },
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
  const doc = { schema: { features: ["comments-doc"] }, blocks: { wanted: {} }, threads: comments };
  for (const options of [{ state: "open" }, { thread_ids: ["selected"] }])
    assert.deepEqual(
      projectReadComments(doc, options).map((value) => value.id),
      ["selected"],
    );
  assert.equal(anchorReads, 0);
});

test("message order is chronological and full quotes/bodies are never silently shortened", () => {
  const body = "完整🌊".repeat(1500),
    quote = "long 🌈 passage ".repeat(500).trimEnd();
  let doc = A.change(A.from({ blocks: { block: { markdown: quote } }, threads: {} }), currentForm);
  let id;
  doc = A.change(doc, (draft) => {
    const result = applyComment(draft, { block_id: "block", selected_text: quote, body }, author);
    id = result.thread_id;
    draft.threads[id].messages[result.message_id].createdAt = "2026-01-02T00:00:00Z";
    const earlier = applyComment(
      draft,
      { action: "reply", thread_id: id, body: "Earlier" },
      author,
    ).message_id;
    draft.threads[id].messages[earlier].createdAt = "2026-01-01T00:00:00Z";
  });
  const before = A.getHeads(doc),
    [thread] = projectReadComments(doc);
  assert.equal(thread.messages[0].body, "Earlier");
  assert.equal(thread.messages[1].body, body);
  assert.equal(thread.selectionContext.text, quote);
  assert.deepEqual(A.getHeads(doc), before);
});

test("a replica that hasn't synced yet projects no comments; legacy threads fail closed", async () => {
  const { projectPage } = await import("./page.mjs");
  const { threadsOf } = await import("./comments.mjs");
  // A browser replica opens empty and fills when the Page syncs.
  for (const empty of [A.init(), A.from({ blocks: {} })]) {
    assert.deepEqual(threadsOf(empty, undefined), {});
    assert.deepEqual(projectPage(empty, undefined).comments, []);
  }
  // A Page whose threads an earlier build kept in the Page document.
  const legacy = A.from({ blocks: {}, comments: { t1: { messages: {} } } });
  assert.throws(() => threadsOf(legacy, undefined), { code: "stored_form_unsupported" });
});

test("author.agent reads back as name and model; an author without it has no agent field", () => {
  let { doc, ids } = fixture();
  doc = A.change(doc, (draft) => {
    ids.named = applyCommentTo(
      draft,
      { action: "reply", thread_id: ids.first.thread_id, body: "From an agent" },
      author,
      undefined,
      { page: draft, role: "editor", agent: { name: "release agent", model: "gpt-5" } },
    );
    ids.modelOnly = applyCommentTo(
      draft,
      { action: "reply", thread_id: ids.first.thread_id, body: "Model only" },
      author,
      undefined,
      { page: draft, role: "editor", agent: { model: "m-1" } },
    );
  });
  doc = A.change(doc, (draft) => {
    // A key outside name and model never reaches a read.
    draft.threads[ids.first.thread_id].messages[ids.named.message_id].author.agent.id = "s-1";
  });
  const [thread] = projectReadComments(doc, { thread_ids: [ids.first.thread_id] });
  const byId = (id) => thread.messages.find((value) => value.id === id).author;
  assert.deepEqual(byId(ids.named.message_id), {
    ...author,
    agent: { name: "release agent", model: "gpt-5" },
  });
  assert.deepEqual(byId(ids.modelOnly.message_id), { ...author, agent: { model: "m-1" } });
  assert.deepEqual(byId(ids.first.message_id), author);
  assert.equal(Object.hasOwn(byId(ids.first.message_id), "agent"), false);
});
