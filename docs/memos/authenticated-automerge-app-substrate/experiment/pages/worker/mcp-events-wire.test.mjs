import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  MAX_WEBHOOK_BYTES,
  parseWebhookSubscription,
  signWebhookBody,
  webhookKey,
  webhookRefreshBefore,
  webhookSubscriptionId,
} from "./mcp-events-wire.mjs";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const otherSecret = `whsec_${Buffer.alloc(24, 8).toString("base64")}`;
const subscription = () => ({
  name: "comment.created",
  arguments: { page_id: "page-123" },
  delivery: { mode: "webhook", url: "https://receiver.example/callback?token=private", secret },
});
const invalid = (run) =>
  assert.throws(run, { name: "TypeError", message: "Invalid MCP Events wire value" });

test("wire parsing is strict and returns detached arguments", () => {
  const sparse = [];
  sparse.length = 2;
  const input = subscription();
  const parsed = parseWebhookSubscription(input);
  assert.deepEqual(parsed, { ...input, cursor: null });
  input.arguments.page_id = "changed";
  assert.equal(parsed.arguments.page_id, "page-123");
  for (const change of [
    { name: "" },
    { name: "invalid event" },
    { name: "a".repeat(129) },
    { arguments: null },
    { arguments: [] },
    { arguments: { bad: undefined } },
    { arguments: { bad: Infinity } },
    { arguments: { bad: 1n } },
    { arguments: { bad: new Date() } },
    { arguments: { bad: sparse } },
    { arguments: { large: "é".repeat(8192) } },
    { extra: "ignored?" },
    { cursor: "cannot-replay" },
    { ttlMs: 0 },
    { ttlMs: -1 },
    { ttlMs: 1.5 },
    { ttlMs: "1000" },
    { ttlMs: NaN },
    { ttlMs: Number.MAX_SAFE_INTEGER + 1 },
  ])
    invalid(() => parseWebhookSubscription({ ...subscription(), ...change }));
  const cyclic = {};
  cyclic.self = cyclic;
  invalid(() => parseWebhookSubscription({ ...subscription(), arguments: cyclic }));
  let deep = {};
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  invalid(() => parseWebhookSubscription({ ...subscription(), arguments: deep }));
  invalid(() => parseWebhookSubscription(subscription(), "unknown"));
});

test("webhook URL checks are syntax only, not SSRF protection", () => {
  for (const url of [
    "http://receiver.example/",
    "ftp://receiver.example/",
    "not-url",
    "https://user:password@receiver.example/",
    "https://receiver.example/#fragment",
    "https://receiver.example/#",
    " https://receiver.example/",
    "https://receiver.example/\n",
    "https://receiver.example/a b",
    "https://receiver.example\\@localhost/",
  ]) {
    const input = subscription();
    input.delivery.url = url;
    invalid(() => parseWebhookSubscription(input));
  }
  // Deliberately proves that this parser must NEVER be treated as a safe fetch
  // gate. Only connect-time resolution and pinning can supply that guarantee.
  for (const url of ["https://127.0.0.1/", "https://[::1]/", "https://internal.example/"]) {
    const input = subscription();
    input.delivery.url = url;
    assert.equal(parseWebhookSubscription(input).delivery.url, url);
  }
  for (const delivery of [
    null,
    { mode: "polling", url: "https://receiver.example/", secret },
    { ...subscription().delivery, unknown: true },
    { mode: "webhook", secret },
  ])
    invalid(() => parseWebhookSubscription({ ...subscription(), delivery }));
});

test("Standard Webhooks keys enforce canonical base64 and 24–64 decoded bytes", () => {
  for (const length of [24, 25, 32, 63, 64]) {
    const bytes = Buffer.alloc(length, 255);
    assert.deepEqual(webhookKey(`whsec_${bytes.toString("base64")}`), new Uint8Array(bytes));
  }
  for (const key of [
    undefined,
    "",
    secret.slice(6),
    secret.replace(/=$/, ""),
    `whsec_${Buffer.alloc(23).toString("base64")}`,
    `whsec_${Buffer.alloc(65).toString("base64")}`,
    `${secret}\n`,
    secret.replace("=", "!"),
    "whsec_" + "_".repeat(32),
  ])
    invalid(() => webhookKey(key));
  // Decodes to the same bytes but nonzero pad bits are not canonical base64.
  invalid(() => webhookKey(`whsec_${"A".repeat(33)}B==`));
});

