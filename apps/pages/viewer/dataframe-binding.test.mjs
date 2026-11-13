import test from "node:test";
import assert from "node:assert/strict";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { fetchDataset } from "./sift-dataset.mjs";
import {
  TEST_BINDING_GLOBAL,
  assetPath,
  bindingKey,
  editorBinding,
  pinnedBinding,
} from "./dataframe-binding.mjs";

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
  assert.equal(editorBinding({ location: { hostname: "pages.example" } }), pinnedBinding);
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
  assert.equal(bindingKey({ source_id: "usage" }), "source:usage");
  assert.equal(bindingKey({ asset_id: "a" }), "asset:a");
  assert.equal(bindingKey(null), "none");
});

test("a browser test's binding applies on a loopback origin only, and falls back to the pin", () => {
  const custom = (dataframe) => (dataframe.title === "Follows" ? { source_id: "usage" } : null);
  const elsewhere = { location: { hostname: "pages.example" }, [TEST_BINDING_GLOBAL]: custom };
  assert.equal(editorBinding(elsewhere), pinnedBinding);
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    const binding = editorBinding({ location: { hostname }, [TEST_BINDING_GLOBAL]: custom });
    assert.deepEqual(binding(node("Follows")), { source_id: "usage" });
    assert.deepEqual(binding(node("Other")), { asset_id: "a".repeat(64) });
  }
  const throwing = editorBinding({
    location: { hostname: "localhost" },
    [TEST_BINDING_GLOBAL]: () => {
      throw Error("broken");
    },
  });
  assert.deepEqual(throwing(node()), { asset_id: "a".repeat(64) });
});
