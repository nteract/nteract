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
  labeledLinkNeedsAsking,
  markedEditorCount,
} = await import("./page-chits.mjs");
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

test("a labeled link the reader can't open is marked unavailable without a hover", async () => {
  const { VirtualTimeScheduler } = await import("rxjs");
  const scheduler = new VirtualTimeScheduler();
  const asks = [];
  let shared = false;
  const refs = new PageRefs({
    scheduler,
    get: (path) => {
      asks.push(path);
      if (path !== OTHER_PATH) return Promise.reject(refused("project_unavailable"));
      if (!shared) return Promise.reject(refused("page_unavailable"));
      return Promise.resolve({ v: 1, page_id: OTHER_ID, title: "Shared now", state: "active" });
    },
  });
  refs.account("dev");
  provideChitRefs(refs);
  try {
    const wg = linkedEditor(
      `See [the plan](${OTHER}), [the plan again](${OTHER}), [the project](${PROJECT}), ` +
        `[elsewhere](https://elsewhere.example/p/${OTHER_ID}) and [a heading](${BASE}#plan)`,
    );
    wg.flush?.();
    const [plan, again, project, elsewhere, heading] = wg.contentDOM.querySelectorAll("a");
    assert.equal(plan.dataset.linkState, undefined, "loading draws the link as it is");
    await tick();
    assert.deepEqual(
      asks.sort(),
      [`/project/${encodeURIComponent(PROJECT_ID)}/meta.json`, OTHER_PATH].sort(),
      "one ask per distinct target, none for another host or a heading",
    );
    for (const link of [plan, again]) {
      assert.equal(link.dataset.linkState, "unavailable");
      assert.equal(link.getAttribute("aria-description"), "Page unavailable");
    }
    assert.equal(project.dataset.linkState, "unavailable");
    assert.equal(project.getAttribute("aria-description"), "Project unavailable");
    assert.equal(plan.textContent, "the plan", "the label stays and nothing joins it");
    assert.equal(plan.getAttribute("href"), OTHER, "the link stays a link");
    for (const link of [elsewhere, heading]) {
      assert.equal(link.dataset.linkState, undefined);
      assert.equal(link.hasAttribute("aria-description"), false);
    }
    // The marker is drawn, never stored: the document keeps the label.
    assert.match(wg.state.doc.textContent(), /^See the plan, the plan again, the project/);
    assert.equal(wg.contentDOM.textContent, wg.state.doc.textContent());

    // Access granted: the stale unavailable answer isn't asked again while
    // the tab sits open, only when the reader comes back to it. Then the
    // marker goes away without a redraw of the block.
    shared = true;
    scheduler.flush();
    await tick();
    assert.equal(asks.filter((path) => path === OTHER_PATH).length, 1, "no polling");
    window.dispatchEvent(new dom.window.FocusEvent("focus"));
    await tick();
    assert.equal(asks.filter((path) => path === OTHER_PATH).length, 2);
    assert.equal(wg.contentDOM.querySelector("a"), plan, "the link wasn't redrawn");
    for (const link of [plan, again]) {
      assert.equal(link.dataset.linkState, undefined);
      assert.equal(link.hasAttribute("aria-description"), false);
    }
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a failed read leaves a labeled link as it is; a read-only block is marked too", async () => {
  let fail = true;
  const refs = new PageRefs({
    get: () =>
      fail
        ? Promise.reject(Object.assign(Error("down"), { status: 500 }))
        : Promise.reject(refused("page_unavailable")),
  });
  refs.account("dev");
  provideChitRefs(refs);
  try {
    const failing = linkedEditor(`[the plan](${OTHER})`);
    failing.flush?.();
    await tick();
    const link = failing.contentDOM.querySelector("a");
    assert.equal(refs.ref({ kind: "page", id: OTHER_ID }, "meta").name, "failed");
    assert.equal(link.dataset.linkState, undefined);
    failing.dom.remove();

    refs.clear();
    fail = false;
    const readOnly = linkedEditor(`[the plan](${OTHER})`, { editable: false });
    readOnly.flush?.();
    await tick();
    assert.equal(readOnly.contentDOM.querySelector("a").dataset.linkState, "unavailable");
    readOnly.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("an edit that redraws a labeled link keeps its marker", async () => {
  const refs = new PageRefs({ get: () => Promise.reject(refused("page_unavailable")) });
  refs.account("dev");
  provideChitRefs(refs);
  try {
    const wg = linkedEditor(`Before [the plan](${OTHER}) after`);
    wg.flush?.();
    await tick();
    const from = 1 + "Before ".length;
    // Splitting the link draws its two halves as new <a>s.
    wg.dispatch({ changes: { from: from + 3, insert: [Leaf.text("x")] } });
    wg.flush?.();
    const links = [...wg.contentDOM.querySelectorAll("a.page-link")];
    assert.equal(links.length, 2);
    for (const link of links) {
      assert.equal(link.dataset.linkState, "unavailable");
      assert.equal(link.getAttribute("aria-description"), "Page unavailable");
    }
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("a bare link's chit is not marked as a labeled link", async () => {
  const refs = new PageRefs({ get: () => Promise.reject(refused("page_unavailable")) });
  refs.account("dev");
  provideChitRefs(refs);
  try {
    const wg = linkedEditor(`See <${OTHER}>`);
    wg.flush?.();
    await tick();
    assert.equal(wg.contentDOM.querySelector("a.wg-chit").dataset.state, "unavailable");
    assert.equal(wg.contentDOM.querySelectorAll("[data-link-state]").length, 0);
    wg.dom.remove();
  } finally {
    provideChitRefs(null);
    refs.dispose();
  }
});

test("labeledLinkNeedsAsking: a missing answer, or a refresh of a stale one", () => {
  const cases = [
    // [ref, without refresh, with refresh]
    [undefined, true, true],
    [{ name: "idle" }, true, true],
    [{ name: "requested", attempts: 0, last: null }, false, false],
    [{ name: "requested", attempts: 0, last: { name: "unavailable" } }, false, false],
    [{ name: "readable", value: {}, stale: false }, false, false],
    [{ name: "readable", value: {}, stale: true }, false, true],
    [{ name: "unavailable", stale: false }, false, false],
    [{ name: "unavailable", stale: true }, false, true],
    [{ name: "failed", attempts: 1, last: null, ready: false }, false, false],
    [{ name: "failed", attempts: 1, last: null, ready: true }, true, true],
    [{ name: "failed", attempts: 1, last: { name: "unavailable" }, ready: false }, false, false],
    [{ name: "failed", attempts: 1, last: { name: "unavailable" }, ready: true }, false, true],
  ];
  for (const [ref, plain, refresh] of cases) {
    assert.equal(labeledLinkNeedsAsking(ref), plain, `${ref?.name ?? "missing"} without refresh`);
    assert.equal(
      labeledLinkNeedsAsking(ref, { refresh: true }),
      refresh,
      `${ref?.name ?? "missing"} with refresh`,
    );
  }
});

test("labeled links don't poll stale answers; a return to the tab asks once per target", async () => {
  const { VirtualTimeScheduler } = await import("rxjs");
  const scheduler = new VirtualTimeScheduler();
  const asks = [];
  const refs = new PageRefs({
    scheduler,
    get: (path) => {
      asks.push(path);
      if (path === OTHER_PATH)
        return Promise.resolve({ v: 1, page_id: OTHER_ID, title: "Open", state: "active" });
      return Promise.reject(refused("project_unavailable"));
    },
  });
  refs.account("dev");
  provideChitRefs(refs);
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const count = (path) => asks.filter((asked) => asked === path).length;
  const PROJECT_PATH = `/project/${encodeURIComponent(PROJECT_ID)}/meta.json`;
  try {
    // Two blocks link to the same two targets.
    const blocks = [
      linkedEditor(`See [the plan](${OTHER}) and [the project](${PROJECT})`),
      linkedEditor(`Again: [the plan](${OTHER}) and [the project](${PROJECT})`),
    ];
    for (const wg of blocks) wg.flush?.();
    await tick();
    assert.equal(markedEditorCount(), 2);
    assert.deepEqual([count(OTHER_PATH), count(PROJECT_PATH)], [1, 1]);

    // Both answers go stale. A ref change and a redraw ask nothing.
    scheduler.flush();
    refs.want({ kind: "page", id: "44444444-4444-4444-8444-444444444444" });
    await tick();
    blocks[0].dispatch({ changes: { from: 1, insert: [Leaf.text("x")] } });
    blocks[0].flush?.();
    await tick();
    assert.deepEqual([count(OTHER_PATH), count(PROJECT_PATH)], [1, 1], "stale isn't polled");

    // A tab turning hidden asks nothing.
    visibility = "hidden";
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await tick();
    assert.deepEqual([count(OTHER_PATH), count(PROJECT_PATH)], [1, 1]);

    // Turning visible asks each stale target once, across both blocks; the
    // focus that comes with it asks nothing more.
    visibility = "visible";
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    window.dispatchEvent(new dom.window.FocusEvent("focus"));
    await tick();
    assert.deepEqual([count(OTHER_PATH), count(PROJECT_PATH)], [2, 2]);

    // Focus alone refreshes too, once the answers are stale again.
    scheduler.flush();
    window.dispatchEvent(new dom.window.FocusEvent("focus"));
    await tick();
    assert.deepEqual([count(OTHER_PATH), count(PROJECT_PATH)], [3, 3]);

    // With every editor gone, the tab's listeners are too.
    for (const wg of blocks) wg.dom.remove();
    await tick();
    assert.equal(markedEditorCount(), 0);
    scheduler.flush();
    window.dispatchEvent(new dom.window.FocusEvent("focus"));
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await tick();
    assert.deepEqual([count(OTHER_PATH), count(PROJECT_PATH)], [3, 3]);
  } finally {
    delete document.visibilityState;
    provideChitRefs(null);
    refs.dispose();
  }
});
