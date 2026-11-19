// An executable view loads only what its own record binds. A Page source is
// data to the view whatever its id, so a source named widget-imports is read
// by nothing and listed like any other source.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { JSDOM } from "jsdom";
import { BehaviorSubject, of } from "rxjs";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { readView, setView, viewGenesis } from "../model/view-doc.mjs";
import { imageAssetUrl } from "../shared/image-assets.mjs";
import { anywidgetPlan, mount, planChange } from "./anywidget-view.mjs";
import { PageSourceStore } from "./page-source-store.mjs";
import { projectSourcesPanel } from "./sources-panel-store.mjs";
import { sourceLine } from "./source-line.mjs";
import { parquetColumns } from "./parquet-columns.mjs";
import { csvArrow as convertCsv } from "./csv-arrow.mjs";
import { parquetFixture } from "../test/parquet-fixture.mjs";

// The CSV converter, as a source store loads it.
const csvArrow = async () => convertCsv;

const PAGE = "33333333-3333-4333-8333-333333333333";
const by = { principal: "account:test", displayName: "Test", driver: "Agent" };
// A loopback output host serves a catalog (widget-imports.mjs).
const FRAME = "http://127.0.0.1:9896/frame/v2/";
const encoder = new TextEncoder();
const sha256 = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");

const entry = encoder.encode("export default { render() {} };");
const entryId = await sha256(entry);
const moduleBytes = encoder.encode("export const injected = true;");
const moduleId = await sha256(moduleBytes);
const declaration = encoder.encode(
  JSON.stringify({
    catalog: "standard",
    catalog_revision: "e".repeat(64),
    imports: ["react"],
    modules: [{ name: "injected", source_id: "entry", revision: "1", asset_id: moduleId }],
  }),
);
const declarationId = await sha256(declaration);
const assets = new Map([
  [entryId, { bytes: entry, media_type: "text/javascript" }],
  [moduleId, { bytes: moduleBytes, media_type: "text/javascript" }],
  [declarationId, { bytes: declaration, media_type: "application/octet-stream" }],
]);

const sourcesDoc = A.change(sourcesGenesis(PAGE), (draft) =>
  setSources(
    draft,
    [
      {
        op: "set_source",
        source_id: "entry",
        name: "Entry",
        source_revision: null,
        asset_id: entryId,
      },
      {
        op: "set_source",
        source_id: "widget-imports",
        name: "Imports",
        source_revision: null,
        asset_id: declarationId,
      },
    ],
    { by, mediaTypes: new Map([...assets].map(([id, asset]) => [id, asset.media_type])) },
  ),
);

function viewRecord(catalogRevision) {
  const doc = A.change(viewGenesis("44444444-4444-4444-8444-444444444444"), (draft) =>
    setView(
      draft,
      {
        op: "set_view",
        view_id: "daily",
        title: "Daily",
        view_type: "module",
        module: { source_id: "entry" },
        view_revision: null,
      },
      { sourcesDoc, by, catalogRevision },
    ),
  );
  return readView(doc, "daily");
}

async function mountView(view) {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const requested = [];
  const request = async (url) => {
    requested.push(url);
    const id = url.split("/").at(-1);
    const asset = assets.get(id);
    if (!asset) return new Response(null, { status: 404 });
    return new Response(asset.bytes, { headers: { "content-type": asset.media_type } });
  };
  const sources = new PageSourceStore({
    pageId: PAGE,
    doc$: new BehaviorSubject(sourcesDoc),
    request,
  });
  let mounted;
  const settled = new Promise((resolve) => {
    mounted = mount(window.document.body, {
      view$: of({ status: "ready", view }),
      sources,
      frameUrl: FRAME,
      theme: { subscribe: () => () => {}, getSnapshot: () => ({ resolved: "light" }) },
      mountOutput(_container, payload, options) {
        resolve({ payload, frameUrl: options.frameUrl });
        return { destroy() {}, setHostContext() {} };
      },
    });
    const root = window.document.querySelector(".pages-anywidget-view");
    new window.MutationObserver(() => {
      if (root.dataset.outputState === "failed")
        resolve({ failed: root.querySelector("p").textContent });
    }).observe(root, { attributes: true, subtree: true, childList: true });
  });
  const result = await settled;
  mounted.destroy();
  sources.destroy();
  return { ...result, requested };
}

