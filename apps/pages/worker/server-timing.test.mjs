import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import {
  NO_TIMING,
  PHASE_TIMING_HEADER,
  SERVER_TIMING_MAX_LENGTH,
  attachTiming,
  createTiming,
  parseTiming,
  serializeTiming,
  serverTimingEnabled,
  timingFor,
  withServerTiming,
} from "./server-timing.mjs";
import { cardKey, pageCard } from "../model/page-card.mjs";
import { PAGE_CARD_KEY } from "./page-card-writer.mjs";
import { cardBucket } from "./card-bucket-fixture.mjs";
import { storeCardImage } from "./card-images.mjs";
import { immutableHeaders, world } from "./projects-fixture.mjs";
import { proposeAccessUpdate } from "./access.mjs";

/** A clock the test moves by hand. */
function clock() {
  let at = 0;
  return { now: () => at, advance: (ms) => (at += ms) };
}

/** Every metric a Server-Timing value names, in order. */
const names = (value) => value.split(", ").map((metric) => metric.split(";")[0]);
/** A 3x2 WebP (the card-images.test.mjs fixture). */
const WEBP = new Uint8Array(
  Buffer.from(
    "UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoDAAIAAUAmJaACdLoB+AAEyAAA/q4X/yU1/jblq/+QXq3zbGgAAA==",
    "base64",
  ),
);
/** The grammar this module writes, and nothing else. */
const METRIC = /^[a-z][a-z0-9_]*(;dur=\d+(\.\d)?)?(;desc="n=\d+")?$/;

test("a phase's duration is the time between its start and end", () => {
  const c = clock();
  const timing = createTiming(c);
  const end = timing.start("auth");
  c.advance(12.34);
  end();
  end(); // A second end counts once.
  assert.deepEqual(timing.entries(), [{ name: "auth", dur: 12.3, n: 1, max: 12.3 }]);
  assert.equal(timing.header(), "auth;dur=12.3");
});

test("overlapping runs count busy wall time, their number and the slowest one", () => {
  const c = clock();
  const timing = createTiming(c);
  const a = timing.start("verify");
  c.advance(10);
  const b = timing.start("verify");
  c.advance(30);
  a(); // 40
  c.advance(5);
  b(); // 35
  c.advance(100); // idle: not counted
  const d = timing.start("verify");
  c.advance(7);
  d();
  assert.deepEqual(timing.entries(), [{ name: "verify", dur: 52, n: 3, max: 40 }]);
  assert.equal(timing.header(), 'verify;dur=52;desc="n=3", verify_max;dur=40');
});

test("measure ends its phase when the work throws, and a run in flight counts up to now", async () => {
  const c = clock();
  const timing = createTiming(c);
  await assert.rejects(
    timing.measure("catalog", async () => {
      c.advance(3);
      throw new Error("refused");
    }),
  );
  timing.start("r2");
  c.advance(4);
  assert.equal(timing.header(), "catalog;dur=3, r2;dur=4");
});

test("count adds runs without a duration", () => {
  const timing = createTiming(clock());
  timing.count("rows", 4);
  timing.count("rows");
  timing.count("rows", -1);
  timing.count("rows", 1.5);
  assert.equal(timing.header(), 'rows;desc="n=5"');
});

test("names that could break the header or carry data record nothing", () => {
  const timing = createTiming(clock());
  for (const name of [
    "Auth",
    "auth;dur=1",
    'a"b',
    "a,b",
    "a b",
    "33333333-3333-4333-8333-333333333333",
    "user:anaconda-fixture:someone",
    "x".repeat(41),
    "",
  ]) {
    timing.start(name)();
    timing.count(name);
  }
  assert.equal(timing.header(), "");
  assert.equal(serializeTiming([{ name: "bad name", dur: 1, n: 1 }]), "");
  // Non-finite and negative durations read as zero.
  assert.equal(
    serializeTiming([
      { name: "a", dur: Number.NaN, n: 1 },
      { name: "b", dur: -5, n: 1 },
    ]),
    "a;dur=0, b;dur=0",
  );
});

