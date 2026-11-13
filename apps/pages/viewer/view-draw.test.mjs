// One embed's drawing over a real source store: each plan loads its tables
// once, a rewritten view or source replaces a load in flight, destroy
// cancels and frees, a refused spec loads nothing, a removed source draws
// empty with one sentence, and a pinned binding reads its history state.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { BehaviorSubject } from "rxjs";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { checkChartSpec } from "../shared/chart-spec.mjs";
import { PageSourceStore } from "./page-source-store.mjs";
import { VIEW_STATUS, createViewDraw, viewNote } from "./view-draw.mjs";
import { VIEW_MEDIA_TYPE } from "./view-store.mjs";

const PAGE = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};
const asset = (char) => char.repeat(64);
const writer = { principal: "agent", displayName: "Agent", driver: "MCP" };

/** The host's sources document, with `set` for its next write and `remove`
 * for a source that goes away. */
function hostSources() {
  let doc = sourcesGenesis(crypto.randomUUID());
  const revisions = {};
  return {
    get doc() {
      return doc;
    },
    set(sourceId, assetId) {
      doc = A.change(doc, (draft) =>
        setSources(
          draft,
          [
            {
              op: "set_source",
              source_id: sourceId,
              name: sourceId,
              asset_id: assetId,
              source_revision: revisions[sourceId] ?? null,
            },
          ],
          { mediaTypes: new Map([[assetId, PARQUET_MEDIA_TYPE]]), by: writer },
        ),
      );
      revisions[sourceId] = doc.sources[sourceId].revision;
      return doc;
    },
    remove(sourceId) {
      doc = A.change(doc, (draft) => {
        delete draft.sources[sourceId];
      });
      delete revisions[sourceId];
      return doc;
    },
  };
}

/** A decoder whose results the test settles: each call is held, with the
 * asset id it decoded. */
function heldDecode() {
  const calls = [];
  const decode = (bytes) =>
    new Promise((resolve, reject) => {
      const table = { asset: new TextDecoder().decode(bytes), freed: 0 };
      table.dispose = () => table.freed++;
      calls.push({ asset: table.asset, table, resolve: () => resolve(table), reject });
    });
  return { calls, decode };
}

const spec = (names = ["sales"]) => ({
  layer: names.map((name) => ({
    data: { name },
    mark: "bar",
    encoding: { x: { field: "region", type: "nominal" } },
  })),
});
const view = ({ revision = "1", names = ["sales"], data, title = "Sales" } = {}) => ({
  status: "ready",
  view: {
    view_id: "sales",
    title,
    media_type: VIEW_MEDIA_TYPE,
    spec: spec(names),
    data: data ?? Object.fromEntries(names.map((name) => [name, { source_id: name }])),
    revision,
    specText: JSON.stringify(spec(names)),
  },
});

function fixture({
  sources: initial,
  sourcesKnown$,
  check = checkChartSpec,
  throwOnDraw = () => false,
  throwOnDestroy = () => false,
} = {}) {
  const host = hostSources();
  for (const [id, char] of Object.entries(initial ?? { sales: "a" })) host.set(id, asset(char));
  const doc$ = new BehaviorSubject(initial === null ? undefined : host.doc);
  const fetches = [];
  const asks = [];
  const store = new PageSourceStore({
    pageId: PAGE,
    doc$,
    demand: () => (asks.push(1), () => {}),
    request: async (url) => {
      fetches.push(url);
      return new Response(new TextEncoder().encode(url.slice(-64)), {
        headers: { "content-type": PARQUET_MEDIA_TYPE },
      });
    },
  });
  const view$ = new BehaviorSubject({ status: "pending" });
  const decoder = heldDecode();
  const draws = [];
  const shown = [];
  const draw = createViewDraw({
    view$,
    sources: store,
    ...(sourcesKnown$ && { sourcesKnown$ }),
    decode: decoder.decode,
    checkChartSpec: check,
    render: {
      draw(input) {
        if (throwOnDraw(input)) throw Error("mount threw");
        const entry = { ...input, destroyed: false };
        draws.push(entry);
        return {
          destroy: () => {
            entry.destroyed = true;
            if (throwOnDestroy(entry)) throw Error("destroy threw");
          },
        };
      },
      show: (status) => shown.push(status),
    },
  });
  return {
    host,
    doc$,
    store,
    view$,
    decoder,
    draws,
    shown,
    draw,
    fetches,
    asks,
    write: (id, char) => doc$.next(host.set(id, asset(char))),
  };
}

