// ONE-SHOT MIGRATION tests: delete with content-migration.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import {
  CONTENT_MIGRATION_RESULT_PREFIX,
  CONTENT_MIGRATION_STATE_KEY,
  contentMigrationArguments,
  contentMigrationStep,
  contentMigrationTargets,
  runContentMigration,
} from "./content-migration.mjs";
import { listAll } from "./catalog.mjs";
import { INTERNAL_PREFIX, reserveOperation } from "./operation-journal.mjs";
import { Storage, fixture, pageId } from "./trash-fixture.mjs";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { adapterSpans } from "../model/richtext-spans.mjs";
import { parseMarkdown } from "../model/markdown-import.mjs";
import { updateSpansConfig } from "../model/marks.mjs";
import { textPath } from "../model/richtext-format.mjs";
import { decode, encode } from "../model/wordgard-doc.mjs";
import { RICH_FORMAT } from "../model/richtext-format.mjs";
import { comment } from "../model/comments-test-support.mjs";

const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const args = (body) => contentMigrationArguments(body);

async function catalogWith(keys) {
  const storage = new Storage();
  for (const [key, value] of Object.entries(keys)) await storage.put(key, value);
  return storage;
}

test("contentMigrationStep: every phase takes exactly its events", () => {
  const start = contentMigrationStep({ phase: "none" }, { type: "start", ids: [id(1), id(2)] });
  assert.deepEqual(start.state, { phase: "applying", ids: [id(1), id(2)], next: 0, pass: 1 });
  assert.ok(contentMigrationStep(start.state, { type: "start", ids: [] }).rejected);
  assert.ok(contentMigrationStep(start.state, { type: "visited", page_id: id(2) }).rejected);
  assert.ok(contentMigrationStep(start.state, { type: "finished", pending: [] }).rejected);
  assert.ok(
    contentMigrationStep({ phase: "none" }, { type: "start", ids: [id(1), id(1)] }).rejected,
  );
  const one = contentMigrationStep(start.state, { type: "visited", page_id: id(1) }).state;
  const two = contentMigrationStep(one, { type: "visited", page_id: id(2) }).state;
  assert.equal(two.next, 2);
  assert.ok(contentMigrationStep(two, { type: "visited", page_id: id(2) }).rejected);
  assert.ok(contentMigrationStep(two, { type: "finished", pending: [id(9)] }).rejected);
  const incomplete = contentMigrationStep(two, { type: "finished", pending: [id(2)] }).state;
  assert.deepEqual(incomplete, { phase: "incomplete", pending: [id(2)], pass: 1 });
  assert.ok(contentMigrationStep(incomplete, { type: "visited", page_id: id(2) }).rejected);
  const again = contentMigrationStep(incomplete, { type: "start", ids: [id(2)] }).state;
  assert.equal(again.pass, 2);
  const done = contentMigrationStep(
    contentMigrationStep(again, { type: "visited", page_id: id(2) }).state,
    { type: "finished", pending: [] },
  ).state;
  assert.deepEqual(done, { phase: "done", pass: 2 });
  for (const type of ["start", "visited", "finished"])
    assert.ok(contentMigrationStep(done, { type, ids: [], page_id: id(1), pending: [] }).rejected);
  assert.ok(contentMigrationStep(done, { type: "other" }).rejected);
});

test("arguments are validated", () => {
  assert.deepEqual(args({ mode: "dry_run" }), {
    mode: "dry_run",
    limit: 10,
    after: null,
    page_ids: [],
  });
  for (const body of [
    {},
    { mode: "go" },
    { mode: "apply", limit: 0 },
    { mode: "apply", limit: 26 },
    { mode: "dry_run", after: "nope" },
    { mode: "dry_run", page_ids: ["x"] },
  ])
    assert.throws(() => args(body), { code: "invalid_arguments" }, JSON.stringify(body));
});

