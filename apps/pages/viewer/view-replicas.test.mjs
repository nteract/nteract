// The Page's keyed view replicas: a replica opens while something holds its
// view and closes VIEW_CLOSE_DELAY_MS after the last holder lets go, each
// looks its document up by the derived id on each admitted connection, a
// held view keeps asking once per look-again window, at most MAX_VIEWS have
// a slot, a view whose document is missing gives its slot to one that waits,
// and retirement stops every one. The holder machine's table is
// view-hold-machine.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import {
  LOOK_AGAIN_MS,
  MISSING_ATTEMPTS,
  lookAgainDelay,
  retryDelay,
} from "./host-doc-open-machine.mjs";
import { MAX_VIEWS, VIEW_CLOSE_DELAY_MS, ViewReplicas } from "./view-replicas.mjs";
import { VIEW_MEDIA_TYPE } from "./view-store.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const PAGE = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

function fixture({ linked = true, stored = false, limit } = {}) {
  const scheduler = new VirtualTimeScheduler();
  const calls = [];
  const derivations = [];
  let connected = linked;
  const views = new ViewReplicas({
    pageId: PAGE,
    viewDocumentId: async (pageId, viewId) => {
      derivations.push(viewId);
      return `${pageId}/${viewId}`;
    },
    find: (id, { signal } = {}) =>
      new Promise((resolve, reject) => {
        const call = { id, signal, settled: false };
        call.resolve = (value) => ((call.settled = true), resolve(value));
        call.reject = (error) => ((call.settled = true), reject(error));
        calls.push(call);
        signal?.addEventListener("abort", () => call.reject(signal.reason ?? Error("aborted")));
      }),
    forget: async () => {},
    link: () => (connected ? 1 : undefined),
    linked: () => connected,
    stored: () => stored,
    scheduler,
    closeDelay: VIEW_CLOSE_DELAY_MS,
    ...(limit && { limit }),
  });
  const advance = (ms) => {
    const target = scheduler.frame + ms;
    scheduler.maxFrames = target;
    scheduler.flush();
    scheduler.frame = target;
    scheduler.maxFrames = Infinity;
  };
  return {
    views,
    calls,
    derivations,
    scheduler,
    advance,
    /** Lookups still running. */
    pending: () => calls.filter((call) => !call.settled),
    connect() {
      connected = true;
      views.connected();
    },
  };
}

const handle = (doc) => ({ doc: () => doc, on() {}, off() {} });
const missing = (id) => Error(`Document ${id} is unavailable`);
const viewDoc = (title) => ({
  title,
  media_type: VIEW_MEDIA_TYPE,
  spec: JSON.stringify({ mark: "bar" }),
  data: {},
  revision: "1",
  producer: { kind: "edit_page", at: "2026-11-12T00:00:00.000Z", by: { principal: "agent" } },
});
const latest = (held) => {
  let value;
  held.view$.subscribe((view) => (value = view)).unsubscribe();
  return value;
};

/** Answer every running lookup as a host holding the views in `existing`
 * would, then let the retries and admissions that follow run. */
async function serve(f, existing, ms = 1_000) {
  for (const call of f.pending()) {
    const viewId = call.id.slice(PAGE.length + 1);
    if (existing.has(viewId)) call.resolve(handle(viewDoc(viewId)));
    else call.reject(missing(call.id));
  }
  await tick();
  f.advance(ms);
  await tick();
}

test("a held view opens one replica, looked up by its derived id", async () => {
  const f = fixture();
  const a = f.views.hold("sales");
  const b = f.views.hold("sales");
  await tick();
  assert.deepEqual(f.views.open, ["sales"]);
  assert.deepEqual(
    f.calls.map((call) => call.id),
    [`${PAGE}/sales`],
    "two embeds of one view share one lookup",
  );
  a.release();
  f.advance(VIEW_CLOSE_DELAY_MS);
  assert.deepEqual(f.views.open, ["sales"], "one embed still holds it");
  b.release();
  b.release();
  f.advance(VIEW_CLOSE_DELAY_MS);
  assert.deepEqual(f.views.open, [], "the last release closes it after the delay");
  assert.equal(f.calls[0].signal.aborted, true, "its lookup stops");
});

