import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyComment } from "../model/comments.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { CommentAdmission, recordFrame } from "./comment-admission.mjs";

// The native per-author gate at the byte store. Frames here use the stored
// record layout (patch-record-codec.mjs, binary v2) with a signed envelope
// whose issuer is the signing key; the signature itself is the native
// engine's concern and isn't checked here.

const TREE = "c".repeat(32);
const OTHER_TREE = "d".repeat(32);
const SERVER = "f".repeat(64);
const ALICE_KEY = "a1".repeat(32);
const BOB_KEY = "b2".repeat(32);
const VIEWER_KEY = "e3".repeat(32);
const SIGNERS = {
  [ALICE_KEY]: { principal: "account:alice", role: "editor" },
  [BOB_KEY]: { principal: "account:bob", role: "commenter" },
  [VIEWER_KEY]: { principal: "account:carol", role: "viewer" },
};
const page = A.from({ blocks: { b1: { id: "b1", markdown: "One" } } });

const unhex = (value) => Uint8Array.from(value.match(/../g), (pair) => parseInt(pair, 16));
/** A stored commit record frame for one encoded change. */
function frame(change, issuer, tree = TREE) {
  const hash = A.decodeChange(change).hash;
  const signed = new Uint8Array(4 + 32 + 8 + 64);
  signed.set([0x53, 0x54, 0x43, 0x00]);
  signed.set(unhex(issuer), 4);
  const value = new Uint8Array(112 + signed.length + change.length);
  value.set([0x53, 0x44, 0x52, 0x02]);
  const view = new DataView(value.buffer);
  view.setUint32(8, signed.length);
  view.setUint32(12, change.length);
  value.set(unhex(tree.padEnd(64, "0")), 16);
  value.set(unhex(hash), 48);
  value.set(signed, 112);
  value.set(change, 112 + signed.length);
  return [`subduction-v1/${tree.padEnd(64, "0")}/commits/${hash}`, value];
}

function harness() {
  let comments = A.clone(commentsGenesis("c0000000-0000-4000-8000-000000000003"));
  const saved = [];
  const refused = [];
  const admission = new CommentAdmission({
    tree: () => TREE,
    serverKey: SERVER,
    signer: (key) => SIGNERS[key],
    seed: () => comments,
    onRefused: async (key, reason) => refused.push({ key, code: reason.code }),
  });
  let fail = false;
  const store = admission.guard({
    async save(key) {
      if (fail) throw Error("storage unavailable");
      saved.push(key);
    },
    async saveMany(entries) {
      for (const [key] of entries) saved.push(key);
    },
    async load() {
      return undefined;
    },
  });
  /** One comment action as `who` writes it; returns its encoded change and
   * advances the serving document as delivery would. */
  const write = (who, input, deliver = true) => {
    const before = comments;
    const after = A.change(A.clone(before, { actor: who.actor }), (draft) =>
      applyComment(draft, input, { principal: who.principal }, undefined, {
        page,
        role: who.role,
      }),
    );
    const [change] = A.getChanges(before, after);
    if (deliver) comments = after;
    return change;
  };
  return {
    store,
    saved,
    refused,
    admission,
    write,
    raw: (actor, fn) => {
      const after = A.change(A.clone(comments, { actor }), fn);
      return A.getChanges(comments, after)[0];
    },
    deliver: (change) => {
      comments = A.applyChanges(comments, [change])[0];
    },
    failNext: (value) => {
      fail = value;
    },
    comments: () => comments,
  };
}
const actor = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
const alice = { ...SIGNERS[ALICE_KEY], actor: actor() };
const bob = { ...SIGNERS[BOB_KEY], actor: actor() };

test("recordFrame reads tree, kind, issuer and blob, and ignores everything else", () => {
  const change = A.getAllChanges(A.from({ x: 1 }))[0];
  const [path, value] = frame(change, BOB_KEY);
  const read = recordFrame(path, value);
  assert.equal(read.tree, TREE.padEnd(64, "0"));
  assert.equal(read.kind, "commit");
  assert.equal(read.issuer, BOB_KEY);
  assert.deepEqual(read.blob, change);
  assert.equal(recordFrame(`${path.split("/commits/")[0]}/id`, new Uint8Array([1])), null);
  assert.equal(recordFrame(path, value.subarray(0, 50)), null);
});

test("a commenter's own thread and replies pass and are stored", async () => {
  const h = harness();
  const add = h.write(bob, { block_id: "b1", body: "Mine" }, false);
  await h.store.save(...frame(add, BOB_KEY));
  h.deliver(add);
  const thread = Object.keys(h.comments().threads)[0];
  const reply = h.write(bob, { action: "reply", thread_id: thread, body: "Again" }, false);
  await h.store.save(...frame(reply, BOB_KEY));
  assert.equal(h.saved.length, 2);
  assert.deepEqual(h.refused, []);
});

