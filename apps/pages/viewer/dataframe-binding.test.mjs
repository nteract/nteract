import test from "node:test";
import assert from "node:assert/strict";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { fetchDataset } from "./sift-dataset.mjs";
import { assetPath, bindingKey, storedBinding, pinnedBinding } from "./dataframe-binding.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const node = (title = "Usage") => ({
  src: `/api/pages/${pageId}/assets/${"a".repeat(64)}`,
  media_type: PARQUET_MEDIA_TYPE,
  title,
});

test("every stored node draws its pinned asset", () => {
  assert.deepEqual(pinnedBinding(node()), { asset_id: "a".repeat(64) });
  assert.equal(pinnedBinding({ src: "https://example.com/x.parquet" }), null);
  assert.equal(pinnedBinding(null), null);
  assert.deepEqual(storedBinding(node()), pinnedBinding(node()));
});

test("a pinned node fetches its own src, so a src on another Page is refused with no request", async () => {
  const otherPage = "44444444-4444-4444-8444-444444444444";
  const foreign = { ...node(), src: `/api/pages/${otherPage}/assets/${"a".repeat(64)}` };
  const path = assetPath(foreign.src, pageId, pinnedBinding(foreign));
  assert.equal(path, foreign.src);
  const requests = [];
  await assert.rejects(
    fetchDataset(path, { pageId, request: async (url) => requests.push(url) }),
    /belongs to another Page/,
  );
  assert.deepEqual(requests, []);
  // This Page's pin is its own src too; only another asset names a new path.
  assert.equal(assetPath(node().src, pageId, pinnedBinding(node())), node().src);
  assert.equal(
    assetPath(node().src, pageId, { asset_id: "b".repeat(64) }),
    `/api/pages/${pageId}/assets/${"b".repeat(64)}`,
  );
  assert.equal(assetPath(node().src, pageId, null), node().src);
});

test("bindings compare by what they name", () => {
  assert.equal(bindingKey({ source_id: "usage" }), "source:usage:follow");
  assert.equal(bindingKey({ asset_id: "a" }), "asset:a");
  assert.equal(bindingKey(null), "none");
});

test("stored source bindings follow or pin without an asset fallback", () => {
  for (const binding of [{ source_id: "usage" }, { source_id: "usage", revision: "2" }])
    assert.deepEqual(storedBinding({ binding }), binding);
  assert.notEqual(
    bindingKey({ source_id: "usage" }),
    bindingKey({ source_id: "usage", revision: "1" }),
  );
});