test("a ready view loads its source once and draws it by data name", async () => {
  const f = fixture();
  assert.equal(f.shown.at(-1).sentence, VIEW_STATUS.waiting);
  f.view$.next(view());
  await settle();
  assert.equal(f.decoder.calls.length, 1);
  assert.equal(f.decoder.calls[0].asset, asset("a"));
  f.decoder.calls[0].resolve();
  await settle();
  assert.equal(f.draws.length, 1);
  assert.equal(f.draws[0].datasets.sales, f.decoder.calls[0].table);
  assert.equal(f.draws[0].view.title, "Sales");
  assert.equal(f.draws[0].note, null);
  assert.equal(f.decoder.calls[0].table.freed, 1, "the chart's rows replace the table");
  assert.deepEqual(f.shown.at(-1), { state: "drawn", sentence: null, note: null, title: "Sales" });
  f.draw.destroy();
  assert.equal(f.draws[0].destroyed, true);
});

test("two data names bound to one source load it once", async () => {
  const f = fixture();
  f.view$.next(
    view({ names: ["a", "b"], data: { a: { source_id: "sales" }, b: { source_id: "sales" } } }),
  );
  await settle();
  assert.equal(f.decoder.calls.length, 1);
  f.decoder.calls[0].resolve();
  await settle();
  assert.equal(f.draws[0].datasets.a, f.draws[0].datasets.b);
  assert.equal(f.decoder.calls[0].table.freed, 1, "freed once");
});

test("a view rewritten while its table loads cancels that load and draws the new one", async () => {
  const f = fixture();
  f.view$.next(view());
  await settle();
  f.view$.next(view({ revision: "2", title: "Sales, again" }));
  await settle();
  assert.equal(f.decoder.calls.length, 2);
  // The first load's table arrives after it was cancelled: it is freed and
  // never drawn.
  f.decoder.calls[0].resolve();
  await settle();
  assert.equal(f.draws.length, 0);
  assert.equal(f.decoder.calls[0].table.freed, 1);
  f.decoder.calls[1].resolve();
  await settle();
  assert.equal(f.draws.length, 1);
  assert.equal(f.draws[0].view.title, "Sales, again");
});

test("a source rewritten while the chart draws replaces the load; the drawn chart stays until then", async () => {
  const f = fixture();
  f.view$.next(view());
  await settle();
  f.decoder.calls[0].resolve();
  await settle();
  assert.equal(f.draws.length, 1);
  f.write("sales", "b");
  await settle();
  assert.equal(f.draws[0].destroyed, false, "the old chart stays while the new table loads");
  f.write("sales", "c");
  await settle();
  assert.deepEqual(
    f.decoder.calls.map((call) => call.asset),
    [asset("a"), asset("b"), asset("c")],
  );
  f.decoder.calls[1].resolve();
  f.decoder.calls[2].resolve();
  await settle();
  assert.equal(f.draws.length, 2, "only the newest version draws");
  assert.equal(f.draws[0].destroyed, true);
  assert.equal(f.draws[1].datasets.sales.asset, asset("c"));
  assert.equal(f.decoder.calls[1].table.freed, 1, "the replaced load's table is freed");
});

test("a chart that throws while tearing down neither blocks the redraw nor keeps its tables", async () => {
  const f = fixture({ throwOnDestroy: () => true });
  f.view$.next(view());
  await settle();
  f.decoder.calls[0].resolve();
  await settle();
  f.write("sales", "b");
  await settle();
  f.decoder.calls[1].resolve();
  await settle();
  assert.equal(f.draws[0].destroyed, true);
  assert.equal(f.draws.length, 2, "the new version draws");
  assert.equal(f.draws[1].datasets.sales.asset, asset("b"));
  assert.equal(f.decoder.calls[1].table.freed, 1, "its tables are freed");
  assert.equal(f.draw.state.name, "drawn");
  assert.equal(f.draw.loads, 0);
  assert.doesNotThrow(() => f.draw.destroy());
  assert.equal(f.draws[1].destroyed, true);
  assert.equal(f.draw.state.name, "destroyed");
});

