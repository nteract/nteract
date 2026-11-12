import assert from "node:assert/strict";
import { test } from "node:test";
import { Refusal } from "../sync/host.mjs";
import {
  ROUNDS_EMPTY,
  ROUND_BUCKETS_MS,
  roundsStep,
  syncRefusedRecord,
  syncRoundsRecord,
} from "./plain-sync-log.mjs";

const pageId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-11-04T00:00:00Z");
const round = (ms, extra = {}) => ({
  type: "round",
  ms,
  waitMs: 1,
  changes: 2,
  bytes: 30,
  ...extra,
});

test("roundsStep covers every state and event", () => {
  const one = roundsStep(ROUNDS_EMPTY, round(5)).state;
  const closed = roundsStep(ROUNDS_EMPTY, { type: "close" }).state;
  const cases = [
    ["empty + round", ROUNDS_EMPTY, round(5), "collecting", false],
    ["empty + close", ROUNDS_EMPTY, { type: "close" }, "closed", false],
    ["collecting + round", one, round(7), "collecting", false],
    ["collecting + close", one, { type: "close" }, "closed", true],
    ["closed + round", closed, round(7), "closed", false],
    ["closed + close", closed, { type: "close" }, "closed", false],
  ];
  for (const [label, state, event, phase, emits] of cases) {
    const result = roundsStep(state, event);
    assert.equal(result.state.phase, phase, label);
    assert.equal(result.emit !== null, emits, label);
  }
  assert.throws(() => roundsStep(ROUNDS_EMPTY, { type: "tick" }), TypeError);
});

test("rounds are summarised and emitted every perRecord rounds and at close", () => {
  let state = ROUNDS_EMPTY;
  const emitted = [];
  for (const ms of [3, 10, 11, 4000, 6000]) {
    const result = roundsStep(state, round(ms), { perRecord: 3 });
    state = result.state;
    if (result.emit) emitted.push(result.emit);
  }
  assert.equal(emitted.length, 1);
  assert.equal(state.phase, "collecting");
  const close = roundsStep(state, { type: "close" }, { perRecord: 3 });
  emitted.push(close.emit);
  assert.deepEqual(
    emitted.map(({ rounds, changes, bytes, msSum, msMax, waitMsSum }) => ({
      rounds,
      changes,
      bytes,
      msSum,
      msMax,
      waitMsSum,
    })),
    [
      { rounds: 3, changes: 6, bytes: 90, msSum: 24, msMax: 11, waitMsSum: 3 },
      { rounds: 2, changes: 4, bytes: 60, msSum: 10000, msMax: 6000, waitMsSum: 2 },
    ],
  );
  // Inclusive upper bounds: 3 and 10 land in "10", 11 in "25".
  const first = syncRoundsRecord({ pageId, summary: emitted[0], credential: "oidc", now });
  assert.deepEqual(first.latency_ms_buckets, {
    10: 2,
    25: 1,
    50: 0,
    100: 0,
    250: 0,
    500: 0,
    1000: 0,
    2500: 0,
    5000: 0,
    "+Inf": 0,
  });
  const second = syncRoundsRecord({ pageId, summary: emitted[1], now });
  assert.equal(second.latency_ms_buckets["5000"], 1);
  assert.equal(second.latency_ms_buckets["+Inf"], 1);
  assert.equal(Object.keys(second.latency_ms_buckets).length, ROUND_BUCKETS_MS.length + 1);
  assert.deepEqual(
    { ...second, latency_ms_buckets: undefined },
    {
      service: "nteract-pages-native",
      event: "page.sync_rounds",
      page_id: pageId,
      credential: "none",
      rounds: 2,
      changes: 4,
      bytes: 60,
      latency_ms_sum: 10000,
      latency_ms_max: 6000,
      wait_ms_sum: 2,
      latency_ms_buckets: undefined,
      timestamp: "2026-11-04T00:00:00.000Z",
    },
  );
});

test("a fatal refusal logs its close outcome; a non-fatal one only its reason", () => {
  const schema = new Refusal("schema_unsupported", "Reload", {
    fatal: true,
    close: { code: 4426, reason: "schema_unsupported" },
  });
  assert.deepEqual(
    syncRefusedRecord({ pageId, kind: "page", refusal: schema, credential: "oidc", now }),
    {
      service: "nteract-pages-native",
      event: "page.sync_refused",
      page_id: pageId,
      doc: "page",
      reason: "schema_unsupported",
      fatal: true,
      code: "schema_unsupported",
      status: 409,
      close: 4426,
      credential: "oidc",
      timestamp: "2026-11-04T00:00:00.000Z",
    },
  );
  const claimed = new Refusal("actor_claimed", "Actor ab belongs to another principal");
  assert.deepEqual(
    syncRefusedRecord({ pageId, kind: "comments", refusal: claimed, repeats: 3, now }),
    {
      service: "nteract-pages-native",
      event: "page.sync_refused",
      page_id: pageId,
      doc: "comments",
      reason: "actor_claimed",
      fatal: false,
      credential: "none",
      repeats: 3,
      timestamp: "2026-11-04T00:00:00.000Z",
    },
  );
  const queue = new Refusal("receive_queue_full", "Too many", {
    fatal: true,
    close: { code: 4503, reason: "temporarily_unavailable" },
  });
  assert.deepEqual(
    (({ code, status, close }) => ({ code, status, close }))(
      syncRefusedRecord({ pageId, kind: "page", refusal: queue, now }),
    ),
    { code: "temporarily_unavailable", status: 503, close: 4503 },
  );
  // A fatal refusal without a close takes the host's default.
  const ephemeral = new Refusal("ephemeral_too_large", "Too big", { fatal: true });
  assert.deepEqual(
    (({ code, status, close }) => ({ code, status, close }))(
      syncRefusedRecord({ pageId, kind: "page", refusal: ephemeral, now }),
    ),
    { code: "request_rejected", status: 400, close: 4400 },
  );
});

test("a refusal names each kind a Page host serves", () => {
  for (const kind of ["page", "comments", "sources"])
    assert.equal(
      syncRefusedRecord({ pageId, kind, refusal: new Refusal("request_rejected", "no"), now }).doc,
      kind,
    );
});

test("refusal records keep free text, bad ids and identities out", () => {
  const record = syncRefusedRecord({
    pageId: "not a page id",
    kind: "other",
    refusal: Object.assign(new Refusal("Actor abc belongs to user:x", "user:x"), {
      principal: "user:x",
    }),
    credential: "token-in-a-header",
    now,
  });
  assert.equal(record.page_id, undefined);
  assert.equal(record.doc, "unknown");
  assert.equal(record.reason, "unknown");
  assert.equal(record.credential, "none");
  assert.ok(!JSON.stringify(record).includes("user:x"));
});
