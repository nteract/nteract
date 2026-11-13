// A view node copied out of one Page and pasted into another keeps its node
// (and only its view id): the copy registry records nothing for it, the
// dataframe copier doesn't hold the paste for it, and the paste filter leaves
// it as it is. On the other Page its embed then says the chart isn't there.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { markCopiedHTML, COPY_ATTR } from "./copy-registry.mjs";
import { createDataframeCopier } from "./dataframe-copy.mjs";
import { filterPastedDataframes, foreignDataframes } from "./wordgard-model.mjs";

const here = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const there = "1c9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const viewFigure = (viewId) =>
  `<figure data-pages-view data-view-id="${viewId}" wg-content="true"></figure>`;
const dataframeFigure = (pageId, assetId) =>
  `<figure data-pages-dataframe='${JSON.stringify({
    src: `/api/pages/${pageId}/assets/${assetId}`,
    media_type: "application/vnd.apache.parquet",
    title: "Usage",
  })}'>Usage</figure>`;

function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
  };
}

test("copying a view records nothing and marks nothing", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const parser = new dom.window.DOMParser();
  const storage = memoryStorage();
  const html = `<p>Before</p>${viewFigure("sales")}<p>After</p>`;
  assert.equal(markCopiedHTML(html, there, { parser, storage: () => storage }), html);
  assert.equal(storage.items.size, 0);
  // Beside a table, only the table's asset is recorded.
  const asset = "a".repeat(64);
  const mixed = viewFigure("sales") + dataframeFigure(there, asset);
  const marked = markCopiedHTML(mixed, there, { parser, storage: () => storage });
  assert.ok(marked.includes(COPY_ATTR));
  const [record] = JSON.parse([...storage.items.values()][0]);
  assert.deepEqual(record.assets, [asset]);
});

test("pasting a view into another Page keeps the node and copies nothing", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const parser = new dom.window.DOMParser();
  const html = `<p>Copied</p>${viewFigure("sales")}`;
  assert.deepEqual(foreignDataframes(html, here, parser), []);
  assert.equal(filterPastedDataframes(html, here, parser), html, "the view figure is untouched");
  const copier = createDataframeCopier({
    pageId: here,
    parser,
    lookup: () => null,
    copy: () => assert.fail("a view copies nothing"),
    insert: () => assert.fail("a view paste isn't held"),
  });
  assert.equal(
    copier.accept(html, () => ({ from: 0, to: 0 })),
    false,
  );
  assert.equal(copier.state.name, "idle");
});
