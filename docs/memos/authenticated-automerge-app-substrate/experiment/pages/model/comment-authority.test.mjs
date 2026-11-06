import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { EntitySet, REJECTION, admitCommentChanges } from "./comment-authority.mjs";
import { applyComment } from "./comments.mjs";
import { commentDecision } from "./comment-rules.mjs";
import { commentsGenesis } from "./comments-doc.mjs";
import { editorCommentSpans, markdownCommentSpans } from "./comment-content.mjs";
import { adapterSpans } from "./richtext-spans.mjs";
import { BLOCKING } from "../sync/comments.mjs";
import { parseMarkdown } from "./markdown-import.mjs";
import { RICH_FORMAT } from "./richtext-format.mjs";

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
/** A message as this build writes it: rich text, no `body`. */
const richMessage = (text, principal) => ({
  format: RICH_FORMAT,
  richText: text,
  author: who(principal),
  createdAt: now(),
  deletedAt: null,
});

/** Raw writes, bypassing comment-rules: what a hostile peer could sync. */
const RAW = {
  add: (d) => {
    d.threads.newthread = {
      target: { kind: "block", blockId: "b1" },
      author: who(RAW.principal),
      createdAt: now(),
      status: { value: "open", at: now() },
      messages: {
        m1: richMessage("hello", RAW.principal),
      },
    };
  },
  reply: (d, ids) => {
    d.threads[ids.thread].messages.newreply = richMessage("reply", RAW.principal);
  },
  resolve: (d, ids) => {
    d.threads[ids.thread].status = { value: "resolved", at: now() };
  },
  reopen: (d, ids) => {
    d.threads[ids.thread].status = { value: "open", at: now() };
  },
  edit: (d, ids) => {
    A.updateText(d, ["threads", ids.thread, "messages", ids.message, "richText"], "rewritten");
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
    messages: { m1: richMessage("hello", BOB) },
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

test("empty or oversized content is refused; markers don't count toward the length", () => {
  const { doc, ids } = seed();
  const text = ["threads", ids.bobThread, "messages", ids.bobMessage, "richText"];
  const empty = admit(doc, BOB, "commenter", (d) => {
    A.updateText(d, text, "   ");
  });
  assert.equal(empty.reason.code, REJECTION.INVALID_VALUE);
  const large = admit(doc, BOB, "commenter", (d) => {
    A.updateText(d, text, "x".repeat(16001));
  });
  assert.equal(large.reason.code, REJECTION.INVALID_VALUE);
  // 16000 characters in 100 list items: within the limit.
  const list = Array.from({ length: 100 }, () => `- ${"x".repeat(160)}`).join("\n");
  const items = admit(doc, BOB, "commenter", (d) => {
    A.updateSpans(d, text, markdownCommentSpans(list));
  });
  assert.equal(items.ok, true, JSON.stringify(items.reason));
});

test("a new message is rich text; a bare literal body is refused", () => {
  const { doc, ids } = seed();
  const bare = admit(doc, BOB, "commenter", (d) => {
    d.threads[ids.aliceThread].messages.bare = {
      body: "hello",
      author: who(BOB),
      createdAt: now(),
      deletedAt: null,
    };
  });
  assert.equal(bare.reason.code, REJECTION.OUTDATED_FORM);
  assert.match(bare.reason.message, /body/);
  // A message map without the rich format is an earlier build's too.
  const formless = admit(doc, BOB, "commenter", (d) => {
    const { format: _format, ...rest } = richMessage("hello", BOB);
    d.threads[ids.aliceThread].messages.formless = rest;
  });
  assert.equal(formless.reason.code, REJECTION.OUTDATED_FORM);
  assert.match(formless.reason.message, /rich text/);
  // An earlier build's tab still writes a Markdown copy: refused.
  const copy = admit(doc, BOB, "commenter", (d) => {
    d.threads[ids.aliceThread].messages.copy = { ...richMessage("hello", BOB), body: "hello" };
  });
  assert.equal(copy.reason?.code, REJECTION.OUTDATED_FORM);
  assert.match(copy.reason.message, /body/);
  for (const bodyFormat of ["markdown", "html"]) {
    const result = admit(doc, BOB, "commenter", (d) => {
      d.threads[ids.aliceThread].messages.format = { ...richMessage("hello", BOB), bodyFormat };
    });
    assert.equal(result.reason.code, REJECTION.INVALID_VALUE, bodyFormat);
  }
  const plain = admit(doc, BOB, "commenter", (d) => {
    d.threads[ids.aliceThread].messages.plain = {
      ...richMessage("hello", BOB),
      bodyFormat: "plain",
    };
  });
  assert.equal(plain.ok, true, JSON.stringify(plain.reason));
});

test("an existing literal-body message is refused, even for a soft delete", () => {
  const { doc: seeded, ids } = seed();
  // A message in the shape earlier builds stored, which the comments
  // migration rewrote everywhere.
  const doc = A.change(seeded, (d) => {
    d.threads[ids.bobThread].messages[ids.bobMessage] = {
      body: "Bob opens",
      author: who(BOB),
      createdAt: now(),
      deletedAt: null,
    };
  });
  const path = ["threads", ids.bobThread, "messages", ids.bobMessage];
  const deleted = admit(doc, BOB, "commenter", (d) => {
    d.threads[ids.bobThread].messages[ids.bobMessage].deletedAt = now();
  });
  assert.equal(deleted.reason?.code, REJECTION.OUTDATED_FORM);
  const emptied = admit(doc, BOB, "commenter", (d) => {
    A.updateText(d, [...path, "body"], " ");
  });
  assert.equal(emptied.reason?.code, REJECTION.OUTDATED_FORM);
  // The tools refuse to rewrite it rather than guess at its form.
  assert.throws(
    () =>
      changesOf(doc, (d) =>
        applyComment(
          d,
          { action: "edit", thread_id: ids.bobThread, message_id: ids.bobMessage, body: "Now" },
          who(BOB),
          null,
          { page, role: "commenter" },
        ),
      ),
    { code: "stored_form_unsupported" },
  );
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

test("every write leaves a message in the editor's span form", () => {
  const { doc: seeded, ids } = seed();
  // Two paragraphs: the adapter's form opens with a paragraph marker the
  // editor never writes.
  const adapter = adapterSpans(parseMarkdown("One\n\nTwo"));
  const created = admit(seeded, BOB, "commenter", (d) => {
    d.threads[ids.aliceThread].messages.adapter = richMessage("", BOB);
    A.updateSpans(d, ["threads", ids.aliceThread, "messages", "adapter", "richText"], adapter);
  });
  assert.equal(created.reason?.code, REJECTION.OUTDATED_FORM);
  assert.match(created.reason.message, /editor/);
  const bobText = ["threads", ids.bobThread, "messages", ids.bobMessage, "richText"];
  const edited = admit(seeded, BOB, "commenter", (d) => A.updateSpans(d, bobText, adapter));
  assert.equal(edited.reason?.code, REJECTION.OUTDATED_FORM);
  const editor = admit(seeded, BOB, "commenter", (d) =>
    A.updateSpans(d, bobText, markdownCommentSpans("One\n\nTwo")),
  );
  assert.equal(editor.ok, true, JSON.stringify(editor.reason));
  // A message an earlier build stored in the adapter's form with its copy:
  // every write to it is refused, a soft delete included, because `body`
  // doesn't depend on what the editor's encoder writes.
  const adapterOnly = A.change(seeded, (d) => A.updateSpans(d, bobText, adapter));
  const withCopy = A.change(adapterOnly, (d) => {
    d.threads[ids.bobThread].messages[ids.bobMessage].body = "One\n\nTwo";
  });
  const deleted = admit(withCopy, BOB, "commenter", (d) => {
    d.threads[ids.bobThread].messages[ids.bobMessage].deletedAt = now();
  });
  assert.equal(deleted.reason?.code, REJECTION.OUTDATED_FORM);
  for (const write of [
    (d) =>
      A.updateText(d, ["threads", ids.bobThread, "messages", ids.bobMessage, "body"], "new copy"),
    (d) => {
      delete d.threads[ids.bobThread].messages[ids.bobMessage].body;
      A.updateSpans(d, bobText, markdownCommentSpans("One\n\nTwo"));
    },
  ])
    assert.equal(admit(withCopy, BOB, "commenter", write).reason?.code, REJECTION.OUTDATED_FORM);
});

test("an old form is refused without blocking the key: a stale tab isn't an attack", () => {
  assert.equal(REJECTION.OUTDATED_FORM, "outdated_form");
  assert.equal(BLOCKING.has(REJECTION.OUTDATED_FORM), false);
  assert.equal(BLOCKING.has(REJECTION.INVALID_VALUE), true);
});

test("a soft delete never checks the span form; a content write still does", () => {
  // Spans out of the editor's current form, as an earlier encoder (or the
  // ProseMirror adapter) wrote them. A later Wordgard release that encodes
  // differently leaves every stored message like this.
  const { doc: seeded, ids } = seed();
  const bobText = ["threads", ids.bobThread, "messages", ids.bobMessage, "richText"];
  const adapter = adapterSpans(parseMarkdown("One\n\nTwo"));
  const doc = A.change(seeded, (d) => A.updateSpans(d, bobText, adapter));
  const deleted = admit(doc, BOB, "commenter", (d) => {
    d.threads[ids.bobThread].messages[ids.bobMessage].deletedAt = now();
  });
  assert.equal(deleted.ok, true, JSON.stringify(deleted.reason));
  const edited = admit(doc, BOB, "commenter", (d) => A.splice(d, bobText, 1, 0, "x"));
  assert.equal(edited.reason?.code, REJECTION.OUTDATED_FORM);
  for (const write of [
    (d) => {
      d.threads[ids.bobThread].messages[ids.bobMessage].bodyFormat = "plain";
    },
    (d) => {
      d.threads[ids.bobThread].messages[ids.bobMessage].format = "automerge-rich-text-v1";
    },
  ])
    assert.equal(admit(doc, BOB, "commenter", write).reason?.code, REJECTION.OUTDATED_FORM);
});

/** An empty paragraph between two others, in the editor's form. */
function emptyParagraphSpans() {
  const spans = markdownCommentSpans("One\n\nTwo");
  const marker = spans.findIndex((span, index) => index > 0 && span.type === "block");
  const out = editorCommentSpans([
    ...spans.slice(0, marker),
    { type: "block", value: { type: "paragraph", parents: [], attrs: {}, isEmbed: false } },
    ...spans.slice(marker),
  ]);
  const blocks = out.map((span) => span.type);
  assert.ok(
    blocks.some((type, index) => type === "block" && blocks[index + 1] === "block"),
    JSON.stringify(out),
  );
  return out;
}

test("rich content passes admission through create, edit and soft delete", () => {
  const image = "![A chart](https://example.org/chart.png)";
  const cases = {
    image: { body: `See ${image}`, body_format: "markdown" },
    "hard break": { body: "line one\nline two", body_format: "plain" },
    highlight: { body: 'A <mark data-color="yellow">marked</mark> word', body_format: "markdown" },
    "empty paragraph": { spans: emptyParagraphSpans() },
  };
  for (const [name, content] of Object.entries(cases)) {
    let { doc, ids } = seed();
    const step = (input) => {
      let result;
      const changes = changesOf(doc, (d) => {
        result = applyComment(
          d,
          { ...input, ...(content.spans ? {} : content) },
          who(BOB),
          content.spans && input.action !== "delete_message" ? content.spans : null,
          { page, role: "commenter" },
        );
      });
      const admitted = admitCommentChanges(doc, changes, BOB, { role: "commenter" });
      assert.equal(
        admitted.ok,
        true,
        `${name} ${input.action}: ${JSON.stringify(admitted.reason)}`,
      );
      doc = admitted.next;
      return result;
    };
    const { message_id } = step({ action: "reply", thread_id: ids.aliceThread });
    const target = { thread_id: ids.aliceThread, message_id };
    step({ action: "edit", ...target });
    step({ action: "delete_message", ...target });
    assert.ok(doc.threads[ids.aliceThread].messages[message_id].deletedAt, name);
  }
});
