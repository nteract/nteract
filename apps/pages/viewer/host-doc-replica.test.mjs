// The host-document replica's interpreter: discovery answers, lookups by a
// derived id when something asks, lookups with a timeout, retries and the
// look-again window on virtual time, an older host's answer, retirement, and
// that the open document's changes reach `doc$`. Over a real host it syncs
// the document, never sends a change for it, and finds a document the host
// created after an earlier lookup missed, on the same connection.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Repo, interpretAsDocumentId } from "@automerge/automerge-repo";
import { VirtualTimeScheduler, asyncScheduler } from "rxjs";
import { AutomergeSyncBackend } from "../sync/backend.mjs";
import { DocStore, MemoryByteStore } from "../sync/doc-store.mjs";
import { PlainHostStorage } from "../sync/plain-host-fixture.mjs";
import { until } from "../sync/test-helpers.mjs";
import { decodeFrame, encodeFrame, framePipe } from "../sync/wire.mjs";
import { PAGE_FAMILY_MODULES } from "../worker/document-modules.mjs";
import { PlainSync, treeOf } from "../worker/plain-sync.mjs";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { readableFormats } from "../model/document-types.mjs";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { MISSING_ATTEMPTS, lookAgainDelay, retryDelay } from "./host-doc-open-machine.mjs";
import {
  LOOKUP_TIMEOUT_MS,
  HostDocReplica,
  UNAVAILABLE,
  evictUnavailable,
  monotonicClock,
} from "./host-doc-replica.mjs";
import { monotonicNow } from "./monotonic.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const ID = "sources-1";
const named = (id = ID) => ({ documents: { sources: { id, type: "pages.sources", format: 1 } } });
const none = { documents: { page: { id: "p", type: "pages.page", format: 3 } } };

/** A repo whose `find` calls are held until the test settles them. With
 * `ignoreAbort`, an aborted find still settles however the test settles it,
 * as a find whose answer was already on its way does. */
function heldFind({ ignoreAbort = false } = {}) {
  const calls = [];
  const find = (id, { signal } = {}) =>
    new Promise((resolve, reject) => {
      calls.push({ id, signal, resolve, reject });
      if (!ignoreAbort)
        signal?.addEventListener("abort", () => reject(signal.reason ?? Error("aborted")));
    });
  return { calls, find };
}

/** A handle on `doc` whose value the test can move, as a remote change. */
function handleOf(doc) {
  let current = doc;
  const listeners = new Set();
  return {
    doc: () => current,
    on: (type, fn) => type === "change" && listeners.add(fn),
    off: (type, fn) => listeners.delete(fn),
    land(next) {
      current = next;
      for (const fn of listeners) fn({});
    },
    listeners,
  };
}

function replica({ link = () => 1, linked, stored, derive, ignoreAbort, clock } = {}) {
  const scheduler = new VirtualTimeScheduler();
  // The wall clock: the scheduler's own now(), which a test can set back.
  let shift = 0;
  scheduler.now = () => scheduler.frame + shift;
  const repo = heldFind({ ignoreAbort });
  const forgotten = [];
  const derivations = [];
  const sources = new HostDocReplica({
    find: repo.find,
    forget: async (id) => forgotten.push(id),
    link,
    ...(linked && { linked }),
    ...(stored && { stored }),
    ...(clock && { clock: clock(scheduler) }),
    scheduler,
    ...(derive !== null && {
      derive: async () => {
        derivations.push(1);
        return derive ? derive() : DERIVED;
      },
    }),
  });
  const docs = [];
  sources.doc$.subscribe((doc) => docs.push(doc));
  /** Run virtual time forward by `ms`. */
  // The virtual clock moves only as far as the actions it runs; set it to
  // the target after each flush, so timers armed later count from there.
  const advance = (ms) => {
    const target = scheduler.frame + ms;
    scheduler.maxFrames = target;
    scheduler.flush();
    scheduler.frame = target;
    scheduler.maxFrames = Infinity;
  };
  return {
    sources,
    repo,
    scheduler,
    docs,
    advance,
    forgotten,
    derivations,
    state: () => sources.state$.snapshot(),
    /** Set the wall clock back `ms` without advancing any timer. */
    setWallBack: (ms) => (shift -= ms),
  };
}

const DERIVED = "derived-1";
const missing = (id = DERIVED) => Error(`Document ${id} is unavailable`);

const sourcesDoc = (sources = {}) => A.from({ sources });

test("a Page with no sources document looks nothing up and publishes nothing", async () => {
  const r = replica();
  r.sources.discovered(none);
  await tick();
  assert.deepEqual(r.state(), { name: "absent" });
  assert.equal(r.repo.calls.length, 0);
  assert.deepEqual(r.docs, [undefined]);
  assert.equal(r.sources.doc, undefined);
});

test("a Page with no sources document and nothing asking derives nothing", async () => {
  const r = replica();
  r.sources.discovered(none);
  r.advance(600_000);
  await tick();
  assert.equal(r.derivations.length, 0);
  assert.equal(r.repo.calls.length, 0);
});

test("an ask on an absent document looks it up by its derived id on this connection", async () => {
  const r = replica();
  r.sources.discovered(none);
  r.sources.want();
  await tick();
  assert.deepEqual(r.state(), { name: "opening", attempt: 1, id: DERIVED, via: "derived" });
  assert.equal(r.repo.calls[0].id, DERIVED);
  // Asking again while it looks derives nothing more.
  r.sources.want();
  await tick();
  assert.equal(r.repo.calls.length, 1);
  const handle = handleOf(sourcesDoc({ usage: {} }));
  r.repo.calls[0].resolve(handle);
  await tick();
  assert.deepEqual(r.state(), { name: "ready", id: DERIVED });
  assert.equal(r.sources.doc, handle.doc());
  // An open document answers an ask without deriving or looking anything up.
  const derived = r.derivations.length;
  r.sources.want();
  await tick();
  assert.equal(r.derivations.length, derived);
  assert.equal(r.repo.calls.length, 1);
});

