// ONE-SHOT MIGRATION tests: delete with comments-migration.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import {
  COMMENTS_MIGRATION_RESULT_PREFIX,
  COMMENTS_MIGRATION_STATE_KEY,
  commentsMigrationArguments,
  commentsMigrationStep,
  commentsMigrationTargets,
  runCommentsMigration,
} from "./comments-migration.mjs";
import { listAll } from "./catalog.mjs";
import { INTERNAL_PREFIX, reserveOperation } from "./operation-journal.mjs";
import { Storage, fixture, pageId } from "./trash-fixture.mjs";
import { adapterSpans } from "../model/richtext-spans.mjs";
import { parseMarkdown } from "../model/markdown-import.mjs";
import { projectReadComments } from "../model/read-comments.mjs";
import { planCommentsNormalization } from "../model/comments-normalization.mjs";
import { RICH_FORMAT } from "../model/richtext-format.mjs";

const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const args = (body) => commentsMigrationArguments(body);

async function catalogWith(keys) {
  const storage = new Storage();
  for (const [key, value] of Object.entries(keys)) await storage.put(key, value);
  return storage;
}

test("commentsMigrationStep: every phase takes exactly its events", () => {
  const start = commentsMigrationStep({ phase: "none" }, { type: "start", ids: [id(1), id(2)] });
  assert.deepEqual(start.state, { phase: "applying", ids: [id(1), id(2)], next: 0, pass: 1 });
  assert.ok(commentsMigrationStep(start.state, { type: "start", ids: [] }).rejected);
  assert.ok(commentsMigrationStep(start.state, { type: "visited", page_id: id(2) }).rejected);
  assert.ok(commentsMigrationStep(start.state, { type: "finished", pending: [] }).rejected);
  assert.ok(
    commentsMigrationStep({ phase: "none" }, { type: "start", ids: [id(1), id(1)] }).rejected,
  );
  const one = commentsMigrationStep(start.state, { type: "visited", page_id: id(1) }).state;
  const two = commentsMigrationStep(one, { type: "visited", page_id: id(2) }).state;
  assert.equal(two.next, 2);
  assert.ok(commentsMigrationStep(two, { type: "visited", page_id: id(2) }).rejected);
  assert.ok(commentsMigrationStep(two, { type: "finished", pending: [id(9)] }).rejected);
  const incomplete = commentsMigrationStep(two, { type: "finished", pending: [id(2)] }).state;
  assert.deepEqual(incomplete, { phase: "incomplete", pending: [id(2)], pass: 1 });
  assert.ok(commentsMigrationStep(incomplete, { type: "visited", page_id: id(2) }).rejected);
  const again = commentsMigrationStep(incomplete, { type: "start", ids: [id(2)] }).state;
  assert.equal(again.pass, 2);
  const done = commentsMigrationStep(
    commentsMigrationStep(again, { type: "visited", page_id: id(2) }).state,
    { type: "finished", pending: [] },
  ).state;
  assert.deepEqual(done, { phase: "done", pass: 2 });
  for (const type of ["start", "visited", "finished"])
    assert.ok(commentsMigrationStep(done, { type, ids: [], page_id: id(1), pending: [] }).rejected);
  assert.ok(commentsMigrationStep(done, { type: "other" }).rejected);
});

test("arguments are validated", () => {
  assert.deepEqual(args({ mode: "dry_run" }), {
    mode: "dry_run",
    limit: 10,
    after: null,
    page_ids: [],
    include_connected: false,
  });
  for (const body of [
    {},
    { mode: "go" },
    { mode: "apply", limit: 0 },
    { mode: "apply", limit: 26 },
    { mode: "dry_run", after: "nope" },
    { mode: "dry_run", page_ids: ["x"] },
    { mode: "apply", include_connected: "yes" },
  ])
    assert.throws(() => args(body), { code: "invalid_arguments" }, JSON.stringify(body));
});

test("targets: owned, trashed and named Pages, never shared or deleted ones", async () => {
  const storage = await catalogWith({
    [`page/${id(3)}`]: { page_id: id(3) },
    [`trash/${id(1)}`]: { page_id: id(1) },
    [`host/deleted/${id(5)}`]: true,
    [`shared/${id(6)}`]: { page_id: id(6) },
  });
  assert.deepEqual(await commentsMigrationTargets(storage, listAll, [id(7), id(3)]), [
    { page_id: id(1), kind: "trash" },
    { page_id: id(3), kind: "page" },
    { page_id: id(7), kind: "extra" },
  ]);
});

