import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { RecoveryCapture, RECOVERY_INITIAL, recoveryCaptureStep } from "./recovery-capture.mjs";
import * as recovery from "./recovery-capture.mjs";
import { PageSession } from "./session.mjs";
import { saveRecoveryCopy, archiveSnapshot, key, store } from "./local-catalog.mjs";
import {
  decodeSnapshot,
  encodeSnapshot,
  listLocalRecoveries,
  writeLocalPage,
} from "./local-pages.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { captureSelectionTarget, selectionContext } from "../model/comments.mjs";
import { comment, newCommentsDoc } from "../model/comments-test-support.mjs";
import { captureCommentDraft, resolveCommentDraft } from "./comment-draft.mjs";

const history = (doc) =>
  A.getAllChanges(doc)
    .map((c) => A.decodeChange(c).hash)
    .sort();
const newId = () => interpretAsDocumentId(generateAutomergeUrl());

async function fixture() {
  const identity = { principal: crypto.randomUUID(), displayName: "Writer" };
  const pageId = crypto.randomUUID();
  let doc = A.change(A.from(createPageData({ pageId, title: "Recovery" })), (d) =>
    initializePage(d, "Keep this passage"),
  );
  const blockId = Object.keys(doc.blocks)[0];
  const target = captureSelectionTarget(doc, blockId, "this passage");
  const { comments } = comment(
    doc,
    newCommentsDoc(),
    { block_id: blockId, selected_text: "this passage", body: "Unsent comment" },
    identity,
  );
  doc = A.change(doc, (d) => {
    d.future = { unknown: [1, "preserved"] };
    A.updateSpans(
      d,
      ["blocks", blockId, "richText"],
      [
        { type: "text", value: "Keep this passage" },
        {
          type: "block",
          value: {
            type: "future-node",
            parents: [],
            attrs: { src: `/api/pages/${pageId}/assets/opaque`, future: true },
          },
        },
      ],
    );
  });
  const session = new PageSession(pageId, { authentication: { identity, canWrite: true } });
  session.acceptAuthentication({ identity, canWrite: true });
  session.access = { canRead: true, canWrite: true, canComment: true, role: "owner", revision: 0 };
  session.handle = { documentId: newId(), doc: () => doc };
  session.commentsHandle = { documentId: newId(), doc: () => comments };
  session.localPage = {
    principal: identity.principal,
    page_id: pageId,
    document_id: session.handle.documentId,
    snapshot: encodeSnapshot(A.save(doc)),
    title: "Recovery",
    updated_at: new Date().toISOString(),
  };
  session.dispatch({ type: "opened", denied: false });
  await writeLocalPage(identity, session.localPage);
  return { session, identity, doc, comments, blockId, target };
}

