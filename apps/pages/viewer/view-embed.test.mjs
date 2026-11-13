// A view embed in a DOM with the real chart renderer, the chart Worker's
// message loop in this process, and the real Arrow decoder: a Parquet source
// decodes once into Arrow IPC bytes, draws, and a rewritten source redraws; a view that isn't on the Page and a removed
// source each show their one sentence. Also measures what decoding and
// drawing a 100,000-row source costs.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import * as A from "@automerge/automerge";
import { setWasmUrl } from "@nteract/sift";
import { JSDOM } from "jsdom";
import { tableFromIPC } from "apache-arrow";
import { BehaviorSubject } from "rxjs";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { checkChartSpec } from "../shared/chart-spec.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { PageSourceStore } from "./page-source-store.mjs";
import { InProcessWorker } from "../test/chart-worker-in-process.mjs";
import { readDatasets } from "./chart-dataflow.mjs";
import { setChartWorker } from "./vega-chart.mjs";
import { decodeArrow } from "./view-arrow.mjs";
import { DATAFRAME_LIMITS } from "./sift-dataset.mjs";
import { VIEW_MEDIA_TYPE, projectView } from "./view-store.mjs";

const require = createRequire(import.meta.url);
const duck = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
const duckDist = path.dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"));
setWasmUrl(
  `data:application/wasm;base64,${readFileSync(require.resolve("@nteract/sift/sift.wasm")).toString("base64")}`,
);

setChartWorker(() => new InProcessWorker());

/** A decoded source's rows as the chart Worker reads them. */
const workerRows = (bytes) => readDatasets({ d: { ipc: bytes } }).d;

const PAGE = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const asset = (char) => char.repeat(64);
const writer = { principal: "agent", displayName: "Agent", driver: "MCP" };
const until = async (predicate, label) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 10_000) throw Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Parquet files written by DuckDB, by name. */
const files = {};
let dir;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pages-view-embed-"));
  const db = await duck.createDuckDB(
    {
      mvp: { mainModule: `${duckDist}/duckdb-mvp.wasm`, mainWorker: "" },
      eh: { mainModule: `${duckDist}/duckdb-eh.wasm`, mainWorker: "" },
    },
    new duck.VoidLogger(),
    duck.NODE_RUNTIME,
  );
  await db.instantiate();
  const connection = db.connect();
  const write = (name, sql) => {
    const file = path.join(dir, `${name}.parquet`);
    connection.query(`COPY (${sql}) TO '${file}' (FORMAT PARQUET)`);
    files[name] = new Uint8Array(readFileSync(file));
  };
  write("small", "SELECT * FROM (VALUES ('east', 3), ('west', 5), ('north', 2)) t(region, total)");
  write("other", "SELECT * FROM (VALUES ('east', 9), ('west', 1)) t(region, total)");
  write(
    "large",
    "SELECT 'r' || (i % 20) AS region, i::BIGINT AS total, i * 0.5 AS share FROM range(100000) t(i)",
  );
  write(
    "typed",
    `SELECT * FROM (VALUES
      (12.34::DECIMAL(10,2), 9007199254740993::BIGINT, 5::UBIGINT, '12:00:01.5'::TIME,
       INTERVAL 1 DAY, DATE '2024-01-02', TIMESTAMP '2024-01-02 03:04:05.123', 'east'::VARCHAR,
       [1, 2], 7, 8),
      (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
    ) t(price, big, unsigned, clock, span, day, stamp, region, list, "__proto__", "constructor")`,
  );
  write(
    "stamps",
    `SELECT * FROM (VALUES
      (TIMESTAMP_S '2024-01-02 03:04:05', TIMESTAMP_MS '2024-01-02 03:04:05.123',
       TIMESTAMP '2024-01-02 03:04:05.123456', TIMESTAMP_NS '2024-01-02 03:04:05.123456789',
       TIMESTAMPTZ '2024-01-02 03:04:05+02')
    ) t(s, ms, us, ns, zoned)`,
  );
  write(
    "nested",
    `SELECT * FROM (VALUES
      ({'count': 9007199254740993::BIGINT, 'price': 1.25::DECIMAL(5,2)},
       [9007199254740993::BIGINT, NULL], [1.5::DECIMAL(4,1)], MAP {'k': 2::BIGINT},
       {'constructor': 1, 'toString': 2, 'toJSON': 3, 'toArray': 4, '__proto__': 5, 'plain': 6},
       MAP {9007199254740992::BIGINT: 'even', 9007199254740993::BIGINT: 'odd'})
    ) t(record, counts, prices, lookup, members, wide)`,
  );
  connection.close();
});
after(() => rmSync(dir, { recursive: true, force: true }));

