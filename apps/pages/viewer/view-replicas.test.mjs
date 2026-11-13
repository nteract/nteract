// The Page's keyed view replicas: a replica opens while something holds its
// view and closes VIEW_CLOSE_DELAY_MS after the last holder lets go, each
// looks its document up by the derived id on each admitted connection, at
// most MAX_VIEWS are open, a view that isn't on the Page rests as missing,
// and retirement stops every one. The holder machine's table is
// view-hold-machine.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { MISSING_ATTEMPTS, lookAgainDelay, retryDelay } from "./host-doc-open-machine.mjs";
import { MAX_VIEWS, VIEW_CLOSE_DELAY_MS, ViewReplicas } from "./view-replicas.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const PAGE = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

function fixture({ linked = true } = {}) {
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
        calls.push({ id, signal, resolve, reject });
        signal?.addEventListener("abort", () => reject(signal.reason ?? Error("aborted")));
      }),
    forget: async () => {},
    link: () => (connected ? 1 : undefined),
    linked: () => connected,
    scheduler,
    closeDelay: VIEW_CLOSE_DELAY_MS,
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
    connect() {
      connected = true;
      views.connected();
    },
  };
}

const handle = (doc) => ({ doc: () => doc, on() {}, off() {} });
const missing = (id) => Error(`Document ${id} is unavailable`);
const latest = (held) => {
  let value;
  held.view$.subscribe((view) => (value = view)).unsubscribe();
  return value;
};

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

test("at most MAX_VIEWS views open; 1,000 view nodes cost ten lookups and nothing more", async () => {
  const f = fixture();
  const holds = Array.from({ length: 1_000 }, (_, i) => f.views.hold(`view-${i}`));
  await tick();
  assert.equal(f.views.open.length, MAX_VIEWS);
  assert.equal(f.derivations.length, MAX_VIEWS, "only admitted views derive an id");
  assert.equal(f.calls.length, MAX_VIEWS, "only admitted views look anything up");
  // Every view misses; the admitted ones rest after their bursts.
  for (let round = 1; round <= MISSING_ATTEMPTS; round++) {
    for (const call of f.calls.slice(-MAX_VIEWS)) call.reject(missing(call.id));
    await tick();
    f.advance(retryDelay(round));
    await tick();
  }
  assert.equal(f.calls.length, MAX_VIEWS * MISSING_ATTEMPTS);
  // Timers: one look-again window per admitted view, none for the rest.
  assert.equal(f.scheduler.actions.length, MAX_VIEWS);
  f.advance(10 * lookAgainDelay(3));
  await tick();
  assert.equal(f.calls.length, MAX_VIEWS * MISSING_ATTEMPTS, "nothing polls");
  assert.equal(f.scheduler.actions.length, 0);
  const over = latest(holds[MAX_VIEWS]);
  assert.deepEqual(over, {
    status: "unavailable",
    reason: "limit",
    sentence: "A Page shows at most 10 charts.",
  });
  for (const hold of holds) hold.release();
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

test("a view that isn't on this Page rests as missing until something asks again", async () => {
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
  f.advance(600_000);
  await tick();
  assert.equal(f.calls.length, MISSING_ATTEMPTS, "nothing polls");
  held.want();
  await tick();
  assert.equal(f.calls.length, MISSING_ATTEMPTS + 1, "an ask after the window looks again");
  held.release();
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
  held.want();
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
