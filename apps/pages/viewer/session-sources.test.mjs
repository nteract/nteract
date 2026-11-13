// PageSession's sources replica: each admitted connection's discovery moves
// it, the Page's source store reads it, and a replaced replica opens its own.
// The machine is covered by sources-open-machine.test.mjs, its interpreter by
// sources-replica.test.mjs, and retirement by session-revoke.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { PageSession } from "./session.mjs";
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

function fixture(t) {
  const auth = { identity: { principal: crypto.randomUUID(), displayName: "R" }, canWrite: false };
  const pageId = crypto.randomUUID();
  const doc = A.change(A.from(createPageData({ pageId, title: "P" })), (draft) =>
    initializePage(draft),
  );
  const session = new PageSession(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
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
  return { session, admit };
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
