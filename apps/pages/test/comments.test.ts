import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as A from "@automerge/automerge/slim";
import { PagesWorkspace, type Storage } from "../src/workspace.ts";
import { prepareComment, projectComments, validateComments } from "../src/comments.ts";
import { createPage, type Page } from "../src/document.ts";
import { actorPrefix, newActor, receiveAdmitted, validatePage } from "../src/sync.ts";
await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);
const principal = '["issuer","alice"]';
class Memory implements Storage {
  values = new Map<string, unknown>();
  fail = false;
  async get<T>(k: string) {
    return structuredClone(this.values.get(k)) as T | undefined;
  }
  async put(values: Record<string, unknown>) {
    if (this.fail) throw Error("storage failed");
    for (const [k, v] of Object.entries(values)) this.values.set(k, structuredClone(v));
  }
}
test("Pages-shaped comments support replies, resolution, author edits, tombstones, and safe retries", async () => {
  const storage = new Memory(),
    room = new PagesWorkspace({ storage });
  const created = (await room.call(principal, {
    operation: "create_page",
    arguments: { idempotency_key: "comments-fixture", markdown: "A café 🌍 passage." },
  })) as any;
  const page_id = created.page_id,
    block_id = created.content.blocks[0].id;
  const call = (operation: string, args: Record<string, unknown>) =>
    room.call(principal, { operation, arguments: { page_id, ...args } }) as Promise<any>;
  const add = {
    action: "add",
    block_id,
    selected_text: "café 🌍",
    body: "Check this passage",
    base_sequence: 1,
    idempotency_key: "add-comment-1",
  };
  const first = await call("manage_page_comment", add);
  assert.equal(first.thread.selectionContext.text, "café 🌍");
  assert.equal(first.thread.author.id, await actorPrefix(principal));
  assert.deepEqual(await call("manage_page_comment", add), first);
  const second = await call("reply_page_comment", {
    thread_id: first.thread_id,
    body: "Replied",
    base_sequence: 2,
    idempotency_key: "reply-comment-1",
  });
  assert.equal(second.thread.messages.length, 2);
  const resolved = await call("manage_page_comment", {
    action: "resolve",
    thread_id: first.thread_id,
    base_sequence: 3,
    idempotency_key: "resolve-comment-1",
  });
  assert.equal(resolved.thread.state, "resolved");
  assert.equal(resolved.thread.resolvedBy.id, first.thread.author.id);
  assert.equal((await call("list_page_comments", { state: "open" })).threads.length, 0);
  await call("manage_page_comment", {
    action: "reopen",
    thread_id: first.thread_id,
    base_sequence: 4,
    idempotency_key: "reopen-comment-1",
  });
  await call("manage_page_comment", {
    action: "edit",
    thread_id: first.thread_id,
    message_id: second.message_id,
    body: "Edited reply",
    base_sequence: 5,
    idempotency_key: "edit-comment-1",
  });
  const deleted = await call("manage_page_comment", {
    action: "delete_message",
    thread_id: first.thread_id,
    message_id: second.message_id,
    base_sequence: 6,
    idempotency_key: "delete-comment-1",
  });
  assert.equal(deleted.thread.messages.find((m: any) => m.id === second.message_id).body, "");
  assert.ok(deleted.thread.messages.find((m: any) => m.id === second.message_id).deletedAt);
  const restarted = new PagesWorkspace({ storage });
  assert.deepEqual(
    await restarted.call(principal, { operation: "list_page_comments", arguments: { page_id } }),
    await call("list_page_comments", {}),
  );
  await assert.rejects(
    call("reply_page_comment", {
      thread_id: first.thread_id,
      body: "stale",
      base_sequence: 1,
      idempotency_key: "stale-comment-1",
    }),
    /Page changed/,
  );
  storage.fail = true;
  await assert.rejects(
    call("reply_page_comment", {
      thread_id: first.thread_id,
      body: "unsaved",
      base_sequence: 7,
      idempotency_key: "failed-comment-1",
    }),
    /storage failed/,
  );
  assert.equal((await call("list_page_comments", {})).threads[0].messages.length, 2);
});

