// The Page's source store and a table that follows a source through it:
// the projection, per-source versions, the one resolver with its byte cache,
// and freeing what nothing reads.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { BehaviorSubject } from "rxjs";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { PageSourceStore, SourceUnavailable, projectSources } from "./page-source-store.mjs";
import { followSource, markDrawnVersion, versionKey } from "./source-follow.mjs";

const PAGE = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const asset = (char) => char.repeat(64);
const writer = { principal: "agent", displayName: "Agent", driver: "MCP" };

/** A sources document the host wrote, and `set` for the host's next write. */
function hostDoc() {
  let doc = sourcesGenesis(crypto.randomUUID());
  const revisions = {};
  return {
    get doc() {
      return doc;
    },
    set(sourceId, assetId, name = sourceId) {
      doc = A.change(doc, (draft) => {
        setSources(
          draft,
          [
            {
              op: "set_source",
              source_id: sourceId,
              name,
              asset_id: assetId,
              source_revision: revisions[sourceId] ?? null,
            },
          ],
          { mediaTypes: new Map([[assetId, PARQUET_MEDIA_TYPE]]), by: writer },
        );
      });
      revisions[sourceId] = doc.sources[sourceId].revision;
      return doc;
    },
  };
}

/** A fetch that answers every Page asset with its id's bytes, counting. */
function datasetFetch() {
  const calls = [];
  const request = async (url, { signal } = {}) => {
    calls.push(url);
    signal?.throwIfAborted();
    return new Response(new TextEncoder().encode(url.slice(-64)), {
      headers: { "content-type": PARQUET_MEDIA_TYPE },
    });
  };
  return { calls, request };
}

/** A decoder whose tables record whether they were freed. */
function decoder() {
  const tables = [];
  const loadTableFile = async (bytes) => {
    const table = { text: new TextDecoder().decode(bytes), disposed: false };
    table.dispose = () => (table.disposed = true);
    tables.push(table);
    return table;
  };
  return { tables, loadTableFile };
}

function storeOver(doc) {
  const doc$ = new BehaviorSubject(doc);
  const fetches = datasetFetch();
  const store = new PageSourceStore({ pageId: PAGE, doc$, request: fetches.request });
  return { doc$, store, fetches };
}

test("a Page with no sources document projects no sources", () => {
  assert.deepEqual(projectSources(undefined), {});
  const { store } = storeOver(undefined);
  assert.deepEqual(store.snapshot(), {});
  const seen = [];
  store.versions(["usage"]).subscribe((versions) => seen.push(versions));
  assert.deepEqual(seen, [{ usage: null }]);
  assert.throws(() => store.resolve({ source_id: "usage" }), SourceUnavailable);
});

test("the projection reads each source, and an entry the host would refuse hides only itself", () => {
  const host = hostDoc();
  host.set("usage", asset("a"), "Usage");
  host.set("costs", asset("b"), "Costs");
  const broken = A.change(host.doc, (draft) => {
    draft.sources.costs.revision = "9";
  });
  assert.deepEqual(projectSources(broken), {
    usage: {
      source_id: "usage",
      name: "Usage",
      asset_id: asset("a"),
      media_type: PARQUET_MEDIA_TYPE,
      revision: "1",
    },
  });
});

test("a refresh reaches the subscriber of that source and not another", () => {
  const host = hostDoc();
  host.set("usage", asset("a"));
  host.set("costs", asset("b"));
  const { doc$, store } = storeOver(host.doc);
  const usage = [];
  const costs = [];
  store.versions(["usage"]).subscribe((v) => usage.push(v.usage));
  store.versions(["costs"]).subscribe((v) => costs.push(v.costs));
  assert.equal(usage.length, 1, "each subscriber gets the current version at once");
  assert.equal(costs.length, 1);

  doc$.next(host.set("usage", asset("c")));
  assert.deepEqual(
    usage.map((v) => [v.asset_id, v.revision]),
    [
      [asset("a"), "1"],
      [asset("c"), "2"],
    ],
  );
  assert.equal(costs.length, 1, "refreshing usage doesn't reach a costs subscriber");

  // A new document value that changes no source reaches no one: the store
  // reads only the sources document, so a prose edit never gets this far.
  doc$.next(A.change(host.doc, (draft) => (draft.unrelated = true)));
  doc$.next(A.clone(host.doc));
  assert.equal(usage.length, 2);
  assert.equal(costs.length, 1);

  // The document closing (a retired replica) reads as no sources.
  doc$.next(undefined);
  assert.equal(usage.at(-1), null);
  assert.equal(costs.at(-1), null);
});

