/**
 * Loading the Page editor (page-editor.mjs) as a state machine.
 *
 * app.js renders the shell without the editor. It imports the editor chunk,
 * and with it the WASM runtimes, once at boot. A tab never imports it twice:
 * a chunk that failed to load usually belongs to a build the server no longer
 * serves, so only a reload can fix it.
 *
 * States:
 * - loading: the import is in flight.
 * - ready: the module is loaded; Pages can open.
 * - failed: the import rejected. `message` is the browser's reason, kept for
 *   diagnostics; the viewer shows its own text.
 *
 * Events: `loaded` (the import resolved) and `failed` (it rejected).
 *
 * Effects: `checkBuild` asks the server for its build, so a deploy that
 * retired this tab's chunks shows the reload banner as a server change.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const message = (value) => {
  only(value, value.type ? ["type", "message"] : ["name", "message"]);
  check(typeof value.message === "string", "message must be a string");
};
const typed = (keys) => (value) => only(value, ["type", ...keys]);
const named = (value) => only(value, ["name"]);

export const editorLoadSpec = Object.freeze({
  name: "editor-load",
  states: ["loading", "ready", "failed"],
  events: ["loaded", "failed"],
  validate: {
    states: { loading: named, ready: named, failed: message },
    events: { loaded: typed([]), failed: message },
    effects: { checkBuild: typed([]) },
  },
});

export const REJECT = Object.freeze({
  settled: "The editor import already settled",
});

function transition(state, event) {
  if (state.name !== "loading") return reject(state, REJECT.settled);
  if (event.type === "loaded") return { state: { name: "ready" }, effects: [] };
  return {
    state: { name: "failed", message: event.message },
    effects: [{ type: "checkBuild" }],
  };
}

export const editorLoadMachine = defineMachine({
  ...editorLoadSpec,
  initial: { name: "loading" },
  transition,
});
