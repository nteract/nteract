// The deployment's card: PAGES_SOCIAL_CARD selects an object in PAGES_ASSETS,
// the tags name its version, and /social-card.png serves it. Anything that
// goes wrong falls back to the committed card.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardBucket } from "./card-bucket-fixture.mjs";
import {
  BRAND_CARD_KEY,
  COMMITTED_CARD,
  brandCardKey,
  siteTags,
  socialCard,
  socialCardResponse,
  socialCardTags,
  socialCardUrl,
} from "./site-tags.mjs";
import { previewTags } from "./published-preview.mjs";
import { SOCIAL_CARD_BASE64, SOCIAL_CARD_VERSION } from "../shared/social-card.mjs";

const origin = "https://pages.example";
const version = "0123456789ab";
const key = `brand/social-card-${version}.png`;
const brandBytes = new TextEncoder().encode("the deployment's own card");
const committedBytes = Buffer.from(SOCIAL_CARD_BASE64, "base64");

const warnings = (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.parse(call.arguments[0]));
};

async function brandEnv(extra = {}) {
  const bucket = cardBucket();
  await bucket.put(key, brandBytes, { httpMetadata: { contentType: "image/png" } });
  return { PAGES_SOCIAL_CARD: key, PAGES_ASSETS: bucket, ...extra };
}

const fetchCard = (env, query, method = "GET") =>
  socialCardResponse(new Request(`${origin}/social-card.png${query}`, { method }), env);

const IMMUTABLE = {
  "content-type": "image/png",
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "cross-origin",
};
const BRIEF = { ...IMMUTABLE, "cache-control": "public, max-age=300" };

test("unset selects the committed card, with the tags and route unchanged", async (t) => {
  const logged = warnings(t);
  for (const env of [{}, { PAGES_SOCIAL_CARD: "" }, undefined])
    assert.equal(socialCard(env), COMMITTED_CARD);
  assert.deepEqual(COMMITTED_CARD, { version: SOCIAL_CARD_VERSION, key: null });
  assert.equal(
    socialCardUrl(origin, COMMITTED_CARD),
    `${origin}/social-card.png?v=${SOCIAL_CARD_VERSION}`,
  );
  const kept = await fetchCard({}, `?v=${SOCIAL_CARD_VERSION}`);
  assert.deepEqual(Object.fromEntries(kept.headers), IMMUTABLE);
  assert.deepEqual(Buffer.from(await kept.arrayBuffer()), committedBytes);
  assert.deepEqual(logged(), []);
});

test("a matching key selects its card, and every tag renderer names its version", async (t) => {
  const logged = warnings(t);
  const card = socialCard({ PAGES_SOCIAL_CARD: key });
  assert.deepEqual(card, { version, key });
  assert.equal(brandCardKey(version), key);
  assert.equal(BRAND_CARD_KEY.exec(key)[1], version);
  const url = `${origin}/social-card.png?v=${version}`;
  assert.equal(socialCardUrl(origin, card), url);
  const tags = socialCardTags(origin, card);
  assert.equal(tags["og:image"], url);
  assert.equal(tags["twitter:image"], url);
  // The deployment's card is drawn at the committed card's size.
  assert.equal(tags["og:image:width"], 1200);
  assert.equal(tags["og:image:height"], 630);
  // The same bytes for every caller, and the same card on every route.
  assert.equal(siteTags(origin, card), siteTags(origin, socialCard({ PAGES_SOCIAL_CARD: key })));
  for (const html of [siteTags(origin, card), previewTags(origin, card, "id", null)]) {
    assert.ok(html.includes(`<meta property="og:image" content="${url}">`), html);
    assert.ok(html.includes(`<meta name="twitter:image" content="${url}">`), html);
    assert.ok(!html.includes(SOCIAL_CARD_VERSION), html);
  }
  assert.deepEqual(logged(), []);
});

