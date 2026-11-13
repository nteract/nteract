// The sources replica's interpreter: discovery answers, lookups with a
// timeout, retries on virtual time, an older host's answer, retirement, and
// that the open document's changes reach `doc$`. Over a real host it syncs
// the document and never sends a change for it.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Repo, documentIdToBinary, interpretAsDocumentId } from "@automerge/automerge-repo";
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
import { retryDelay } from "./sources-open-machine.mjs";
import { SOURCES_LOOKUP_TIMEOUT_MS, SourcesReplica, UNAVAILABLE } from "./sources-replica.mjs";
import { IdbByteStore } from "../sync/idb-byte-store.mjs";
import "fake-indexeddb/auto";

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

function replica({ link = () => 1 } = {}) {
  const scheduler = new VirtualTimeScheduler();
  const repo = heldFind();
  const sources = new SourcesReplica({ find: repo.find, link, scheduler });
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
  return { sources, repo, scheduler, docs, advance, state: () => sources.state$.snapshot() };
}

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
  assert.deepEqual(r.state(), { name: "retrying", attempt: 2, id: ID });
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
  r.advance(SOURCES_LOOKUP_TIMEOUT_MS - 1);
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
  assert.deepEqual(r.state(), { name: "opening", attempt: 1, id: ID });
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

test("retirement removes the sources document's synced bytes from the replica's storage", async (t) => {
  const bytes = new IdbByteStore(`pages-plain-test-${crypto.randomUUID()}`);
  t.after(() => bytes.destroy());
  const h = await hostWithSources(t, { bytes });
  await h.write("usage", "a".repeat(64));
  const tree = treeOf(h.sourcesId);
  const stored = async () => (await bytes.list("")).filter((key) => key.includes(tree));
  const sources = new SourcesReplica({
    find: (id, options) => h.repo.find(id, options),
    forget: (id) => h.backend.deleteLocal(documentIdToBinary(id)),
  });
  sources.discovered(named(h.sourcesId));
  await until(() => sources.state$.snapshot().name === "ready", { label: "sources open" });
  await h.backend.flush();
  assert.ok((await stored()).length > 0, "the synced document is stored");

  // A closed replica keeps its bytes for its successor.
  sources.close();
  assert.ok((await stored()).length > 0);

  sources.discovered(named(h.sourcesId));
  await until(() => sources.state$.snapshot().name === "ready", { label: "sources reopen" });
  await sources.retire();
  assert.deepEqual(await stored(), [], "nothing of it is left in the tab's database");
});

// Over a real host: PlainSync serving the Page family, and a browser repo
// with this build's formats.
async function hostWithSources(t, { bytes = new MemoryByteStore() } = {}) {
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
  await plain.host.seed(treeOf(sourcesId), "sources", sourcesGenesis(uuid));
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
  const backend = await AutomergeSyncBackend.load({ store: new DocStore(bytes) });
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
  return { pageId, sourcesId, repo, backend, sent, write };
}

test("over a real host the replica syncs the document and never sends a change for it", async (t) => {
  const h = await hostWithSources(t);
  await h.write("usage", "a".repeat(64));
  const sources = new SourcesReplica({ find: (id, options) => h.repo.find(id, options) });
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
  const sources = new SourcesReplica({ find: (id, options) => h.repo.find(id, options) });
  sources.discovered(named(missing));
  await until(() => sources.state$.snapshot().name !== "opening", { label: "lookup settles" });
  assert.deepEqual(sources.state$.snapshot(), { name: "unserved", id: missing });
  assert.equal(sources.doc, undefined);
  sources.close();
});
