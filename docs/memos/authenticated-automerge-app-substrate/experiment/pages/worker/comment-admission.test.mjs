import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyComment } from "../model/comments.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { createHash } from "node:crypto";
import {
  CommentAdmission,
  REFUSAL_BUDGET,
  REFUSAL_CACHE_TTL_MS,
  REFUSAL_WINDOW_MS,
  chargeRefusal,
  recordFrame,
  throttled,
} from "./comment-admission.mjs";

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
// Bob's second tab: another signing key of the same principal.
const BOB_OTHER_KEY = "b4".repeat(32);
const SIGNERS = {
  [ALICE_KEY]: { principal: "account:alice", role: "editor" },
  [BOB_KEY]: { principal: "account:bob", role: "commenter" },
  [BOB_OTHER_KEY]: { principal: "account:bob", role: "commenter" },
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
  // The header's signed-envelope digest, as the bridge writes it.
  value.set(createHash("sha256").update(signed).digest(), 80);
  value.set(signed, 112);
  value.set(change, 112 + signed.length);
  return [`subduction-v1/${tree.padEnd(64, "0")}/commits/${hash}`, value];
}

function harness() {
  let comments = A.clone(commentsGenesis("c0000000-0000-4000-8000-000000000003"));
  const saved = [];
  const refused = [];
  const throttledKeys = [];
  const clock = { now: 1_000_000 };
  const admission = new CommentAdmission({
    tree: () => TREE,
    serverKey: SERVER,
    signer: (key) => SIGNERS[key],
    seed: () => comments,
    onRefused: (key, reason) => refused.push({ key, code: reason.code }),
    onThrottled: (key) => throttledKeys.push(key),
    now: () => clock.now,
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
  const write = (who, input, deliver = true, spans) => {
    const before = comments;
    const after = A.change(A.clone(before, { actor: who.actor }), (draft) =>
      applyComment(draft, input, { principal: who.principal }, spans, {
        page,
        role: who.role,
        literal: !!spans,
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
    throttledKeys,
    clock,
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

test("recordFrame decodes with the bridge's codec and checks the frame against its path", () => {
  const change = A.getAllChanges(A.from({ x: 1 }))[0];
  const [path, value] = frame(change, BOB_KEY);
  const read = recordFrame(path, value, 1 << 20);
  assert.equal(read.tree, TREE.padEnd(64, "0"));
  assert.equal(read.kind, "commit");
  assert.equal(read.issuer, BOB_KEY);
  assert.deepEqual(read.blob, change);
  assert.equal(recordFrame(`${path.split("/commits/")[0]}/id`, new Uint8Array([1]), 1 << 20), null);
  assert.throws(() => recordFrame(path, value.subarray(0, 50), 1 << 20));
  assert.throws(() => recordFrame(path.replace("/commits/", "/fragments/"), value, 1 << 20));
});

test("a malformed frame in the comments tree is refused, not a storage failure", async () => {
  const h = harness();
  const change = h.write(bob, { block_id: "b1", body: "Mine" }, false);
  const [path, value] = frame(change, BOB_KEY);
  await assert.rejects(h.store.save(path, value.subarray(0, 120)), { recordRefused: true });
  assert.deepEqual(h.refused, [], "an unreadable frame proves no broken rule");
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
    // The marker the bridge reads: a refusal, not a storage failure.
    recordRefused: true,
  });
  assert.equal(h.saved.length, 1, "the refused record was never written");
  assert.deepEqual(h.refused, [{ key: BOB_KEY, code: "not_message_author" }]);
});

const IMAGE = "/api/assets/p1/" + "a".repeat(64);
const imageSpans = [
  {
    type: "block",
    value: {
      type: "image",
      parents: ["paragraph"],
      attrs: { src: IMAGE, alt: "", title: null },
      isEmbed: true,
    },
  },
];

test("an image-only comment from the browser passes, and the same key writes again", async () => {
  const h = harness();
  // The composer's draft: one image, no text. Its Markdown source is the
  // image reference, as comment-draft.mjs sends it.
  const add = h.write(
    bob,
    { block_id: "b1", body: `![](${IMAGE})`, body_format: "markdown" },
    false,
    imageSpans,
  );
  await h.store.save(...frame(add, BOB_KEY));
  h.deliver(add);
  assert.deepEqual(h.refused, []);
  const [threadId] = Object.keys(h.comments().threads);
  const reply = h.write(
    bob,
    { action: "reply", thread_id: threadId, body: "And a caption" },
    false,
  );
  await h.store.save(...frame(reply, BOB_KEY));
  assert.equal(h.saved.length, 2);
  assert.deepEqual(h.refused, []);
});

test("a comment with neither text nor an image is refused everywhere alike", async () => {
  const h = harness();
  const rule = [
    { type: "block", value: { type: "horizontal-rule", parents: [], attrs: {}, isEmbed: false } },
  ];
  // The tools refuse it before writing.
  assert.throws(
    () => h.write(bob, { block_id: "b1", body: "---", body_format: "markdown" }, false, rule),
    /1–16000 characters/,
  );
  // So does native admission, written raw.
  const raw = h.raw(bob.actor, (draft) => {
    const now = new Date().toISOString();
    const author = { principal: bob.principal, displayName: "Bob", driver: "Browser" };
    draft.threads.rule = {
      target: { kind: "block", blockId: "b1" },
      author,
      createdAt: now,
      status: { value: "open", at: now },
      messages: {
        m1: {
          body: "---",
          format: "automerge-rich-text-v1",
          richText: "",
          author,
          createdAt: now,
          deletedAt: null,
        },
      },
    };
    A.updateSpans(draft, ["threads", "rule", "messages", "m1", "richText"], rule);
  });
  await assert.rejects(h.store.save(...frame(raw, BOB_KEY)), { recordRefused: true });
});

test("an unexpected checker error refuses the record without blocking the key", async () => {
  const h = harness();
  const add = h.write(bob, { block_id: "b1", body: "Mine" }, false);
  h.admission.signer = () => {
    throw Error("checker bug");
  };
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try {
    await assert.rejects(
      h.store.save(...frame(add, BOB_KEY)),
      (error) => error.recordRefused === true && error.reason.code === "admission_error",
    );
  } finally {
    console.error = original;
  }
  assert.deepEqual(h.refused, []);
  assert.match(errors[0], /page.comment_admission_error/);
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
  // Nonfatal, like every refusal, and no proof of a broken rule: the key
  // isn't blocked, so repeating it gains an attacker nothing.
  await assert.rejects(
    fresh.store.save(...frame(second, BOB_KEY)),
    (error) => error.recordRefused === true && error.reason.code === "missing_dependencies",
  );
  assert.deepEqual(fresh.refused, []);
  // Once its dependency lands, the same record is accepted.
  await fresh.store.save(...frame(first, BOB_KEY));
  await fresh.store.save(...frame(second, BOB_KEY));
  assert.equal(fresh.saved.length, 2);
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

test("the refusal budget is a pure step: a window, a throttle, then it starts over", () => {
  let entry;
  let exceeded = 0;
  for (let i = 0; i < REFUSAL_BUDGET + 3; i++) {
    const step = chargeRefusal(entry, 1000);
    entry = step.entry;
    if (step.exceeded) exceeded++;
  }
  assert.equal(exceeded, 1, "the budget is spent once per window");
  assert.equal(throttled(entry, 1000), true);
  assert.equal(throttled(entry, 1000 + REFUSAL_WINDOW_MS), false);
  const next = chargeRefusal(entry, 1000 + REFUSAL_WINDOW_MS);
  assert.deepEqual(next.entry.count, 1, "a new window starts over");
  assert.equal(next.exceeded, false);
});

test("an identical resend is refused without decoding while nothing new is admitted", async () => {
  const h = harness();
  const add = h.write(alice, { block_id: "b1", body: "Alice's" });
  await h.store.save(...frame(add, ALICE_KEY));
  h.admission.adopt(A.clone(h.comments()));
  const [threadId] = Object.keys(h.comments().threads);
  const [messageId] = Object.keys(h.comments().threads[threadId].messages);
  const forged = h.raw(bob.actor, (d) =>
    A.updateText(d, ["threads", threadId, "messages", messageId, "body"], "Forged"),
  );
  const record = frame(forged, BOB_KEY);
  const checked = h.admission.stats.checked;
  await assert.rejects(h.store.save(...record), { recordRefused: true });
  assert.equal(h.admission.stats.checked, checked + 1);
  await assert.rejects(h.store.save(...record), (e) => e.reason.code === "comment_refusal_cached");
  assert.equal(h.admission.stats.checked, checked + 1, "the resend was not decoded");
  // After the TTL it's checked again.
  h.clock.now += REFUSAL_CACHE_TTL_MS;
  await assert.rejects(h.store.save(...record), (e) => e.reason.code === "not_message_author");
  assert.equal(h.admission.stats.checked, checked + 2);
});

test("a burst of bad records: bounded work, then the connection closes, then a valid record lands", async () => {
  const h = harness();
  // Bob's later changes depend on one the host never received.
  const first = h.write(bob, { block_id: "b1", body: "First" });
  const threadId = Object.keys(h.comments().threads)[0];
  const orphans = [];
  for (let i = 0; i < 40; i++)
    orphans.push(h.write(bob, { action: "reply", thread_id: threadId, body: `Reply ${i}` }));
  const fresh = harness();
  fresh.clock.now = h.clock.now;
  // Twenty distinct orphans, each resent three times.
  for (const orphan of orphans.slice(0, 20))
    for (let resend = 0; resend < 3; resend++)
      await assert.rejects(fresh.store.save(...frame(orphan, BOB_KEY)), { recordRefused: true });
  const { checked, cached, throttled: refusedUnread } = fresh.admission.stats;
  assert.ok(checked <= REFUSAL_BUDGET, `decoded ${checked} records, budget ${REFUSAL_BUDGET}`);
  assert.ok(cached + refusedUnread >= 60 - REFUSAL_BUDGET);
  // The record that spent the budget closes the submitter, and so does every
  // record after it, cached resends included.
  const crossing = 60 - fresh.throttledKeys.length;
  assert.ok(crossing <= REFUSAL_BUDGET, `the budget was spent by refusal ${crossing}`);
  assert.ok(fresh.throttledKeys.every((key) => key === BOB_KEY));
  assert.deepEqual(fresh.refused, [], "a missing dependency never blocks the key");
  // Still throttled within the window, even for a valid record, and that
  // submission closes its connection too.
  const closes = fresh.throttledKeys.length;
  await assert.rejects(
    fresh.store.save(...frame(first, BOB_KEY)),
    (e) => e.reason.code === "comment_admission_throttled",
  );
  assert.equal(fresh.throttledKeys.length, closes + 1);
  // After backing off, the missing dependency arrives and both are admitted.
  fresh.clock.now += REFUSAL_WINDOW_MS;
  await fresh.store.save(...frame(first, BOB_KEY));
  await fresh.store.save(...frame(orphans[0], BOB_KEY));
  assert.equal(fresh.saved.length, 2);
  assert.equal(fresh.throttledKeys.length, closes + 1, "no close once the window has passed");
});

test("a reconnect or another key of a throttled principal gets the retryable close too", async () => {
  const h = harness();
  h.write(bob, { block_id: "b1", body: "First" });
  const threadId = Object.keys(h.comments().threads)[0];
  const orphan = () => h.write(bob, { action: "reply", thread_id: threadId, body: "R" });
  const fresh = harness();
  for (let i = 0; i < REFUSAL_BUDGET; i++)
    await assert.rejects(fresh.store.save(...frame(orphan(), BOB_KEY)));
  assert.deepEqual(fresh.throttledKeys, [BOB_KEY], "the budget closes the submitter");
  // The same key after reconnecting: its next submission is refused unread
  // and closed again, so the client keeps backing off.
  await assert.rejects(
    fresh.store.save(...frame(orphan(), BOB_KEY)),
    (e) => e.reason.code === "comment_admission_throttled",
  );
  // Bob's other tab, a different key of the same principal: the same.
  const valid = fresh.write(bob, { block_id: "b1", body: "From the other tab" }, false);
  await assert.rejects(
    fresh.store.save(...frame(valid, BOB_OTHER_KEY)),
    (e) => e.reason.code === "comment_admission_throttled",
  );
  assert.deepEqual(fresh.throttledKeys, [BOB_KEY, BOB_KEY, BOB_OTHER_KEY]);
  const checked = fresh.admission.stats.checked;
  assert.equal(checked, REFUSAL_BUDGET, "throttled submissions are never decoded");
  // After the window, the other tab's valid comment lands and nothing closes.
  fresh.clock.now += REFUSAL_WINDOW_MS;
  await fresh.store.save(...frame(valid, BOB_OTHER_KEY));
  assert.equal(fresh.saved.length, 1);
  assert.equal(fresh.throttledKeys.length, 3);
});

test("other principals keep their budget while one is throttled", async () => {
  const h = harness();
  h.write(bob, { block_id: "b1", body: "First" });
  const threadId = Object.keys(h.comments().threads)[0];
  const fresh = harness();
  for (let i = 0; i < REFUSAL_BUDGET; i++) {
    const orphan = h.write(bob, { action: "reply", thread_id: threadId, body: `R${i}` });
    await assert.rejects(fresh.store.save(...frame(orphan, BOB_KEY)));
  }
  assert.deepEqual(fresh.throttledKeys, [BOB_KEY]);
  const add = fresh.write(alice, { block_id: "b1", body: "Alice is fine" }, false);
  await fresh.store.save(...frame(add, ALICE_KEY));
  assert.equal(fresh.saved.length, 1);
});
