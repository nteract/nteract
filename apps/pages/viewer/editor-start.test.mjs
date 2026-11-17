// The editor-start table through the pure machine, and EditorStart's
// interpretation of it in a document.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { readPageRoute } from "../shared/routes.mjs";
import { LISTING_ROUTES, editorStartMachine } from "./editor-start-machine.mjs";
import { EditorStart, IDLE_FALLBACK_MS, IDLE_TIMEOUT_MS } from "./editor-start.mjs";

const TABLE = new URL("../test/fixtures/machines/editor-start.json", import.meta.url);
const pageId = "1a160b47-6df1-4983-81eb-489ca5a26812";
const projectId = "prj_2b160b47-6df1-4983-81eb-489ca5a26812";

test("the editor-start table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(editorStartMachine, loadTable(TABLE)), {
    rows: 13,
    pairs: 12,
    unreachable: 4,
    cases: 2,
  });
});

test("listings hold the editor at boot; every other route starts it", () => {
  const boot = (path) =>
    editorStartMachine.step(editorStartMachine.initial, {
      type: "boot",
      route: readPageRoute(path).kind,
    });
  for (const path of ["/", "/?show=shared", "/pages", "/projects"])
    assert.deepEqual(boot(path).effects, [{ type: "watch" }], `${path} holds`);
  for (const path of [
    `/p/${pageId}`,
    `/p/${pageId}/roadmap`,
    `/?page=${pageId}`,
    `/project/${projectId}`,
    "/no-such-route",
  ])
    assert.deepEqual(boot(path).effects, [{ type: "start" }], `${path} starts`);
  assert.deepEqual([...LISTING_ROUTES].sort(), ["home", "pages", "projects"]);
});

/** A jsdom window whose idle callbacks and frames run only when the test
 * says. `idle: false` leaves requestIdleCallback out, like Safari. */
function fixture({ idle = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><main id="root"></main></body>');
  const win = dom.window;
  const idles = new Map();
  const frames = new Map();
  let next = 1;
  if (idle) {
    win.requestIdleCallback = (callback, options) => {
      idles.set(next, { callback, options });
      return next++;
    };
    win.cancelIdleCallback = (id) => idles.delete(id);
  } else delete win.requestIdleCallback;
  win.requestAnimationFrame = (callback) => {
    frames.set(next, callback);
    return next++;
  };
  win.cancelAnimationFrame = (id) => frames.delete(id);
  let starts = 0;
  const start = new EditorStart({ start: () => starts++, win });
  const run = (map) => {
    const callbacks = [...map.values()];
    map.clear();
    for (const entry of callbacks) (entry.callback ?? entry)();
  };
  return {
    win,
    start,
    starts: () => starts,
    idles,
    frames,
    runFrames: () => run(frames),
    runIdle: () => run(idles),
    /** Let the MutationObserver deliver. */
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    addRow(className = "index-row-link") {
      const link = win.document.createElement("a");
      link.className = className;
      link.href = `/p/${pageId}`;
      link.textContent = "Roadmap";
      win.document.getElementById("root").append(link);
      return link;
    },
    close: () => dom.window.close(),
  };
}

test("a listing starts the editor once its first rows painted and the browser is idle", async () => {
  const f = fixture();
  f.start.boot("home");
  assert.equal(f.start.state.name, "holding");
  assert.equal(f.starts(), 0, "nothing loads before the rows");
  f.addRow("index-card-link");
  await f.flush();
  assert.equal(f.frames.size, 1, "the rows report a frame later");
  assert.equal(f.idles.size, 0);
  f.runFrames();
  assert.equal(f.start.state.name, "painted");
  assert.equal(f.idles.size, 1);
  assert.deepEqual([...f.idles.values()][0].options, { timeout: IDLE_TIMEOUT_MS });
  assert.equal(f.starts(), 0, "painted is not idle");
  f.addRow();
  await f.flush();
  assert.equal(f.frames.size, 0, "the row watcher reported once and disconnected");
  f.runIdle();
  assert.equal(f.starts(), 1);
  assert.equal(f.start.state.name, "started");
  f.addRow().dispatchEvent(new f.win.Event("pointerover", { bubbles: true }));
  assert.equal(f.starts(), 1, "the intent listeners are gone");
  f.close();
});

test("hovering or focusing a row starts the editor at once and cancels the idle wait", async () => {
  for (const type of ["pointerover", "focusin", "pointerdown"]) {
    const f = fixture();
    f.start.boot("pages");
    const row = f.addRow();
    await f.flush();
    f.runFrames();
    assert.equal(f.idles.size, 1);
    const title = f.win.document.createElement("span");
    row.append(title);
    title.dispatchEvent(new f.win.Event(type, { bubbles: true }));
    assert.equal(f.starts(), 1, type);
    assert.equal(f.idles.size, 0, `${type} cancels the idle callback`);
    f.close();
  }
});

test("intent on New Page or the Page switcher starts the editor before any row paints", () => {
  for (const markup of [
    '<div class="library-actions"><button class="primary">New Page</button></div>',
    '<button class="subtle-button pages-trigger">Browse</button>',
  ]) {
    const f = fixture();
    f.start.boot("home");
    f.win.document.getElementById("root").innerHTML = markup;
    f.win.document
      .querySelector("button")
      .dispatchEvent(new f.win.Event("pointerover", { bubbles: true }));
    assert.equal(f.starts(), 1, markup);
    assert.equal(f.start.state.name, "started");
    f.close();
  }
});

test("pointing at anything else waits for the rows", async () => {
  const f = fixture();
  f.start.boot("home");
  f.win.document.getElementById("root").innerHTML =
    '<div class="library-actions"><button class="subtle-button">Trash</button></div>';
  f.win.document
    .querySelector("button")
    .dispatchEvent(new f.win.Event("pointerover", { bubbles: true }));
  f.win.document.body.dispatchEvent(new f.win.Event("focusin", { bubbles: true }));
  assert.equal(f.starts(), 0);
  f.close();
});

test("without requestIdleCallback the editor starts a short timer after the rows paint", async () => {
  const f = fixture({ idle: false });
  f.start.boot("home");
  f.addRow();
  await f.flush();
  f.runFrames();
  assert.equal(f.starts(), 0);
  await new Promise((resolve) => setTimeout(resolve, IDLE_FALLBACK_MS + 50));
  assert.equal(f.starts(), 1);
  f.close();
});

test("a Page route starts the editor at boot and watches nothing", async () => {
  const f = fixture();
  f.start.boot("page");
  assert.equal(f.starts(), 1);
  f.addRow().dispatchEvent(new f.win.Event("pointerover", { bubbles: true }));
  await f.flush();
  assert.equal(f.frames.size, 0);
  assert.equal(f.starts(), 1);
  f.start.boot("home");
  f.start.intent();
  assert.equal(f.starts(), 1, "the start runs once per tab");
  f.close();
});