test("a view held again within the close delay keeps its replica; after it, a new one opens", async () => {
  const f = fixture();
  const first = f.views.hold("sales");
  await tick();
  f.calls[0].resolve(handle({ title: "x" }));
  await tick();
  const replica = f.views.replica("sales");
  first.release();
  f.advance(1_900);
  const second = f.views.hold("sales");
  f.advance(10_000);
  assert.equal(f.views.replica("sales"), replica, "re-held at 1.9 s: the same replica");
  assert.equal(replica.state$.snapshot().name, "ready");
  assert.equal(f.calls.length, 1);

  second.release();
  f.advance(2_100);
  assert.equal(replica.state$.snapshot().name, "closed", "released for 2.1 s: closed");
  const third = f.views.hold("sales");
  await tick();
  assert.notEqual(f.views.replica("sales"), replica, "a new replica opens");
  assert.equal(f.calls.length, 2);
  third.release();
});

test("1,000 held view nodes keep at most MAX_VIEWS lookups in flight, and each is looked up", async () => {
  const f = fixture();
  const holds = Array.from({ length: 1_000 }, (_, i) => f.views.hold(`view-${i}`));
  await tick();
  assert.equal(f.views.open.length, MAX_VIEWS);
  assert.equal(f.derivations.length, MAX_VIEWS, "only views with a slot derive an id");
  assert.equal(f.calls.length, MAX_VIEWS, "only views with a slot look anything up");
  assert.deepEqual(latest(holds[MAX_VIEWS]), {
    status: "unavailable",
    reason: "limit",
    sentence: "A Page shows at most 10 charts.",
  });
  // Every document is missing. Each view takes its turn; the cap bounds the
  // work in flight, not which views are looked up.
  let peak = 0;
  for (let round = 0; f.views.waiting.some((id) => !f.derivations.includes(id)); round++) {
    assert.ok(round < 1_000, "every view gets a slot");
    peak = Math.max(peak, f.pending().length);
    assert.ok(f.views.open.length <= MAX_VIEWS);
    assert.ok(f.scheduler.actions.length <= 2 * MAX_VIEWS, "a timer and a deadline per slot");
    await serve(f, new Set());
  }
  assert.equal(peak, MAX_VIEWS);
  assert.equal(new Set(f.derivations).size, 1_000, "every view was looked up");
  assert.equal(
    latest(holds[MAX_VIEWS]).reason,
    "missing",
    "a view that had its turn reads missing",
  );
  for (const hold of holds) hold.release();
  f.advance(VIEW_CLOSE_DELAY_MS);
  await tick();
  assert.deepEqual([f.views.open, f.views.waiting, f.pending().length], [[], [], 0]);
});

test("a fresh view takes the slot of a view whose document is missing as soon as it settles", async () => {
  const f = fixture();
  const gone = Array.from({ length: MAX_VIEWS }, (_, i) => f.views.hold(`gone-${i}`));
  await tick();
  const real = f.views.hold("sales");
  await tick();
  assert.equal(latest(real).reason, "limit", "every slot is looking up a view");
  // The missing views' first bursts run out; the first to settle gives way.
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++)
    await serve(f, new Set(["sales"]), retryDelay(attempt));
  await serve(f, new Set(["sales"]));
  assert.ok(f.views.open.includes("sales"), "admitted without a reload");
  assert.equal(f.views.replica("sales").state$.snapshot().name, "ready");
  assert.equal(latest(real).status, "ready");
  assert.equal(f.views.waiting.length, 1, "the view that gave way waits");
  assert.equal(latest(gone.find((held) => latest(held).reason === "missing")).reason, "missing");
  for (const held of [...gone, real]) held.release();
});

