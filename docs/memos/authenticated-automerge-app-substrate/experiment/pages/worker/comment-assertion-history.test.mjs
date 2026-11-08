import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { PlainSync } from "./plain-sync.mjs";
import { Storage } from "./projects-fixture.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { applyComment } from "../model/comments.mjs";
import { browser, raw, until, newId, urlOf } from "../sync/test-helpers.mjs";

const payload = "https://private.invalid/" + "x".repeat(5000);
const who = { principal: "Alice", displayName: "Alice", driver: "Browser" };
const access = {
  generation: 1,
  role: "commenter",
  canWrite: false,
  canComment: true,
  trashed: false,
};
const identity = { ...who, role: "commenter", identity: who, access, features: [] };
const page = A.from({ blocks: { b: { id: "b" } } });
const at = "2026-11-08T04:14:28Z";
function fixtureThread(d, tid = "thread", mid = "initial") {
  const message = {
    format: "automerge-rich-text-v1",
    richText: "Body",
    author: { ...who },
    createdAt: at,
    deletedAt: null,
  };
  d.threads[tid] = {
    target: { kind: "block", blockId: "b" },
    author: { ...who },
    createdAt: at,
    status: { value: "open", at },
    messages: { [mid]: message },
  };
}
async function coldAdmission(base, next, valid) {
  const storage = new Storage(),
    id = newId();
  const { sync, refusals } = await open(storage);
  await sync.host.seed(id, "comments", base);
  const socket = raw(sync.host, { ...identity, senderId: "writer", sessionId: "writer" });
  const message = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
  message.changes = A.getAllChanges(next);
  socket.link.client.send({ t: "sync", doc: id, m: A.encodeSyncMessage(message), r: 1 });
  await until(() => refusals.length || socket.frames.some((frame) => frame.t === "sync"));
  const doc = await sync.host.document(id);
  await sync.host.store.compact(id, A.save(doc), A.getHeads(doc));
  const cold = await open(storage);
  cold.sync.host.register(id, "comments");
  const viewer = await browser(cold.sync.host, { ...identity, principal: "Bob" });
  try {
    const read = await viewer.repo.find(urlOf(id));
    assert.equal(refusals.length, valid ? 0 : 1);
    assert.deepEqual(A.getHeads(read.doc()), A.getHeads(doc));
    if (!valid) assert.deepEqual(A.getHeads(read.doc()), A.getHeads(base));
  } finally {
    await viewer.repo.shutdown();
    socket.link.client.close();
  }
}

for (const key of ["constructor", "toString", "hasOwnProperty", "_odd-ID_9"])
  for (const reply of [false, true]) {
    test(`native own ID ${key} ${reply ? "reply" : "thread"} enforces assertion construction`, async () => {
      let base = commentsGenesis(crypto.randomUUID());
      if (reply) base = A.change(base, (draft) => fixtureThread(draft));
      for (const bad of [true, false]) {
        const next = A.change(A.clone(base), (draft) => {
          if (reply)
            draft.threads.thread.messages[key] = {
              format: "automerge-rich-text-v1",
              richText: "Reply",
              author: { ...who },
              createdAt: at,
              deletedAt: null,
            };
          else fixtureThread(draft, key);
          const author = reply
            ? draft.threads.thread.messages[key].author
            : draft.threads[key].author;
          author.clientAssertions = { version: 1, name: "Agent" };
          if (bad) {
            author.clientAssertions.session_url = new A.ImmutableString(payload);
            delete author.clientAssertions.session_url;
          }
        });
        await coldAdmission(base, next, !bad);
        A.free(next);
      }
      A.free(base);
    });
  }

