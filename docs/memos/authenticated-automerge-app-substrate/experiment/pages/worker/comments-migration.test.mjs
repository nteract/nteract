import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { documentFeatures } from "../model/schema-features.mjs";
import { adapter, schema, textPath } from "../model/richtext.mjs";
import { hasPreservedBlocks } from "../model/raw-migration.mjs";
import { pmNodeToSpans } from "@automerge/prosemirror";
import { projectComments } from "../model/comments.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { legacyComment } from "../model/comments-test-support.mjs";
import { copyLegacyThreads, detachLegacyComments } from "../model/comments-migration.mjs";
import { fixture, pageId } from "./trash-fixture.mjs";

// Moving a Page's comments out of its document: model/comments-migration.mjs
// and the host run in worker/index.mjs (migrateCommentsOnce).

const ALICE = { principal: "account:alice", displayName: "Alice", driver: "Browser" };
const BOB = { principal: "account:bob", displayName: "Bob", driver: "Codex" };

/** A Page as builds before the comments document stored it: unstamped, with
 * a block comment, a passage comment with a rich reply and a resolved status,
 * and a soft-deleted message. */
function legacyPage() {
  let page = A.change(A.from(createPageData({ pageId, title: "Launch plan" })), (draft) => {
    initializePage(draft, "We ship on Friday. Then we rest.");
    delete draft.schema;
  });
  const id = orderedBlockIds(page)[0];
  let block, passage, deleted;
  ({ page, result: block } = legacyComment(page, { block_id: id, body: "Whole block" }, ALICE));
  ({ page, result: passage } = legacyComment(
    page,
    { block_id: id, selected_text: "Friday", body: "Which Friday?" },
    BOB,
  ));
  ({ page } = legacyComment(
    page,
    {
      action: "reply",
      thread_id: passage.thread_id,
      body: "**This** one, with `code`",
      body_format: "markdown",
    },
    ALICE,
  ));
  ({ page } = legacyComment(page, { action: "resolve", thread_id: passage.thread_id }, ALICE));
  ({ page, result: deleted } = legacyComment(
    page,
    { action: "reply", thread_id: block.thread_id, body: "Oops" },
    BOB,
  ));
  ({ page } = legacyComment(
    page,
    { action: "delete_message", thread_id: block.thread_id, message_id: deleted.message_id },
    BOB,
  ));
  return { page, id, threads: { block: block.thread_id, passage: passage.thread_id } };
}

/** The projected threads, without volatile resolution offsets. */
const view = (page, comments) =>
  projectComments(page, comments)
    .map(({ selectionContext, ...thread }) => ({ ...thread, attached: selectionContext?.status }))
    .sort((a, b) => a.id.localeCompare(b.id));

const UUID = "c0000000-0000-4000-8000-000000000002";

test("the copy moves every thread unchanged and the detach stamps the Page", () => {
  const { page } = legacyPage();
  const before = view(page);
  assert.equal(before.length, 2);
  let comments = A.clone(commentsGenesis(UUID));
  let result;
  comments = A.change(comments, (draft) => {
    result = copyLegacyThreads(draft, page);
  });
  assert.deepEqual(result, { copied: 2, existing: 0, skipped: 0 });
  const detached = A.change(page, (draft) => detachLegacyComments(draft));
  assert.equal(detached.comments, undefined);
  assert.ok(documentFeatures(detached).includes("comments-doc"));
  // Same threads, same anchors, same rich bodies; read from the new home.
  assert.deepEqual(view(detached, comments), before);
  // Page text is untouched.
  const id = orderedBlockIds(page)[0];
  assert.equal(detached.blocks[id].richText, page.blocks[id].richText);
});

test("the copy is idempotent: a rerun copies nothing twice", () => {
  const { page } = legacyPage();
  let comments = A.clone(commentsGenesis(UUID));
  comments = A.change(comments, (draft) => copyLegacyThreads(draft, page));
  const heads = A.getHeads(comments);
  let again;
  const next = A.change(comments, (draft) => {
    again = copyLegacyThreads(draft, page);
  });
  assert.deepEqual(again, { copied: 0, existing: 2, skipped: 0 });
  assert.deepEqual(A.getHeads(next), heads, "a no-op copy writes no change");
});