function withDom(run) {
  const { window } = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    pretendToBeVisual: true,
  });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window, document: window.document });
  return Promise.resolve(run(window)).finally(() => {
    Object.assign(globalThis, previous);
    window.close();
  });
}

function sourcesOf(map) {
  let doc = sourcesGenesis(crypto.randomUUID());
  const revisions = {};
  const set = (id, assetId) => {
    doc = A.change(doc, (draft) =>
      setSources(
        draft,
        [
          {
            op: "set_source",
            source_id: id,
            name: id,
            asset_id: assetId,
            source_revision: revisions[id] ?? null,
          },
        ],
        { mediaTypes: new Map([[assetId, PARQUET_MEDIA_TYPE]]), by: writer },
      ),
    );
    revisions[id] = doc.sources[id].revision;
    return doc;
  };
  for (const [id, assetId] of Object.entries(map)) set(id, assetId);
  return {
    set,
    get doc() {
      return doc;
    },
  };
}

/** A store whose assets are the Parquet files above: asset(char) → file. */
function storeOver(sources, byAsset) {
  const doc$ = new BehaviorSubject(sources.doc);
  const store = new PageSourceStore({
    pageId: PAGE,
    doc$,
    request: async (url) =>
      new Response(byAsset[url.slice(-64)], { headers: { "content-type": PARQUET_MEDIA_TYPE } }),
  });
  return { doc$, store };
}

const spec = {
  data: { name: "sales" },
  mark: "bar",
  encoding: {
    x: { field: "region", type: "nominal" },
    y: { field: "total", type: "quantitative", aggregate: "sum" },
  },
};
const ready = (revision = "1", fields = {}) => ({
  status: "ready",
  view: {
    view_id: "sales",
    title: "Sales by region",
    media_type: VIEW_MEDIA_TYPE,
    spec,
    data: { sales: { source_id: "sales" } },
    revision,
    specText: JSON.stringify(spec),
    ...fields,
  },
});

test("a Parquet source decodes once into Arrow IPC bytes a chart reads", async () => {
  const bytes = await decodeArrow(files.small, DATAFRAME_LIMITS);
  assert.ok(bytes instanceof Uint8Array);
  const table = tableFromIPC(bytes);
  assert.equal(table.numRows, 3);
  assert.deepEqual(
    table.schema.fields.map((field) => field.name),
    ["region", "total"],
  );
});

test("each column reaches a chart in a form Vega reads", async () => {
  const [row, empty] = workerRows(await decodeArrow(files.typed, DATAFRAME_LIMITS));
  assert.ok(!Object.hasOwn(row, "__proto__"));
  assert.equal(row.price, 12.34);
  assert.equal(row.big, 9007199254740992, "past the safe range: the nearest double");
  assert.equal(row.unsigned, 5);
  assert.equal(row.clock, 43_201_500, "time of day in milliseconds");
  assert.equal(row.span, null);
  assert.equal(row.day, Date.UTC(2024, 0, 2));
  assert.equal(row.stamp, Date.UTC(2024, 0, 2, 3, 4, 5, 123));
  assert.equal(row.region, "east");
  assert.deepEqual(row.list, [1, 2]);
  assert.equal(Object.getPrototypeOf(row), null, "rows hold only their columns");
  assert.ok(Object.hasOwn(row, "constructor"));
  assert.equal(row.constructor, 8);
  for (const name of ["price", "big", "unsigned", "clock", "span", "day", "stamp", "region"])
    assert.equal(empty[name], null, `${name} keeps its null`);
});

