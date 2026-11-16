import assert from "node:assert/strict";
import test from "node:test";
import { BehaviorSubject } from "rxjs";
import {
  initialPreview,
  previewTransition,
  previewOf,
  sourcePreviewStore,
  TEXT_PREVIEW_LIMIT,
} from "./source-preview-store.mjs";
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