test("capture stores full history, unknown nodes, native anchors and rich drafts without changing checkpoints", async () => {
  const { session, identity, doc, comments, blockId, target } = await fixture();
  const draft = {
    kind: "comment",
    body: "rich",
    spans: [{ type: "text", value: "rich", marks: { bold: true, future: "kept" } }],
    anchor: captureCommentDraft(doc, blockId, { text: "this passage", occurrence: 1 }),
    custom: { future: true },
  };
  session.watchCommentDrafts(() => [
    draft,
    {
      kind: "reply",
      thread_id: "thread",
      body: "",
      spans: [{ type: "block", value: { type: "image", attrs: { src: "asset" } } }],
    },
  ]);
  session.observeRefusal(
    Object.freeze({
      doc: "tree",
      r: 7,
      code: "invalid_page_content",
      correlated: true,
      fatal: false,
    }),
  );
  const before = await store.load(key(identity, session.pageId));
  const phase = session.phase$.snapshot();
  const handles = [session.handle, session.commentsHandle];
  const copy = await session.saveRecoveryCopy();
  assert.equal(session.recoveryCapture.state.name, "archived");
  assert.deepEqual(await store.load(key(identity, session.pageId)), before);
  assert.equal(session.phase$.snapshot(), phase);
  assert.deepEqual([session.handle, session.commentsHandle], handles);
  assert.equal(copy.document_id, session.handle.documentId);
  assert.equal(copy.comments_document_id, session.commentsHandle.documentId);
  const restored = A.load(decodeSnapshot(copy.snapshot));
  const restoredComments = A.load(decodeSnapshot(copy.comments_snapshot));
  assert.deepEqual(history(restored), history(doc));
  assert.deepEqual(history(restoredComments), history(comments));
  assert.deepEqual(A.getHeads(restored), copy.heads);
  assert.deepEqual(A.getHeads(restoredComments), copy.comment_heads);
  assert.deepEqual(A.toJS(restored), A.toJS(doc));
  assert.deepEqual(A.toJS(restoredComments), A.toJS(comments));
  assert.equal(
    A.getObjectId(restored.blocks[blockId], "richText"),
    A.getObjectId(doc.blocks[blockId], "richText"),
  );
  assert.deepEqual(selectionContext(restored, target), selectionContext(doc, target));
  assert.equal(selectionContext(restored, target).status, "attached");
  for (const thread of Object.values(restoredComments.threads))
    assert.equal(selectionContext(restored, thread.target).status, "attached");
  assert.deepEqual(copy.comment_drafts[0], draft);
  assert.deepEqual(resolveCommentDraft(restored, copy.comment_drafts[0].anchor), {
    block_id: blockId,
    selected_text: "this passage",
    occurrence: 1,
  });
  assert.equal(copy.comment_drafts.length, 2, "native image-only drafts survive");
  draft.spans[0].marks.bold = false;
  assert.equal(copy.comment_drafts[0].spans[0].marks.bold, true);
  const exported = session.exportRecovery(copy);
  assert.deepEqual(exported.refusal_evidence, copy.refusal_evidence);
  assert.equal(exported.document_id, copy.document_id);
  assert.deepEqual(exported.comment_drafts, copy.comment_drafts);
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 1);
  assert.equal((await listLocalRecoveries({ principal: "another" }, session.pageId)).length, 0);
  await assert.rejects(saveRecoveryCopy({ principal: "another" }, copy), /account/);
  A.free(restored);
  A.free(restoredComments);
});

test("capture and transaction failures retain both live documents and retry the immutable copy", async (t) => {
  const { session, identity } = await fixture();
  const before = await store.load(key(identity, session.pageId));
  const handles = [session.handle, session.commentsHandle];
  const stop = session.watchCommentDrafts(() => {
    throw Error("draft read failed");
  });
  await assert.rejects(session.saveRecoveryCopy(), /draft read failed/);
  assert.equal(session.recoveryCapture.state.name, "failed");
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 0);
  stop();
  const original = store.run.bind(store);
  const mocked = t.mock.method(store, "run", (mode, operation) =>
    mode === "readwrite"
      ? original(mode, (records, _done, fail) =>
          operation(records, () => fail(Error("transaction abort")), fail),
        )
      : original(mode, operation),
  );
  await assert.rejects(session.saveRecoveryCopy(), /transaction abort/);
  const copy = session.recoveryCapture.state.copy;
  assert.ok(copy);
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 0);
  mocked.mock.restore();
  assert.deepEqual(await session.saveRecoveryCopy(), copy);
  assert.deepEqual(await store.load(key(identity, session.pageId)), before);
  assert.deepEqual([session.handle, session.commentsHandle], handles);
});

test("lost acknowledgment and restart reconcile one archive ID; conflicting payload never overwrites it", async (t) => {
  const { session, identity } = await fixture();
  const persist = session.recoveryCapture.persist;
  const mock = t.mock.method(session.recoveryCapture, "persist", async (copy) => {
    await persist(copy);
    throw Error("lost acknowledgment");
  });
  await assert.rejects(session.saveRecoveryCopy(), /lost acknowledgment/);
  const copy = session.recoveryCapture.state.copy;
  await store.close();
  assert.deepEqual(await listLocalRecoveries(identity, session.pageId), [copy]);
  mock.mock.restore();
  assert.deepEqual(await session.saveRecoveryCopy(), copy);
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 1);
  await assert.rejects(saveRecoveryCopy(identity, { ...copy, title: "different" }), /another copy/);
});

test("capture requires current comments; a stale checkpoint is not silently substituted", async () => {
  const { session, comments } = await fixture();
  session.localPage.comments_snapshot = encodeSnapshot(A.save(comments));
  session.commentsHandle = undefined;
  await assert.rejects(session.saveRecoveryCopy(), /comments to load/);
  assert.equal(session.recoveryCapture.state.copy, undefined);
});