test("timestamps read as epoch milliseconds in every unit, a zoned one as its instant", async () => {
  const [row] = workerRows(await decodeArrow(files.stamps, DATAFRAME_LIMITS));
  const at = Date.UTC(2024, 0, 2, 3, 4, 5);
  assert.equal(row.s, at);
  assert.equal(row.ms, at + 123);
  assert.ok(Math.abs(row.us - (at + 123.456)) < 1e-3, "microseconds keep their fraction");
  assert.ok(Math.abs(row.ns - (at + 123.456789)) < 1e-3, "nanoseconds keep their fraction");
  assert.equal(row.zoned, Date.UTC(2024, 0, 2, 1, 4, 5), "+02:00 is two hours before UTC");
});

test("values inside lists, structs and maps read as numbers, and rows serialize", async () => {
  const rows = workerRows(await decodeArrow(files.nested, DATAFRAME_LIMITS));
  const [row] = rows;
  assert.deepEqual({ ...row.record }, { count: 9007199254740992, price: 1.25 });
  assert.deepEqual(row.counts, [9007199254740992, null]);
  assert.deepEqual(row.prices, [1.5]);
  assert.deepEqual({ ...row.lookup }, { k: 2 });
  assert.doesNotThrow(() => JSON.stringify(rows));
});

test("struct fields named like object members read their values, and map keys stay apart", async () => {
  const [row] = workerRows(await decodeArrow(files.nested, DATAFRAME_LIMITS));
  const members = row.members;
  for (const [name, value] of Object.entries({
    constructor: 1,
    toString: 2,
    toJSON: 3,
    toArray: 4,
    plain: 6,
  }))
    assert.ok(Object.hasOwn(members, name) && members[name] === value, `${name} is ${value}`);
  assert.ok(!Object.hasOwn(members, "__proto__"), "a __proto__ field is dropped");
  assert.equal(Object.getPrototypeOf(members), Object.prototype);
  assert.deepEqual(
    Object.entries(row.wide).sort(),
    [
      ["9007199254740992", "even"],
      ["9007199254740993", "odd"],
    ],
    "two keys one double apart keep their own digits",
  );
});

test("an embed draws its view, redraws on a new source version, and shows its sentences", () =>
  withDom(async (window) => {
    const { mountViewEmbed } = await import("./view-embed.mjs");
    const { mount } = await import("./vega-chart.mjs");
    const sources = sourcesOf({ sales: asset("a") });
    const { doc$, store } = storeOver(sources, {
      [asset("a")]: files.small,
      [asset("b")]: files.other,
    });
    const view$ = new BehaviorSubject({ status: "pending" });
    const container = window.document.body.appendChild(window.document.createElement("div"));
    const embed = mountViewEmbed(container, {
      view$,
      sources: store,
      decode: decodeArrow,
      checkChartSpec,
      mount,
    });
    const root = container.querySelector(".pages-view");
    assert.equal(root.dataset.viewState, "waiting");
    assert.equal(root.querySelector(".pages-chart-message").textContent, "Loading chart…");

    view$.next(ready());
    await until(() => root.dataset.viewState === "drawn", "the first draw");
    await until(() => root.querySelector(".pages-view-chart svg"), "the chart's SVG");
    const figure = root.querySelector(".pages-view-chart figure.pages-chart");
    assert.equal(figure.querySelector(".pages-chart-title").textContent, "Sales by region");
    assert.equal(root.querySelector(".pages-view-placeholder").hidden, true);
    const bars = () => root.querySelectorAll(".pages-view-chart path[role='graphics-symbol']");
    await until(() => bars().length === 3, "three bars");

    // An agent points the source at a new asset: the chart redraws from it.
    doc$.next(sources.set("sales", asset("b")));
    await until(() => bars().length === 2, "two bars from the new asset");
    assert.equal(
      root.querySelectorAll("figure.pages-chart:not(.pages-view-placeholder)").length,
      1,
    );

    // The source goes away: the chart draws empty and names it.
    doc$.next(
      A.change(sources.doc, (draft) => {
        delete draft.sources.sales;
      }),
    );
    await until(() => !root.querySelector(".pages-view-note").hidden, "the note");
    assert.equal(
      root.querySelector(".pages-view-note").textContent,
      `This chart's source "sales" isn't on this Page.`,
    );

    // A view that isn't on this Page shows one sentence in the bare frame.
    view$.next({
      status: "unavailable",
      reason: "missing",
      sentence: "This chart isn't on this Page.",
    });
    await until(() => root.dataset.viewState === "blocked", "the sentence");
    assert.equal(root.querySelector(".pages-view-placeholder").hidden, false);
    assert.equal(
      root.querySelector(".pages-view-placeholder .pages-chart-message").textContent,
      "This chart isn't on this Page.",
    );
    assert.equal(root.querySelector(".pages-view-chart").childElementCount, 0);
    embed.destroy();
    assert.equal(container.childElementCount, 0);
  }));

