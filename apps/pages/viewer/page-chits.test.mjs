// Chits (page-chits.mjs): which links draw as one, and when the URL shows.
// The browser smoke (scripts/page-links-smoke.mjs) checks the drawing.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", {
  pretendToBeVisual: true,
  url: "https://pages.example/p/11111111-1111-4111-8111-111111111111",
});
for (const name of [
  "window",
  "document",
  "navigator",
  "location",
  "Node",
  "Element",
  "HTMLElement",
  "Text",
  "Range",
  "Selection",
  "DocumentFragment",
  "ShadowRoot",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "customElements",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "InputEvent",
  "FocusEvent",
  "MouseEvent",
])
  globalThis[name] ??= dom.window[name];
const empty = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = empty;

const { Wordgard } = await import("wordgard/editor");
const { Leaf } = await import("wordgard/doc");
const { GardState, GardSelection, Transaction } = await import("wordgard/state");
const { textPath } = await import("../model/richtext.mjs");
const { richFromSource } = await import("../model/richtext-test-support.mjs");
const { decode, schema } = await import("./wordgard-model.mjs");
const {
  bareLinkRanges,
  chitField,
  chitLabel,
  needsAsking,
  pageChits,
  revealedBy,
  unavailableLabel,
  labeledLinkAsks,
  UNAVAILABLE_DESCRIPTION_IDS,
} = await import("./page-chits.mjs");
const { PagesLink } = await import("./wordgard-model.mjs");
const { pagesLinkShape } = await import("./page-link-shape.mjs");
const { linkedTarget } = await import("../shared/page-links.mjs");
const { provideChitRefs } = await import("./chit-refs.mjs");
const { PageRefs } = await import("./page-refs.mjs");

const BASE = "https://pages.example/p/11111111-1111-4111-8111-111111111111";
const OTHER = "https://pages.example/p/22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "prj_33333333-3333-4333-8333-333333333333";
const PROJECT = `https://pages.example/project/${PROJECT_ID}`;

function treeOf(markdown) {
  const native = A.change(A.from({ blocks: { one: { markdown } } }), (d) =>
    richFromSource(d, "one"),
  );
  return decode(A.spans(native, textPath("one"))).doc;
}

function editor(markdown, { editable = true, currentProjectId = null } = {}) {
  const state = GardState.create({
    doc: treeOf(markdown),
    config: [
      ...schema.elements.map((e) => GardState.schemaElement.of(e)),
      GardState.readOnly.of(!editable),
      Wordgard.editable.of(editable),
      pageChits({ base: () => BASE, currentProjectId: () => currentProjectId }),
    ],
  });
  return new Wordgard({ state, parent: document.body });
}
const field = (wg) => wg.state.field(chitField);
const focus = (wg, focused) => {
  wg.contentDOM.dispatchEvent(
    new dom.window.FocusEvent(focused ? "focusin" : "focusout", { bubbles: true }),
  );
};

test("bare links to other Pages and Projects are chits; other links aren't", () => {
  const doc = treeOf(
    [
      `<${OTHER}> and <${PROJECT}> and <${OTHER}#a-heading>`,
      `[Titled](${OTHER}) and [${OTHER}](${OTHER} "t") and <https://example.com/x>`,
      `<${BASE}> and <https://evil.example/p/22222222-2222-4222-8222-222222222222>`,
      "```\n" + OTHER + "\n```",
      `\`${OTHER}\``,
      `**<${OTHER}>**`,
    ].join("\n\n"),
  );
  const ranges = bareLinkRanges(doc, { base: BASE, currentPageId: null });
  assert.deepEqual(
    ranges.map((range) => [range.href, range.target.kind, range.to - range.from]),
    [
      [OTHER, "page", OTHER.length],
      [PROJECT, "project", PROJECT.length],
      [`${OTHER}#a-heading`, "page", OTHER.length + 10],
      [OTHER, "page", OTHER.length],
    ],
  );
  // The open Project's own links stay plain.
  assert.equal(
    bareLinkRanges(treeOf(`<${PROJECT}>`), { base: BASE, currentProjectId: PROJECT_ID }).length,
    0,
  );
});

test("a link whose text is split by formatting is still one chit", () => {
  // Bold over part of the URL: two text nodes, one link.
  const half = OTHER.slice(0, 20);
  const doc = treeOf(`[**${half}**${OTHER.slice(20)}](${OTHER})`);
  const ranges = bareLinkRanges(doc, { base: BASE });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].to - ranges[0].from, OTHER.length);
});