test("targets: owned, trashed, tombstoned and named Pages, never shared ones", async () => {
  const storage = await catalogWith({
    [`page/${id(3)}`]: { page_id: id(3) },
    [`trash/${id(1)}`]: { page_id: id(1) },
    [`trash/${id(4)}`]: { page_id: id(4) },
    [`host/deleted/${id(4)}`]: true,
    [`host/deleted/${id(5)}`]: true,
    [`shared/${id(6)}`]: { page_id: id(6) },
  });
  const { targets, tombstones } = await contentMigrationTargets(storage, listAll, [id(7), id(3)]);
  assert.deepEqual(targets, [
    { page_id: id(1), kind: "trash" },
    { page_id: id(3), kind: "page" },
    { page_id: id(4), kind: "trash" },
    { page_id: id(5), kind: "deleted" },
    { page_id: id(7), kind: "extra" },
  ]);
  assert.deepEqual(tombstones, [
    { page_id: id(4), trash_entry: true },
    { page_id: id(5), trash_entry: false },
  ]);
});

test("dry run pages through every target and writes nothing", async () => {
  const keys = {};
  for (let n = 1; n <= 5; n++) keys[`page/${id(n)}`] = { page_id: id(n) };
  const storage = await catalogWith(keys);
  const before = structuredClone(storage.values);
  const seen = [];
  const visit = async (pageId, mode) => {
    seen.push([pageId, mode]);
    return { status: "would_normalize", report: { forms: { first_marker: 1 }, blocks: [] } };
  };
  const first = await runContentMigration(storage, {
    args: args({ mode: "dry_run", limit: 2 }),
    listAll,
    visit,
  });
  assert.deepEqual(first.visited, [id(1), id(2)]);
  assert.equal(first.next, id(2));
  assert.deepEqual(first.targets, { total: 5, page: 5 });
  assert.deepEqual(first.totals.forms, { first_marker: 2 });
  assert.deepEqual(first.progress, { phase: "none" });
  const second = await runContentMigration(storage, {
    args: args({ mode: "dry_run", limit: 5, after: first.next }),
    listAll,
    visit,
  });
  assert.deepEqual(second.visited, [id(3), id(4), id(5)]);
  assert.equal(second.next, null);
  assert.ok(seen.every(([, mode]) => mode === "dry_run"));
  assert.deepEqual(storage.values, before);
});

test("a call starts no visit past its budget", async () => {
  const keys = {};
  for (let n = 1; n <= 4; n++) keys[`page/${id(n)}`] = { page_id: id(n) };
  const storage = await catalogWith(keys);
  let now = 0;
  const visit = async () => {
    now += 40_000;
    return { status: "unchanged" };
  };
  const result = await runContentMigration(storage, {
    args: args({ mode: "apply", limit: 4 }),
    listAll,
    visit,
    clock: () => now,
  });
  assert.equal(result.visited.length, 2);
  assert.equal(result.progress.next, 2);
});

test("apply runs in batches, keeps each result, resumes after a crash and finishes pending Pages", async () => {
  const keys = {};
  for (let n = 1; n <= 4; n++) keys[`page/${id(n)}`] = { page_id: id(n) };
  const storage = await catalogWith(keys);
  // Page 3 is busy on the first pass; page 2's first visit "crashes" the
  // Catalog after the Page wrote (its result never lands).
  const writes = new Map();
  let crashOnce = true;
  const visit = async (pageId) => {
    if (pageId === id(2) && crashOnce) {
      writes.set(pageId, (writes.get(pageId) ?? 0) + 1);
      crashOnce = false;
      throw Object.assign(Error("process killed"), { crash: true });
    }
    if (pageId === id(3) && !writes.has("pass2")) return { status: "busy" };
    if (pageId === id(2))
      return {
        status: "unchanged",
        revert: [{ key: "k", before_heads: ["h0"], after_heads: ["h"], blocks: [] }],
      };
    writes.set(pageId, (writes.get(pageId) ?? 0) + 1);
    return {
      status: "normalized",
      before_heads: ["a"],
      after_heads: ["b"],
      report: {
        refused: 0,
        forms: { first_marker: 1 },
        blocks: [{ block_id: "x", action: "normalize" }],
      },
    };
  };
  const call = () =>
    runContentMigration(storage, { args: args({ mode: "apply", limit: 2 }), listAll, visit });
  const first = await call();
  assert.deepEqual(first.visited, [id(1), id(2)]);
  assert.equal(first.pages[1].status, "error");
  assert.deepEqual(first.progress, { phase: "applying", next: 2, pass: 1, total: 4 });
  const stored = await storage.get(`${CONTENT_MIGRATION_RESULT_PREFIX}${id(1)}`);
  assert.deepEqual(stored.before_heads, ["a"]);
  assert.deepEqual(stored.report.refused_block_ids, []);
  assert.equal(stored.report.blocks, undefined);
  const second = await call();
  assert.deepEqual(second.visited, [id(3), id(4)]);
  assert.deepEqual(second.progress, { phase: "incomplete", pending: [id(2), id(3)], pass: 1 });
  writes.set("pass2", true);
  const third = await call();
  assert.deepEqual(third.visited, [id(2), id(3)]);
  assert.deepEqual(third.progress, { phase: "done", pass: 2 });
  assert.deepEqual((await storage.get(`${CONTENT_MIGRATION_RESULT_PREFIX}${id(2)}`)).revert, [
    { key: "k", before_heads: ["h0"], after_heads: ["h"], blocks: [] },
  ]);
  // Done is terminal: another apply visits nothing.
  const fourth = await call();
  assert.deepEqual(fourth.visited, []);
  assert.deepEqual((await storage.get(CONTENT_MIGRATION_STATE_KEY)).phase, "done");
  for (const n of [1, 3, 4]) assert.equal(writes.get(id(n)), 1);
});