/** wordgard.css's reserve rule: the selector an embed matches while it
 * holds `--pages-view-reserve`. */
const RESERVED = (() => {
  const css = readFileSync(new URL("./wordgard.css", import.meta.url), "utf8");
  const at = css.indexOf("min-height: var(--pages-view-reserve");
  const open = css.lastIndexOf("{", at);
  const start = css.lastIndexOf("}", open) + 1;
  return css
    .slice(start, open)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
})();

test("an embed holds its reserve while its sources are unknown, unreachable, and until the chart draws", () =>
  withDom(async (window) => {
    const { mountViewEmbed } = await import("./view-embed.mjs");
    const { mount } = await import("./vega-chart.mjs");
    const sources = sourcesOf({ sales: asset("a") });
    const doc$ = new BehaviorSubject(undefined);
    const store = new PageSourceStore({
      pageId: PAGE,
      doc$,
      request: async () =>
        new Response(files.small, { headers: { "content-type": PARQUET_MEDIA_TYPE } }),
    });
    const answer$ = new BehaviorSubject("unknown");
    const section = window.document.body.appendChild(window.document.createElement("section"));
    section.className = "wordgard-widget wordgard-view-embed";
    const canvas = section.appendChild(window.document.createElement("div"));
    canvas.className = "wordgard-view-canvas";
    const view$ = new BehaviorSubject(ready());
    const embed = mountViewEmbed(canvas, {
      view$,
      sources: store,
      sourcesAnswer$: answer$,
      decode: decodeArrow,
      checkChartSpec,
      mount,
    });
    const root = canvas.querySelector(".pages-view");
    const message = () => root.querySelector(".pages-view-placeholder .pages-chart-message");
    const note = root.querySelector(".pages-view-note");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(root.dataset.viewState, "waiting");
    assert.equal(message().textContent, "Loading chart…");
    assert.ok(section.matches(RESERVED), "unknown: reserved");
    answer$.next("unreachable");
    await until(() => root.dataset.viewState === "unreachable", "unreachable");
    assert.equal(
      message().textContent,
      "This chart's data isn't on this device yet. It draws when Pages reconnects.",
    );
    assert.equal(note.hidden, true, "nothing claims the source is missing");
    assert.ok(section.matches(RESERVED), "unreachable: reserved");
    // The connection opens the sources document.
    doc$.next(sources.doc);
    answer$.next("known");
    await until(() => root.dataset.viewState === "drawn", "the draw");
    assert.ok(section.matches(RESERVED), "drawing: still reserved");
    await until(
      () => root.querySelector(".pages-view-chart .pages-chart[data-chart-status=rendered]"),
      "the rendered chart",
    );
    assert.equal(section.matches(RESERVED), false, "rendered: the chart holds the space");
    assert.equal(note.hidden, true);
    assert.equal(root.querySelectorAll(".pages-view-chart figure.pages-chart").length, 1);
    embed.destroy();
    section.remove();
  }));