test("a derived miss is forgotten just before the next lookup, and the replica rests", async () => {
  const r = replica();
  r.sources.discovered(none);
  r.sources.want();
  await tick();
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) {
    r.repo.calls[attempt - 1].reject(missing());
    await tick();
    assert.equal(r.forgotten.length, attempt - 1, "nothing is evicted at the miss");
    if (attempt === MISSING_ATTEMPTS) break;
    r.advance(retryDelay(attempt) - 1);
    await tick();
    assert.equal(r.repo.calls.length, attempt, "no lookup before the delay");
    r.advance(1);
    await tick();
    assert.equal(r.forgotten.length, attempt, "the retry evicts the miss first");
    assert.equal(r.repo.calls.length, attempt + 1);
  }
  assert.deepEqual(r.state(), { name: "absent", id: DERIVED, misses: 1, cooling: true });
  // Nobody asks: the window passes and nothing runs.
  r.advance(lookAgainDelay(1));
  await tick();
  assert.deepEqual(r.state(), { name: "absent", id: DERIVED, misses: 1 });
  r.advance(600_000);
  await tick();
  assert.equal(r.repo.calls.length, MISSING_ATTEMPTS);
  // A later ask runs one lookup at once, evicting the last miss first.
  r.sources.want();
  await tick();
  assert.equal(r.repo.calls.length, MISSING_ATTEMPTS + 1);
  assert.equal(r.forgotten.length, MISSING_ATTEMPTS);
});

test("standing demand looks a document that never appears up at fixed times, and stops with it", async () => {
  const r = replica();
  const times = [];
  const seen = new Set();
  r.sources.discovered(none);
  const stop = r.sources.demand();
  await tick();
  const run = async (deadline) => {
    while (r.scheduler.frame <= deadline) {
      for (const call of r.repo.calls) {
        if (seen.has(call)) continue;
        seen.add(call);
        times.push(r.scheduler.frame);
        call.reject(missing());
      }
      await tick();
      r.advance(500);
      await tick();
    }
  };
  await run(200_000);
  assert.deepEqual(times, [0, 1_000, 3_000, 13_000, 43_000, 103_000, 163_000]);
  stop();
  stop();
  await run(600_000);
  assert.equal(times.length, 7, "nothing asks once the demand stops");
});

test("a close and a new connection keep the misses and what is left of the window", async () => {
  const r = replica();
  r.sources.discovered(none);
  const stop = r.sources.demand();
  await tick();
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) {
    r.repo.calls.at(-1).reject(missing());
    await tick();
    if (attempt < MISSING_ATTEMPTS) r.advance(retryDelay(attempt));
    await tick();
  }
  const rested = r.repo.calls.length;
  assert.deepEqual(r.state(), { name: "absent", id: DERIVED, misses: 1, cooling: true });
  r.advance(4_000);
  r.sources.close();
  assert.deepEqual(r.state(), { name: "closed", id: DERIVED, misses: 1 });
  r.advance(1_000);
  r.sources.connected();
  await tick();
  assert.deepEqual(r.state(), { name: "absent", id: DERIVED, misses: 1, cooling: true });
  assert.equal(r.repo.calls.length, rested, "no new burst");
  r.advance(lookAgainDelay(1) - 5_000 - 1);
  await tick();
  assert.equal(r.repo.calls.length, rested, "the window's last 5 s pass first");
  r.advance(1);
  await tick();
  assert.equal(r.repo.calls.length, rested + 1, "then one lookup");
  r.repo.calls.at(-1).reject(missing());
  await tick();
  assert.deepEqual(r.state(), { name: "absent", id: DERIVED, misses: 2, cooling: true });
  stop();
});

/** Rest `r` after its first burst, with standing demand; returns the
 * lookup count at the rest. */
async function restAfterBurst(r) {
  r.sources.discovered(none);
  const stop = r.sources.demand();
  await tick();
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) {
    r.repo.calls.at(-1).reject(missing());
    await tick();
    if (attempt < MISSING_ATTEMPTS) r.advance(retryDelay(attempt));
    await tick();
  }
  return { rested: r.repo.calls.length, stop };
}

test("setting the wall clock back an hour doesn't stretch the rest", async () => {
  // Deadlines read a monotonic clock (here the virtual frame, as
  // performance.now() is in a browser); the scheduler's now() is the wall
  // clock, which moves back an hour with no timer advancing.
  const r = replica({ clock: (scheduler) => () => scheduler.frame });
  const { rested, stop } = await restAfterBurst(r);
  r.advance(2_000);
  r.setWallBack(3_600_000);
  r.sources.close();
  r.sources.connected();
  await tick();
  r.advance(lookAgainDelay(1) - 2_000 - 1);
  await tick();
  assert.equal(r.repo.calls.length, rested);
  r.advance(1);
  await tick();
  assert.equal(r.repo.calls.length, rested + 1, "the next lookup ends the original window");
  stop();
});

test("a clock that jumps back can't make a rest longer than its window", async () => {
  // A clock that misbehaves the same way: the rest is clamped to the window.
  let back = 0;
  const r = replica({ clock: (scheduler) => () => scheduler.frame - back });
  const { rested, stop } = await restAfterBurst(r);
  r.advance(2_000);
  back = 3_600_000;
  r.sources.close();
  r.sources.connected();
  await tick();
  r.advance(lookAgainDelay(1));
  await tick();
  assert.equal(r.repo.calls.length, rested + 1, "one window at most, not an hour");
  stop();
});

test("deadlines read performance.now() under the async scheduler, and the scheduler's clock otherwise", () => {
  assert.equal(monotonicClock(asyncScheduler), monotonicNow);
  const scheduler = new VirtualTimeScheduler();
  scheduler.frame = 1234;
  assert.equal(monotonicClock(scheduler)(), 1234);
});

