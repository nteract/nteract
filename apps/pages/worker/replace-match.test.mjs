import assert from "node:assert/strict";
import { readRevision } from "./operation-journal.mjs";
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
import { headsFor } from "./revisions.mjs";
import { blockAddress } from "../model/addresses.mjs";

async function fixture() {
  let doc = A.from(createPageData({ pageId: "page_test", title: "Test" }));
  doc = A.change(doc, (draft) => initializePage(draft, "word word end"));
  const id = orderedBlockIds(doc)[0];
  const values = new Map();
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) =>
      typeof key === "object"
        ? Object.entries(key).forEach(([name, entry]) => values.set(name, entry))
        : values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    list: async ({ prefix = "", limit = Infinity } = {}) =>
      new Map(
        [...values]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .slice(0, limit),
      ),
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
    revision: await readRevision(storage, "page", A.getHeads(doc)),
    nonce: "targeted-edit-123",
    operations: [
      {
        op: "replace_match",
        node_id: blockAddress(doc, id),
        match_text: "word",
        replacement: "phrase",
        context_after: "end",
      },
    ],
  };
  const context = (input = args) => ({
    storage,
    handle,
    operation: "edit_page",
    args: input,
    identity,
    apply: (draft) =>
      applyPageOperation(draft, { operation: "edit_page", arguments: input, identity }),
    flush: async () => {},
  });
  return {
    values,
    storage,
    handle,
    identity,
    args,
    context,
    heads: (revision) => headsFor(storage, "page", revision),
  };
}

test("visible-text replacement uses the revision, nonce, and account/driver guards", async () => {
  const f = await fixture();
  const receipt = await documentMutation(f.context());
  const heads = A.getHeads(f.handle.doc());
  assert.equal(projectPage(f.handle.doc()).blocks[0].markdown, "word phrase end");
  assert.equal(receipt.result.edits[0].matched, 1);
  assert.deepEqual(await documentMutation(f.context()), receipt);
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
  await assert.rejects(
    documentMutation(f.context({ ...f.args, nonce: "new-key-stale-revision" })),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "stale_revision");
      assert.match(error.message, /Page changed/);
      // The refusal names the live revision, so the caller can rebuild its
      // request without a read_page round trip.
      assert.deepEqual(error.details, { current_heads: [...heads].sort() });
      return true;
    },
  );
  // Another driver of the same account conflicts on the nonce. Another
  // account's nonce is its own: that request is new, and stale here.
  await assert.rejects(
    documentMutation({ ...f.context(), identity: { ...f.identity, driver: "Codex" } }),
    { code: "nonce_conflict" },
  );
  await assert.rejects(
    documentMutation({ ...f.context(), identity: { ...f.identity, principal: "user:other" } }),
    { code: "stale_revision" },
  );
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
});

test("ambiguous visible replacement persists no intent or partially-applied sibling", async () => {
  const f = await fixture();
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
  assert.deepEqual(
    [...f.values.keys()].filter((key) => !key.startsWith("host/revision/")),
    [],
  );
  assert.deepEqual(A.getHeads(f.handle.doc()), before);
  assert.equal(f.handle.doc().title, "Test");
});

test("an interrupted targeted replacement recovers exact changes without matching again", async () => {
  const f = await fixture();
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
  assert.deepEqual(await f.heads(receipt.revision), heads);
  assert.equal(projectPage(f.handle.doc()).blocks[0].markdown, "word phrase end");
});