test("a source named widget-imports is an ordinary source an executable view never loads", async () => {
  const declarationUrl = imageAssetUrl(PAGE, declarationId);
  const moduleUrl = imageAssetUrl(PAGE, moduleId);
  for (const catalog of [null, "a".repeat(64)]) {
    const view = viewRecord(catalog);
    assert.equal(view.catalog_revision, catalog ?? undefined);
    const mounted = await mountView(view);
    assert.equal(mounted.failed, undefined, mounted.failed);
    assert.deepEqual(mounted.requested, [imageAssetUrl(PAGE, entryId)]);
    assert.ok(!mounted.requested.includes(declarationUrl));
    assert.ok(!mounted.requested.includes(moduleUrl));
    assert.equal(mounted.payload.imports, undefined);
    assert.equal(new URL(mounted.frameUrl).searchParams.get("catalog"), catalog);
  }

  const view = viewRecord("a".repeat(64));
  const panel = projectSourcesPanel(
    sourcesDoc,
    { unreadableBlocks: 0, placements: [{ key: "v:0", kind: "view", viewId: "daily" }] },
    { daily: { status: "ready", view } },
  );
  const listed = panel.sources.find((source) => source.source_id === "widget-imports");
  assert.equal(listed.name, "Imports");
  assert.equal(listed.media_type, "application/octet-stream");
  assert.deepEqual(listed.uses, []);
  assert.ok(panel.sources.every((source) => source.uses.every((use) => use.role !== "catalog")));
  assert.deepEqual(
    panel.libraryPins.map((pin) => pin.digest),
    ["a".repeat(64)],
  );
  const line = sourceLine(
    {
      "widget-imports": {
        source_id: "widget-imports",
        name: "Imports",
        revision: "1",
        set_at: new Date().toISOString(),
        media_type: "application/octet-stream",
        asset_id: declarationId,
      },
    },
    Date.now(),
  );
  assert.deepEqual(
    line.entries.map((entry) => entry.id),
    ["widget-imports"],
  );
});

// A module view keeps its frame when a followed data source moves. Its plan
// splits code identity from data inputs.
const PARQUET = "application/vnd.apache.parquet";
const files = {
  entry2: [encoder.encode("export function render() { /* v2 */ }"), "text/javascript"],
  label1: [encoder.encode("first label"), "application/octet-stream"],
  label2: [encoder.encode("second label"), "application/octet-stream"],
  table1: [parquetFixture({ days: 5 }), PARQUET],
  table2: [parquetFixture({ days: 9 }), PARQUET],
  // A Parquet-typed file Sift cannot decode.
  tableBad: [encoder.encode("PAR1 not a Parquet file PAR1"), PARQUET],
  // The table source moving to a file that arrives whole.
  tableWhole: [encoder.encode("not parquet"), "application/octet-stream"],
  labelBig: [encoder.encode("L".repeat(20)), "application/octet-stream"],
  note1: [encoder.encode("n"), "application/octet-stream"],
  note2: [encoder.encode("n".repeat(10)), "application/octet-stream"],
  cities1: [encoder.encode("city,people\nOslo,3\nBergen,\n"), "text/csv"],
  cities2: [encoder.encode("city,people\nOslo,4\n"), "text/csv"],
  // A CSV uploaded before CSV was a source type.
  citiesBinary: [encoder.encode("city,people\nTromsø,1\n"), "application/octet-stream"],
  citiesRagged: [encoder.encode("city,people\nOslo\n"), "text/csv"],
};
const ids = {};
for (const [name, [bytes, media_type]] of Object.entries(files)) {
  ids[name] = await sha256(bytes);
  assets.set(ids[name], { bytes, media_type });
}
const mediaTypes = new Map([...assets].map(([id, asset]) => [id, asset.media_type]));
const setSource = (source_id, asset_id, source_revision) => ({
  op: "set_source",
  source_id,
  name: source_id,
  source_revision,
  asset_id,
});
const moveSources = (doc, operations, types = mediaTypes) =>
  A.change(A.clone(doc), (draft) => setSources(draft, operations, { by, mediaTypes: types }));
const dataSources = moveSources(sourcesDoc, [
  setSource("label", ids.label1, null),
  setSource("table", ids.table1, null),
  setSource("note", ids.note1, null),
]);

