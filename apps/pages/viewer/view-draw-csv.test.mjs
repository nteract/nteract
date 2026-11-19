// A chart over a CSV source: the source store converts it to Arrow IPC once
// and the chart draws those bytes; a new CSV version redraws; a CSV that
// can't be converted says why after the usual sentence.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { BehaviorSubject } from "rxjs";
import { tableFromIPC } from "apache-arrow";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { CSV_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { checkChartSpec } from "../shared/chart-spec.mjs";
import { PageSourceStore } from "./page-source-store.mjs";
import { VIEW_STATUS, createViewDraw } from "./view-draw.mjs";
import { VIEW_MEDIA_TYPE } from "./view-store.mjs";
import { csvArrow } from "./csv-arrow.mjs";
import { decodeArrow } from "./view-arrow.mjs";

const PAGE = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const writer = { principal: "agent", displayName: "Agent", driver: "MCP" };
// The conversion runs in WASM, so a load takes more than a few turns.
async function until(check) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out");
}
const sha256 = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");

const files = new Map();
async function csvAsset(text) {
  const bytes = new TextEncoder().encode(text);
  const id = await sha256(bytes);
  files.set(id, bytes);
  return id;
}
const first = await csvAsset("region,sales,day\nNorth,3,2024-01-01\nSouth,4.5,2024-01-02\n");
const second = await csvAsset("region,sales,day\nNorth,7,2024-02-01\n");
const ragged = await csvAsset("region,sales\nNorth\n");
const tooMany = await csvAsset(
  "region\n" + Array.from({ length: 250_001 }, (_, i) => `r${i % 10}`).join("\n") + "\n",
);

const spec = {
  data: { name: "sales" },
  mark: "bar",
  encoding: {
    x: { field: "region", type: "nominal" },
    y: { field: "sales", type: "quantitative" },
  },
};

function fixture(assetId) {
  let doc = sourcesGenesis(crypto.randomUUID());
  let revision = null;
  const set = (id) => {
    doc = A.change(doc, (draft) =>
      setSources(
        draft,
        [
          {
            op: "set_source",
            source_id: "sales",
            name: "sales",
            asset_id: id,
            source_revision: revision,
          },
        ],
        { mediaTypes: new Map([[id, CSV_MEDIA_TYPE]]), by: writer },
      ),
    );
    revision = doc.sources.sales.revision;
    return doc;
  };
  const doc$ = new BehaviorSubject(set(assetId));
  const store = new PageSourceStore({
    pageId: PAGE,
    doc$,
    request: async (url) =>
      new Response(files.get(url.slice(-64)), {
        headers: { "content-type": CSV_MEDIA_TYPE, "x-pages-media-type": CSV_MEDIA_TYPE },
      }),
    csvArrow: async () => csvArrow,
  });
  const view$ = new BehaviorSubject({
    status: "ready",
    view: {
      view_id: "sales",
      title: "Sales",
      media_type: VIEW_MEDIA_TYPE,
      spec,
      data: { sales: { source_id: "sales" } },
      revision: "1",
      specText: JSON.stringify(spec),
    },
  });
  const draws = [];
  const shown = [];
  const draw = createViewDraw({
    view$,
    sources: store,
    decode: decodeArrow,
    checkChartSpec,
    render: {
      draw(input) {
        draws.push(input);
        return { destroy() {} };
      },
      show: (status) => shown.push(status),
    },
  });
  return {
    draws,
    shown,
    move: (id) => doc$.next(set(id)),
    destroy: () => (draw.destroy(), store.destroy()),
  };
}

test("a chart over a CSV source draws its Arrow IPC and redraws on a new version", async () => {
  const f = fixture(first);
  await until(() => f.draws.length === 1);
  const rows = tableFromIPC(f.draws[0].datasets.sales)
    .toArray()
    .map((row) => row.toJSON());
  assert.deepEqual(
    rows.map((row) => [row.region, row.sales]),
    [
      ["North", 3],
      ["South", 4.5],
    ],
  );
  f.move(second);
  await until(() => f.draws.length === 2);
  assert.equal(tableFromIPC(f.draws[1].datasets.sales).numRows, 1);
  assert.equal(f.shown.at(-1).state, "drawn");
  f.destroy();
});

test("a CSV that can't be converted shows the failed sentence and the converter's reason", async () => {
  const f = fixture(ragged);
  await until(() => f.shown.at(-1)?.state === "failed");
  assert.equal(f.draws.length, 0);
  const { sentence, state } = f.shown.at(-1);
  assert.equal(state, "failed");
  assert.ok(sentence.startsWith(`${VIEW_STATUS.failed} This file can't be read as CSV: `));
  assert.match(sentence, /unequal lengths/);
  assert.ok(sentence.length <= VIEW_STATUS.failed.length + 241, "bounded");
  // A limit is a reason too; nothing is truncated to fit it.
  f.move(tooMany);
  await until(() => /row limit/.test(f.shown.at(-1)?.sentence ?? ""));
  assert.match(f.shown.at(-1).sentence, /row limit \(250001 > 250000\)/);
  // A version that converts draws, with no reason left behind.
  f.move(first);
  await until(() => f.shown.at(-1)?.state === "drawn");
  assert.equal(f.shown.at(-1).sentence, null);
  f.destroy();
});