test("a commenter editing another author's message is refused before storage and blocked", async () => {
  const h = harness();
  const add = h.write(alice, { block_id: "b1", body: "Alice's" });
  await h.store.save(...frame(add, ALICE_KEY));
  const [threadId] = Object.keys(h.comments().threads);
  const [messageId] = Object.keys(h.comments().threads[threadId].messages);
  // Bob's tab skips the rules and edits Alice's body directly.
  const forged = h.raw(bob.actor, (draft) =>
    A.updateText(draft, ["threads", threadId, "messages", messageId, "body"], "Rewritten"),
  );
  await assert.rejects(h.store.save(...frame(forged, BOB_KEY)), {
    code: "comment_change_refused",
  });
  assert.equal(h.saved.length, 1, "the refused record was never written");
  assert.deepEqual(h.refused, [{ key: BOB_KEY, code: "not_message_author" }]);
});

test("any commenter may resolve another author's thread", async () => {
  const h = harness();
  const add = h.write(alice, { block_id: "b1", body: "Alice's" });
  await h.store.save(...frame(add, ALICE_KEY));
  const [threadId] = Object.keys(h.comments().threads);
  const resolve = h.write(bob, { action: "resolve", thread_id: threadId }, false);
  await h.store.save(...frame(resolve, BOB_KEY));
  assert.deepEqual(h.refused, []);
});

test("a commenter can't delete another's thread; an editor can", async () => {
  const h = harness();
  const add = h.write(alice, { block_id: "b1", body: "Alice's" });
  await h.store.save(...frame(add, ALICE_KEY));
  const [threadId] = Object.keys(h.comments().threads);
  const remove = h.raw(bob.actor, (draft) => {
    delete draft.threads[threadId];
  });
  await assert.rejects(h.store.save(...frame(remove, BOB_KEY)));
  const byEditor = h.raw(alice.actor, (draft) => {
    delete draft.threads[threadId];
  });
  await h.store.save(...frame(byEditor, ALICE_KEY));
  assert.equal(h.saved.length, 2);
});

test("a viewer's change is refused even if it reaches the store", async () => {
  const h = harness();
  const add = h.raw(actor(), (draft) => {
    draft.threads.x = { messages: {} };
  });
  await assert.rejects(h.store.save(...frame(add, VIEWER_KEY)));
  assert.equal(h.saved.length, 0);
});

test("the host's own records pass unchecked; other trees pass straight through", async () => {
  const h = harness();
  const host = h.raw(actor(), (draft) => {
    draft.threads.anything = { messages: {} };
  });
  await h.store.save(...frame(host, SERVER));
  const page = A.getAllChanges(A.from({ title: "x" }))[0];
  await h.store.save(...frame(page, BOB_KEY, OTHER_TREE));
  await h.store.save("subduction-v1/whatever/id", new Uint8Array([1]));
  assert.equal(h.saved.length, 3);
});

test("a group saved at once is checked in causal order, whatever its order", async () => {
  const h = harness();
  const first = h.write(bob, { block_id: "b1", body: "First" });
  const threadId = Object.keys(h.comments().threads)[0];
  const second = h.write(bob, { action: "reply", thread_id: threadId, body: "Second" });
  // Reset the admission document to before both, as a fresh host would hold.
  const h2 = harness();
  await h2.store.saveMany([frame(second, BOB_KEY), frame(first, BOB_KEY)]);
  assert.equal(h2.saved.length, 2);
});

test("a change whose dependencies never arrive is refused without blocking its key", async () => {
  const h = harness();
  const first = h.write(bob, { block_id: "b1", body: "First" });
  const threadId = Object.keys(h.comments().threads)[0];
  const second = h.write(bob, { action: "reply", thread_id: threadId, body: "Second" });
  const fresh = harness();
  await assert.rejects(fresh.store.save(...frame(second, BOB_KEY)), {
    code: "comment_change_refused",
  });
  assert.deepEqual(fresh.refused, []);
  assert.ok(first);
});

test("a failed save rebuilds the admission document from storage", async () => {
  const h = harness();
  const add = h.write(bob, { block_id: "b1", body: "Mine" }, false);
  h.failNext(true);
  await assert.rejects(h.store.save(...frame(add, BOB_KEY)), /storage unavailable/);
  assert.equal(h.admission.admitted, undefined, "reset after an ambiguous failure");
  h.failNext(false);
  await h.store.save(...frame(add, BOB_KEY));
  assert.equal(h.saved.length, 1);
});
