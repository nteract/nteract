import assert from "node:assert/strict";
import { readRevision } from "./operation-journal.mjs";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createPageData, initializePage } from "../model/page.mjs";
import { applyComment, projectComments } from "../model/comments.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { guardCommentIntent, passageComment } from "../model/comment-guard.mjs";
import { textPath } from "../model/richtext.mjs";
import { blockAddress } from "../model/addresses.mjs";
import { COMMENTS_DOC, documentMutation, PAGE_DOC } from "./mutations.mjs";
import { headsFor } from "./revisions.mjs";

// Comment intents as the Page host runs them: journaled on the comments
// document, anchored in the Page document, and never writing the Page.

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .slice(0, limit),
    );
  }
  async sync() {}
}

function fixture(t, markdown = "Alpha first.\n\nBeta second.\n\nKeep the tail.") {
  const storage = new Storage();
  let doc = A.change(
    A.from(createPageData({ pageId: "comment-fixture", title: "Comment fixture" })),
    (draft) => initializePage(draft, markdown),
  );
  let comments = A.clone(commentsGenesis(crypto.randomUUID()));
  const id = Object.keys(doc.blocks)[0];
  const block = blockAddress(doc, id);
  const identity = { principal: "user:comment-fixture", displayName: "Agent", driver: "Codex" };
  const handle = {
    doc: () => comments,
    async update(fn) {
      comments = fn(comments);
    },
  };
  let applications = 0;
  const context = (args, operation = "manage_page_comment") => {
    let page;
    return {
      storage,
      handle,
      doc: COMMENTS_DOC,
      pageId: "comment-fixture",
      operation,
      args,
      identity,
      baseRevision: (input) => (passageComment(operation, input) ? input.revision : undefined),
      guard: (input, baseHeads) => {
        page = doc;
        return guardCommentIntent(page, operation, input, baseHeads);
      },
      receiptFields: async (plan) => ({ revision: await plan.handle(PAGE_DOC, A.getHeads(page)) }),
      pageHeads: () => A.getHeads(doc),
      apply(draft, effectiveArgs) {
        applications++;
        // The Page host reports model validation failures as 400s.
        try {
          return applyComment(
            draft,
            operation === "reply_page_comment"
              ? { ...effectiveArgs, action: "reply" }
              : effectiveArgs,
            identity,
            undefined,
            { page, role: "editor" },
          );
        } catch (error) {
          throw Object.assign(error, { status: error.status ?? 400 });
        }
      },
      flush: async () => {},
    };
  };
  /** A native change to the Page document, as a browser peer makes. */
  const native = (fn) => {
    doc = A.change(doc, fn);
  };
  // A browser peer typing: one splice per character, each advancing heads.
  const type = (after, text) => {
    for (const char of text)
      native((draft) => {
        const at = draft.blocks[id].richText.indexOf(after) + after.length;
        A.splice(draft, textPath(id), at, 0, char);
        after += char;
      });
  };
  // The Page revision handle of the Page as it is now.
  const revision = () => readRevision(storage, PAGE_DOC, A.getHeads(doc));
  const args = async (overrides = {}) => ({
    nonce: `comment-${crypto.randomUUID()}`,
    revision: await revision(),
    ...overrides,
  });
  t.after(() => A.free(doc));
  return {
    storage,
    handle,
    page: () => doc,
    id,
    block,
    context,
    native,
    nativeComments: (fn) => {
      comments = A.change(comments, fn);
    },
    type,
    args,
    revision,
    commentHeads: (handle) => headsFor(storage, COMMENTS_DOC, handle),
    applications: () => applications,
    comments: () => projectComments(doc, comments),
    text: () => doc.blocks[id].richText,
  };
}

const operationEntries = (f) =>
  [...f.storage.values].filter(([key]) => key.startsWith("host/operation/"));
const rejectsWith = (status, code) => (error) =>
  error.status === status && (code === undefined || error.code === code);

