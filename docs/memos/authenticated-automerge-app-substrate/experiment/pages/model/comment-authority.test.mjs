import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { REJECTION, admitCommentChanges } from "./comment-authority.mjs";
import {
  addMessage,
  addReaction,
  createThread,
  deleteMessage,
  editMessage,
  initCommentsDoc,
  removeReaction,
  setThreadAnchor,
  setThreadStatus,
} from "./comments-doc.mjs";

const ALICE = "account:alice";
const BOB = "account:bob";
const CAROL = "account:carol";
const AT = "2026-10-31T12:00:00.000Z";
const blockAnchor = { kind: "block", blockId: "block-1" };
const selectionAnchor = {
  kind: "selection",
  anchor: { blockId: "block-2", textObjectId: "7@aa", relativePositionBase64: "AQID" },
  head: { blockId: "block-2", textObjectId: "7@aa", relativePositionBase64: "BAUG" },
};
const actor = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
const s = (value) => new A.ImmutableString(value);

/** Alice's thread, with Bob's reply and one reaction from each. */
function seed(threads = 0) {
  let doc = initCommentsDoc("page10.runtimed.run", { actor: actor() });
  doc = A.change(doc, (d) => {
    createThread(d, {
      threadId: "t-alice",
      messageId: "m-alice",
      anchor: blockAnchor,
      principal: ALICE,
      body: "Alice **opens** this",
      at: AT,
    });
    addMessage(d, {
      threadId: "t-alice",
      messageId: "m-bob",
      principal: BOB,
      body: "Bob replies",
      at: AT,
    });
    addReaction(d, {
      threadId: "t-alice",
      reactionId: "r-bob",
      principal: BOB,
      emoji: "👍",
      target: "m-alice",
    });
    addReaction(d, { threadId: "t-alice", reactionId: "r-alice", principal: ALICE, emoji: "🎉" });
  });
  for (let start = 0; start < threads; start += 250)
    doc = A.change(doc, (d) => {
      for (let i = start; i < Math.min(threads, start + 250); i++) {
        const owner = [ALICE, BOB, CAROL][i % 3];
        createThread(d, {
          threadId: `t-${i}`,
          messageId: `m-${i}-0`,
          anchor: blockAnchor,
          principal: owner,
          body: `Thread ${i} opens with a longer paragraph of text`,
          at: AT,
        });
        addMessage(d, {
          threadId: `t-${i}`,
          messageId: `m-${i}-1`,
          principal: [ALICE, BOB, CAROL][(i + 1) % 3],
          body: `Reply ${i}`,
          at: AT,
        });
        addReaction(d, {
          threadId: `t-${i}`,
          reactionId: `r-${i}`,
          principal: owner,
          emoji: "👀",
          target: `m-${i}-1`,
        });
      }
    });
  return doc;
}

/** One client session: a replica with its own actor, writing one change. */
function edit(doc, fn) {
  const replica = A.clone(doc, { actor: actor() });
  const next = A.change(replica, fn);
  return A.getChanges(doc, next);
}

function allowed(doc, changes, principal, options) {
  const result = admitCommentChanges(doc, changes, principal, options);
  assert.equal(result.ok, true, JSON.stringify(result.reason));
  return result;
}

function denied(doc, changes, principal, code, options) {
  const heads = A.getHeads(doc);
  const result = admitCommentChanges(doc, changes, principal, options);
  assert.equal(result.ok, false, `expected ${code}`);
  assert.equal(result.reason.code, code, JSON.stringify(result.reason));
  assert.deepEqual(A.getHeads(doc), heads, "the serving document is untouched");
  return result;
}

const thread = (doc) => doc.threads["t-alice"];

// Create thread

test("a commenter creates a thread as themself", () => {
  const doc = seed();
  const changes = edit(doc, (d) =>
    createThread(d, {
      threadId: "t-carol",
      messageId: "m-carol",
      anchor: selectionAnchor,
      principal: CAROL,
      body: "Carol asks",
    }),
  );
  const { doc: next } = allowed(doc, changes, CAROL);
  assert.equal(String(next.threads["t-carol"].created_by), CAROL);
  assert.equal(String(next.threads["t-carol"].messages["m-carol"].author), CAROL);
});

test("a forged created_by is rejected", () => {
  const doc = seed();
  const changes = edit(doc, (d) => {
    createThread(d, {
      threadId: "t-forged",
      messageId: "m-forged",
      anchor: blockAnchor,
      principal: CAROL,
      body: "Looks like Alice",
    });
    d.threads["t-forged"].created_by = s(ALICE);
  });
  denied(doc, changes, CAROL, REJECTION.CREATED_BY_MISMATCH);
});