test("revealedBy: a caret inside or at an edge, or a selection end strictly inside", () => {
  const ranges = [{ from: 5, to: 10 }];
  const at = (anchor, head = anchor) => revealedBy(ranges, { anchor, head }).length;
  for (const pos of [5, 7, 10]) assert.equal(at(pos), 1, `caret ${pos}`);
  for (const pos of [4, 11]) assert.equal(at(pos), 0, `caret ${pos}`);
  assert.equal(at(2, 7), 1);
  assert.equal(at(7, 12), 1);
  assert.equal(at(2, 12), 0, "a selection over the whole chit keeps it closed");
  assert.equal(at(5, 10), 0, "ends exactly at the edges keep it closed");
});

test("the URL shows only for a focused, editable editor's own caret", () => {
  const wg = editor(`See <${OTHER}> now`);
  const [range] = field(wg).ranges;
  // Unfocused: a local selection in the chit doesn't reveal it.
  wg.dispatch({ selection: GardSelection.cursor(range.from + 3) });
  assert.deepEqual(field(wg).revealed, []);
  focus(wg, true);
  assert.deepEqual(field(wg).revealed, [range.from], "focus reveals where the caret is");
  // Moving out closes it; moving to the far edge opens it again.
  wg.dispatch({ selection: GardSelection.cursor(1) });
  assert.deepEqual(field(wg).revealed, []);
  wg.dispatch({ selection: GardSelection.cursor(range.to) });
  assert.deepEqual(field(wg).revealed, [range.from]);
  // A peer's edit before it keeps it open, mapped; it never opens another.
  wg.dispatch({
    changes: { from: 1, insert: [Leaf.text("Hi ")] },
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
  });
  assert.deepEqual(field(wg).revealed, [range.from + 3]);
  wg.dom.remove();
});

test("losing focus closes every chit", async () => {
  const wg = editor(`<${OTHER}>`);
  const [range] = field(wg).ranges;
  wg.dispatch({ selection: GardSelection.cursor(range.from + 1) });
  focus(wg, true);
  assert.deepEqual(field(wg).revealed, [range.from]);
  focus(wg, false);
  await Promise.resolve();
  assert.deepEqual(field(wg).revealed, []);
  wg.dom.remove();
});

test("a peer's caret move or edit never opens a chit", () => {
  const wg = editor(`See <${OTHER}> now`);
  focus(wg, true);
  const [range] = field(wg).ranges;
  wg.dispatch({
    selection: GardSelection.cursor(range.from + 2),
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
  });
  assert.deepEqual(field(wg).revealed, []);
  wg.dispatch({
    changes: { from: range.from + 2, insert: [Leaf.text("x")] },
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
  });
  assert.deepEqual(field(wg).revealed, []);
  wg.dom.remove();
});

test("a read-only block never shows the URL", () => {
  const wg = editor(`<${OTHER}>`, { editable: false });
  focus(wg, true);
  wg.dispatch({ selection: GardSelection.cursor(3) });
  assert.deepEqual(field(wg).revealed, []);
  wg.dom.remove();
});

test("editing the URL so it's no longer bare turns the chit back into a link", () => {
  const wg = editor(`<${OTHER}>`);
  focus(wg, true);
  const [range] = field(wg).ranges;
  wg.dispatch({ selection: GardSelection.cursor(range.to) });
  // Typing inside the link's text changes it from its href.
  wg.dispatch({ changes: { from: range.to - 1, insert: [Leaf.text("x")] } });
  assert.deepEqual(field(wg).ranges, []);
  wg.dom.remove();
});

test("the chit draws the hidden source and a link with the target's attributes", () => {
  const wg = editor(`See <${OTHER}> and <${PROJECT}>`);
  wg.flush?.();
  const sources = wg.contentDOM.querySelectorAll(".wg-chit-source");
  assert.equal(sources.length, 2);
  for (const source of sources) assert.ok(source.querySelector("a"), "the link's <a> is inside");
  const chits = [...wg.contentDOM.querySelectorAll("a.wg-chit")];
  assert.deepEqual(
    chits.map((chit) => [chit.className, chit.dataset.pageId ?? chit.dataset.projectId]),
    [
      ["page-link wg-chit", "22222222-2222-4222-8222-222222222222"],
      ["project-link wg-chit", PROJECT_ID],
    ],
  );
  for (const chit of chits) assert.ok(!chit.closest(".wg-chit-source"), "the chit isn't hidden");
  wg.dom.remove();
});