test("comment ranges follow text edits and detach when their selected content or block disappears", async () => {
  const prefix = await actorPrefix(principal);
  let doc = createPage(
    "page_" + "a".repeat(32),
    "Title",
    ["before target after"],
    newActor(prefix),
  );
  const id = doc.order[0],
    op = prepareComment(doc, {
      action: "add",
      block_id: id,
      selected_text: "target",
      body: "Discuss",
    });
  doc = A.change(doc, op.apply);
  validatePage(doc, doc.page_id);
  doc = A.change(doc, (d) => A.splice(d, ["blocks", id, "markdown"], 0, 0, "prefix "));
  assert.equal(projectComments(doc)[0].selectionContext?.status, "attached");
  assert.equal((projectComments(doc)[0].selectionContext as any).text, "target");
  const start = doc.blocks[id].markdown.indexOf("target");
  doc = A.change(doc, (d) => A.splice(d, ["blocks", id, "markdown"], start, 6, ""));
  assert.equal(projectComments(doc)[0].selectionContext?.status, "detached");
  doc = A.change(doc, (d) => {
    d.order = [];
    delete d.blocks[id];
  });
  assert.equal(projectComments(doc)[0].detached, true);
  assert.equal(projectComments(doc)[0].messages[0].body, "Discuss");
  A.free(doc);
});

test("concurrent new threads and replies converge and raw actor forgery fails", async () => {
  const prefix = await actorPrefix(principal);
  let base = createPage("page_" + "b".repeat(32), "Title", ["source"], newActor(prefix));
  const block_id = base.order[0];
  let a = A.clone(base, { actor: newActor(prefix) }),
    b = A.clone(base, { actor: newActor(prefix) });
  a = A.change(a, prepareComment(a, { action: "add", block_id, body: "A" }).apply);
  b = A.change(b, prepareComment(b, { action: "add", block_id, body: "B" }).apply);
  a = A.merge(a, b);
  validateComments(a, base, prefix);
  assert.equal(projectComments(a).length, 2);
  const thread_id = projectComments(a)[0].id;
  b = A.clone(a, { actor: newActor(prefix) });
  a = A.change(a, prepareComment(a, { action: "reply", thread_id, body: "Left" }).apply);
  b = A.change(b, prepareComment(b, { action: "reply", thread_id, body: "Right" }).apply);
  a = A.merge(a, b);
  assert.equal(projectComments(a).find((t) => t.id === thread_id)!.messages.length, 3);
  const other = await actorPrefix("bob");
  let forged = A.clone(a, { actor: newActor(other) });
  forged = A.change(
    forged,
    prepareComment(forged, {
      action: "edit",
      thread_id,
      message_id: projectComments(a)[0].messages[0].id,
      body: "forged",
    }).apply,
  );
  assert.throws(() => validateComments(forged, a, other), /Only the author/);
  A.free(forged);
  A.free(b);
  A.free(a);
  A.free(base);
});

test("old Pages gain one shared comments root without changing content identity", async () => {
  const storage = new Memory(),
    room = new PagesWorkspace({ storage });
  const created = (await room.call(principal, {
    operation: "create_page",
    arguments: { idempotency_key: "old-page-fixture", markdown: "Keep my history" },
  })) as any;
  const saved = await storage.get<any>(created.page_id);
  let old = A.load<Page>(saved.bytes);
  old = A.change(old, (d) => {
    delete d.comments;
  });
  const blockId = old.order[0],
    objectId = A.getObjectId(old.blocks[blockId]);
  saved.bytes = A.save(old);
  await storage.put({ [created.page_id]: saved });
  const read = (await room.call(principal, {
    operation: "list_page_comments",
    arguments: { page_id: created.page_id },
  })) as any;
  assert.equal(read.sequence, 2);
  assert.deepEqual(read.threads, []);
  const migrated = A.load<Page>((await storage.get<any>(created.page_id)).bytes);
  assert.equal(A.getObjectId(migrated.blocks[blockId]), objectId);
  assert.equal(migrated.blocks[blockId].markdown, "Keep my history");
  assert.equal(
    (
      (await room.call(principal, {
        operation: "list_page_comments",
        arguments: { page_id: created.page_id },
      })) as any
    ).sequence,
    2,
  );
  A.free(migrated);
  A.free(old);
});

