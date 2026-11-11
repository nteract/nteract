import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { cardKey, pageCard } from "../model/page-card.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { PAGE_CARD_KEY } from "./page-card-writer.mjs";
import { CONTENT_ACTIVITY_KEY } from "./content-activity.mjs";
import { fixture, pageId, trashArgs } from "./trash-fixture.mjs";
import { cardBucket } from "./card-bucket-fixture.mjs";

// The Page host's side of cards: the write beside each content-activity
// flush, the skip when the card didn't change, a card write that fails
// without failing the edit, the host's own bucket adapter under the
// ordering fence, and card writes racing a purge
// (worker/page-card-writer.mjs).

/** Emit `change` with patches from the fixture's handle, as the repo does. */
function emitting(page) {
  const inner = page.handle;
  const listeners = new Set();
  page.handle = {
    doc: () => inner.doc(),
    broadcast: (...args) => inner.broadcast(...args),
    async update(fn) {
      const before = A.getHeads(inner.doc());
      await inner.update(fn);
      const after = inner.doc();
      const patches = A.diff(after, before, A.getHeads(after));
      if (patches.length) for (const listener of Array.from(listeners)) listener({ patches });
    },
    on: (type, listener) => type === "change" && listeners.add(listener),
    off: (type, listener) => type === "change" && listeners.delete(listener),
  };
  return page;
}