test("a new thread's first message must be authored by the principal", () => {
  const doc = seed();
  const changes = edit(doc, (d) => {
    createThread(d, {
      threadId: "t-forged",
      messageId: "m-forged",
      anchor: blockAnchor,
      principal: CAROL,
      body: "Looks like Alice",
    });
    d.threads["t-forged"].messages["m-forged"].author = s(ALICE);
  });
  denied(doc, changes, CAROL, REJECTION.AUTHOR_MISMATCH);
});

test("a new thread needs a message, both maps, a valid status and a valid anchor", () => {
  const doc = seed();
  const base = { anchor: blockAnchor, status: s("open"), created_by: s(CAROL) };
  const cases = [
    { ...base, messages: {}, reactions: {} },
    { ...base, messages: {} },
    { ...base, status: s("closed"), messages: {}, reactions: {} },
    { ...base, anchor: { kind: "elsewhere" }, messages: {}, reactions: {} },
  ];
  for (const value of cases) {
    const changes = edit(doc, (d) => {
      d.threads["t-bad"] = value;
    });
    denied(doc, changes, CAROL, REJECTION.INVALID_VALUE);
  }
});

test("a new thread cannot carry unknown fields", () => {
  const doc = seed();
  const changes = edit(doc, (d) => {
    createThread(d, {
      threadId: "t-extra",
      messageId: "m-extra",
      anchor: blockAnchor,
      principal: CAROL,
      body: "Hello",
    });
    d.threads["t-extra"].pinned = true;
  });
  denied(doc, changes, CAROL, REJECTION.UNKNOWN_PATH);
});

test("an existing thread cannot be replaced or deleted", () => {
  const doc = seed();
  const replace = edit(doc, (d) =>
    createThread(d, {
      threadId: "t-alice",
      messageId: "m-takeover",
      anchor: blockAnchor,
      principal: CAROL,
      body: "Mine now",
    }),
  );
  denied(doc, replace, CAROL, REJECTION.THREAD_REPLACE);
  denied(doc, replace, ALICE, REJECTION.THREAD_REPLACE);
  const remove = edit(doc, (d) => {
    delete d.threads["t-alice"];
  });
  denied(doc, remove, ALICE, REJECTION.THREAD_DELETE);
});

// Add message

test("a commenter replies as themself", () => {
  const doc = seed();
  const changes = edit(doc, (d) =>
    addMessage(d, { threadId: "t-alice", messageId: "m-carol", principal: CAROL, body: "+1" }),
  );
  const { doc: next } = allowed(doc, changes, CAROL);
  assert.equal(String(thread(next).messages["m-carol"].author), CAROL);
});

test("a reply with someone else's author is rejected", () => {
  const doc = seed();
  const changes = edit(doc, (d) =>
    addMessage(d, { threadId: "t-alice", messageId: "m-fake", principal: ALICE, body: "I agree" }),
  );
  denied(doc, changes, CAROL, REJECTION.AUTHOR_MISMATCH);
});

test("an existing message cannot be replaced or hard-deleted", () => {
  const doc = seed();
  const replace = edit(doc, (d) =>
    addMessage(d, { threadId: "t-alice", messageId: "m-alice", principal: CAROL, body: "Gone" }),
  );
  denied(doc, replace, CAROL, REJECTION.MESSAGE_REPLACE);
  const remove = edit(doc, (d) => {
    delete d.threads["t-alice"].messages["m-alice"];
  });
  denied(doc, remove, ALICE, REJECTION.MESSAGE_DELETE);
});

// Edit or delete a message

test("an author edits and soft-deletes their own message", () => {
  const doc = seed();
  const edited = edit(doc, (d) =>
    editMessage(d, { threadId: "t-alice", messageId: "m-bob", body: "Bob, _revised_" }),
  );
  const { doc: next } = allowed(doc, edited, BOB);
  assert.equal(A.spans(thread(next).messages["m-bob"], ["body"]).at(-1).value, "revised");
  const removed = edit(next, (d) => deleteMessage(d, { threadId: "t-alice", messageId: "m-bob" }));
  assert.equal(thread(allowed(next, removed, BOB).doc).messages["m-bob"].deleted, true);
});

