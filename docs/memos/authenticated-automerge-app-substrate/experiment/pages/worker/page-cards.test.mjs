import assert from "node:assert/strict";
import { test } from "node:test";
import { proposeAccessUpdate } from "./access.mjs";
import { cardKey, pageCard } from "../model/page-card.mjs";
import { PAGE_CARD_KEY } from "./page-card-writer.mjs";
import {
  PAGE_CARDS_MAX,
  allowedPageCards,
  pageCardReadBounds,
  parsePageCardIds,
  readPageCards,
} from "./page-cards.mjs";
import { cardBucket } from "./card-bucket-fixture.mjs";
import { boundedMap } from "./bounded-map.mjs";
import { tools } from "../mcp.mjs";
import { world } from "./projects-fixture.mjs";

async function cardsWorld(t) {
  const w = await world(t);
  const assets = cardBucket();
  w.env.PAGES_ASSETS = assets;
  const settle = async () => {
    while (w.jobs.length) await Promise.allSettled(w.jobs.splice(0));
  };
  /** A Page with the card its host would write on its first flush
   * (page-card-host.test.mjs covers the host's side). */
  const create = async (title, markdown) => {
    const created = await w.createPage({ title, markdown });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await settle();
    const pageId = created.body.page_id;
    const card = await pageCard(w.page(pageId).handle.doc());
    await assets.seed(cardKey(pageId), card);
    await w.page(pageId).ctx.storage.put(PAGE_CARD_KEY, { card_hash: card.card_hash });
    return pageId;
  };
  const cards = async (who, pageIds) => w.call(who, "page_cards", { page_ids: pageIds });
  return { w, assets, settle, create, cards };
}

/** Set `principal`'s direct role on an owned Page, as a sharing change does. */
async function setRole(w, pageId, principal, role) {
  const host = w.page(pageId);
  const ownerIdentity = { principal: w.owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  const acl = proposeAccessUpdate(host.metadata, ownerIdentity, {
    principal,
    role,
    expected_revision: host.metadata.acl?.revision ?? 0,
  }).acl;
  host.metadata = { ...host.metadata, acl };
  await host.ctx.storage.put("host/document", host.metadata);
}

const discover = (w, principal, pageId) =>
  w.catalogStorage(principal).put(`shared/${pageId}`, {
    page_id: pageId,
    title: "Shared",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    shared: true,
  });

test("an owner reads its Page's card as stored", async (t) => {
  const { w, assets, create, cards } = await cardsWorld(t);
  const pageId = await create("Plan", "# Goals\n\n- Ship cards\n- [ ] Test them");
  const stored = assets.card(cardKey(pageId));
  assert.equal(stored.v, 1);
  assert.deepEqual(await w.page(pageId).ctx.storage.get(PAGE_CARD_KEY), {
    card_hash: stored.card_hash,
  });
  const answer = await cards("owner", [pageId]);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.principal, w.owner);
  assert.deepEqual(answer.body.cards[pageId], stored);
  assert.deepEqual(answer.body.cards[pageId].blocks[0].content[0], ["h1", {}, "Goals"]);
  // No object URL or key leaves the Worker.
  assert.equal(JSON.stringify(answer.body).includes("card.json"), false);
});

test("a shared Page's card shows for its member and is gone on the call after revocation", async (t) => {
  const { w, create, cards } = await cardsWorld(t);
  const pageId = await create("Shared plan", "Hello, member.");
  // Before a grant, even a discovered entry gets nothing.
  await discover(w, w.member, pageId);
  assert.deepEqual((await cards("member", [pageId])).body.cards, { [pageId]: null });
  await setRole(w, pageId, w.member, "viewer");
  const granted = await cards("member", [pageId]);
  assert.equal(granted.body.principal, w.member);
  assert.equal(granted.body.cards[pageId].title, "Shared plan");
  await setRole(w, pageId, w.member, null);
  assert.deepEqual((await cards("member", [pageId])).body.cards, { [pageId]: null });
  // A card fetch is a read: the next listing prunes the entry, not this.
  assert.ok(await w.catalogStorage(w.member).get(`shared/${pageId}`));
});