test("two hosts copying at once converge on the same threads", () => {
  const { page } = legacyPage();
  const genesis = commentsGenesis(UUID);
  const left = A.change(A.clone(genesis), (draft) => copyLegacyThreads(draft, page));
  const right = A.change(A.clone(genesis), (draft) => copyLegacyThreads(draft, page));
  const merged = A.merge(A.clone(left), right);
  assert.deepEqual(view(page, merged), view(page, left));
  assert.equal(Object.keys(merged.threads).length, 2);
});

test("drop mode moves nothing and still detaches", () => {
  const { page } = legacyPage();
  let result;
  A.change(A.clone(commentsGenesis(UUID)), (draft) => {
    result = copyLegacyThreads(draft, page, { mode: "drop" });
  });
  assert.deepEqual(result, { copied: 0, existing: 0, skipped: 2 });
});

test("a thread that can't be copied is skipped whole; the rest move", () => {
  let { page, threads } = legacyPage();
  page = A.change(page, (draft) => {
    draft.comments[threads.block].target = { kind: "nowhere" };
    draft.comments["not a valid id"] = { messages: {} };
  });
  let result;
  const comments = A.change(A.clone(commentsGenesis(UUID)), (draft) => {
    result = copyLegacyThreads(draft, page);
  });
  assert.deepEqual(result, { copied: 1, existing: 0, skipped: 2 });
  assert.deepEqual(Object.keys(comments.threads), [threads.passage]);
});

/** A host fixture over a legacy Page. */
async function legacyFixture(t) {
  const plain = await fixture(t);
  const { page, threads } = legacyPage();
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(page) });
  const before = view(page);
  A.free(page);
  return { f, threads, before };
}
const migrationEntries = async (f) => [
  ...(await f.storage.list({ prefix: "host/operation/internal:comments_" })),
];

test("the host moves a legacy Page's comments once, on load, without touching its text", async (t) => {
  const { f, before } = await legacyFixture(t);
  const id = orderedBlockIds(f.doc())[0];
  const text = f.doc().blocks[id].richText;
  // Two triggers at once, as a load and a connection could race.
  await Promise.all([f.page.convertPreservedMarkdown(), f.page.convertPreservedMarkdown()]);
  assert.equal(f.page.conversion.name, "clear");
  assert.equal(f.doc().comments, undefined);
  assert.ok(documentFeatures(f.doc()).includes("comments-doc"));
  assert.equal(f.doc().blocks[id].richText, text);
  assert.deepEqual(view(f.doc(), f.commentsDoc()), before);
  // Each step was one journaled host intent. A finished internal receipt is
  // dropped when the next one reserves, so the detach's is what remains.
  const entries = await migrationEntries(f);
  assert.deepEqual(
    entries.map(([key, entry]) => [key.split("_")[1], entry.pending]),
    [["detach", false]],
  );
  // Reads list the moved threads from the comments document.
  const read = await f.tool("owner", "list_page_comments", { state: "all" });
  assert.equal(read.status, 200);
  assert.equal(read.body.comments.length, 2);
  assert.deepEqual(read.body.comment_heads, f.commentHeads());
  // Idempotent: later loads write nothing in either document.
  const heads = f.heads(),
    commentHeads = f.commentHeads();
  await f.page.convertPreservedMarkdown();
  await (await f.restart()).convertPreservedMarkdown();
  assert.deepEqual(f.heads(), heads);
  assert.deepEqual(f.commentHeads(), commentHeads);
});

test("legacy threads read from the Page until the move; a write moves them first", async (t) => {
  const { f, before } = await legacyFixture(t);
  // Not migrated yet: reads come from the Page's own map.
  assert.equal(f.page.commentsView(), undefined);
  const read = await f.tool("owner", "list_page_comments", { state: "all" });
  assert.equal(read.body.comments.length, before.length);
  assert.equal(read.body.comment_heads, undefined);
  // A comment write waits for the move, then lands beside the moved threads.
  const write = await f.tool("owner", "manage_page_comment", {
    action: "add",
    block_id: orderedBlockIds(f.doc())[0],
    body: "After the move",
    idempotency_key: "early-comment-0001",
  });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  assert.equal(f.doc().comments, undefined);
  assert.equal(Object.keys(f.commentsDoc().threads).length, before.length + 1);
});

