/**
 * Loading the Page editor (page-editor.mjs) as a state machine.
 *
 * app.js renders the shell without the editor. It imports the editor chunk,
 * and with it the WASM runtimes, once per tab: at boot for routes that show a
 * Page, and on first use for the index routes (/projects, /pages), which only
 * list. A tab never imports it twice: a chunk that failed to load usually
 * belongs to a build the server no longer serves, so only a reload can fix it.
 *
 * States:
 * - idle: nothing has asked for the editor yet.
 * - loading: the import is in flight.
 * - ready: the module is loaded; Pages can open.
 * - failed: the import rejected. `message` is the browser's reason, kept for
 *   diagnostics; the viewer shows its own text.
 *
 * Events: `start` (boot, or the first Page open or creation), `loaded` (the
 * import resolved) and `failed` (it rejected). A second `start` is a no-op.
 *
 * Effects: `import` runs the dynamic import. `checkBuild` asks the server for
 * its build, so a deploy that retired this tab's chunks shows the reload
 * banner as a server change.
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
  states: ["idle", "loading", "ready", "failed"],
  events: ["start", "loaded", "failed"],
  unreachable: [
    ["idle", "loaded", "The import runs only after start"],
    ["idle", "failed", "The import runs only after start"],
  ],
  validate: {
    states: { idle: named, loading: named, ready: named, failed: message },
    events: { start: typed([]), loaded: typed([]), failed: message },
    effects: { import: typed([]), checkBuild: typed([]) },
  },
});

export const REJECT = Object.freeze({
  running: "The editor import is already running",
  settled: "The editor import already settled",
});

function transition(state, event) {
  if (state.name === "idle") return { state: { name: "loading" }, effects: [{ type: "import" }] };
  if (event.type === "start")
    return reject(state, state.name === "loading" ? REJECT.running : REJECT.settled);
  if (state.name !== "loading") return reject(state, REJECT.settled);
  if (event.type === "loaded") return { state: { name: "ready" }, effects: [] };
  return {
    state: { name: "failed", message: event.message },
    effects: [{ type: "checkBuild" }],
  };
}

export const editorLoadMachine = defineMachine({
  ...editorLoadSpec,
  initial: { name: "idle" },
  transition,
});