test("a Page naming many missing ids draws every existing view near the viewport", async () => {
  // The host holds at most MAX_VIEWS views per Page. However many missing
  // ids the body also names, and in whatever order embeds come near the
  // viewport and stay mounted, every existing view draws.
  const f = fixture();
  const existing = new Set(Array.from({ length: MAX_VIEWS }, (_, i) => `real-${i}`));
  const names = [];
  for (let i = 0; i < 40; i++) {
    names.push(`gone-${i}`);
    if (i % 4 === 3) names.push(`real-${(i - 3) / 4}`);
  }
  const holds = [];
  for (const name of names) {
    holds.push([name, f.views.hold(name)]);
    await serve(f, existing);
  }
  for (let round = 0; round < 40; round++) await serve(f, existing, 2_000);
  for (const name of existing) {
    assert.ok(f.views.open.includes(name), `${name} has a slot`);
    assert.equal(f.views.replica(name).state$.snapshot().name, "ready", `${name} is open`);
  }
  for (const [name, held] of holds)
    assert.equal(latest(held).status, existing.has(name) ? "ready" : "unavailable", name);
  for (const [, held] of holds) held.release();
});

test("missing views take turns, so one the host makes later is found while it waits", async () => {
  const f = fixture();
  const ids = Array.from({ length: MAX_VIEWS + 2 }, (_, i) => `gone-${i}`);
  const holds = ids.map((id) => f.views.hold(id));
  for (let round = 0; round < 10; round++) await serve(f, new Set(), 2_000);
  assert.equal(new Set(f.derivations).size, ids.length, "every view had a first turn");
  const late = ids.find((id) => f.views.waiting.includes(id));
  assert.ok(late, "a view whose turn passed waits");
  const existing = new Set([late]);
  for (let round = 0; round < 40 && !f.views.open.includes(late); round++)
    await serve(f, existing, 10_000);
  await serve(f, existing);
  assert.equal(latest(holds[ids.indexOf(late)]).status, "ready", "found on its next turn");
  for (const held of holds) held.release();
});

test("taking turns keeps each view's misses: many missing ids cost about one lookup per slot per window", async () => {
  const f = fixture();
  const ids = Array.from({ length: 50 }, (_, i) => `gone-${i}`);
  const holds = ids.map((id) => f.views.hold(id));
  const minute = 60_000;
  const step = 1_000;
  const perMinute = [];
  const lookedUp = new Set();
  for (let at = 0; at < 30 * minute; at += step) {
    const before = f.calls.length;
    await serve(f, new Set(), step);
    if (at >= 15 * minute) for (const call of f.calls.slice(before)) lookedUp.add(call.id);
    if (at % minute === minute - step) perMinute.push(f.calls.length);
  }
  const counts = perMinute.map((total, index) => total - (perMinute[index - 1] ?? 0));
  // The first minutes give each id its one burst; after that, about one
  // lookup per slot per 60 s window (ten a minute), however long it runs.
  const steady = counts.slice(15);
  assert.ok(
    steady.every((count) => count <= MAX_VIEWS),
    `steady lookups per minute: ${steady.join(", ")}`,
  );
  assert.equal(lookedUp.size, ids.length, "every id is still looked up in turn");
  assert.ok(f.pending().length <= MAX_VIEWS);
  for (const held of holds) held.release();
});

test("ten views whose lookups failed give their slots to an existing view, and recover", async () => {
  const f = fixture();
  const gone = Array.from({ length: MAX_VIEWS }, (_, i) => f.views.hold(`gone-${i}`));
  await tick();
  // An outage: every lookup fails until the lookups give up.
  for (let round = 0; round < 20; round++) {
    for (const call of f.pending()) call.reject(Error("network"));
    await tick();
    f.advance(5_000);
    await tick();
  }
  assert.ok(gone.every((_, i) => f.views.replica(`gone-${i}`).state$.snapshot().name === "failed"));
  const real = f.views.hold("sales");
  await tick();
  assert.ok(f.views.open.includes("sales"), "a failed view gives its slot up");
  assert.equal(latest(gone.find((held) => latest(held).reason === "failed")).reason, "failed");
  // The connection recovers: views with a slot look again, and the existing
  // view draws.
  f.connect();
  await tick();
  await serve(f, new Set(["sales"]));
  assert.equal(latest(real).status, "ready");
  // The view that gave its slot up is looked up again when it next has one.
  const [parked] = f.views.waiting;
  const asked = () => f.calls.filter((call) => call.id === `${PAGE}/${parked}`).length;
  const before = asked();
  real.release();
  f.advance(VIEW_CLOSE_DELAY_MS);
  await tick();
  assert.equal(f.views.waiting.length, 0);
  assert.equal(asked(), before + 1, `${parked} looks again`);
  for (const held of gone) held.release();
});

