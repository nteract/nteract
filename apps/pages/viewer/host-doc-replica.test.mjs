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
import { VirtualTimeScheduler } from "rxjs";
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
import { LOOK_AGAIN_MS, MISSING_ATTEMPTS, retryDelay } from "./host-doc-open-machine.mjs";
import { LOOKUP_TIMEOUT_MS, HostDocReplica, UNAVAILABLE } from "./host-doc-replica.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const ID = "sources-1";
const named = (id = ID) => ({ documents: { sources: { id, type: "pages.sources", format: 1 } } });
const none = { documents: { page: { id: "p", type: "pages.page", format: 3 } } };

/** A repo whose `find` calls are held until the test settles them. */
function heldFind() {
  const calls = [];
  const find = (id, { signal } = {}) =>
    new Promise((resolve, reject) => {
      calls.push({ id, signal, resolve, reject });
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

function replica({ link = () => 1, derive } = {}) {
  const scheduler = new VirtualTimeScheduler();
  const repo = heldFind();
  const forgotten = [];
  const derivations = [];
  const sources = new HostDocReplica({
    find: repo.find,
    forget: async (id) => forgotten.push(id),
    link,
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
  r.advance(10 * LOOK_AGAIN_MS);
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

test("a derived miss forgets the answer, retries on the backoff, then rests", async () => {
  const r = replica();
  r.sources.discovered(none);
  r.sources.want();
  await tick();
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) {
    r.repo.calls[attempt - 1].reject(missing());
    await tick();
    assert.deepEqual(r.forgotten, Array(attempt).fill(DERIVED), "each miss is forgotten");
    if (attempt === MISSING_ATTEMPTS) break;
    r.advance(retryDelay(attempt) - 1);
    await tick();
    assert.equal(r.repo.calls.length, attempt, "no lookup before the delay");
    r.advance(1);
    await tick();
    assert.equal(r.repo.calls.length, attempt + 1);
  }
  assert.deepEqual(r.state(), { name: "absent", id: DERIVED, cooling: true });
  // Nobody asks: the window passes and nothing runs.
  r.advance(LOOK_AGAIN_MS);
  await tick();
  assert.deepEqual(r.state(), { name: "absent", id: DERIVED });
  r.advance(10 * LOOK_AGAIN_MS);
  await tick();
  assert.equal(r.repo.calls.length, MISSING_ATTEMPTS);
  // A later ask looks at once.
  r.sources.want();
  await tick();
  assert.equal(r.repo.calls.length, MISSING_ATTEMPTS + 1);
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
  r.advance(LOOK_AGAIN_MS);
  await tick();
  assert.equal(r.repo.calls.length, before + 1, "twenty asks are one lookup");
  r.repo.calls.at(-1).resolve(handleOf(sourcesDoc()));
  await tick();
  assert.equal(r.state().name, "ready");
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
  const r = replica();
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

  // A lookup in flight at retirement is cancelled and never installs.
  const other = replica();
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
async function hostWithSources(t, { seed = true } = {}) {
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
  const link = framePipe();
  const sent = [];
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
    socket.dispatchEvent(Object.assign(new Event("message"), { data: encodeFrame(frame).buffer })),
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
  const backend = await AutomergeSyncBackend.load({ store: new DocStore(new MemoryByteStore()) });
  backend.addConnection(transport, { hostId: "pages-host" });
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
  return { pageId, sourcesId, repo, sent, write, create };
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
    forget: (id) => h.repo.removeFromCache(id),
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
