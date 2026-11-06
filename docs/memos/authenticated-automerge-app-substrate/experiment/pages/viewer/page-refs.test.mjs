import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualTimeScheduler } from "rxjs";
import { runTable } from "../shared/machine-test.mjs";
import {
  PAGE_REF_BACKOFF_MAX_MS,
  PAGE_REF_BACKOFF_MS,
  PAGE_REF_CONCURRENCY,
  PAGE_REF_TTL_MS,
  PAGE_REF_UNAVAILABLE_TTL_MS,
  PageRefs,
  backoffMs,
  pageRefMachine,
  pageRefPoolMachine,
  readCard,
  readMeta,
  settledOf,
} from "./page-refs.mjs";

const ok = (state, effects = []) => ({ state, effects });
const no = (state, rejected) => ({ state, effects: [], rejected });
const VALUE = { title: "Plan", state: "active", role: "viewer", content_updated_at: null };
const fetch = [{ type: "fetch" }];
const expire = [{ type: "expire", ms: PAGE_REF_TTL_MS }];
const expireUnavailable = [{ type: "expire", ms: PAGE_REF_UNAVAILABLE_TTL_MS }];
const idle = { name: "idle" };
const requested = (last = null, attempts = 0) => ({ name: "requested", last, attempts });
const readable = (stale = false) => ({ name: "readable", value: VALUE, stale });
const unavailable = (stale = false) => ({ name: "unavailable", stale });
const failed = (attempts, ready, last = null) => ({ name: "failed", last, attempts, ready });
const lastReadable = { name: "readable", value: VALUE };
const lastUnavailable = { name: "unavailable" };
const wanted = { type: "wanted" };
const answered = { type: "answered", value: VALUE };

const refRows = [
  { state: idle, event: wanted, expect: ok(requested(), fetch) },
  { state: requested(), event: wanted, expect: no(requested(), "already requested") },
  { state: requested(), event: answered, expect: ok(readable(), expire) },
  {
    label: "a refresh's answer replaces the one it refreshed",
    state: requested(lastReadable),
    event: { type: "refused" },
    expect: ok(unavailable(), expireUnavailable),
  },
  {
    state: requested(null, 2),
    event: { type: "failed" },
    expect: ok(failed(3, false), [{ type: "backoff", ms: backoffMs(3) }]),
  },
  {
    label: "a failed refresh keeps the answer it refreshed",
    state: requested(lastReadable),
    event: { type: "failed" },
    expect: ok(failed(1, false, lastReadable), [{ type: "backoff", ms: PAGE_REF_BACKOFF_MS }]),
  },
  { case: "fresh", state: readable(), event: wanted, expect: no(readable(), "fresh") },
  {
    case: "stale",
    label: "a stale answer is asked again and shows meanwhile",
    state: readable(true),
    event: wanted,
    expect: ok(requested(lastReadable), fetch),
  },
  { case: "fresh", state: readable(), event: { type: "expired" }, expect: ok(readable(true)) },
  {
    case: "stale",
    state: readable(true),
    event: { type: "expired" },
    expect: no(readable(true), "already stale"),
  },
  { case: "fresh", state: unavailable(), event: wanted, expect: no(unavailable(), "fresh") },
  {
    case: "stale",
    label: "a refusal is asked again after its TTL: access can be granted",
    state: unavailable(true),
    event: wanted,
    expect: ok(requested(lastUnavailable), fetch),
  },
  {
    case: "fresh",
    state: unavailable(),
    event: { type: "expired" },
    expect: ok(unavailable(true)),
  },
  {
    case: "stale",
    state: unavailable(true),
    event: { type: "expired" },
    expect: no(unavailable(true), "already stale"),
  },
  {
    case: "backing-off",
    state: failed(1, false),
    event: wanted,
    expect: no(failed(1, false), "backing off"),
  },
  {
    case: "ready",
    label: "after the backoff, the next ask goes out and keeps its count",
    state: failed(2, true, lastReadable),
    event: wanted,
    expect: ok(requested(lastReadable, 2), fetch),
  },
  {
    case: "backing-off",
    state: failed(1, false),
    event: { type: "retry" },
    expect: ok(failed(1, true)),
  },
  {
    case: "ready",
    state: failed(1, true),
    event: { type: "retry" },
    expect: no(failed(1, true), "already ready"),
  },
];