test("trashed, unknown, malformed and other accounts' Pages all answer null", async (t) => {
  const { w, assets, create, cards } = await cardsWorld(t);
  const kept = await create("Kept", "Kept body");
  const trashed = await create("Trashed", "Trashed body");
  const deleted = await w.call("owner", "delete_page", {
    page_id: trashed,
    base_heads: w.heads(trashed),
    idempotency_key: w.key(),
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.ok(assets.objects.has(cardKey(trashed)), "Trash keeps the card object");
  const unknown = "44444444-4444-4444-8444-444444444444";
  await assets.seed(cardKey(unknown), { v: 1, card_hash: "x", blocks: [] });
  const answer = await cards("owner", [kept, trashed, unknown, "not-a-page", kept]);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(Object.keys(answer.body.cards), [kept, trashed, unknown, "not-a-page"]);
  assert.ok(answer.body.cards[kept]);
  assert.equal(answer.body.cards[trashed], null);
  assert.equal(answer.body.cards[unknown], null);
  assert.equal(answer.body.cards["not-a-page"], null);
  // Someone else's Page, card and all, is null for a stranger.
  assert.deepEqual((await cards("stranger", [kept])).body.cards, { [kept]: null });
  // Refused IDs never reach the bucket.
  assert.deepEqual(
    assets.reads.filter((key) => !key.includes(kept)),
    [],
  );
});

test("D1 never grants a card: an index row for the caller opens nothing", async (t) => {
  const { w, create, cards } = await cardsWorld(t);
  const pageId = await create("Private", "Not for strangers");
  // Make sure the index tables exist, then forge an access row.
  assert.equal((await w.call("owner", "list_pages")).status, 200);
  const stranger = "user:anaconda-fixture:stranger-user";
  await w.db
    .prepare(
      `INSERT INTO pages_catalog_access (page_id, principal, role, source, updated_at, title)
       VALUES (?, ?, 'viewer', 'member', ?, 'Private')`,
    )
    .bind(pageId, stranger, new Date().toISOString())
    .run();
  assert.deepEqual((await cards("stranger", [pageId])).body.cards, { [pageId]: null });
  // Not even with a forged discovery entry: the Page host refuses the check.
  await discover(w, stranger, pageId);
  assert.deepEqual((await cards("stranger", [pageId])).body.cards, { [pageId]: null });
});

test("more than 24 IDs, or anything but an array of strings, is refused", async (t) => {
  const { cards } = await cardsWorld(t);
  const many = Array.from(
    { length: PAGE_CARDS_MAX + 1 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  const over = await cards("owner", many);
  assert.equal(over.status, 400);
  assert.equal(over.body.code, "invalid_arguments");
  assert.equal((await cards("owner", many.slice(0, PAGE_CARDS_MAX))).status, 200);
  for (const pageIds of [undefined, "x", [1]]) {
    const refused = await cards("owner", pageIds);
    assert.equal(refused.status, 400, JSON.stringify(pageIds));
    assert.equal(refused.body.code, "invalid_arguments");
  }
  // Duplicates count once.
  assert.deepEqual(parsePageCardIds([...many.slice(0, 24), many[0]]).length, 24);
});

test("page_cards is an /api/tools operation only: no MCP tool describes it", async (t) => {
  assert.equal(
    tools.some((tool) => tool.name === "page_cards"),
    false,
  );
  const { w, create } = await cardsWorld(t);
  const pageId = await create("Plan", "Body");
  const viaMcp = await w.mcp("owner", "page_cards", { page_ids: [pageId] });
  assert.equal(viaMcp.isError, true);
  assert.equal(viaMcp.body.code, "unknown_tool");
});

test("a read-only API key can read cards", async (t) => {
  const { create, cards } = await cardsWorld(t);
  const pageId = await create("Plan", "Body");
  const answer = await cards("reader", [pageId]);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

test("a purge deletes the card object and the host's stored hash", async (t) => {
  const { w, assets, create } = await cardsWorld(t);
  const pageId = await create("Doomed", "Gone soon");
  assert.ok(assets.objects.has(cardKey(pageId)));
  const trashed = await w.call("owner", "delete_page", {
    page_id: pageId,
    base_heads: w.heads(pageId),
    idempotency_key: w.key(),
  });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  const preview = await w.call("owner", "purge_page", { page_id: pageId, action: "preview" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const purged = await w.call("owner", "purge_page", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.body.preview_token,
    idempotency_key: w.key(),
  });
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  assert.equal(assets.objects.has(cardKey(pageId)), false);
  assert.equal(await w.page(pageId).ctx.storage.get(PAGE_CARD_KEY), undefined);
});

test("allowedPageCards admits settled owned and active shared Pages only", async () => {
  const ids = [1, 2, 3, 4, 5, 6, 7].map((n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`);
  const storage = new Map([
    [`page/${ids[0]}`, { page_id: ids[0] }],
    [`page/${ids[1]}`, { page_id: ids[1], pending: true }],
    [`shared/${ids[2]}`, { page_id: ids[2] }],
    [`shared/${ids[3]}`, { page_id: ids[3] }],
    [`shared/${ids[4]}`, { page_id: ids[4] }],
    [`shared/${ids[5]}`, { page_id: ids[5] }],
  ]);
  const checks = {
    [ids[2]]: { status: "ok", page: { state: "active" } },
    [ids[3]]: { status: "denied" },
    [ids[4]]: { status: "unavailable" },
    // The member still holds a grant, but the owner trashed the Page.
    [ids[5]]: { status: "ok", page: { state: "trashed" } },
  };
  const allowed = await allowedPageCards(ids, {
    storage: { get: async (key) => storage.get(key) },
    verifyShared: async (id) => checks[id],
    map: boundedMap,
    checks: 4,
  });
  assert.deepEqual(allowed, [ids[0], ids[2]]);
});

test("readPageCards reads only allowed IDs, at once, and a bad object or a late one is null", async () => {
  const ids = [1, 2, 3, 4].map((n) => `bbbbbbbb-0000-4000-8000-00000000000${n}`);
  const read = [];
  const errors = [];
  let release;
  const late = new Promise((resolve) => (release = resolve));
  let running = 0;
  let most = 0;
  const started = Date.now();
  const cards = await readPageCards(ids, [ids[0], ids[1], ids[2], "not-requested"], {
    deadlineMs: 50,
    readObject: async (key, signal) => {
      read.push(key);
      most = Math.max(most, ++running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (key.includes(ids[1])) return "{not json";
        if (key.includes(ids[2])) {
          await late;
          assert.equal(signal.aborted, true, "the deadline aborts the read");
        }
        return JSON.stringify({ v: 1, card_hash: "h", blocks: [] });
      } finally {
        running--;
      }
    },
    onError: (error) => errors.push(error),
  });
  release();
  assert.ok(Date.now() - started < 1000, "one deadline for every read");
  assert.deepEqual(
    read,
    [ids[0], ids[1], ids[2]].map((id) => `pages/${id}/card.json`),
  );
  assert.equal(most, 3, "every read starts at once");
  assert.equal(cards[ids[0]].card_hash, "h");
  assert.deepEqual([cards[ids[1]], cards[ids[2]], cards[ids[3]]], [null, null, null]);
  assert.equal(errors.length, 1, "only the bad object is an error");
  assert.ok(pageCardReadBounds.deadlineMs <= 1500);
});

test("slow card reads never hold the account's Catalog queue", async (t) => {
  const { w, assets, create, cards } = await cardsWorld(t);
  const pageId = await create("Plan", "Body");
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  assets.beforeGet = () => slow;
  const deadline = pageCardReadBounds.deadlineMs;
  pageCardReadBounds.deadlineMs = 10_000;
  t.after(() => {
    pageCardReadBounds.deadlineMs = deadline;
    release();
  });
  const pending = cards("owner", [pageId]);
  // Wait until the gateway is reading the object, past the Catalog.
  while (!assets.reads.length) await new Promise((resolve) => setTimeout(resolve, 1));
  let timer;
  const listed = await Promise.race([
    w.call("owner", "list_pages"),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("list_pages waited behind the card read")), 2000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(listed.body.pages.some((page) => page.page_id === pageId));
  release();
  const answer = await pending;
  assert.equal(answer.body.cards[pageId].title, "Plan");
});

test("a card read past the deadline answers null, and the call still returns", async (t) => {
  const { assets, create, cards } = await cardsWorld(t);
  const fast = await create("Fast", "Body");
  const slow = await create("Slow", "Body");
  let release;
  const held = new Promise((resolve) => (release = resolve));
  assets.beforeGet = (key) => (key.includes(slow) ? held : undefined);
  const deadline = pageCardReadBounds.deadlineMs;
  pageCardReadBounds.deadlineMs = 40;
  t.after(() => {
    pageCardReadBounds.deadlineMs = deadline;
    release();
  });
  const answer = await cards("owner", [fast, slow]);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.cards[fast].title, "Fast");
  assert.equal(answer.body.cards[slow], null);
});