test("a value that doesn't match selects the committed card and is logged once", async (t) => {
  const logged = warnings(t);
  for (const value of [
    `brand/social-card-${version.toUpperCase()}.png`,
    `brand/social-card-${version.slice(1)}.png`,
    `brand/social-card-${version}0.png`,
    `/brand/social-card-${version}.png`,
    `brand/social-card-${version}.png.bak`,
    `cards/social-card-${version}.png`,
    `brand/social-card-${version}.jpg`,
    "https://cdn.example/card.png",
    42,
  ]) {
    assert.equal(socialCard({ PAGES_SOCIAL_CARD: value }), COMMITTED_CARD, String(value));
    assert.ok(
      siteTags(origin, socialCard({ PAGES_SOCIAL_CARD: value })).includes(
        `?v=${SOCIAL_CARD_VERSION}"`,
      ),
    );
  }
  // One line for the isolate however many reads see a refused value. It
  // names the setting and the shape it needs, not the value.
  const refusals = logged().filter((record) => record.event === "site.social_card_setting_refused");
  assert.equal(refusals.length, 1, JSON.stringify(refusals));
  assert.equal(refusals[0].setting, "PAGES_SOCIAL_CARD");
  assert.ok(!JSON.stringify(refusals).includes("cdn.example"));
});

test("the card's own URL streams it from PAGES_ASSETS with the committed card's headers", async (t) => {
  warnings(t);
  const env = await brandEnv();
  const response = await fetchCard(env, `?v=${version}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.fromEntries(response.headers), IMMUTABLE);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), brandBytes);
  assert.deepEqual(env.PAGES_ASSETS.reads, [key]);
  // HEAD reads the object's metadata, never its body.
  const head = await fetchCard(env, `?v=${version}`, "HEAD");
  assert.equal(head.status, 200);
  assert.deepEqual(Object.fromEntries(head.headers), IMMUTABLE);
  assert.equal(head.body, null);
  assert.deepEqual(env.PAGES_ASSETS.heads, [key]);
  assert.deepEqual(env.PAGES_ASSETS.reads, [key]);
  assert.equal((await fetchCard(env, `?v=${version}`, "POST")).status, 405);
});

test("a missing v or another version gets the committed card, kept briefly, with no read", async (t) => {
  warnings(t);
  const env = await brandEnv();
  for (const query of ["", `?v=${SOCIAL_CARD_VERSION}`, "?v=000000000000", `?v=${version}x`]) {
    const response = await fetchCard(env, query);
    assert.equal(response.status, 200, query);
    assert.deepEqual(Object.fromEntries(response.headers), BRIEF, query);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), committedBytes, query);
  }
  assert.deepEqual(env.PAGES_ASSETS.reads, []);
});

test("a card missing from PAGES_ASSETS, or a failed read, falls back to the committed card", async (t) => {
  const logged = warnings(t);
  const missing = { PAGES_SOCIAL_CARD: brandCardKey("ffffffffffff"), PAGES_ASSETS: cardBucket() };
  const failing = await brandEnv();
  failing.PAGES_ASSETS.beforeGet = async () => {
    throw Error("object store unavailable");
  };
  failing.PAGES_ASSETS.beforeHead = failing.PAGES_ASSETS.beforeGet;
  const unbound = { PAGES_SOCIAL_CARD: key };
  for (const [env, query] of [
    [missing, "?v=ffffffffffff"],
    [failing, `?v=${version}`],
    [unbound, `?v=${version}`],
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetchCard(env, query, method);
      assert.equal(response.status, 200, method);
      assert.deepEqual(Object.fromEntries(response.headers), BRIEF, method);
      if (method === "GET")
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), committedBytes);
    }
  }
  // One line per problem in this isolate, naming the key and never the bytes.
  const lines = logged().filter((record) => record.event === "site.social_card_unavailable");
  assert.deepEqual(
    lines.map(({ key, reason }) => ({ key, reason })),
    [
      { key: brandCardKey("ffffffffffff"), reason: "missing" },
      { key, reason: "read_failed" },
    ],
  );
});
