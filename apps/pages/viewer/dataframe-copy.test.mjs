// The dataframe-copy machine over every state × event, its interpreter, and
// the paste helpers: a table pasted from another Page lands with this Page's
// copy of its data, or as its title when the copy fails.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parse, serialize } from "wordgard/doc";
import { runTable } from "../shared/machine-test.mjs";
import { REJECT, dataframeCopyMachine } from "./dataframe-copy-machine.mjs";
import {
  COPYING,
  copyFailure,
  copyPageDataset,
  createDataframeCopier,
  pastedSlice,
} from "./dataframe-copy.mjs";
import {
  PagesDataframe,
  Paragraph,
  foreignDataframes,
  pastedPageHTML,
  schema,
} from "./wordgard-model.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

const idle = { name: "idle" };
const copying = { name: "copying", token: 2 };
const failed = { name: "failed", message: "No access. Pasted its title instead." };
const row = (label, state, event, expect, kase) => ({
  label,
  ...(kase && { case: kase }),
  state,
  event,
  expect: { effects: [], ...expect },
});
const ROWS = [
  row(
    "a paste with a table from another Page starts copying",
    idle,
    { type: "start", token: 1 },
    { state: { name: "copying", token: 1 }, effects: [{ type: "copy", token: 1 }] },
  ),
  row(
    "a second paste waits for the first",
    copying,
    { type: "start", token: 3 },
    { state: copying, rejected: REJECT.busy },
  ),
  row(
    "a new paste clears the last failure",
    failed,
    { type: "start", token: 3 },
    { state: { name: "copying", token: 3 }, effects: [{ type: "copy", token: 3 }] },
  ),
  row(
    "idle has no copy to finish",
    idle,
    { type: "copied", token: 1 },
    { state: idle, rejected: REJECT.stale },
  ),
  row(
    "the copy finishes and the paste lands",
    copying,
    { type: "copied", token: 2 },
    { state: idle, effects: [{ type: "insert", token: 2 }] },
    "current",
  ),
  row(
    "a cancelled paste's copy is ignored",
    copying,
    { type: "copied", token: 1 },
    { state: copying, rejected: REJECT.stale },
    "stale",
  ),
  row(
    "a shown failure ignores a late copy",
    failed,
    { type: "copied", token: 2 },
    { state: failed, rejected: REJECT.stale },
  ),
  row(
    "idle has no copy to fail",
    idle,
    { type: "failed", token: 1, message: "x" },
    { state: idle, rejected: REJECT.stale },
  ),
  row(
    "a failed copy says why, and the paste lands with the title",
    copying,
    { type: "failed", token: 2, message: "No access" },
    { state: { name: "failed", message: "No access" }, effects: [{ type: "insert", token: 2 }] },
    "current",
  ),
  row(
    "a cancelled paste's failure is ignored",
    copying,
    { type: "failed", token: 1, message: "x" },
    { state: copying, rejected: REJECT.stale },
    "stale",
  ),
  row(
    "a shown failure ignores a late one",
    failed,
    { type: "failed", token: 2, message: "x" },
    { state: failed, rejected: REJECT.stale },
  ),
  row(
    "a paste that can't land says why",
    idle,
    { type: "problem", message: "Paste again." },
    { state: { name: "failed", message: "Paste again." } },
  ),
  row(
    "a problem while copying waits",
    copying,
    { type: "problem", message: "x" },
    { state: copying, rejected: REJECT.busy },
  ),
  row(
    "a problem after a failure replaces it",
    failed,
    { type: "problem", message: "Newer" },
    { state: { name: "failed", message: "Newer" } },
  ),
  row("nothing to cancel", idle, { type: "cancel" }, { state: idle, rejected: REJECT.idle }),
  row(
    "cancel drops the paste",
    copying,
    { type: "cancel" },
    { state: idle, effects: [{ type: "abort", token: 2 }] },
  ),
  row("dismiss clears a failure", failed, { type: "cancel" }, { state: idle }),
];

test("the dataframe-copy machine covers every state × event", async () => {
  assert.deepEqual(await runTable(dataframeCopyMachine, ROWS), {
    rows: 17,
    pairs: 15,
    unreachable: 0,
    cases: 4,
  });
});

