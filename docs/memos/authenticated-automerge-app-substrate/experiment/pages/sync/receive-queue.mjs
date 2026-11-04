// Per-connection bound on the sync frames the Page host has taken from a
// socket but not finished. A frame counts from arrival until its admission
// run settles (stored and acked, or refused), so the bound covers frames
// waiting in a document's queue and the one being admitted. The limits match
// the native byte transport's receive queue (shared/byte-transport.mjs).
//
//   open        counting frames; an arrival over either limit overflows
//   overflowed  the host refused the arrival that overflowed and closed the
//               socket; later arrivals are dropped, settles still count down
//   closing     the socket closed with frames still running; settles count
//               down, arrivals are dropped
//   closed      the socket closed and every frame settled
//
// `receiveStep` is the only transition. The host runs the effect it returns:
// "admit" queues the frame, "refuse" refuses it and closes, "drop" ignores it,
// "release" reports that the closed connection has nothing left running, so
// anything it reported (a refusal, a round) has been reported.

export const RECEIVE_LIMITS = Object.freeze({
  maxFrames: 256,
  maxBytes: 32 * 1024 * 1024,
});

export const RECEIVE_OPEN = Object.freeze({ phase: "open", frames: 0, bytes: 0 });
const CLOSED = Object.freeze({ phase: "closed", frames: 0, bytes: 0 });

const settled = (state, bytes) => ({
  phase: state.phase,
  frames: Math.max(0, state.frames - 1),
  bytes: Math.max(0, state.bytes - bytes),
});
const closing = (state) =>
  state.frames === 0
    ? { state: CLOSED, effect: "release" }
    : { state: { ...state, phase: "closing" }, effect: null };

/**
 * One transition. Events: `{ type: "arrive", bytes }`, `{ type: "settle",
 * bytes }` (the bytes its arrival counted) and `{ type: "close" }`.
 * Returns `{ state, effect }`; effect is "admit", "refuse", "drop",
 * "release" or null.
 */
export function receiveStep(state, event, limits = RECEIVE_LIMITS) {
  switch (state.phase) {
    case "open":
      if (event.type === "arrive") {
        if (state.frames >= limits.maxFrames || state.bytes + event.bytes > limits.maxBytes)
          return { state: { ...state, phase: "overflowed" }, effect: "refuse" };
        return {
          state: {
            phase: "open",
            frames: state.frames + 1,
            bytes: state.bytes + event.bytes,
          },
          effect: "admit",
        };
      }
      if (event.type === "settle") return { state: settled(state, event.bytes), effect: null };
      if (event.type === "close") return closing(state);
      break;
    case "overflowed":
      if (event.type === "arrive") return { state, effect: "drop" };
      if (event.type === "settle") return { state: settled(state, event.bytes), effect: null };
      if (event.type === "close") return closing(state);
      break;
    case "closing":
      if (event.type === "arrive") return { state, effect: "drop" };
      if (event.type === "settle") return closing(settled(state, event.bytes));
      if (event.type === "close") return { state, effect: null };
      break;
    case "closed":
      if (event.type === "arrive") return { state, effect: "drop" };
      if (event.type === "settle" || event.type === "close") return { state, effect: null };
      break;
  }
  throw new TypeError(`No receive transition for ${event.type} in ${state.phase}`);
}
