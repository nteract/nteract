import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { EntitySet, REJECTION, admitCommentChanges } from "./comment-authority.mjs";
import { applyComment } from "./comments.mjs";
import { commentDecision } from "./comment-rules.mjs";
import { commentsGenesis } from "./comments-doc.mjs";

const ALICE = "account:alice";
const BOB = "account:bob";
const UUID = "0f5db4ee-ab47-48e4-a0e2-facc277a3efe";
const actor = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
const who = (principal) => ({ principal, displayName: principal.slice(8), driver: "Browser" });
const page = A.from({
  blocks: { b1: { id: "b1", markdown: "One" }, b2: { id: "b2", markdown: "Two" } },
});

/** Alice's thread (her first message, then Bob's reply) and Bob's thread. */
function seed() {
  let doc = A.clone(commentsGenesis(UUID), { actor: actor() });
  const ids = {};
  doc = A.change(doc, (d) => {
    const alice = applyComment(d, { block_id: "b1", body: "Alice opens" }, who(ALICE), null, {
      page,
      role: "editor",
    });
    const reply = applyComment(
      d,
      { action: "reply", thread_id: alice.thread_id, body: "Bob replies" },
      who(BOB),
      null,
      { page, role: "commenter" },
    );
    const bob = applyComment(d, { block_id: "b2", body: "Bob opens" }, who(BOB), null, {
      page,
      role: "commenter",
    });
    Object.assign(ids, {
      aliceThread: alice.thread_id,
      aliceMessage: alice.message_id,
      bobReply: reply.message_id,
      bobThread: bob.thread_id,
      bobMessage: bob.message_id,
    });
  });
  return { doc, ids };
}

/** The changes `fn` makes on a fork of `doc` with a fresh actor. */
function changesOf(doc, fn) {
  const fork = A.clone(doc, { actor: actor() });
  const next = A.change(fork, fn);
  return A.getChanges(doc, next);
}

function admit(doc, principal, role, fn) {
  const result = admitCommentChanges(doc, changesOf(doc, fn), principal, { role });
  if (result.ok) A.free(result.next);
  return result;
}

const now = () => new Date().toISOString();

/** Raw writes, bypassing comment-rules: what a hostile peer could sync. */
const RAW = {
  add: (d) => {
    d.threads.newthread = {
      target: { kind: "block", blockId: "b1" },
      author: who(RAW.principal),
      createdAt: now(),
      status: { value: "open", at: now() },
      messages: {
        m1: { body: "hello", author: who(RAW.principal), createdAt: now(), deletedAt: null },
      },
    };
  },
  reply: (d, ids) => {
    d.threads[ids.thread].messages.newreply = {
      body: "reply",
      author: who(RAW.principal),
      createdAt: now(),
      deletedAt: null,
    };
  },
  resolve: (d, ids) => {
    d.threads[ids.thread].status = { value: "resolved", at: now() };
  },
  reopen: (d, ids) => {
    d.threads[ids.thread].status = { value: "open", at: now() };
  },
  edit: (d, ids) => {
    A.updateText(d, ["threads", ids.thread, "messages", ids.message, "body"], "rewritten");
  },
  delete_message: (d, ids) => {
    d.threads[ids.thread].messages[ids.message].deletedAt = now();
  },
  delete_thread: (d, ids) => {
    delete d.threads[ids.thread];
  },
  move_anchor: (d, ids) => {
    d.threads[ids.thread].target = { kind: "block", blockId: "b2" };
  },
};

// The state × event table. A state is the acting principal's role and
// whether the thread and message the action touches are its own. Every cell
// is written out, then checked three ways: against comment-rules, against
// the tools (applyComment), and against native admission of a raw change.
const Y = true,
  N = false;
const TABLE = {
  //            add reply resolve reopen edit delete_message delete_thread move_anchor
  "owner/own": [Y, Y, Y, Y, Y, Y, Y, Y],
  "owner/other": [Y, Y, Y, Y, N, N, Y, N],
  "editor/own": [Y, Y, Y, Y, Y, Y, Y, Y],
  "editor/other": [Y, Y, Y, Y, N, N, Y, N],
  "commenter/own": [Y, Y, Y, Y, Y, Y, Y, Y],
  "commenter/other": [Y, Y, Y, Y, N, N, N, N],
  "viewer/own": [N, N, N, N, N, N, N, N],
  "viewer/other": [N, N, N, N, N, N, N, N],
};
const EVENTS = [
  "add",
  "reply",
  "resolve",
  "reopen",
  "edit",
  "delete_message",
  "delete_thread",
  "move_anchor",
];