test("dry run pages through every target and writes nothing", async () => {
  const keys = {};
  for (let n = 1; n <= 5; n++) keys[`page/${id(n)}`] = { page_id: id(n) };
  const storage = await catalogWith(keys);
  const before = structuredClone(storage.values);
  const seen = [];
  const visit = async (page, mode) => {
    seen.push([page, mode]);
    return { status: "would_normalize", report: { forms: { plain_body: 1 }, messages: [] } };
  };
  const first = await runCommentsMigration(storage, {
    args: args({ mode: "dry_run", limit: 2 }),
    listAll,
    visit,
  });
  assert.deepEqual(first.visited, [id(1), id(2)]);
  assert.equal(first.next, id(2));
  assert.deepEqual(first.targets, { total: 5, page: 5 });
  assert.deepEqual(first.totals.forms, { plain_body: 2 });
  assert.deepEqual(first.progress, { phase: "none" });
  const second = await runCommentsMigration(storage, {
    args: args({ mode: "dry_run", limit: 5, after: first.next }),
    listAll,
    visit,
  });
  assert.deepEqual(second.visited, [id(3), id(4), id(5)]);
  assert.equal(second.next, null);
  assert.ok(seen.every(([, mode]) => mode === "dry_run"));
  assert.deepEqual(storage.values, before);
});

test("apply runs in batches, keeps each result, resumes after a crash and finishes pending Pages", async () => {
  const keys = {};
  for (let n = 1; n <= 4; n++) keys[`page/${id(n)}`] = { page_id: id(n) };
  const storage = await catalogWith(keys);
  const writes = new Map();
  let crashOnce = true;
  const visit = async (page) => {
    if (page === id(2) && crashOnce) {
      crashOnce = false;
      throw Error("process killed");
    }
    if (page === id(3) && !writes.has("pass2")) return { status: "busy" };
    if (page === id(2))
      return {
        status: "unchanged",
        revert: [{ key: "k", before_heads: ["h0"], after_heads: ["h"], messages: [] }],
      };
    writes.set(page, (writes.get(page) ?? 0) + 1);
    return {
      status: "normalized",
      before_heads: ["a"],
      after_heads: ["b"],
      report: {
        refused: 0,
        forms: { plain_body: 1 },
        messages: [{ thread_id: "t", message_id: "m", action: "plain" }],
      },
    };
  };
  const call = () =>
    runCommentsMigration(storage, { args: args({ mode: "apply", limit: 2 }), listAll, visit });
  const first = await call();
  assert.deepEqual(first.visited, [id(1), id(2)]);
  assert.equal(first.pages[1].status, "error");
  assert.deepEqual(first.progress, { phase: "applying", next: 2, pass: 1, total: 4 });
  const stored = await storage.get(`${COMMENTS_MIGRATION_RESULT_PREFIX}${id(1)}`);
  assert.deepEqual(stored.before_heads, ["a"]);
  assert.deepEqual(stored.report.refused_messages, []);
  assert.equal(stored.report.messages, undefined);
  const second = await call();
  assert.deepEqual(second.visited, [id(3), id(4)]);
  assert.deepEqual(second.progress, { phase: "incomplete", pending: [id(2), id(3)], pass: 1 });
  writes.set("pass2", true);
  const third = await call();
  assert.deepEqual(third.visited, [id(2), id(3)]);
  assert.deepEqual(third.progress, { phase: "done", pass: 2 });
  assert.deepEqual((await storage.get(`${COMMENTS_MIGRATION_RESULT_PREFIX}${id(2)}`)).revert, [
    { key: "k", before_heads: ["h0"], after_heads: ["h"], messages: [] },
  ]);
  const fourth = await call();
  assert.deepEqual(fourth.visited, []);
  assert.equal((await storage.get(COMMENTS_MIGRATION_STATE_KEY)).phase, "done");
  for (const n of [1, 3, 4]) assert.equal(writes.get(id(n)), 1);
});

// The whole path: owner → Catalog → Page host, over comments an earlier
// build stored: a plain message and an adapter-form rich one with its copy.

const LITERAL = "2 * 3 is **six**\nsecond line";
const MARKDOWN = "We ship **Friday**.\n\n> - quoted item";

