// The browser WebSocket's readyState is the socket's lifecycle:
// CONNECTING → OPEN → CLOSING → CLOSED. The browser owns the transitions;
// this module owns what a send does in each state.
//
// The viewer hands its socket to Subduction's WASM transport, which calls
// socket.send() itself. Its connection tasks can still send after close()
// starts (a reconnect, an access change, a host idle close) and before the
// close event reaches them. The browser drops those bytes and logs "WebSocket
// is already in CLOSING or CLOSED state." for each one. The guarded send drops
// them without the log. The close event still runs the disconnect path.

export const SOCKET_STATE = Object.freeze({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

/**
 * What a send does in a socket state:
 * - `send`: OPEN, the bytes go out.
 * - `drop`: CLOSING or CLOSED, the browser would discard them anyway.
 * - `refuse`: CONNECTING, left to the browser, which throws InvalidStateError.
 *   Subduction waits for open before it sends, so this is a caller bug.
 */
export function sendDecision(readyState) {
  if (readyState === SOCKET_STATE.OPEN) return "send";
  if (readyState === SOCKET_STATE.CLOSING || readyState === SOCKET_STATE.CLOSED) return "drop";
  return "refuse";
}

/** Shadow `socket.send` with one that follows sendDecision. Returns the socket. */
export function guardSocketSend(socket) {
  const send = socket.send;
  Object.defineProperty(socket, "send", {
    configurable: true,
    writable: true,
    value(data) {
      if (sendDecision(socket.readyState) === "drop") return;
      return send.call(socket, data);
    },
  });
  return socket;
}