const here = "33333333-3333-4333-8333-333333333333";
const there = "44444444-4444-4444-8444-444444444444";
const elsewhere = "55555555-5555-4555-8555-555555555555";
const assetA = "a".repeat(64),
  assetB = "b".repeat(64);
const src = (page, asset = assetA) => `/api/pages/${page}/assets/${asset}`;

function copiedHTML(dom, ...attrs) {
  const nodes = attrs.map((value) =>
    PagesDataframe.of({ media_type: PARQUET_MEDIA_TYPE, title: "Usage", ...value }),
  );
  const doc = schema.doc([Paragraph.create([]), ...nodes]);
  const container = dom.window.document.createElement("div");
  container.append(serialize(doc).toDOM(dom.window.document));
  return container.innerHTML;
}
const dataframes = (dom, html) => {
  const body = dom.window.document.createElement("body");
  body.innerHTML = html;
  const found = [];
  parse(schema, body).iterate((node) => {
    if (node.type === PagesDataframe) found.push(node.param);
  });
  return found;
};

test("foreign tables are found once each; this Page's and forged ones are not", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const parser = new dom.window.DOMParser();
  const html =
    copiedHTML(
      dom,
      { src: src(there) },
      { src: src(there) },
      { src: src(elsewhere, assetB) },
      { src: src(here) },
    ) +
    `<figure data-pages-dataframe='{"src":"https://evil.example/x","media_type":"x"}'>t</figure>`;
  assert.deepEqual(foreignDataframes(html, here, parser), [
    { src: src(there), pageId: there, assetId: assetA },
    { src: src(elsewhere, assetB), pageId: elsewhere, assetId: assetB },
  ]);
  assert.deepEqual(foreignDataframes(html, null, parser), []);
  assert.deepEqual(foreignDataframes("<p>plain</p>", here, parser), []);
});

test("a copied table pastes with this Page's src; one that didn't copy pastes as its title", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const parser = new dom.window.DOMParser();
  const html = copiedHTML(
    dom,
    { src: src(there), view_id: "v1" },
    { src: src(elsewhere, assetB), title: "Other" },
  );
  const copied = new Map([[src(there), src(here)]]);
  const pasted = pastedPageHTML(html, here, parser, copied);
  assert.deepEqual(dataframes(dom, pasted), [
    { src: src(here), media_type: PARQUET_MEDIA_TYPE, title: "Usage", view_id: "v1" },
  ]);
  assert.match(pasted, /<p>Other<\/p>/);
  // A copy map can't point a table at a third Page.
  const misdirected = pastedPageHTML(html, here, parser, new Map([[src(there), src(elsewhere)]]));
  assert.deepEqual(dataframes(dom, misdirected), []);
  // Without a copy, nothing from another Page survives, as before.
  assert.deepEqual(dataframes(dom, pastedPageHTML(html, here, parser)), []);
});

test("pastedSlice reads the rewritten HTML as the editor would", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const html = pastedPageHTML(
    `<meta charset="utf-8">${copiedHTML(dom, { src: src(there) })}`,
    here,
    new dom.window.DOMParser(),
    new Map([[src(there), src(here)]]),
  );
  const seen = [];
  const slice = pastedSlice({ schema }, html, {
    document: dom.window.document.implementation.createHTMLDocument(""),
    filters: [(value) => (seen.push(value), value)],
  });
  assert.equal(seen.length, 1);
  assert.ok(slice.content.some((token) => token.type === PagesDataframe));
  assert.equal(slice.content.find((token) => token.type === PagesDataframe).param.src, src(here));
});

test("copyPageDataset posts the source to this Page's asset URL and checks the answer", async () => {
  const calls = [];
  const answer = (status, body) => async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(body), { status });
  };
  const source = { pageId: there, assetId: assetA };
  const ok = { asset_id: assetA, url: src(here), mime_type: PARQUET_MEDIA_TYPE, size: 10 };
  assert.equal(await copyPageDataset(here, source, undefined, answer(201, ok)), src(here));
  assert.equal(calls[0][0], src(here));
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), { from_page_id: there });
  await assert.rejects(
    copyPageDataset(here, source, undefined, answer(403, { error: "Forbidden" })),
    { status: 403, message: "Forbidden" },
  );
  await assert.rejects(
    copyPageDataset(here, source, undefined, answer(200, { ...ok, url: src(there) })),
    /invalid dataset reference/,
  );
});