test("standing demand made before a connection looks the document up when one is admitted", async () => {
  let linked = false;
  const r = replica({ linked: () => linked });
  const stop = r.sources.demand();
  r.sources.discovered(none);
  await tick();
  assert.equal(r.repo.calls.length, 0, "no lookup while nothing is linked");
  linked = true;
  r.sources.discovered(none);
  await tick();
  assert.equal(r.repo.calls.length, 1);
  stop();
});

test("asks inside the look-again window run one lookup when it ends", async () => {
  const r = replica();
  r.sources.discovered(none);
  r.sources.want();
  await tick();
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) {
    r.repo.calls.at(-1).reject(missing());
    await tick();
    r.advance(retryDelay(attempt));
    await tick();
  }
  const before = r.repo.calls.length;
  assert.equal(r.state().cooling, true);
  for (let i = 0; i < 20; i++) r.sources.want();
  await tick();
  assert.equal(r.repo.calls.length, before, "asks wait for the window");
  r.advance(lookAgainDelay(1));
  await tick();
  assert.equal(r.repo.calls.length, before + 1, "twenty asks are one lookup");
  // That lookup misses too: no burst, and the next window is wider.
  r.repo.calls.at(-1).reject(missing());
  await tick();
  assert.deepEqual(r.state(), { name: "absent", id: DERIVED, misses: 2, cooling: true });
  r.sources.want();
  r.advance(lookAgainDelay(2) - 1);
  await tick();
  assert.equal(r.repo.calls.length, before + 1);
  r.advance(1);
  await tick();
  assert.equal(r.repo.calls.length, before + 2);
  r.repo.calls.at(-1).resolve(handleOf(sourcesDoc()));
  await tick();
  assert.equal(r.state().name, "ready");
});

test("an id another replica installed is never evicted, however late the eviction runs", async () => {
  const claims = new Set();
  const evicted = [];
  let releaseForget;
  const repo = heldFind();
  const scheduler = new VirtualTimeScheduler();
  const advance = (ms) => {
    const target = scheduler.frame + ms;
    scheduler.maxFrames = target;
    scheduler.flush();
    scheduler.frame = target;
    scheduler.maxFrames = Infinity;
  };
  const make = () =>
    new HostDocReplica({
      find: repo.find,
      claims,
      // A slow eviction: it settles only when the test lets it.
      forget: (id) =>
        new Promise((resolve) => {
          releaseForget = () => {
            evicted.push(id);
            resolve();
          };
        }),
      derive: async () => DERIVED,
      scheduler,
    });
  const first = make();
  first.connected();
  await tick();
  repo.calls[0].reject(missing());
  await tick();
  // A second replica on the same repo finds and installs the same document.
  const second = make();
  second.connected();
  await tick();
  repo.calls[1].resolve(handleOf(sourcesDoc()));
  await tick();
  assert.equal(second.state$.snapshot().name, "ready");
  assert.ok(claims.has(DERIVED));
  // The first replica's retry comes due: it doesn't evict what the second holds.
  advance(retryDelay(1));
  await tick();
  assert.equal(releaseForget, undefined, "no eviction was started");
  assert.equal(repo.calls.length, 3, "the retry looks up without evicting");
  second.close();
  assert.ok(!claims.has(DERIVED), "closing gives up the claim");

  // An eviction already under way when the lookup is cancelled stops there:
  // no find runs after it.
  const third = make();
  third.connected();
  await tick();
  repo.calls.at(-1).reject(missing());
  await tick();
  advance(retryDelay(1));
  await tick();
  const finds = repo.calls.length;
  third.retire();
  releaseForget();
  await tick();
  assert.deepEqual(evicted, [DERIVED]);
  assert.equal(repo.calls.length, finds, "a cancelled lookup finds nothing after evicting");
  first.close();
});

test("a new connection looks a derived document up again at once", async () => {
  const r = replica();
  r.sources.connected();
  await tick();
  assert.deepEqual(r.state(), { name: "opening", attempt: 1, id: DERIVED, via: "derived" });
  r.sources.connected();
  await tick();
  assert.equal(r.repo.calls[0].signal.aborted, true, "the first connection's lookup stops");
  assert.equal(r.repo.calls.length, 2);
});

test("a derivation that settles after retirement or close steps nothing", async () => {
  let release;
  const r = replica({ derive: () => new Promise((resolve) => (release = resolve)) });
  r.sources.connected();
  await tick();
  r.sources.retire();
  release(DERIVED);
  await tick();
  assert.deepEqual(r.state(), { name: "retired" });
  assert.equal(r.repo.calls.length, 0);

  const other = replica({ derive: () => new Promise((resolve) => (release = resolve)) });
  other.sources.discovered(none);
  other.sources.want();
  await tick();
  other.sources.close();
  release(DERIVED);
  await tick();
  assert.deepEqual(other.state(), { name: "closed" });
  assert.equal(other.repo.calls.length, 0);
});

test("a replica without a derivation opens only what discovery names", async () => {
  const r = replica({ derive: null });
  r.sources.discovered(none);
  r.sources.want();
  r.sources.connected();
  await tick();
  assert.deepEqual(r.state(), { name: "absent" });
  assert.equal(r.repo.calls.length, 0);
});

test("a document that appears on a later discovery opens then", async () => {
  const r = replica();
  r.sources.discovered(none);
  // An agent writes the first source; the next admitted connection's
  // discovery names the new document.
  r.sources.discovered(named());
  await tick();
  assert.equal(r.repo.calls.length, 1);
  assert.equal(r.repo.calls[0].id, ID);
  const handle = handleOf(sourcesDoc());
  r.repo.calls[0].resolve(handle);
  await tick();
  assert.deepEqual(r.state(), { name: "ready", id: ID });
  assert.equal(r.sources.doc, handle.doc());
  // A refresh reaches doc$.
  const refreshed = sourcesDoc({ usage: { name: "Usage" } });
  handle.land(refreshed);
  assert.equal(r.docs.at(-1), refreshed);
});