for (const [state, expected] of Object.entries(TABLE)) {
  const [role, ownership] = state.split("/");
  for (const [index, event] of EVENTS.entries()) {
    test(`per-author table: ${role} on ${ownership === "own" ? "its own" : "another's"} thread, ${event} → ${expected[index] ? "allowed" : "refused"}`, () => {
      const { doc, ids } = seed();
      // Bob acts. "own" targets Bob's thread and message; "other" targets
      // Alice's thread and her first message.
      const target =
        ownership === "own"
          ? { thread: ids.bobThread, message: ids.bobMessage }
          : { thread: ids.aliceThread, message: ids.aliceMessage };
      const thread = doc.threads[target.thread];
      const message = thread.messages[target.message];
      const decision = commentDecision({ action: event, role, principal: BOB, thread, message });
      assert.equal(decision.allowed, expected[index], "comment-rules");

      if (event !== "move_anchor") {
        const input = {
          action: event,
          ...(event !== "add" && { thread_id: target.thread }),
          ...(["edit", "delete_message"].includes(event) && { message_id: target.message }),
          ...(event === "add" && { block_id: "b1" }),
          ...(["add", "reply", "edit"].includes(event) && { body: "text" }),
        };
        let toolError;
        const fork = A.clone(doc, { actor: actor() });
        try {
          A.change(fork, (d) => applyComment(d, input, who(BOB), null, { page, role }));
        } catch (error) {
          toolError = error;
        }
        assert.equal(!toolError, expected[index], `tools: ${toolError?.message}`);
        if (toolError) assert.ok([403].includes(toolError.status), toolError.message);
      }

      // Native admission never sees a viewer's put: the policy refuses it
      // first. The checker refuses it anyway.
      RAW.principal = BOB;
      const result = admit(doc, BOB, role, (d) => RAW[event](d, target));
      assert.equal(result.ok, expected[index], `native: ${JSON.stringify(result.reason)}`);
    });
  }
}

test("a forged author on a new thread or reply is refused", () => {
  const { doc, ids } = seed();
  RAW.principal = ALICE;
  assert.equal(
    admit(doc, BOB, "commenter", (d) => RAW.add(d)).reason.code,
    REJECTION.AUTHOR_MISMATCH,
  );
  assert.equal(
    admit(doc, BOB, "editor", (d) => RAW.reply(d, { thread: ids.aliceThread })).reason.code,
    REJECTION.AUTHOR_MISMATCH,
  );
});

test("author and createdAt are immutable, even for the author", () => {
  const { doc, ids } = seed();
  const result = admit(doc, BOB, "commenter", (d) => {
    d.threads[ids.bobThread].messages[ids.bobMessage].author = who(ALICE);
  });
  assert.equal(result.reason.code, REJECTION.IMMUTABLE_FIELD);
  const created = admit(doc, BOB, "commenter", (d) => {
    d.threads[ids.bobThread].createdAt = now();
  });
  assert.equal(created.reason.code, REJECTION.IMMUTABLE_FIELD);
});

test("messages are soft-deleted; removing or replacing one is refused", () => {
  const { doc, ids } = seed();
  const removed = admit(doc, BOB, "editor", (d) => {
    delete d.threads[ids.bobThread].messages[ids.bobMessage];
  });
  assert.equal(removed.reason.code, REJECTION.MESSAGE_DELETE);
  const replaced = admit(doc, BOB, "editor", (d) => {
    d.threads[ids.bobThread].messages[ids.bobMessage] = {
      body: "x",
      author: who(BOB),
      createdAt: now(),
      deletedAt: null,
    };
  });
  assert.equal(replaced.reason.code, REJECTION.MESSAGE_REPLACE);
});