test("a padded stored title reaches the chart and its label trimmed, and an unbounded one is refused", () =>
  withDom(async (window) => {
    const { mountViewEmbed } = await import("./view-embed.mjs");
    const { mount } = await import("./vega-chart.mjs");
    const { store } = storeOver(sourcesOf({ sales: asset("a") }), { [asset("a")]: files.small });
    const stored = (title) =>
      A.from({
        title,
        media_type: VIEW_MEDIA_TYPE,
        spec: JSON.stringify(spec),
        data: { sales: { source_id: "sales" } },
        revision: "1",
        producer: { kind: "agent", at: "2026-11-12T00:00:00.000Z", by: { principal: "a" } },
      });
    const view$ = new BehaviorSubject(projectView("sales", stored(`  Sales${" ".repeat(150)}`)));
    const container = window.document.body.appendChild(window.document.createElement("div"));
    const embed = mountViewEmbed(container, {
      view$,
      sources: store,
      decode: decodeArrow,
      checkChartSpec,
      mount,
    });
    const root = container.querySelector(".pages-view");
    await until(() => root.dataset.viewState === "drawn", "the draw");
    const figure = root.querySelector(".pages-view-chart figure.pages-chart");
    assert.equal(figure.querySelector(".pages-chart-title").textContent, "Sales");
    assert.equal(root.querySelector(".pages-view-placeholder").getAttribute("aria-label"), "Sales");

    view$.next(projectView("sales", stored(`S${" ".repeat(10_000_000)}`)));
    await until(() => root.dataset.viewState === "blocked", "the refusal");
    assert.equal(
      root.querySelector(".pages-view-placeholder .pages-chart-message").textContent,
      "This chart's view can't be read.",
    );
    const placeholder = root.querySelector(".pages-view-placeholder");
    assert.equal(placeholder.getAttribute("aria-label"), "Chart");
    assert.ok(!root.textContent.includes("   "), "no padding reaches the DOM");
    embed.destroy();
  }));

test("a 100,000-row source decodes and draws, and the cost is reported", () =>
  withDom(async (window) => {
    const { mountViewEmbed } = await import("./view-embed.mjs");
    const { mount } = await import("./vega-chart.mjs");
    const started = performance.now();
    const bytes = await decodeArrow(files.large, DATAFRAME_LIMITS);
    const decoded = performance.now();
    assert.equal(tableFromIPC(bytes).numRows, 100_000);
    const rows = workerRows(bytes);
    const converted = performance.now();
    assert.equal(rows.length, 100_000);
    assert.equal(typeof rows[0].total, "number", "a 64-bit integer column reads as numbers");
    assert.equal(rows[3].share, 1.5, "a decimal column reads at its scale");
    assert.equal(rows[99_999].share, 49_999.5);

    const sources = sourcesOf({ sales: asset("c") });
    const { store } = storeOver(sources, { [asset("c")]: files.large });
    const view$ = new BehaviorSubject(ready());
    const container = window.document.body.appendChild(window.document.createElement("div"));
    const drawStart = performance.now();
    const embed = mountViewEmbed(container, {
      view$,
      sources: store,
      decode: decodeArrow,
      checkChartSpec,
      mount,
    });
    await until(() => container.querySelector(".pages-view-chart svg"), "the large chart");
    const drawn = performance.now();
    console.log(
      `[view-embed] 100,000 rows: parquet ${(files.large.byteLength / 1024).toFixed(0)} KiB, ` +
        `decode ${(decoded - started).toFixed(0)} ms, rows ${(converted - decoded).toFixed(0)} ms, ` +
        `embed first draw ${(drawn - drawStart).toFixed(0)} ms`,
    );
    embed.destroy();
  }));