test("a failed lookup retries on the backoff, and a reconnect retries at once", async () => {
  const r = replica();
  r.sources.discovered(named());
  await tick();
  r.repo.calls[0].reject(Error("network"));
  await tick();
  assert.equal(r.state().name, "retrying");
  r.advance(retryDelay(1) - 1);
  await tick();
  assert.equal(r.repo.calls.length, 1, "no lookup before the delay");
  r.advance(1);
  await tick();
  assert.equal(r.repo.calls.length, 2, "the timer starts the next lookup");
  r.repo.calls[1].reject(Error("network"));
  await tick();
  assert.deepEqual(r.state(), { name: "retrying", attempt: 2, id: ID, via: "named" });
  // A reconnect's discovery restarts at once and clears the timer.
  r.sources.discovered(named());
  await tick();
  assert.equal(r.repo.calls.length, 3);
  r.advance(retryDelay(2) * 4);
  await tick();
  assert.equal(r.repo.calls.length, 3, "the cleared timer never fires");
  r.repo.calls[2].resolve(handleOf(sourcesDoc()));
  await tick();
  assert.equal(r.state().name, "ready");
});

test("a lookup that outlasts its timeout counts as failed", async () => {
  const r = replica();
  r.sources.discovered(named());
  await tick();
  r.advance(LOOKUP_TIMEOUT_MS - 1);
  await tick();
  assert.equal(r.state().name, "opening");
  r.advance(1);
  await tick();
  assert.equal(r.repo.calls[0].signal.aborted, true);
  assert.equal(r.state().name, "retrying");
});

test("a lookup running when a new connection is admitted restarts on it", async () => {
  const r = replica({ ignoreAbort: true });
  r.sources.discovered(named());
  await tick();
  r.sources.discovered(named());
  await tick();
  assert.equal(r.repo.calls[0].signal.aborted, true);
  assert.equal(r.repo.calls.length, 2);
  // The first lookup's late handle never installs.
  r.repo.calls[0].resolve(handleOf(sourcesDoc()));
  await tick();
  assert.deepEqual(r.state(), { name: "opening", attempt: 1, id: ID, via: "named" });
});

test("an older host's unknown-document answer stops; one after the connection changed retries", async () => {
  let link = 1;
  const r = replica({ link: () => link });
  r.sources.discovered(named());
  await tick();
  r.repo.calls[0].reject(Error(`Document ${ID} is unavailable`));
  await tick();
  assert.deepEqual(r.state(), { name: "unserved", id: ID });
  r.advance(60_000);
  await tick();
  assert.equal(r.repo.calls.length, 1, "nothing retries an older host's answer");

  // The next connection may be a newer host: its discovery starts over.
  r.sources.discovered(named());
  await tick();
  link = undefined;
  r.repo.calls[1].reject(Error(`Document ${ID} is unavailable`));
  await tick();
  assert.equal(r.state().name, "retrying", "a lost connection is not the host's answer");
  // A discovery with no document map is an older host too.
  r.sources.discovered({ documentId: "p" });
  assert.deepEqual(r.state(), { name: "unserved" });
});

test("a document at a format this build doesn't read is never looked up", async () => {
  const r = replica();
  r.sources.discovered({ documents: { sources: { id: ID, type: "pages.sources", format: 9 } } });
  await tick();
  assert.deepEqual(r.state(), { name: "unreadable" });
  assert.equal(r.repo.calls.length, 0);
});

test("retiring cancels a lookup, drops the document, and nothing opens again", async () => {
  const r = replica();
  r.sources.discovered(named());
  await tick();
  const handle = handleOf(sourcesDoc());
  r.repo.calls[0].resolve(handle);
  await tick();
  assert.equal(r.sources.doc, handle.doc());
  r.sources.retire();
  assert.deepEqual(r.state(), { name: "retired" });
  assert.equal(r.sources.doc, undefined);
  assert.equal(handle.listeners.size, 0, "the handle's listener is removed");
  handle.land(sourcesDoc({ late: {} }));
  assert.equal(r.sources.doc, undefined);
  r.sources.discovered(named());
  r.sources.close();
  await tick();
  assert.equal(r.repo.calls.length, 1);
  assert.deepEqual(r.state(), { name: "retired" });

  // A lookup in flight at retirement is cancelled and never installs, even
  // when its find resolves after the abort.
  const other = replica({ ignoreAbort: true });
  other.sources.discovered(named());
  await tick();
  other.sources.retire();
  assert.equal(other.repo.calls[0].signal.aborted, true);
  other.repo.calls[0].resolve(handleOf(sourcesDoc()));
  await tick();
  assert.equal(other.sources.doc, undefined);
});

test("the replica exposes its state and the document's value, and no handle", async () => {
  const r = replica();
  r.sources.discovered(named());
  await tick();
  const handle = handleOf(sourcesDoc());
  r.repo.calls[0].resolve(handle);
  await tick();
  assert.equal(r.state().name, "ready");
  // Its own enumerable properties are the two streams; nothing reaches the
  // handle or a function that returns it.
  assert.deepEqual(Object.keys(r.sources).sort(), ["doc$", "state$"]);
  for (const value of Object.values(r.sources)) {
    assert.notEqual(value, handle);
    assert.notEqual(typeof value, "function");
  }
  assert.equal(r.sources.find, undefined);
  assert.equal(r.sources.doc, handle.doc(), "the value, not the handle");
});

