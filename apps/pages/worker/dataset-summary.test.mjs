// Dataset summaries over a ranged-read bucket, with Sift's real WASM.

import assert from "node:assert/strict";
import test from "node:test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { write_parquet_ipc } from "@nteract/sift/wasm";
import * as sift from "#sift-wasm";
import {
  DatasetSummaries,
  FooterUnreadable,
  MAX_FOOTER_BYTES,
  MAX_SUMMARY_COLUMNS,
  MAX_SUMMARY_BYTES,
  MAX_TEXT_BOUND,
  TAIL_BYTES,
  agentSummary,
  datasetSummaryKey,
  readParquetTail,
} from "./dataset-summary.mjs";
import { imageAssetKey } from "./image-assets.mjs";

const pageId = "11111111-1111-4111-8111-111111111111";
const assetId = "a".repeat(64);

/** An R2-shaped bucket that answers ranged gets and records every read. */
function bucket() {
  const objects = new Map();
  const reads = [];
  return {
    objects,
    reads,
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength } : null;
    },
    async get(key, { range } = {}) {
      reads.push(range ? [key, range.offset, range.length] : [key]);
      const bytes = objects.get(key);
      if (!bytes) return null;
      const body = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
      return {
        size: bytes.byteLength,
        arrayBuffer: async () => body.slice().buffer,
        text: async () => new TextDecoder().decode(body),
      };
    },
    async put(key, value) {
      await this.beforePut?.(key);
      objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function salesParquet() {
  const table = tableFromArrays({
    region: ["east", "west", "east", null],
    units: Int32Array.from([3, 9, 4, 1]),
    revenue: Float64Array.from([10.5, 99.25, 12, 3]),
    day: [
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 11, 31),
      Date.UTC(2026, 5, 1),
      Date.UTC(2026, 2, 3),
    ].map((ms) => new Date(ms)),
  });
  return write_parquet_ipc(tableToIPC(table, "stream"));
}

/** A Page's summaries over `parquet`, counting Sift loads. */
function summaries(parquet) {
  const store = bucket();
  if (parquet) store.objects.set(imageAssetKey(pageId, assetId), parquet);
  const loads = { count: 0 };
  const loader = async () => {
    loads.count++;
    return sift;
  };
  return {
    store,
    loads,
    make: () => new DatasetSummaries({ bucket: store, pageId, sift: loader }),
  };
}

test("summarizes a dataset from its footer and stores the summary beside it", async () => {
  const parquet = salesParquet();
  const { store, make } = summaries(parquet);
  const summary = await make().summary(assetId);

  assert.equal(summary.rows, 4);
  assert.equal(summary.row_groups, 1);
  const byName = Object.fromEntries(summary.columns.map((c) => [c.name, c]));
  assert.deepEqual(
    [byName.region.type, byName.region.null_count, byName.region.min, byName.region.max],
    // Arrow JS writes strings dictionary-encoded; the type is what the file reads as.
    ["Dictionary(Int32, Utf8)", 1, "east", "west"],
  );
  assert.deepEqual([byName.units.min, byName.units.max], [1, 9]);
  assert.deepEqual([byName.revenue.min, byName.revenue.max], [3, 99.25]);
  assert.match(byName.day.type, /^(Date|Timestamp)/);
  assert.ok(String(byName.day.min).startsWith("2026-01-01"), byName.day.min);
  assert.ok(String(byName.day.max).startsWith("2026-12-31"), byName.day.max);

  // One ranged read of the end, never the whole file.
  const datasetReads = store.reads.filter(([key]) => key === imageAssetKey(pageId, assetId));
  assert.deepEqual(datasetReads, [[imageAssetKey(pageId, assetId), 0, parquet.byteLength]]);
  const stored = JSON.parse(
    new TextDecoder().decode(store.objects.get(datasetSummaryKey(pageId, assetId))),
  );
  assert.deepEqual(stored.summary, summary);
});

