import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { fixture as baseFixture, pageId } from "./trash-fixture.mjs";
async function fixture(t) {
  const f = await baseFixture(t);
  f.env.PAGES_COMMENT_ASSERTIONS = "enabled";
  return f;
}
import { mcpSessionId } from "./usage.mjs";
import { attribution, messageRuns } from "../viewer/comment-thread-display.mjs";

const key = () => crypto.randomUUID();

test("prepare refuses new attributed intents, enable shares with readers, disable preserves pending recovery and replay", async (t) => {
  const f = await fixture(t);
  delete f.env.PAGES_COMMENT_ASSERTIONS;
  const args = { action: "add", block_id: f.blockId, body: "Phased", idempotency_key: key() };
  const before = f.commentHeads();
  const unavailable = await call(f, "manage_page_comment", args, {
    name: "Shared",
    model: "model",
  });
  assert.equal(unavailable.code, "comment_assertions_unavailable");
  assert.deepEqual(f.commentHeads(), before);
  assert.ok(![...f.storage.durable().keys()].some((entry) => entry.includes(args.idempotency_key)));
  const legacy = await call(f, "manage_page_comment", { ...args, idempotency_key: key() });
  assert.ok(legacy.result?.message_id);
  f.env.PAGES_COMMENT_ASSERTIONS = "enabled";
  let flushes = 0;
  f.hooks.flush = () => {
    if (++flushes === 2) throw Error("after journal before flush");
  };
  const failed = await call(f, "manage_page_comment", args, { name: "Shared", model: "model" });
  assert.ok(failed.error);
  delete f.hooks.flush;
  delete f.env.PAGES_COMMENT_ASSERTIONS;
  await f.crashRestart();
  const recovered = await call(f, "manage_page_comment", args, { name: "Changed" });
  assert.ok(recovered.result?.message_id, JSON.stringify(recovered));
  const read = await call(f, "list_page_comments", {}, undefined, { who: "member" });
  const msg = read.comments
    .find((item) => item.id === recovered.result.thread_id)
    .messages.find((item) => item.id === recovered.result.message_id);
  assert.deepEqual(msg.author.clientAssertions, { version: 1, name: "Shared", model: "model" });
  assert.deepEqual(await call(f, "manage_page_comment", args, { model: "Another" }), recovered);
  assert.equal(
    (await call(f, "manage_page_comment", { ...args, idempotency_key: key() }, { name: "Next" }))
      .code,
    "comment_assertions_unavailable",
  );
});
async function call(f, operation, args, agent, { who = "owner", http = false, headers = {} } = {}) {
  const response = await worker.fetch(
    new Request(`https://pages.invalid/${http ? "api/tools" : "mcp"}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.tokens[who]}`,
        "content-type": "application/json",
        "x-pages-driver": "Kilo",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(
        http
          ? { operation, arguments: { page_id: pageId, ...args } }
          : {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: operation,
                arguments: { page_id: pageId, ...args },
                ...(agent !== undefined && { _meta: { agent } }),
              },
            },
      ),
    }),
    { ...f.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid" },
  );
  const body = await response.json();
  return http ? body : (body.result?.structuredContent ?? body);
}