test("concurrent tabs keep distinct captures and a duplicate ID remains idempotent", async () => {
  const { session, identity } = await fixture();
  const before = await store.load(key(identity, session.pageId));
  const a = session.captureRecoveryCopy(crypto.randomUUID());
  const b = {
    ...a,
    capture_id: crypto.randomUUID(),
    comment_drafts: [{ kind: "reply", body: "other tab" }],
  };
  await Promise.all([
    saveRecoveryCopy(identity, a),
    saveRecoveryCopy(identity, b),
    saveRecoveryCopy(identity, a),
  ]);
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 2);
  assert.deepEqual(await store.load(key(identity, session.pageId)), before);
});

test("mixed retirement and capture archives offer the complete bundle, never a misleading latest draft", async () => {
  const { session, identity } = await fixture();
  const before = await store.load(key(identity, session.pageId));
  const retired = { ...session.localPage, title: "old retired draft" };
  await store.run("readwrite", (records) => archiveSnapshot(records, identity, retired, 5));
  const copy = {
    ...session.captureRecoveryCopy(crypto.randomUUID()),
    title: "new explicit capture",
  };
  const legacy = { ...session.localPage, title: "legacy unsequenced" };
  await store.save(
    `recovery/${encodeURIComponent(identity.principal)}/${session.pageId}/legacy`,
    new TextEncoder().encode(JSON.stringify(legacy)),
  );
  await saveRecoveryCopy(identity, copy);
  const records = await listLocalRecoveries(identity, session.pageId);
  assert.equal(
    records.at(-1).title,
    "old retired draft",
    "sequence ordering is not a cross-purpose latest capture",
  );
  const calls = [];
  const action = recovery.recoveryDownloadAction(records, (...args) => calls.push(args));
  assert.equal(action.label, "Download recovery copies");
  action.run();
  assert.deepEqual(calls, [[undefined, { bundle: true }]]);
  const bundle = session.exportRecoveries(records);
  assert.equal(bundle.copies.length, 3, "legacy and retirement archives remain accessible");
  assert.ok(bundle.copies.some((record) => record.capture_id === copy.capture_id));
  await Promise.all([saveRecoveryCopy(identity, copy), saveRecoveryCopy(identity, copy)]);
  assert.deepEqual(
    await listLocalRecoveries(identity, session.pageId),
    records,
    "idempotent concurrent retries do not reorder archives",
  );
  assert.deepEqual(await store.load(key(identity, session.pageId)), before);
  const oldAction = recovery.recoveryDownloadAction(
    records.filter((record) => record.recovery_kind !== "capture"),
    (...args) => calls.push(args),
  );
  assert.equal(oldAction.label, "Download previous local draft");
  oldAction.run();
  assert.equal(calls.at(-1)[0].title, "old retired draft");
  assert.equal(
    recovery.recoveryDownloadAction([], () => {}),
    undefined,
  );
  await Promise.all([
    store.run("readwrite", (rows) => archiveSnapshot(rows, identity, retired, 6)),
    saveRecoveryCopy(identity, { ...copy, capture_id: crypto.randomUUID() }),
  ]);
  const concurrent = await listLocalRecoveries(identity, session.pageId);
  assert.equal(concurrent.length, 5);
  assert.equal(
    recovery.recoveryDownloadAction(concurrent, () => {}).label,
    "Download recovery copies",
  );
  assert.equal(session.exportRecoveries(concurrent).copies.length, 5);
  assert.deepEqual(await store.load(key(identity, session.pageId)), before);
});

test("archive menu delegates purpose selection instead of selecting the last mixed record", () => {
  const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
  assert.match(source, /recoveryDownloadAction\(localRecoveries, downloadDraft\)/);
  assert.doesNotMatch(source, /downloadDraft\(localRecoveries\.at\(-1\)\)/);
});

