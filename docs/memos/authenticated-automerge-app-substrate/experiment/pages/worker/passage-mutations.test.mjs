import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, projectPage } from "../model/page.mjs";
import { textPath } from "../model/richtext.mjs";
import { documentMutation, recoverDocumentMutations } from "./mutations.mjs";

class Storage {
  values = new Map();
  durable = new Map();
  beforeSync;
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
  async sync() {
    this.beforeSync?.();
    this.durable = structuredClone(this.values);
  }
}

function fixture(t, markdown = "Alpha first.\n\nBeta second.\n\nKeep the tail.") {
  const storage = new Storage();
  let doc = A.change(
    A.from(createPageData({ pageId: "passage-fixture", title: "Passage fixture" })),
    (draft) => initializePage(draft, markdown),
  );
  const id = Object.keys(doc.blocks)[0];
  const identity = { principal: "user:passage-fixture", driver: "Codex" };
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  let applications = 0;
  const appliedArguments = [];
  const context = (args, overrides = {}) => ({
    storage,
    handle,
    operation: "patch_page",
    args,
    identity,
    apply(draft, effectiveArgs) {
      applications++;
      appliedArguments.push(structuredClone(effectiveArgs));
      return applyPageOperation(draft, {
        operation: "patch_page",
        arguments: effectiveArgs,
        identity,
      });
    },
    flush: () => storage.sync(),
    ...overrides,
  });
  const native = (fn) => {
    doc = A.change(doc, fn);
  };
  const replace = (match, replacement) =>
    native((draft) => {
      const start = draft.blocks[id].richText.indexOf(match);
      assert.ok(start >= 0);
      A.splice(draft, textPath(id), start, match.length, replacement);
    });
  const args = (overrides = {}) => ({
    idempotency_key: `passage-${crypto.randomUUID()}`,
    base_heads: A.getHeads(doc),
    conflict_scope: "target",
    operations: [{ op: "replace_match", block_id: id, match_text: "Beta", replacement: "Agent" }],
    ...overrides,
  });
  t.after(() => A.free(doc));
  return {
    storage,
    handle,
    id,
    context,
    native,
    replace,
    args,
    appliedArguments,
    applications: () => applications,
    markdown: () => projectPage(doc).blocks[0].markdown,
  };
}

const operationEntries = (f) =>
  [...f.storage.values].filter(([key]) => key.startsWith("host/operation/"));

test("target-scoped stale edit preserves an unrelated native edit in the same rich block", async (t) => {
  const f = fixture(t);
  const args = f.args();
  const object = A.getObjectId(f.handle.doc().blocks[f.id], "richText");
  f.replace("Alpha", "Human");
  const observed = A.getHeads(f.handle.doc());
  const receipt = await documentMutation(f.context(args));
  assert.equal(f.markdown(), "Human first.\n\nAgent second.\n\nKeep the tail.");
  assert.equal(A.getObjectId(f.handle.doc().blocks[f.id], "richText"), object);
  assert.deepEqual(receipt.concurrency, {
    rebased: true,
    base_heads: args.base_heads,
    observed_heads: observed,
  });
  assert.deepEqual(receipt.heads, A.getHeads(f.handle.doc()));
  assert.equal(f.applications(), 1);
});

test("base node_index follows its native passage after an earlier paragraph is inserted", async (t) => {
  const f = fixture(t, "First apple.\n\nSecond apple.\n\nTail.");
  const args = f.args({
    operations: [
      {
        op: "replace_match",
        block_id: f.id,
        node_index: 1,
        match_text: "apple",
        replacement: "pear",
      },
    ],
  });
  f.native((draft) => {
    A.splitBlock(draft, textPath(f.id), 0, {
      type: new A.ImmutableString("paragraph"),
      parents: [],
      attrs: {},
      isEmbed: false,
    });
    A.splice(draft, textPath(f.id), 1, 0, "New introduction.");
  });
  assert.equal(f.markdown(), "New introduction.\n\nFirst apple.\n\nSecond apple.\n\nTail.");
  const receipt = await documentMutation(f.context(args));
  assert.equal(receipt.concurrency.rebased, true);
  assert.equal(f.appliedArguments[0].operations[0].node_index, 2);
  assert.equal(args.operations[0].node_index, 1, "the fingerprinted request must not be mutated");
  assert.equal(f.markdown(), "New introduction.\n\nFirst apple.\n\nSecond pear.\n\nTail.");
});