test("per-field MCP origin never opts private HTTP or session telemetry into another reader's comment", async (t) => {
  const f = await fixture(t);
  const initial = await call(f, "read_page", { comments: "all" });
  const telemetry = {
    "x-pages-client": "PRIVATE-HARNESS",
    "x-pages-model": "PRIVATE-MODEL",
    "mcp-session-id": mcpSessionId({ name: "PRIVATE-SESSION-HARNESS" }),
  };
  const cases = [
    [undefined, { headers: telemetry }, undefined],
    [
      undefined,
      {
        http: true,
        headers: {
          ...telemetry,
          "x-pages-agent": "PRIVATE-LEGACY-NAME",
          "x-pages-internal-request-agent": encodeURIComponent(JSON.stringify({ name: "FORGED" })),
        },
      },
      undefined,
    ],
    [{ name: "Explicit name" }, { headers: telemetry }, { version: 1, name: "Explicit name" }],
    [
      { model: "Explicit model" },
      { headers: { "x-pages-client": "PRIVATE-HARNESS", "x-pages-agent": "PRIVATE-LEGACY-NAME" } },
      { version: 1, model: "Explicit model" },
    ],
  ];
  for (const [agent, options, expected] of cases) {
    const args = {
      action: "add",
      block_id: f.blockId,
      body: "Publication boundary",
      idempotency_key: key(),
    };
    const result = await call(f, "manage_page_comment", args, agent, options);
    assert.ok(result.result?.message_id, JSON.stringify(result));
    const { thread_id, message_id } = result.result;
    for (const operation of ["read_page", "list_page_comments", "read_page_changes"]) {
      const read = await call(
        f,
        operation,
        operation === "read_page_changes"
          ? { since_heads: initial.heads, since_comment_heads: initial.comment_heads }
          : operation === "read_page"
            ? { comments: "all" }
            : {},
        undefined,
        { who: "member" },
      );
      assert.ok(read.comments, JSON.stringify(read));
      assert.ok(!JSON.stringify(read.comments).includes("PRIVATE-"));
      assert.ok(!JSON.stringify(read.comments).includes("FORGED"));
      if (operation !== "read_page_changes") {
        const message = read.comments
          .find((thread) => thread.id === thread_id)
          .messages.find((message) => message.id === message_id);
        assert.deepEqual(message.author.clientAssertions, expected);
      }
    }
    const replay = await call(f, "manage_page_comment", args, { name: "Changed" });
    assert.deepEqual(replay, result);
    assert.deepEqual(
      f.commentsDoc().threads[thread_id].messages[message_id].author.clientAssertions,
      expected,
    );
  }
  const before = f.commentHeads();
  const conflict = await call(
    f,
    "manage_page_comment",
    { action: "add", block_id: f.blockId, body: "Conflict", idempotency_key: key() },
    { model: "Explicit" },
    { headers: telemetry },
  );
  assert.equal(conflict.code, "invalid_arguments");
  assert.deepEqual(f.commentHeads(), before);
});

test("actual MCP and HTTP comment creation survive restart, read/list/delta and UI projection", async (t) => {
  const f = await fixture(t);
  const initial = await call(f, "read_page", { comments: "all" });
  const headers = { "mcp-session-id": mcpSessionId({ name: "Harness", version: "1" }) };
  const args = { action: "add", block_id: f.blockId, body: "Original", idempotency_key: key() };
  const added = await call(
    f,
    "manage_page_comment",
    args,
    { name: "Release", id: "PRIVATE-ID", model: "model-a" },
    { headers },
  );
  assert.ok(added.result?.message_id, JSON.stringify(added));
  const { thread_id, message_id } = added.result;
  const labels = { version: 1, name: "Release", model: "model-a" };
  assert.deepEqual(f.commentsDoc().threads[thread_id].author.clientAssertions, labels);
  assert.deepEqual(
    f.commentsDoc().threads[thread_id].messages[message_id].author.clientAssertions,
    labels,
  );
  assert.ok(!JSON.stringify(f.commentsDoc()).includes("PRIVATE-ID"));
  assert.deepEqual(f.heads(), initial.heads);
  const firstHeads = f.commentHeads();
  const replay = await call(
    f,
    "manage_page_comment",
    args,
    { name: "Different", model: "model-b" },
    { headers },
  );
  assert.deepEqual(replay, added);
  assert.deepEqual(f.commentHeads(), firstHeads);
  const replied = await call(
    f,
    "manage_page_comment",
    { action: "reply", thread_id, body: "Reply", idempotency_key: key() },
    { name: "Release", model: "model-b" },
    { headers },
  );
  assert.ok(replied.result?.message_id, JSON.stringify(replied));
  const httpReply = await call(
    f,
    "manage_page_comment",
    { action: "reply", thread_id, body: "HTTP", idempotency_key: key() },
    undefined,
    {
      http: true,
      headers: {
        "x-pages-agent": "HTTP Agent",
        "x-pages-client": "HTTP/1",
        "x-pages-model": "model-c",
      },
    },
  );
  assert.ok(httpReply.result?.message_id, JSON.stringify(httpReply));
  await f.crashRestart();
  for (const operation of ["read_page", "list_page_comments"]) {
    const read = await call(f, operation, operation === "read_page" ? { comments: "all" } : {});
    const thread = read.comments.find((thread) => thread.id === thread_id);
    const message = thread.messages.find((message) => message.id === message_id);
    assert.deepEqual(message.author.clientAssertions, labels);
    assert.equal(message.author.principal, f.owner);
    assert.match(attribution(message.author).label, /Release.*client-supplied.*model-a/);
    assert.equal(
      messageRuns(thread.messages).length,
      3,
      "model switches split visible author runs",
    );
    assert.equal(JSON.stringify(read).includes("PRIVATE-ID"), false);
  }
  const delta = await call(f, "read_page_changes", {
    since_heads: initial.heads,
    since_comment_heads: initial.comment_heads,
    comments: "all",
  });
  assert.ok(JSON.stringify(delta.comments).includes('"clientAssertions"'));
  assert.ok(JSON.stringify(delta.comments).includes('"model-a"'));
  assert.equal(
    delta.attribution,
    "unavailable",
    "comment snapshots are not edit-history attribution",
  );
  const legacy =
    f.commentsDoc().threads[Object.keys(f.commentsDoc().threads).find((id) => id !== thread_id)];
  assert.equal(legacy.author.clientAssertions, undefined);
  for (const action of ["edit", "resolve", "delete_message"]) {
    const changed = await call(
      f,
      "manage_page_comment",
      {
        action,
        thread_id,
        message_id,
        ...(action === "edit" && { body: "Edited" }),
        idempotency_key: key(),
      },
      { name: "Later", model: "other" },
    );
    assert.equal(changed.code, undefined, JSON.stringify(changed));
    assert.deepEqual(
      f.commentsDoc().threads[thread_id].messages[message_id].author.clientAssertions,
      labels,
    );
  }
  const beforeNoOp = f.commentHeads();
  await call(
    f,
    "manage_page_comment",
    { action: "resolve", thread_ids: [thread_id], idempotency_key: key() },
    { name: "No-op" },
  );
  assert.deepEqual(f.commentHeads(), beforeNoOp);
  const deleted = (await call(f, "list_page_comments", { state: "all" })).comments
    .find((thread) => thread.id === thread_id)
    .messages.find((message) => message.id === message_id);
  assert.equal(deleted.author, undefined, "deleted message projection exposes no attribution");
});