test("page-ref: every state × event", async () => {
  const result = await runTable(pageRefMachine, refRows);
  assert.equal(result.rows, refRows.length);
});

test("a failed ref backs off exponentially, up to a cap", () => {
  assert.equal(backoffMs(1), PAGE_REF_BACKOFF_MS);
  assert.equal(backoffMs(2), PAGE_REF_BACKOFF_MS * 2);
  assert.equal(backoffMs(3), PAGE_REF_BACKOFF_MS * 4);
  assert.equal(backoffMs(30), PAGE_REF_BACKOFF_MAX_MS);
});

const pool = (name, waiting, busy, slots = 2) => ({ name, waiting, busy, slots });
const send = [{ type: "send" }];
const poolRows = [
  { state: pool("quiet", 0, 0), event: { type: "queued" }, expect: ok(pool("busy", 0, 1), send) },
  {
    state: pool("quiet", 0, 0),
    event: { type: "settled" },
    expect: no(pool("quiet", 0, 0), "no request is running"),
  },
  {
    case: "sent",
    state: pool("busy", 0, 1),
    event: { type: "queued" },
    expect: ok(pool("busy", 0, 2), send),
  },
  {
    case: "waits",
    label: "with every slot busy, a request waits",
    state: pool("busy", 0, 2),
    event: { type: "queued" },
    expect: ok(pool("full", 1, 2)),
  },
  { state: pool("busy", 0, 2), event: { type: "settled" }, expect: ok(pool("busy", 0, 1)) },
  { state: pool("full", 1, 2), event: { type: "queued" }, expect: ok(pool("full", 2, 2)) },
  {
    case: "sent",
    label: "a free slot sends the next waiting request",
    state: pool("full", 2, 2),
    event: { type: "settled" },
    expect: ok(pool("full", 1, 2), send),
  },
  {
    case: "sent-drained",
    state: pool("full", 1, 2),
    event: { type: "settled" },
    expect: ok(pool("busy", 0, 2), send),
  },
];

test("page-ref-pool: every state × event", async () => {
  await runTable(pageRefPoolMachine, poolRows);
  assert.equal(pageRefPoolMachine.initial.slots, PAGE_REF_CONCURRENCY);
});

