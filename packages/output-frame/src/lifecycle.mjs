// A mount is immutable. Changes in code or inputs dispose it and require a
// new mount; no late completion can revive a disposed mount.
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
