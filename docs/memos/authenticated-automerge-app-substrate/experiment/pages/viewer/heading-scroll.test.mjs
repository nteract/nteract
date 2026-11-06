import assert from "node:assert/strict";
import { test } from "node:test";
import { SCROLL_STATE_KEY } from "../shared/routes.mjs";
import { HeadingScroll, routeIdOf } from "./heading-scroll.mjs";

const id = "1a160b47-6df1-4983-81eb-489ca5a26812";
const project = `prj_${id}`;

/** A window, history and location the controller can drive. */
function browser(href) {
  const window = new EventTarget();
  const location = {};
  const go = (path) => {
    const url = new URL(path, "https://pages.example");
    Object.assign(location, {
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    });
  };
  go(href);
  const history = { state: null };
  const scroll = new HeadingScroll({ window, history, location });
  /** Back or Forward to `path` with entry state `state`. */
  const traverse = (path, state) => {
    go(path);
    history.state = state;
    window.dispatchEvent(new Event("popstate"));
  };
  const key = (type, key = "x") => {
    const event = new Event(type);
    event.key = key;
    window.dispatchEvent(event);
  };
  return { window, history, location, scroll, traverse, key, go };
}

test("routeIdOf names a Page or Project address and nothing else", () => {
  assert.equal(routeIdOf(`https://pages.example/p/${id}#plan`), id);
  assert.equal(routeIdOf(`https://pages.example/project/${project}`), project);
  assert.equal(routeIdOf("https://pages.example/pages"), null);
});

test("page load asks for the address's heading, and an early wheel calls it off", () => {
  const { scroll, window } = browser(`/p/${id}#plan`);
  scroll.start();
  scroll.requestFromAddress();
  assert.deepEqual(scroll.store.snapshot(), {
    name: "pending",
    routeId: id,
    target: { kind: "anchor", anchor: "plan" },
  });
  // No Page session yet: the reader scrolls the loading preview.
  window.dispatchEvent(new Event("wheel"));
  assert.equal(scroll.store.snapshot().name, "cancelled");
  // The Page opening and drawing later doesn't revive it.
  scroll.navigated(id);
  assert.deepEqual(scroll.dispatch({ type: "located", pageId: id, projectId: null }), []);
  assert.equal(scroll.store.snapshot().name, "cancelled");
  scroll.stop();
});

test("every kind of reader intent cancels; modifier keys alone and idle screens don't", () => {
  for (const fire of [
    (b) => b.window.dispatchEvent(new Event("wheel")),
    (b) => b.window.dispatchEvent(new Event("touchmove")),
    (b) => b.window.dispatchEvent(new Event("pointerdown")),
    (b) => b.key("keydown", "PageDown"),
    (b) => b.key("keydown", "a"),
  ]) {
    const b = browser(`/p/${id}#plan`);
    b.scroll.start();
    b.scroll.requestFromAddress();
    fire(b);
    assert.equal(b.scroll.store.snapshot().name, "cancelled");
    b.scroll.stop();
  }
  const b = browser(`/p/${id}#plan`);
  b.scroll.start();
  b.scroll.requestFromAddress();
  b.key("keydown", "Shift");
  assert.equal(b.scroll.store.snapshot().name, "pending");
  b.scroll.stop();
  // Nothing to cancel: intent leaves a resting state alone.
  const quiet = browser(`/p/${id}`);
  quiet.scroll.start();
  quiet.scroll.requestFromAddress();
  quiet.window.dispatchEvent(new Event("wheel"));
  assert.equal(quiet.scroll.store.snapshot().name, "idle");
  quiet.scroll.stop();
});

test("Back asks for the entry's recorded position, else its heading", () => {
  const { scroll, traverse } = browser(`/p/${id}`);
  scroll.start();
  traverse(`/p/${id}`, { pageId: id, [SCROLL_STATE_KEY]: { path: `/p/${id}`, y: 900 } });
  assert.deepEqual(scroll.store.snapshot(), {
    name: "pending",
    routeId: id,
    target: { kind: "position", y: 900 },
  });
  // A position recorded at another address doesn't count; the heading does.
  traverse(`/p/${id}#plan`, { [SCROLL_STATE_KEY]: { path: "/pages", y: 900 } });
  assert.deepEqual(scroll.store.snapshot().target, { kind: "anchor", anchor: "plan" });
  // Neither: nothing to scroll to.
  traverse(`/p/${id}`, null);
  assert.equal(scroll.store.snapshot().name, "idle");
  // A Project route's entry.
  traverse(`/project/${project}`, { [SCROLL_STATE_KEY]: { path: `/project/${project}`, y: 0 } });
  assert.deepEqual(scroll.store.snapshot(), {
    name: "pending",
    routeId: project,
    target: { kind: "position", y: 0 },
  });
  scroll.stop();
});

test("opening another route cancels a pending scroll; opening its own keeps it", () => {
  const { scroll } = browser(`/p/${id}#plan`);
  scroll.requestFromAddress();
  scroll.navigated(id);
  assert.equal(scroll.store.snapshot().name, "pending");
  scroll.navigated(null);
  assert.equal(scroll.store.snapshot().name, "cancelled");
});