// Writes the "chart" module view, as set_view would, and returns its record.
function moduleViewWriter() {
  let doc = viewGenesis("55555555-5555-4555-8555-555555555555");
  return (fields, writer = by) => {
    const revision = readView(doc, "chart")?.revision ?? null;
    doc = A.change(doc, (draft) =>
      setView(
        draft,
        {
          op: "set_view",
          view_id: "chart",
          title: "Chart",
          view_type: "module",
          module: { source_id: "entry" },
          data: { label: { source_id: "label" }, table: { source_id: "table" } },
          view_revision: revision,
          ...fields,
        },
        { sourcesDoc: dataSources, by: writer },
      ),
    );
    return readView(doc, "chart");
  };
}

const plan = (key, data, title = "T") => ({ key, data, view: { title } });

test("a plan change is a remount, a data change, a title change or nothing", () => {
  const a = { asset_id: "a".repeat(64), media_type: "application/octet-stream" };
  const b = { asset_id: "b".repeat(64), media_type: "application/octet-stream" };
  const base = plan("code", { "data/x": a, "data/y": a });
  const none = { kind: "none", data: [], title: false };
  const remount = { kind: "remount", data: [], title: false };
  for (const [next, expected] of [
    [plan("code", { "data/x": a, "data/y": a }), none],
    [plan("code", { "data/x": b, "data/y": a }), { kind: "data", data: ["data/x"], title: false }],
    [
      plan("code", { "data/x": b, "data/y": b }, "U"),
      { kind: "data", data: ["data/x", "data/y"], title: true },
    ],
    [plan("code", { "data/x": a, "data/y": a }, "U"), { kind: "title", data: [], title: true }],
    [
      plan("code", { "data/x": { ...a, media_type: PARQUET }, "data/y": a }),
      { kind: "data", data: ["data/x"], title: false },
    ],
    [plan("other", { "data/x": a, "data/y": a }), remount],
    [plan("other", { "data/x": b, "data/y": a }, "U"), remount],
    [{ error: "This view isn't executable." }, remount],
  ])
    assert.deepEqual({ ...planChange(base, next) }, expected);
  assert.equal(planChange({ error: "e" }, { error: "e" }).kind, "none");
  assert.equal(planChange({ error: "e" }, { error: "f" }).kind, "remount");
  assert.equal(planChange({ error: "e" }, base).kind, "remount");
  // Every module view data name is a file, so a name that moves between
  // Parquet and another type is a data change like any other.
  const store = new PageSourceStore({ pageId: PAGE, doc$: new BehaviorSubject(dataSources) });
  const whole = new PageSourceStore({
    pageId: PAGE,
    doc$: new BehaviorSubject(moveSources(dataSources, [setSource("table", ids.tableWhole, "1")])),
  });
  const view = moduleViewWriter()({});
  for (const [from, to] of [
    [store, whole],
    [whole, store],
  ])
    assert.deepEqual(
      { ...planChange(anywidgetPlan(view, from), anywidgetPlan(view, to)) },
      { kind: "data", data: ["data/table"], title: false },
    );
  store.destroy();
  whole.destroy();
});

test("a module view plan follows code for remounts and data for updates", () => {
  const write = moduleViewWriter();
  const store = new PageSourceStore({ pageId: PAGE, doc$: new BehaviorSubject(dataSources) });
  const first = anywidgetPlan(write({}), store);
  assert.deepEqual(Object.keys(first.data), ["data/label", "data/table"]);
  // The code identity names no data asset and no data type.
  assert.doesNotMatch(first.key, new RegExp(ids.table1));
  assert.doesNotMatch(first.key, /parquet/);
  // Another Parquet file under the same name is a data change.
  const nextTable = new PageSourceStore({
    pageId: PAGE,
    doc$: new BehaviorSubject(moveSources(dataSources, [setSource("table", ids.table2, "1")])),
  });
  assert.deepEqual(
    { ...planChange(first, anywidgetPlan(write({}), nextTable)) },
    { kind: "data", data: ["data/table"], title: false },
  );
  nextTable.destroy();
  // A producer-only rewrite and a title rewrite keep the code identity.
  const rewritten = anywidgetPlan(write({}, { ...by, displayName: "Other" }), store);
  assert.equal(planChange(first, rewritten).kind, "none");
  assert.equal(planChange(first, anywidgetPlan(write({ title: "Renamed" }), store)).kind, "title");
  // A different entry is new code.
  const moved = moveSources(dataSources, [setSource("entry", ids.entry2, "1")]);
  const other = new PageSourceStore({ pageId: PAGE, doc$: new BehaviorSubject(moved) });
  assert.equal(planChange(first, anywidgetPlan(write({ title: "Chart" }), other)).kind, "remount");
  // A view that becomes non-executable is a plan error, and so a remount.
  const chart = { ...write({}), media_type: "application/vnd.vegalite.v5+json", spec: {} };
  let error;
  try {
    anywidgetPlan(chart, store);
  } catch (caught) {
    error = { error: caught.message };
  }
  assert.ok(error);
  assert.equal(planChange(first, error).kind, "remount");
  store.destroy();
  other.destroy();
});

