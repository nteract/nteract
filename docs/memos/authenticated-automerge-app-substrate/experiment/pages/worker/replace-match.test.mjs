import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import {
  createPageData,
  initializePage,
  orderedBlockIds,
  applyPageOperation,
  projectPage,
} from "../model/page.mjs";
import { documentMutation, recoverDocumentMutations } from "./mutations.mjs";

function fixture() {
  let doc = A.from(createPageData({ pageId: "page_test", title: "Test" }));
  doc = A.change(doc, (draft) => initializePage(draft, "word word end"));
  const id = orderedBlockIds(doc)[0];
  const values = new Map();
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    list: async () => new Map(values),
    sync: async () => {},
  };
  const handle = {
    doc: () => doc,
    update: async (fn) => {
      doc = fn(doc);
    },
  };
  const identity = { principal: "user:owner", driver: "Kilo Desktop" };
  const args = {
    base_heads: A.getHeads(doc),
    idempotency_key: "targeted-edit-123",
    operations: [
      {
        op: "replace_match",
        block_id: id,
        match_text: "word",
        replacement: "phrase",
        context_after: "end",
      },
    ],
  };
  const context = (input = args) => ({
    storage,
    handle,
    operation: "patch_page",
    args: input,
    identity,
    apply: (draft) =>
      applyPageOperation(draft, { operation: "patch_page", arguments: input, identity }),
    flush: async () => {},
  });
  return { values, storage, handle, identity, args, context };
}

test("visible-text replacement uses existing head, idempotency, and account/driver guards", async () => {
  const f = fixture();
  const receipt = await documentMutation(f.context());
  const heads = A.getHeads(f.handle.doc());
  assert.equal(projectPage(f.handle.doc()).blocks[0].markdown, "word phrase end");
  assert.equal(receipt.result.edits[0].matched, 1);
  assert.deepEqual(await documentMutation(f.context()), receipt);
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
  await assert.rejects(
    documentMutation(f.context({ ...f.args, idempotency_key: "new-key-stale-heads" })),
    (error) =>
      error.status === 409 && error.code === "stale_heads" && /Page changed/.test(error.message),
  );
  for (const identity of [
    { ...f.identity, driver: "Codex" },
    { ...f.identity, principal: "user:other" },
  ])
    await assert.rejects(documentMutation({ ...f.context(), identity }), /different request/);
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
});

test("ambiguous visible replacement persists no intent or partially-applied sibling", async () => {
  const f = fixture();
  const before = A.getHeads(f.handle.doc());
  await assert.rejects(
    documentMutation(
      f.context({
        ...f.args,
        operations: [
          { op: "set_title", title: "Must not persist" },
          { ...f.args.operations[0], context_after: undefined },
        ],
      }),
    ),
    /found 2 matches/,
  );
  assert.equal(f.values.size, 0);
  assert.deepEqual(A.getHeads(f.handle.doc()), before);
  assert.equal(f.handle.doc().title, "Test");
});

test("an interrupted targeted replacement recovers exact changes without matching again", async () => {
  const f = fixture();
  let flushes = 0;
  await assert.rejects(
    documentMutation({
      ...f.context(),
      flush: async () => {
        if (++flushes === 2) throw Error("simulated durability interruption");
      },
    }),
    /durability interruption/,
  );
  const heads = A.getHeads(f.handle.doc());
  await recoverDocumentMutations(f.storage, f.handle, async () => {});
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
  const receipt = await documentMutation(f.context());
  assert.deepEqual(receipt.heads, heads);
  assert.equal(projectPage(f.handle.doc()).blocks[0].markdown, "word phrase end");
});
