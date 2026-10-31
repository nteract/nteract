import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage } from "../model/page.mjs";
import { projectComments } from "../model/comments.mjs";
import { textPath } from "../model/richtext.mjs";
import { documentMutation } from "./mutations.mjs";

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
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
  const id = Object.keys(doc.blocks)[0];
  const identity = { principal: "user:comment-fixture", displayName: "Agent", driver: "Codex" };
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  let applications = 0;
  const context = (args, operation = "manage_page_comment") => ({
    storage,
    handle,
    operation,
    args,
    identity,
    apply(draft, effectiveArgs) {
      applications++;
      // The Page host reports model validation failures as 400s.
      try {
        return applyPageOperation(draft, { operation, arguments: effectiveArgs, identity });
      } catch (error) {
        throw Object.assign(error, { status: 400 });
      }
    },
    flush: async () => {},
  });
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
  const args = (overrides = {}) => ({
    idempotency_key: `comment-${crypto.randomUUID()}`,
    base_heads: A.getHeads(doc),
    ...overrides,
  });
  t.after(() => A.free(doc));
  return {
    storage,
    handle,
    id,
    context,
    native,
    type,
    args,
    applications: () => applications,
    comments: () => projectComments(doc),
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
    f.context(f.args({ action: "add", block_id: f.id, selected_text: "Beta", body: "Why?" })),
  );
  const { thread_id, message_id } = added.result;
  const stale = A.getHeads(f.handle.doc());
  f.type("Beta", " typed by a human");
  assert.notDeepEqual(A.getHeads(f.handle.doc()), stale);

  const reply = await documentMutation(
    f.context(f.args({ action: "reply", thread_id, body: "Because.", base_heads: stale })),
  );
  assert.equal(reply.result.thread_id, thread_id);
  f.type("Alpha", " more");
  await documentMutation(
    f.context(
      f.args({ action: "edit", thread_id, message_id, body: "Why not?", base_heads: stale }),
    ),
  );
  await documentMutation(f.context(f.args({ action: "resolve", thread_id, base_heads: stale })));
  // base_heads is optional for thread actions.
  await documentMutation(
    f.context({ idempotency_key: `reopen-${crypto.randomUUID()}`, action: "reopen", thread_id }),
  );
  await documentMutation(
    f.context(
      { idempotency_key: `legacy-${crypto.randomUUID()}`, thread_id, body: "Legacy reply" },
      "reply_page_comment",
    ),
  );
  await documentMutation(
    f.context(f.args({ action: "delete_message", thread_id, message_id, base_heads: stale })),
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
});

test("thread actions still validate threads, messages and supplied heads", async (t) => {
  const f = fixture(t);
  for (const [args, status] of [
    [{ action: "reply", thread_id: "missing", body: "Hello" }, 400],
    [{ action: "edit", thread_id: "missing", message_id: "missing", body: "Hello" }, 400],
    [{ action: "resolve", thread_id: "missing" }, 400],
    [{ action: "reply", thread_id: "missing", body: "Hello", base_heads: ["bad"] }, 400],
  ])
    await assert.rejects(
      documentMutation(f.context({ idempotency_key: `bad-${crypto.randomUUID()}`, ...args })),
      rejectsWith(status),
    );
  assert.equal(operationEntries(f).length, 0);
});

test("a passage comment from an older read anchors the passage the caller saw", async (t) => {
  const f = fixture(t);
  const args = f.args({ action: "add", block_id: f.id, selected_text: "Beta", body: "Look" });
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
  const args = f.args({
    action: "add",
    block_id: f.id,
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
  const args = f.args({ action: "add", block_id: f.id, selected_text: "Beta", body: "Gone" });
  f.native((draft) => {
    const at = draft.blocks[f.id].richText.indexOf("Beta");
    A.splice(draft, textPath(f.id), at, 4, "");
  });
  const before = A.save(f.handle.doc());
  await assert.rejects(documentMutation(f.context(args)), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "edit_conflict");
    assert.deepEqual(error.details.conflicts, [{ block_id: f.id, reason: "target_detached" }]);
    assert.deepEqual(error.details.current_heads, A.getHeads(f.handle.doc()));
    return true;
  });
  assert.deepEqual(A.save(f.handle.doc()), before);
  assert.equal(f.applications(), 0);
  assert.equal(operationEntries(f).length, 0);
});

test("a passage comment rejects unknown, missing or malformed base heads", async (t) => {
  const f = fixture(t);
  const add = { action: "add", block_id: f.id, selected_text: "Beta", body: "Hi" };
  await assert.rejects(
    documentMutation(f.context(f.args({ ...add, base_heads: ["f".repeat(64)] }))),
    rejectsWith(409, "resync_required"),
  );
  for (const base_heads of [undefined, [], ["bad"]])
    await assert.rejects(
      documentMutation(f.context(f.args({ ...add, base_heads }))),
      rejectsWith(400),
    );
  await assert.rejects(
    documentMutation(f.context(f.args({ ...add, selected_text: "Missing" }))),
    rejectsWith(400),
  );
  assert.equal(f.applications(), 0);
  assert.equal(operationEntries(f).length, 0);
});

test("a block comment needs only its block to exist now", async (t) => {
  const f = fixture(t);
  const stale = A.getHeads(f.handle.doc());
  f.type("Alpha", " typed");
  await documentMutation(
    f.context(f.args({ action: "add", block_id: f.id, body: "Block note", base_heads: stale })),
  );
  assert.deepEqual(f.comments()[0].target, { kind: "block", blockId: f.id });
  f.native((draft) => {
    delete draft.blocks[f.id];
  });
  await assert.rejects(
    documentMutation(
      f.context(f.args({ action: "add", block_id: f.id, body: "Late", base_heads: stale })),
    ),
    rejectsWith(400),
  );
});

test("an exact retry replays its receipt after the passage is later deleted", async (t) => {
  const f = fixture(t);
  const args = f.args({ action: "add", block_id: f.id, selected_text: "Beta", body: "Once" });
  f.type("Alpha", " typed");
  const receipt = await documentMutation(f.context(args));
  f.native((draft) => {
    const at = draft.blocks[f.id].richText.indexOf("Beta");
    A.splice(draft, textPath(f.id), at, 4, "");
  });
  assert.deepEqual(await documentMutation(f.context(args)), receipt);
  const reply = f.args({
    action: "reply",
    thread_id: receipt.result.thread_id,
    body: "Twice?",
  });
  const replied = await documentMutation(f.context(reply));
  f.type("Alpha typed", " again");
  assert.deepEqual(await documentMutation(f.context(reply)), replied);
  assert.equal(f.applications(), 2);
  assert.equal(f.comments().length, 1);
  assert.equal(f.comments()[0].messages.length, 2);
});