test("a stored summary answers without Sift; memory answers without the bucket", async () => {
  const { store, loads, make } = summaries(salesParquet());
  const first = await make().summary(assetId);
  assert.equal(loads.count, 1);

  // A new host reads the stored summary and loads no WASM.
  const host = make();
  assert.deepEqual(await host.summary(assetId), first);
  assert.equal(loads.count, 1);
  const reads = store.reads.length;
  assert.deepEqual(await host.summary(assetId), first);
  assert.equal(store.reads.length, reads);
});

test("an unreadable footer is stored as such and summarizes to null", async () => {
  const notParquet = new TextEncoder().encode("PAR1 this is not a footer PAR1");
  const { store, loads, make } = summaries(notParquet);
  assert.equal(await make().summary(assetId), null);
  const stored = JSON.parse(
    new TextDecoder().decode(store.objects.get(datasetSummaryKey(pageId, assetId))),
  );
  assert.equal(typeof stored.unreadable, "string");
  assert.equal(await make().summary(assetId), null);
  assert.equal(loads.count, 1, "a refusal is not retried");
});

test("a missing dataset summarizes to null and stores nothing", async () => {
  const { store, make } = summaries(null);
  assert.equal(await make().summary(assetId), null);
  assert.equal(store.objects.size, 0);
});

test("bucket failures reject and store nothing", async () => {
  const { store, make } = summaries(salesParquet());
  store.get = async () => {
    throw Error("object store unavailable");
  };
  await assert.rejects(make().summary(assetId), /unavailable/);
  assert.equal(store.objects.has(datasetSummaryKey(pageId, assetId)), false);
});

test("a footer longer than the first read takes a second read of exactly its length", async () => {
  const store = bucket();
  const key = "dataset";
  store.objects.set(key, new Uint8Array(TAIL_BYTES * 3));
  const footer = TAIL_BYTES * 2;
  const read = await readParquetTail(store, key, () => footer);
  assert.equal(read.tail.byteLength, footer + 8);
  assert.deepEqual(store.reads, [
    [key, TAIL_BYTES * 2, TAIL_BYTES],
    [key, TAIL_BYTES * 3 - footer - 8, footer + 8],
  ]);
  await assert.rejects(
    readParquetTail(store, key, () => MAX_FOOTER_BYTES + 1),
    FooterUnreadable,
  );
  await assert.rejects(
    readParquetTail(store, key, () => TAIL_BYTES * 3),
    FooterUnreadable,
  );
});