test("the resolver turns a binding into the version it reads now", () => {
  const host = hostDoc();
  host.set("usage", asset("a"));
  const { doc$, store } = storeOver(host.doc);
  assert.deepEqual(store.resolve({ source_id: "usage" }), {
    source_id: "usage",
    asset_id: asset("a"),
    media_type: PARQUET_MEDIA_TYPE,
    revision: "1",
  });
  doc$.next(host.set("usage", asset("b")));
  assert.equal(store.resolve({ source_id: "usage" }).asset_id, asset("b"));
  assert.deepEqual(store.resolve({ asset_id: asset("d") }), {
    asset_id: asset("d"),
    media_type: PARQUET_MEDIA_TYPE,
    revision: null,
  });
  assert.throws(() => store.resolve({ source_id: "nope" }), /isn't on this Page/);
  assert.throws(() => store.resolve(null), SourceUnavailable);
});

test("one resolver per store, one byte cache: each load decodes its own table", async () => {
  const host = hostDoc();
  host.set("usage", asset("a"));
  const { store, fetches } = storeOver(host.doc);
  const { tables, loadTableFile } = decoder();
  const resolver = store.resolver(loadTableFile);
  assert.equal(store.resolver(loadTableFile), resolver);
  const version = store.resolve({ source_id: "usage" });
  const [first, second] = await Promise.all([resolver.load(version), resolver.load(version)]);
  assert.equal(fetches.calls.length, 1, "two tables over one asset fetch it once");
  assert.notEqual(first.table, second.table);
  assert.equal(first.table.text, asset("a"));
  assert.deepEqual(
    { ...first, table: undefined },
    { table: undefined, ...version },
    "the load names the version it drew",
  );
  await resolver.load(store.resolve({ asset_id: asset("a") }));
  assert.equal(fetches.calls.length, 1, "a pinned table over the same asset shares the bytes");
  assert.equal(tables.length, 3);
});

test("a table decoded after its reader left is freed, and destroy stops everything", async () => {
  const host = hostDoc();
  host.set("usage", asset("a"));
  const { store, fetches } = storeOver(host.doc);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const tables = [];
  const resolver = store.resolver(async () => {
    await held;
    const table = { disposed: false, dispose: () => (table.disposed = true) };
    tables.push(table);
    return table;
  });
  const reader = new AbortController();
  const loading = resolver.load(store.resolve({ source_id: "usage" }), { signal: reader.signal });
  await tick();
  reader.abort();
  release();
  await assert.rejects(loading, /stopped/);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].disposed, true, "nothing reads it, so it is freed");

  // The byte cache keeps the newest assets only.
  const small = new PageSourceStore({
    pageId: PAGE,
    doc$: new BehaviorSubject(undefined),
    request: fetches.request,
    maxEntries: 2,
  });
  const cached = small.resolver(async () => ({ dispose() {} }));
  for (const char of ["a", "b", "c"]) await cached.load(small.resolve({ asset_id: asset(char) }));
  assert.deepEqual(cached.cached(), [asset("b"), asset("c")]);

  small.destroy();
  assert.deepEqual(cached.cached(), []);
  await assert.rejects(
    cached.load({ asset_id: asset("a"), media_type: PARQUET_MEDIA_TYPE, revision: null }),
    /stopped/,
  );
  assert.throws(() => small.resolver(async () => ({})), /closed/);
});

test("a destroyed store reads as a Page with no sources", () => {
  const host = hostDoc();
  host.set("usage", asset("a"));
  host.set("costs", asset("b"));
  const { doc$, store } = storeOver(host.doc);
  const seen = [];
  const subscription = store.versions(["usage", "costs"]).subscribe((v) => seen.push(v));
  assert.equal(Object.keys(store.snapshot()).length, 2);
  store.destroy();
  assert.deepEqual(store.snapshot(), {});
  assert.throws(() => store.resolve({ source_id: "usage" }), SourceUnavailable);
  assert.throws(() => store.resolve({ asset_id: asset("a") }), SourceUnavailable);
  assert.deepEqual(seen.at(-1), { usage: null, costs: null }, "subscribers get nulls");
  assert.equal(subscription.closed, false, "and stay open");
  // The document no longer reaches it.
  doc$.next(host.set("usage", asset("c")));
  assert.equal(seen.length, 2);
  assert.deepEqual(store.snapshot(), {});
});

test("a followed table redraws on a refresh, frees the version it replaced, and records what drew", async () => {
  const host = hostDoc();
  host.set("usage", asset("a"));
  const { doc$, store } = storeOver(host.doc);
  const { tables, loadTableFile } = decoder();
  const renders = [];
  const drawn = [];
  const element = { dataset: {} };
  const follow = followSource({
    binding: { source_id: "usage" },
    sources: store,
    loadTableFile,
    render: (key, load, version) => renders.push({ key, load, version }),
    onDrawn: (version) => {
      drawn.push(version);
      markDrawnVersion(element, version);
    },
  });
  assert.equal(renders.length, 1);
  assert.equal(renders[0].key, `${asset("a")}:1`);
  const firstTable = await renders[0].load();
  assert.equal(firstTable.text, asset("a"));
  assert.deepEqual(element.dataset, { assetId: asset("a"), sourceRevision: "1" });

  // An agent refreshes the source. A new key replaces the table; the
  // renderer frees the old one on unmount (Sift does), and a load still
  // running for it is stopped.
  const staleLoad = renders[0].load();
  doc$.next(host.set("usage", asset("b")));
  assert.equal(renders.length, 2);
  assert.equal(renders[1].key, versionKey({ asset_id: asset("b"), revision: "2" }));
  await assert.rejects(staleLoad, { name: "AbortError" });
  assert.equal(tables.length, 1, "the replaced version's stopped load decodes nothing");
  const secondTable = await renders[1].load();
  assert.equal(secondTable.text, asset("b"));
  assert.deepEqual(element.dataset, { assetId: asset("b"), sourceRevision: "2" });
  assert.deepEqual(
    drawn.map((v) => [v.asset_id, v.revision]),
    [
      [asset("a"), "1"],
      [asset("b"), "2"],
    ],
  );

  // Another source changing doesn't redraw this table.
  doc$.next(host.set("costs", asset("c")));
  assert.equal(renders.length, 2);

  // The source isn't on the Page any more: the table says so.
  doc$.next(undefined);
  assert.equal(renders.length, 3);
  assert.equal(renders[2].key, "missing");
  assert.equal(renders[2].load, null);

  follow.destroy();
  doc$.next(host.doc);
  assert.equal(renders.length, 3, "a destroyed table follows nothing");
});
