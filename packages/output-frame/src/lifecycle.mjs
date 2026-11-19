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

// The frame's answers to data messages. `awaiting` is a frozen list of names
// whose latest sent data message the frame may still answer as unhandled.
// The frame answers only that way; an applied change is never acknowledged.
// Events:
// - {type: "sent", names}: data messages for these names went to the frame.
//   A name already awaiting stays once: the newer message replaces the older.
// - {type: "unhandled", name}: accepted only for an awaiting name, which
//   then stops awaiting, so one sent message is answered at most once.
// - {type: "end"}: the mount failed or was disposed; nothing awaits.
// Returns the next `awaiting` and whether this event is an accepted answer.
export function answerTransition(awaiting, event) {
  switch (event.type) {
    case "sent": {
      const added = event.names.filter((name) => !awaiting.includes(name));
      return {
        awaiting: added.length ? Object.freeze([...awaiting, ...added]) : awaiting,
        accept: false,
      };
    }
    case "unhandled":
      return awaiting.includes(event.name)
        ? { awaiting: Object.freeze(awaiting.filter((name) => name !== event.name)), accept: true }
        : { awaiting, accept: false };
    case "end":
      return { awaiting: NO_DATA, accept: false };
    default:
      return { awaiting, accept: false };
  }
}

// The frame protocol's version, named in the handshake's message type. A
// shell answers a handshake for another version with an error that names
// both, so a page and a shell from different releases fail with a reason.
export const PROTOCOL_VERSION = 3;
export const connectMessageType = (version = PROTOCOL_VERSION) =>
  `nteract-output-connect-v${version}`;
// The version a handshake's message type names, or null for any other type.
export function connectVersion(type) {
  const match = /^nteract-output-connect-v([1-9][0-9]{0,3})$/.exec(
    typeof type === "string" ? type : "",
  );
  return match ? Number(match[1]) : null;
}