test("destroy during a pending load cancels it and frees what it decoded", async () => {
  const f = fixture();
  f.view$.next(view());
  await settle();
  f.draw.destroy();
  f.decoder.calls[0].resolve();
  await settle();
  assert.equal(f.draws.length, 0);
  assert.equal(f.decoder.calls[0].table.freed, 1);
  // Nothing more moves it.
  f.view$.next(view({ revision: "2" }));
  f.write("sales", "b");
  await settle();
  assert.equal(f.decoder.calls.length, 1);
  assert.equal(f.draw.state.name, "destroyed");
});

test("a spec the checks refuse shows its sentence and loads nothing", async () => {
  const f = fixture();
  const refused = view();
  refused.view = { ...refused.view, spec: { mark: "bar", data: { url: "https://example.com" } } };
  f.view$.next(refused);
  await settle();
  assert.equal(f.decoder.calls.length, 0);
  assert.equal(f.shown.at(-1).state, "blocked");
  assert.match(f.shown.at(-1).sentence, /URL/);
  assert.equal(f.shown.at(-1).title, "Sales");
});

test("a view that isn't on this Page shows its sentence", async () => {
  const f = fixture();
  f.view$.next({
    status: "unavailable",
    reason: "missing",
    sentence: "This chart isn't on this Page.",
  });
  await settle();
  assert.deepEqual(f.shown.at(-1), {
    state: "blocked",
    sentence: "This chart isn't on this Page.",
    note: null,
    title: null,
  });
});

test("a removed source draws empty, names the source, and asks for the sources document", async () => {
  const f = fixture({ sources: { sales: "a", costs: "b" } });
  f.view$.next(view({ names: ["sales", "costs"] }));
  await settle();
  for (const call of f.decoder.calls) call.resolve();
  await settle();
  assert.equal(f.draws.length, 1);
  f.doc$.next(f.host.remove("costs"));
  await settle();
  // Only the remaining source loads again.
  assert.deepEqual(
    f.decoder.calls.map((call) => call.asset),
    [asset("a"), asset("b"), asset("a")],
  );
  f.decoder.calls[2].resolve();
  await settle();
  const latest = f.draws.at(-1);
  assert.deepEqual(latest.datasets.costs, []);
  assert.equal(latest.note, `This chart's source "costs" isn't on this Page.`);
  assert.equal(f.shown.at(-1).note, latest.note);
  assert.ok(f.asks.length > 0, "a missing source asks for the sources document");
});

test("a view ready before its sources document is read waits, then draws its data once", async () => {
  // The Page's sources document is still being read from storage: the store
  // holds no document, and the lookup has no answer.
  const known$ = new BehaviorSubject(false);
  const f = fixture({ sources: null, sourcesKnown$: known$ });
  f.host.set("sales", asset("a"));
  f.view$.next(view());
  await settle();
  assert.deepEqual(f.draws, [], "nothing draws as missing while the document is unread");
  assert.equal(f.shown.at(-1).sentence, VIEW_STATUS.waiting);
  assert.equal(f.shown.at(-1).note, null);
  assert.ok(f.asks.length > 0, "it asks for the sources document");
  f.doc$.next(f.host.doc);
  known$.next(true);
  await settle();
  f.decoder.calls[0].resolve();
  await settle();
  assert.equal(f.draws.length, 1);
  assert.equal(f.draws[0].note, null);
  assert.equal(f.draws[0].datasets.sales, f.decoder.calls[0].table);
});

test("a source the answered sources document doesn't hold draws empty, with its note", async () => {
  const known$ = new BehaviorSubject(false);
  const f = fixture({ sources: null, sourcesKnown$: known$ });
  f.view$.next(view());
  await settle();
  assert.deepEqual(f.draws, []);
  // The host answered: there is no sources document.
  known$.next(true);
  await settle();
  assert.equal(f.draws.length, 1);
  assert.deepEqual(f.draws[0].datasets.sales, []);
  assert.equal(f.draws[0].note, `This chart's source "sales" isn't on this Page.`);
});