for (const kind of ["thread", "message", "missing-version", "valid-reply", "body"])
  test(`native detached assertion identity: ${kind}`, async () => {
    const base = A.change(commentsGenesis(crypto.randomUUID()), (draft) => {
      fixtureThread(draft);
      for (const author of [
        draft.threads.thread.author,
        draft.threads.thread.messages.initial.author,
      ])
        author.clientAssertions = { version: 1, name: "a".repeat(80) };
    });
    const deleted = A.change(A.clone(base), (draft) => {
      delete draft.threads.thread;
    });
    const next = A.change(A.clone(base), (draft) => {
      if (kind === "thread" || kind === "message")
        A.splice(
          draft,
          [
            "threads",
            "thread",
            ...(kind === "message" ? ["messages", "initial"] : []),
            "author",
            "clientAssertions",
            "name",
          ],
          80,
          0,
          "z",
        );
      else if (kind === "body")
        A.updateText(
          draft,
          ["threads", "thread", "messages", "initial", "richText"],
          "Detached ordinary edit",
        );
      else {
        draft.threads.thread.messages.reply = {
          format: "automerge-rich-text-v1",
          richText: "Reply",
          author: {
            ...who,
            clientAssertions:
              kind === "missing-version" ? { name: "Agent" } : { version: 1, name: "Agent" },
          },
          createdAt: at,
          deletedAt: null,
        };
      }
    });
    await coldAdmission(deleted, next, ["body", "valid-reply"].includes(kind));
    for (const doc of [base, deleted, next]) A.free(doc);
  });
const retained = (doc) =>
  A.getAllChanges(A.load(A.save(doc))).flatMap((bytes) => A.decodeChange(bytes).ops);
async function open(storage) {
  const refusals = [];
  const sync = new PlainSync({
    storage,
    policy: { account: () => access },
    now: () => 0,
    onRefused: (_conn, refusal) => refusals.push(refusal.code),
  });
  await sync.host.load();
  return { sync, refusals };
}

for (const kind of ["thread", "message"])
  test(`fresh concurrent author cannot reset admitted detached ${kind} ownership`, async () => {
    const genesis = commentsGenesis(crypto.randomUUID());
    const entity = (doc) =>
      kind === "thread" ? doc.threads.thread : doc.threads.thread.messages.initial;
    const c0 = A.change(A.clone(genesis), (draft) => {
      // C0 is intentionally unfinished, never admitted on its own.
      const message = {
        format: "automerge-rich-text-v1",
        richText: "Body",
        createdAt: at,
        deletedAt: null,
        ...(kind === "thread" && { author: { ...who } }),
      };
      draft.threads.thread = {
        target: { kind: "block", blockId: "b" },
        createdAt: at,
        status: { value: "open", at },
        messages: { initial: message },
        ...(kind === "message" && { author: { ...who } }),
      };
    });
    const base = A.change(A.clone(c0), (draft) => {
      entity(draft).author = { ...who, clientAssertions: { version: 1, name: "Original" } };
    });
    const deleted = A.change(A.clone(base), (draft) => {
      delete draft.threads.thread;
    });
    const next = A.change(A.clone(c0, { actor: "ff".repeat(16) }), (draft) => {
      entity(draft).author = {
        ...who,
        clientAssertions: { version: 1, name: "Changed-by-conflict" },
      };
    });
    const delta = A.getChanges(c0, next);
    assert.deepEqual(A.decodeChange(delta[0]).ops.find((op) => op.key === "author").pred, []);
    // Positive initial bundled completion and the visible-owner refusal use the
    // same real native host/cold-reader path as the detached regression.
    await coldAdmission(genesis, base, true);
    await coldAdmission(base, next, false);
    await coldAdmission(deleted, next, false);
    for (const doc of [genesis, c0, base, deleted, next]) A.free(doc);
  });