const settle = async (f) => {
  while (f.tasks.length) await Promise.allSettled(f.tasks.splice(0));
};
const stored = (assets) => assets.card(cardKey(pageId));
const longBody = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} ${"words ".repeat(30)}`);

test("a booted host writes no card until its content changes", async (t) => {
  const assets = cardBucket();
  const f = await fixture(t, { env: { PAGES_ASSETS: assets } });
  await emitting(f.page).watchContent();
  assert.deepEqual(f.page.pageCard.state, { name: "idle", stored: null });
  const read = await f.tool("owner", "read_page", {});
  assert.equal(read.status, 200, JSON.stringify(read.body));
  await settle(f);
  assert.equal(assets.puts, 0, "reads and boots write nothing");
});

test("a flush writes the card when its first screen changed", async (t) => {
  const assets = cardBucket();
  const f = await fixture(t, { env: { PAGES_ASSETS: assets } });
  await emitting(f.page).watchContent();
  const top = await f.tool("owner", "edit_page", {
    operations: [
      { op: "insert_markdown", markdown: "## Launch\n\nThe plan, in brief.", after_block_id: null },
    ],
    revision: await f.revision(),
    nonce: "card-top",
  });
  assert.equal(top.status, 200, JSON.stringify(top.body));
  await settle(f);
  assert.equal(assets.puts, 1);
  const card = stored(assets);
  assert.equal(card.title, "Launch plan");
  assert.deepEqual(card.blocks[0].content[0], ["h2", {}, "Launch"]);
  assert.equal(card.content_updated_at, f.page.contentActivity.value);
  assert.deepEqual(await f.storage.get(PAGE_CARD_KEY), { card_hash: card.card_hash });
  // The object carries what the writer's ordering check reads back.
  assert.deepEqual(assets.objects.get(cardKey(pageId)).customMetadata, {
    card_hash: card.card_hash,
    content_updated_at: card.content_updated_at,
  });
});

test("a flush after an edit below the fold puts nothing", async (t) => {
  const doc = A.change(A.from(createPageData({ pageId, title: "Launch plan" })), (draft) =>
    initializePage(draft, longBody.join("\n\n")),
  );
  const assets = cardBucket();
  const plain = await fixture(t);
  const f = await fixture(t, {
    auth: plain.auth,
    docBytes: A.save(doc),
    env: { PAGES_ASSETS: assets },
  });
  const before = await pageCard(doc);
  A.free(doc);
  assert.equal(before.truncated, true);
  await f.storage.put(PAGE_CARD_KEY, { card_hash: before.card_hash });
  await assets.seed(cardKey(pageId), before);
  assets.puts = 0;
  await emitting(f.page).watchContent();
  const below = await f.tool("owner", "edit_page", {
    operations: [{ op: "insert_markdown", markdown: "A footnote." }],
    revision: await f.revision(),
    nonce: "card-below",
  });
  assert.equal(below.status, 200, JSON.stringify(below.body));
  await settle(f);
  assert.ok(f.page.contentActivity.value, "the edit flushed");
  assert.equal(assets.puts, 0, "an edit below the fold writes no card");
  assert.deepEqual(f.page.pageCard.state, { name: "idle", stored: before.card_hash });
});

test("a failed card write never fails the edit or the flush, and the next flush retries", async (t) => {
  const assets = cardBucket();
  const f = await fixture(t, { env: { PAGES_ASSETS: assets } });
  await f.storage.put(PAGE_CARD_KEY, { card_hash: "a".repeat(64) });
  await emitting(f.page).watchContent();
  assets.fail = true;
  const edit = await f.tool("owner", "edit_page", {
    operations: [{ op: "insert_markdown", markdown: "# New opening", after_block_id: null }],
    revision: await f.revision(),
    nonce: "card-fails",
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await settle(f);
  assert.equal(assets.puts, 1);
  assert.equal(assets.objects.size, 0);
  // The flush itself landed: the owner's Catalog has the content time.
  const entry = await f.catalogOf(f.owner).storage.get(`page/${pageId}`);
  assert.equal(entry.content_updated_at, f.page.contentActivity.value);
  assert.equal(f.page.contentActivity.state.name, "idle");
  assert.deepEqual(await f.storage.get(PAGE_CARD_KEY), { card_hash: "a".repeat(64) });

  assets.fail = false;
  await f.page.contentActivity.report(new Date().toISOString());
  await settle(f);
  assert.deepEqual(stored(assets).blocks[0].content[0], ["h1", {}, "New opening"]);
});

test("the host's card puts are conditional on the etag it saw, and retry once when refused", async (t) => {
  const assets = cardBucket();
  const f = await fixture(t, { env: { PAGES_ASSETS: assets } });
  await emitting(f.page).watchContent();
  const first = await f.tool("owner", "edit_page", {
    operations: [{ op: "insert_markdown", markdown: "# First", after_block_id: null }],
    revision: await f.revision(),
    nonce: "fence-first",
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await settle(f);
  assert.equal(assets.puts, 1);
  // Another writer replaces the object after this host's write.
  await assets.seed(cardKey(pageId), { v: 1, card_hash: "3".repeat(64), blocks: [] });
  assets.puts = 0;
  // This edit's own flush waits out the minute; the report below stands in.
  f.page.unwatchContent();
  const second = await f.tool("owner", "edit_page", {
    operations: [{ op: "insert_markdown", markdown: "# Second", after_block_id: null }],
    revision: await f.revision(),
    nonce: "fence-second",
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  await f.page.contentActivity.report(new Date().toISOString());
  await settle(f);
  assert.equal(assets.refused, 1, "the put on the old etag is refused");
  assert.equal(assets.puts, 2, "then read again and put once more");
  assert.deepEqual(stored(assets).blocks[0].content[0], ["h1", {}, "Second"]);
  assert.deepEqual(await f.storage.get(PAGE_CARD_KEY), { card_hash: stored(assets).card_hash });
});

test("a refused put that finds a later content time in the object puts nothing more", async (t) => {
  const assets = cardBucket();
  const f = await fixture(t, { env: { PAGES_ASSETS: assets } });
  await emitting(f.page).watchContent();
  const first = await f.tool("owner", "edit_page", {
    operations: [{ op: "insert_markdown", markdown: "# First", after_block_id: null }],
    revision: await f.revision(),
    nonce: "later-first",
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await settle(f);
  // A newer host, still live beside this one, wrote a later card.
  const later = {
    v: 1,
    card_hash: "3".repeat(64),
    blocks: [],
    // Two minutes ahead: within the clock-skew limit, so a newer card.
    content_updated_at: new Date(Date.now() + 2 * 60_000).toISOString(),
  };
  await assets.put(cardKey(pageId), JSON.stringify(later), {
    customMetadata: { card_hash: later.card_hash, content_updated_at: later.content_updated_at },
  });
  assets.puts = 0;
  f.page.unwatchContent();
  const second = await f.tool("owner", "edit_page", {
    operations: [{ op: "insert_markdown", markdown: "# Second", after_block_id: null }],
    revision: await f.revision(),
    nonce: "later-second",
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  await f.page.contentActivity.report(new Date().toISOString());
  await settle(f);
  assert.equal(assets.refused, 1);
  assert.equal(assets.puts, 1, "no retry over the later card");
  assert.deepEqual(stored(assets), later);
});

test("a card left by a node 10 minutes ahead doesn't block this host's writes", async (t) => {
  const assets = cardBucket();
  const f = await fixture(t, { env: { PAGES_ASSETS: assets } });
  // The previous host ran on a node 10 minutes fast. Content activity drops
  // its stored time, past the skew limit, so this host's times are earlier.
  const ahead = new Date(Date.now() + 10 * 60_000).toISOString();
  await f.storage.put(CONTENT_ACTIVITY_KEY, { content_updated_at: ahead });
  const old = { v: 1, card_hash: "3".repeat(64), blocks: [], content_updated_at: ahead };
  await assets.put(cardKey(pageId), JSON.stringify(old), {
    customMetadata: { card_hash: old.card_hash, content_updated_at: ahead },
  });
  assets.puts = 0;
  await emitting(f.page).watchContent();
  const edit = await f.tool("owner", "edit_page", {
    operations: [{ op: "insert_markdown", markdown: "# Fresh opening", after_block_id: null }],
    revision: await f.revision(),
    nonce: "skew-fresh",
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await settle(f);
  assert.ok(f.page.contentActivity.value < ahead, "this host's time is earlier");
  assert.equal(assets.puts, 1);
  assert.deepEqual(stored(assets).blocks[0].content[0], ["h1", {}, "Fresh opening"]);
  assert.equal(stored(assets).content_updated_at, f.page.contentActivity.value);
});

test("a host's first put requires no object, so one that appears first is not overwritten blind", async (t) => {
  const assets = cardBucket();
  const f = await fixture(t, { env: { PAGES_ASSETS: assets } });
  await emitting(f.page).watchContent();
  // Another writer's object lands between this host's head() and its put.
  let raced = false;
  assets.beforePut = async (key) => {
    if (raced) return;
    raced = true;
    await assets.seed(key, { v: 1, card_hash: "3".repeat(64), blocks: [] });
  };
  const edit = await f.tool("owner", "edit_page", {
    operations: [{ op: "insert_markdown", markdown: "# Mine", after_block_id: null }],
    revision: await f.revision(),
    nonce: "fence-none",
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await settle(f);
  assert.equal(assets.refused, 1, "the put that required no object is refused");
  assert.deepEqual(stored(assets).blocks[0].content[0], ["h1", {}, "Mine"], "then retried");
});

test("a host without a Page assets bucket has no card writer", async (t) => {
  const f = await fixture(t);
  await emitting(f.page).watchContent();
  assert.equal(f.page.pageCard, null);
  const edit = await f.tool("owner", "edit_page", {
    operations: [{ op: "insert_markdown", markdown: "More." }],
    revision: await f.revision(),
    nonce: "no-bucket",
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
});

for (const mode of ["lands", "lands, then times out"])
  test(`a card put that ${mode} while the Page is purged leaves no object`, async (t) => {
    const assets = cardBucket();
    const f = await fixture(t, { env: { PAGES_ASSETS: assets } });
    await emitting(f.page).watchContent();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let entered;
    const putting = new Promise((resolve) => (entered = resolve));
    const put = assets.put.bind(assets);
    assets.put = async (...args) => {
      entered();
      await gate;
      const landed = await put(...args);
      if (mode !== "lands") throw Error("Page card write timed out");
      return landed;
    };
    const top = await f.tool("owner", "edit_page", {
      operations: [{ op: "insert_markdown", markdown: "# Racing", after_block_id: null }],
      revision: await f.revision(),
      nonce: "race-top",
    });
    assert.equal(top.status, 200, JSON.stringify(top.body));
    await putting;
    assert.equal((await f.catalogCall("owner", "delete_page", trashArgs(f))).status, 200);
    const preview = await f.catalogCall("owner", "purge_page", {
      page_id: pageId,
      action: "preview",
    });
    const purged = await f.catalogCall("owner", "purge_page", {
      page_id: pageId,
      action: "confirm",
      preview_token: preview.body.preview_token,
      nonce: "purge-request-1",
    });
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    release();
    await settle(f);
    assert.equal(assets.objects.has(cardKey(pageId)), false, "no orphan card");
    assert.equal(await f.storage.get(PAGE_CARD_KEY), undefined);
    assert.equal(f.page.pageCard.state.name, "stopped");
  });