test("the header stops before its size cap", () => {
  const timing = createTiming(clock());
  for (let index = 0; index < 400; index += 1) timing.start(`phase_${index}`)();
  const value = timing.header();
  assert.ok(value.length <= SERVER_TIMING_MAX_LENGTH, String(value.length));
  assert.ok(value.startsWith("phase_0;dur=0, phase_1;dur=0"));
  for (const metric of value.split(", ")) assert.match(metric, METRIC);
});

test("parse reads back what serialize wrote, and merge adds it under a prefix", () => {
  const c = clock();
  const inner = createTiming(c);
  const end = inner.start("verify");
  c.advance(10);
  const other = inner.start("verify");
  c.advance(10);
  end();
  other();
  inner.start("scan");
  c.advance(2.5);
  inner.entries(); // reading never ends a run
  const value = inner.header();
  assert.deepEqual(parseTiming(value), [
    { name: "verify", dur: 20, max: 20, n: 2 },
    { name: "scan", dur: 2.5, max: 2.5, n: 1 },
  ]);
  const outer = createTiming(clock());
  outer.merge(value, { prefix: "cat_" });
  outer.merge(value, { prefix: "cat_" });
  outer.merge(inner, { prefix: "x_" });
  assert.equal(
    outer.header(),
    'cat_verify;dur=40;desc="n=4", cat_verify_max;dur=20, cat_scan;dur=5;desc="n=2", cat_scan_max;dur=2.5, ' +
      'x_verify;dur=20;desc="n=2", x_verify_max;dur=20, x_scan;dur=2.5',
  );
});

test("parse skips anything that isn't this module's own form", () => {
  assert.deepEqual(
    parseTiming(
      'Bad;dur=1, ok;dur=1;desc="title", ok2;dur=-1, ok3;foo=1, ok4;dur=1;desc="n=0", good;dur=2',
    ),
    [{ name: "good", dur: 2, max: 2, n: 1 }],
  );
  assert.deepEqual(parseTiming(undefined), []);
  assert.deepEqual(parseTiming("a;dur=1, ".repeat(400)), []);
});

test("PAGES_SERVER_TIMING turns the header off", () => {
  assert.equal(serverTimingEnabled({}), true);
  assert.equal(serverTimingEnabled(undefined), true);
  assert.equal(serverTimingEnabled({ PAGES_SERVER_TIMING: "on" }), true);
  for (const off of ["off", "OFF", " false ", "0"])
    assert.equal(serverTimingEnabled({ PAGES_SERVER_TIMING: off }), false, off);
});

test("a request's recorder travels with it; an untimed one records nothing", async () => {
  const request = new Request("https://pages.invalid/");
  assert.equal(timingFor(request), NO_TIMING);
  assert.equal(await NO_TIMING.measure("auth", async () => 7), 7);
  const timing = createTiming(clock());
  assert.equal(attachTiming(request, timing), request);
  assert.equal(timingFor(request), timing);
});

test("withServerTiming copies a response whose headers refuse writes", async () => {
  const timing = createTiming(clock());
  timing.start("auth")();
  const frozen = immutableHeaders(Response.json({ ok: true }, { status: 201 }));
  const answer = withServerTiming(frozen, timing);
  assert.notEqual(answer, frozen);
  assert.equal(answer.status, 201);
  assert.equal(answer.headers.get("server-timing"), "auth;dur=0");
  assert.deepEqual(await answer.json(), { ok: true });
  const plain = new Response("x");
  assert.equal(withServerTiming(plain, NO_TIMING), plain);
  assert.equal(plain.headers.has("server-timing"), false);
});

// Through the gateway.

