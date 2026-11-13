// PageSession's sources and view replicas: each admitted connection moves
// them, a reader that asks for a missing source looks again, the Page's
// source store reads them, and a replaced replica opens its own.
// The machine is covered by host-doc-open-machine.test.mjs, its interpreter by
// host-doc-replica.test.mjs, and retirement on every real path (sources and
// views) by session-revoke.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { VirtualTimeScheduler } from "rxjs";
import { LOOK_AGAIN_MS, MISSING_ATTEMPTS, retryDelay } from "./host-doc-open-machine.mjs";
import { PageSession } from "./session.mjs";
import {
  derivedDocumentId,
  sourcesDocUuid,
  viewDocumentId as hostViewDocumentId,
} from "../shared/document-ids.mjs";
import { until } from "../sync/test-helpers.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const SOURCES_ID = "5".repeat(32);
const page = { id: "p", type: "pages.page", format: 3 };
const withSources = {
  documents: { page, sources: { id: SOURCES_ID, type: "pages.sources", format: 1 } },
};
const withoutSources = { documents: { page } };

function heldRepo() {
  const calls = [];
  return {
    calls,
    find(id, { signal } = {}) {
      return new Promise((resolve, reject) => {
        calls.push({ id, signal, resolve, reject });
        signal?.addEventListener("abort", () => reject(signal.reason ?? Error("aborted")));
      });
    },
    flush: async () => {},
  };
}

function fixture(t, options = {}) {
  const auth = { identity: { principal: crypto.randomUUID(), displayName: "R" }, canWrite: false };
  const pageId = crypto.randomUUID();
  const doc = A.change(A.from(createPageData({ pageId, title: "P" })), (draft) =>
    initializePage(draft),
  );
  const session = new PageSession(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
    ...options,
  });
  session.acceptAuthentication(auth);
  session.handle = { doc: () => doc, on() {} };
  session.repo = heldRepo();
  session.backend = {};
  session.sockets.add({ close() {} });
  session.queueSaved = () => {};
  t.after(() => {
    session.sources.close();
    session.close();
  });
  /** An admitted connection whose discovery is `connection`. */
  const admit = (connection) => {
    session.connection = connection;
    session.connectionGeneration = (session.connectionGeneration ?? 0) + 1;
    session.openSources();
  };
  return { session, admit, pageId };
}

const sourcesWith = (assetId) => {
  const genesis = sourcesGenesis(crypto.randomUUID());
  return A.change(genesis, (draft) =>
    setSources(
      draft,
      [
        {
          op: "set_source",
          source_id: "usage",
          name: "Usage",
          asset_id: assetId,
          source_revision: null,
        },
      ],
      {
        mediaTypes: new Map([[assetId, PARQUET_MEDIA_TYPE]]),
        by: { principal: "agent", displayName: "Agent", driver: "MCP" },
      },
    ),
  );
};

test("a Page whose discovery names no sources document looks nothing up", async (t) => {
  const { session, admit } = fixture(t);
  admit(withoutSources);
  await tick();
  assert.equal(session.sources.state$.snapshot().name, "absent");
  assert.equal(session.repo.calls.length, 0);
  assert.deepEqual(session.pageSources.snapshot(), {});
});

test("a sources document that appears while the tab is open opens on the next admitted connection", async (t) => {
  const { session, admit } = fixture(t);
  admit(withoutSources);
  const versions = [];
  session.pageSources.versions(["usage"]).subscribe((v) => versions.push(v.usage));
  // An agent writes the Page's first source; a reconnect's discovery names
  // the new document.
  admit(withSources);
  await tick();
  assert.equal(session.repo.calls.length, 1);
  assert.equal(session.repo.calls[0].id, SOURCES_ID);
  session.repo.calls[0].resolve({ doc: () => sourcesWith("a".repeat(64)), on() {}, off() {} });
  await tick();
  assert.equal(session.sources.state$.snapshot().name, "ready");
  // session.sources exposes the two streams and no handle.
  assert.deepEqual(Object.keys(session.sources).sort(), ["doc$", "state$"]);
  for (const value of Object.values(session.sources))
    assert.notEqual(typeof value, "function", "no own property is a function");
  assert.deepEqual(
    versions.map((v) => v && [v.asset_id, v.revision]),
    [null, ["a".repeat(64), "1"]],
  );
  // A later reconnect keeps the open document: no second lookup.
  admit(withSources);
  await tick();
  assert.equal(session.repo.calls.length, 1);
});