for (const conflict of [
  "text",
  "same-visible-replacement",
  "formatting",
  "deleted-block",
  "replaced-block-object",
]) {
  test(`changed target (${conflict}) rejects before recording or applying an intent`, async (t) => {
    const f = fixture(t);
    const args = f.args();
    if (conflict === "deleted-block") {
      f.native((draft) => {
        delete draft.blocks[f.id];
      });
    } else if (conflict === "replaced-block-object") {
      const replacement = A.toJS(f.handle.doc()).blocks[f.id];
      f.native((draft) => {
        draft.blocks[f.id] = replacement;
      });
    } else if (conflict === "formatting") {
      f.native((draft) => {
        const start = draft.blocks[f.id].richText.indexOf("Beta");
        A.mark(draft, textPath(f.id), { start, end: start + 4, expand: "none" }, "bold", true);
      });
    } else f.replace("Beta", conflict === "text" ? "Human" : "Beta");
    const before = A.save(f.handle.doc());
    await assert.rejects(
      documentMutation(f.context(args)),
      (error) => error.status === 409 && error.code === "edit_conflict",
    );
    assert.deepEqual(A.save(f.handle.doc()), before);
    assert.equal(f.applications(), 0);
    assert.equal(operationEntries(f).length, 0);
  });
}

test("legacy exact-head mode still rejects an unrelated stale revision", async (t) => {
  const f = fixture(t);
  const args = f.args();
  delete args.conflict_scope;
  f.replace("Alpha", "Human");
  await assert.rejects(documentMutation(f.context(args)), (error) => error.status === 409);
  assert.equal(f.applications(), 0);
  assert.equal(operationEntries(f).length, 0);
});

test("one changed passage rejects the complete target-scoped batch before either edit", async (t) => {
  const f = fixture(t);
  const args = f.args({
    operations: [
      { op: "replace_match", block_id: f.id, match_text: "Beta", replacement: "Agent" },
      { op: "replace_match", block_id: f.id, match_text: "tail", replacement: "ending" },
    ],
  });
  f.replace("tail", "human ending");
  const before = A.save(f.handle.doc());
  await assert.rejects(
    documentMutation(f.context(args)),
    (error) => error.status === 409 && error.code === "edit_conflict",
  );
  assert.deepEqual(A.save(f.handle.doc()), before);
  assert.match(f.markdown(), /Beta second/);
  assert.equal(f.applications(), 0);
  assert.equal(operationEntries(f).length, 0);
});

test("target mode records a non-rebased receipt when its revision is current", async (t) => {
  const f = fixture(t);
  const args = f.args();
  const receipt = await documentMutation(f.context(args));
  assert.deepEqual(receipt.concurrency, {
    rebased: false,
    base_heads: args.base_heads,
    observed_heads: args.base_heads,
  });
  const bytes = A.save(f.handle.doc());
  assert.deepEqual(await documentMutation(f.context(args)), receipt);
  assert.deepEqual(A.save(f.handle.doc()), bytes);
  assert.equal(f.applications(), 1);
});

test("a native target edit during external preparation is caught by the second guard", async (t) => {
  const f = fixture(t);
  const args = f.args();
  let prepared = 0;
  await assert.rejects(
    documentMutation(
      f.context(args, {
        async prepare() {
          prepared++;
          f.replace("Beta", "Human");
        },
      }),
    ),
    (error) => error.status === 409 && error.code === "edit_conflict",
  );
  assert.equal(prepared, 1);
  assert.equal(f.applications(), 0);
  assert.equal(operationEntries(f).length, 0);
  assert.match(f.markdown(), /Human second/);
});

