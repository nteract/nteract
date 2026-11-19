// CSV sources in the Page's source store: the byte cache converts each to
// Arrow IPC once (normalized-bytes.mjs), and every reader, a table, a chart
// or a module view, decodes those bytes.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { BehaviorSubject } from "rxjs";
import { tableFromIPC } from "apache-arrow";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { CSV_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { PageSourceStore } from "./page-source-store.mjs";
import { followSource } from "./source-follow.mjs";
import { csvArrow as convertCsv } from "./csv-arrow.mjs";
import { isParquet } from "./view-arrow.mjs";

const PAGE = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const asset = (char) => char.repeat(64);
const writer = { principal: "agent", displayName: "Agent", driver: "MCP" };
const csvText = {
  [asset("a")]: "city,people\nOslo,3\nBergen,4\n",
  [asset("b")]: "city,people\nOslo,5\n",
  [asset("c")]: "city,people\nOslo\n",
  [asset("d")]: "n\n1\n",
};

/** A sources document the host wrote, and `set` for the host's next write. */
function hostDoc() {
  let doc = sourcesGenesis(crypto.randomUUID());
  const revisions = {};
  return {
    get doc() {
      return doc;
    },
    set(sourceId, assetId, mediaType = CSV_MEDIA_TYPE) {
      doc = A.change(doc, (draft) => {
        setSources(
          draft,
          [
            {
              op: "set_source",
              source_id: sourceId,
              name: sourceId,
              asset_id: assetId,
              source_revision: revisions[sourceId] ?? null,
            },
          ],
          { mediaTypes: new Map([[assetId, mediaType]]), by: writer },
        );
      });
      revisions[sourceId] = doc.sources[sourceId].revision;
      return doc;
    },
  };
}

/** A fetch that serves each asset's CSV text under `typeOf(id)`, counting.
 * With `failFirst`, the first request answers 503. */
function csvFetch({ failFirst = false, typeOf = () => CSV_MEDIA_TYPE } = {}) {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (failFirst && calls.length === 1) return new Response("unavailable", { status: 503 });
    const id = url.slice(-64);
    return new Response(new TextEncoder().encode(csvText[id]), {
      headers: { "content-type": typeOf(id), "x-pages-media-type": typeOf(id) },
    });
  };
  return { calls, request };
}

/** The CSV converter, counting its conversions. */
function csvConverter() {
  const converted = [];
  return {
    converted,
    csvArrow: async () => async (bytes, limits) => {
      converted.push(new TextDecoder().decode(bytes));
      return convertCsv(bytes, limits);
    },
  };
}

/** A decoder that reads normalized bytes as Arrow IPC, as Sift's
 * loadTableFile does for bytes without the Parquet magic. */
const ipcRows = async (bytes) => {
  assert.ok(!isParquet(bytes), "a CSV reaches every reader as Arrow IPC");
  return tableFromIPC(bytes)
    .toArray()
    .map((row) => row.toJSON());
};

const storeOf = (host, options) =>
  new PageSourceStore({ pageId: PAGE, doc$: new BehaviorSubject(host.doc), ...options });

test("a CSV source converts once for every load and decoder; a failed conversion is kept", async () => {
  const host = hostDoc();
  host.set("cities", asset("a"));
  host.set("broken", asset("c"));
  const fetches = csvFetch();
  const { converted, csvArrow } = csvConverter();
  const store = storeOf(host, { request: fetches.request, csvArrow });
  const version = store.resolve({ source_id: "cities" });
  assert.equal(version.media_type, CSV_MEDIA_TYPE);
  const tables = store.resolver(ipcRows);
  const charts = store.resolver(async (bytes) => bytes);
  const [first, second] = await Promise.all([tables.load(version), tables.load(version)]);
  assert.deepEqual(first.table, [
    { city: "Oslo", people: 3n },
    { city: "Bergen", people: 4n },
  ]);
  assert.deepEqual(second.table, first.table);
  assert.ok(!isParquet((await charts.load(version)).table));
  assert.equal(converted.length, 1, "one conversion across loads and decoders");
  assert.equal(fetches.calls.length, 1);
  // A CSV that does not convert fails every reader the same way, with no
  // second fetch or conversion.
  const broken = store.resolve({ source_id: "broken" });
  for (let i = 0; i < 2; i++)
    await assert.rejects(tables.load(broken), {
      name: "CsvUnreadable",
      message: /can't be read as CSV: .*unequal lengths/,
    });
  await assert.rejects(charts.load(broken), { name: "CsvUnreadable" });
  assert.equal(converted.length, 2);
  assert.equal(fetches.calls.length, 2);
  store.destroy();
});