test("replacing the replica cancels its sources lookup; the new replica opens its own", async (t) => {
  const { session, admit } = fixture(t);
  admit(withSources);
  await tick();
  const first = session.repo;
  await session.releaseLocal();
  assert.equal(first.calls[0].signal.aborted, true);
  assert.equal(session.sources.state$.snapshot().name, "closed");
  session.repo = heldRepo();
  session.backend = {};
  session.sockets.add({ close() {} });
  first.calls[0].resolve({ doc: () => sourcesWith("a".repeat(64)), on() {}, off() {} });
  await tick();
  assert.equal(session.sources.doc, undefined, "the old replica's lookup never installs");
  admit(withSources);
  await tick();
  assert.equal(session.repo.calls.length, 1);
});

test("a hidden Page opens no sources document", async (t) => {
  const { session, admit } = fixture(t);
  Object.defineProperty(session, "hidden", { value: true, configurable: true });
  admit(withSources);
  await tick();
  assert.equal(session.repo.calls.length, 0);
  assert.equal(session.sources.state$.snapshot().name, "closed");
});

test("a Page's first source, created while the tab is open, opens when a table asks for it", async (t) => {
  const { session, admit, pageId } = fixture(t);
  admit(withoutSources);
  await tick();
  assert.equal(session.repo.calls.length, 0, "nothing asks yet, so nothing is looked up");
  // A table follows a source the Page doesn't hold: the session looks the
  // sources document up by its derived id, on the connection it has.
  const versions = [];
  session.pageSources.versions(["usage"]).subscribe((v) => versions.push(v.usage));
  await until(() => session.repo.calls.length === 1, { label: "the derived lookup" });
  assert.equal(session.repo.calls[0].id, derivedDocumentId(await sourcesDocUuid(pageId)));
  session.repo.calls[0].resolve({ doc: () => sourcesWith("a".repeat(64)), on() {}, off() {} });
  await tick();
  assert.equal(session.sources.state$.snapshot().name, "ready");
  assert.deepEqual(
    versions.map((v) => v && v.asset_id),
    [null, "a".repeat(64)],
  );
});

test("a table waiting for a Page's first source asks once per window until it stops waiting", async (t) => {
  const scheduler = new VirtualTimeScheduler();
  const advance = (ms) => {
    const target = scheduler.frame + ms;
    scheduler.maxFrames = target;
    scheduler.flush();
    scheduler.frame = target;
    scheduler.maxFrames = Infinity;
  };
  const { session, admit } = fixture(t, { scheduler });
  admit(withoutSources);
  const waiting = session.pageSources.versions(["usage"]).subscribe(() => {});
  const answer = async () => {
    await until(() => session.repo.calls.some((call) => !call.answered), { label: "a lookup" });
    for (const call of session.repo.calls.filter((each) => !each.answered)) {
      call.answered = true;
      call.reject(Error(`Document ${call.id} is unavailable`));
    }
    await tick();
  };
  for (let attempt = 1; attempt <= MISSING_ATTEMPTS; attempt++) {
    await answer();
    advance(retryDelay(attempt));
  }
  assert.equal(session.repo.calls.length, MISSING_ATTEMPTS);
  for (const [index, window] of LOOK_AGAIN_MS.entries()) {
    advance(window);
    await answer();
    assert.equal(session.repo.calls.length, MISSING_ATTEMPTS + index + 1, `after ${window} ms`);
  }
  // The table goes away: nothing asks after the window it is in.
  waiting.unsubscribe();
  advance(600_000);
  await tick();
  assert.equal(session.repo.calls.length, MISSING_ATTEMPTS + LOOK_AGAIN_MS.length);
});

test("a hidden Page asks for no sources document", async (t) => {
  const { session, admit } = fixture(t);
  admit(withoutSources);
  Object.defineProperty(session, "hidden", { value: true, configurable: true });
  session.pageSources.versions(["usage"]).subscribe(() => {});
  await tick();
  assert.equal(session.repo.calls.length, 0);
});