test("automerge-repo's unknown-document error is the one the replica reads as an older host", async (t) => {
  const h = await hostWithSources(t);
  const missing = interpretAsDocumentId(new Uint8Array(16).fill(9));
  const error = await h.repo.find(missing).then(
    () => assert.fail("the host doesn't serve this document"),
    (cause) => cause,
  );
  assert.match(error.message, UNAVAILABLE);
});

// Over a real host: PlainSync serving the Page family, and a browser repo
// with this build's formats.
async function hostWithSources(
  t,
  { seed = true, connect = true, bytes = new MemoryByteStore() } = {},
) {
  const pageId = crypto.randomUUID();
  const uuid = crypto.randomUUID();
  const sourcesId = interpretAsDocumentId(
    Uint8Array.from(Buffer.from(uuid.replaceAll("-", ""), "hex")),
  );
  const plain = new PlainSync({
    storage: new PlainHostStorage(),
    modules: PAGE_FAMILY_MODULES,
    policy: {
      account: () => ({ role: "viewer", canWrite: false, canComment: false, generation: 0 }),
      leaseExpiresAt: () => Infinity,
    },
  });
  await plain.load([]);
  const create = () => plain.host.seed(treeOf(sourcesId), "sources", sourcesGenesis(uuid));
  if (seed) await create();
  t.after(() => plain.close());
  // The browser side: a socket stand-in for PlainSync.accept and the frames
  // the browser sends.
  const sent = [];
  /** Admit a connection from `backend` to the host. */
  const attach = (backend) => {
    const link = framePipe();
    const transport = {
      ...link.client,
      send(frame) {
        sent.push(frame);
        return link.client.send(frame);
      },
      onMessage: (fn) => link.client.onMessage(fn),
      onClose: (fn) => link.client.onClose(fn),
      close: (...args) => link.client.close(...args),
    };
    const socket = new EventTarget();
    socket.send = (bytes) => link.host.send(decodeFrame(bytes));
    socket.close = (code, reason) => link.host.close(code, reason);
    link.host.onMessage((frame) =>
      socket.dispatchEvent(
        Object.assign(new Event("message"), { data: encodeFrame(frame).buffer }),
      ),
    );
    link.host.onClose(() => socket.dispatchEvent(new Event("close")));
    plain.accept(
      socket,
      {
        principal: "account:reader",
        displayName: "Reader",
        driver: "Browser",
        canWrite: false,
        credentialKind: "session",
      },
      {
        features: [...BUILD_FEATURES],
        formats: readableFormats(),
        senderId: `b-${crypto.randomUUID()}`,
      },
    );
    backend.addConnection(transport, { hostId: "pages-host" });
  };
  const backend = await AutomergeSyncBackend.load({ store: new DocStore(bytes) });
  if (connect) attach(backend);
  const repo = new Repo({ backend });
  t.after(() => repo.shutdown?.());
  /** The host's own write: a source pointing at `asset`. */
  const write = async (sourceId, asset, previous = null) => {
    const handle = await plain.repo.find(sourcesId);
    await handle.change((doc) =>
      setSources(
        doc,
        [
          {
            op: "set_source",
            source_id: sourceId,
            name: sourceId,
            asset_id: asset,
            source_revision: previous,
          },
        ],
        {
          mediaTypes: new Map([[asset, "application/vnd.apache.parquet"]]),
          by: { principal: "agent", displayName: "Agent", driver: "MCP" },
        },
      ),
    );
  };
  return {
    pageId,
    sourcesId,
    repo,
    sent,
    write,
    create,
    connect: () => attach(backend),
    /** A browser on `store` that holds no connection until it connects. */
    browser: async (store) => {
      const local = await AutomergeSyncBackend.load({ store: new DocStore(store) });
      const localRepo = new Repo({ backend: local });
      t.after(() => localRepo.shutdown?.());
      return {
        repo: localRepo,
        connect: () => attach(local),
        /** Persist what it holds and let go of the store, as a reload does. */
        async unload() {
          await localRepo.flush();
          await localRepo.shutdown();
          await local.close();
        },
      };
    },
  };
}

test("over a real host the replica syncs the document and never sends a change for it", async (t) => {
  const h = await hostWithSources(t);
  await h.write("usage", "a".repeat(64));
  const sources = new HostDocReplica({ find: (id, options) => h.repo.find(id, options) });
  sources.discovered(named(h.sourcesId));
  await until(() => sources.state$.snapshot().name === "ready", { label: "sources open" });
  assert.equal(sources.doc.sources.usage.current.asset_id, "a".repeat(64));
  // An agent refreshes the source: the host's write reaches doc$.
  await h.write("usage", "b".repeat(64), "1");
  await until(() => sources.doc?.sources.usage.revision === "2", { label: "refresh" });
  assert.equal(sources.doc.sources.usage.current.asset_id, "b".repeat(64));
  // Every frame the browser sent for this document carried no change.
  const frames = h.sent.filter((frame) => frame.doc === treeOf(h.sourcesId));
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.equal(frame.t, "sync");
    if (frame.m) assert.deepEqual(A.decodeSyncMessage(frame.m).changes, []);
  }
  assert.ok(!h.sent.some((frame) => frame.t === "refused"));
  sources.close();
});

test("over a real host, a document it doesn't serve reads as an older host's answer", async (t) => {
  const h = await hostWithSources(t);
  const missing = interpretAsDocumentId(new Uint8Array(16).fill(7));
  const sources = new HostDocReplica({ find: (id, options) => h.repo.find(id, options) });
  sources.discovered(named(missing));
  await until(() => sources.state$.snapshot().name !== "opening", { label: "lookup settles" });
  assert.deepEqual(sources.state$.snapshot(), { name: "unserved", id: missing });
  assert.equal(sources.doc, undefined);
  sources.close();
});

