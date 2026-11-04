import assert from "node:assert/strict";
import { test } from "node:test";
import { proposeAccessUpdate } from "./access.mjs";
import { cardKey, pageCard } from "../model/page-card.mjs";
import { PAGE_CARD_KEY } from "./page-card-writer.mjs";
import { PAGE_CARDS_MAX, pageCardsFor, parsePageCardIds } from "./page-cards.mjs";
import { boundedMap } from "./bounded-map.mjs";
import { tools } from "../mcp.mjs";
import { world } from "./projects-fixture.mjs";

/** An in-memory Page assets bucket, as R2 answers. */
function bucket() {
  const objects = new Map();
  return {
    objects,
    reads: [],
    async put(key, value) {
      objects.set(key, String(value));
      return { key };
    },
    async get(key) {
      this.reads.push(key);
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async head(key) {
      return objects.has(key) ? { key } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

async function cardsWorld(t) {
  const w = await world(t);
  const assets = bucket();
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
    await assets.put(cardKey(pageId), JSON.stringify(card));
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
  const stored = JSON.parse(assets.objects.get(cardKey(pageId)));
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
  assets.objects.set(cardKey(unknown), JSON.stringify({ v: 1, card_hash: "x", blocks: [] }));
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

test("pageCardsFor checks shared entries at once, reads only allowed objects, and treats a bad object as no card", async () => {
  const storage = new Map([
    ["page/aaaaaaaa-0000-4000-8000-000000000001", { page_id: "a" }],
    ["page/aaaaaaaa-0000-4000-8000-000000000002", { page_id: "b", pending: true }],
    ["shared/aaaaaaaa-0000-4000-8000-000000000003", { page_id: "c" }],
    ["shared/aaaaaaaa-0000-4000-8000-000000000004", { page_id: "d" }],
    ["shared/aaaaaaaa-0000-4000-8000-000000000005", { page_id: "e" }],
  ]);
  const ids = [1, 2, 3, 4, 5, 6].map((n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`);
  const checks = { [ids[2]]: "ok", [ids[3]]: "denied", [ids[4]]: "unavailable" };
  const read = [];
  const errors = [];
  const cards = await pageCardsFor(ids, {
    storage: { get: async (key) => storage.get(key) },
    verifyShared: async (id) =>
      checks[id] === "ok" ? { status: "ok", page: { state: "active" } } : { status: checks[id] },
    readObject: async (key) => {
      read.push(key);
      return key.includes(ids[2])
        ? "{not json"
        : JSON.stringify({ v: 1, card_hash: "h", blocks: [] });
    },
    map: boundedMap,
    checks: 4,
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(read, [`pages/${ids[0]}/card.json`, `pages/${ids[2]}/card.json`]);
  assert.equal(cards[ids[0]].card_hash, "h");
  for (const id of ids.slice(1)) assert.equal(cards[id], null);
  assert.equal(errors.length, 1);
});