test("thread actions succeed after browser typing in the same block", async (t) => {
  const f = fixture(t);
  const added = await documentMutation(
    f.context(
      await f.args({ action: "add", node_id: f.block, selected_text: "Beta", body: "Why?" }),
    ),
  );
  const { thread_id, message_id } = added.result;
  const stale = await f.revision();
  const pageAfterAdd = A.getHeads(f.page());
  f.type("Beta", " typed by a human");
  assert.notDeepEqual(A.getHeads(f.page()), stale);

  const reply = await documentMutation(
    f.context(await f.args({ action: "reply", thread_id, body: "Because.", revision: stale })),
  );
  assert.equal(reply.result.thread_id, thread_id);
  f.type("Alpha", " more");
  await documentMutation(
    f.context(
      await f.args({ action: "edit", thread_id, message_id, body: "Why not?", revision: stale }),
    ),
  );
  await documentMutation(
    f.context(await f.args({ action: "resolve", thread_id, revision: stale })),
  );
  // revision is optional for thread actions.
  await documentMutation(
    f.context({ nonce: `reopen-${crypto.randomUUID()}`, action: "reopen", thread_id }),
  );
  await documentMutation(
    f.context(
      { nonce: `legacy-${crypto.randomUUID()}`, thread_id, body: "Legacy reply" },
      "reply_page_comment",
    ),
  );
  await documentMutation(
    f.context(await f.args({ action: "delete_message", thread_id, message_id, revision: stale })),
  );

  const [thread] = f.comments();
  assert.equal(thread.state, "open");
  assert.deepEqual(
    thread.messages.map((message) => [message.body ?? null, Boolean(message.deletedAt)]),
    [
      [null, true],
      ["Because.", false],
      ["Legacy reply", false],
    ],
  );
  // Typing after the final selected character extends the block, not the anchor.
  assert.equal(thread.selectionContext.text, "Beta");
  assert.match(f.text(), /Beta typed by a human/);
  // Only the typing moved the Page; the comment intents wrote none of it.
  assert.ok(A.getChanges(A.view(f.page(), pageAfterAdd), f.page()).length > 0);
});

test("thread actions still validate threads, messages and supplied heads", async (t) => {
  const f = fixture(t);
  for (const [args, status] of [
    [{ action: "reply", thread_id: "missing", body: "Hello" }, 400],
    [{ action: "edit", thread_id: "missing", message_id: "missing", body: "Hello" }, 400],
    [{ action: "resolve", thread_id: "missing" }, 400],
    [{ action: "reply", thread_id: "missing", body: "Hello", revision: "bad" }, 400],
  ])
    await assert.rejects(
      documentMutation(f.context({ nonce: `bad-${crypto.randomUUID()}`, ...args })),
      rejectsWith(status),
    );
  assert.equal(operationEntries(f).length, 0);
});

test("a passage comment from an older read anchors the passage the caller saw", async (t) => {
  const f = fixture(t);
  const args = await f.args({
    action: "add",
    node_id: f.block,
    selected_text: "Beta",
    body: "Look",
  });
  f.type("Alpha", " typed");
  f.native((draft) => A.splice(draft, textPath(f.id), 0, 0, "Intro. "));
  const receipt = await documentMutation(f.context(args));
  assert.equal(f.applications(), 1);
  const [thread] = f.comments();
  assert.equal(thread.id, receipt.result.thread_id);
  assert.deepEqual(thread.selectionContext, {
    status: "attached",
    start: { blockId: f.id, offsetUtf16: f.text().indexOf("Beta") },
    end: { blockId: f.id, offsetUtf16: f.text().indexOf("Beta") + 4 },
    text: "Beta",
  });
  assert.equal(receipt.concurrency, undefined);
});

test("occurrence counts copies at the read revision, not the current one", async (t) => {
  const f = fixture(t, "apple one, apple two.");
  const args = await f.args({
    action: "add",
    node_id: f.block,
    selected_text: "apple",
    occurrence: 2,
    body: "This one",
  });
  // A new copy ahead of the target would shift a current-revision count.
  f.native((draft) => A.splice(draft, textPath(f.id), 0, 0, "apple zero, "));
  await documentMutation(f.context(args));
  const [thread] = f.comments();
  assert.equal(thread.selectionContext.start.offsetUtf16, f.text().indexOf("apple two"));
});