test("native overlap after synchronous capture merges normally and exact retry never reauthors", async (t) => {
  const f = fixture(t);
  const args = f.args();
  const observed = A.getHeads(f.handle.doc());
  let flushes = 0;
  const receipt = await documentMutation(
    f.context(args, {
      async flush() {
        if (++flushes === 1) f.replace("Beta", "Human");
        await f.storage.sync();
      },
    }),
  );
  assert.match(f.markdown(), /Human/);
  assert.match(f.markdown(), /Agent/);
  assert.deepEqual(receipt.concurrency, {
    rebased: false,
    base_heads: observed,
    observed_heads: observed,
  });
  assert.ok(A.hasHeads(f.handle.doc(), receipt.heads));
  assert.notDeepEqual(A.getHeads(f.handle.doc()), receipt.heads);
  const bytes = A.save(f.handle.doc());
  const replay = f.context(args, {
    prepare: () => assert.fail("a retry must not repeat preparation"),
    apply: () => assert.fail("a retry must not author a new edit"),
  });
  assert.deepEqual(await documentMutation(replay), receipt);
  assert.deepEqual(A.save(f.handle.doc()), bytes);
  assert.equal(f.applications(), 1);
});

for (const recovery of ["retry", "startup"]) {
  test(`pending target edit retains its bytes and receipt through ${recovery} after later edits`, async (t) => {
    const f = fixture(t);
    const args = f.args();
    f.replace("Alpha", "Human");
    let flushes = 0;
    await assert.rejects(
      documentMutation(
        f.context(args, {
          async flush() {
            if (++flushes === 2) throw Error("Interrupted passage durability");
            await f.storage.sync();
          },
        }),
      ),
      /Interrupted passage durability/,
    );
    const key = `host/operation/${args.idempotency_key}`;
    const pending = await f.storage.get(key);
    assert.equal(pending.pending, true);
    assert.equal(pending.receipt.concurrency.rebased, true);
    f.replace("Agent", "Later human");
    const beforeReplay = A.save(f.handle.doc());
    if (recovery === "startup")
      await recoverDocumentMutations(f.storage, f.handle, () => f.storage.sync());
    const replay = f.context(args, {
      prepare: () => assert.fail("pending replay must skip prerequisites"),
      apply: () => assert.fail("pending replay must reuse recorded bytes"),
    });
    assert.deepEqual(await documentMutation(replay), pending.receipt);
    assert.deepEqual(await documentMutation(replay), pending.receipt);
    assert.deepEqual(A.save(f.handle.doc()), beforeReplay);
    assert.equal((await f.storage.get(key)).pending, false);
    assert.equal(f.applications(), 1);
  });
}

test("crash after journaling but before apply replays the recorded passage against later native edits", async (t) => {
  const f = fixture(t);
  const args = f.args();
  f.replace("Alpha", "Human");
  let interrupted = false;
  f.storage.beforeSync = () => {
    if (!interrupted && operationEntries(f).some(([, entry]) => entry.pending)) {
      interrupted = true;
      // The intent reached durable storage but its acknowledgement was lost.
      f.storage.durable = structuredClone(f.storage.values);
      throw Error("Crash after passage intent put");
    }
  };
  await assert.rejects(documentMutation(f.context(args)), /Crash after passage intent put/);
  const key = `host/operation/${args.idempotency_key}`;
  const pending = await f.storage.get(key);
  assert.equal(pending.pending, true);
  assert.match(f.markdown(), /Beta second/);
  f.storage.beforeSync = undefined;
  f.storage.values = structuredClone(f.storage.durable);
  f.replace("Keep the tail", "Later human tail");
  await recoverDocumentMutations(f.storage, f.handle, () => f.storage.sync());
  assert.equal(f.markdown(), "Human first.\n\nAgent second.\n\nLater human tail.");
  assert.ok(A.hasHeads(f.handle.doc(), pending.receipt.heads));
  const replay = f.context(args, { apply: () => assert.fail("recovery must not reauthor") });
  assert.deepEqual(await documentMutation(replay), pending.receipt);
  assert.equal(f.applications(), 1);
});