test("subscription IDs use canonical arguments and bind every ownership/filter component", async () => {
  const input = subscription();
  input.arguments = { page_id: "page-123", filter: { b: 2, a: [1, { z: false, x: null }] } };
  const first = await webhookSubscriptionId("principal-A", input);
  assert.match(first, /^sub_[a-f0-9]{64}$/);
  const reordered = {
    ...input,
    arguments: { filter: { a: [1, { x: null, z: false }], b: 2 }, page_id: "page-123" },
  };
  assert.equal(await webhookSubscriptionId("principal-A", reordered), first);
  assert.equal(
    await webhookSubscriptionId("principal-A", {
      ...input,
      ttlMs: 1,
      cursor: null,
      delivery: { ...input.delivery, secret: otherSecret },
    }),
    first,
  );
  for (const [principal, changed] of [
    ["principal-B", input],
    ["principal-A", { ...input, name: "page.changed" }],
    ["principal-A", { ...input, arguments: { ...input.arguments, page_id: "page-456" } }],
    [
      "principal-A",
      { ...input, delivery: { ...input.delivery, url: "https://receiver.example/other" } },
    ],
    ["principal-A", { ...input, arguments: { ...input.arguments, filter: { a: [2, 1], b: 2 } } }],
  ])
    assert.notEqual(await webhookSubscriptionId(principal, changed), first);
  const unsubscribe = { ...input, delivery: { mode: "webhook", url: input.delivery.url } };
  assert.equal(
    await webhookSubscriptionId(
      "principal-A",
      parseWebhookSubscription(unsubscribe, "unsubscribe"),
    ),
    first,
  );
  invalid(() => parseWebhookSubscription(input, "unsubscribe"));
  await assert.rejects(webhookSubscriptionId("", input), /Invalid MCP Events wire value/);
});

test("finite leases obey requested bounds, defaults and server maximum", () => {
  const policy = {
    now: Date.parse("2026-10-01T00:00:00Z"),
    defaultTtlMs: 60_000,
    maxTtlMs: 120_000,
  };
  for (const ttl of [undefined, null])
    assert.equal(webhookRefreshBefore(ttl, policy), "2026-10-01T00:01:00.000Z");
  assert.equal(webhookRefreshBefore(1, policy), "2026-10-01T00:00:00.001Z");
  assert.equal(webhookRefreshBefore(999_999, policy), "2026-10-01T00:02:00.000Z");
  for (const ttl of [0, -1, 0.5, "1000", NaN, Infinity])
    invalid(() => webhookRefreshBefore(ttl, policy));
  for (const change of [
    { now: -1 },
    { now: Infinity },
    { defaultTtlMs: 0 },
    { maxTtlMs: 1 },
    { now: 8_640_000_000_000_000 },
    { now: Number.MAX_SAFE_INTEGER },
  ])
    invalid(() => webhookRefreshBefore(undefined, { ...policy, ...change }));
});

const signing = () => ({
  subscriptionId: "sub_123",
  messageId: "evt_456",
  secret,
  body: '{"eventId":"evt_456","data":{"text":"café 🌱"}}',
  signedAt: 1_759_320_001_987,
});
const referenceSignature = (input, key) =>
  `v1,${createHmac("sha256", Buffer.from(key.slice(6), "base64"))
    .update(`${input.messageId}.${Math.floor(input.signedAt / 1000)}.${input.body}`, "utf8")
    .digest("base64")}`;

test("signatures interoperate with independent Node HMAC over exact UTF-8 bytes", async () => {
  const input = signing();
  const signed = await signWebhookBody(input);
  assert.equal(signed.body, input.body);
  assert.deepEqual(signed.headers, {
    "Content-Type": "application/json",
    "webhook-id": input.messageId,
    "webhook-timestamp": "1759320001",
    "webhook-signature": referenceSignature(input, secret),
    "X-MCP-Subscription-Id": input.subscriptionId,
  });
  for (const change of [
    { body: input.body + " " },
    { messageId: "evt_457" },
    { signedAt: input.signedAt + 1000 },
  ])
    assert.notEqual(
      (await signWebhookBody({ ...input, ...change })).headers["webhook-signature"],
      signed.headers["webhook-signature"],
    );
  const rotated = await signWebhookBody({ ...input, previousSecret: otherSecret });
  assert.equal(
    rotated.headers["webhook-signature"],
    `${referenceSignature(input, secret)} ${referenceSignature(input, otherSecret)}`,
  );
  assert.equal(
    (await signWebhookBody({ ...input, previousSecret: secret })).headers["webhook-signature"],
    signed.headers["webhook-signature"],
  );
  const verification = {
    ...input,
    messageId: "msg_verification_123",
    body: '{"type":"verification","challenge":"fresh"}',
  };
  assert.equal(
    (await signWebhookBody(verification)).headers["webhook-signature"],
    referenceSignature(verification, secret),
  );
});