test("a passage deleted after the read returns edit_conflict without recording", async (t) => {
  const f = fixture(t);
  const args = await f.args({
    action: "add",
    node_id: f.block,
    selected_text: "Beta",
    body: "Gone",
  });
  f.native((draft) => {
    const at = draft.blocks[f.id].richText.indexOf("Beta");
    A.splice(draft, textPath(f.id), at, 4, "");
  });
  const before = A.save(f.handle.doc());
  await assert.rejects(documentMutation(f.context(args)), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "edit_conflict");
    assert.deepEqual(error.details.conflicts, [{ node_id: f.block, reason: "target_detached" }]);
    assert.deepEqual(error.details.current_heads, A.getHeads(f.page()));
    return true;
  });
  assert.deepEqual(A.save(f.handle.doc()), before);
  assert.equal(f.applications(), 0);
  assert.equal(operationEntries(f).length, 0);
});

test("a passage comment rejects an unknown, missing or malformed revision", async (t) => {
  const f = fixture(t);
  const add = { action: "add", node_id: f.block, selected_text: "Beta", body: "Hi" };
  await assert.rejects(
    documentMutation(f.context(await f.args({ ...add, revision: "r999" }))),
    rejectsWith(409, "resync_required"),
  );
  for (const revision of [undefined, "", "bad", "c1", ["r1"]])
    await assert.rejects(
      documentMutation(f.context(await f.args({ ...add, revision }))),
      rejectsWith(400),
    );
  await assert.rejects(
    documentMutation(f.context(await f.args({ ...add, selected_text: "Missing" }))),
    rejectsWith(400),
  );
  assert.equal(f.applications(), 0);
  assert.equal(operationEntries(f).length, 0);
});

test("a block comment needs only its block to exist now", async (t) => {
  const f = fixture(t);
  const stale = await f.revision();
  f.type("Alpha", " typed");
  await documentMutation(
    f.context(
      await f.args({ action: "add", node_id: f.block, body: "Block note", revision: stale }),
    ),
  );
  // A block comment takes no revision at all.
  await documentMutation(
    f.context({ nonce: `bare-${crypto.randomUUID()}`, node_id: f.block, body: "Bare" }),
  );
  assert.deepEqual(f.comments()[0].target, { kind: "block", blockId: f.id });
  f.native((draft) => {
    delete draft.blocks[f.id];
  });
  await assert.rejects(
    documentMutation(
      f.context(await f.args({ action: "add", node_id: f.block, body: "Late", revision: stale })),
    ),
    rejectsWith(400),
  );
});

test("an exact retry replays its receipt after the passage is later deleted", async (t) => {
  const f = fixture(t);
  const args = await f.args({
    action: "add",
    node_id: f.block,
    selected_text: "Beta",
    body: "Once",
  });
  f.type("Alpha", " typed");
  const receipt = await documentMutation(f.context(args));
  f.native((draft) => {
    const at = draft.blocks[f.id].richText.indexOf("Beta");
    A.splice(draft, textPath(f.id), at, 4, "");
  });
  // The retry returns the same receipt, both revisions included.
  assert.match(receipt.revision, /^r\d+$/);
  assert.match(receipt.comment_revision, /^c\d+$/);
  assert.deepEqual(await documentMutation(f.context(args)), receipt);
  const reply = await f.args({
    action: "reply",
    thread_id: receipt.result.thread_id,
    body: "Twice?",
  });
  const replied = await documentMutation(f.context(reply));
  f.type("Alpha typed", " again");
  assert.match(replied.comment_revision, /^c\d+$/);
  assert.deepEqual(await documentMutation(f.context(reply)), replied);
  assert.equal(f.applications(), 2);
  assert.equal(f.comments().length, 1);
  assert.equal(f.comments()[0].messages.length, 2);
});

/** Open `count` block comments, each in its own native change. */
function openThreads(f, count) {
  const ids = [];
  for (let n = 0; n < count; n++)
    f.nativeComments((draft) => {
      ids.push(
        applyComment(
          draft,
          { action: "add", block_id: f.id, body: `Note ${n}` },
          { principal: "user:reviewer", displayName: "Reviewer", driver: "Browser" },
          undefined,
          { page: f.page(), role: "commenter" },
        ).thread_id,
      );
    });
  return ids;
}
const states = (f) => Object.fromEntries(f.comments().map((thread) => [thread.id, thread.state]));
const changeCount = (f) => A.getAllChanges(f.handle.doc()).length;

