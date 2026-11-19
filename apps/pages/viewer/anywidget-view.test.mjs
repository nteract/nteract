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
  table1: [encoder.encode("PAR1 table one PAR1"), PARQUET],
  table2: [encoder.encode("PAR1 table two, longer PAR1"), PARQUET],
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
});

test("a module view plan follows code for remounts and data for updates", () => {
  const write = moduleViewWriter();
  const store = new PageSourceStore({ pageId: PAGE, doc$: new BehaviorSubject(dataSources) });
  const first = anywidgetPlan(write({}), store);
  assert.deepEqual(Object.keys(first.data), ["data/label", "data/table"]);
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

function mountModuleView(t) {
  const write = moduleViewWriter();
  const { window } = new JSDOM("<!doctype html><body></body>");
  const request = async (url, options = {}) => {
    const asset = assets.get(url.split("/").at(-1));
    if (!asset) return new Response(null, { status: 404 });
    const headers = {
      "content-type": "application/octet-stream",
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
  const doc$ = new BehaviorSubject(dataSources);
  const sources = new PageSourceStore({ pageId: PAGE, doc$, request });
  const view$ = new BehaviorSubject({ status: "ready", view: write({}) });
  const calls = { mounts: [], destroyed: 0, data: [] };
  const mounted = mount(window.document.body, {
    view$,
    sources,
    frameUrl: FRAME,
    theme: { subscribe: () => () => {}, getSnapshot: () => ({ resolved: "light" }) },
    mountOutput(_container, payload, options) {
      const handle = {
        frame: { title: payload.title },
        destroy: () => calls.destroyed++,
        setHostContext() {},
        setData: (name, value) => calls.data.push([name, value]),
      };
      calls.mounts.push({ payload, options, handle });
      options.onState("ready");
      return handle;
    },
  });
  t.after(() => {
    mounted.destroy();
    sources.destroy();
    window.close();
  });
  const root = window.document.querySelector(".pages-anywidget-view");
  return { write, doc$, view$, calls, root };
}

test("a followed data source moving to a new asset updates the mounted view in place", async (t) => {
  const { doc$, calls, root } = mountModuleView(t);
  await until(() => calls.mounts.length === 1, "the view never mounted");
  const { byteSources } = calls.mounts[0].options;
  assert.equal(new TextDecoder().decode(byteSources["data/label"]), "first label");
  assert.equal(byteSources["data/table"].byteLength, files.table1[0].byteLength);
  assert.equal(typeof byteSources["data/table"].read, "function");
  doc$.next(moveSources(dataSources, [setSource("label", ids.label2, "1")]));
  await until(() => calls.data.length === 1, "the label change never reached the frame");
  assert.equal(calls.data[0][0], "data/label");
  assert.equal(new TextDecoder().decode(calls.data[0][1]), "second label");
  doc$.next(
    moveSources(dataSources, [
      setSource("label", ids.label2, "1"),
      setSource("table", ids.table2, "1"),
    ]),
  );
  await until(() => calls.data.length === 2, "the table change never reached the frame");
  assert.equal(calls.data[1][0], "data/table");
  assert.equal(calls.data[1][1].byteLength, files.table2[0].byteLength);
  // The new file stays readable after its load has finished.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(new TextDecoder().decode(await calls.data[1][1].read(0, 9)), "PAR1 tabl");
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