test("raw comments sync enforces ownership even with an otherwise admitted actor", async () => {
  const alice = await actorPrefix(principal),
    bob = await actorPrefix("bob");
  let server = createPage("page_" + "c".repeat(32), "Title", ["body"], newActor(alice));
  server = A.change(
    server,
    prepareComment(server, { action: "add", block_id: server.order[0], body: "Alice" }).apply,
  );
  let client = A.clone(server, { actor: newActor(bob) }),
    local = A.initSyncState(),
    remote = A.initSyncState();
  const thread = projectComments(server)[0];
  client = A.change(
    client,
    prepareComment(client, {
      action: "edit",
      thread_id: thread.id,
      message_id: thread.messages[0].id,
      body: "Impersonated",
    }).apply,
  );
  let rejected = false;
  for (let i = 0; i < 10 && !rejected; i++) {
    const [next, message] = A.generateSyncMessage(client, local);
    local = next;
    if (message)
      try {
        const received = receiveAdmitted(server, remote, message, bob);
        server = received.doc;
        remote = received.state;
      } catch (e) {
        assert.match(String(e), /Only the author/);
        rejected = true;
        break;
      }
    const [s, m] = A.generateSyncMessage(server, remote);
    remote = s;
    if (m) [client, local] = A.receiveSyncMessage(client, local, m);
  }
  assert.equal(rejected, true);
  assert.equal(projectComments(server)[0].messages[0].body, "Alice");
  A.free(client);
  A.free(server);
});

test("browser comment changes preserve projected authors through content edits", async () => {
  const { PageReplica } = await import("../viewer/replica.ts");
  const prefix = await actorPrefix(principal);
  const replica = new PageReplica(
    principal,
    "page_" + "d".repeat(32),
    () => {},
    () => {},
    async () => true,
  );
  replica.doc = createPage(replica.pageId!, "Title", ["body"], newActor(prefix));
  try {
    const thread_id = replica.comment({
      action: "add",
      block_id: replica.doc.order[0],
      body: "Browser",
    });
    replica.text(null, "Renamed");
    replica.comment({ action: "reply", thread_id, body: "Reply" });
    replica.comment({ action: "resolve", thread_id });
    assert.equal(projectComments(replica.doc)[0].resolvedBy?.id, prefix);
    assert.equal(projectComments(replica.doc)[0].messages.length, 2);
    validatePage(replica.doc, replica.pageId!);
  } finally {
    replica.dispose();
  }
});

test("concurrent resolve and reopen converge with attribution from the winning value", async () => {
  const prefix = await actorPrefix(principal);
  let base = createPage("page_" + "e".repeat(32), "Title", ["text"], newActor(prefix));
  const add = prepareComment(base, { action: "add", block_id: base.order[0], body: "Discuss" });
  base = A.change(base, add.apply);
  let a = A.clone(base, { actor: newActor(prefix) }),
    b = A.clone(base, { actor: newActor(prefix) });
  a = A.change(a, prepareComment(a, { action: "resolve", thread_id: add.threadId }).apply);
  b = A.change(b, prepareComment(b, { action: "reopen", thread_id: add.threadId }).apply);
  a = A.merge(a, b);
  b = A.merge(b, a);
  validateComments(a, base, prefix);
  validatePage(a, a.page_id);
  assert.deepEqual(projectComments(a), projectComments(b));
  A.free(a);
  A.free(b);
  A.free(base);
});