test("a CSV source whose fetch failed is fetched and converted again", async () => {
  const host = hostDoc();
  host.set("cities", asset("a"));
  const fetches = csvFetch({ failFirst: true });
  const { converted, csvArrow } = csvConverter();
  const store = storeOf(host, { request: fetches.request, csvArrow });
  const resolver = store.resolver(ipcRows);
  const version = store.resolve({ source_id: "cities" });
  await assert.rejects(resolver.load(version), /Couldn't load the dataset \(503\)/);
  assert.equal(converted.length, 0);
  assert.equal((await resolver.load(version)).table.length, 2);
  assert.equal(fetches.calls.length, 2);
  store.destroy();
});

test("a table or chart refuses a source that is neither Parquet nor CSV before fetching", async () => {
  const host = hostDoc();
  host.set("old", asset("d"), "application/octet-stream");
  const fetches = csvFetch();
  const store = storeOf(host, { request: fetches.request, ...csvConverter() });
  await assert.rejects(store.resolver(ipcRows).load(store.resolve({ source_id: "old" })), {
    name: "SourceUnavailable",
    message: "This build can't show application/octet-stream.",
  });
  assert.equal(fetches.calls.length, 0);
  store.destroy();
});

test("a shared resolver keeps decoded columns by asset and format", async () => {
  const host = hostDoc();
  // A CSV uploaded as generic binary: only csv() reads it.
  host.set("old", asset("d"), "application/octet-stream");
  host.set("cities", asset("a"));
  const fetches = csvFetch({
    typeOf: (id) => (id === asset("d") ? "application/octet-stream" : CSV_MEDIA_TYPE),
  });
  const { converted, csvArrow } = csvConverter();
  const store = storeOf(host, { request: fetches.request, csvArrow });
  const decodes = [];
  const decode = async (bytes) => {
    decodes.push(bytes.byteLength);
    return ipcRows(bytes);
  };
  const csv = store.sharedResolver(decode, { format: "csv" });
  const parquet = store.sharedResolver(decode, { format: "parquet" });
  assert.equal(store.sharedResolver(decode, { format: "csv" }), csv);
  assert.equal(store.sharedResolver(decode), parquet, "Parquet is the default format");
  assert.notEqual(csv, parquet, "one resolver per format, even for one decoder");
  assert.throws(() => store.sharedResolver(decode, { format: "tsv" }), /Unknown table format/);
  const old = store.resolve({ source_id: "old" });
  const rows = await csv.load(old);
  assert.deepEqual(rows.table, [{ n: 1n }]);
  assert.equal((await csv.load(old)).table, rows.table, "decoded once");
  await assert.rejects(parquet.load(old), { name: "SourceUnavailable" });
  // A CSV source read in both formats is decoded once per format; the
  // conversion is shared.
  const cities = store.resolve({ source_id: "cities" });
  const [asCsv, asParquet] = await Promise.all([csv.load(cities), parquet.load(cities)]);
  assert.notEqual(asCsv.table, asParquet.table, "the two formats never share a result");
  assert.deepEqual(asCsv.table, asParquet.table);
  assert.deepEqual(csv.decoded(), [asset("d"), asset("a")]);
  assert.deepEqual(parquet.decoded(), [asset("a")]);
  assert.equal(decodes.length, 3);
  assert.equal(converted.length, 2);
  store.destroy();
});

test("a followed table over a CSV source draws its rows, redraws on a new version, and shows a failure", async () => {
  const host = hostDoc();
  host.set("cities", asset("a"));
  const doc$ = new BehaviorSubject(host.doc);
  const store = new PageSourceStore({
    pageId: PAGE,
    doc$,
    request: csvFetch().request,
    ...csvConverter(),
  });
  const renders = [];
  const follow = followSource({
    binding: { source_id: "cities" },
    sources: store,
    loadTableFile: ipcRows,
    render: (key, load) => renders.push({ key, load }),
  });
  assert.deepEqual(await renders[0].load(), [
    { city: "Oslo", people: 3n },
    { city: "Bergen", people: 4n },
  ]);
  doc$.next(host.set("cities", asset("b")));
  assert.equal(renders.length, 2);
  assert.deepEqual(await renders[1].load(), [{ city: "Oslo", people: 5n }]);
  doc$.next(host.set("cities", asset("c")));
  await assert.rejects(renders[2].load(), { message: /can't be read as CSV: .*unequal lengths/ });
  follow.destroy();
  store.destroy();
});