test("editing another author's message body is rejected", () => {
  const doc = seed();
  const changes = edit(doc, (d) =>
    editMessage(d, { threadId: "t-alice", messageId: "m-alice", body: "Alice says I win" }),
  );
  const { reason } = denied(doc, changes, CAROL, REJECTION.NOT_MESSAGE_AUTHOR);
  assert.deepEqual(reason.details.path.slice(0, 5), [
    "threads",
    "t-alice",
    "messages",
    "m-alice",
    "body",
  ]);
  // A single raw character splice is caught the same way.
  const splice = edit(doc, (d) =>
    A.splice(d, ["threads", "t-alice", "messages", "m-alice", "body"], 1, 0, "!"),
  );
  denied(doc, splice, BOB, REJECTION.NOT_MESSAGE_AUTHOR);
});

test("deleting another author's message is rejected", () => {
  const doc = seed();
  const changes = edit(doc, (d) => deleteMessage(d, { threadId: "t-alice", messageId: "m-alice" }));
  denied(doc, changes, BOB, REJECTION.NOT_MESSAGE_AUTHOR);
});

test("author and created_at are immutable, even for the author", () => {
  const doc = seed();
  for (const field of ["author", "created_at"]) {
    const changes = edit(doc, (d) => {
      d.threads["t-alice"].messages["m-bob"][field] = s(
        field === "author" ? CAROL : "2027-01-01T00:00:00.000Z",
      );
    });
    denied(doc, changes, BOB, REJECTION.IMMUTABLE_FIELD);
  }
});

test("an author's edit must leave a valid body", () => {
  const doc = seed();
  const empty = edit(doc, (d) => {
    const path = ["threads", "t-alice", "messages", "m-bob", "body"];
    A.splice(
      d,
      path,
      0,
      A.spans(d.threads["t-alice"].messages["m-bob"], ["body"]).at(-1).value.length + 1,
    );
  });
  denied(doc, empty, BOB, REJECTION.INVALID_VALUE);
  const badMark = edit(doc, (d) =>
    A.mark(
      d,
      ["threads", "t-alice", "messages", "m-bob", "body"],
      { start: 1, end: 3, expand: "none" },
      "blink",
      true,
    ),
  );
  denied(doc, badMark, BOB, REJECTION.INVALID_VALUE);
});

test("unknown message fields are rejected", () => {
  const doc = seed();
  const changes = edit(doc, (d) => {
    d.threads["t-alice"].messages["m-bob"].pinned = true;
  });
  denied(doc, changes, BOB, REJECTION.UNKNOWN_PATH);
});

// Change a thread's anchor

test("only the thread's creator moves its anchor", () => {
  const doc = seed();
  const changes = edit(doc, (d) =>
    setThreadAnchor(d, { threadId: "t-alice", anchor: selectionAnchor }),
  );
  const { doc: next } = allowed(doc, changes, ALICE);
  assert.equal(String(thread(next).anchor.kind), "selection");
  denied(doc, changes, BOB, REJECTION.NOT_THREAD_CREATOR);
  const nested = edit(doc, (d) => {
    d.threads["t-alice"].anchor.blockId = "block-9";
  });
  denied(doc, nested, CAROL, REJECTION.NOT_THREAD_CREATOR);
});

test("a moved anchor must keep the anchor shape", () => {
  const doc = seed();
  const changes = edit(doc, (d) =>
    setThreadAnchor(d, { threadId: "t-alice", anchor: { kind: "block" } }),
  );
  denied(doc, changes, ALICE, REJECTION.INVALID_VALUE);
});

test("a write into a superseded anchor is checked where its author put it", () => {
  const doc = seed();
  // Two of Alice's sessions race. The second writes into the anchor map the
  // first replaced, so that object is no longer visible after the merge.
  const moved = edit(doc, (d) =>
    setThreadAnchor(d, { threadId: "t-alice", anchor: selectionAnchor }),
  );
  const late = edit(doc, (d) => {
    d.threads["t-alice"].anchor.blockId = "block-9";
  });
  const { doc: next } = allowed(doc, moved, ALICE);
  const result = allowed(next, late, ALICE);
  assert.ok(result.stats.pathLookups > 1, "resolved at the change's own heads");
  denied(next, late, BOB, REJECTION.NOT_THREAD_CREATOR);
});

// Resolve or reopen a thread