test("concurrent message edits merge and deletion hides late edits without resurrection", async () => {
  const prefix = await actorPrefix(principal);
  let base = createPage("page_" + "f".repeat(32), "Title", ["text"], newActor(prefix));
  const add = prepareComment(base, { action: "add", block_id: base.order[0], body: "Original" });
  base = A.change(base, add.apply);
  const ids = { thread_id: add.threadId, message_id: add.messageId };
  let left = A.clone(base, { actor: newActor(prefix) }),
    right = A.clone(base, { actor: newActor(prefix) }),
    deleted = A.clone(base, { actor: newActor(prefix) });
  left = A.change(
    left,
    prepareComment(left, { action: "edit", ...ids, body: "Left Original" }).apply,
  );
  right = A.change(
    right,
    prepareComment(right, { action: "edit", ...ids, body: "Original Right" }).apply,
  );
  // Different display timestamps must not make concurrent edits structurally invalid.
  right = A.change(right, (d) => {
    d.comments![add.threadId].messages[add.messageId!].editedAt = "2026-10-17T23:00:00.000Z";
  });
  deleted = A.change(deleted, prepareComment(deleted, { action: "delete_message", ...ids }).apply);
  let merged = A.merge(A.clone(left), right);
  validateComments(merged, left, prefix);
  assert.equal(projectComments(merged)[0].messages[0].body, "Left Original Right");
  let deletedAgain = A.clone(base, { actor: newActor(prefix) });
  deletedAgain = A.change(
    deletedAgain,
    prepareComment(deletedAgain, { action: "delete_message", ...ids }).apply,
  );
  deletedAgain = A.change(deletedAgain, (d) => {
    d.comments![add.threadId].messages[add.messageId!].deletedAt = "2026-10-17T23:00:00.000Z";
  });
  deleted = A.merge(deleted, deletedAgain);
  validateComments(deleted, base, prefix);
  A.free(deletedAgain);
  merged = A.merge(merged, deleted);
  validateComments(merged, deleted, prefix);
  validatePage(merged, merged.page_id);
  const projection = projectComments(merged)[0].messages[0];
  assert.equal(projection.body, "");
  assert.ok(projection.deletedAt);
  const rejected = A.clone(merged);
  assert.throws(
    () =>
      A.change(rejected, prepareComment(merged, { action: "edit", ...ids, body: "Restore" }).apply),
    /deleted/,
  );
  A.free(rejected);
  let forged = A.clone(merged, { actor: newActor(prefix) });
  forged = A.change(forged, (d) => {
    d.comments![add.threadId].messages[add.messageId!].deletedAt = null;
  });
  assert.throws(() => validateComments(forged, merged, prefix), /cannot be restored/);
  for (const d of [forged, merged, deleted, right, left, base]) A.free(d);
});

test("selection heads exclude appended text and stay detached after deleting their endpoint", async () => {
  const prefix = await actorPrefix(principal);
  let doc = createPage("page_" + "1".repeat(32), "Title", ["target 🌍"], newActor(prefix));
  const id = doc.order[0];
  doc = A.change(
    doc,
    prepareComment(doc, {
      action: "add",
      block_id: id,
      selected_text: "target 🌍",
      body: "Discuss",
    }).apply,
  );
  doc = A.change(doc, (d) =>
    A.splice(d, ["blocks", id, "markdown"], d.blocks[id].markdown.length, 0, " appended"),
  );
  assert.equal((projectComments(doc)[0].selectionContext as any).text, "target 🌍");
  assert.equal(
    (projectComments(doc)[0].selectionContext as any).end.offsetUtf16,
    "target 🌍".length,
  );
  doc = A.change(doc, (d) => A.splice(d, ["blocks", id, "markdown"], 0, "target 🌍".length, ""));
  assert.equal(projectComments(doc)[0].detached, true);
  doc = A.change(doc, (d) => A.splice(d, ["blocks", id, "markdown"], 0, 0, "unrelated"));
  assert.equal(projectComments(doc)[0].detached, true);
  A.free(doc);
});