test("malformed metadata fails before journaling and claimed labels never grant another principal's rights", async (t) => {
  const f = await fixture(t);
  const before = f.commentHeads();
  for (const agent of [
    { principal: f.owner },
    { assurance: "verified" },
    { name: "x".repeat(81) },
  ]) {
    const result = await call(
      f,
      "manage_page_comment",
      { action: "add", block_id: f.blockId, body: "Bad", idempotency_key: key() },
      agent,
    );
    assert.equal(result.code, "invalid_arguments");
    assert.deepEqual(f.commentHeads(), before);
  }
  const created = await call(
    f,
    "manage_page_comment",
    { action: "add", block_id: f.blockId, body: "Mine", idempotency_key: key() },
    { name: "Owner" },
  );
  const result = await call(
    f,
    "manage_page_comment",
    { action: "edit", ...created.result, body: "Spoof", idempotency_key: key() },
    { name: "Owner" },
    { who: "member" },
  );
  assert.equal(result.code, "comment_not_author");
});

test("crash after the durable intent preserves original body and assertions before receipt replay", async (t) => {
  const f = await fixture(t);
  const args = { action: "add", block_id: f.blockId, body: "Journaled", idempotency_key: key() };
  let flushes = 0;
  f.hooks.flush = () => {
    if (++flushes === 2) throw Error("cut after intent before document flush");
  };
  const failed = await call(f, "manage_page_comment", args, { name: "Original", model: "model-a" });
  assert.ok(failed.error, JSON.stringify(failed));
  const intent = [...f.storage.durable()].find(
    ([key]) => key === `host/operation/${args.idempotency_key}`,
  )?.[1];
  assert.equal(intent.pending, true);
  assert.equal(intent.changes.length, 1, "body and assertions share one native change");
  delete f.hooks.flush;
  await f.crashRestart();
  const retried = await call(f, "manage_page_comment", args, { name: "Retry", model: "model-b" });
  assert.ok(retried.result?.message_id, JSON.stringify(retried));
  const { thread_id, message_id } = retried.result;
  assert.deepEqual(
    f.commentsDoc().threads[thread_id].messages[message_id].author.clientAssertions,
    { version: 1, name: "Original", model: "model-a" },
  );
  assert.equal(Object.keys(f.commentsDoc().threads).length, 2);
});