test("answers are read only for the Page they name", () => {
  const id = "2b160b47-6df1-4983-81eb-489ca5a26812";
  const body = {
    v: 1,
    page_id: id,
    title: "Plan",
    state: "active",
    role: "viewer",
    content_updated_at: "2026-11-01T00:00:00.000Z",
  };
  assert.deepEqual(readMeta(body, id), {
    title: "Plan",
    state: "active",
    role: "viewer",
    content_updated_at: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(readMeta(body, "other"), null);
  assert.equal(readMeta({ ...body, v: 2 }, id), null);
  assert.equal(readMeta({ ...body, state: "deleted" }, id), null);
  assert.equal(readMeta({ ...body, title: 3 }, id), null);
  assert.equal(readCard({ v: 1, page_id: id, card: null }, id), null);
  assert.equal(readCard({ v: 1, page_id: id }, id), undefined);
  assert.equal(readCard({ v: 1, page_id: "other", card: null }, id), undefined);
  assert.deepEqual(readCard({ v: 1, page_id: id, card: { blocks: [] } }, id), { blocks: [] });
  assert.equal(readCard({ v: 1, page_id: id, card: { blocks: "x" } }, id), null);
  assert.equal(settledOf(idle), null);
  assert.equal(settledOf(requested(lastReadable)), lastReadable);
  assert.deepEqual(settledOf(readable()), readable());
  assert.equal(settledOf(failed(1, false)), null);
});

// ---------------------------------------------------------------------------
// The loader, on virtual time.

const A = "2b160b47-6df1-4983-81eb-489ca5a26812";
const B = "3c160b47-6df1-4983-81eb-489ca5a26812";
const meta = (id, title = "Plan") => ({
  v: 1,
  page_id: id,
  title,
  state: "active",
  role: "viewer",
  content_updated_at: null,
});

/** A loader whose requests wait until the test answers them. */
function loader({ concurrency } = {}) {
  // advance(ms) runs every action due by then and moves the scheduler's
  // clock there, even when nothing was due, so a timer armed afterwards
  // counts from the right time.
  const scheduler = new VirtualTimeScheduler();
  let now = 0;
  const calls = [];
  const get = (path, { signal }) =>
    new Promise((resolve, reject) => {
      const call = { path, signal, resolve, reject };
      calls.push(call);
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  const refs = new PageRefs({ get, scheduler, ...(concurrency && { concurrency }) });
  const advance = (ms) => {
    now += ms;
    scheduler.schedule(() => {}, now - scheduler.frame);
    scheduler.maxFrames = now;
    scheduler.flush();
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const error = (status, code) => Object.assign(Error(code ?? "error"), { status, code });
  return { refs, calls, advance, settle, error, scheduler };
}

test("concurrent asks share a request; an answer stays fresh for the TTL", async () => {
  const l = loader();
  l.refs.account("user:a");
  l.refs.want(A, ["meta"]);
  l.refs.want(A, ["meta"]);
  assert.deepEqual(
    l.calls.map((call) => call.path),
    [`/p/${A}/meta.json`],
  );
  l.calls[0].resolve(meta(A));
  await l.settle();
  assert.deepEqual(l.refs.ref(A, "meta"), {
    name: "readable",
    value: { title: "Plan", state: "active", role: "viewer", content_updated_at: null },
    stale: false,
  });
  l.advance(PAGE_REF_TTL_MS - 1);
  l.refs.want(A, ["meta"]);
  assert.equal(l.calls.length, 1, "fresh: nothing asked");
  l.advance(1);
  assert.equal(l.refs.ref(A, "meta").stale, true);
  l.refs.want(A, ["meta"]);
  assert.equal(l.calls.length, 2, "stale: asked again");
  // The old title shows while the new one loads.
  assert.equal(settledOf(l.refs.ref(A, "meta")).value.title, "Plan");
  l.calls[1].resolve(meta(A, "Renamed"));
  await l.settle();
  assert.equal(l.refs.ref(A, "meta").value.title, "Renamed");
});

test("an unavailable answer goes stale sooner than a readable one", async () => {
  assert.ok(PAGE_REF_UNAVAILABLE_TTL_MS < PAGE_REF_TTL_MS);
  assert.equal(PAGE_REF_UNAVAILABLE_TTL_MS, 15_000);
  const l = loader();
  l.refs.account("user:a");
  l.refs.want(A, ["meta"]);
  l.refs.want(B, ["meta"]);
  l.calls[0].resolve(meta(A));
  l.calls[1].reject(l.error(404, "page_unavailable"));
  await l.settle();
  l.advance(PAGE_REF_UNAVAILABLE_TTL_MS - 1);
  assert.equal(l.refs.ref(B, "meta").stale, false);
  l.advance(1);
  assert.equal(l.refs.ref(B, "meta").stale, true, "unavailable: stale at 15 s");
  assert.equal(l.refs.ref(A, "meta").stale, false, "readable: still fresh");
  l.refs.want(B, ["meta"]);
  assert.equal(l.calls.length, 3, "asked again: access may have been granted, or the host is back");
  l.advance(PAGE_REF_TTL_MS - PAGE_REF_UNAVAILABLE_TTL_MS);
  assert.equal(l.refs.ref(A, "meta").stale, true, "readable: stale at 60 s");
});

test("meta and card load in parallel; a 404 is unavailable; a failure backs off", async () => {
  const l = loader();
  l.refs.account("user:a");
  l.refs.want(A, ["meta", "card"]);
  assert.deepEqual(
    l.calls.map((call) => call.path),
    [`/p/${A}/meta.json`, `/p/${A}/card.json`],
  );
  l.calls[0].reject(l.error(404, "page_unavailable"));
  l.calls[1].reject(l.error(404, "page_unavailable"));
  await l.settle();
  assert.equal(l.refs.ref(A, "meta").name, "unavailable");
  assert.equal(l.refs.ref(A, "card").name, "unavailable");

  l.refs.want(B, ["meta"]);
  l.calls[2].reject(l.error(500, "internal"));
  await l.settle();
  assert.deepEqual(l.refs.ref(B, "meta"), {
    name: "failed",
    last: null,
    attempts: 1,
    ready: false,
  });
  l.refs.want(B, ["meta"]);
  assert.equal(l.calls.length, 3, "backing off: nothing asked");
  l.advance(PAGE_REF_BACKOFF_MS);
  assert.equal(l.refs.ref(B, "meta").ready, true);
  l.refs.want(B, ["meta"]);
  assert.equal(l.calls.length, 4);
  // A body for another Page is a failure, not an answer.
  l.calls[3].resolve(meta(A));
  await l.settle();
  assert.equal(l.refs.ref(B, "meta").attempts, 2);
  l.advance(PAGE_REF_BACKOFF_MS * 2 - 1);
  assert.equal(l.refs.ref(B, "meta").ready, false, "the second wait is twice as long");
  l.advance(1);
  assert.equal(l.refs.ref(B, "meta").ready, true);
  // Some other 404 (a proxy's, a missing route) is a failure too.
  l.refs.want(B, ["meta"]);
  l.calls[4].reject(l.error(404, "not_found"));
  await l.settle();
  assert.equal(l.refs.ref(B, "meta").name, "failed");
});

test("at most six requests run; an urgent ask goes before the queue", async () => {
  const l = loader();
  l.refs.account("user:a");
  const ids = Array.from(
    { length: 8 },
    (_, index) => `${index}b160b47-6df1-4983-81eb-489ca5a26812`,
  );
  for (const id of ids.slice(0, 7)) l.refs.want(id, ["meta"]);
  assert.equal(l.calls.length, PAGE_REF_CONCURRENCY);
  l.refs.want(ids[7], ["meta"], { urgent: true });
  assert.equal(l.calls.length, PAGE_REF_CONCURRENCY);
  l.calls[0].resolve(meta(ids[0]));
  await l.settle();
  assert.equal(l.calls[6].path, `/p/${ids[7]}/meta.json`, "the urgent ask went first");
  l.calls[1].resolve(meta(ids[1]));
  await l.settle();
  assert.equal(l.calls[7].path, `/p/${ids[6]}/meta.json`);
  assert.equal(l.calls.length, 8);
});

test("another account, sign-out or a 401 drops every ref and aborts what runs", async () => {
  const l = loader();
  l.refs.want(A, ["meta"]);
  assert.equal(l.calls.length, 0, "no account: nothing asked");
  l.refs.account("user:a");
  l.refs.want(A, ["meta"]);
  l.calls[0].resolve(meta(A));
  await l.settle();
  l.refs.want(B, ["meta"]);
  const running = l.calls[1];
  // Another account: nothing resolved for the first is kept, and its
  // request's answer is never read.
  l.refs.account("user:b");
  assert.equal(running.signal.aborted, true);
  assert.equal(l.refs.store.snapshot().refs.size, 0);
  assert.equal(l.refs.principal, "user:b");
  running.resolve(meta(B));
  await l.settle();
  assert.equal(l.refs.ref(B, "meta").name, "idle");
  // The TTL timers of the first account's refs are gone.
  assert.equal(l.scheduler.actions.length, 0);
  // The same account again changes nothing.
  l.refs.want(A, ["meta"]);
  l.refs.account("user:b");
  assert.equal(l.refs.ref(A, "meta").name, "requested");
  // A 401 clears everything, keeping the account until the session check.
  l.refs.want(B, ["meta"]);
  l.calls[2].reject(l.error(401, "auth_required"));
  await l.settle();
  assert.equal(l.calls[3].signal.aborted, true);
  assert.equal(l.refs.store.snapshot().refs.size, 0);
  // Sign-out.
  l.refs.want(A, ["meta"]);
  l.refs.account(null);
  assert.equal(l.refs.store.snapshot().refs.size, 0);
  l.refs.want(A, ["meta"]);
  assert.equal(l.refs.ref(A, "meta").name, "idle");
});

test("pool slots come back after a clear", async () => {
  const l = loader({ concurrency: 1 });
  l.refs.account("user:a");
  l.refs.want(A, ["meta"]);
  l.refs.want(B, ["meta"]);
  assert.equal(l.calls.length, 1);
  l.refs.clear();
  l.refs.want(B, ["meta"]);
  assert.equal(l.calls.length, 2, "the aborted request's slot is free");
  l.calls[1].resolve(meta(B));
  await l.settle();
  assert.equal(l.refs.ref(B, "meta").name, "readable");
});