test("serialization failure retains the live pair; a fresh explicit attempt can capture it", async (t) => {
  const { session, identity } = await fixture();
  const handles = [session.handle, session.commentsHandle];
  const fail = t.mock.method(session, "exportRecovery", () => {
    throw Error("snapshot failure");
  });
  await assert.rejects(session.saveRecoveryCopy(), /snapshot failure/);
  assert.deepEqual([session.handle, session.commentsHandle], handles);
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 0);
  fail.mock.restore();
  await session.saveRecoveryCopy();
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 1);
});

test("late archive completion belongs only to the captured account and cannot install handles or acknowledge edits", async (t) => {
  const { session, identity } = await fixture();
  let finish;
  const persist = session.recoveryCapture.persist;
  t.mock.method(
    session.recoveryCapture,
    "persist",
    (copy) =>
      new Promise((resolve) => {
        finish = async () => resolve(await persist(copy));
      }),
  );
  const save = session.saveRecoveryCopy();
  const other = { principal: crypto.randomUUID() };
  const handle = { documentId: newId(), doc: () => undefined };
  session.identity = other;
  session.handle = handle;
  const receipt = session.savedHeads;
  await finish();
  await save;
  assert.equal(session.handle, handle);
  assert.equal(session.savedHeads, receipt);
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 1);
  assert.equal((await listLocalRecoveries(other, session.pageId)).length, 0);
});

test("every state ignores irrelevant and stale completions; duplicate Save cannot overlap", async () => {
  const states = [
    RECOVERY_INITIAL,
    { name: "capturing", id: "a" },
    { name: "persisting", id: "a", copy: {} },
    { name: "failed", id: "a", copy: {} },
    { name: "archived", id: "a", record: {} },
  ];
  for (const state of states) {
    for (const type of ["captured", "persisted", "failed", "unrelated"])
      assert.equal(recoveryCaptureStep(state, { type, id: "stale" }), state);
    if (["capturing", "persisting"].includes(state.name))
      assert.equal(recoveryCaptureStep(state, { type: "save", id: "b" }), state);
  }
  const copy = { native: true },
    record = { archived: true };
  for (const state of states) {
    assert.deepEqual(
      recoveryCaptureStep(state, { type: "captured", id: state.id, copy }),
      state.name === "capturing" ? { name: "persisting", id: "a", copy } : state,
    );
    assert.deepEqual(
      recoveryCaptureStep(state, { type: "persisted", id: state.id, record }),
      state.name === "persisting" ? { name: "archived", id: "a", record } : state,
    );
    assert.deepEqual(
      recoveryCaptureStep(state, { type: "failed", id: state.id, error: "failure" }),
      ["capturing", "persisting"].includes(state.name)
        ? { ...state, name: "failed", error: "failure" }
        : state,
    );
  }
  let settle,
    captures = 0,
    writes = 0;
  const operation = new RecoveryCapture({
    capture: () => {
      captures++;
      return {};
    },
    persist: () => {
      writes++;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  });
  const first = operation.save();
  await operation.save();
  assert.deepEqual([captures, writes], [1, 1]);
  settle({ archived: true });
  await first;
  assert.equal(operation.state.name, "archived");
});

test("unmatched evidence is ignored and missing_dependencies is evidence, never a policy decision", async () => {
  const { session } = await fixture();
  session.observeRefusal({ code: "invalid_page_content", correlated: false });
  assert.equal(session.refusalEvidence, undefined);
  const phase = session.phase$.snapshot();
  session.observeRefusal({ code: "missing_dependencies", correlated: true });
  assert.equal(session.refusalEvidence.code, "missing_dependencies");
  assert.equal(session.phase$.snapshot(), phase);
  assert.equal(session.recoveryCapture.state.name, "idle");
});

test("native snapshot keeps queued changes whose dependencies have not arrived", () => {
  const base = A.from({ value: 1 });
  const changed = A.change(base, (d) => {
    d.value = 2;
  });
  const pending = A.applyChanges(A.init(), [A.getLastLocalChange(changed)])[0];
  assert.ok(A.getMissingDeps(pending).length);
  const loaded = A.load(A.save(pending));
  assert.deepEqual(A.getMissingDeps(loaded), A.getMissingDeps(pending));
  const completed = A.applyChanges(loaded, [A.getAllChanges(changed)[0]])[0];
  assert.deepEqual(history(completed), history(changed));
  assert.deepEqual(A.toJS(completed), A.toJS(changed));
});
