import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  applyPageOperation,
  createPageData,
  initializePage,
  insertedAssets,
  orderedBlockIds,
} from "./page.mjs";
import { projectReadContent } from "./read-content.mjs";
import { textPath } from "./richtext.mjs";
import { documentFeatures } from "./schema-features.mjs";
import { PARQUET_MEDIA_TYPE, dataframeAttrs, readDataframe } from "../shared/dataset-assets.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const first = "a".repeat(64),
  second = "b".repeat(64);
const src = (asset) => `/api/pages/${pageId}/assets/${asset}`;
const edit = (doc, operations) => {
  let result;
  const next = A.change(A.clone(doc), (draft) => {
    result = applyPageOperation(draft, { operation: "edit_page", arguments: { operations } });
  });
  return { doc: next, result };
};
const setSource = (source_id, asset_id, expected_revision = null) => ({
  op: "set_source",
  source_id,
  name: source_id,
  asset_id,
  expected_revision,
});
const withSources = () =>
  edit(
    A.change(A.from(createPageData({ pageId })), (doc) => initializePage(doc, "Intro")),
    [setSource("daily", first), setSource("tools", second)],
  ).doc;
const node = (attrs) => ({ op: "insert_node", node: { type: "dataframe", attrs } });
const chart = (names) =>
  JSON.stringify({
    layer: names.map((name) => ({ data: { name }, mark: "bar" })),
  });
const storedAttrs = (doc, id) =>
  Object.fromEntries(
    Object.entries(A.spans(doc, textPath(id))[0].value.attrs).map(([k, v]) => [k, String(v)]),
  );

test("insert_node with a source stores it beside the asset it holds now", () => {
  const { doc, result } = edit(withSources(), [node({ source: "daily", title: "Daily" })]);
  const id = orderedBlockIds(doc).at(-1);
  assert.deepEqual(result.inserted_nodes, [
    {
      block_id: id,
      type: "dataframe",
      attrs: {
        asset_id: first,
        src: src(first),
        media_type: PARQUET_MEDIA_TYPE,
        title: "Daily",
        source: "daily",
      },
    },
  ]);
  assert.deepEqual(storedAttrs(doc, id), {
    src: src(first),
    media_type: PARQUET_MEDIA_TYPE,
    title: "Daily",
    source: "daily",
  });
  assert.ok(documentFeatures(doc).includes("dataframe-source"));
  assert.ok(documentFeatures(doc).includes("page-sources"));
});

test("a refresh moves the source, not the node: src stays the version it was written with", () => {
  let { doc } = edit(withSources(), [node({ source: "daily" })]);
  doc = edit(doc, [setSource("daily", second, "1")]).doc;
  const id = orderedBlockIds(doc).at(-1);
  assert.equal(storedAttrs(doc, id).src, src(first));
  assert.equal(doc.sources.daily.current.asset_id, second);
});

test("read_page's outline reports the source in insert_node's receipt shape", () => {
  const { doc, result } = edit(withSources(), [node({ source: "daily" })]);
  const entry = projectReadContent(doc, {}).outline.find((item) => item.type === "dataframe");
  assert.deepEqual(entry.attrs, result.inserted_nodes[0].attrs);
});

test("a chart over sources needs every name registered and its source among them", () => {
  const { result } = edit(withSources(), [
    node({ source: "daily", chart: chart(["daily", "tools"]) }),
  ]);
  assert.equal(result.inserted_nodes[0].attrs.source, "daily");
  assert.throws(
    () => edit(withSources(), [node({ source: "daily", chart: chart(["daily", "missing"]) })]),
    { code: "source_not_found" },
  );
  assert.throws(
    () => edit(withSources(), [node({ source: "daily", chart: chart(["tools"]) })]),
    /one of its data names/,
  );
});

test("a node names an asset or a source, never both, and the source must exist", () => {
  for (const attrs of [
    { source: "daily", asset_id: first },
    { source: "Daily" },
    { source: "__proto__" },
    {},
  ])
    assert.throws(() => edit(withSources(), [node(attrs)]), /insert_node requires/, attrs);
  assert.throws(() => edit(withSources(), [node({ source: "weekly" })]), {
    code: "source_not_found",
  });
});

test("a source-bound insert asks the host to check no asset", () => {
  assert.deepEqual(insertedAssets([node({ source: "daily" })], pageId), []);
  assert.equal(insertedAssets([node({ asset_id: first })], pageId).length, 1);
});

test("stored attrs keep a valid source and drop a malformed one on read", () => {
  const attrs = { src: src(first), media_type: PARQUET_MEDIA_TYPE, source: "daily" };
  assert.equal(dataframeAttrs(attrs).source, "daily");
  assert.equal(readDataframe(attrs).source, "daily");
  assert.equal(readDataframe({ ...attrs, source: "Bad ID" }).source, undefined);
  assert.throws(() => dataframeAttrs({ ...attrs, source: "Bad ID" }), /Page source ID/);
});
