/**
 * When the viewer starts the Page editor (editor-loader.mjs), as a state
 * machine over the route the tab booted on and what happens after.
 *
 * A route that opens a document (a Page, Project content, anything that isn't
 * a listing) starts the editor at boot, beside the shell, so the Page opens as
 * soon as its document syncs. A listing route (`/`, `/pages`, `/projects`)
 * holds it: the editor graph and the Automerge WASM would compete with the
 * listing's first rows and their card images for the network. It starts once
 * the first rows have painted, the first screen's card images have settled
 * (or a cap ran out) and the browser is idle, with the WASM at low fetch
 * priority. Intent starts it at once: a pointer or keyboard focus entering a
 * row link, New Page or the Page switcher. Opening a Page asks the loader for
 * the editor itself; `opened` tells this machine, so its watchers go.
 *
 * States:
 * - booting: the route isn't read yet.
 * - holding: a listing route whose rows haven't painted.
 * - settling: the first rows painted with card images on the first screen;
 *   waiting for those images to load or fail, up to a cap.
 * - idling: waiting for an idle callback.
 * - started: the editor was asked for. Final.
 *
 * Events: `boot` (with the route kind, once), `painted` (the first rows drew,
 * with how many first-screen cards they hold: 0 in list mode), `settled`
 * (those cards' images loaded or failed, or the cap ran out), `idle` (the
 * idle callback ran), `intent` (pointer or focus on something that opens a
 * Page) and `opened` (something else asked the loader for the editor).
 *
 * Effects: `watch` (observe the first rows and listen for intent), `settle`
 * (watch the first-screen card images, with the cap), `idle` (request an idle
 * callback), `start` (ask the loader for the editor; `priority: "low"` marks
 * the WASM preload low) and `stop` (remove every watcher and pending
 * callback).
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
const named = only(["name"]);

export const editorStartSpec = Object.freeze({
  name: "editor-start",
  states: ["booting", "holding", "settling", "idling", "started"],
  events: ["boot", "painted", "settled", "idle", "intent", "opened"],
  unreachable: [
    ["booting", "painted", "The row watcher attaches at boot"],
    ["booting", "settled", "The image watcher attaches after the rows paint"],
    ["booting", "idle", "The idle callback is requested only after the rows paint"],
    ["booting", "intent", "The intent listeners attach at boot"],
    ["booting", "opened", "Nothing opens a Page before the route is read"],
    ["holding", "settled", "The image watcher attaches after the rows paint"],
    ["holding", "idle", "The idle callback is requested only after the rows paint"],
    ["settling", "idle", "The idle callback is requested only once the images settle"],
  ],
  cases: {
    "booting/boot": ["listing", "document"],
    "holding/painted": ["cards", "no-cards"],
  },
  validate: {
    states: {
      booting: named,
      holding: named,
      settling: named,
      idling: named,
      started: named,
    },
    events: {
      boot: (value) => {
        only(["type", "route"])(value);
        check(typeof value.route === "string", "route must be a route kind");
      },
      painted: (value) => {
        only(["type", "cards"])(value);
        check(Number.isInteger(value.cards) && value.cards >= 0, "cards must be a count");
      },
      settled: only(["type"]),
      idle: only(["type"]),
      intent: only(["type"]),
      opened: only(["type"]),
    },
    effects: {
      watch: only(["type"]),
      settle: only(["type"]),
      idle: only(["type"]),
      start: (value) => {
        only(["type", "priority"])(value);
        check(!("priority" in value) || value.priority === "low", "priority is low or absent");
      },
      stop: only(["type"]),
    },
  },
});

export const REJECT = Object.freeze({
  booted: "The route was already read",
  painted: "The first rows already painted",
  settled: "The first-screen images already settled",
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
  if (event.type === "opened") return { state: { name: "started" }, effects: [STOP] };
  if (event.type === "painted") {
    if (state.name !== "holding") return reject(state, REJECT.painted);
    return event.cards > 0
      ? { state: { name: "settling" }, effects: [{ type: "settle" }] }
      : { state: { name: "idling" }, effects: [{ type: "idle" }] };
  }
  if (event.type === "settled") {
    if (state.name !== "settling") return reject(state, REJECT.settled);
    return { state: { name: "idling" }, effects: [{ type: "idle" }] };
  }
  // idle, from idling
  return { state: { name: "started" }, effects: [{ type: "start", priority: "low" }, STOP] };
}

export const editorStartMachine = defineMachine({
  ...editorStartSpec,
  initial: { name: "booting" },
  transition,
});
