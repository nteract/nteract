import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PARQUET_MEDIA_TYPE,
  isParquetFile,
  parseAssetPath,
  parseSiftSource,
  siftSource,
} from "../shared/dataset-assets.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const assetId = "a".repeat(64);
const src = `/api/pages/${pageId}/assets/${assetId}`;

test("only a same-origin Page asset path names a dataset", () => {
  assert.deepEqual(parseAssetPath(src), { pageId, assetId });
  for (const value of [
    `https://pages.runtimed.run${src}`,
    `//evil.example${src}`,
    `${src}?x=1`,
    `${src}/`,
    `/api/pages/${pageId}/assets/${"A".repeat(64)}`,
    `/api/pages/not-a-page/assets/${assetId}`,
    `/api/pages/${pageId}/assets/../${assetId}`,
    "javascript:alert(1)",
    undefined,
    42,
  ])
    assert.equal(parseAssetPath(value), null, String(value));
});

test("a sift fence body round-trips its src and trimmed title", () => {
  assert.equal(siftSource({ src }), JSON.stringify({ src }));
  const body = siftSource({ src, title: "  Usage by day  " });
  assert.deepEqual(JSON.parse(body), { src, title: "Usage by day" });
  assert.deepEqual(parseSiftSource(body), { src, title: "Usage by day" });
  assert.deepEqual(parseSiftSource(`\n  ${JSON.stringify({ src })}\n`), { src, title: null });
  assert.throws(() => siftSource({ src: "https://example.com/data.parquet" }));
});

test("a sift fence ignores keys it doesn't know", () => {
  assert.deepEqual(parseSiftSource(JSON.stringify({ src, view: { sort: "events" } })), {
    src,
    title: null,
  });
});

test("a malformed sift fence explains itself instead of throwing", () => {
  for (const text of [
    "",
    "   ",
    "not json",
    "[]",
    "null",
    '"string"',
    JSON.stringify({}),
    JSON.stringify({ src: "https://example.com/data.parquet" }),
    JSON.stringify({ src: `${src}#x` }),
  ]) {
    const result = parseSiftSource(text);
    assert.equal(typeof result.error, "string", text);
    assert.equal(result.src, undefined);
  }
});

test("Parquet files are recognized by media type or by extension when the type is generic", () => {
  assert.equal(isParquetFile({ name: "usage", type: PARQUET_MEDIA_TYPE }), true);
  for (const type of ["", "application/octet-stream", "application/x-parquet"])
    assert.equal(isParquetFile({ name: "usage.PARQUET", type }), true, type);
  assert.equal(isParquetFile({ name: "usage.parquet", type: "image/png" }), false);
  assert.equal(isParquetFile({ name: "usage.csv", type: "" }), false);
  assert.equal(isParquetFile(null), false);
});