// The whole path: owner → Catalog → Page host, over a Page stored in the
// ProseMirror adapter's form.

function adapterDocBytes() {
  let doc = A.change(A.from(createPageData({ pageId, title: "Launch plan" })), (draft) =>
    initializePage(draft, ""),
  );
  const block = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) =>
    A.updateSpans(
      draft,
      textPath(block),
      adapterSpans(parseMarkdown("We ship on Friday.\n\n> - quoted item\n\nThen we rest.")),
      updateSpansConfig,
    ),
  );
  const bytes = A.save(doc);
  A.free(doc);
  return { bytes, block };
}

async function adapterFixture(t) {
  const plain = await fixture(t);
  const { bytes, block } = adapterDocBytes();
  const f = await fixture(t, { auth: plain.auth, docBytes: bytes });
  // As at the end of loadDocument.
  await f.page.convertPreservedMarkdown();
  const run = async (body, token = f.tokens.owner) => {
    const response = await f
      .catalogOf(f.owner)
      .catalog.fetch(f.request(token, "/internal/content-migration", body));
    return { status: response.status, body: await response.json() };
  };
  return { f, block, run };
}

/** Whether `block` holds the editor's canonical spans: rewriting it to
 * them changes nothing. */
const canonical = (doc, block) => {
  const path = textPath(block);
  const rewritten = A.change(A.clone(doc), (draft) =>
    A.updateSpans(draft, path, encode(decode(A.spans(doc, path)).doc), updateSpansConfig),
  );
  const same = A.getHeads(rewritten).join() === A.getHeads(doc).join();
  A.free(rewritten);
  return same;
};

test("end to end: dry run reports, apply normalizes once, a second run writes nothing", async (t) => {
  const { f, block, run } = await adapterFixture(t);
  const heads = f.heads();
  const dry = await run({ mode: "dry_run" });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.pages.length, 1);
  const page = dry.body.pages[0];
  assert.equal(page.status, "would_normalize");
  assert.deepEqual(page.report.forms, { first_marker: 1, quote_marker: 1 });
  assert.equal(page.record_comments_doc, true);
  assert.deepEqual(f.heads(), heads, "dry run wrote nothing");
  assert.equal(await f.catalogOf(f.owner).storage.get(CONTENT_MIGRATION_STATE_KEY), undefined);

  const applied = await run({ mode: "apply" });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.pages[0].status, "normalized");
  assert.deepEqual(applied.body.pages[0].before_heads, [...heads].sort());
  assert.deepEqual(applied.body.pages[0].problems, []);
  assert.deepEqual(applied.body.progress, { phase: "done", pass: 1 });
  assert.ok(canonical(f.doc(), block));
  const after = f.heads();
  // One journaled host change.
  const entries = [...(await f.storage.list({ prefix: "host/operation/internal:content_norm_" }))];
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1].pending, false);

  const again = await run({ mode: "apply" });
  assert.deepEqual(again.body.visited, []);
  const verify = await run({ mode: "dry_run" });
  assert.equal(verify.body.pages[0].status, "unchanged");
  assert.equal(verify.body.pages[0].revert.length, 1);
  assert.deepEqual(f.heads(), after);
});