async function legacyFixture(t) {
  const f = await fixture(t);
  await f.page.commentsHandle.update((comments) =>
    A.change(comments, (d) => {
      const [threadId] = Object.keys(d.threads);
      const thread = d.threads[threadId];
      const [messageId] = Object.keys(thread.messages);
      const author = { ...thread.messages[messageId].author };
      thread.messages[messageId] = {
        body: LITERAL,
        author,
        createdAt: "2026-10-01T00:00:00.000Z",
        deletedAt: null,
      };
      thread.messages.rich = {
        body: MARKDOWN,
        format: RICH_FORMAT,
        richText: "",
        author,
        createdAt: "2026-10-02T00:00:00.000Z",
        deletedAt: null,
      };
      A.updateSpans(
        d,
        ["threads", threadId, "messages", "rich", "richText"],
        adapterSpans(parseMarkdown(MARKDOWN)),
      );
    }),
  );
  const run = async (body, token = f.tokens.owner) => {
    const response = await f
      .catalogOf(f.owner)
      .catalog.fetch(f.request(token, "/internal/comments-migration", body));
    return { status: response.status, body: await response.json() };
  };
  return { f, run };
}
const reads = (f) => projectReadComments(f.doc(), {}, f.commentsDoc());
const migrated = (f) => planCommentsNormalization(f.commentsDoc()).writes.length === 0;

test("end to end: dry run reports, apply normalizes once, a second run writes nothing", async (t) => {
  const { f, run } = await legacyFixture(t);
  const pageHeads = f.heads();
  const heads = f.commentHeads();
  const before = reads(f);
  const dry = await run({ mode: "dry_run" });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  const page = dry.body.pages[0];
  assert.equal(page.status, "would_normalize");
  assert.deepEqual(page.report.forms, {
    plain_body: 1,
    markdown_copy: 1,
    first_marker: 1,
    quote_marker: 1,
  });
  assert.deepEqual(f.commentHeads(), heads, "dry run wrote nothing");
  assert.equal(await f.catalogOf(f.owner).storage.get(COMMENTS_MIGRATION_STATE_KEY), undefined);

  const applied = await run({ mode: "apply" });
  assert.equal(applied.body.pages[0].status, "normalized", JSON.stringify(applied.body));
  assert.deepEqual(applied.body.pages[0].before_heads, [...heads].sort());
  assert.deepEqual(applied.body.pages[0].problems, []);
  assert.deepEqual(applied.body.progress, { phase: "done", pass: 1 });
  assert.ok(migrated(f));
  assert.deepEqual(reads(f), before, "every read is unchanged: ids, bodies, formats, anchors");
  assert.deepEqual(f.heads(), pageHeads, "the Page document is never written");
  for (const message of Object.values(Object.values(f.commentsDoc().threads)[0].messages)) {
    assert.equal(message.format, RICH_FORMAT);
    assert.equal(message.body, undefined);
  }
  const entries = [...(await f.storage.list({ prefix: `${INTERNAL_PREFIX}comments_norm_` }))];
  assert.equal(entries.length, 1, "one journaled host change");
  assert.equal(entries[0][1].pending, false);
  const after = f.commentHeads();
  const again = await run({ mode: "apply" });
  assert.deepEqual(again.body.visited, []);
  const verify = await run({ mode: "dry_run" });
  assert.equal(verify.body.pages[0].status, "unchanged");
  assert.equal(verify.body.pages[0].revert.length, 1);
  assert.deepEqual(f.commentHeads(), after);
});

test("end to end: only the owner runs it, and apply needs write", async (t) => {
  const { f, run } = await legacyFixture(t);
  const stranger = await run({ mode: "dry_run" }, f.tokens.member);
  assert.equal(stranger.status, 403);
  const direct = await f.pageCall("owner", "/internal/comments-migration", {
    page_id: pageId,
    owner: f.owner,
    mode: "apply",
  });
  assert.equal(direct.status, 404);
  const readOnly = await run({ mode: "apply" }, f.auth.apiKey({ scopes: ["cloud:read"] }));
  assert.equal(readOnly.status, 403, JSON.stringify(readOnly));
});

test("end to end: a Page with a live socket is skipped as busy unless include_connected", async (t) => {
  const { f, run } = await legacyFixture(t);
  const disconnected = [];
  f.page.wires.add({ disconnect: async () => disconnected.push("wire") });
  const first = await run({ mode: "apply" });
  assert.equal(first.body.pages[0].status, "busy");
  assert.deepEqual(first.body.progress, { phase: "incomplete", pending: [pageId], pass: 1 });
  assert.ok(!migrated(f));
  const second = await run({ mode: "apply", include_connected: true });
  assert.equal(second.body.pages[0].status, "normalized");
  assert.equal(second.body.pages[0].connected, 1);
  assert.deepEqual(disconnected, [], "no peer is disconnected");
});