test("raw block targets must be strings rather than coercible arrays", async () => {
  const prefix = await actorPrefix(principal);
  let doc = createPage("page_" + "2".repeat(32), "Title", ["text"], newActor(prefix));
  const add = prepareComment(doc, { action: "add", block_id: doc.order[0], body: "Discuss" });
  doc = A.change(doc, add.apply);
  doc = A.change(doc, (d) => {
    (d.comments![add.threadId].target as any).blockId = [d.order[0]];
  });
  assert.throws(() => validatePage(doc, doc.page_id), /Invalid target block/);
  A.free(doc);
});

test("pre-comments pending edits recover into a migrated Page with the shared comments root", async () => {
  const { restorePending } = await import("../viewer/replica.ts");
  const prefix = await actorPrefix(principal);
  let base = createPage("page_" + "3".repeat(32), "Title", ["original"], newActor(prefix));
  base = A.change(base, (d) => {
    delete d.comments;
  });
  let pending = A.clone(base, { actor: newActor(prefix) }),
    upgraded = A.clone(base, { actor: newActor(prefix) });
  pending = A.change(pending, (d) => A.updateText(d, ["title"], "Recovered title"));
  upgraded = A.change(upgraded, (d) => {
    d.comments = {};
  });
  const root = A.getObjectId(upgraded.comments!);
  const result = restorePending(upgraded, base.page_id, [
    { key: "old", scope: "test", revision: 1, bytes: A.save(pending) },
  ]);
  assert.equal(result.unreadable.length, 0);
  assert.equal(result.recovered.length, 1);
  assert.equal(result.doc.title, "Recovered title");
  assert.equal(A.getObjectId(result.doc.comments!), root);
  validateComments(result.doc, upgraded, prefix);
  for (const d of [result.doc, upgraded, pending, base]) A.free(d);
});

test("legacy Pages at the storage budget remain readable after comments migration", async () => {
  const storage = new Memory(),
    room = new PagesWorkspace({ storage });
  const created = (await room.call(principal, {
    operation: "create_page",
    arguments: { idempotency_key: "near-limit-fixture", markdown: "Keep readable" },
  })) as any;
  const saved = await storage.get<any>(created.page_id);
  let doc = A.load<Page>(saved.bytes);
  doc = A.change(doc, (d) => {
    delete d.comments;
  });
  saved.bytes = A.save(doc);
  saved.receipts.padding = { digest: "fixture", result: "" };
  const size =
    saved.bytes.length + new TextEncoder().encode(JSON.stringify({ ...saved, bytes: null })).length;
  saved.receipts.padding.result = "x".repeat(1536 * 1024 - size - 1);
  await storage.put({ [created.page_id]: saved });
  const result = (await room.call(principal, {
    operation: "read_page",
    arguments: { page_id: created.page_id },
  })) as any;
  assert.equal(result.content.blocks[0].markdown, "Keep readable");
  assert.equal(result.content.through_sequence, 2);
  A.free(doc);
});

test("comment IDs reject prototype names as invalid input", async () => {
  let doc = createPage(
    "page_" + "4".repeat(32),
    "Title",
    ["text"],
    newActor(await actorPrefix(principal)),
  );
  assert.throws(
    () => prepareComment(doc, { action: "reply", thread_id: "constructor", body: "bad" }),
    /Invalid thread ID/,
  );
  const add = prepareComment(doc, { action: "add", block_id: doc.order[0], body: "Good" });
  doc = A.change(doc, add.apply);
  assert.throws(
    () =>
      prepareComment(doc, {
        action: "edit",
        thread_id: add.threadId,
        message_id: "__proto__",
        body: "bad",
      }),
    /Invalid message ID/,
  );
  A.free(doc);
});