test("end to end: only the owner runs it, and apply needs write", async (t) => {
  const { f, run } = await adapterFixture(t);
  const stranger = await run({ mode: "dry_run" }, f.tokens.member);
  assert.equal(stranger.status, 403);
  // The Page host refuses a credentialed request on its migration route.
  const direct = await f.pageCall("owner", "/internal/content-migration", {
    page_id: pageId,
    owner: f.owner,
    mode: "apply",
  });
  assert.equal(direct.status, 404);
});

test("end to end: a Page with a live socket is skipped as busy and finished on the next pass", async (t) => {
  const { f, block, run } = await adapterFixture(t);
  const wire = { disconnect: async () => {} };
  f.page.wires.add(wire);
  const first = await run({ mode: "apply" });
  assert.equal(first.body.pages[0].status, "busy");
  assert.deepEqual(first.body.progress, { phase: "incomplete", pending: [pageId], pass: 1 });
  assert.ok(!canonical(f.doc(), block));
  f.page.wires.delete(wire);
  const second = await run({ mode: "apply" });
  assert.equal(second.body.pages[0].status, "normalized");
  assert.deepEqual(second.body.progress, { phase: "done", pass: 2 });
});

test("end to end: a crash mid-apply replays the recorded change once", async (t) => {
  const { f, block, run } = await adapterFixture(t);
  let flushes = 0;
  // Flush 1 precedes the journal reserve; flush 2 follows the replay. Cut 2:
  // the intent is durable, the document bytes are not.
  f.hooks.flush = () => {
    if (++flushes === 2) throw Object.assign(Error("process killed"), { cut: true });
  };
  t.mock.method(console, "error", () => {});
  const first = await run({ mode: "apply" });
  assert.equal(first.body.pages[0].status, "error");
  const pending = [
    ...(await f.storage.list({ prefix: "host/operation/internal:content_norm_" })),
  ].filter(([, entry]) => entry.pending);
  assert.equal(pending.length, 1);
  f.hooks.flush = undefined;
  await f.crashRestart();
  assert.ok(canonical(f.doc(), block), "recovery replayed the recorded change");
  const heads = f.heads();
  const second = await run({ mode: "apply" });
  assert.equal(second.body.pages[0].status, "unchanged");
  assert.deepEqual(second.body.progress, { phase: "done", pass: 2 });
  assert.deepEqual(f.heads(), heads);
  // The write the crash interrupted still has its revert record.
  const stored = await f
    .catalogOf(f.owner)
    .storage.get(`${CONTENT_MIGRATION_RESULT_PREFIX}${pageId}`);
  assert.equal(stored.revert.length, 1);
  assert.deepEqual(stored.revert[0].blocks, [{ block_id: block, action: "normalize" }]);
  assert.deepEqual(stored.revert[0].after_heads, heads);
});

const paragraph = (parents = []) => ({
  type: "block",
  value: { type: "paragraph", parents, attrs: {}, isEmbed: false },
});

test("end to end: apply writes nothing on a Page that became blocked after its dry run", async (t) => {
  const { f, block, run } = await adapterFixture(t);
  const dry = await run({ mode: "dry_run" });
  assert.equal(dry.body.pages[0].status, "would_normalize");
  // Between the dry run and apply, a block the editor can't hold appears.
  const lossy = "b".repeat(8);
  await f.page.handle.update((doc) =>
    A.change(doc, (draft) => {
      draft.blocks[lossy] = {
        id: lossy,
        position: "a9",
        kind: "markdown",
        format: RICH_FORMAT,
        markdown: "",
        richText: "",
        metadata: {},
      };
      A.updateSpans(
        draft,
        textPath(lossy),
        [paragraph(["mystery-container"]), { type: "text", value: "inside", marks: {} }],
        updateSpansConfig,
      );
    }),
  );
  const heads = f.heads();
  const applied = await run({ mode: "apply" });
  assert.deepEqual(f.heads(), heads, "nothing written");
  assert.equal(applied.body.pages[0].status, "partial");
  assert.deepEqual(applied.body.pages[0].report.refused_reasons, { lossy: 1 });
  assert.ok(!canonical(f.doc(), block));
  assert.deepEqual(applied.body.progress, { phase: "incomplete", pending: [pageId], pass: 1 });
});