test("an existing thread cannot be replaced, and threads cannot be replaced at all", () => {
  const { doc, ids } = seed();
  RAW.principal = BOB;
  const replaced = admit(doc, BOB, "owner", (d) => {
    d.threads[ids.bobThread] = {
      target: { kind: "block", blockId: "b1" },
      author: who(BOB),
      createdAt: now(),
      status: { value: "open", at: now() },
      messages: {},
    };
  });
  assert.equal(replaced.reason.code, REJECTION.THREAD_REPLACE);
  const root = admit(doc, BOB, "owner", (d) => {
    d.threads = {};
  });
  assert.equal(root.reason.code, REJECTION.IMMUTABLE_FIELD);
});

test("a new thread needs a valid anchor, status and first message, and no unknown fields", () => {
  const { doc } = seed();
  const base = () => ({
    target: { kind: "block", blockId: "b1" },
    author: who(BOB),
    createdAt: now(),
    status: { value: "open", at: now() },
    messages: { m1: { body: "hello", author: who(BOB), createdAt: now(), deletedAt: null } },
  });
  for (const [label, patch] of [
    ["anchor", { target: { kind: "elsewhere" } }],
    ["status", { status: { value: "archived", at: now() } }],
    ["messages", { messages: {} }],
    ["unknown field", { reactions: {} }],
  ]) {
    const result = admit(doc, BOB, "commenter", (d) => {
      d.threads.fresh = { ...base(), ...patch };
    });
    assert.equal(result.ok, false, label);
  }
  assert.equal(
    admit(doc, BOB, "commenter", (d) => {
      d.threads.fresh = base();
    }).ok,
    true,
  );
});

test("an empty or oversized body is refused", () => {
  const { doc, ids } = seed();
  const empty = admit(doc, BOB, "commenter", (d) => {
    A.updateText(d, ["threads", ids.bobThread, "messages", ids.bobMessage, "body"], "   ");
  });
  assert.equal(empty.reason.code, REJECTION.INVALID_VALUE);
  const large = admit(doc, BOB, "commenter", (d) => {
    A.updateText(
      d,
      ["threads", ids.bobThread, "messages", ids.bobMessage, "body"],
      "x".repeat(16001),
    );
  });
  assert.equal(large.reason.code, REJECTION.INVALID_VALUE);
});

test("a rich reply written by the tools passes native admission", () => {
  const { doc, ids } = seed();
  const changes = changesOf(doc, (d) =>
    applyComment(
      d,
      {
        action: "reply",
        thread_id: ids.aliceThread,
        body: "| a | b |\n| - | - |\n| 1 | ~~2~~ |",
        body_format: "markdown",
      },
      who(BOB),
      null,
      { page, role: "commenter" },
    ),
  );
  const result = admitCommentChanges(doc, changes, BOB, { role: "commenter" });
  assert.equal(result.ok, true, JSON.stringify(result.reason));
  A.free(result.next);
});

test("a stamp may name only features this build knows", () => {
  const { doc } = seed();
  const result = admit(doc, BOB, "commenter", (d) => {
    d.schema = { features: ["from-the-future"] };
  });
  assert.equal(result.reason.code, REJECTION.UNSUPPORTED_FEATURE);
  assert.equal(
    admit(doc, BOB, "commenter", (d) => {
      d.schema = { features: ["strike"] };
    }).ok,
    true,
  );
});

test("a reply racing its thread's deletion is admitted and changes nothing visible", () => {
  const { doc, ids } = seed();
  // Alice (editor) deletes her thread while Bob replies to it concurrently.
  const reply = changesOf(doc, (d) => {
    RAW.principal = BOB;
    RAW.reply(d, { thread: ids.aliceThread });
  });
  const deleted = admitCommentChanges(
    doc,
    changesOf(doc, (d) => RAW.delete_thread(d, { thread: ids.aliceThread })),
    ALICE,
    { role: "editor" },
  );
  assert.equal(deleted.ok, true);
  const raced = admitCommentChanges(deleted.next, reply, BOB, { role: "commenter" });
  assert.equal(raced.ok, true, JSON.stringify(raced.reason));
  assert.equal(Object.hasOwn(raced.next.threads, ids.aliceThread), false);
  A.free(deleted.next);
  A.free(raced.next);
});

test("unknown root paths are refused", () => {
  const { doc } = seed();
  assert.equal(
    admit(doc, BOB, "owner", (d) => {
      d.origin = "elsewhere";
    }).reason.code,
    REJECTION.UNKNOWN_PATH,
  );
});