for (const scenario of [
  "scalar-url",
  "text-url",
  "scalar-overwrite",
  "text-splice",
  "mark-unmark",
  "block-join",
  "valid-rewrite",
  "map-delete",
  "author-delete",
  "message-delete",
  "thread-delete",
  "thread-scalar-url",
  "reply-scalar-url",
  "generic-url",
]) {
  test(`native PlainSync rejects retained assertion construction history: ${scenario}`, async () => {
    const variant = scenario.endsWith("scalar-url") ? "scalar-url" : scenario;
    const storage = new Storage(),
      id = newId();
    let base = commentsGenesis(crypto.randomUUID()),
      existing;
    if (scenario.startsWith("reply-"))
      base = A.change(base, (draft) => {
        existing = applyComment(draft, { block_id: "b", body: "Existing" }, who, undefined, {
          page,
          role: "commenter",
        });
      });
    const { sync, refusals } = await open(storage);
    await sync.host.seed(id, "comments", base);
    let ids;
    let candidate = A.change(A.clone(base), (draft) => {
      ids = applyComment(
        draft,
        existing
          ? { action: "reply", thread_id: existing.thread_id, body: "Valid" }
          : { block_id: "b", body: "Valid" },
        { ...who, clientAssertions: { version: 1, name: "Agent" } },
        undefined,
        { page, role: "commenter" },
      );
      const claims = scenario.startsWith("thread-")
        ? draft.threads[ids.thread_id].author.clientAssertions
        : draft.threads[ids.thread_id].messages[ids.message_id].author.clientAssertions;
      const path = [
        "threads",
        ids.thread_id,
        "messages",
        ids.message_id,
        "author",
        "clientAssertions",
        "name",
      ];
      if (variant === "scalar-url") {
        claims.session_url = new A.ImmutableString(payload);
        delete claims.session_url;
      }
      if (variant === "generic-url") {
        const author = draft.threads[ids.thread_id].messages[ids.message_id].author;
        author.session_url = new A.ImmutableString(payload);
        delete author.session_url;
      }
      if (variant === "text-url") claims.session_url = payload;
      if (variant === "scalar-overwrite") {
        claims.model = new A.ImmutableString("x".repeat(5000));
        claims.model = new A.ImmutableString("model");
      }
      if (variant === "text-splice") {
        A.splice(draft, path, 0, 0, "x".repeat(5000));
        A.splice(draft, path, 0, 5000, "");
      }
      if (variant === "mark-unmark") {
        A.mark(draft, path, { start: 0, end: 1 }, "private", payload);
        A.unmark(draft, path, { start: 0, end: 1 }, "private");
      }
      if (variant === "block-join")
        A.splitBlock(draft, path, 0, { type: "private", value: payload });
      if (variant === "valid-rewrite") A.updateText(draft, path, "OtherAgent");
    });
    if (
      [
        "text-url",
        "block-join",
        "valid-rewrite",
        "map-delete",
        "author-delete",
        "message-delete",
        "thread-delete",
      ].includes(variant)
    )
      candidate = A.change(candidate, (draft) => {
        const author = draft.threads[ids.thread_id].messages[ids.message_id].author;
        if (variant === "text-url") delete author.clientAssertions.session_url;
        if (variant === "block-join")
          A.joinBlock(
            draft,
            [
              "threads",
              ids.thread_id,
              "messages",
              ids.message_id,
              "author",
              "clientAssertions",
              "name",
            ],
            0,
          );
        if (variant === "valid-rewrite")
          A.updateText(
            draft,
            [
              "threads",
              ids.thread_id,
              "messages",
              ids.message_id,
              "author",
              "clientAssertions",
              "name",
            ],
            "Agent",
          );
        if (variant === "map-delete") delete author.clientAssertions;
        if (variant === "author-delete")
          delete draft.threads[ids.thread_id].messages[ids.message_id].author;
        if (variant === "message-delete")
          delete draft.threads[ids.thread_id].messages[ids.message_id];
        if (variant === "thread-delete") delete draft.threads[ids.thread_id];
      });
    const socket = raw(sync.host, { ...identity, senderId: "writer", sessionId: "writer" });
    const message = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
    message.changes = A.getAllChanges(candidate);
    socket.link.client.send({ t: "sync", doc: id, m: A.encodeSyncMessage(message), r: 1 });
    await until(() => refusals.length || socket.frames.some((frame) => frame.t === "sync"));
    const admitted = await sync.host.document(id);
    // Check durable bytes and a genuinely new reader even on the RED version.
    await sync.host.store.compact(id, A.save(admitted), A.getHeads(admitted));
    const cold = await open(storage);
    cold.sync.host.register(id, "comments");
    const reopened = await cold.sync.host.document(id);
    const viewer = await browser(cold.sync.host, {
      ...identity,
      principal: "Bob",
      senderId: "viewer",
    });
    try {
      const handle = await viewer.repo.find(urlOf(id));
      assert.deepEqual(A.getHeads(handle.doc()), A.getHeads(reopened));
      assert.deepEqual(retained(handle.doc()), retained(reopened));
      if (variant === "generic-url") {
        assert.equal(refusals.length, 0, "no new generic deleted-history policy");
        assert.ok(retained(reopened).some((op) => op.value === payload));
      } else {
        assert.equal(
          refusals.length,
          1,
          `candidate retained ${retained(reopened).length} operations`,
        );
        assert.deepEqual(A.getHeads(reopened), A.getHeads(base));
        assert.equal(sync.host.actor(A.getActorId(candidate)), undefined);
      }
    } finally {
      await viewer.repo.shutdown();
      socket.link.client.close();
      A.free(candidate);
      A.free(base);
    }
  });
}