test("any commenter resolves or reopens a thread", () => {
  const doc = seed();
  const resolved = edit(doc, (d) =>
    setThreadStatus(d, { threadId: "t-alice", status: "resolved" }),
  );
  const { doc: next } = allowed(doc, resolved, CAROL);
  assert.equal(String(thread(next).status), "resolved");
  const reopened = edit(next, (d) => setThreadStatus(d, { threadId: "t-alice", status: "open" }));
  assert.equal(String(thread(allowed(next, reopened, BOB).doc).status), "open");
});

test("status must stay open or resolved", () => {
  const doc = seed();
  const bogus = edit(doc, (d) => {
    d.threads["t-alice"].status = s("archived");
  });
  denied(doc, bogus, BOB, REJECTION.INVALID_VALUE);
  const removed = edit(doc, (d) => {
    delete d.threads["t-alice"].status;
  });
  denied(doc, removed, BOB, REJECTION.INVALID_VALUE);
});

test("an invalid status that loses a conflict is still rejected", () => {
  const doc = seed();
  const good = edit(doc, (d) => setThreadStatus(d, { threadId: "t-alice", status: "resolved" }));
  const bad = edit(doc, (d) => {
    d.threads["t-alice"].status = s("archived");
  });
  denied(doc, [...good, ...bad], BOB, REJECTION.INVALID_VALUE);
});

// Add a reaction

test("a commenter reacts as themself", () => {
  const doc = seed();
  const changes = edit(doc, (d) =>
    addReaction(d, {
      threadId: "t-alice",
      reactionId: "r-carol",
      principal: CAROL,
      emoji: "❤️",
      target: "m-bob",
    }),
  );
  const { doc: next } = allowed(doc, changes, CAROL);
  assert.equal(String(thread(next).reactions["r-carol"].principal), CAROL);
});

test("a reaction in someone else's name is rejected", () => {
  const doc = seed();
  const changes = edit(doc, (d) =>
    addReaction(d, { threadId: "t-alice", reactionId: "r-fake", principal: ALICE, emoji: "👎" }),
  );
  denied(doc, changes, CAROL, REJECTION.REACTION_PRINCIPAL_MISMATCH);
});

test("a reaction must target the thread or one of its messages", () => {
  const doc = seed();
  const changes = edit(doc, (d) =>
    addReaction(d, {
      threadId: "t-alice",
      reactionId: "r-carol",
      principal: CAROL,
      emoji: "👍",
      target: "m-missing",
    }),
  );
  denied(doc, changes, CAROL, REJECTION.INVALID_VALUE);
});

test("two writes creating one reaction ID in a batch are rejected", () => {
  const doc = seed();
  // The forged entry could lose the conflict now and surface after the
  // valid one is removed. A created entry must have exactly one value.
  const valid = edit(doc, (d) =>
    addReaction(d, { threadId: "t-alice", reactionId: "r-dup", principal: CAROL, emoji: "👍" }),
  );
  const forged = edit(doc, (d) =>
    addReaction(d, { threadId: "t-alice", reactionId: "r-dup", principal: BOB, emoji: "👎" }),
  );
  denied(doc, [...valid, ...forged], CAROL, REJECTION.CONFLICTING_CREATE);
});

test("conflicting entries inside a thread the batch creates are rejected", () => {
  const doc = seed();
  const replica = A.clone(doc, { actor: actor() });
  const created = A.change(replica, (d) =>
    createThread(d, {
      threadId: "t-carol",
      messageId: "m-carol",
      anchor: blockAnchor,
      principal: CAROL,
      body: "New",
    }),
  );
  const branch = (fn) => A.getChanges(created, A.change(A.clone(created, { actor: actor() }), fn));
  const valid = branch((d) =>
    addReaction(d, { threadId: "t-carol", reactionId: "r-dup", principal: CAROL, emoji: "👍" }),
  );
  const forged = branch((d) =>
    addReaction(d, { threadId: "t-carol", reactionId: "r-dup", principal: ALICE, emoji: "👎" }),
  );
  const batch = [...A.getChanges(doc, created), ...valid, ...forged];
  denied(doc, batch, CAROL, REJECTION.CONFLICTING_CREATE);
});

// Remove a reaction

test("only a reaction's principal removes it", () => {
  const doc = seed();
  const changes = edit(doc, (d) => removeReaction(d, { threadId: "t-alice", reactionId: "r-bob" }));
  const { doc: next } = allowed(doc, changes, BOB);
  assert.equal(Object.hasOwn(thread(next).reactions, "r-bob"), false);
  denied(doc, changes, CAROL, REJECTION.NOT_REACTION_OWNER);
});