test("over a real host, a document created after a derived miss opens on the same connection", async (t) => {
  const h = await hostWithSources(t, { seed: false });
  const sources = new HostDocReplica({
    find: (id, options) => h.repo.find(id, options),
    forget: (id) => evictUnavailable(h.repo, id),
    derive: async () => h.sourcesId,
  });
  sources.discovered(none);
  sources.want();
  // The host answers none, and the replica waits to look again.
  await until(() => sources.state$.snapshot().name === "retrying", { label: "first miss" });
  // The host creates the document (an agent's first source); the retry on
  // this same connection finds it.
  await h.create();
  await h.write("usage", "a".repeat(64));
  await until(() => sources.state$.snapshot().name === "ready", {
    label: "found after the miss",
    timeout: 10_000,
  });
  assert.equal(sources.doc.sources.usage.current.asset_id, "a".repeat(64));
  sources.close();
});

test("over a real host, eviction leaves a document that has loaded since the miss", async (t) => {
  const h = await hostWithSources(t);
  await h.write("usage", "a".repeat(64));
  const handle = await h.repo.find(h.sourcesId);
  await evictUnavailable(h.repo, h.sourcesId);
  // The handle still follows the host's writes.
  await h.write("usage", "b".repeat(64), "1");
  await until(() => handle.doc().sources.usage.revision === "2", { label: "a write after" });
});

// Before a connection: an ask reads this tab's stored copy (`stored`).

/** A replica whose Page is open from this tab's copy, with no connection
 * until `connect()`. `socket` holds a socket up while lookups stay closed. */
function offline({ socket = false } = {}) {
  let up = false;
  const r = replica({
    link: () => (up || socket ? 1 : undefined),
    linked: () => up,
    stored: () => true,
  });
  return {
    ...r,
    connect() {
      up = true;
    },
  };
}

test("before a connection, an ask opens the document from this tab's copy, and the connection keeps it", async () => {
  const r = offline();
  const stop = r.sources.demand();
  await tick();
  assert.deepEqual(r.state(), { name: "opening", attempt: 1, id: DERIVED, via: "stored" });
  assert.equal(r.repo.calls[0].id, DERIVED);
  const handle = handleOf(sourcesDoc({ usage: {} }));
  r.repo.calls[0].resolve(handle);
  await tick();
  assert.deepEqual(r.state(), { name: "ready", id: DERIVED });
  assert.equal(r.sources.doc, handle.doc());
  // The connection derives the same id: the document stays open.
  r.connect();
  r.sources.connected();
  r.sources.discovered(named(DERIVED));
  await tick();
  assert.equal(r.repo.calls.length, 1, "no lookup on the connection");
  assert.deepEqual(r.state(), { name: "ready", id: DERIVED });
  const refreshed = sourcesDoc({ usage: { name: "Usage" } });
  handle.land(refreshed);
  assert.equal(r.sources.doc, refreshed);
  // A discovery that names none drops it, as for any open document.
  stop();
  r.sources.discovered(none);
  assert.deepEqual(r.state(), { name: "absent" });
  assert.equal(r.sources.doc, undefined);
  assert.equal(handle.listeners.size, 0);
});

test("a stored miss is not a verdict: the replica closes, reads nothing again, and the connection looks", async () => {
  for (const socket of [false, true]) {
    const r = offline({ socket });
    const stop = r.sources.demand();
    await tick();
    // No socket: the repo's answer reads as a failed lookup. A socket that
    // isn't admitted yet: as an unavailable one. Both close the replica.
    r.repo.calls[0].reject(missing());
    await tick();
    assert.deepEqual(r.state(), { name: "closed", checked: true }, `socket ${socket}`);
    assert.deepEqual(r.docs, [undefined], "nothing is shown as missing or failed");
    const derived = r.derivations.length;
    r.sources.want();
    r.sources.demand()();
    r.advance(600_000);
    await tick();
    assert.equal(r.repo.calls.length, 1, "standing demand doesn't read the store again");
    assert.equal(r.derivations.length, derived, "an ask in that state derives nothing");
    assert.deepEqual(r.forgotten, [], "nothing is evicted until the next lookup");
    // The connection looks it up, evicting the stored answer first.
    r.connect();
    r.sources.connected();
    await tick();
    assert.deepEqual(r.state(), { name: "opening", attempt: 1, id: DERIVED, via: "derived" });
    assert.deepEqual(r.forgotten, [DERIVED]);
    assert.equal(r.repo.calls.length, 2);
    r.repo.calls[1].resolve(handleOf(sourcesDoc()));
    await tick();
    assert.equal(r.state().name, "ready");
    stop();
  }
});

test("a stored read that outlasts its timeout closes the replica the same way", async () => {
  const r = offline();
  r.sources.want();
  await tick();
  r.advance(LOOKUP_TIMEOUT_MS);
  await tick();
  assert.equal(r.repo.calls[0].signal.aborted, true);
  assert.deepEqual(r.state(), { name: "closed", checked: true });
});

test("a connection admitted during a stored read cancels it, evicts its answer, and looks up on the link", async () => {
  const r = offline();
  r.sources.want();
  await tick();
  r.connect();
  r.sources.discovered(named(DERIVED));
  await tick();
  assert.equal(r.repo.calls[0].signal.aborted, true, "the stored read stops");
  assert.deepEqual(r.forgotten, [DERIVED], "its answer is evicted before the lookup");
  assert.equal(r.repo.calls.length, 2);
  assert.deepEqual(r.state(), { name: "opening", attempt: 1, id: DERIVED, via: "named" });
  r.repo.calls[1].resolve(handleOf(sourcesDoc()));
  await tick();
  assert.equal(r.state().name, "ready");
});

test("a connection admitted while the id derives looks up on the link, not in storage", async () => {
  let release;
  let up = false;
  const r = replica({
    link: () => (up ? 1 : undefined),
    linked: () => up,
    stored: () => true,
    derive: () => new Promise((resolve) => (release = resolve)),
  });
  r.sources.want();
  await tick();
  up = true;
  release(DERIVED);
  await tick();
  assert.equal(r.repo.calls.length, 0);
  assert.deepEqual(r.state(), { name: "closed" });
});

