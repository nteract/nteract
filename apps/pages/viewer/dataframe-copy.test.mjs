// The dataframe-copy machine over every state × event, its interpreter, and
// the paste helpers: a table pasted from another Page lands with this Page's
// copy of its data, or as its title when the copy fails.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parse, serialize, Slice } from "wordgard/doc";
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
  landHeldPaste,
  pastedSlice,
  readsPastedHTML,
} from "./dataframe-copy.mjs";
import {
  COPY_LIMIT,
  COPY_TITLE_MAX,
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
const confirming = { name: "confirming", token: 2 };
const copying = { name: "copying", token: 2 };
const failed = { name: "failed", message: "No access. Pasted its title instead." };
const row = (label, state, event, expect, kase) => ({
  label,
  ...(kase && { case: kase }),
  state,
  event,
  expect: { effects: [], ...expect },
});
const refused = (label, state, event, reason, kase) =>
  row(label, state, event, { state, rejected: reason }, kase);
const ROWS = [
  row(
    "a paste with this browser's tables from another Page is held to ask",
    idle,
    { type: "start", token: 1 },
    { state: { name: "confirming", token: 1 } },
  ),
  refused(
    "a second paste waits while one asks",
    confirming,
    { type: "start", token: 3 },
    REJECT.busy,
  ),
  refused(
    "a second paste waits while one copies",
    copying,
    { type: "start", token: 3 },
    REJECT.busy,
  ),
  row(
    "a new paste clears the last failure",
    failed,
    { type: "start", token: 3 },
    { state: { name: "confirming", token: 3 } },
  ),
  refused("idle has nothing to confirm", idle, { type: "confirm" }, REJECT.unasked),
  row(
    "confirming starts the copies",
    confirming,
    { type: "confirm" },
    { state: copying, effects: [{ type: "copy", token: 2 }] },
  ),
  refused("a second confirm is ignored", copying, { type: "confirm" }, REJECT.unasked),
  refused("a failure has nothing to confirm", failed, { type: "confirm" }, REJECT.unasked),
  refused("idle has nothing to decline", idle, { type: "decline" }, REJECT.unasked),
  row(
    "declining lands the paste with titles and copies nothing",
    confirming,
    { type: "decline" },
    { state: idle, effects: [{ type: "insert", token: 2 }] },
  ),
  refused("declining once copying is too late", copying, { type: "decline" }, REJECT.unasked),
  refused("a failure has nothing to decline", failed, { type: "decline" }, REJECT.unasked),
  refused("idle has no copy to finish", idle, { type: "copied", token: 1 }, REJECT.stale),
  refused("nothing copies before confirm", confirming, { type: "copied", token: 2 }, REJECT.stale),
  row(
    "the copy finishes and the paste lands",
    copying,
    { type: "copied", token: 2 },
    { state: idle, effects: [{ type: "insert", token: 2 }] },
    "current",
  ),
  refused(
    "a cancelled paste's copy is ignored",
    copying,
    { type: "copied", token: 1 },
    REJECT.stale,
    "stale",
  ),
  refused(
    "a shown failure ignores a late copy",
    failed,
    { type: "copied", token: 2 },
    REJECT.stale,
  ),
  refused(
    "idle has no copy to fail",
    idle,
    { type: "failed", token: 1, message: "x" },
    REJECT.stale,
  ),
  refused(
    "nothing fails before confirm",
    confirming,
    { type: "failed", token: 2, message: "x" },
    REJECT.stale,
  ),
  row(
    "a failed copy says why, and the paste lands with the title",
    copying,
    { type: "failed", token: 2, message: "No access" },
    { state: { name: "failed", message: "No access" }, effects: [{ type: "insert", token: 2 }] },
    "current",
  ),
  refused(
    "a cancelled paste's failure is ignored",
    copying,
    { type: "failed", token: 1, message: "x" },
    REJECT.stale,
    "stale",
  ),
  refused(
    "a shown failure ignores a late one",
    failed,
    { type: "failed", token: 2, message: "x" },
    REJECT.stale,
  ),
  row(
    "a paste that can't land says why",
    idle,
    { type: "problem", message: "Paste again." },
    { state: { name: "failed", message: "Paste again." } },
  ),
  refused(
    "a problem while asking waits",
    confirming,
    { type: "problem", message: "x" },
    REJECT.busy,
  ),
  refused("a problem while copying waits", copying, { type: "problem", message: "x" }, REJECT.busy),
  row(
    "a problem after a failure replaces it",
    failed,
    { type: "problem", message: "Newer" },
    { state: { name: "failed", message: "Newer" } },
  ),
  refused("nothing to cancel", idle, { type: "cancel" }, REJECT.idle),
  row(
    "cancel while asking drops the paste",
    confirming,
    { type: "cancel" },
    { state: idle, effects: [{ type: "abort", token: 2 }] },
  ),
  row(
    "cancel while copying drops the paste",
    copying,
    { type: "cancel" },
    { state: idle, effects: [{ type: "abort", token: 2 }] },
  ),
  row("dismiss clears a failure", failed, { type: "cancel" }, { state: idle }),
];

test("the dataframe-copy machine covers every state × event", async () => {
  assert.deepEqual(await runTable(dataframeCopyMachine, ROWS), {
    rows: 30,
    pairs: 28,
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
    states = [],
    questions = [];
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
    onState: (state) => {
      states.push(state.name === "failed" ? state.message : state.name);
      if (state.name === "confirming") questions.push(copier.question);
    },
  });
  // A copy out of `page`'s editor: its tables, marked as the editor's
  // clipboard output filter marks them, with the Page's title in the record.
  const copyFrom = (page, ...assets) =>
    markCopiedHTML(copiedHTML(dom, ...assets.map((id) => ({ src: src(page, id) }))), page, {
      parser,
      storage: () => storage,
      title: "Usage this week",
    });
  // Paste and say yes.
  const bring = (html, target = () => "target") => {
    const taken = copier.accept(html, target);
    if (taken) copier.confirm();
    return taken;
  };
  return { dom, parser, storage, copier, copies, inserted, states, questions, copyFrom, bring };
}

test("a table copied in one editor and pasted in another asks, then issues exactly one copy", async (t) => {
  const h = harness(t);
  const html = h.copyFrom(there, assetA);
  assert.match(html, /data-pages-copy/);
  assert.equal(
    h.copier.accept(html, () => "target"),
    true,
  );
  assert.equal(h.copier.state.name, "confirming");
  assert.equal(h.copies.length, 0, "nothing is copied before the person says yes");
  assert.deepEqual(h.questions, [
    `Bring the data for 1 table from "Usage this week" into this Page?`,
  ]);
  h.copier.confirm();
  assert.equal(h.copies.length, 1);
  assert.deepEqual(h.copies[0].source, { src: src(there), pageId: there, assetId: assetA });
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.inserted, [["target", { [src(there)]: src(here) }]]);
  assert.deepEqual(h.states, ["confirming", "copying", "idle"]);
  assert.equal(COPYING.includes("another Page"), true);
});

test("a replayed copy id asks with the record's title and copies nothing until confirmed", async (t) => {
  const h = harness(t);
  // A site that saw the clipboard keeps the id and wraps the reference in
  // its own content, under its own title.
  const id = clipboardCopyId(h.copyFrom(there, assetA), h.parser);
  const replay =
    "<p>Totally ordinary notes</p>" +
    copiedHTML(h.dom, { src: src(there), title: "Lunch menu" }) +
    copyMarker(id);
  assert.equal(
    h.copier.accept(replay, () => "target"),
    true,
  );
  assert.equal(h.copies.length, 0);
  assert.equal(h.questions.at(-1).includes("Usage this week"), true);
  assert.equal(h.questions.at(-1).includes("Lunch menu"), false);
  // Paste titles only: lands now, copies nothing.
  h.copier.decline();
  await settle();
  assert.equal(h.copies.length, 0);
  assert.deepEqual(h.inserted, [["target", {}]]);
  assert.deepEqual(h.states, ["confirming", "idle"]);
  // Cancel drops the paste and copies nothing.
  h.copier.accept(replay, () => "again");
  h.copier.cancel();
  await settle();
  assert.equal(h.copies.length, 0);
  assert.equal(h.inserted.length, 1);
});

test("a second paste while one is held takes the editor's own path", async (t) => {
  const h = harness(t);
  const html = h.copyFrom(there, assetA, assetB);
  h.copier.accept(html, () => "target");
  assert.equal(
    h.copier.accept(html, () => "second"),
    false,
    "while asking",
  );
  h.copier.confirm();
  assert.equal(
    h.copier.accept(html, () => "second"),
    false,
    "while copying",
  );
  assert.equal(h.copies.length, 2);
  assert.deepEqual(h.questions, [
    `Bring the data for 2 tables from "Usage this week" into this Page?`,
  ]);
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.inserted, []);
  h.copies[1].resolve(src(here, assetB));
  await settle();
  assert.deepEqual(h.inserted, [
    ["target", { [src(there)]: src(here), [src(there, assetB)]: src(here, assetB) }],
  ]);
});