test("one bad change rejects the whole batch with its hash", () => {
  const { doc, ids } = seed();
  const fork = A.clone(doc, { actor: actor() });
  const good = A.change(fork, (d) => RAW.resolve(d, { thread: ids.aliceThread }));
  const bad = A.change(good, (d) =>
    RAW.edit(d, { thread: ids.aliceThread, message: ids.aliceMessage }),
  );
  const changes = A.getChanges(doc, bad);
  const result = admitCommentChanges(doc, changes, BOB, { role: "commenter" });
  assert.equal(result.ok, false);
  assert.equal(result.reason.code, REJECTION.NOT_MESSAGE_AUTHOR);
  assert.equal(result.reason.change, A.decodeChange(changes[1]).hash);
});

test("changes with missing dependencies are refused, not queued", () => {
  const { doc, ids } = seed();
  const fork = A.clone(doc, { actor: actor() });
  const first = A.change(fork, (d) => RAW.resolve(d, { thread: ids.aliceThread }));
  const second = A.change(first, (d) => RAW.reopen(d, { thread: ids.aliceThread }));
  const result = admitCommentChanges(doc, A.getChanges(first, second), BOB, { role: "commenter" });
  assert.equal(result.reason.code, REJECTION.MISSING_DEPENDENCIES);
});

test("undecodable bytes, a missing principal and a non-commenting role are refused", () => {
  const { doc } = seed();
  assert.equal(
    admitCommentChanges(doc, [new Uint8Array([1, 2, 3])], BOB, { role: "editor" }).reason.code,
    REJECTION.MALFORMED_CHANGE,
  );
  assert.equal(
    admitCommentChanges(doc, [], "", { role: "editor" }).reason.code,
    REJECTION.INVALID_PRINCIPAL,
  );
  assert.equal(
    admitCommentChanges(doc, [], BOB, { role: "viewer" }).reason.code,
    REJECTION.NOT_ALLOWED,
  );
});

test("changes the document already holds are not attributed again", () => {
  const { doc } = seed();
  const held = A.getAllChanges(doc);
  const result = admitCommentChanges(doc, held, BOB, { role: "commenter" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.actors, []);
  A.free(result.next);
});

test("an Automerge actor stays with the principal that first used it", () => {
  const { doc, ids } = seed();
  const changes = changesOf(doc, (d) => RAW.resolve(d, { thread: ids.aliceThread }));
  const result = admitCommentChanges(doc, changes, BOB, {
    role: "commenter",
    actorPrincipal: () => ALICE,
  });
  assert.equal(result.reason.code, REJECTION.ACTOR_CLAIMED);
});

test("authority keys on the principal, not the session label", () => {
  const { doc, ids } = seed();
  // Another session of Bob, with a different display name and driver,
  // edits Bob's message.
  const result = admit(doc, BOB, "commenter", (d) =>
    applyComment(
      d,
      { action: "edit", thread_id: ids.bobThread, message_id: ids.bobMessage, body: "Edited" },
      { principal: BOB, displayName: "release agent", driver: "Kilo" },
      null,
      { page, role: "commenter" },
    ),
  );
  assert.equal(result.ok, true, JSON.stringify(result.reason));
});

test("concurrent creates of one absent ID: exactly one is accepted, in queue order", () => {
  const { doc } = seed();
  const create = (principal) =>
    changesOf(doc, (d) => {
      RAW.principal = principal;
      RAW.add(d);
    });
  const first = admitCommentChanges(doc, create(BOB), BOB, { role: "commenter" });
  assert.equal(first.ok, true);
  const second = admitCommentChanges(first.next, create(ALICE), ALICE, { role: "editor" });
  assert.equal(second.ok, false);
  // The second create meets a thread that now exists: a replacement.
  assert.equal(second.reason.code, REJECTION.THREAD_REPLACE);
  A.free(first.next);
});

test("entity sets keep (thread, id) pairs distinct", () => {
  const set = new EntitySet();
  set.add("a", "b-c");
  set.add("a-b", "c");
  assert.equal([...set].length, 2);
  assert.equal(set.has("a", "b-c"), true);
  assert.equal(set.has("a", "c"), false);
});