test("nothing reads the store until something asks, and a tab without a stored Page reads nothing", async () => {
  const r = offline();
  r.advance(60_000);
  await tick();
  assert.equal(r.derivations.length, 0);
  assert.equal(r.repo.calls.length, 0);
  const fresh = replica({ link: () => undefined, linked: () => false, stored: () => false });
  fresh.sources.demand();
  await tick();
  assert.equal(fresh.repo.calls.length, 0);
  assert.deepEqual(fresh.state(), { name: "closed" });
});

test("retire and close stop a stored read; a replaced backend's copy is read afresh", async () => {
  const r = offline();
  r.sources.want();
  await tick();
  r.sources.retire();
  assert.equal(r.repo.calls[0].signal.aborted, true);
  assert.deepEqual(r.state(), { name: "retired" });
  r.sources.want();
  await tick();
  assert.equal(r.repo.calls.length, 1);

  const other = offline();
  other.sources.want();
  await tick();
  other.sources.close();
  assert.equal(other.repo.calls[0].signal.aborted, true);
  assert.deepEqual(other.state(), { name: "closed" });
  other.sources.want();
  await tick();
  assert.equal(other.repo.calls.length, 2, "the new backend's copy is read");
  other.repo.calls[1].reject(missing());
  await tick();
  other.sources.close();
  assert.deepEqual(other.state(), { name: "closed" }, "a close clears the read");
});

test("a replica closed mid-read evicts the read's answer before its next lookup on a link", async () => {
  const r = offline();
  r.sources.want();
  await tick();
  // A view gives its slot up mid-read; the repo may still settle the read
  // unavailable.
  r.sources.close();
  r.repo.calls[0].reject(missing());
  await tick();
  assert.deepEqual(r.state(), { name: "closed" });
  r.connect();
  r.sources.connected();
  await tick();
  assert.deepEqual(r.forgotten, [DERIVED], "the read's answer is evicted first");
  assert.equal(r.repo.calls.length, 2);
  assert.deepEqual(r.state(), { name: "opening", attempt: 1, id: DERIVED, via: "derived" });
});

/** A replica with no connection until `connect()`, whose evictions wait
 * until the test settles them (or their lookup's signal aborts, unless
 * `ignoreAbort`). */
function slowEviction({ ignoreAbort = false } = {}) {
  let up = false;
  const repo = heldFind();
  const evictions = [];
  const sources = new HostDocReplica({
    find: repo.find,
    forget: (id, { signal } = {}) =>
      new Promise((resolve) => {
        evictions.push({ id, signal, resolve });
        if (!ignoreAbort) signal?.addEventListener("abort", () => resolve());
      }),
    link: () => (up ? 1 : undefined),
    linked: () => up,
    stored: () => true,
    derive: async () => DERIVED,
  });
  return {
    sources,
    repo,
    evictions,
    connect() {
      up = true;
    },
    disconnect() {
      up = false;
    },
  };
}

test("an eviction interrupted by its lookup's cancellation runs again on the next lookup", async () => {
  for (const interrupt of ["discovered", "close"]) {
    const r = slowEviction();
    r.sources.want();
    await tick();
    // A connection interrupts the stored read: the named lookup first evicts
    // the read's answer, and the eviction waits on the still-loading entry.
    r.connect();
    r.sources.discovered(named(DERIVED));
    await tick();
    assert.equal(r.evictions.length, 1);
    assert.equal(r.repo.calls.length, 1, "no find before the eviction completes");
    // The eviction itself is interrupted.
    if (interrupt === "close") r.sources.close();
    r.sources.discovered(named(DERIVED));
    await tick();
    assert.equal(r.evictions[0].signal.aborted, true, interrupt);
    assert.equal(r.evictions.length, 2, `${interrupt}: the next lookup evicts again`);
    r.evictions[1].resolve();
    await tick();
    assert.equal(r.repo.calls.length, 2, "the find follows the completed eviction");
    r.repo.calls[1].resolve(handleOf(sourcesDoc()));
    await tick();
    assert.equal(r.sources.state$.snapshot().name, "ready");
    // Completed: the next lookup of the id evicts nothing.
    r.sources.close();
    r.sources.discovered(named(DERIVED));
    await tick();
    assert.equal(r.evictions.length, 2);
    assert.equal(r.repo.calls.length, 3);
    r.sources.close();
  }
});

test("an earlier eviction settling late never clears an obligation a later forget set", async () => {
  const r = slowEviction({ ignoreAbort: true });
  r.sources.want();
  await tick();
  r.connect();
  r.sources.discovered(named(DERIVED));
  await tick();
  assert.equal(r.evictions.length, 1);
  // The lookup is closed mid-eviction; with no connection, a new stored
  // read misses and sets a new obligation.
  r.sources.close();
  r.disconnect();
  r.sources.want();
  await tick();
  // The new read evicts first (the interrupted obligation still stands),
  // then reads, and misses.
  assert.equal(r.evictions.length, 2);
  r.evictions[1].resolve();
  await tick();
  r.repo.calls.at(-1).reject(missing());
  await tick();
  assert.deepEqual(r.sources.state$.snapshot(), { name: "closed", checked: true });
  // The first eviction settles now: the miss's obligation stands.
  r.evictions[0].resolve();
  await tick();
  r.connect();
  r.sources.discovered(named(DERIVED));
  await tick();
  assert.equal(r.evictions.length, 3, "the stored miss's answer is evicted before the lookup");
  r.evictions[2].resolve();
  await tick();
  r.repo.calls.at(-1).resolve(handleOf(sourcesDoc()));
  await tick();
  assert.equal(r.sources.state$.snapshot().name, "ready");
  r.sources.close();
});