test("signing enforces byte budgets and redacts all invalid wire values", async () => {
  const body = "é".repeat(MAX_WEBHOOK_BYTES / 2);
  assert.equal((await signWebhookBody({ ...signing(), body })).body, body);
  for (const change of [
    { body: body + "a" },
    { body: "" },
    { body: {} },
    { secret: "private-key-invalid" },
    { previousSecret: "private-old-key-invalid" },
    { messageId: "private\nheader" },
    { subscriptionId: "private.id" },
    { signedAt: -1 },
    { signedAt: 1.1 },
  ])
    await assert.rejects(signWebhookBody({ ...signing(), ...change }), {
      name: "TypeError",
      message: "Invalid MCP Events wire value",
    });
});

test("signing matches the upstream Standard Webhooks known-answer vector", async () => {
  // Public synthetic fixture, not a live secret:
  // https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/javascript/src/webhook.test.ts
  const signed = await signWebhookBody({
    subscriptionId: "sub_fixture",
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    messageId: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    signedAt: 1614265330000,
    body: '{"test": 2432232314}',
  });
  assert.equal(
    signed.headers["webhook-signature"],
    "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  );
});

test("canonical identity bounds object keys, strings and metadata before expensive work", () => {
  for (const args of [
    Object.fromEntries(Array.from({ length: 16_385 }, (_, i) => [`k${i}`, null])),
    { ["k".repeat(16_385)]: null },
    { value: "x".repeat(16_385) },
    { value: "\n".repeat(8192) },
  ])
    invalid(() => parseWebhookSubscription({ ...subscription(), arguments: args }));
});

test("standard MCP metadata is accepted but never retained or used for identity", async () => {
  const input = subscription();
  const parsed = parseWebhookSubscription({
    ...input,
    _meta: { progressToken: 123, custom: { a: true } },
  });
  assert.equal(Object.hasOwn(parsed, "_meta"), false);
  const expected = await webhookSubscriptionId("principal-A", input);
  assert.equal(await webhookSubscriptionId("principal-A", parsed), expected);
  const stopped = parseWebhookSubscription(
    {
      name: input.name,
      arguments: input.arguments,
      delivery: { mode: "webhook", url: input.delivery.url },
      _meta: { progressToken: "different" },
    },
    "unsubscribe",
  );
  assert.equal(await webhookSubscriptionId("principal-A", stopped), expected);
  for (const metadata of [null, "bad", [], { nested: undefined }, { big: "x".repeat(16_385) }])
    invalid(() => parseWebhookSubscription({ ...input, _meta: metadata }));
});

test("exact-body signing rejects lone surrogates but accepts valid UTF-16 pairs", async () => {
  for (const body of ["\ud800", "\udfff", "a\ud800b", "a\udfffb", "\ud800\ud800", "\udfff\ud800"])
    await assert.rejects(signWebhookBody({ ...signing(), body }), {
      name: "TypeError",
      message: "Invalid MCP Events wire value",
    });
  for (const body of ["\ud83c\udf31", "a\ud800\udc00b", "\udbff\udfff", '"\\ud800"']) {
    const input = { ...signing(), body };
    const signed = await signWebhookBody(input);
    assert.equal(signed.body, body);
    assert.equal(signed.headers["webhook-signature"], referenceSignature(input, secret));
  }
});

test("canonical budget is cumulative and stops before visiting later values", () => {
  const args = { first: "a".repeat(8000), second: "b".repeat(8000), third: "c".repeat(8000) };
  Object.defineProperty(args, "z_never_read", {
    enumerable: true,
    get() {
      assert.fail("cumulative byte limit must reject before reading later values");
    },
  });
  invalid(() => parseWebhookSubscription({ ...subscription(), arguments: args }));
});

test("every accepted argument byte/depth boundary can receive a subscription ID", async () => {
  const atByteLimit = { x: "a".repeat(16_384 - 8) };
  assert.equal(Buffer.byteLength(JSON.stringify(atByteLimit)), 16_384);
  let atDepthLimit = "leaf";
  for (let i = 0; i < 16; i++) atDepthLimit = { x: atDepthLimit };
  for (const args of [atByteLimit, atDepthLimit]) {
    const parsed = parseWebhookSubscription({ ...subscription(), arguments: args });
    assert.match(await webhookSubscriptionId("principal-A", parsed), /^sub_[a-f0-9]{64}$/);
  }
});