test("an embed replaced within the close delay frees its slot for the one that replaces it", async () => {
  const f = fixture();
  const holds = Array.from({ length: MAX_VIEWS }, (_, i) => f.views.hold(`view-${i}`));
  await tick();
  await serve(f, new Set(Array.from({ length: MAX_VIEWS }, (_, i) => `view-${i}`)));
  // The last embed is removed; a different view's embed takes its place
  // before the close delay ends.
  holds.pop().release();
  const replacement = f.views.hold("sales");
  await tick();
  assert.ok(f.views.open.includes("sales"), "the view in its close delay gave its slot up");
  assert.ok(!f.views.open.includes(`view-${MAX_VIEWS - 1}`));
  await serve(f, new Set(["sales"]));
  assert.equal(latest(replacement).status, "ready");
  for (const held of [...holds, replacement]) held.release();
});

test("a mounted view whose document is missing asks once per window until the host makes it", async () => {
  const f = fixture();
  const held = f.views.hold("elsewhere");
  const seen = [];
  held.view$.subscribe((view) => seen.push(view));
  await tick();
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) {
    f.calls.at(-1).reject(missing(`${PAGE}/elsewhere`));
    await tick();
    f.advance(retryDelay(attempt));
    await tick();
  }
  assert.equal(f.calls.length, MISSING_ATTEMPTS);
  assert.deepEqual(
    seen.map((view) => view.status),
    ["pending", "unavailable"],
    "no flash of missing while it retries",
  );
  assert.equal(seen.at(-1).sentence, "This chart isn't on this Page.");
  // Held, the view is standing demand: one lookup at the end of each window.
  for (const [index, window] of [...LOOK_AGAIN_MS, 60_000].entries()) {
    f.advance(window);
    await tick();
    assert.equal(f.calls.length, MISSING_ATTEMPTS + index + 1, `window ${index + 1}`);
    if (index < LOOK_AGAIN_MS.length) {
      f.calls.at(-1).reject(missing(`${PAGE}/elsewhere`));
      await tick();
    }
  }
  // The host made the view: the running lookup finds it.
  f.calls.at(-1).resolve(handle(viewDoc("Elsewhere")));
  await tick();
  assert.equal(seen.at(-1).status, "ready");
  held.release();
});

test("a view nothing holds stops asking", async () => {
  const f = fixture();
  const held = f.views.hold("elsewhere");
  await tick();
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) {
    f.calls.at(-1).reject(missing(`${PAGE}/elsewhere`));
    await tick();
    f.advance(retryDelay(attempt));
    await tick();
  }
  held.release();
  f.advance(10 * lookAgainDelay(3));
  await tick();
  assert.equal(f.calls.length, MISSING_ATTEMPTS);
  assert.equal(f.scheduler.actions.length, 0);
});

test("an id the contract doesn't allow opens nothing and reads as missing", async () => {
  const f = fixture();
  const held = f.views.hold("Not A View");
  await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(latest(held).reason, "missing");
});

test("retirement stops every view, a late lookup never installs, and nothing opens after", async () => {
  const f = fixture();
  const held = f.views.hold("sales");
  await tick();
  f.views.retire();
  f.calls[0].resolve(handle({ title: "late" }));
  await tick();
  const replica = f.views.replica("sales");
  assert.equal(replica.state$.snapshot().name, "retired");
  assert.equal(replica.doc, undefined);
  f.views.connected();
  f.advance(10 * lookAgainDelay(3));
  await tick();
  assert.equal(f.calls.length, 1);
  held.release();
  f.advance(VIEW_CLOSE_DELAY_MS);
  const again = f.views.hold("sales");
  const other = f.views.hold("costs");
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(latest(again).reason, "closed");
  assert.equal(latest(other).reason, "closed");
  assert.equal(f.derivations.length, 1, "a view named after retirement derives nothing");
});

