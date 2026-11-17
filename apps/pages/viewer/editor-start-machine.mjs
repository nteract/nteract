/**
 * When the viewer starts the Page editor (editor-loader.mjs), as a state
 * machine over the route the tab booted on and what happens after.
 *
 * A route that opens a document (a Page, Project content, anything that isn't
 * a listing) starts the editor at boot, beside the shell, so the Page opens as
 * soon as its document syncs. A listing route (`/`, `/pages`, `/projects`)
 * holds it: the editor graph and the Automerge WASM would compete with the
 * library's first rows and their card images. It starts once the listing has
 * painted its first rows and the browser is idle, or earlier on intent: a
 * pointer or keyboard focus entering a row link, New Page or the Page
 * switcher. A Page opened before either still works, because opening a Page
 * asks the loader for the editor itself; this machine only decides when to ask
 * ahead of that.
 *
 * States:
 * - booting: the route isn't read yet.
 * - holding: a listing route whose rows haven't painted.
 * - painted: the first rows painted; the idle callback is pending.
 * - started: the editor import was asked for. Final.
 *
 * Events: `boot` (with the route kind, once), `painted` (the first rows drew),
 * `idle` (the idle callback ran), `intent` (pointer or focus on something that
 * opens a Page).
 *
 * Effects: `watch` (observe the first rows and listen for intent), `idle`
 * (request an idle callback), `start` (ask the loader for the editor) and
 * `stop` (remove the watchers and cancel a pending idle callback).
 */
import { defineMachine, reject } from "../shared/machine.mjs";

/** Route kinds (shared/routes.mjs) that list rather than open a document. */
export const LISTING_ROUTES = Object.freeze(["home", "pages", "projects"]);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (keys) => (value) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};

export const editorStartSpec = Object.freeze({
  name: "editor-start",
  states: ["booting", "holding", "painted", "started"],
  events: ["boot", "painted", "idle", "intent"],
  unreachable: [
    ["booting", "painted", "The row watcher attaches at boot"],
    ["booting", "idle", "The idle callback is requested only after the rows paint"],
    ["booting", "intent", "The intent listeners attach at boot"],
    ["holding", "idle", "The idle callback is requested only after the rows paint"],
  ],
  cases: { "booting/boot": ["listing", "document"] },
  validate: {
    states: {
      booting: only(["name"]),
      holding: only(["name"]),
      painted: only(["name"]),
      started: only(["name"]),
    },
    events: {
      boot: (value) => {
        only(["type", "route"])(value);
        check(typeof value.route === "string", "route must be a route kind");
      },
      painted: only(["type"]),
      idle: only(["type"]),
      intent: only(["type"]),
    },
    effects: {
      watch: only(["type"]),
      idle: only(["type"]),
      start: only(["type"]),
      stop: only(["type"]),
    },
  },
});

export const REJECT = Object.freeze({
  booted: "The route was already read",
  painted: "The first rows already painted",
  started: "The editor was already asked for",
});

const START = Object.freeze({ type: "start" });
const STOP = Object.freeze({ type: "stop" });

function transition(state, event) {
  if (event.type === "boot") {
    if (state.name !== "booting") return reject(state, REJECT.booted);
    return LISTING_ROUTES.includes(event.route)
      ? { state: { name: "holding" }, effects: [{ type: "watch" }] }
      : { state: { name: "started" }, effects: [START] };
  }
  if (state.name === "started") return reject(state, REJECT.started);
  if (event.type === "intent") return { state: { name: "started" }, effects: [START, STOP] };
  if (event.type === "painted") {
    if (state.name === "painted") return reject(state, REJECT.painted);
    return { state: { name: "painted" }, effects: [{ type: "idle" }] };
  }
  // idle, from painted
  return { state: { name: "started" }, effects: [START, STOP] };
}

export const editorStartMachine = defineMachine({
  ...editorStartSpec,
  initial: { name: "booting" },
  transition,
});