test("a pinned binding reads its history state and ignores later revisions", async () => {
  const f = fixture();
  f.write("sales", "b");
  f.view$.next(view({ data: { sales: { source_id: "sales", revision: "1" } } }));
  await settle();
  assert.equal(f.decoder.calls[0].asset, asset("a"), "revision 1 is asset a");
  f.decoder.calls[0].resolve();
  await settle();
  f.write("sales", "c");
  await settle();
  assert.equal(f.decoder.calls.length, 1, "a new revision doesn't move a pinned chart");
  // A revision the history doesn't hold draws empty with a sentence.
  f.view$.next(view({ revision: "2", data: { sales: { source_id: "sales", revision: "9" } } }));
  await settle();
  assert.equal(f.decoder.calls.length, 1);
  assert.deepEqual(f.draws.at(-1).datasets.sales, []);
  assert.equal(f.draws.at(-1).note, `This chart's source "sales" has no revision 9 on this Page.`);
});

test("a table that fails to load says so, and a new version tries again", async () => {
  const f = fixture();
  f.view$.next(view());
  await settle();
  f.decoder.calls[0].reject(Error("corrupt"));
  await settle();
  assert.equal(f.shown.at(-1).state, "failed");
  assert.equal(f.shown.at(-1).sentence, VIEW_STATUS.failed);
  f.write("sales", "b");
  await settle();
  f.decoder.calls[1].resolve();
  await settle();
  assert.equal(f.draws.length, 1);
});

test("the sentence for data a chart can't read names each source", () => {
  assert.equal(viewNote([]), null);
  assert.equal(
    viewNote([
      { source_id: "a", reason: "missing" },
      { source_id: "b", reason: "missing" },
      { source_id: "c", reason: "revision", revision: "2" },
    ]),
    `This chart's sources "a" and "b" aren't on this Page.`,
  );
  assert.equal(
    viewNote([
      { source_id: "a", reason: "missing" },
      { source_id: "b", reason: "missing" },
      { source_id: "c", reason: "missing" },
    ]),
    `This chart's sources "a", "b" and "c" aren't on this Page.`,
  );
});

test("a chart that throws while mounting shows a sentence and frees its tables", async () => {
  let throwing = false;
  const f = fixture({ throwOnDraw: () => throwing });
  f.view$.next(view());
  await settle();
  f.decoder.calls[0].resolve();
  await settle();
  assert.equal(f.draws.length, 1);
  throwing = true;
  f.write("sales", "b");
  await settle();
  f.decoder.calls[1].resolve();
  await settle();
  assert.equal(f.draws[0].destroyed, true, "the replaced chart is gone");
  assert.equal(f.decoder.calls[1].table.freed, 1, "the thrown chart's table is freed");
  assert.equal(f.draw.state.name, "failed");
  assert.equal(f.shown.at(-1).sentence, VIEW_STATUS.broken);
  // A later version draws again.
  throwing = false;
  f.write("sales", "c");
  await settle();
  f.decoder.calls[2].resolve();
  await settle();
  assert.equal(f.draw.state.name, "drawn");
  assert.equal(f.draws.length, 2);
});

test("a spec check that throws blocks one revision; the next revision draws", async () => {
  let throwing = true;
  const f = fixture({
    check: (spec, options) => {
      if (throwing) throw Error("check threw");
      return checkChartSpec(spec, options);
    },
  });
  f.view$.next(view());
  await settle();
  assert.equal(f.shown.at(-1).state, "blocked");
  assert.equal(f.shown.at(-1).sentence, VIEW_STATUS.broken);
  assert.equal(f.decoder.calls.length, 0);
  throwing = false;
  f.view$.next(view({ revision: "2" }));
  await settle();
  f.decoder.calls[0].resolve();
  await settle();
  assert.equal(f.draw.state.name, "drawn");
});

test("failed loads are released, through repeated failures and destroy", async () => {
  const f = fixture();
  f.view$.next(view());
  for (const char of ["b", "c", "d"]) {
    await settle();
    f.decoder.calls.at(-1).reject(Error("corrupt"));
    await settle();
    assert.equal(f.draw.state.name, "failed");
    assert.equal(f.draw.loads, 0, "a failed load keeps no record");
    f.write("sales", char);
  }
  await settle();
  assert.equal(f.draw.loads, 1, "the newest load runs");
  f.draw.destroy();
  assert.equal(f.draw.loads, 0);
});