test("a chit's label follows the tab's refs", async () => {
  const answers = new Map();
  const refs = new PageRefs({
    get: (path) => new Promise((resolve, reject) => answers.set(path, { resolve, reject })),
  });
  refs.account("dev");
  provideChitRefs(refs);
  try {
    const wg = editor(`See <${OTHER}>`);
    wg.flush?.();
    const chit = wg.contentDOM.querySelector("a.wg-chit");
    assert.equal(chit.dataset.state, "loading");
    assert.equal(chit.textContent, "Page");
    const path = "/p/22222222-2222-4222-8222-222222222222/meta.json";
    assert.ok(answers.has(path), "the chit asked for the target's meta");
    answers.get(path).resolve({
      v: 1,
      page_id: "22222222-2222-4222-8222-222222222222",
      title: "Nov 5 Evening Focus",
      state: "active",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(wg.contentDOM.querySelector("a.wg-chit"), chit, "the widget wasn't redrawn");
    assert.equal(chit.textContent, "Nov 5 Evening Focus");
    assert.equal(chit.dataset.state, "readable");
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("chitLabel names each face", () => {
  assert.deepEqual(chitLabel("page", null), { text: "Page", state: "loading" });
  assert.deepEqual(chitLabel("project", { name: "idle" }), { text: "Project", state: "loading" });
  assert.deepEqual(chitLabel("page", { name: "readable", value: { title: "T" }, stale: false }), {
    text: "T",
    state: "readable",
  });
  assert.deepEqual(chitLabel("page", { name: "readable", value: { title: "" }, stale: false }), {
    text: "Untitled",
    state: "readable",
  });
  assert.deepEqual(chitLabel("page", { name: "unavailable", stale: false }), {
    text: "Page unavailable",
    state: "unavailable",
  });
  assert.deepEqual(chitLabel("project", { name: "unavailable", stale: true }), {
    text: "Project unavailable",
    state: "unavailable",
  });
  assert.deepEqual(chitLabel("page", { name: "failed", attempts: 1, last: null }), {
    text: null,
    state: "failed",
  });
  // A refresh keeps showing the last title.
  assert.deepEqual(
    chitLabel("page", {
      name: "requested",
      attempts: 0,
      last: { name: "readable", value: { title: "Old" }, stale: true },
    }),
    { text: "Old", state: "readable" },
  );
});

test("needsAsking: missing, stale, or failed past its backoff", () => {
  assert.equal(needsAsking(undefined), true);
  assert.equal(needsAsking({ name: "idle" }), true);
  assert.equal(needsAsking({ name: "requested", attempts: 0, last: null }), false);
  assert.equal(needsAsking({ name: "readable", value: {}, stale: false }), false);
  assert.equal(needsAsking({ name: "readable", value: {}, stale: true }), true);
  assert.equal(needsAsking({ name: "unavailable", stale: true }), true);
  assert.equal(needsAsking({ name: "failed", attempts: 1, last: null, ready: false }), false);
  assert.equal(needsAsking({ name: "failed", attempts: 1, last: null, ready: true }), true);
});

test("a chit asks again after a failure's backoff and after the refs are dropped", async () => {
  const { VirtualTimeScheduler } = await import("rxjs");
  const scheduler = new VirtualTimeScheduler();
  const asks = [];
  const refs = new PageRefs({
    scheduler,
    get: (path) => {
      asks.push(path);
      return asks.length === 1
        ? Promise.reject(Object.assign(Error("down"), { status: 500 }))
        : Promise.resolve({
            v: 1,
            page_id: "22222222-2222-4222-8222-222222222222",
            title: "Back again",
            state: "active",
          });
    },
  });
  refs.account("dev");
  provideChitRefs(refs);
  try {
    const wg = editor(`See <${OTHER}>`);
    wg.flush?.();
    const chit = wg.contentDOM.querySelector("a.wg-chit");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(chit.dataset.state, "failed");
    assert.equal(chit.textContent, OTHER, "a failure shows the URL");
    scheduler.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(asks.length, 2, "the backoff passing asked again");
    assert.equal(chit.textContent, "Back again");
    refs.clear();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(asks.length, 3, "dropped refs are asked for again");
    assert.equal(chit.textContent, "Back again");
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a block that turns read-only closes its open chit", () => {
  const permissions = new GardState.Compartment();
  const state = GardState.create({
    doc: treeOf(`<${OTHER}>`),
    config: [
      ...schema.elements.map((e) => GardState.schemaElement.of(e)),
      permissions.of([GardState.readOnly.of(false), Wordgard.editable.of(true)]),
      pageChits({ base: () => BASE }),
    ],
  });
  const wg = new Wordgard({ state, parent: document.body });
  focus(wg, true);
  const [range] = field(wg).ranges;
  wg.dispatch({ selection: GardSelection.cursor(range.from + 1) });
  wg.flush?.();
  assert.equal(wg.contentDOM.querySelectorAll("a.wg-chit").length, 0);
  wg.dispatch({
    effects: permissions.reconfigure([GardState.readOnly.of(true), Wordgard.editable.of(false)]),
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
  });
  wg.flush?.();
  assert.equal(wg.contentDOM.querySelectorAll("a.wg-chit").length, 1);
  wg.dom.remove();
});

const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PATH = `/p/${OTHER_ID}/meta.json`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const refused = (code) => Object.assign(Error(code), { status: 404, code });

/** An editor that draws link marks as Page blocks and comments do. */
function linkedEditor(markdown, { editable = true } = {}) {
  const state = GardState.create({
    doc: treeOf(markdown),
    config: [
      ...schema.elements.map((e) => GardState.schemaElement.of(e)),
      GardState.readOnly.of(!editable),
      Wordgard.editable.of(editable),
      pagesLinkShape({ currentPageId: () => "11111111-1111-4111-8111-111111111111" }),
      pageChits({ base: () => BASE }),
    ],
  });
  return new Wordgard({ state, parent: document.body });
}

test("unavailableLabel: only a settled unavailable answer marks a labeled link", () => {
  const page = linkedTarget(OTHER, BASE);
  const project = linkedTarget(PROJECT, BASE);
  assert.equal(page.kind, "page");
  assert.equal(project.kind, "project");
  // Loading.
  assert.equal(unavailableLabel(page, null), null);
  assert.equal(unavailableLabel(page, { name: "idle" }), null);
  assert.equal(unavailableLabel(page, { name: "requested", attempts: 0, last: null }), null);
  // Readable, fresh or stale.
  const readable = { name: "readable", value: { title: "T" }, stale: false };
  assert.equal(unavailableLabel(page, readable), null);
  assert.equal(unavailableLabel(page, { ...readable, stale: true }), null);
  // A failed read with nothing settled before it.
  assert.equal(
    unavailableLabel(page, { name: "failed", attempts: 1, last: null, ready: false }),
    null,
  );
  // Unavailable, fresh or stale, and while a stale one is asked again.
  assert.equal(unavailableLabel(page, { name: "unavailable", stale: false }), "Page unavailable");
  assert.equal(unavailableLabel(page, { name: "unavailable", stale: true }), "Page unavailable");
  assert.equal(
    unavailableLabel(page, { name: "requested", attempts: 0, last: { name: "unavailable" } }),
    "Page unavailable",
  );
  assert.equal(
    unavailableLabel(project, { name: "unavailable", stale: false }),
    "Project unavailable",
  );
  // A link to another host, or to a heading on the Page open now, names no
  // target and is never marked.
  const elsewhere = linkedTarget(`https://elsewhere.example/p/${OTHER_ID}`, BASE);
  assert.equal(elsewhere, null);
  assert.equal(unavailableLabel(elsewhere, { name: "unavailable", stale: false }), null);
  const heading = linkedTarget(`${BASE}#plan`, BASE, {
    currentPageId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(heading, null);
  assert.equal(unavailableLabel(heading, { name: "unavailable", stale: false }), null);
});

/** Let a promise settle and Wordgard's animation-frame flush run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
const PROJECT_PATH = `/project/${encodeURIComponent(PROJECT_ID)}/meta.json`;
const PAGE_DESCRIPTION = UNAVAILABLE_DESCRIPTION_IDS.page;
const PROJECT_DESCRIPTION = UNAVAILABLE_DESCRIPTION_IDS.project;

/** A tab whose visibility a test sets; `restore()` puts jsdom's back. */
function visibility() {
  let state = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  return {
    set(next) {
      state = next;
    },
    restore() {
      delete document.visibilityState;
    },
  };
}

/** Tab refs whose answers a test controls: `answers[path]` is "open",
 * "refused", "failed" or "signed-out" (a 401). Every request is in `asks`. */
function scriptedRefs(answers, scheduler) {
  const asks = [];
  const refs = new PageRefs({
    scheduler,
    get: (path) => {
      asks.push(path);
      const answer = answers[path] ?? "refused";
      if (answer === "open") {
        const id = decodeURIComponent(path.split("/")[2]);
        return Promise.resolve(
          path.startsWith("/project/")
            ? { v: 1, kind: "project", project_id: id, title: "Open" }
            : { v: 1, page_id: id, title: "Open", state: "active" },
        );
      }
      if (answer === "failed") return Promise.reject(Object.assign(Error("down"), { status: 500 }));
      if (answer === "signed-out")
        return Promise.reject(Object.assign(Error("signed out"), { status: 401 }));
      return Promise.reject(
        refused(path.startsWith("/project/") ? "project_unavailable" : "page_unavailable"),
      );
    },
  });
  refs.account("dev");
  provideChitRefs(refs);
  const count = (path) => asks.filter((asked) => asked === path).length;
  return { refs, asks, count };
}

const describedBy = (link) => link.getAttribute("aria-describedby");

test("labeledLinkAsks: each ref state by the pass's cause and the tab's visibility", () => {
  const states = {
    missing: undefined,
    idle: { name: "idle" },
    requested: { name: "requested", attempts: 0, last: null },
    "requested over unavailable": { name: "requested", attempts: 0, last: { name: "unavailable" } },
    "readable fresh": { name: "readable", value: {}, stale: false },
    "readable stale": { name: "readable", value: {}, stale: true },
    "unavailable fresh": { name: "unavailable", stale: false },
    "unavailable stale": { name: "unavailable", stale: true },
    "failed backing off": { name: "failed", attempts: 1, last: null, ready: false },
    "failed ready": { name: "failed", attempts: 1, last: null, ready: true },
    "failed refresh backing off": {
      name: "failed",
      attempts: 1,
      last: { name: "unavailable" },
      ready: false,
    },
    "failed refresh ready": {
      name: "failed",
      attempts: 1,
      last: { name: "unavailable" },
      ready: true,
    },
  };
  // Which states ask, per cause and visibility. Everything else asks nothing.
  const asking = {
    draw: ["missing", "idle", "failed ready"],
    change: ["unavailable stale", "failed refresh ready"],
    return: [
      "missing",
      "idle",
      "readable stale",
      "unavailable stale",
      "failed ready",
      "failed refresh ready",
    ],
  };
  const hiddenAsking = { ...asking, change: [] };
  for (const [visible, expected] of [
    [true, asking],
    [false, hiddenAsking],
  ])
    for (const cause of ["draw", "change", "return"])
      for (const [name, ref] of Object.entries(states))
        assert.equal(
          labeledLinkAsks(ref, { cause, visible }),
          expected[cause].includes(name),
          `${name} on ${cause}, ${visible ? "visible" : "hidden"}`,
        );
});

test("a labeled link the reader can't open is marked unavailable without a hover", async () => {
  const { refs, asks } = scriptedRefs({});
  try {
    const wg = linkedEditor(
      `See [the plan](${OTHER}), [the plan again](${OTHER}), [the project](${PROJECT}), ` +
        `[elsewhere](https://elsewhere.example/p/${OTHER_ID}) and [a heading](${BASE}#plan)`,
    );
    wg.flush?.();
    const [plan, again, project, elsewhere, heading] = wg.contentDOM.querySelectorAll("a");
    assert.equal(plan.dataset.linkState, undefined, "loading draws the link as it is");
    await settle();
    assert.deepEqual(
      asks.sort(),
      [PROJECT_PATH, OTHER_PATH].sort(),
      "one ask per distinct target, none for another host or a heading",
    );
    for (const link of [plan, again]) {
      assert.equal(link.dataset.linkState, "unavailable");
      assert.equal(describedBy(link), PAGE_DESCRIPTION);
    }
    assert.equal(project.dataset.linkState, "unavailable");
    assert.equal(describedBy(project), PROJECT_DESCRIPTION);
    for (const link of [elsewhere, heading]) {
      assert.equal(link.dataset.linkState, undefined);
      assert.equal(describedBy(link), null);
    }
    // The descriptions are hidden text outside every editor, once per document.
    for (const [id, text] of [
      [PAGE_DESCRIPTION, "Page unavailable"],
      [PROJECT_DESCRIPTION, "Project unavailable"],
    ]) {
      const description = document.getElementById(id);
      assert.equal(description.textContent, text);
      assert.ok(description.closest("[hidden]"), "the description is hidden");
      assert.equal(description.closest("wg-content, .wordgard-document, [contenteditable]"), null);
      assert.equal(document.querySelectorAll(`[id="${id}"]`).length, 1);
    }
    const second = linkedEditor(`Also [the plan](${OTHER})`);
    second.flush?.();
    await settle();
    assert.equal(describedBy(second.contentDOM.querySelector("a")), PAGE_DESCRIPTION);
    assert.equal(document.querySelectorAll(`[id="${PAGE_DESCRIPTION}"]`).length, 1);
    second.dom.remove();
    // The label stays, the link stays a link, and nothing enters the document.
    assert.equal(plan.textContent, "the plan");
    assert.equal(plan.getAttribute("href"), OTHER);
    assert.match(wg.state.doc.textContent(), /^See the plan, the plan again, the project/);
    assert.equal(wg.contentDOM.textContent, wg.state.doc.textContent());
    // Another description on the link, such as the hover card's, is kept.
    plan.setAttribute("aria-describedby", `${PAGE_DESCRIPTION} card-label`);
    refs.want({ kind: "page", id: "55555555-5555-4555-8555-555555555555" });
    await settle();
    assert.equal(describedBy(plan), `${PAGE_DESCRIPTION} card-label`);
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a marked link whose href stops naming a Page loses its marker", async () => {
  const { refs } = scriptedRefs({});
  try {
    const wg = linkedEditor(`See [the plan](${OTHER}) now`);
    wg.flush?.();
    await settle();
    const from = 1 + "See ".length;
    const range = { from, to: from + "the plan".length };
    const marked = () => {
      const link = wg.contentDOM.querySelector("a");
      return [link.dataset.linkState, describedBy(link)];
    };
    assert.deepEqual(marked(), ["unavailable", PAGE_DESCRIPTION]);
    for (const href of [`https://elsewhere.example/p/${OTHER_ID}`, `${BASE}#plan`]) {
      wg.dispatch({ changes: { ...range, add: PagesLink.of({ href, title: null }) } });
      wg.flush?.();
      await settle();
      assert.equal(wg.contentDOM.querySelector("a").getAttribute("href"), href);
      assert.deepEqual(marked(), [undefined, null], href);
    }
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a 401 holds labeled links until the release, which asks once", async () => {
  const answers = { [OTHER_PATH]: "signed-out" };
  const { refs, count } = scriptedRefs(answers);
  let wg;
  try {
    wg = linkedEditor(`See [the plan](${OTHER})`);
    wg.flush?.();
    await settle();
    // The 401 dropped every ref and held them with the account kept.
    assert.equal(count(OTHER_PATH), 1);
    assert.equal(refs.principal, "dev");
    refs.clear();
    wg.dispatch({ changes: { from: 1, insert: [Leaf.text("So: ")] } });
    wg.flush?.();
    window.dispatchEvent(new dom.window.FocusEvent("focus"));
    await settle();
    assert.equal(count(OTHER_PATH), 1, "a change, a redraw and a return ask nothing while held");
    // The session answers for the same account: one draw pass asks once.
    answers[OTHER_PATH] = "refused";
    refs.session("dev");
    await settle();
    assert.equal(count(OTHER_PATH), 2);
    assert.equal(wg.contentDOM.querySelector("a").dataset.linkState, "unavailable");
  } finally {
    wg?.dom.remove();
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a chit refused with a 401 asks again only after a session answer", async () => {
  const { VirtualTimeScheduler } = await import("rxjs");
  const scheduler = new VirtualTimeScheduler();
  const answers = { [OTHER_PATH]: "signed-out", [PROJECT_PATH]: "signed-out" };
  const { refs, count } = scriptedRefs(answers, scheduler);
  const both = () => count(OTHER_PATH) + count(PROJECT_PATH);
  const blocks = [];
  try {
    // Two editors draw the same chits, each with its own store subscription.
    blocks.push(editor(`See <${OTHER}> and <${PROJECT}>`));
    blocks.push(editor(`Again <${OTHER}> and <${PROJECT}>`));
    for (const wg of blocks) wg.flush?.();
    await settle();
    // Each target was asked once; the first 401 held the tab and aborted
    // the other request, and the drop asked nothing.
    assert.equal(both(), 2);
    for (let round = 0; round < 5; round++) {
      scheduler.flush();
      await settle();
    }
    assert.equal(both(), 2, "no loop while held");
    // A release asks once per target, however many chits draw it; the 401
    // holds again.
    refs.session("dev");
    await settle();
    assert.equal(both(), 4);
    for (let round = 0; round < 5; round++) {
      scheduler.flush();
      await settle();
    }
    assert.equal(both(), 4, "no loop after the second 401 either");
    // The repeat waits on the backoff before its release.
    answers[OTHER_PATH] = "open";
    answers[PROJECT_PATH] = "open";
    refs.session("dev");
    await settle();
    assert.equal(both(), 4, "cooling");
    scheduler.flush();
    await settle();
    assert.equal(both(), 6, "released: each target once");
    for (const wg of blocks) {
      const [page, project] = wg.contentDOM.querySelectorAll("a.wg-chit");
      assert.equal(page.textContent, "Open", "the chit got its title back without a reload");
      assert.equal(project.textContent, "Open");
    }
  } finally {
    for (const wg of blocks) wg.dom.remove();
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a failing target is asked again on a redraw or a return, not on its backoff", async () => {
  const { VirtualTimeScheduler } = await import("rxjs");
  const scheduler = new VirtualTimeScheduler();
  const { refs, count } = scriptedRefs({ [OTHER_PATH]: "failed" }, scheduler);
  try {
    const wg = linkedEditor(`See [the plan](${OTHER}) now`);
    wg.flush?.();
    await settle();
    assert.equal(count(OTHER_PATH), 1);
    assert.equal(wg.contentDOM.querySelector("a").dataset.linkState, undefined);
    scheduler.flush();
    await settle();
    assert.equal(refs.ref({ kind: "page", id: OTHER_ID }, "meta").ready, true);
    assert.equal(count(OTHER_PATH), 1, "the backoff passing asks nothing");
    wg.dispatch({ changes: { from: 1, insert: [Leaf.text("x")] } });
    wg.flush?.();
    await settle();
    assert.equal(count(OTHER_PATH), 2, "a redraw asks");
    scheduler.flush();
    window.dispatchEvent(new dom.window.FocusEvent("focus"));
    await settle();
    assert.equal(count(OTHER_PATH), 3, "a return asks");
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a stale unavailable answer is asked again on a ref change while visible", async () => {
  const { VirtualTimeScheduler } = await import("rxjs");
  const scheduler = new VirtualTimeScheduler();
  const answers = { [OTHER_PATH]: "open", [PROJECT_PATH]: "refused" };
  const { refs, count } = scriptedRefs(answers, scheduler);
  const tab = visibility();
  const both = () => [count(OTHER_PATH), count(PROJECT_PATH)];
  try {
    const wg = linkedEditor(`See [the plan](${OTHER}) and [the project](${PROJECT})`);
    wg.flush?.();
    await settle();
    assert.deepEqual(both(), [1, 1]);

    // Hidden: both answers go stale, and their expiry asks nothing.
    tab.set("hidden");
    scheduler.flush();
    await settle();
    assert.deepEqual(both(), [1, 1], "a hidden tab asks nothing");

    // Visible again without a return event: the next ref change asks for the
    // stale unavailable answer only, never the stale readable one.
    tab.set("visible");
    refs.want({ kind: "page", id: "55555555-5555-4555-8555-555555555555" });
    await settle();
    assert.deepEqual(both(), [1, 2]);

    // Visible, its expiry is the change that asks: every 15 s while unavailable.
    scheduler.flush();
    await settle();
    assert.deepEqual(both(), [1, 3]);
    wg.dom.remove();
  } finally {
    tab.restore();
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a transient unavailable answer clears 15 s later with no return", async () => {
  const { VirtualTimeScheduler } = await import("rxjs");
  const scheduler = new VirtualTimeScheduler();
  const answers = { [OTHER_PATH]: "refused" };
  const { refs, count } = scriptedRefs(answers, scheduler);
  try {
    const wg = linkedEditor(`See [the plan](${OTHER})`);
    wg.flush?.();
    await settle();
    const plan = wg.contentDOM.querySelector("a");
    assert.equal(plan.dataset.linkState, "unavailable");
    // The host was slow, not refusing: its next answer is the Page.
    answers[OTHER_PATH] = "open";
    scheduler.flush();
    await settle();
    assert.equal(count(OTHER_PATH), 2);
    assert.equal(wg.contentDOM.querySelector("a"), plan, "the link wasn't redrawn");
    assert.equal(plan.dataset.linkState, undefined);
    assert.equal(describedBy(plan), null);
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a wrong lock whose recheck fails heals on the recheck's backoff", async () => {
  const { VirtualTimeScheduler } = await import("rxjs");
  const scheduler = new VirtualTimeScheduler();
  const answers = { [OTHER_PATH]: "refused" };
  const { refs, count } = scriptedRefs(answers, scheduler);
  try {
    const wg = linkedEditor(`See [the plan](${OTHER})`);
    wg.flush?.();
    await settle();
    const plan = wg.contentDOM.querySelector("a");
    assert.equal(plan.dataset.linkState, "unavailable");
    // The 15 s recheck fails; the lock stays from the earlier answer.
    answers[OTHER_PATH] = "failed";
    scheduler.flush();
    await settle();
    assert.equal(count(OTHER_PATH), 2);
    const ref = refs.ref({ kind: "page", id: OTHER_ID }, "meta");
    assert.equal(ref.name, "failed");
    assert.equal(ref.last?.name, "unavailable");
    assert.equal(plan.dataset.linkState, "unavailable");
    // The host recovers; the backoff passing asks again, with no return.
    answers[OTHER_PATH] = "open";
    scheduler.flush();
    await settle();
    assert.equal(count(OTHER_PATH), 3);
    assert.equal(plan.dataset.linkState, undefined);
    assert.equal(describedBy(plan), null);
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("another account asks again with no redraw; a 401's drop asks nothing", async () => {
  const { refs, count } = scriptedRefs({ [OTHER_PATH]: "open" });
  try {
    const wg = linkedEditor(`See [the plan](${OTHER})`);
    wg.flush?.();
    await settle();
    assert.equal(count(OTHER_PATH), 1);
    refs.account("other");
    await settle();
    assert.equal(count(OTHER_PATH), 2, "the new account's answer is asked for");
    refs.refused();
    await settle();
    assert.equal(count(OTHER_PATH), 2, "a 401's drop asks nothing");
    refs.clear();
    await settle();
    assert.equal(count(OTHER_PATH), 2, "dropping refs with the account kept asks nothing");
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a return to the tab asks once per stale target across blocks", async () => {
  const { VirtualTimeScheduler } = await import("rxjs");
  const scheduler = new VirtualTimeScheduler();
  const answers = { [OTHER_PATH]: "open", [PROJECT_PATH]: "refused" };
  const { refs, count } = scriptedRefs(answers, scheduler);
  const tab = visibility();
  const both = () => [count(OTHER_PATH), count(PROJECT_PATH)];
  try {
    const blocks = [
      linkedEditor(`See [the plan](${OTHER}) and [the project](${PROJECT})`),
      linkedEditor(`Again: [the plan](${OTHER}) and [the project](${PROJECT})`),
    ];
    for (const wg of blocks) wg.flush?.();
    await settle();
    assert.deepEqual(both(), [1, 1]);

    // Stale while hidden; a hidden visibilitychange asks nothing.
    tab.set("hidden");
    scheduler.flush();
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await settle();
    assert.deepEqual(both(), [1, 1]);

    // Turning visible asks each stale target once across both blocks; the
    // focus that comes with it asks nothing more.
    tab.set("visible");
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    window.dispatchEvent(new dom.window.FocusEvent("focus"));
    await settle();
    assert.deepEqual(both(), [2, 2]);

    // Access granted, then a focus once the answers are stale: the lock goes.
    answers[PROJECT_PATH] = "open";
    tab.set("hidden");
    scheduler.flush();
    tab.set("visible");
    window.dispatchEvent(new dom.window.FocusEvent("focus"));
    await settle();
    assert.deepEqual(both(), [3, 3]);
    for (const wg of blocks)
      assert.equal(wg.contentDOM.querySelectorAll("[data-link-state]").length, 0);

    // With every editor gone, the tab's listeners are too.
    for (const wg of blocks) wg.dom.remove();
    await settle();
    scheduler.flush();
    window.dispatchEvent(new dom.window.FocusEvent("focus"));
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await settle();
    assert.deepEqual(both(), [3, 3]);
  } finally {
    tab.restore();
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a failed read leaves a labeled link as it is; a read-only block is marked too", async () => {
  const answers = { [OTHER_PATH]: "failed" };
  const { refs } = scriptedRefs(answers);
  try {
    const failing = linkedEditor(`See [the plan](${OTHER})`);
    failing.flush?.();
    await settle();
    assert.equal(refs.ref({ kind: "page", id: OTHER_ID }, "meta").name, "failed");
    assert.equal(failing.contentDOM.querySelector("a").dataset.linkState, undefined);
    failing.dom.remove();

    refs.clear();
    answers[OTHER_PATH] = "refused";
    const readOnly = linkedEditor(`See [the plan](${OTHER})`, { editable: false });
    readOnly.flush?.();
    await settle();
    assert.equal(readOnly.contentDOM.querySelector("a").dataset.linkState, "unavailable");
    readOnly.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("an edit that redraws a labeled link keeps its marker", async () => {
  const { refs } = scriptedRefs({});
  try {
    const wg = linkedEditor(`Before [the plan](${OTHER}) after`);
    wg.flush?.();
    await settle();
    const from = 1 + "Before ".length;
    // Splitting the link draws its two halves as new <a>s.
    wg.dispatch({ changes: { from: from + 3, insert: [Leaf.text("x")] } });
    wg.flush?.();
    await settle();
    const links = [...wg.contentDOM.querySelectorAll("a.page-link")];
    assert.equal(links.length, 2);
    for (const link of links) {
      assert.equal(link.dataset.linkState, "unavailable");
      assert.equal(describedBy(link), PAGE_DESCRIPTION);
    }
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a bare link's chit is not marked as a labeled link", async () => {
  const { refs } = scriptedRefs({});
  try {
    const wg = linkedEditor(`See <${OTHER}>`);
    wg.flush?.();
    await settle();
    assert.equal(wg.contentDOM.querySelector("a.wg-chit").dataset.state, "unavailable");
    assert.equal(wg.contentDOM.querySelectorAll("[data-link-state]").length, 0);
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});
