// The dataframe-copy machine over every state × event, its interpreter, and
// the paste helpers: a table pasted from another Page lands with this Page's
// copy of its data, or as its title when the copy fails.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parse, serialize } from "wordgard/doc";
import { runTable } from "../shared/machine-test.mjs";
import { REJECT, dataframeCopyMachine } from "./dataframe-copy-machine.mjs";
import * as A from "@automerge/automerge";
import { GardState } from "wordgard/state";
import {
  COPYING,
  NOT_BROUGHT,
  OVER_LIMIT,
  PASTE_COPY_CONCURRENCY,
  PASTE_TABLE_LIMIT,
  copyFailure,
  copyPageDataset,
  createDataframeCopier,
  heldPasteChange,
  pastedSlice,
  readsPastedHTML,
} from "./dataframe-copy.mjs";
import {
  COPY_LIMIT,
  COPY_TTL_MS,
  clipboardCopyId,
  copyMarker,
  lookupCopy,
  markCopiedHTML,
  recordCopy,
} from "./copy-registry.mjs";
import { captureImageInsertion } from "./image-upload.mjs";
import { createWordgardBinding } from "./wordgard-binding.mjs";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { blockMarkdown } from "../model/richtext.mjs";
import {
  CodeBlock,
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
/** localStorage as this browser's copy registry sees it. */
function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
  };
}
const asset = (n) => n.toString(16).padStart(64, "0");

function harness(t, { insert } = {}) {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const parser = new dom.window.DOMParser();
  const storage = memoryStorage();
  const copies = [],
    inserted = [],
    states = [];
  const copier = createDataframeCopier({
    pageId: here,
    parser,
    lookup: (id) => lookupCopy(id, { storage: () => storage }),
    copy(source, signal) {
      const pending = { source, signal, ...deferred() };
      copies.push(pending);
      return pending.promise;
    },
    insert:
      insert ?? ((html, target, copied) => inserted.push([target, Object.fromEntries(copied)])),
    onState: (state) => states.push(state.name === "failed" ? state.message : state.name),
  });
  // A copy out of `page`'s editor: its tables, marked as the editor's
  // clipboard output filter marks them.
  const copyFrom = (page, ...assets) =>
    markCopiedHTML(copiedHTML(dom, ...assets.map((id) => ({ src: src(page, id) }))), page, {
      parser,
      storage: () => storage,
    });
  return { dom, parser, storage, copier, copies, inserted, states, copyFrom };
}

test("a table copied in one editor and pasted in another issues exactly one copy", async (t) => {
  const h = harness(t);
  const html = h.copyFrom(there, assetA);
  assert.match(html, /data-pages-copy/);
  assert.equal(
    h.copier.accept(html, () => "target"),
    true,
  );
  assert.equal(h.copies.length, 1);
  assert.deepEqual(h.copies[0].source, { src: src(there), pageId: there, assetId: assetA });
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.inserted, [["target", { [src(there)]: src(here) }]]);
  assert.deepEqual(h.states, ["copying", "idle"]);
  assert.equal(COPYING.includes("another Page"), true);
});

test("a second paste while one copies takes the editor's own path", async (t) => {
  const h = harness(t);
  const html = h.copyFrom(there, assetA, assetB);
  h.copier.accept(html, () => "target");
  assert.equal(
    h.copier.accept(html, () => "second"),
    false,
  );
  assert.equal(h.copies.length, 2);
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.inserted, []);
  h.copies[1].resolve(src(here, assetB));
  await settle();
  assert.deepEqual(h.inserted, [
    ["target", { [src(there)]: src(here), [src(there, assetB)]: src(here, assetB) }],
  ]);
});