test("two sessions removing the same reaction both succeed", () => {
  const doc = seed();
  const first = edit(doc, (d) => removeReaction(d, { threadId: "t-alice", reactionId: "r-bob" }));
  const second = edit(doc, (d) => removeReaction(d, { threadId: "t-alice", reactionId: "r-bob" }));
  const { doc: next } = allowed(doc, first, BOB);
  allowed(next, second, BOB);
});

test("rewriting another author's reaction is rejected", () => {
  const doc = seed();
  const emoji = edit(doc, (d) => {
    d.threads["t-alice"].reactions["r-bob"].emoji = s("👎");
  });
  denied(doc, emoji, CAROL, REJECTION.NOT_REACTION_OWNER);
  const takeover = edit(doc, (d) =>
    addReaction(d, { threadId: "t-alice", reactionId: "r-bob", principal: CAROL, emoji: "👎" }),
  );
  denied(doc, takeover, CAROL, REJECTION.NOT_REACTION_OWNER);
  // The owner removes and re-adds; a reaction itself never changes.
  denied(doc, emoji, BOB, REJECTION.IMMUTABLE_FIELD);
});

// origin and unknown paths

test("origin is immutable for every commenter", () => {
  const doc = seed();
  const changes = edit(doc, (d) => {
    d.origin = s("evil.example");
  });
  for (const principal of [ALICE, BOB, CAROL])
    denied(doc, changes, principal, REJECTION.ORIGIN_IMMUTABLE);
});

test("unknown paths and structural replacements are rejected", () => {
  const doc = seed();
  const cases = [
    [(d) => (d.title = s("Comments")), REJECTION.UNKNOWN_PATH],
    [(d) => (d.threads["t-alice"].pinned = true), REJECTION.UNKNOWN_PATH],
    [(d) => (d.threads = {}), REJECTION.IMMUTABLE_FIELD],
    [(d) => (d.threads["t-alice"].messages = {}), REJECTION.IMMUTABLE_FIELD],
    [(d) => (d.threads["t-alice"].reactions = {}), REJECTION.IMMUTABLE_FIELD],
    [(d) => (d.threads["t-alice"].created_by = s(CAROL)), REJECTION.IMMUTABLE_FIELD],
  ];
  for (const [fn, code] of cases) denied(doc, edit(doc, fn), ALICE, code);
});

// Batches and attribution

test("one bad change rejects the whole batch with its hash", () => {
  const doc = seed();
  const good = edit(doc, (d) =>
    addMessage(d, { threadId: "t-alice", messageId: "m-carol", principal: CAROL, body: "Fine" }),
  );
  const bad = edit(doc, (d) =>
    editMessage(d, { threadId: "t-alice", messageId: "m-bob", body: "Not fine" }),
  );
  const { reason } = denied(doc, [...good, ...bad], CAROL, REJECTION.NOT_MESSAGE_AUTHOR);
  assert.equal(reason.change, A.decodeChange(bad[0]).hash);
});

test("changes with missing dependencies are rejected, not queued", () => {
  const doc = seed();
  const replica = A.clone(doc, { actor: actor() });
  const one = A.change(replica, (d) =>
    addMessage(d, { threadId: "t-alice", messageId: "m-1", principal: CAROL, body: "One" }),
  );
  const two = A.change(one, (d) =>
    addMessage(d, { threadId: "t-alice", messageId: "m-2", principal: CAROL, body: "Two" }),
  );
  denied(doc, A.getChanges(one, two), CAROL, REJECTION.MISSING_DEPENDENCIES);
});

test("undecodable bytes are rejected", () => {
  denied(seed(), [new Uint8Array([1, 2, 3])], CAROL, REJECTION.MALFORMED_CHANGE);
});

test("a principal is required", () => {
  const doc = seed();
  const result = admitCommentChanges(doc, [], "");
  assert.equal(result.reason.code, REJECTION.INVALID_PRINCIPAL);
});

test("changes the document already holds are not attributed again", () => {
  const doc = seed();
  // Bob's earlier reply is resent by Carol, for example after a reconnect.
  const resent = A.getAllChanges(doc);
  const { stats } = allowed(doc, resent, CAROL);
  assert.equal(stats.changes, 0);
});

test("an Automerge actor stays with the principal that first used it", () => {
  const doc = seed();
  const changes = edit(doc, (d) =>
    addMessage(d, { threadId: "t-alice", messageId: "m-carol", principal: CAROL, body: "Hi" }),
  );
  const { actor: used } = A.decodeChange(changes[0]);
  const owners = new Map([[used, BOB]]);
  denied(doc, changes, CAROL, REJECTION.ACTOR_CLAIMED, { actorPrincipal: (a) => owners.get(a) });
  const { actors } = allowed(doc, changes, CAROL, { actorPrincipal: () => undefined });
  assert.deepEqual(actors, [used]);
});