test("actual host writer add/reply, durable replay, separate immutable edit and cold reader", async () => {
  const storage = new Storage(),
    id = newId(),
    base = commentsGenesis(crypto.randomUUID());
  const { sync, refusals } = await open(storage);
  await sync.host.seed(id, "comments", base);
  const writer = await browser(sync.host, identity);
  let ids;
  try {
    const handle = await writer.repo.find(urlOf(id));
    handle.change((draft) => {
      ids = applyComment(
        draft,
        { block_id: "b", body: "Initial" },
        { ...who, clientAssertions: { version: 1, name: "Agent", model: "model" } },
        undefined,
        { page, role: "commenter" },
      );
    });
    await until(async () => (await sync.host.document(id)).threads[ids.thread_id]);
    handle.change((draft) =>
      applyComment(
        draft,
        { action: "reply", thread_id: ids.thread_id, body: "Reply" },
        { ...who, clientAssertions: { version: 1, name: "Other", model: "model2" } },
        undefined,
        { page, role: "commenter" },
      ),
    );
    await until(
      async () =>
        Object.keys((await sync.host.document(id)).threads[ids.thread_id].messages).length === 2,
    );
    const doc = await sync.host.document(id),
      heads = A.getHeads(doc);
    const relay = raw(sync.host, { ...identity, senderId: "relay", sessionId: "relay" });
    const message = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
    message.changes = A.getAllChanges(doc);
    relay.link.client.send({ t: "sync", doc: id, m: A.encodeSyncMessage(message), r: 1 });
    await until(() => relay.frames.length > 0);
    assert.deepEqual(refusals, []);
    assert.deepEqual(A.getHeads(await sync.host.document(id)), heads);
    handle.change((draft) => {
      draft.threads[ids.thread_id].messages[ids.message_id].author.clientAssertions.name =
        new A.ImmutableString("Changed");
    });
    await until(() => refusals.length);
    assert.equal(refusals.at(-1), "immutable_field");
    await sync.host.store.compact(id, A.save(doc), heads);
    const cold = await open(storage);
    cold.sync.host.register(id, "comments");
    const viewer = await browser(cold.sync.host, { ...identity, principal: "Bob" });
    try {
      const read = await viewer.repo.find(urlOf(id));
      assert.deepEqual(A.getHeads(read.doc()), heads);
      assert.equal(
        read.doc().threads[ids.thread_id].messages[ids.message_id].author.clientAssertions.name,
        "Agent",
      );
    } finally {
      await viewer.repo.shutdown();
      relay.link.client.close();
    }
  } finally {
    await writer.repo.shutdown();
    A.free(base);
  }
});