test("forged or foreign clipboard references issue no copy and say why", async (t) => {
  const h = harness(t);
  const forged = copiedHTML(h.dom, { src: src(there) });
  const known = recordCopy({ pageId: elsewhere, assets: [assetA] }, { storage: () => h.storage });
  const lacking = recordCopy({ pageId: there, assets: [assetB] }, { storage: () => h.storage });
  for (const [label, html] of [
    ["no copy element", forged],
    ["an unknown id", forged + copyMarker("f".repeat(32))],
    ["a record for another Page", forged + copyMarker(known)],
    ["a record without that asset", forged + copyMarker(lacking)],
    ["a malformed element", forged + `<span data-pages-copy='{"v":1,"id":"x"}'></span>`],
    ["a newer format", forged + `<span data-pages-copy='{"v":2,"id":"${lacking}"}'></span>`],
  ]) {
    assert.equal(
      h.copier.accept(html, () => "target"),
      false,
      label,
    );
    assert.equal(h.copies.length, 0, label);
    assert.equal(h.states.at(-1), NOT_BROUGHT, label);
  }
  // The copy element only carries an id: page and asset fields in it count
  // for nothing.
  const lying =
    forged + `<span data-pages-copy='{"v":1,"id":"${known}","page":"${there}"}'></span>`;
  assert.equal(
    h.copier.accept(lying, () => "target"),
    false,
  );
  assert.equal(h.copies.length, 0);
});

test("of a paste's tables, only those this browser copied copy; the rest are titles", async (t) => {
  const h = harness(t);
  const own = h.copyFrom(there, assetA);
  const mixed = own + copiedHTML(h.dom, { src: src(there, assetB) });
  h.copier.accept(mixed, () => "target");
  assert.deepEqual(
    h.copies.map(({ source }) => source.assetId),
    [assetA],
  );
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.inserted, [["target", { [src(there)]: src(here) }]]);
  assert.equal(h.states.at(-1), NOT_BROUGHT);
});

test("one paste copies at most the table limit, two at a time", async (t) => {
  const h = harness(t);
  const assets = Array.from({ length: PASTE_TABLE_LIMIT + 3 }, (_, n) => asset(n + 1));
  h.copier.accept(h.copyFrom(there, ...assets), () => "target");
  assert.equal(h.copies.length, PASTE_COPY_CONCURRENCY);
  for (let n = 0; n < PASTE_TABLE_LIMIT; n++) {
    h.copies[n].resolve(src(here, h.copies[n].source.assetId));
    await settle();
  }
  assert.equal(h.copies.length, PASTE_TABLE_LIMIT);
  assert.deepEqual(
    h.copies.map(({ source }) => source.assetId),
    assets.slice(0, PASTE_TABLE_LIMIT),
  );
  assert.equal(Object.keys(h.inserted[0][1]).length, PASTE_TABLE_LIMIT);
  assert.equal(h.states.at(-1), OVER_LIMIT);
});

test("a failed copy lands the paste with what did copy, and says why", async (t) => {
  const h = harness(t);
  const html = h.copyFrom(there, assetA, assetB);
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
  const html = h.copyFrom(there, assetA);
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
  h.copier.accept(h.copyFrom(there, assetA), () => "target");
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.states, [
    "copying",
    "idle",
    "The place you pasted changed before the table copied. Paste again.",
  ]);
  h.copier.destroy();
  assert.equal(
    h.copier.accept(h.copyFrom(there, assetA), () => "x"),
    false,
  );
});

test("the copy registry keeps the newest copies for a day, and nothing without storage", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const storage = memoryStorage();
  const options = (now) => ({ storage: () => storage, now });
  const ids = Array.from({ length: COPY_LIMIT + 5 }, (_, n) =>
    recordCopy({ pageId: there, assets: [assetA] }, options(1000 + n)),
  );
  const now = 1000 + ids.length;
  assert.equal(lookupCopy(ids[0], options(now)), null, "the oldest copies are dropped");
  assert.deepEqual(lookupCopy(ids.at(-1), options(now)), {
    id: ids.at(-1),
    page: there,
    assets: [assetA],
  });
  assert.equal(lookupCopy(ids.at(-1), options(1000 + COPY_TTL_MS + ids.length)), null);
  assert.equal(JSON.parse(storage.items.values().next().value).length, COPY_LIMIT);
  // Storage that's missing, throws, or holds garbage records and finds nothing.
  const throwing = {
    getItem() {
      throw Error("SecurityError");
    },
    setItem() {
      throw Error("QuotaExceededError");
    },
  };
  for (const store of [
    () => undefined,
    () => throwing,
    () => {
      throw Error("blocked");
    },
  ]) {
    assert.equal(recordCopy({ pageId: there, assets: [assetA] }, { storage: store }), null);
    assert.equal(lookupCopy(ids.at(-1), { storage: store }), null);
  }
  const garbage = memoryStorage();
  garbage.setItem("pages.clipboard-copies.v1", "{not json");
  assert.equal(lookupCopy(ids.at(-1), { storage: () => garbage }), null);
  // Without a record, the editor's copy goes out unmarked, as ordinary HTML.
  const parser = new dom.window.DOMParser();
  const html = copiedHTML(dom, { src: src(there) });
  assert.equal(markCopiedHTML(html, there, { parser, storage: () => throwing }), html);
  // A copy of another Page's table, or of no table, isn't recorded.
  assert.equal(markCopiedHTML(html, here, { parser, storage: () => storage }), html);
  const marked = markCopiedHTML(html, there, { parser, storage: () => storage });
  assert.equal(lookupCopy(clipboardCopyId(marked, parser), options(Date.now())).page, there);
  // The marker never pastes as content.
  assert.deepEqual(
    dataframes(dom, pastedPageHTML(marked, there, parser)).map((value) => value.src),
    [src(there)],
  );
  assert.equal(pastedPageHTML(marked, there, parser).includes("data-pages-copy"), false);
});