test("agent summaries keep only whole-file bounds and JSON-safe values", () => {
  const column = (name, data_type, min, max, extra = {}) => ({
    name,
    data_type,
    nullable: true,
    null_count: 0,
    min,
    max,
    bounded_row_groups: 2,
    bounds_exact: true,
    has_infinite: false,
    ...extra,
  });
  const summary = agentSummary({
    num_rows: 10,
    num_row_groups: 2,
    created_by: null,
    columns: [
      column("partial", "Int64", 1, 5, { bounded_row_groups: 1 }),
      column("inf", "Float64", -Infinity, Infinity, { has_infinite: true }),
      column("long", "Utf8", "a", "z".repeat(MAX_TEXT_BOUND + 1)),
      column("ts", "Timestamp(Millisecond, None)", Date.UTC(2026, 10, 13, 9, 30), 0),
      column("truncated", "Utf8", "a", "b", { bounds_exact: false }),
    ],
  });
  const [partial, inf, long, ts, truncated] = summary.columns;
  assert.deepEqual([partial.min, partial.max, partial.bounds_exact], [null, null, false]);
  assert.deepEqual([inf.min, inf.max], ["-Infinity", "Infinity"]);
  assert.deepEqual([long.min, long.max], ["a", null]);
  assert.equal(ts.min, "2026-11-13T09:30:00.000Z");
  assert.equal(truncated.bounds_exact, false);
  assert.equal(summary.columns_truncated, undefined);

  const wide = agentSummary({
    num_rows: 0,
    num_row_groups: 0,
    created_by: null,
    columns: Array.from({ length: MAX_SUMMARY_COLUMNS + 1 }, (_, i) =>
      column(`c${i}`, "Int32", null, null, { bounded_row_groups: 0 }),
    ),
  });
  assert.equal(wide.columns.length, MAX_SUMMARY_COLUMNS);
  assert.equal(wide.column_count, MAX_SUMMARY_COLUMNS + 1);
  assert.equal(wide.columns_truncated, true);

  // Long names and bounds stop the list at the byte cap, whatever the count.
  const cjk = "東".repeat(MAX_TEXT_BOUND);
  const heavy = agentSummary({
    num_rows: 1,
    num_row_groups: 1,
    created_by: null,
    columns: Array.from({ length: MAX_SUMMARY_COLUMNS }, (_, i) =>
      column(`${cjk}${i}`, "Utf8", cjk, cjk, { bounded_row_groups: 1 }),
    ),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(heavy)).byteLength;
  assert.ok(bytes <= MAX_SUMMARY_BYTES, `${bytes} bytes`);
  assert.ok(heavy.columns.length > 0 && heavy.columns.length < MAX_SUMMARY_COLUMNS);
  assert.equal(heavy.columns_truncated, true);
});

/** A Sift stand-in that answers `summarize` for every footer. */
function fakeSift(summarize) {
  return { parquet_footer_length: () => 4, parquet_footer_summary: summarize };
}

test("an infinite bound reads the same from a new host as from the one that computed it", async () => {
  const { store } = summaries(salesParquet());
  const sift = fakeSift(() => ({
    num_rows: 1,
    num_row_groups: 1,
    created_by: null,
    columns: [
      {
        name: "x",
        data_type: "Float64",
        nullable: false,
        null_count: 0,
        min: -Infinity,
        max: Infinity,
        bounded_row_groups: 1,
        bounds_exact: true,
        has_infinite: true,
      },
    ],
  }));
  const host = () => new DatasetSummaries({ bucket: store, pageId, sift: async () => sift });
  const computed = await host().summary(assetId);
  assert.deepEqual([computed.columns[0].min, computed.columns[0].max], ["-Infinity", "Infinity"]);
  assert.deepEqual(await host().summary(assetId), computed);
});

test("a trapped Sift stores that footer as unreadable and summarizes nothing more", async () => {
  const { store } = summaries(salesParquet());
  const other = "b".repeat(64);
  store.objects.set(imageAssetKey(pageId, other), salesParquet());
  let calls = 0;
  const sift = fakeSift(() => {
    calls++;
    throw new WebAssembly.RuntimeError("unreachable");
  });
  const host = new DatasetSummaries({ bucket: store, pageId, sift: async () => sift });
  assert.equal(await host.summary(assetId), null);
  const stored = JSON.parse(
    new TextDecoder().decode(store.objects.get(datasetSummaryKey(pageId, assetId))),
  );
  assert.match(stored.unreadable, /trapped/);
  await assert.rejects(host.summary(other), /trapped earlier/);
  assert.equal(calls, 1);
  assert.equal(store.objects.has(datasetSummaryKey(pageId, other)), false);
});

test("after close nothing is stored, and a write in flight takes back what it wrote", async () => {
  const { store, make } = summaries(salesParquet());
  const host = make();
  let release;
  store.beforePut = () => {
    host.close();
    return new Promise((resolve) => (release = resolve));
  };
  const pending = host.summary(assetId);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await pending).rows, 4, "the read still answers");
  assert.equal(store.objects.has(datasetSummaryKey(pageId, assetId)), false);

  // A closed store never writes.
  store.beforePut = () => assert.fail("a closed store wrote");
  const closed = summaries(salesParquet());
  const shut = closed.make();
  shut.close();
  closed.store.beforePut = store.beforePut;
  assert.equal((await shut.summary(assetId)).rows, 4);
  assert.equal(closed.store.objects.has(datasetSummaryKey(pageId, assetId)), false);
});