test("each failure says why and that the title pasted instead", () => {
  assert.match(copyFailure({ status: 403 }), /don't have access.*title instead/);
  assert.match(copyFailure({ status: 404 }), /no longer on the Page.*title instead/);
  assert.match(copyFailure(new TypeError("Failed to fetch")), /Couldn't reach Pages.*title/);
  assert.equal(
    copyFailure({ status: 413, message: "Datasets must be 5 MiB or smaller" }),
    "Couldn't copy the table's data: Datasets must be 5 MiB or smaller. Pasted its title instead.",
  );
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
function harness(t, { insert } = {}) {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const copies = [],
    inserted = [],
    states = [];
  const copier = createDataframeCopier({
    pageId: here,
    parser: new dom.window.DOMParser(),
    copy(source, signal) {
      const pending = { source, signal, ...deferred() };
      copies.push(pending);
      return pending.promise;
    },
    insert:
      insert ?? ((html, target, copied) => inserted.push([target, Object.fromEntries(copied)])),
    onState: (state) => states.push(state.name === "failed" ? state.message : state.name),
  });
  return { dom, copier, copies, inserted, states };
}

test("a pasted table copies, then the paste lands with its src on this Page", async (t) => {
  const h = harness(t);
  const html = copiedHTML(h.dom, { src: src(there) }, { src: src(elsewhere, assetB) });
  assert.equal(
    h.copier.accept(html, () => "target"),
    true,
  );
  assert.equal(
    h.copier.accept(html, () => "second"),
    false,
    "a second paste takes its own path",
  );
  assert.deepEqual(
    h.copies.map(({ source }) => source.pageId),
    [there, elsewhere],
  );
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.inserted, []);
  h.copies[1].resolve(src(here, assetB));
  await settle();
  assert.deepEqual(h.inserted, [
    ["target", { [src(there)]: src(here), [src(elsewhere, assetB)]: src(here, assetB) }],
  ]);
  assert.deepEqual(h.states, ["copying", "idle"]);
  assert.equal(COPYING.includes("another Page"), true);
});

test("a failed copy lands the paste with what did copy, and says why", async (t) => {
  const h = harness(t);
  const html = copiedHTML(h.dom, { src: src(there) }, { src: src(elsewhere, assetB) });
  h.copier.accept(html, () => "target");
  h.copies[0].resolve(src(here));
  h.copies[1].reject(Object.assign(Error("Forbidden"), { status: 403 }));
  await settle();
  assert.deepEqual(h.inserted, [["target", { [src(there)]: src(here) }]]);
  assert.deepEqual(h.states, ["copying", copyFailure({ status: 403 })]);
  // Offline: fetch itself fails.
  h.copier.accept(html, () => "next");
  for (const copy of h.copies.slice(2)) copy.reject(new TypeError("Failed to fetch"));
  await settle();
  assert.deepEqual(h.inserted.at(-1), ["next", {}]);
  assert.match(h.states.at(-1), /Couldn't reach Pages/);
});

test("cancel drops the paste; a paste with nothing foreign, or no target, isn't taken", async (t) => {
  const h = harness(t);
  const html = copiedHTML(h.dom, { src: src(there) });
  h.copier.accept(html, () => "target");
  h.copier.cancel();
  assert.equal(h.copies[0].signal.aborted, true);
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(h.states, ["copying", "idle"]);
  assert.equal(
    h.copier.accept(copiedHTML(h.dom, { src: src(here) }), () => "x"),
    false,
  );
  assert.equal(
    h.copier.accept(html, () => {
      throw Error("read-only");
    }),
    false,
  );
  assert.equal(h.copies.length, 1);
});

test("a paste whose place is gone says so", async (t) => {
  const h = harness(t, {
    insert() {
      throw Error("The place you pasted changed before the table copied. Paste again.");
    },
  });
  h.copier.accept(copiedHTML(h.dom, { src: src(there) }), () => "target");
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.states, [
    "copying",
    "idle",
    "The place you pasted changed before the table copied. Paste again.",
  ]);
  h.copier.destroy();
  assert.equal(
    h.copier.accept(copiedHTML(h.dom, { src: src(there) }), () => "x"),
    false,
  );
});
