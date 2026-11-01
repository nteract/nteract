import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { fixture } from "./trash-fixture.mjs";

// The comment tool contract against the Page host: comments live in their own
// document, so a comment write never moves the Page's heads.

let keys = 0;
const key = () => `contract-${String(++keys).padStart(4, "0")}-${crypto.randomUUID()}`;
const comment = (f, who, args) =>
  f.tool(who, "manage_page_comment", { idempotency_key: key(), ...args });

test("comment writes never change the Page's heads", async (t) => {
  const f = await fixture(t);
  const heads = f.heads();
  const added = await comment(f, "owner", { action: "add", block_id: f.blockId, body: "Block" });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  // No base_heads: a block comment doesn't read Page text.
  const threadId = added.body.result.thread_id;
  const steps = [
    { action: "reply", thread_id: threadId, body: "Reply" },
    { action: "resolve", thread_id: threadId },
    { action: "reopen", thread_ids: [threadId] },
    { action: "edit", thread_id: threadId, message_id: added.body.result.message_id, body: "Ed" },
    { action: "delete_message", thread_id: threadId, message_id: added.body.result.message_id },
  ];
  let commentHeads = added.body.comment_heads;
  for (const step of steps) {
    const result = await comment(f, "owner", step);
    assert.equal(result.status, 200, `${step.action}: ${JSON.stringify(result.body)}`);
    assert.deepEqual(result.body.heads, heads, `${step.action} keeps the Page's heads`);
    assert.notDeepEqual(result.body.comment_heads, commentHeads, `${step.action} moves comments`);
    commentHeads = result.body.comment_heads;
  }
  assert.deepEqual(f.heads(), heads);
  assert.deepEqual(f.commentHeads(), commentHeads);
  // An edit from the revision read before all of that still applies exactly.
  const edit = await f.tool("owner", "edit_page", {
    idempotency_key: key(),
    base_heads: heads,
    operations: [{ op: "set_title", title: "Still current" }],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
});

test("a passage comment still resolves at the base_heads the agent read", async (t) => {
  const f = await fixture(t);
  const read = await f.tool("owner", "read_page", { comments: "none" });
  const missing = await comment(f, "owner", {
    action: "add",
    block_id: f.blockId,
    selected_text: "Friday",
    body: "Which?",
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "invalid_edit_selector");
  const added = await comment(f, "owner", {
    action: "add",
    block_id: f.blockId,
    selected_text: "Friday",
    body: "Which?",
    base_heads: read.body.heads,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body.heads, read.body.heads);
});

test("reads carry comment_heads, and read_page_changes lists comment changes from them", async (t) => {
  const f = await fixture(t);
  const read = await f.tool("owner", "read_page", { comments: "summary" });
  assert.deepEqual(read.body.comment_heads, f.commentHeads());
  const listed = await f.tool("owner", "list_page_comments", {});
  assert.deepEqual(listed.body.comment_heads, f.commentHeads());
  const [existing] = listed.body.comments;
  const resolved = await comment(f, "owner", { action: "resolve", thread_id: existing.id });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const changes = await f.tool("owner", "read_page_changes", {
    since_heads: read.body.heads,
    since_comment_heads: read.body.comment_heads,
  });
  assert.equal(changes.status, 200, JSON.stringify(changes.body));
  assert.deepEqual(changes.body.changes, [], "no content changed");
  assert.deepEqual(changes.body.heads, read.body.heads);
  assert.deepEqual(changes.body.comment_heads, f.commentHeads());
  assert.equal(changes.body.comments.length, 1);
  assert.equal(changes.body.comments[0].thread_id, existing.id);
  assert.equal(changes.body.comments[0].state, "resolved");
  // Without a comments baseline: a snapshot of every current thread.
  const unknown = await f.tool("owner", "read_page_changes", { since_heads: read.body.heads });
  assert.equal(unknown.body.comments_snapshot, true);
  assert.equal(unknown.body.comments.length, listed.body.comments.length);
});

test("a commenter comments but can't edit, and touches only its own messages", async (t) => {
  const f = await fixture(t, { memberRole: "commenter" });
  const heads = f.heads();
  const [ownerThread] = Object.keys(f.commentsDoc().threads);
  const ownersMessage = Object.keys(f.commentsDoc().threads[ownerThread].messages)[0];
  // The fixture's comment is the member's own; the owner adds one more.
  const owner = await comment(f, "owner", { action: "add", block_id: f.blockId, body: "Owner" });
  const ownerMessage = owner.body.result.message_id;
  const added = await comment(f, "member", { action: "add", block_id: f.blockId, body: "Mine" });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const reply = await comment(f, "member", {
    action: "reply",
    thread_id: owner.body.result.thread_id,
    body: "On yours",
  });
  assert.equal(reply.status, 200);
  // Resolve and reopen stay open to any commenter.
  assert.equal(
    (await comment(f, "member", { action: "resolve", thread_id: owner.body.result.thread_id }))
      .status,
    200,
  );
  for (const forbidden of [
    { action: "edit", message_id: ownerMessage, body: "Rewritten" },
    { action: "delete_message", message_id: ownerMessage },
  ]) {
    const refused = await comment(f, "member", {
      thread_id: owner.body.result.thread_id,
      ...forbidden,
    });
    assert.equal(refused.status, 403, `${forbidden.action}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, "comment_not_author");
  }
  const deleteThread = await comment(f, "member", {
    action: "delete_thread",
    thread_id: owner.body.result.thread_id,
  });
  assert.ok([400, 403].includes(deleteThread.status));
  // Its own message: edit and delete pass.
  assert.equal(
    (
      await comment(f, "member", {
        action: "edit",
        thread_id: ownerThread,
        message_id: ownersMessage,
        body: "Edited",
      })
    ).status,
    200,
  );
  // Editing the Page is refused.
  const edit = await f.tool("member", "edit_page", {
    idempotency_key: key(),
    base_heads: heads,
    operations: [{ op: "set_title", title: "Nope" }],
  });
  assert.equal(edit.status, 403);
  assert.deepEqual(f.heads(), heads);
});

test("a viewer can read comments but not write them", async (t) => {
  const f = await fixture(t, { memberRole: "viewer" });
  const read = await f.tool("member", "list_page_comments", {});
  assert.equal(read.status, 200);
  const write = await comment(f, "member", { action: "add", block_id: f.blockId, body: "No" });
  assert.equal(write.status, 403);
});

test("uploads need edit access: a commenter comments in text", async (t) => {
  for (const [role, status] of [
    ["editor", 200],
    ["commenter", 403],
    ["viewer", 403],
  ]) {
    const f = await fixture(t, { memberRole: role });
    const response = await f.pageCall("member", "/internal/assets/authorize", {
      page_id: f.page.metadata.pageId,
      write: true,
    });
    assert.equal(response.status, status, `${role}: ${JSON.stringify(response.body)}`);
  }
});

test("the purge preview counts the comments document's threads", async (t) => {
  const f = await fixture(t);
  await comment(f, "owner", { action: "add", block_id: f.blockId, body: "Two" });
  assert.equal(Object.keys(f.commentsDoc().threads).length, 2);
  assert.ok(A.getHeads(f.commentsDoc()).length > 0);
});

test("a refused key stops writing comments at once; its connection alone closes", async (t) => {
  const f = await fixture(t);
  const editorKey = "ab".repeat(32),
    otherKey = "cd".repeat(32);
  await f.bind(editorKey, f.member);
  await f.bind(otherKey, f.owner);
  await f.page.policy.put(editorKey, editorKey, "c".repeat(32));
  const persisted = f.page.policy.refuseComments(editorKey);
  // In memory at once, before the binding write lands.
  await assert.rejects(f.page.policy.put(editorKey, editorKey, "c".repeat(32)));
  await persisted;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(f.disconnected, [editorKey], "only the refused key's connection closed");
  // Reconnecting with the same key: still an editor of the Page, never again
  // a comment author.
  await f.bind(editorKey, f.member);
  await assert.rejects(f.page.policy.put(editorKey, editorKey, "c".repeat(32)), /read-only|author/);
  // That attempt closed its own connection too; a fresh one still edits.
  await f.bind(editorKey, f.member);
  await f.page.policy.put(editorKey, editorKey, f.page.metadata.tree);
  // The owner's key keeps writing both documents.
  await f.page.policy.put(otherKey, otherKey, "c".repeat(32));
  await f.page.policy.put(otherKey, otherKey, f.page.metadata.tree);
  // Durable: a restart keeps the block.
  const restarted = await f.restart();
  assert.equal(restarted.policy.bindings.get(editorKey).commentsBlocked, true);
});

test("a comment receipt's heads are the Page revision it read, stable across retries", async (t) => {
  const f = await fixture(t);
  const before = f.heads();
  // A browser edit lands while the comment is being journaled.
  let typed = false;
  f.hooks.flush = () => {
    if (typed) return;
    typed = true;
    f.edit("typed while commenting");
  };
  const args = {
    idempotency_key: key(),
    action: "add",
    block_id: f.blockId,
    body: "Concurrent",
  };
  const first = await f.tool("owner", "manage_page_comment", args);
  f.hooks.flush = undefined;
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(typed);
  assert.deepEqual(first.body.heads, before, "the baseline, not the live Page");
  assert.notDeepEqual(f.heads(), before);
  // Polling from the receipt still returns the browser's edit.
  const changes = await f.tool("owner", "read_page_changes", { since_heads: first.body.heads });
  assert.equal(changes.status, 200, JSON.stringify(changes.body));
  assert.equal(changes.body.title_changed, true);
  assert.equal(changes.body.title, "typed while commenting");
  // An exact retry returns the recorded receipt, after yet another edit.
  f.edit(" and more");
  const retry = await f.tool("owner", "manage_page_comment", args);
  assert.deepEqual(retry.body, first.body);
});

test("receipts journaled before the comments document keep their Page heads", async (t) => {
  const f = await fixture(t);
  const args = { idempotency_key: key(), action: "add", block_id: f.blockId, body: "Old build" };
  const fresh = await f.tool("owner", "manage_page_comment", args);
  assert.equal(fresh.status, 200);
  // Rewrite that entry as a build before the comments document stored it:
  // journaled on the Page, its receipt's heads Page heads.
  const path = `host/operation/${args.idempotency_key}`;
  const entry = await f.storage.get(path);
  const pageHeads = f.heads();
  const legacy = {
    fingerprint: entry.fingerprint,
    pending: false,
    receipt: { page_id: entry.receipt.page_id, heads: pageHeads, result: entry.receipt.result },
  };
  await f.storage.put(path, legacy);
  const retried = await f.tool("owner", "manage_page_comment", args);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.legacy_receipt, true);
  assert.deepEqual(retried.body.heads, pageHeads, "Page heads stay labeled as Page heads");
  assert.equal(retried.body.comment_heads, undefined, "never relabeled as comment heads");
  // A legacy entry still pending never replays into the comments document.
  await f.storage.put(path, { ...legacy, pending: true, changes: [] });
  const commentHeads = f.commentHeads();
  const pending = await f.tool("owner", "manage_page_comment", args);
  assert.equal(pending.status, 409, JSON.stringify(pending.body));
  assert.equal(pending.body.code, "operation_pending");
  assert.deepEqual(f.commentHeads(), commentHeads);
});
