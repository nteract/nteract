// A mount runs one immutable set of code. A code change disposes it and needs
// a new mount; no late completion can revive a disposed mount. Data inputs
// can change within a mount (see dataTransition).
export const OUTPUT_STATES = [
  "connecting",
  "handshaking",
  "loading",
  "importing",
  "initializing",
  "rendering",
  "ready",
  "failed",
  "disposed",
];
export function outputTransition(state, event) {
  if (state === "disposed") return state;
  if (event === "dispose") return "disposed";
  if (event === "fail") return "failed";
  return (
    {
      connecting: { connect: "handshaking" },
      handshaking: { connected: "loading" },
      loading: { mount: "importing" },
      importing: { loaded: "initializing" },
      initializing: { initialized: "rendering" },
      rendering: { rendered: "ready" },
    }[state]?.[event] ?? state
  );
}

const NO_DATA = Object.freeze([]);

// Data changes for one mount, given its output state. `pending` is a frozen
// list of [name, value] in arrival order, at most one entry per name. An
// optional `change` ([name, value]) replaces that name's pending entry and
// moves it to the end. Returns the next `pending` and the entries to `send`
// now, in order:
// - before "ready" the entries wait: the frame has not rendered yet;
// - at "ready" every entry is sent and nothing waits;
// - "failed" and "disposed" drop every entry, including `change`.
// Call it with a change, and with none after each output state change.
export function dataTransition(state, pending, change) {
  if (state === "failed" || state === "disposed") return { pending: NO_DATA, send: NO_DATA };
  const next = change ? [...pending.filter(([name]) => name !== change[0]), change] : pending;
  if (state === "ready") return { pending: NO_DATA, send: Object.freeze([...next]) };
  return { pending: next === pending ? pending : Object.freeze(next), send: NO_DATA };
}
