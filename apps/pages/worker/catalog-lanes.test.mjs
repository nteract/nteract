import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { CARDS_LANE, CARDS_LANE_HEADER, catalogLane } from "./catalog-lanes.mjs";
import { gatewayFixture } from "./gateway-fixture.mjs";
import { cardKey, pageCard } from "../model/page-card.mjs";
import { PAGE_CARD_KEY } from "./page-card-writer.mjs";
import { cardBucket } from "./card-bucket-fixture.mjs";
import { world } from "./projects-fixture.mjs";
import { PHASE_TIMING_HEADER, TIMING_REQUEST_HEADER, parseTiming } from "./server-timing.mjs";

const lane = (path, headers = {}) =>
  catalogLane(new Request(`https://pages.internal${path}`, { method: "POST", headers }));

test("catalogLane: only the cards header on /internal/catalog leaves the queue", () => {
  assert.equal(lane("/internal/catalog"), "queued");
  assert.equal(lane("/internal/catalog", { [CARDS_LANE_HEADER]: CARDS_LANE }), "cards");
  assert.equal(lane("/internal/catalog", { [CARDS_LANE_HEADER]: "location" }), "queued");
  assert.equal(lane("/internal/title", { [CARDS_LANE_HEADER]: CARDS_LANE }), "queued");
  assert.equal(lane("/internal/projection", { [CARDS_LANE_HEADER]: CARDS_LANE }), "queued");
  assert.equal(lane("/internal/location"), "location");
  assert.equal(lane("/internal/project-discovery"), "discovery");
});

async function cardsWorld(t) {
  const w = await world(t);
  const assets = cardBucket();
  w.env.PAGES_ASSETS = assets;
  const create = async (title) => {
    const created = await w.createPage({ title, markdown: "Body" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await w.settle();
    const pageId = created.body.page_id;
    const card = await pageCard(w.page(pageId).handle.doc());
    await assets.seed(cardKey(pageId), card);
    await w.page(pageId).ctx.storage.put(PAGE_CARD_KEY, { card_hash: card.card_hash });
    return pageId;
  };
  /** Hold the owner's Catalog queue until the returned function runs. */
  const holdQueue = () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const running = w.catalog().queue(() => held);
    return async () => {
      release();
      await running;
    };
  };
  return { w, create, holdQueue };
}

const within = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const settledWithin = async (promise, ms) => {
  let timer;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return result;
};

test("page_cards answers while a queued Catalog request is held; a write still waits", async (t) => {
  const { w, create, holdQueue } = await cardsWorld(t);
  const pageId = await create("Plan");
  const release = holdQueue();
  t.after(release);
  const cards = await within(
    w.call("owner", "page_cards", { page_ids: [pageId] }),
    2000,
    "page_cards waited behind the queue",
  );
  assert.equal(cards.status, 200, JSON.stringify(cards.body));
  assert.equal(cards.body.cards[pageId].title, "Plan");

  const created = w.createPage({ title: "Later" });
  const listed = w.call("owner", "list_pages");
  assert.equal(await settledWithin(created, 50), false, "create_page ran past the held queue");
  assert.equal(await settledWithin(listed, 10), false, "list_pages ran past the held queue");
  await release();
  assert.equal((await created).status, 200);
  assert.equal((await listed).status, 200);
});

test("a cards-lane request records no queue phase; a queued one does", async (t) => {
  const { w, create } = await cardsWorld(t);
  const pageId = await create("Plan");
  const ask = async (headers, operation, args) => {
    const response = await w.catalog().fetch(
      new Request("https://pages.invalid/internal/catalog", {
        method: "POST",
        headers: {
          authorization: `Bearer ${w.auth.apiKey()}`,
          [TIMING_REQUEST_HEADER]: "1",
          ...headers,
        },
        body: JSON.stringify({ operation, arguments: args }),
      }),
    );
    const names = parseTiming(response.headers.get(PHASE_TIMING_HEADER) ?? "").map(
      (metric) => metric.name,
    );
    return { status: response.status, body: await response.json(), names };
  };
  const cards = await ask({ [CARDS_LANE_HEADER]: CARDS_LANE }, "page_cards", {
    page_ids: [pageId],
  });
  assert.equal(cards.status, 200, JSON.stringify(cards.body));
  assert.deepEqual(cards.body.allowed, [pageId]);
  assert.ok(cards.names.includes("cards"));
  assert.equal(cards.names.includes("queue"), false);
  const queued = await ask({}, "page_cards", { page_ids: [pageId] });
  assert.ok(queued.names.includes("queue"));
});

test("the cards lane answers only page_cards", async (t) => {
  const { w, holdQueue } = await cardsWorld(t);
  const release = holdQueue();
  t.after(release);
  for (const operation of ["list_pages", "create_page", "list_spaces", "delete_page"]) {
    const response = await within(
      w.catalog().fetch(
        new Request("https://pages.invalid/internal/catalog", {
          method: "POST",
          headers: {
            authorization: `Bearer ${w.auth.apiKey()}`,
            [CARDS_LANE_HEADER]: CARDS_LANE,
          },
          body: JSON.stringify({ operation, arguments: {} }),
        }),
      ),
      2000,
      `${operation} in the cards lane waited for the queue`,
    );
    assert.equal(response.status, 400, operation);
  }
});

test("a client's lane header never reaches the Catalog; the gateway sets it for page_cards only", async (t) => {
  const fixture = await gatewayFixture(t);
  const seen = [];
  fixture.env.CATALOGS = {
    getByName: () => ({
      async fetch(request) {
        const body = await request.clone().json();
        seen.push({ operation: body.operation, lane: request.headers.get(CARDS_LANE_HEADER) });
        if (body.operation === "page_cards") return Response.json({ allowed: [] });
        return Response.json({ pages: [], next_cursor: null, limit: 1 });
      },
    }),
  };
  for (const operation of ["list_pages", "list_projects"]) {
    const response = await worker.fetch(
      new Request("https://pages.invalid/api/tools", {
        method: "POST",
        headers: {
          authorization: fixture.bearer,
          "content-type": "application/json",
          [CARDS_LANE_HEADER]: CARDS_LANE,
        },
        body: JSON.stringify({ operation, arguments: {} }),
      }),
      fixture.env,
    );
    await response.body?.cancel();
  }
  const cards = await worker.fetch(
    new Request("https://pages.invalid/api/tools", {
      method: "POST",
      headers: {
        authorization: fixture.bearer,
        "content-type": "application/json",
        [CARDS_LANE_HEADER]: "queued",
      },
      body: JSON.stringify({ operation: "page_cards", arguments: { page_ids: [] } }),
    }),
    fixture.env,
  );
  assert.equal(cards.status, 200);
  assert.deepEqual(seen, [
    { operation: "list_pages", lane: null },
    { operation: "list_spaces", lane: null },
    { operation: "page_cards", lane: CARDS_LANE },
  ]);
});
