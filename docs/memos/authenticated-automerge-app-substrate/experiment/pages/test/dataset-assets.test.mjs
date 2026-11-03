import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PARQUET_MEDIA_TYPE,
  dataframeAttrs,
  dataframeFor,
  isParquetFile,
  parseAssetPath,
  titleFromFile,
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

test("dataframe attrs normalize the title and need a known media type", () => {
  assert.deepEqual(dataframeAttrs({ src, media_type: PARQUET_MEDIA_TYPE, title: "  Usage  " }), {
    src,
    media_type: PARQUET_MEDIA_TYPE,
    title: "Usage",
  });
  assert.deepEqual(
    dataframeAttrs({ src, media_type: PARQUET_MEDIA_TYPE, title: "  " }).title,
    null,
  );
  assert.deepEqual(dataframeFor(pageId, { asset_id: assetId }), {
    src,
    media_type: PARQUET_MEDIA_TYPE,
    title: null,
  });
});

test("dataframe attrs refuse foreign sources, other media types and unknown keys", () => {
  for (const value of [
    null,
    [],
    { media_type: PARQUET_MEDIA_TYPE },
    { src: "https://example.com/x.parquet", media_type: PARQUET_MEDIA_TYPE },
    { src, media_type: "text/csv" },
    { src, media_type: PARQUET_MEDIA_TYPE, title: 42 },
    { src, media_type: PARQUET_MEDIA_TYPE, title: "x".repeat(201) },
    { src, media_type: PARQUET_MEDIA_TYPE, view: { sort: "events" } },
  ])
    assert.throws(() => dataframeAttrs(value), JSON.stringify(value));
});

test("Parquet files are recognized by media type or by extension when the type is generic", () => {
  assert.equal(isParquetFile({ name: "usage", type: PARQUET_MEDIA_TYPE }), true);
  for (const type of ["", "application/octet-stream", "application/x-parquet"])
    assert.equal(isParquetFile({ name: "usage.PARQUET", type }), true, type);
  assert.equal(isParquetFile({ name: "usage.parquet", type: "image/png" }), false);
  assert.equal(isParquetFile({ name: "usage.csv", type: "" }), false);
  assert.equal(isParquetFile(null), false);
  assert.equal(titleFromFile({ name: "usage by day.parquet" }), "usage by day");
  assert.equal(titleFromFile({ name: ".parquet" }), null);
});