test("a thread_ids batch resolves every thread in one change and one receipt", async (t) => {
  const f = fixture(t);
  const ids = openThreads(f, 13);
  const before = changeCount(f);
  const receipt = await documentMutation(
    f.context(await f.args({ action: "resolve", thread_ids: ids })),
  );
  assert.equal(changeCount(f) - before, 1, "one Automerge change for the whole batch");
  assert.equal(f.applications(), 1);
  assert.equal(operationEntries(f).length, 1, "one journal entry under one key");
  assert.deepEqual(await f.commentHeads(receipt.comment_revision), A.getHeads(f.handle.doc()));
  assert.equal((await f.commentHeads(receipt.comment_revision)).length, 1);
  assert.deepEqual(
    receipt.result.threads,
    ids.map((thread_id) => ({ thread_id, outcome: "resolved" })),
  );
  assert.ok(Object.values(states(f)).every((state) => state === "resolved"));
});

test("a batch skips threads already resolved and changes the rest", async (t) => {
  const f = fixture(t);
  const [open, done, other] = openThreads(f, 3);
  await documentMutation(f.context(await f.args({ action: "resolve", thread_id: done })));
  const resolvedAt = f.handle.doc().threads[done].status.at;
  const before = changeCount(f);
  const receipt = await documentMutation(
    f.context(await f.args({ action: "resolve", thread_ids: [open, done, other] })),
  );
  assert.equal(changeCount(f) - before, 1);
  assert.deepEqual(receipt.result.threads, [
    { thread_id: open, outcome: "resolved" },
    { thread_id: done, outcome: "already_resolved" },
    { thread_id: other, outcome: "resolved" },
  ]);
  assert.equal(f.handle.doc().threads[done].status.at, resolvedAt, "a no-op keeps its time");
  assert.deepEqual(states(f), { [open]: "resolved", [done]: "resolved", [other]: "resolved" });
});

test("a batch of threads all in the target state writes nothing and reports each", async (t) => {
  const f = fixture(t);
  const ids = openThreads(f, 2);
  const heads = A.getHeads(f.handle.doc());
  const receipt = await documentMutation(
    f.context(await f.args({ action: "reopen", thread_ids: ids })),
  );
  assert.deepEqual(await f.commentHeads(receipt.comment_revision), heads);
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
  assert.deepEqual(
    receipt.result.threads,
    ids.map((thread_id) => ({ thread_id, outcome: "already_open" })),
  );
});

test("one thread already in the target state writes nothing and says so", async (t) => {
  const f = fixture(t);
  const [thread] = openThreads(f, 1);
  const first = await documentMutation(
    f.context(await f.args({ action: "resolve", thread_id: thread })),
  );
  assert.equal(first.result.outcome, "resolved");
  const resolvedAt = f.handle.doc().threads[thread].status.at;
  const heads = A.getHeads(f.handle.doc());
  for (const [action, outcome] of [
    ["resolve", "already_resolved"],
    ["reopen", "reopened"],
    ["reopen", "already_open"],
  ]) {
    const before = A.getHeads(f.handle.doc());
    const receipt = await documentMutation(f.context(await f.args({ action, thread_id: thread })));
    assert.deepEqual(receipt.result, { thread_id: thread, message_id: null, outcome }, action);
    if (outcome.startsWith("already")) {
      // No change, so the receipt names the revision the thread already had.
      assert.deepEqual(A.getHeads(f.handle.doc()), before, outcome);
      assert.deepEqual(await f.commentHeads(receipt.comment_revision), before, outcome);
    }
    if (outcome === "already_resolved") {
      assert.deepEqual(before, heads);
      assert.equal(f.handle.doc().threads[thread].status.at, resolvedAt);
    }
  }
});

test("a no-op resolve retried with its nonce replays its receipt after the thread reopens", async (t) => {
  const f = fixture(t);
  const [thread] = openThreads(f, 1);
  await documentMutation(f.context(await f.args({ action: "resolve", thread_id: thread })));
  const args = await f.args({ action: "resolve", thread_id: thread });
  const receipt = await documentMutation(f.context(args));
  assert.equal(receipt.result.outcome, "already_resolved");
  // Someone reopens it; the retry replays the no-op and resolves nothing.
  await documentMutation(f.context(await f.args({ action: "reopen", thread_id: thread })));
  const heads = A.getHeads(f.handle.doc());
  const applications = f.applications();
  assert.deepEqual(await documentMutation(f.context(args)), receipt);
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
  assert.equal(states(f)[thread], "open");
  assert.equal(f.applications(), applications, "the replay never applies the resolve again");
  await assert.rejects(
    documentMutation(f.context({ ...args, action: "reopen" })),
    rejectsWith(409, "nonce_conflict"),
  );
});

