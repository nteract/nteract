// Per-connection bound on the sync frames the Page host has taken from a
// socket but not finished. A frame counts from arrival until its admission
// run settles (stored and acked, or refused), so the bound covers frames
// waiting in a document's queue and the one being admitted. The limits match
// the native byte transport's receive queue (shared/byte-transport.mjs).
//
//   open        counting frames; an arrival over either limit overflows
//   overflowed  the host refused the arrival that overflowed and closed the
//               socket; later arrivals are dropped, settles still count down
//   closed      the socket closed; nothing is counted
//
// `receiveStep` is the only transition. The host runs the effect it returns:
// "admit" queues the frame, "refuse" refuses it and closes, "drop" ignores it.

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

/**
 * One transition. Events: `{ type: "arrive", bytes }`, `{ type: "settle",
 * bytes }` (the bytes its arrival counted) and `{ type: "close" }`.
 * Returns `{ state, effect }`; effect is "admit", "refuse", "drop" or null.
 */
export function receiveStep(state, event, limits = RECEIVE_LIMITS) {
  if (event.type === "close") return { state: CLOSED, effect: null };
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
      break;
    case "overflowed":
      if (event.type === "arrive") return { state, effect: "drop" };
      if (event.type === "settle") return { state: settled(state, event.bytes), effect: null };
      break;
    case "closed":
      if (event.type === "arrive") return { state, effect: "drop" };
      if (event.type === "settle") return { state, effect: null };
      break;
  }
  throw new TypeError(`No receive transition for ${event.type} in ${state.phase}`);
}