async function until(predicate, message) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

// The asset route's responses: a Parquet file is served as its media type,
// every other file as octet-stream; each names its media type.
// `log` records each request as [asset id, "HEAD" | "range" | "whole"].
function assetRequest(gate, log = []) {
  return async (url, options = {}) => {
    await gate;
    const id = url.split("/").at(-1);
    log.push([id, options.method === "HEAD" ? "HEAD" : options.headers?.Range ? "range" : "whole"]);
    const asset = assets.get(id);
    if (!asset) return new Response(null, { status: 404 });
    const headers = {
      "content-type": asset.media_type === PARQUET ? PARQUET : "application/octet-stream",
      "x-pages-media-type": asset.media_type,
      "content-length": String(asset.bytes.byteLength),
    };
    if (options.method === "HEAD") return new Response(null, { headers });
    const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? "");
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      return new Response(asset.bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          ...headers,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${asset.bytes.byteLength}`,
        },
      });
    }
    return new Response(asset.bytes, { headers });
  };
}

// `ready: false` leaves the fake frame starting until the test calls
// onState; `gate` holds every asset response until it resolves; `rejectData`
// makes the frame refuse setData for a name once. `store` shares one
// Page's sources between views; `decode` is the Parquet decoder.
function mountModuleView(
  t,
  {
    listening = true,
    ready = true,
    gate,
    rejectData,
    fields = {},
    maxTotalBytes,
    store,
    decode = parquetColumns,
  } = {},
) {
  const write = moduleViewWriter();
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc$ = store?.doc$ ?? new BehaviorSubject(dataSources);
  const log = [];
  const sources =
    store?.sources ??
    new PageSourceStore({ pageId: PAGE, doc$, request: assetRequest(gate, log), csvArrow });
  const view$ = new BehaviorSubject({ status: "ready", view: write(fields) });
  const calls = { mounts: [], destroyed: 0, data: [] };
  const mounted = mount(window.document.body, {
    view$,
    sources,
    frameUrl: FRAME,
    maxTotalBytes,
    columnDecoder: async () => decode,
    theme: { subscribe: () => () => {}, getSnapshot: () => ({ resolved: "light" }) },
    mountOutput(_container, payload, options) {
      const handle = {
        frame: { title: payload.title },
        destroy: () => calls.destroyed++,
        setHostContext() {},
        setData(name, value) {
          if (rejectData === name) {
            rejectData = undefined;
            throw Error("The frame refused this input.");
          }
          calls.data.push([name, value]);
          // A frame whose view has no change listener reports the change back.
          if (!listening) queueMicrotask(() => options.onUnhandledData(name));
        },
      };
      calls.mounts.push({ payload, options, handle });
      if (ready) options.onState("ready");
      return handle;
    },
  });
  t.after(() => {
    mounted.destroy();
    if (!store) sources.destroy();
    window.close();
  });
  const root = window.document.querySelector(".pages-anywidget-view");
  return { write, doc$, view$, calls, root, log };
}

// What the frame asks a file input for.
const asking = () => new AbortController().signal;
const rows = async (input) => (await input.columns("parquet", asking())).numRows;
const head = async (input) => new TextDecoder().decode(await input.read(0, 4));
const whole = async (input) => new TextDecoder().decode(await input.bytes(asking()));
// Requests for data assets other than HEAD: bytes fetched for data.
const dataReads = (log) =>
  log.filter(([id, kind]) => kind !== "HEAD" && id !== entryId && id !== moduleId);

test("a followed data source moving to a new asset updates the mounted view in place", async (t) => {
  const { doc$, calls, root, log } = mountModuleView(t);
  await until(() => calls.mounts.length === 1, "the view never mounted");
  const { files: inputs } = calls.mounts[0].options;
  // The mount opens each file for its size and fetches no data bytes.
  assert.deepEqual(dataReads(log), []);
  assert.deepEqual(
    { ...inputs["data/label"], read: 0, bytes: 0, columns: 0 },
    { mimeType: "application/octet-stream", byteLength: 11, read: 0, bytes: 0, columns: 0 },
  );
  // A file that is not Parquet refuses parquet() before anything is fetched.
  await assert.rejects(inputs["data/label"].columns("parquet", asking()), {
    message: "This file is not Parquet.",
  });
  assert.deepEqual(dataReads(log), []);
  assert.equal(inputs["data/table"].mimeType, PARQUET);
  assert.equal(inputs["data/table"].byteLength, files.table1[0].byteLength);
  // Each read happens when the frame asks.
  assert.equal(await whole(inputs["data/label"]), "first label");
  assert.equal(await head(inputs["data/table"]), "PAR1");
  assert.equal(await rows(inputs["data/table"]), 5);
  doc$.next(moveSources(dataSources, [setSource("label", ids.label2, "1")]));
  await until(() => calls.data.length === 1, "the label change never reached the frame");
  assert.equal(calls.data[0][0], "data/label");
  const asked = dataReads(log).length;
  assert.equal(await whole(calls.data[0][1]), "second label");
  assert.equal(dataReads(log).length, asked + 1, "the change fetched nothing until asked");
  doc$.next(
    moveSources(dataSources, [
      setSource("label", ids.label2, "1"),
      setSource("table", ids.table2, "1"),
    ]),
  );
  await until(() => calls.data.length === 2, "the table change never reached the frame");
  assert.equal(calls.data[1][0], "data/table");
  assert.equal(calls.data[1][1].byteLength, files.table2[0].byteLength);
  assert.equal(await rows(calls.data[1][1]), 9);
  // The new file stays readable after its load has finished.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await head(calls.data[1][1]), "PAR1");
  assert.equal(calls.mounts.length, 1, "no remount");
  assert.equal(calls.destroyed, 0, "the frame stays");
  assert.equal(root.dataset.outputState, "ready");
});

test("an entry change remounts, a title change relabels, a producer rewrite does nothing", async (t) => {
  const { write, doc$, view$, calls, root } = mountModuleView(t);
  await until(() => calls.mounts.length === 1, "the view never mounted");
  view$.next({ status: "ready", view: write({}, { ...by, displayName: "Someone else" }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.mounts.length, 1);
  view$.next({ status: "ready", view: write({ title: "Renamed" }) });
  await until(() => root.querySelector("h3").textContent === "Renamed", "title not updated");
  assert.equal(calls.mounts[0].handle.frame.title, "Renamed");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.mounts.length, 1);
  assert.equal(calls.destroyed, 0);
  assert.deepEqual(calls.data, []);
  doc$.next(moveSources(dataSources, [setSource("entry", ids.entry2, "1")]));
  await until(() => calls.mounts.length === 2, "an entry change did not remount");
  assert.equal(calls.destroyed, 1);
  assert.deepEqual(calls.data, []);
});

test("a data change that fails to load keeps the mounted view and its earlier data", async (t) => {
  const { doc$, calls, root } = mountModuleView(t);
  await until(() => calls.mounts.length === 1, "the view never mounted");
  const missing = "f".repeat(64);
  const broken = moveSources(
    dataSources,
    [setSource("label", missing, "1")],
    new Map([[missing, "application/octet-stream"]]),
  );
  doc$.next(broken);
  await until(() => root.dataset.inputError === "data/label", "the failure was not shown");
  assert.match(root.querySelector("p").textContent, /earlier data/);
  assert.equal(root.dataset.outputState, "ready");
  assert.equal(calls.destroyed, 0);
  assert.deepEqual(calls.data, []);
  doc$.next(moveSources(broken, [setSource("label", ids.label2, "2")]));
  await until(() => calls.data.length === 1, "the next change did not load");
  assert.equal(root.dataset.inputError, undefined);
  assert.equal(root.querySelector("p").textContent, "");
});

test("a view with no listener for a data change is mounted again with the new data", async (t) => {
  const { doc$, calls, root } = mountModuleView(t, { listening: false });
  await until(() => calls.mounts.length === 1, "the view never mounted");
  doc$.next(moveSources(dataSources, [setSource("label", ids.label2, "1")]));
  await until(() => calls.mounts.length === 2, "the unhandled change did not remount");
  assert.equal(calls.destroyed, 1, "the old frame is gone");
  assert.equal(await whole(calls.mounts[1].options.files["data/label"]), "second label");
  // The new mount starts from the newest plan: nothing is redelivered.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.mounts.length, 2);
  assert.equal(calls.data.length, 1);
  assert.equal(root.dataset.outputState, "ready");
});

test("a refused data change shows its failure; module view files count toward no mount total", async (t) => {
  const { doc$, calls, root } = mountModuleView(t, {
    // The entry alone: the files are read only on request.
    maxTotalBytes: entry.byteLength,
    rejectData: "data/label",
  });
  await until(() => calls.mounts.length === 1, "the view never mounted");
  const big = moveSources(dataSources, [setSource("label", ids.labelBig, "1")]);
  doc$.next(big);
  await until(() => root.dataset.inputError === "data/label", "the refusal was not shown");
  assert.match(root.querySelector("p").textContent, /refused/);
  doc$.next(moveSources(big, [setSource("label", ids.label2, "2")]));
  await until(() => calls.data.length === 1, "the next change was not delivered");
  assert.equal(root.dataset.inputError, undefined);
});

test("an input failure shows only on a ready frame and never touches a failed one", async (t) => {
  const { doc$, calls, root } = mountModuleView(t, { ready: false });
  await until(() => calls.mounts.length === 1, "the view never mounted");
  const { onState } = calls.mounts[0].options;
  onState("booting");
  const missing = "f".repeat(64);
  const broken = moveSources(
    dataSources,
    [setSource("label", missing, "1")],
    new Map([[missing, "application/octet-stream"]]),
  );
  doc$.next(broken);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(root.dataset.inputError, undefined, "not while the frame is starting");
  assert.doesNotMatch(root.querySelector("p").textContent, /earlier data/);
  onState("ready");
  assert.equal(root.dataset.inputError, "data/label");
  assert.match(root.querySelector("p").textContent, /earlier data/);
  onState("failed", "The output failed.");
  const button = root.querySelector("button");
  assert.equal(button.hidden, false);
  assert.equal(root.dataset.inputError, undefined);
  doc$.next(moveSources(broken, [setSource("label", ids.label2, "2")]));
  await until(() => calls.data.length === 1, "the next change did not load");
  assert.equal(button.hidden, false, "Retry stays on a failed frame");
  assert.equal(button.disabled, false);
  assert.equal(root.querySelector("p").textContent, "The output failed.");
});

test("a title change while inputs load reaches the new frame's title", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { write, view$, calls, root } = mountModuleView(t, { gate });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.mounts.length, 0);
  view$.next({ status: "ready", view: write({ title: "Renamed while loading" }) });
  await until(
    () => root.querySelector("h3").textContent === "Renamed while loading",
    "label not updated",
  );
  release();
  await until(() => calls.mounts.length === 1, "the view never mounted");
  assert.equal(calls.mounts[0].handle.frame.title, "Renamed while loading");
});

test("two module views over one Parquet asset decode it once", async (t) => {
  const doc$ = new BehaviorSubject(dataSources);
  const sources = new PageSourceStore({ pageId: PAGE, doc$, request: assetRequest() });
  t.after(() => sources.destroy());
  let decodes = 0;
  const decode = async (bytes, limits) => {
    decodes++;
    return parquetColumns(bytes, limits);
  };
  const store = { doc$, sources };
  const one = mountModuleView(t, { store, decode });
  const two = mountModuleView(t, { store, decode });
  await until(
    () => one.calls.mounts.length === 1 && two.calls.mounts.length === 1,
    "the views never mounted",
  );
  const first = one.calls.mounts[0].options.files["data/table"];
  const second = two.calls.mounts[0].options.files["data/table"];
  assert.equal(decodes, 0, "nothing decodes until a view asks");
  const [a, b] = await Promise.all([
    first.columns("parquet", asking()),
    second.columns("parquet", asking()),
  ]);
  assert.equal(decodes, 1);
  assert.equal(a, b, "one cached ColumnSet; each frame gets a copy");
  doc$.next(moveSources(dataSources, [setSource("table", ids.table2, "1")]));
  await until(
    () => one.calls.data.length === 1 && two.calls.data.length === 1,
    "the change did not reach both views",
  );
  assert.equal(decodes, 1, "a data change decodes nothing");
  assert.equal(await rows(two.calls.data[0][1]), 9);
  assert.equal(await rows(one.calls.data[0][1]), 9);
  assert.equal(decodes, 2, "the new asset decodes once for both");
});

test("a Parquet file that cannot be decoded rejects its table and leaves the view ready", async (t) => {
  const bad = moveSources(dataSources, [setSource("table", ids.tableBad, "1")]);
  const doc$ = new BehaviorSubject(bad);
  const sources = new PageSourceStore({ pageId: PAGE, doc$, request: assetRequest() });
  t.after(() => sources.destroy());
  const { calls, root } = mountModuleView(t, { store: { doc$, sources } });
  await until(() => calls.mounts.length === 1, "the view never mounted");
  assert.equal(root.dataset.outputState, "ready");
  const input = calls.mounts[0].options.files["data/table"];
  await assert.rejects(input.columns("parquet", asking()), /^Error: Parquet footer length exceeds/);
  assert.equal(root.dataset.outputState, "ready");
  assert.equal(root.dataset.inputError, undefined);
  // A data change to a good file is a delivered file whose table reads.
  doc$.next(moveSources(bad, [setSource("table", ids.table2, "2")]));
  await until(() => calls.data.length === 1, "the change was not delivered");
  assert.equal(await rows(calls.data[0][1]), 9);
});

// The rows csv() reads from a file input, as the frame's columnRows builds them.
const csvRows = async (input) => {
  const { columnRows } = await import("@nteract/output-frame/table");
  return columnRows(await input.columns("csv", asking()));
};

test("csv() over a CSV source converts it once for two views and follows a new version", async (t) => {
  const withCsv = moveSources(dataSources, [setSource("table", ids.cities1, "1")]);
  const doc$ = new BehaviorSubject(withCsv);
  const log = [];
  let conversions = 0;
  const sources = new PageSourceStore({
    pageId: PAGE,
    doc$,
    request: assetRequest(undefined, log),
    csvArrow: async () => async (bytes, limits) => {
      conversions++;
      return convertCsv(bytes, limits);
    },
  });
  t.after(() => sources.destroy());
  const store = { doc$, sources };
  const one = mountModuleView(t, { store });
  const two = mountModuleView(t, { store });
  await until(
    () => one.calls.mounts.length === 1 && two.calls.mounts.length === 1,
    "the views never mounted",
  );
  const first = one.calls.mounts[0].options.files["data/table"];
  const second = two.calls.mounts[0].options.files["data/table"];
  assert.equal(first.mimeType, "text/csv");
  const [a, b] = await Promise.all([csvRows(first), csvRows(second)]);
  assert.deepEqual(a.columns, ["city", "people"]);
  assert.deepEqual(
    [...a],
    [
      { city: "Oslo", people: 3 },
      { city: "Bergen", people: null },
    ],
  );
  assert.deepEqual([...b], [...a]);
  assert.equal(conversions, 1, "one conversion for both views");
  // parquet() on a CSV source is refused before any read.
  await assert.rejects(first.columns("parquet", asking()), {
    message: "This file is not Parquet.",
  });
  doc$.next(moveSources(withCsv, [setSource("table", ids.cities2, "2")]));
  await until(
    () => one.calls.data.length === 1 && two.calls.data.length === 1,
    "the new version did not reach both views",
  );
  assert.deepEqual([...(await csvRows(one.calls.data[0][1]))], [{ city: "Oslo", people: 4 }]);
  assert.deepEqual([...(await csvRows(two.calls.data[0][1]))], [{ city: "Oslo", people: 4 }]);
  assert.equal(conversions, 2, "the new version converts once");
});

test("csv() reads a CSV stored as generic binary; one that does not parse rejects plainly", async (t) => {
  const { doc$, calls, root } = mountModuleView(t);
  await until(() => calls.mounts.length === 1, "the view never mounted");
  const moved = moveSources(dataSources, [setSource("table", ids.citiesBinary, "1")]);
  doc$.next(moved);
  await until(() => calls.data.length === 1, "the change was not delivered");
  const binary = calls.data[0][1];
  assert.equal(binary.mimeType, "application/octet-stream");
  assert.deepEqual([...(await csvRows(binary))], [{ city: "Tromsø", people: 1 }]);
  doc$.next(moveSources(moved, [setSource("table", ids.citiesRagged, "2")]));
  await until(() => calls.data.length === 2, "the second change was not delivered");
  await assert.rejects(calls.data[1][1].columns("csv", asking()), {
    message: /^This file can't be read as CSV: .*unequal lengths/,
  });
  assert.equal(root.dataset.outputState, "ready");
});