test("end to end: a peer's change between plan and write gets stale heads and writes nothing", async (t) => {
  const { f, run } = await legacyFixture(t);
  const get = f.storage.get.bind(f.storage);
  let edited = false;
  f.storage.get = async (key) => {
    if (!edited && key.startsWith(`${INTERNAL_PREFIX}comments_norm_`)) {
      edited = true;
      await f.page.commentsHandle.update((comments) =>
        A.change(comments, (d) => {
          const thread = Object.values(d.threads)[0];
          thread.status = { value: "resolved", at: new Date().toISOString() };
        }),
      );
    }
    return get(key);
  };
  const applied = await run({ mode: "apply" });
  assert.ok(edited);
  assert.equal(applied.body.pages[0].status, "stale");
  assert.ok(!migrated(f), "nothing written");
  f.storage.get = get;
  const retried = await run({ mode: "apply" });
  assert.equal(retried.body.pages[0].status, "normalized");
});

test("end to end: apply writes nothing when a message became unrewritable after the dry run", async (t) => {
  const { f, run } = await legacyFixture(t);
  assert.equal((await run({ mode: "dry_run" })).body.pages[0].status, "would_normalize");
  await f.page.commentsHandle.update((comments) =>
    A.change(comments, (d) => {
      const thread = Object.values(d.threads)[0];
      thread.messages.lossy = {
        format: RICH_FORMAT,
        richText: "",
        author: { principal: f.owner, displayName: "Owner", driver: "Browser" },
        createdAt: "2026-10-03T00:00:00.000Z",
        deletedAt: null,
      };
      const [threadId] = Object.keys(d.threads);
      A.updateSpans(
        d,
        ["threads", threadId, "messages", "lossy", "richText"],
        [
          {
            type: "block",
            value: { type: "paragraph", parents: ["mystery-container"], attrs: {}, isEmbed: false },
          },
          { type: "text", value: "inside", marks: {} },
        ],
      );
    }),
  );
  const heads = f.commentHeads();
  const applied = await run({ mode: "apply" });
  assert.equal(applied.body.pages[0].status, "partial");
  assert.deepEqual(applied.body.pages[0].report.refused_reasons, { lossy: 1 });
  assert.deepEqual(f.commentHeads(), heads, "nothing written");
});

test("end to end: a crash mid-apply replays the recorded change once, and its revert record stays", async (t) => {
  const { f, run } = await legacyFixture(t);
  let flushes = 0;
  // Flush 1 precedes the journal reserve; flush 2 follows the replay. Cut 2:
  // the intent is durable, the document bytes are not.
  f.hooks.flush = () => {
    if (++flushes === 2) throw Object.assign(Error("process killed"), { cut: true });
  };
  t.mock.method(console, "error", () => {});
  const first = await run({ mode: "apply" });
  assert.equal(first.body.pages[0].status, "error");
  f.hooks.flush = undefined;
  await f.crashRestart();
  assert.ok(migrated(f), "recovery replayed the recorded change");
  const heads = f.commentHeads();
  const second = await run({ mode: "apply" });
  assert.equal(second.body.pages[0].status, "unchanged");
  assert.deepEqual(f.commentHeads(), heads);
  const catalog = f.catalogOf(f.owner).storage;
  const stored = await catalog.get(`${COMMENTS_MIGRATION_RESULT_PREFIX}${pageId}`);
  assert.equal(stored.revert.length, 1);
  assert.deepEqual(stored.revert[0].after_heads, heads);
  assert.deepEqual(stored.revert[0].messages.map((message) => message.action).sort(), [
    "normalize",
    "plain",
  ]);
  // A later host migration's reservation drops finished internal receipts;
  // the Page's own copy of the record survives it.
  await reserveOperation(f.storage, {
    key: `${INTERNAL_PREFIX}later_migration_0001`,
    entry: { fingerprint: "x", pending: true, changes: [], receipt: {} },
  });
  assert.equal((await f.storage.list({ prefix: `${INTERNAL_PREFIX}comments_norm_` })).size, 0);
  const dry = await run({ mode: "dry_run" });
  assert.equal(dry.body.pages[0].revert.length, 1);
});
