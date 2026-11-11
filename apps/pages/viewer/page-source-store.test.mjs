import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import { setPageSource } from "../model/page-sources.mjs";
import {
  chartBinding,
  markSourceVersions,
  pageSourceStore,
  pageSourcesFor,
  sourceVersion,
} from "./page-source-store.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const first = "a".repeat(64),
  second = "b".repeat(64),
  third = "c".repeat(64);
const write = (doc, source_id, asset_id, expected_revision = null) =>
  A.change(doc, (draft) =>
    setPageSource(draft, { source_id, name: source_id, asset_id, expected_revision }),
  );

/** A Page session stand-in: a document and the listeners a change reaches. */
function session(doc) {
  const listeners = new Set();
  return {
    alive: true,
    get doc() {
      return doc;
    },
    set(next) {
      doc = next;
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    listeners,
  };
}

const storeOver = (page) =>
  pageSourceStore({ pageId, read: () => page.doc, subscribe: (fn) => page.subscribe(fn) });

test("a watcher hears its sources' versions, and only when one of them changes", () => {
  const page = session(write(write(A.from({ sources: {} }), "daily", first), "tools", second));
  const seen = [];
  const subscription = storeOver(page)
    .versions(["daily"])
    .subscribe((versions) => seen.push(versions));
  // Prose and another source's refresh don't reach a table of `daily`.
  page.set(A.change(page.doc, (draft) => (draft.title = "Usage")));
  page.set(write(page.doc, "tools", third, "1"));
  page.set(write(page.doc, "daily", third, "1"));
  subscription.unsubscribe();
  page.set(write(page.doc, "daily", first, "2"));
  assert.deepEqual(seen, [
    { daily: { source_id: "daily", asset_id: first, source_revision: "1" } },
    { daily: { source_id: "daily", asset_id: third, source_revision: "2" } },
  ]);
  assert.equal(page.listeners.size, 0);
});

test("a missing source, and a Page with no document yet, read as null", () => {
  assert.equal(sourceVersion(A.from({ sources: {} }), "daily"), null);
  assert.equal(sourceVersion(undefined, "daily"), null);
  const page = session(A.from({}));
  const seen = [];
  storeOver(page)
    .versions(["daily"])
    .subscribe((versions) => seen.push(versions.daily?.source_revision ?? null));
  page.set(write(page.doc, "daily", first));
  assert.deepEqual(seen, [null, "1"]);
});

test("the resolver reads a binding from the document when a view asks for it", async () => {
  const page = session(write(A.from({ sources: {} }), "daily", first));
  const fetched = [];
  const store = storeOver(page);
  const resolver = store.resolver(async (bytes) => ({ bytes, dispose() {} }));
  assert.equal(
    store.resolver(() => assert.fail("one resolver per store")),
    resolver,
  );
  globalThis.fetch = async (url) => {
    fetched.push(String(url).slice(-64));
    return new Response(new Uint8Array([1]), {
      headers: { "content-type": "application/vnd.apache.parquet" },
    });
  };
  try {
    const before = await resolver.resolveSource({ source_id: "daily" });
    page.set(write(page.doc, "daily", second, "1"));
    const after = await resolver.resolveSource({ source_id: "daily" });
    const pinned = await resolver.resolveSource({ asset_id: first });
    assert.deepEqual(
      [before, after, pinned].map(({ asset_id, source_revision }) => [asset_id, source_revision]),
      [
        [first, "1"],
        [second, "2"],
        [first, undefined],
      ],
    );
    // The pinned read shares the byte cache with the first version.
    assert.deepEqual(fetched, [first, second]);
  } finally {
    delete globalThis.fetch;
    store.destroy();
  }
  assert.throws(() => store.resolver(() => {}), /closed/);
});

test("one store per session, closed when the session ends", () => {
  const page = session(A.from({}));
  const store = pageSourcesFor(page, pageId);
  assert.equal(pageSourcesFor(page, pageId), store);
  assert.equal(pageSourcesFor({ doc: A.from({}) }, pageId), null);
  page.alive = false;
  page.set(page.doc);
  assert.throws(() => store.resolver(() => {}), /closed/);
});

test("a chart following sources reads each name as a source; otherwise its src", () => {
  const src = `/api/pages/${pageId}/assets/${first}`;
  assert.deepEqual(chartBinding("tools", { src, source: "daily", following: true }), {
    source_id: "tools",
  });
  assert.deepEqual(chartBinding("anything", { src, following: false }), { asset_id: first });
  assert.deepEqual(chartBinding("daily", { src, source: "daily", following: false }), {
    asset_id: first,
  });
  assert.throws(
    () => chartBinding("tools", { src, source: "daily", following: false }),
    /shows only daily/,
  );
});

test("a view records the version it drew", () => {
  const element = { dataset: {} };
  markSourceVersions(element, {
    daily: { source_id: "daily", asset_id: first, source_revision: "2", rows: 9 },
    pinned: { asset_id: second },
  });
  assert.deepEqual(JSON.parse(element.dataset.sourceVersions), {
    daily: { asset_id: first, source_revision: "2" },
    pinned: { asset_id: second, source_revision: null },
  });
});
