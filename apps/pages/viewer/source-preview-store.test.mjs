import assert from "node:assert/strict";
import test from "node:test";
import { BehaviorSubject } from "rxjs";
import {
  initialPreview,
  previewTransition,
  previewOf,
  sourcePreviewStore,
  CSV_PREVIEW_COLUMNS,
  CSV_PREVIEW_ROWS,
  SOURCE_PREVIEW_TYPES,
  TEXT_PREVIEW_LIMIT,
} from "./source-preview-store.mjs";
import { sourceMediaLabel } from "./sources-panel-store.mjs";

test("a CSV source is labelled CSV and previewed", () => {
  assert.equal(sourceMediaLabel("text/csv"), "CSV");
  assert.ok(SOURCE_PREVIEW_TYPES.includes("text/csv"));
});
const version = { asset_id: "a", revision: "1", media_type: "text/javascript" };
const asset = (text) => ({ bytes: new TextEncoder().encode(text), mediaType: "text/javascript" });

test("preview transitions only accept results for the loading asset", () => {
  const loading = previewTransition(initialPreview, { type: "load", version });
  const event = { type: "loaded", assetId: "a", preview: previewOf(asset("export default {}")) };
  const ready = previewTransition(loading, event);
  assert.equal(ready.name, "ready");
  const failed = previewTransition(loading, { type: "failed", assetId: "a", message: "Offline" });
  assert.equal(failed.message, "Offline");
  const missing = previewTransition(loading, { type: "missing" });
  for (const state of [initialPreview, ready, failed, missing]) {
    assert.equal(previewTransition(state, event), state);
    assert.equal(previewTransition(state, { type: "failed", assetId: "a" }), state);
    assert.equal(previewTransition(state, { type: "load", version }).name, "loading");
    assert.equal(previewTransition(state, { type: "missing" }).name, "unavailable");
  }
  assert.equal(previewTransition(loading, { ...event, assetId: "old" }), loading);
});

test("text and binary previews are bounded; code remains literal text", () => {
  const code = '<script>throw Error("never execute")</script>';
  assert.equal(previewOf(asset(code)).text, code);
  assert.equal(previewOf({ ...asset("body {display:none}"), mediaType: "text/css" }).kind, "text");
  const long = previewOf(asset("x".repeat(TEXT_PREVIEW_LIMIT + 1)));
  assert.equal(long.text.length, TEXT_PREVIEW_LIMIT);
  assert.equal(long.truncated, true);
  const bytes = new Uint8Array(70).fill(255);
  const binary = previewOf({ bytes, mediaType: "application/octet-stream" });
  assert.equal(binary.hex.split(" ").length, 64);
  assert.equal(binary.size, 70);
  assert.equal(binary.truncated, true);
  assert.equal(previewOf({ bytes, mediaType: "audio/wav" }).bytes, bytes);
  assert.throws(() => previewOf({ bytes: new Uint8Array([255]), mediaType: "text/javascript" }));
});

test("JSON previews describe nested data while preserving the original numeric and text literals", () => {
  const read = (text) => previewOf({ ...asset(text), mediaType: "application/json" });
  const raw = '{"pilot":[1,2],"history":{"count":93000000000000001},"label":"<b>x</b>"}';
  const preview = read(raw);
  assert.equal(preview.summary, "3 fields");
  assert.deepEqual(preview.fields, [
    ["pilot", "2 items"],
    ["history", "1 field"],
    ["label", "string"],
  ]);
  assert.equal(preview.text, raw);
  assert.equal(read("null").summary, "null");
  assert.equal(read("[]").summary, "0 items");
  assert.equal(read("false").text, "false");
  const many = read(
    JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, null]))),
  );
  assert.equal(many.fields.length, 8);
  assert.equal(many.more, 12);
  assert.ok(read(JSON.stringify("x".repeat(TEXT_PREVIEW_LIMIT))).truncated);
});

test("CSV previews show the header and first rows as text, bounded, with what is left out", () => {
  const read = (text) => previewOf({ ...asset(text), mediaType: "text/csv" });
  const small = read('﻿zip,"city, state"\r\n02134,"Boston, MA"\n,"two\nlines"\n');
  assert.equal(small.kind, "csv");
  assert.deepEqual(small.header, ["zip", "city, state"]);
  // Values are the file's text: a leading zero and an empty field stay.
  assert.deepEqual(small.rows, [
    ["02134", "Boston, MA"],
    ["", "two\nlines"],
  ]);
  assert.equal(small.moreRows, 0);
  assert.equal(small.moreColumns, 0);
  assert.equal(read("a,b\n").rows.length, 0, "a header-only file");
  assert.equal(read("a\n\n1\n").rows.length, 1, "a blank line is no row");
  const wide = Array.from({ length: 15 }, (_, i) => `c${i}`).join(",");
  const many = read(
    [wide, ...Array.from({ length: 30 }, (_, r) => Array(15).fill(r).join(","))].join("\n"),
  );
  assert.equal(many.header.length, CSV_PREVIEW_COLUMNS);
  assert.equal(many.rows.length, CSV_PREVIEW_ROWS);
  assert.ok(many.rows.every((row) => row.length === CSV_PREVIEW_COLUMNS));
  assert.equal(many.moreRows, 10);
  assert.equal(many.moreColumns, 3);
  // A file that doesn't parse says why in a sentence, never as raw bytes.
  for (const [text, reason] of [
    ["a,b\n1\n", /row 1 has 1 fields; the header has 2/],
    ['a\n"open\n', /quoted field .* never closes/],
    ["", /no header row/],
    ["day,day\n1,2\n", /^This CSV can't be previewed: two columns are named day\.$/],
    ["a,,b\n1,2,3\n", /^This CSV can't be previewed: a column has no name\.$/],
  ])
    assert.throws(() => read(text), { message: reason });
  assert.throws(
    () => previewOf({ bytes: Uint8Array.of(0x61, 0x0a, 0xff), mediaType: "text/csv" }),
    { message: "This CSV can't be previewed: it isn't UTF-8 text." },
  );
});

test("source refresh and unmount cancel reads and discard stale results", async () => {
  const versions = new BehaviorSubject({ code: version });
  const calls = [];
  const read = (pageId, version, { signal }) =>
    new Promise((resolve, reject) => calls.push({ pageId, version, signal, resolve, reject }));
  const resource = sourcePreviewStore(
    { pageId: "page", pageSources: { versions: () => versions } },
    "code",
    read,
  );
  const stop = resource.start();
  await Promise.resolve();
  assert.equal(calls[0].pageId, "page");
  versions.next({ code: { ...version, asset_id: "b", revision: "2" } });
  await Promise.resolve();
  assert.equal(calls[0].signal.aborted, true);
  calls[1].resolve(asset("new"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resource.store.snapshot().preview.text, "new");
  calls[0].resolve(asset("old"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resource.store.snapshot().preview.text, "new");
  versions.next({ code: { ...version, asset_id: "c", revision: "3" } });
  await Promise.resolve();
  calls[2].reject(Error("Offline"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resource.store.snapshot().name, "failed");
  versions.next({});
  assert.equal(resource.store.snapshot().name, "unavailable");
  versions.next({ code: { ...version, media_type: "image/png" } });
  await Promise.resolve();
  assert.equal(calls.length, 3);
  versions.next({ code: { ...version, asset_id: "d", revision: "4" } });
  await Promise.resolve();
  stop();
  assert.equal(calls[3].signal.aborted, true);
  assert.equal(versions.observers.length, 0);
  assert.deepEqual(resource.store.snapshot(), initialPreview);
});
