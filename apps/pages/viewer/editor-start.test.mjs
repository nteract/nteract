// The editor-start table through the pure machine, and EditorStart's
// interpretation of it in a document.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { readPageRoute } from "../shared/routes.mjs";
import { LISTING_ROUTES, editorStartMachine } from "./editor-start-machine.mjs";
import {
  EditorStart,
  IDLE_FALLBACK_MS,
  IDLE_TIMEOUT_MS,
  SETTLE_CAP_MS,
} from "./editor-start.mjs";

const TABLE = new URL("../test/fixtures/machines/editor-start.json", import.meta.url);
const pageId = "1a160b47-6df1-4983-81eb-489ca5a26812";
const projectId = "prj_2b160b47-6df1-4983-81eb-489ca5a26812";

test("the editor-start table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(editorStartMachine, loadTable(TABLE)), {
    rows: 24,
    pairs: 22,
    unreachable: 8,
    cases: 4,
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

/** A jsdom window whose idle callbacks, frames and timers run only when the
 * test says. `idle: false` leaves requestIdleCallback out, like Safari. */
function fixture({ idle = true, rows = "" } = {}) {
  const dom = new JSDOM(
    `<!doctype html><head><style>.page-card-image[data-theme="dark"] { display: none }</style></head>` +
      `<body><main id="root">${rows}</main></body>`,
  );
  const win = dom.window;
  const idles = new Map();
  const frames = new Map();
  const timers = new Map();
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
  win.setTimeout = (callback, ms) => {
    timers.set(next, { callback, ms });
    return next++;
  };
  win.clearTimeout = (id) => timers.delete(id);
  const starts = [];
  const start = new EditorStart({ start: (options) => starts.push(options), win });
  const run = (map) => {
    const callbacks = [...map.values()];
    map.clear();
    for (const entry of callbacks) (entry.callback ?? entry)();
  };
  const root = win.document.getElementById("root");
  return {
    win,
    start,
    starts,
    idles,
    frames,
    timers,
    runFrames: () => run(frames),
    runIdle: () => run(idles),
    runTimers: () => run(timers),
    /** Let the MutationObserver deliver. */
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    addRow(className = "index-row-link") {
      const link = win.document.createElement("a");
      link.className = className;
      link.href = `/p/${pageId}`;
      link.textContent = "Roadmap";
      root.append(link);
      return link;
    },
    /** A grid card with its placeholder; `draw` gives it its preview and
     * images, and `load` finishes the shown one. */
    addCard() {
      const card = win.document.createElement("li");
      card.className = "index-card";
      card.innerHTML =
        '<a class="index-card-link" href="/p/x"><div class="index-card-preview"></div></a>';
      root.append(card);
      const link = card.firstElementChild;
      return {
        card,
        draw({ image = true } = {}) {
          link.innerHTML =
            '<div class="index-card-preview page-card-preview">' +
            (image
              ? '<img class="page-card-image" data-theme="light" src="/l.webp">' +
                '<img class="page-card-image" data-theme="dark" src="/d.webp">'
              : "") +
            "</div>";
        },
        load(theme = "light") {
          const image = card.querySelector(`img[data-theme="${theme}"]`);
          Object.defineProperty(image, "complete", { value: true });
          image.dispatchEvent(new win.Event("load"));
        },
      };
    },
    close: () => dom.window.close(),
  };
}

test("list rows start the editor once they paint and the browser is idle, WASM at low priority", async () => {
  const f = fixture();
  f.start.boot("home");
  assert.equal(f.start.state.name, "holding");
  f.addRow();
  await f.flush();
  assert.equal(f.frames.size, 1, "the rows report a frame later");
  f.runFrames();
  assert.equal(f.start.state.name, "idling", "list rows have no card images to wait for");
  assert.deepEqual([...f.idles.values()][0].options, { timeout: IDLE_TIMEOUT_MS });
  assert.deepEqual(f.starts, [], "painted is not idle");
  f.addRow();
  await f.flush();
  assert.equal(f.frames.size, 0, "the row watcher reported once and disconnected");
  f.runIdle();
  assert.deepEqual(f.starts, [{ priority: "low" }]);
  assert.equal(f.start.state.name, "started");
  f.addRow().dispatchEvent(new f.win.Event("pointerover", { bubbles: true }));
  assert.equal(f.starts.length, 1, "the intent listeners are gone");
  f.close();
});

test("grid rows wait for the first screen's card images before the idle wait", async () => {
  const f = fixture();
  f.start.boot("home");
  const [a, b, c] = [f.addCard(), f.addCard(), f.addCard()];
  await f.flush();
  f.runFrames();
  assert.equal(f.start.state.name, "settling");
  assert.deepEqual(
    [...f.timers.values()].map(({ ms }) => ms),
    [SETTLE_CAP_MS],
  );
  a.draw();
  b.draw({ image: false });
  await f.flush();
  a.load();
  assert.equal(f.start.state.name, "settling", "a card still shows its placeholder");
  c.draw();
  await f.flush();
  assert.equal(f.start.state.name, "settling", "its shown image is still loading");
  c.load("light");
  assert.equal(f.start.state.name, "idling", "loaded, or no image: settled");
  assert.equal(f.timers.size, 0, "the cap is cleared");
  assert.equal(f.idles.size, 1);
  f.runIdle();
  assert.deepEqual(f.starts, [{ priority: "low" }]);
  f.close();
});

test("the cap ends the wait for a card image that never arrives", async () => {
  const f = fixture();
  f.start.boot("pages");
  f.addCard();
  await f.flush();
  f.runFrames();
  assert.equal(f.start.state.name, "settling");
  f.runTimers();
  assert.equal(f.start.state.name, "idling");
  f.runIdle();
  assert.deepEqual(f.starts, [{ priority: "low" }]);
  f.close();
});

test("hovering or focusing a row starts the editor at once, at normal priority", async () => {
  for (const type of ["pointerover", "focusin", "pointerdown"]) {
    const f = fixture();
    f.start.boot("pages");
    const { card } = f.addCard();
    await f.flush();
    f.runFrames();
    assert.equal(f.timers.size, 1);
    card.querySelector(".index-card-preview").dispatchEvent(new f.win.Event(type, { bubbles: true }));
    assert.deepEqual(f.starts, [{ priority: null }], type);
    assert.equal(f.timers.size, 0, `${type} clears the cap`);
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
    assert.deepEqual(f.starts, [{ priority: null }], markup);
    f.close();
  }
});

test("pointing at anything else waits for the rows", () => {
  const f = fixture();
  f.start.boot("home");
  f.win.document.getElementById("root").innerHTML =
    '<div class="library-actions"><button class="subtle-button">Trash</button></div>';
  f.win.document
    .querySelector("button")
    .dispatchEvent(new f.win.Event("pointerover", { bubbles: true }));
  f.win.document.body.dispatchEvent(new f.win.Event("focusin", { bubbles: true }));
  assert.deepEqual(f.starts, []);
  f.close();
});

test("an open that starts the loader removes every watcher", async () => {
  // An empty library: no rows ever paint, and New Page opens by keyboard.
  const f = fixture();
  f.start.boot("home");
  f.start.opened();
  assert.equal(f.start.state.name, "started");
  assert.deepEqual(f.starts, [], "the loader already started");
  f.addRow().dispatchEvent(new f.win.Event("focusin", { bubbles: true }));
  await f.flush();
  assert.equal(f.frames.size, 0, "the row observer is gone");
  assert.deepEqual(f.starts, [], "and the intent listeners");
  f.close();
  // An open while the card images settle.
  const g = fixture();
  g.start.boot("home");
  g.addCard();
  await g.flush();
  g.runFrames();
  g.start.opened();
  assert.equal(g.timers.size, 0, "the cap is cleared");
  assert.deepEqual(g.starts, []);
  g.close();
});

test("rows already in the document report at once", () => {
  const f = fixture({ rows: '<a class="index-row-link" href="/p/x">Roadmap</a>' });
  f.start.boot("home");
  assert.equal(f.frames.size, 1, "no mutation needed");
  f.runFrames();
  assert.equal(f.start.state.name, "idling");
  f.close();
});

test("without requestIdleCallback the editor starts a short timer after the rows paint", async () => {
  const f = fixture({ idle: false });
  f.start.boot("home");
  f.addRow();
  await f.flush();
  f.runFrames();
  assert.deepEqual(
    [...f.timers.values()].map(({ ms }) => ms),
    [IDLE_FALLBACK_MS],
  );
  f.runTimers();
  assert.deepEqual(f.starts, [{ priority: "low" }]);
  f.close();
});

test("a Page route starts the editor at boot, at normal priority, and watches nothing", async () => {
  const f = fixture();
  f.start.boot("page");
  assert.deepEqual(f.starts, [{ priority: null }]);
  f.addRow().dispatchEvent(new f.win.Event("pointerover", { bubbles: true }));
  await f.flush();
  assert.equal(f.frames.size, 0);
  f.start.boot("home");
  f.start.intent();
  f.start.opened();
  assert.equal(f.starts.length, 1, "the start runs once per tab");
  f.close();
});

test("held placeholders are neither drawn rows nor intent, and hold no image to wait on", async () => {
  const f = fixture({
    rows:
      '<li class="index-row-held" aria-hidden="true"><span class="index-row-link"></span></li>' +
      '<li class="index-card-held" aria-hidden="true"><span class="index-card-link"></span></li>',
  });
  f.start.boot("home");
  assert.equal(f.frames.size, 0, "held rows are not the first rows");
  f.win.document
    .querySelector(".index-row-held .index-row-link")
    .dispatchEvent(new f.win.Event("pointerover", { bubbles: true }));
  assert.deepEqual(f.starts, [], "a placeholder is never intent");
  // The server's first answer draws a real card beside the held one.
  const real = f.addCard();
  await f.flush();
  f.runFrames();
  assert.equal(f.start.state.name, "settling");
  real.draw();
  await f.flush();
  real.load();
  assert.equal(f.start.state.name, "idling", "only the drawn card's image counted");
  f.close();
});

test("an image already complete from the HTTP cache settles at once", async () => {
  const f = fixture();
  f.start.boot("home");
  const card = f.addCard();
  card.draw();
  // Complete before the rows report: the settle check sees it on its first look.
  Object.defineProperty(card.card.querySelector('img[data-theme="light"]'), "complete", {
    value: true,
  });
  await f.flush();
  f.runFrames();
  assert.equal(f.start.state.name, "idling");
  assert.equal(f.timers.size, 0, "no cap left running");
  f.close();
});