test("authority keys on the principal, not the session", () => {
  const doc = seed();
  // Two of Bob's sessions, with separate actors and session labels, can edit
  // each other's messages. Labels never reach this check.
  const first = edit(doc, (d) =>
    addMessage(d, {
      threadId: "t-alice",
      messageId: "m-bob-2",
      principal: BOB,
      body: "From the CLI",
    }),
  );
  const { doc: next } = allowed(doc, first, BOB);
  const second = edit(next, (d) =>
    editMessage(d, { threadId: "t-alice", messageId: "m-bob-2", body: "From the browser" }),
  );
  allowed(next, second, BOB);
});

test("concurrent changes from two authors are each admitted and merge", () => {
  const doc = seed();
  const alice = edit(doc, (d) => {
    editMessage(d, { threadId: "t-alice", messageId: "m-alice", body: "Alice, revised" });
    addReaction(d, { threadId: "t-alice", reactionId: "r-alice-2", principal: ALICE, emoji: "✅" });
  });
  const bob = edit(doc, (d) => {
    setThreadStatus(d, { threadId: "t-alice", status: "resolved" });
    editMessage(d, { threadId: "t-alice", messageId: "m-bob", body: "Bob, revised" });
    removeReaction(d, { threadId: "t-alice", reactionId: "r-bob" });
  });
  const ab = allowed(allowed(doc, alice, ALICE).doc, bob, BOB).doc;
  const ba = allowed(allowed(doc, bob, BOB).doc, alice, ALICE).doc;
  assert.deepEqual(A.getHeads(ab).sort(), A.getHeads(ba).sort());
  assert.deepEqual(A.toJS(ab), A.toJS(ba));
  assert.equal(String(thread(ab).status), "resolved");
  assert.deepEqual(Object.keys(thread(ab).reactions).sort(), ["r-alice", "r-alice-2"]);
  // Concurrent creation of one thread ID: the second arrival is refused.
  const carol = edit(doc, (d) =>
    createThread(d, {
      threadId: "t-new",
      messageId: "m-c",
      anchor: blockAnchor,
      principal: CAROL,
      body: "C",
    }),
  );
  const bobNew = edit(doc, (d) =>
    createThread(d, {
      threadId: "t-new",
      messageId: "m-b",
      anchor: blockAnchor,
      principal: BOB,
      body: "B",
    }),
  );
  denied(allowed(doc, carol, CAROL).doc, bobNew, BOB, REJECTION.THREAD_REPLACE);
});

// Cost

test("the check's work depends on the change, not the document", (t) => {
  const small = seed();
  const large = seed(3000);
  const reply = (d) => {
    addMessage(d, { threadId: "t-alice", messageId: "m-carol", principal: CAROL, body: "A reply" });
    setThreadStatus(d, { threadId: "t-alice", status: "resolved" });
    addReaction(d, { threadId: "t-alice", reactionId: "r-carol", principal: CAROL, emoji: "👍" });
  };
  const measure = (doc) => {
    const changes = edit(doc, reply);
    const started = performance.now();
    const result = allowed(doc, changes, CAROL);
    const ms = performance.now() - started;
    A.free(result.doc);
    // The native clone and apply are the only steps that see the whole doc.
    const cloneStarted = performance.now();
    const copy = A.applyChanges(A.clone(doc), changes)[0];
    const cloneMs = performance.now() - cloneStarted;
    A.free(copy);
    return { stats: result.stats, ms, cloneMs, bytes: A.save(doc).length };
  };
  measure(small);
  measure(large);
  const a = measure(small);
  const b = measure(large);
  assert.ok(b.bytes > 100 * a.bytes, `large doc is ${b.bytes} bytes`);
  assert.deepEqual(b.stats, a.stats);
  assert.ok(a.stats.entityReads <= 3);
  t.diagnostic(
    `small ${a.bytes} B: ${a.ms.toFixed(2)} ms (clone+apply ${a.cloneMs.toFixed(2)}); ` +
      `large ${b.bytes} B: ${b.ms.toFixed(2)} ms (clone+apply ${b.cloneMs.toFixed(2)}); ` +
      JSON.stringify(b.stats),
  );
});