test("reopen works as a batch", async (t) => {
  const f = fixture(t);
  const ids = openThreads(f, 3);
  await documentMutation(
    f.context(await f.args({ action: "resolve", thread_ids: ids.slice(0, 2) })),
  );
  const before = changeCount(f);
  const receipt = await documentMutation(
    f.context(await f.args({ action: "reopen", thread_ids: ids })),
  );
  assert.equal(changeCount(f) - before, 1);
  assert.deepEqual(receipt.result.threads, [
    { thread_id: ids[0], outcome: "reopened" },
    { thread_id: ids[1], outcome: "reopened" },
    { thread_id: ids[2], outcome: "already_open" },
  ]);
  assert.ok(Object.values(states(f)).every((state) => state === "open"));
});

test("an unknown thread rejects the whole batch, names it, and changes nothing", async (t) => {
  const f = fixture(t);
  const ids = openThreads(f, 2);
  const bytes = A.save(f.handle.doc());
  await assert.rejects(
    documentMutation(
      f.context(
        await f.args({ action: "resolve", thread_ids: [ids[0], "missing-a", ids[1], "__proto__"] }),
      ),
    ),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_comment_selector");
      assert.deepEqual(error.details.not_found_thread_ids, ["missing-a", "__proto__"]);
      assert.match(error.message, /2 of 4 comment threads not found; nothing was changed/);
      return true;
    },
  );
  assert.deepEqual(A.save(f.handle.doc()), bytes);
  assert.equal(operationEntries(f).length, 0);
  assert.ok(Object.values(states(f)).every((state) => state === "open"));
});

test("a batch retried with its key and payload replays the original receipt", async (t) => {
  const f = fixture(t);
  const ids = openThreads(f, 3);
  const args = await f.args({ action: "resolve", thread_ids: ids });
  const receipt = await documentMutation(f.context(args));
  // Someone reopens a thread; the retry must not resolve it again.
  await documentMutation(f.context(await f.args({ action: "reopen", thread_id: ids[1] })));
  const heads = A.getHeads(f.handle.doc());
  assert.deepEqual(await documentMutation(f.context(args)), receipt);
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
  assert.equal(states(f)[ids[1]], "open");
  assert.equal(f.applications(), 2, "the replay never applies the batch again");
  // The same key with a different payload is a conflict, not a second batch.
  await assert.rejects(
    documentMutation(f.context({ ...args, thread_ids: ids.slice(0, 2) })),
    rejectsWith(409, "nonce_conflict"),
  );
});

test("thread_ids shape errors are refused before any thread is read", async (t) => {
  const f = fixture(t);
  const [id] = openThreads(f, 1);
  const many = Array.from({ length: 101 }, (_, n) => `t-${n}`);
  for (const [name, args] of [
    ["both fields", { action: "resolve", thread_id: id, thread_ids: [id] }],
    ["neither field", { action: "resolve" }],
    ["neither field on reopen", { action: "reopen" }],
    ["an empty list", { action: "resolve", thread_ids: [] }],
    ["more than 100 IDs", { action: "resolve", thread_ids: many }],
    ["duplicate IDs", { action: "resolve", thread_ids: [id, id] }],
    ["a non-array", { action: "resolve", thread_ids: id }],
    ["an empty ID", { action: "resolve", thread_ids: [""] }],
    ["a non-string ID", { action: "resolve", thread_ids: [7] }],
    ["an ID over 256 bytes", { action: "resolve", thread_ids: ["🌊".repeat(65)] }],
    ["another action", { action: "reply", thread_ids: [id], body: "Hi" }],
  ])
    await assert.rejects(
      documentMutation(f.context(await f.args(args))),
      (error) => {
        assert.equal(error.status, 400, name);
        assert.equal(error.code, "invalid_comment_selector", name);
        return true;
      },
      name,
    );
  assert.equal(f.applications(), 0, "the guard refuses before the edit is built");
  assert.equal(operationEntries(f).length, 0);
  // The single-thread form keeps working beside the batch form.
  const single = await documentMutation(
    f.context(await f.args({ action: "resolve", thread_id: id })),
  );
  assert.deepEqual(single.result, { thread_id: id, message_id: null, outcome: "resolved" });
});