test("forged or foreign clipboard references issue no copy, raise no question, and say why", async (t) => {
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
  assert.deepEqual(h.questions, []);
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
  h.bring(mixed);
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
  h.bring(h.copyFrom(there, ...assets));
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

test("past the limit and not this browser's own, the Page gives both reasons", async (t) => {
  const h = harness(t);
  const assets = Array.from({ length: PASTE_TABLE_LIMIT + 1 }, (_, n) => asset(n + 1));
  const html = h.copyFrom(there, ...assets) + copiedHTML(h.dom, { src: src(there, asset(99)) });
  h.bring(html);
  for (let n = 0; n < PASTE_TABLE_LIMIT; n++) {
    h.copies[n].resolve(src(here, h.copies[n].source.assetId));
    await settle();
  }
  assert.equal(h.copies.length, PASTE_TABLE_LIMIT);
  assert.equal(h.states.at(-1), `${OVER_LIMIT} ${NOT_BROUGHT}`);
});

test("a failed copy lands the paste with what did copy, and says why", async (t) => {
  const h = harness(t);
  const html = h.copyFrom(there, assetA, assetB);
  h.bring(html);
  h.copies[0].resolve(src(here));
  h.copies[1].reject(Object.assign(Error("Forbidden"), { status: 403 }));
  await settle();
  assert.deepEqual(h.inserted, [["target", { [src(there)]: src(here) }]]);
  assert.deepEqual(h.states, ["confirming", "copying", copyFailure({ status: 403 })]);
  // Offline: fetch itself fails.
  h.bring(html, () => "next");
  for (const copy of h.copies.slice(2)) copy.reject(new TypeError("Failed to fetch"));
  await settle();
  assert.deepEqual(h.inserted.at(-1), ["next", {}]);
  assert.match(h.states.at(-1), /Couldn't reach Pages/);
});

test("cancel drops the paste; a paste with nothing foreign, or no target, isn't taken", async (t) => {
  const h = harness(t);
  const html = h.copyFrom(there, assetA);
  h.bring(html);
  h.copier.cancel();
  assert.equal(h.copies[0].signal.aborted, true);
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(h.states, ["confirming", "copying", "idle"]);
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
  h.bring(h.copyFrom(there, assetA));
  h.copies[0].resolve(src(here));
  await settle();
  assert.deepEqual(h.states, [
    "confirming",
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

test("the copy registry keeps the newest copies for an hour, and nothing without storage", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const storage = memoryStorage();
  const options = (now) => ({ storage: () => storage, now });
  const ids = Array.from({ length: COPY_LIMIT + 5 }, (_, n) =>
    recordCopy(
      { pageId: there, assets: [assetA], title: `  Usage\n${"x".repeat(300)}` },
      options(1000 + n),
    ),
  );
  assert.equal(COPY_TTL_MS, 60 * 60 * 1000);
  const now = 1000 + ids.length;
  assert.equal(lookupCopy(ids[0], options(now)), null, "the oldest copies are dropped");
  assert.deepEqual(lookupCopy(ids.at(-1), options(now)), {
    id: ids.at(-1),
    page: there,
    assets: [assetA],
    title: `Usage ${"x".repeat(300)}`.slice(0, COPY_TITLE_MAX),
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

function bindingFixture(t, text) {
  let doc = A.change(A.from(createPageData({ pageId: here, title: "Paste" })), (d) =>
    initializePage(d, text),
  );
  const id = orderedBlockIds(doc)[0];
  // A replica that publishes its changes, as a Pages session does, so the
  // binding follows each landed paste.
  const observers = new Set();
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      const before = doc;
      doc = A.change(doc, fn);
      for (const observe of observers)
        observe({
          remote: false,
          patches: A.diff(doc, A.getHeads(before), A.getHeads(doc)),
          patchInfo: { before, after: doc },
        });
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
  };
  const binding = createWordgardBinding(replica, id);
  t.after(() => binding.destroy());
  const state = (selection) =>
    GardState.create({
      doc: binding.current.doc,
      ...(selection && { selection }),
      config: [GardState.schemaElement.of(schema.elements)],
    });
  // The editor's state, captured as a paste captures it.
  const capture = (from, to = from) => {
    const editor = {
      state: { ...state(), selection: { anchor: from, head: to, to }, readOnly: false },
    };
    const at = (position) =>
      captureImageInsertion(replica, id, editor, binding.current.map, position);
    const end = at(to);
    return { from: from === to ? end : at(from), to: end };
  };
  // Land through the binding as the editor's dispatch does; returns the
  // transaction so a test can read the selection it set.
  const land = (target, slice, selection) => {
    let tr;
    landHeldPaste({
      replica,
      target,
      map: binding.current.map,
      slice,
      selection,
      dispatch: (spec) => binding.applyEditorTransaction((tr = state().update(spec))),
    });
    return tr;
  };
  return {
    replica,
    binding,
    state,
    capture,
    land,
    text: () => binding.current.doc.content[0].textContent(),
    markdown: () => blockMarkdown(doc.blocks[id]),
  };
}
const tableSlice = (dom, state, attrs) =>
  pastedSlice(state, copiedHTML(dom, attrs).replace("<p></p>", ""), {
    document: dom.window.document.implementation.createHTMLDocument(""),
  });

test("a held paste replaces the selected text, or lands at the end that still resolves", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const f = bindingFixture(t, "Keep this, replace this.");
  const start = 1 + f.text().indexOf("replace this"),
    end = start + "replace this".length;
  const target = f.capture(start, end);
  const slice = tableSlice(dom, f.state(), { src: src(here), title: "Pasted" });
  const change = heldPasteChange(f.replica, target, f.binding.current.map, slice);
  assert.deepEqual([change.from, change.to], [start, end]);
  f.land(target, slice, { anchor: start, head: end });
  const markdown = f.markdown();
  assert.equal(markdown.includes("replace this"), false, markdown);
  assert.match(markdown, /Keep this, /);
  assert.match(markdown, /\[Dataframe: Pasted\]/);
  // When the selected text is gone, the paste lands where the caret was
  // and nothing else is removed.
  assert.deepEqual(Object.keys(heldPasteChange(f.replica, target, f.binding.current.map, slice)), [
    "from",
    "insert",
    "fit",
  ]);
});

test("pasting over a selected table of the same dataset lands, and says nothing failed", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const f = bindingFixture(t, "Before.");
  // A table already in the block, then selected.
  const at = f.text().length + 1;
  f.land(f.capture(at), tableSlice(dom, f.state(), { src: src(here), title: "Old" }), {
    anchor: 0,
    head: 0,
  });
  const before = f.markdown();
  assert.match(before, /\[Dataframe: Old\]/);
  const size = f.binding.current.doc.length;
  const node = { from: at + 1, to: size - 1 };
  let found;
  f.binding.current.doc.iterate((value, pos) => {
    if (value.type === PagesDataframe) found = { from: pos, to: pos + value.length };
  });
  const range = found ?? node;
  const target = f.capture(range.from, range.to);
  // The same dataset, so the count of matching tables doesn't change.
  assert.doesNotThrow(() =>
    f.land(target, tableSlice(dom, f.state(), { src: src(here), title: "New" }), {
      anchor: range.from,
      head: range.to,
    }),
  );
  const after = f.markdown();
  assert.match(after, /\[Dataframe: New\]/);
  assert.equal(after.includes("Old"), false, after);
  assert.equal(after.match(/\[Dataframe/g).length, 1);
});

test("a held paste at an unmoved caret leaves the caret after what it pasted", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const f = bindingFixture(t, "Before and after.");
  const caret = 1 + f.text().indexOf(" and");
  const target = f.capture(caret);
  const slice = pastedSlice(f.state(), "<p>pasted</p>", {
    document: dom.window.document.implementation.createHTMLDocument(""),
  });
  const tr = f.land(target, slice, { anchor: caret, head: caret });
  const head = tr.state.selection.head;
  assert.ok(head > caret, `caret stayed at ${head}`);
  assert.equal(Slice.get(tr.state.doc, caret, head).textContent().includes("pasted"), true);
  // If the person moved the caret while the paste was held, it stays theirs.
  const moved = f.capture(1);
  const kept = f.land(moved, slice, { anchor: 3, head: 3 });
  assert.equal(kept.selection, undefined);
});