test("closing the Page's replica closes held views; the next connection reopens them", async () => {
  const f = fixture();
  const held = f.views.hold("sales");
  const parked = f.views.hold("costs");
  await tick();
  parked.release();
  f.views.close();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.views.replica("sales").state$.snapshot().name, "closed");
  assert.equal(f.views.replica("costs"), undefined, "a closing view goes at once");
  f.views.connected();
  await tick();
  assert.equal(f.calls.length, 3);
  held.release();
});

test("a view held before a connection waits for one, and every view looks up on it", async () => {
  const f = fixture({ linked: false });
  const holds = Array.from({ length: 10 }, (_, i) => f.views.hold(`view-${i}`));
  await tick();
  assert.equal(f.calls.length, 0);
  f.connect();
  await tick();
  assert.equal(f.calls.length, 10, "ten embeds, ten lookups on the one connection");
  for (const call of f.calls) call.resolve(handle({}));
  await tick();
  // A reconnect keeps every open document.
  f.views.connected();
  await tick();
  assert.equal(f.calls.length, 10);
  for (const hold of holds) hold.release();
});

test("before a connection, a held view this tab stored draws, and one it didn't waits", async () => {
  const f = fixture({ linked: false, stored: true });
  const sales = f.views.hold("sales");
  const costs = f.views.hold("costs");
  await tick();
  assert.deepEqual(
    f.calls.map((call) => call.id),
    [`${PAGE}/sales`, `${PAGE}/costs`],
    "each held view reads this tab's copy once",
  );
  assert.equal(f.views.replica("sales").state$.snapshot().via, "stored");
  // This tab stored the sales view, not the costs one.
  await serve(f, new Set(["sales"]));
  assert.equal(latest(sales).status, "ready");
  assert.equal(latest(sales).view.title, "sales");
  assert.deepEqual(latest(costs), { status: "pending" }, "a stored miss is not a verdict");
  assert.deepEqual(f.views.replica("costs").state$.snapshot(), { name: "closed", checked: true });
  f.advance(600_000);
  await tick();
  assert.equal(f.calls.length, 2, "standing demand doesn't read the store again");
  // The connection keeps the open view and looks the other up on it.
  f.connect();
  await tick();
  assert.deepEqual(
    f.calls.slice(2).map((call) => call.id),
    [`${PAGE}/costs`],
  );
  await serve(f, new Set(["costs"]));
  assert.equal(latest(costs).status, "ready");
  assert.equal(latest(sales).status, "ready");
  sales.release();
  costs.release();
});

test("a stored miss keeps its slot and counts as no look; the connection decides", async () => {
  const f = fixture({ linked: false, stored: true, limit: 1 });
  const first = f.views.hold("first");
  await tick();
  await serve(f, new Set());
  assert.deepEqual(f.views.replica("first").state$.snapshot(), { name: "closed", checked: true });
  // A view named while the slot is taken waits: the stored miss doesn't give
  // the slot up.
  const second = f.views.hold("second");
  await tick();
  assert.deepEqual(f.views.open, ["first"]);
  assert.deepEqual(f.views.waiting, ["second"]);
  assert.deepEqual(latest(first), { status: "pending" });
  assert.equal(latest(second).reason, "limit");
  // On the connection the first view is looked up; once the host answers it
  // holds none, the slot goes to the view that waited.
  f.connect();
  await tick();
  assert.equal(f.calls.at(-1).id, `${PAGE}/first`);
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++)
    await serve(f, new Set(["second"]), retryDelay(attempt));
  await tick();
  assert.deepEqual(f.views.open, ["second"]);
  await serve(f, new Set(["second"]));
  assert.equal(latest(second).status, "ready");
  first.release();
  second.release();
});
