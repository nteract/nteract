// The Page's keyed view replicas: a replica opens while something holds its
// view and closes after the last holder lets go, each looks its document up
// by the derived id on each admitted connection, a view that isn't on the
// Page rests as missing, and retirement stops every one.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { LOOK_AGAIN_MS, MISSING_ATTEMPTS, retryDelay } from "./host-doc-open-machine.mjs";
import { ViewReplicas } from "./view-replicas.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const PAGE = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

function fixture({ linked = true } = {}) {
  const scheduler = new VirtualTimeScheduler();
  const calls = [];
  const forgotten = [];
  let connected = linked;
  const views = new ViewReplicas({
    pageId: PAGE,
    viewDocumentId: async (pageId, viewId) => `${pageId}/${viewId}`,
    find: (id, { signal } = {}) =>
      new Promise((resolve, reject) => {
        calls.push({ id, signal, resolve, reject });
        signal?.addEventListener("abort", () => reject(signal.reason ?? Error("aborted")));
      }),
    forget: async (id) => forgotten.push(id),
    link: () => (connected ? 1 : undefined),
    linked: () => connected,
    scheduler,
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
    forgotten,
    advance,
    connect() {
      connected = true;
      views.connected();
    },
  };
}

const handle = (doc) => ({ doc: () => doc, on() {}, off() {} });
const missing = (id) => Error(`Document ${id} is unavailable`);

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
  f.advance(0);
  assert.deepEqual(f.views.open, ["sales"], "one embed still holds it");
  b.release();
  b.release();
  f.advance(0);
  assert.deepEqual(f.views.open, [], "the last release closes it");
  assert.equal(f.calls[0].signal.aborted, true, "its lookup stops");
});

test("an embed redrawn in place keeps its replica and document", async () => {
  const f = fixture();
  const first = f.views.hold("sales");
  await tick();
  f.calls[0].resolve(handle({ title: "x" }));
  await tick();
  const replica = f.views.replica("sales");
  first.release();
  const second = f.views.hold("sales");
  f.advance(0);
  assert.equal(f.views.replica("sales"), replica);
  assert.equal(replica.state$.snapshot().name, "ready");
  assert.equal(f.calls.length, 1);
  second.release();
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
  f.advance(10 * LOOK_AGAIN_MS);
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
  const seen = [];
  held.view$.subscribe((view) => seen.push(view));
  await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(seen.at(-1).reason, "missing");
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
  f.advance(0);
  const again = f.views.hold("sales");
  const seen = [];
  again.view$.subscribe((view) => seen.push(view));
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(seen.at(-1).reason, "closed");
});

test("closing the Page's replica closes held views; the next connection reopens them", async () => {
  const f = fixture();
  const held = f.views.hold("sales");
  await tick();
  f.views.close();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.views.replica("sales").state$.snapshot().name, "closed");
  f.views.connected();
  await tick();
  assert.equal(f.calls.length, 2);
  held.release();
});