test("in a code block, or as plain text, a paste reads text and isn't held", () => {
  const state = GardState.create({
    doc: schema.doc([Paragraph.create([]), CodeBlock.create([])]),
    config: [GardState.schemaElement.of(schema.elements)],
  });
  const transfer = (data) => ({ getData: (type) => data[type] ?? "" });
  const html = `<figure data-pages-dataframe='{}'>t</figure>`;
  const both = transfer({ "text/html": html, "text/plain": "t" });
  const inParagraph = 1,
    inCode = state.doc.content[0].length + 1;
  assert.equal(readsPastedHTML(state, both, { at: inParagraph }), true);
  assert.equal(readsPastedHTML(state, both, { at: inCode }), false);
  assert.equal(readsPastedHTML(state, both, { at: inParagraph, plain: true }), false);
  // With no text at all, Wordgard reads the HTML even in code.
  assert.equal(readsPastedHTML(state, transfer({ "text/html": html }), { at: inCode }), true);
  assert.equal(readsPastedHTML(state, transfer({ "text/plain": "t" }), { at: inParagraph }), false);
});

test("a held paste replaces the selected text, or lands at the end that still resolves", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  let doc = A.change(A.from(createPageData({ pageId: here, title: "Paste" })), (d) =>
    initializePage(d, "Keep this, replace this."),
  );
  const id = orderedBlockIds(doc)[0];
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      doc = A.change(doc, fn);
    },
    observeChange: () => () => {},
  };
  const binding = createWordgardBinding(replica, id);
  t.after(() => binding.destroy());
  const state = () =>
    GardState.create({
      doc: binding.current.doc,
      config: [GardState.schemaElement.of(schema.elements)],
    });
  const text = binding.current.doc.content[0].textContent();
  const start = 1 + text.indexOf("replace this"),
    end = start + "replace this".length;
  const editor = {
    state: { ...state(), selection: { anchor: start, head: end, to: end }, readOnly: false },
  };
  const capture = (position) =>
    captureImageInsertion(replica, id, editor, binding.current.map, position);
  const target = { from: capture(start), to: capture(end) };
  const slice = pastedSlice(
    state(),
    copiedHTML(dom, { src: src(here), title: "Pasted" }).replace("<p></p>", ""),
    { document: dom.window.document.implementation.createHTMLDocument("") },
  );
  const changes = heldPasteChange(replica, target, binding.current.map, slice);
  assert.deepEqual([changes.from, changes.to], [start, end]);
  binding.applyEditorTransaction(
    state().update({ changes: { correct: changes, local: true }, userEvent: "input.paste" }),
  );
  const markdown = blockMarkdown(doc.blocks[id]);
  assert.equal(markdown.includes("replace this"), false, markdown);
  assert.match(markdown, /Keep this, /);
  assert.match(markdown, /\[Dataframe: Pasted\]/);
  // When the selected text is gone, the paste lands where the caret was
  // and nothing else is removed.
  assert.deepEqual(
    Object.keys(
      heldPasteChange(replica, { from: target.from, to: target.to }, binding.current.map, slice),
    ),
    ["from", "insert", "fit"],
  );
});