test("peers can't write either document while the move runs", async (t) => {
  const { f } = await legacyFixture(t);
  await f.bind("cd".repeat(32), f.owner);
  let fenced;
  // Cut the migration's first flush: the fence holds while it retries.
  f.hooks.flush = () => {
    throw Object.assign(Error("storage unavailable"), { cut: true });
  };
  t.mock.method(console, "error", () => {});
  await f.page.convertPreservedMarkdown();
  try {
    await f.page.policy.put("cd".repeat(32), "cd".repeat(32), f.page.metadata.tree);
  } catch (error) {
    fenced = error;
  }
  assert.equal(fenced?.code, "preserved_markdown_converting");
  f.hooks.flush = undefined;
});

// Cut each step after its durable intent and before its document flush, then
// rebuild the host from storage alone. Journal recovery finishes the step, and
// the load's migration finishes the rest exactly once.
for (const cut of [2, 4]) {
  test(`a restart mid-migration (flush ${cut}) finishes it exactly once`, async (t) => {
    const { f, before } = await legacyFixture(t);
    let flushes = 0;
    f.hooks.flush = () => {
      if (++flushes === cut) throw Object.assign(Error("process killed"), { cut: true });
    };
    t.mock.method(console, "error", () => {});
    await f.page.convertPreservedMarkdown();
    const pending = (await migrationEntries(f)).filter(([, entry]) => entry.pending);
    assert.equal(pending.length, 1, "one step's intent is durable and unfinished");
    f.hooks.flush = undefined;

    await f.crashRestart();
    // The load replays the journal; the conversion machine finishes the move.
    await f.page.convertPreservedMarkdown();
    assert.equal(f.doc().comments, undefined);
    assert.ok(documentFeatures(f.doc()).includes("comments-doc"));
    assert.deepEqual(view(f.doc(), f.commentsDoc()), before);
    const entries = await migrationEntries(f);
    assert.ok(entries.every(([, entry]) => entry.pending === false));
    // Copied once: one thread per legacy thread, no duplicate messages.
    assert.equal(Object.keys(f.commentsDoc().threads).length, before.length);
    const heads = f.heads(),
      commentHeads = f.commentHeads();
    await f.crashRestart();
    await f.page.convertPreservedMarkdown();
    assert.deepEqual(f.heads(), heads);
    assert.deepEqual(f.commentHeads(), commentHeads);
  });
}

test("an old tab can't write comments into the Page after the move", async (t) => {
  const { f } = await legacyFixture(t);
  await f.page.convertPreservedMarkdown();
  // A build from before the comments document declares no comments-doc.
  const old = "ab".repeat(32);
  await f.bind(old, f.owner, ["horizontal-rule", "preserved-markdown-converted", "strike"]);
  await assert.rejects(f.page.policy.put(old, old, f.page.metadata.tree), {
    code: "schema_unsupported",
  });
  // Nor into the comments document, which it doesn't know about.
  await assert.rejects(f.page.policy.put(old, old, "c".repeat(32)), {
    code: "schema_unsupported",
  });
  // A current build writes both.
  const current = "ef".repeat(32);
  await f.bind(current, f.owner);
  await f.page.policy.put(current, current, f.page.metadata.tree);
  await f.page.policy.put(current, current, "c".repeat(32));
});

test("a Page with preserved blocks and legacy comments gets both migrations, in order", async (t) => {
  let { page, threads } = legacyPage();
  const id = orderedBlockIds(page)[0];
  const tree = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("We ship on Friday. Then we rest.")]),
    schema.node("raw", { source: "Old ~~text~~.", importId: "", kind: "markdown" }),
  ]);
  page = A.change(page, (draft) =>
    A.updateSpans(draft, textPath(id), pmNodeToSpans(adapter, tree), adapter.updateSpansConfig()),
  );
  const plain = await fixture(t);
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(page) });
  A.free(page);
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
  assert.equal(hasPreservedBlocks(f.doc()), false);
  assert.equal(f.doc().comments, undefined);
  const features = documentFeatures(f.doc());
  assert.ok(features.includes("preserved-markdown-converted"));
  assert.ok(features.includes("comments-doc"));
  assert.deepEqual(Object.keys(f.commentsDoc().threads).sort(), Object.values(threads).sort());
});