test("with no connection, a table's ask reads the sources document from this tab's copy", async (t) => {
  const { session, admit, pageId } = fixture(t);
  session.sockets.clear();
  const versions = [];
  session.pageSources.versions(["usage"]).subscribe((v) => versions.push(v.usage));
  await until(() => session.repo.calls.length === 1, { label: "the stored read" });
  assert.equal(session.repo.calls[0].id, derivedDocumentId(await sourcesDocUuid(pageId)));
  assert.equal(session.sources.state$.snapshot().via, "stored");
  session.repo.calls[0].resolve({ doc: () => sourcesWith("a".repeat(64)), on() {}, off() {} });
  await tick();
  assert.equal(session.sources.state$.snapshot().name, "ready");
  assert.deepEqual(
    versions.map((v) => v && v.asset_id),
    [null, "a".repeat(64)],
  );
  // The connection that follows names the same document: it stays open.
  session.sockets.add({ close() {} });
  admit({
    documents: {
      page,
      sources: { id: session.repo.calls[0].id, type: "pages.sources", format: 1 },
    },
  });
  await tick();
  assert.equal(session.repo.calls.length, 1);
  assert.equal(session.sources.state$.snapshot().name, "ready");
});

test("a tab with no Page copy open reads nothing before a connection", async (t) => {
  const { session } = fixture(t, { viewDocumentId });
  session.sockets.clear();
  session.handle = undefined;
  session.pageSources.versions(["usage"]).subscribe(() => {});
  const sales = session.views.hold("sales");
  await tick();
  await tick();
  assert.equal(session.repo.calls.length, 0);
  assert.deepEqual(session.sources.state$.snapshot(), { name: "closed" });
  let read;
  sales.view$.subscribe((view) => (read = view)).unsubscribe();
  assert.deepEqual(read, { status: "pending" });
  sales.release();
});

test("a hidden Page reads nothing from this tab's copy", async (t) => {
  const { session } = fixture(t, { viewDocumentId });
  session.sockets.clear();
  Object.defineProperty(session, "hidden", { value: true, configurable: true });
  session.pageSources.versions(["usage"]).subscribe(() => {});
  const sales = session.views.hold("sales");
  await tick();
  await tick();
  assert.equal(session.repo.calls.length, 0);
  sales.release();
});

const viewDocumentId = async (pageId, viewId) => `view:${pageId}:${viewId}`;

test("a held view is looked up by its derived id on each admitted connection", async (t) => {
  const { session, admit, pageId } = fixture(t, { viewDocumentId });
  session.sockets.clear();
  // A view held before any connection reads this tab's copy once; a miss
  // there waits for a connection.
  const sales = session.views.hold("sales");
  await until(() => session.repo.calls.length === 1, { label: "the stored read" });
  session.repo.calls[0].reject(Error(`Document view:${pageId}:sales is unavailable`));
  await tick();
  assert.deepEqual(session.views.replica("sales").state$.snapshot(), {
    name: "closed",
    checked: true,
  });
  let read;
  sales.view$.subscribe((view) => (read = view)).unsubscribe();
  assert.deepEqual(read, { status: "pending" }, "a stored miss is not a verdict");
  session.sockets.add({ close() {} });
  admit(withoutSources);
  await tick();
  assert.deepEqual(
    session.repo.calls.map((call) => call.id),
    [`view:${pageId}:sales`, `view:${pageId}:sales`],
  );
  // One held while connected looks up at once.
  const costs = session.views.hold("costs");
  await tick();
  assert.equal(session.repo.calls.at(-1).id, `view:${pageId}:costs`);
  assert.deepEqual(session.views.open, ["costs", "sales"]);
  sales.release();
  costs.release();
});

test("a session derives each view's document id as the host does", async (t) => {
  const { session, admit, pageId } = fixture(t);
  admit(withoutSources);
  const sales = session.views.hold("sales");
  await until(() => session.repo.calls.length === 1, { label: "the view lookup" });
  assert.equal(session.repo.calls[0].id, await hostViewDocumentId(pageId, "sales"));
  sales.release();
});