async function timedWorld(t) {
  const w = await world(t);
  const assets = cardBucket();
  w.env.PAGES_ASSETS = assets;
  const tokens = { owner: w.auth.apiKey(), member: w.auth.apiKey({ userId: "member-user" }) };
  const settle = async () => {
    while (w.jobs.length) await Promise.allSettled(w.jobs.splice(0));
  };
  const send = async (
    path,
    { who = "owner", method = "POST", body, headers = {}, env = w.env } = {},
  ) => {
    const response = await worker.fetch(
      new Request(`https://pages.invalid${path}`, {
        method,
        headers: {
          ...(who && { authorization: `Bearer ${tokens[who]}` }),
          ...(body !== undefined && { "content-type": "application/json" }),
          ...headers,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
      env,
    );
    const text = await response.text();
    await settle();
    return { status: response.status, headers: response.headers, text };
  };
  const tool = (operation, args = {}, who = "owner") =>
    send("/api/tools", { who, body: { operation, arguments: args } });
  const create = async (title) => {
    const created = await w.createPage({ title, markdown: `# ${title}\n\nBody of ${title}.` });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await settle();
    const pageId = created.body.page_id;
    const card = await pageCard(w.page(pageId).handle.doc());
    await assets.seed(cardKey(pageId), card);
    await w.page(pageId).ctx.storage.put(PAGE_CARD_KEY, { card_hash: card.card_hash });
    return { pageId, card };
  };
  return { w, assets, tokens, send, tool, create, settle };
}

/** Assert `value` is a Server-Timing header in this module's grammar that
 * names `expected` and carries none of `secrets`. */
function assertTiming(value, expected, secrets) {
  assert.ok(value, "Server-Timing is present");
  for (const metric of value.split(", ")) assert.match(metric, METRIC);
  const present = new Set(names(value));
  for (const name of expected) assert.ok(present.has(name), `${name} in ${value}`);
  for (const secret of secrets) assert.equal(value.includes(secret), false, secret);
}

test("the library's three calls and a card image read carry their phases", async (t) => {
  const { w, assets, tool, send, create } = await timedWorld(t);
  const own = await create("Quarterly plan");
  const shared = await create("Shared roadmap");
  // A shared row the member's listing and cards verify with the Page host.
  const host = w.page(shared.pageId);
  const ownerIdentity = { principal: w.owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  host.metadata = {
    ...host.metadata,
    acl: proposeAccessUpdate(host.metadata, ownerIdentity, {
      principal: w.member,
      role: "viewer",
      expected_revision: host.metadata.acl?.revision ?? 0,
    }).acl,
  };
  await host.ctx.storage.put("host/document", host.metadata);
  await w.catalogStorage(w.member).put(`shared/${shared.pageId}`, {
    page_id: shared.pageId,
    title: "Shared roadmap",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    shared: true,
  });
  const project = await w.createProject("Launch secrets");
  await storeCardImage(assets, {
    pageId: own.pageId,
    hash: own.card.card_hash,
    theme: "light",
    bytes: WEBP,
    contentType: "image/webp",
    revision: 1,
  });
  const secrets = [
    own.pageId,
    shared.pageId,
    project.project_id,
    w.owner,
    w.member,
    "fixture",
    "Quarterly",
    "Shared roadmap",
    "Launch",
    own.card.card_hash,
    "/",
  ];

  const listed = await tool("list_pages", { limit: 10 });
  assert.equal(listed.status, 200, listed.text);
  assertTiming(
    listed.headers.get("server-timing"),
    [
      "total",
      "auth",
      "auth_session",
      "auth_account",
      "quota",
      "catalog",
      "cat_queue",
      "cat_auth",
      "cat_auth_session",
      "cat_scan",
      "cat_d1_open",
      "cat_reconcile",
      "cat_candidates",
    ],
    secrets,
  );
  const memberList = await tool("list_pages", { limit: 10 }, "member");
  assert.equal(memberList.status, 200, memberList.text);
  assert.ok(memberList.text.includes(shared.pageId));
  assertTiming(memberList.headers.get("server-timing"), ["cat_verify"], secrets);

  const projects = await tool("list_projects");
  assert.equal(projects.status, 200, projects.text);
  assertTiming(
    projects.headers.get("server-timing"),
    ["total", "auth", "catalog", "cat_queue", "cat_invites", "cat_discovery", "cat_candidates"],
    secrets,
  );

  const cards = await tool("page_cards", { page_ids: [own.pageId] });
  assert.equal(cards.status, 200, cards.text);
  const cardTiming = cards.headers.get("server-timing");
  assertTiming(cardTiming, ["total", "auth", "catalog", "cat_cards", "r2"], secrets);
  // The access step runs outside the Catalog's queue (catalog-lanes.mjs).
  assert.equal(names(cardTiming).includes("cat_queue"), false);
  // One card object and one image pointer.
  assert.match(cardTiming, /(^|, )r2;dur=[\d.]+;desc="n=2", r2_max;dur=/);
  const memberCards = await tool("page_cards", { page_ids: [shared.pageId] }, "member");
  assertTiming(memberCards.headers.get("server-timing"), ["cat_verify"], secrets);

  for (const path of [
    `/api/pages/${own.pageId}/card-image`,
    `/api/pages/${own.pageId}/card-image/${own.card.card_hash}-light.webp`,
  ]) {
    const image = await send(path, { method: "GET" });
    assertTiming(
      image.headers.get("server-timing"),
      ["total", "auth", "allowed", "catalog", "cat_cards", "r2"],
      secrets,
    );
  }
  for (const answer of [listed, memberList, projects, cards, memberCards])
    assert.equal(answer.headers.has(PHASE_TIMING_HEADER), false);
  assert.equal(listed.headers.has("timing-allow-origin"), false);
});

test("PAGES_SERVER_TIMING=off sends no header, and the Catalog is never asked", async (t) => {
  const { w, tool, send, create } = await timedWorld(t);
  const { pageId } = await create("Plan");
  w.env.PAGES_SERVER_TIMING = "off";
  for (const answer of [
    await tool("list_pages"),
    await tool("list_projects"),
    await tool("page_cards", { page_ids: [pageId] }),
    await send(`/api/pages/${pageId}/card-image`, { method: "GET" }),
  ]) {
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.headers.has("server-timing"), false);
    assert.equal(answer.headers.has(PHASE_TIMING_HEADER), false);
  }
});

test("public routes, /mcp and unauthenticated calls carry no timings", async (t) => {
  const { w, tool, send, create } = await timedWorld(t);
  const { pageId } = await create("Plan");
  const answers = [
    await send("/health", { method: "GET", who: null }),
    await send(`/p/${pageId}/preview.json`, { method: "GET", who: null }),
    await send(`/p/${pageId}/meta.json`, { method: "GET", who: null }),
    await send(`/api/pages/${pageId}/card-image`, { method: "GET", who: null }),
    await send("/api/tools", { who: null, body: { operation: "list_pages", arguments: {} } }),
    await send("/mcp", {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_pages", arguments: {} },
      },
      headers: { accept: "application/json, text/event-stream" },
      // MCP results carry links, so the gateway needs its public origin.
      env: { ...w.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid" },
    }),
  ];
  // The MCP call ran: the route is timed nowhere, not merely refused.
  assert.ok(answers.at(-1).text.includes(pageId), answers.at(-1).text);
  for (const answer of answers) {
    assert.equal(answer.headers.has("server-timing"), false, answer.text.slice(0, 200));
    assert.equal(answer.headers.has(PHASE_TIMING_HEADER), false);
  }
  // An authenticated caller's refused call still carries its phases.
  const refused = await tool("list_pages", { limit: 1000 });
  assert.equal(refused.status, 400);
  assert.ok(refused.headers.has("server-timing"));
});

test("a stored receipt and its replay are byte-identical with and without timings", async (t) => {
  const { w, tool } = await timedWorld(t);
  const nonce = `timing-receipt-${crypto.randomUUID()}`;
  const args = { title: "Receipt", markdown: "Body.", nonce };
  const first = await tool("create_page", args);
  assert.equal(first.status, 200, first.text);
  assert.ok(first.headers.has("server-timing"));
  const stored = await w.receipt(nonce);
  assert.ok(stored, "the Catalog stored a receipt");
  const timed = await tool("create_page", args);
  w.env.PAGES_SERVER_TIMING = "off";
  const untimed = await tool("create_page", args);
  assert.equal(untimed.headers.has("server-timing"), false);
  assert.ok(timed.headers.has("server-timing"));
  assert.equal(timed.status, untimed.status);
  assert.equal(timed.text, untimed.text);
  assert.equal(first.text, timed.text);
  assert.deepEqual(await w.receipt(nonce), stored);
  for (const answer of [first, timed, untimed]) {
    assert.equal(answer.headers.has(PHASE_TIMING_HEADER), false);
    assert.equal(answer.text.includes("dur="), false);
  }
});