test("after a stored miss, the next lookup never evicts an id another replica installed", async () => {
  const claims = new Set();
  const forgotten = [];
  const repo = heldFind();
  let up = false;
  const make = () =>
    new HostDocReplica({
      find: repo.find,
      forget: async (id) => forgotten.push(id),
      claims,
      link: () => (up ? 1 : undefined),
      linked: () => up,
      stored: () => true,
      derive: async () => DERIVED,
    });
  const first = make();
  first.want();
  await tick();
  repo.calls[0].reject(missing());
  await tick();
  assert.deepEqual(first.state$.snapshot(), { name: "closed", checked: true });
  const second = make();
  second.want();
  await tick();
  repo.calls[1].resolve(handleOf(sourcesDoc()));
  await tick();
  assert.ok(claims.has(DERIVED));
  up = true;
  first.connected();
  await tick();
  assert.deepEqual(forgotten, [], "the installed id is not evicted");
  assert.equal(repo.calls.length, 3);
  first.close();
  second.close();
});

/** A replica on `tab`'s repo whose Page is open from the tab's store, with
 * no connection until the test admits one. */
function storedReplica(tab, id, { onFind = () => {} } = {}) {
  let up = false;
  const states = [];
  const sources = new HostDocReplica({
    find: (doc, options) => {
      const found = tab.repo.find(doc, options);
      onFind(up);
      return found;
    },
    forget: (doc, options) => evictUnavailable(tab.repo, doc, options),
    link: () => (up ? 1 : undefined),
    linked: () => up,
    stored: () => true,
    derive: async () => id,
  });
  sources.state$.state$.subscribe((state) => states.push(state.name));
  return {
    sources,
    states,
    /** Admit a connection whose discovery names `id`. */
    admit() {
      tab.connect();
      up = true;
      sources.discovered(named(id));
    },
  };
}

test("over a real host, a document this tab stored opens before the connection and then syncs on it", async (t) => {
  const bytes = new MemoryByteStore();
  const h = await hostWithSources(t, { connect: false });
  await h.write("usage", "a".repeat(64));
  // An earlier visit synced the document into this tab's store.
  const visit = await h.browser(bytes);
  visit.connect();
  const synced = await visit.repo.find(h.sourcesId);
  await until(() => synced.doc()?.sources?.usage?.revision === "1", { label: "first visit" });
  await visit.unload();
  // A reload: the same store, no connection.
  const tab = await h.browser(bytes);
  const { sources, admit } = storedReplica(tab, h.sourcesId);
  const stop = sources.demand();
  await until(() => sources.state$.snapshot().name === "ready", { label: "opened from storage" });
  assert.equal(sources.doc.sources.usage.current.asset_id, "a".repeat(64));
  // The host moves on while the tab has no connection.
  await h.write("usage", "b".repeat(64), "1");
  await tick();
  assert.equal(sources.doc.sources.usage.revision, "1");
  // The connection is admitted: discovery names the open document, and the
  // host's change reaches doc$.
  const values = [];
  sources.doc$.subscribe((doc) => values.push(doc?.sources.usage.revision));
  admit();
  assert.equal(sources.state$.snapshot().name, "ready", "the open document stays open");
  await until(() => sources.doc?.sources.usage.revision === "2", { label: "synced on the link" });
  assert.equal(values.at(-1), "2");
  assert.equal(sources.doc.sources.usage.current.asset_id, "b".repeat(64));
  stop();
  sources.close();
});

test("over a real host, a tab with no stored copy waits for the host, which finds the document", async (t) => {
  const h = await hostWithSources(t, { connect: false });
  await h.write("usage", "a".repeat(64));
  const tab = await h.browser(new MemoryByteStore());
  const { sources, states, admit } = storedReplica(tab, h.sourcesId);
  const stop = sources.demand();
  // With no bytes and no peer, the repo answers at once: unavailable.
  await until(() => sources.state$.snapshot().checked === true, { label: "stored miss" });
  assert.equal(
    tab.repo.findWithProgress(h.sourcesId).peek().state,
    "unavailable",
    "the repo holds that answer",
  );
  assert.equal(sources.doc, undefined);
  // A named discovery on the live link evicts that answer and asks the host.
  admit();
  await until(() => sources.state$.snapshot().name === "ready", { label: "found on the link" });
  assert.equal(sources.doc.sources.usage.current.asset_id, "a".repeat(64));
  for (const name of ["failed", "absent", "unserved", "retrying"])
    assert.ok(!states.includes(name), `never ${name}`);
  stop();
  sources.close();
});

test("over a real host, a connection admitted while a stored read settles still finds the document", async (t) => {
  const h = await hostWithSources(t, { connect: false });
  await h.write("usage", "a".repeat(64));
  // The repo's answer to the stored read is on its way for a few turns: admit
  // the connection a little later each round, through and past that window.
  // With `twice`, a second admission follows at once and cancels the first
  // lookup while its eviction still waits on the read.
  for (const twice of [false, true])
    for (let round = 0; round < 24; round++) {
      const label = `round ${round}${twice ? ", admitted twice" : ""}`;
      const tab = await h.browser(new MemoryByteStore());
      let admitted;
      const replica = storedReplica(tab, h.sourcesId, {
        onFind: (up) => {
          if (up) return;
          admitted = (async () => {
            for (let i = 0; i < round; i++) await Promise.resolve();
            replica.admit();
            if (!twice) return;
            await Promise.resolve();
            replica.admit();
          })();
        },
      });
      const { sources, states } = replica;
      sources.want();
      await until(() => admitted !== undefined, { label: "stored read" });
      await admitted;
      await until(() => sources.state$.snapshot().name === "ready", {
        label: `found on the link, ${label}`,
      });
      assert.ok(!states.includes("unserved"), `${label}: never unserved`);
      sources.close();
      await tab.unload();
    }
});