test("end to end: apply refuses a rewrite that would detach a comment anchor", async (t) => {
  const { f, block, run } = await adapterFixture(t);
  await f.page.handle.update((doc) =>
    A.change(doc, (draft) =>
      A.updateSpans(
        draft,
        textPath(block),
        [paragraph(), { type: "text", value: "first\nsecond", marks: {} }],
        updateSpansConfig,
      ),
    ),
  );
  await f.page.commentsHandle.update(
    (comments) =>
      comment(f.doc(), comments, { block_id: block, selected_text: "t\n", body: "Edge" }).comments,
  );
  const heads = f.heads();
  const applied = await run({ mode: "apply" });
  assert.equal(applied.body.pages[0].status, "partial");
  assert.deepEqual(applied.body.pages[0].report.refused_reasons, { anchors_detached: 1 });
  assert.deepEqual(f.heads(), heads, "nothing written");
});

test("end to end: the revert record outlives a revisit and the journal receipt", async (t) => {
  const { f, block, run } = await adapterFixture(t);
  const before = [...f.heads()].sort();
  const applied = await run({ mode: "apply" });
  assert.equal(applied.body.pages[0].status, "normalized");
  const after = f.heads();
  const expected = {
    before_heads: before,
    after_heads: after,
    blocks: [{ block_id: block, action: "normalize" }],
  };
  const catalog = f.catalogOf(f.owner).storage;
  const resultKey = `${CONTENT_MIGRATION_RESULT_PREFIX}${pageId}`;
  const record = (value) => value.revert.map(({ key: _key, ...rest }) => rest);
  assert.deepEqual(record(await catalog.get(resultKey)), [expected]);
  // A later host migration's reservation drops finished internal receipts.
  await reserveOperation(f.storage, {
    key: `${INTERNAL_PREFIX}later_migration_0001`,
    entry: { fingerprint: "x", pending: true, changes: [], receipt: {} },
  });
  assert.equal(
    (await f.storage.list({ prefix: `${INTERNAL_PREFIX}content_norm_` })).size,
    0,
    "the journal receipt is gone",
  );
  // The operator runs the pass again: the Page has nothing to write.
  await catalog.delete(CONTENT_MIGRATION_STATE_KEY);
  const revisit = await run({ mode: "apply" });
  assert.equal(revisit.body.pages[0].status, "unchanged");
  assert.deepEqual(record(await catalog.get(resultKey)), [expected]);
  // The Page keeps its own copy too.
  const dry = await run({ mode: "dry_run" });
  assert.deepEqual(record(dry.body.pages[0]), [expected]);
});

test("end to end: an edit between plan and write gets stale heads and writes nothing", async (t) => {
  const { f, block, run } = await adapterFixture(t);
  // A native edit lands while the host reads its journal for the new intent.
  const get = f.storage.get.bind(f.storage);
  let edited = false;
  f.storage.get = async (key) => {
    if (!edited && key.startsWith(`${INTERNAL_PREFIX}content_norm_`)) {
      edited = true;
      f.edit("Edited meanwhile");
    }
    return get(key);
  };
  const applied = await run({ mode: "apply" });
  assert.ok(edited);
  assert.equal(applied.body.pages[0].status, "stale");
  assert.ok(!canonical(f.doc(), block), "nothing written");
  assert.equal((await f.storage.list({ prefix: `${INTERNAL_PREFIX}content_norm_` })).size, 0);
  assert.deepEqual(applied.body.progress, { phase: "incomplete", pending: [pageId], pass: 1 });
  f.storage.get = get;
  const retried = await run({ mode: "apply" });
  assert.equal(retried.body.pages[0].status, "normalized");
});

test("a revisit keeps the revert records an earlier visit stored", async () => {
  const storage = await catalogWith({ [`page/${id(1)}`]: { page_id: id(1) } });
  const record = { key: "k1", before_heads: ["a"], after_heads: ["b"], blocks: [] };
  const answers = [{ status: "normalized", revert: [record] }, { status: "unchanged" }];
  const visit = async () => answers.shift();
  await runContentMigration(storage, { args: args({ mode: "apply" }), listAll, visit });
  await storage.delete(CONTENT_MIGRATION_STATE_KEY);
  await runContentMigration(storage, { args: args({ mode: "apply" }), listAll, visit });
  const stored = await storage.get(`${CONTENT_MIGRATION_RESULT_PREFIX}${id(1)}`);
  assert.equal(stored.status, "unchanged");
  assert.deepEqual(stored.revert, [record]);
});
